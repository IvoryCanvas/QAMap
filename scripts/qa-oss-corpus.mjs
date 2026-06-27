#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifest = path.join(repoRoot, "qa/oss-corpus.json");
const defaultWorkdir = path.join(repoRoot, ".codeward-corpus");
const defaultReport = path.join(repoRoot, "codeward-corpus-report.json");
const ignoredDirectories = new Set([
  ".git",
  ".github",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  "vendor",
  ".venv",
  "__pycache__",
]);

const options = parseArgs(process.argv.slice(2));
const manifestPath = path.resolve(options.manifest ?? defaultManifest);
const workdir = path.resolve(options.workdir ?? defaultWorkdir);
const reportPath = path.resolve(options.report ?? defaultReport);
const cliPath = path.join(repoRoot, "dist/cli.js");

const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const repositories = selectRepositories(manifest.repositories ?? [], options);
if (repositories.length === 0) {
  throw new Error("No repositories selected for corpus QA.");
}

await ensureCliBuilt();
await fs.mkdir(path.join(workdir, "repos"), { recursive: true });

const results = [];
console.log("CodeWard OSS Corpus QA");
console.log(`Manifest: ${manifestPath}`);
console.log(`Workdir: ${workdir}`);
console.log(`Repositories: ${repositories.length}`);
console.log("");

for (const repository of repositories) {
  const result = await runRepository(repository);
  results.push(result);
  printRepositoryResult(result);
}

const summary = {
  generatedAt: new Date().toISOString(),
  manifest: manifestPath,
  workdir,
  total: results.length,
  passed: results.filter((result) => result.status === "pass").length,
  failed: results.filter((result) => result.status === "fail").length,
  results,
};

await fs.writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(`Report: ${reportPath}`);
console.log(`Result: ${summary.passed}/${summary.total} passed`);

if (summary.failed > 0) {
  process.exitCode = 1;
}

async function runRepository(repository) {
  const startedAt = Date.now();
  const clonePath = path.join(workdir, "repos", safeName(repository.name));
  const failures = [];
  let scan;
  let testPlan;
  let evaluation;
  let changedFile;

  try {
    await prepareRepository(repository, clonePath);
    await resetRepository(clonePath);
    scan = JSON.parse(await runCodeWard(["scan", clonePath, "--json"]));
    changedFile = await applySyntheticChange(clonePath, repository.change ?? {});
    testPlan = JSON.parse(
      await runCodeWard(["test-plan", clonePath, "--base", "HEAD", "--head", "HEAD", "--include-working-tree", "--json"]),
    );
    evaluation = JSON.parse(
      await runCodeWard(["eval", clonePath, "--base", "HEAD", "--head", "HEAD", "--include-working-tree", "--json"]),
    );

    const commands = testPlan.suggestedCommands ?? [];
    if (commands.length === 0) {
      failures.push("No suggested validation commands were discovered.");
    }
    for (const pattern of repository.expectedCommandPatterns ?? []) {
      const matcher = new RegExp(pattern);
      if (!commands.some((command) => matcher.test(command))) {
        failures.push(`Missing expected command pattern: ${pattern}`);
      }
    }
    const validationGate = evaluation.checks?.find((check) => check.id === "validation-commands");
    if (!validationGate || validationGate.status === "fail") {
      failures.push("Validation command gate failed.");
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (!options.keep) {
      await resetRepository(clonePath).catch(() => undefined);
    }
  }

  return {
    name: repository.name,
    ecosystem: repository.ecosystem,
    url: repository.url,
    status: failures.length === 0 ? "pass" : "fail",
    durationMs: Date.now() - startedAt,
    changedFile,
    scanFindingCount: scan?.findings?.length,
    suggestedCommands: testPlan?.suggestedCommands ?? [],
    domainTestItems: testPlan?.items?.map((item) => item.title) ?? [],
    evaluationRating: evaluation?.rating,
    validationGate: evaluation?.checks?.find((check) => check.id === "validation-commands")?.status,
    failures,
  };
}

async function prepareRepository(repository, clonePath) {
  if (await exists(path.join(clonePath, ".git"))) {
    if (!options.reuse) {
      await fs.rm(clonePath, { recursive: true, force: true });
    }
  }
  if (!(await exists(path.join(clonePath, ".git")))) {
    await fs.mkdir(path.dirname(clonePath), { recursive: true });
    await run("git", ["clone", "--depth", "1", "--no-tags", repository.url, clonePath], repoRoot, 120_000);
  }
}

async function resetRepository(clonePath) {
  if (!(await exists(path.join(clonePath, ".git")))) {
    return;
  }
  await run("git", ["reset", "--hard", "HEAD"], clonePath);
  await run("git", ["clean", "-fd"], clonePath);
}

async function applySyntheticChange(root, change) {
  const relativePath = await findChangeFile(root, change);
  const absolutePath = path.join(root, relativePath);
  await fs.appendFile(absolutePath, syntheticCommentForPath(relativePath), "utf8");
  return relativePath;
}

async function findChangeFile(root, change) {
  for (const candidate of change.fileCandidates ?? []) {
    const resolved = path.join(root, candidate);
    if (await exists(resolved)) {
      return toPosixPath(candidate);
    }
  }

  const extensions = new Set(change.extensions ?? []);
  const pathHints = change.pathHints ?? [];
  const candidates = [];
  await walk(root, root, candidates, extensions);
  candidates.sort((left, right) => scoreCandidate(right, pathHints) - scoreCandidate(left, pathHints));

  const match = candidates[0];
  if (!match) {
    throw new Error("Could not find a source file for synthetic corpus change.");
  }
  return match;
}

async function walk(root, directory, candidates, extensions) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(root, absolutePath, candidates, extensions);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (extensions.size > 0 && !extensions.has(path.extname(entry.name))) {
      continue;
    }
    candidates.push(toPosixPath(path.relative(root, absolutePath)));
  }
}

function scoreCandidate(filePath, pathHints) {
  let score = 0;
  for (const hint of pathHints) {
    if (hint === "." || filePath.startsWith(hint)) {
      score += 10;
    }
    if (filePath.includes(hint)) {
      score += 2;
    }
  }
  if (/(?:^|\/)(test|tests|spec|specs|fixtures?)\//i.test(filePath)) {
    score -= 5;
  }
  return score;
}

function syntheticCommentForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".py" || extension === ".rb" || extension === ".sh") {
    return `\n# CodeWard corpus synthetic change ${Date.now()}.\n`;
  }
  if (extension === ".md" || extension === ".html") {
    return `\n<!-- CodeWard corpus synthetic change ${Date.now()}. -->\n`;
  }
  return `\n// CodeWard corpus synthetic change ${Date.now()}.\n`;
}

async function runCodeWard(args) {
  const { stdout } = await run(process.execPath, [cliPath, ...args], repoRoot);
  return stdout;
}

async function run(command, args, cwd, timeoutMs = 60_000) {
  return execFileAsync(command, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

async function ensureCliBuilt() {
  if (!(await exists(cliPath))) {
    throw new Error("dist/cli.js was not found. Run `pnpm build` before corpus QA.");
  }
}

function selectRepositories(repositories, selectedOptions) {
  let selected = repositories;
  if (selectedOptions.repo.length > 0) {
    const names = new Set(selectedOptions.repo);
    selected = selected.filter((repository) => names.has(repository.name));
  }
  if (selectedOptions.ecosystem.length > 0) {
    const ecosystems = new Set(selectedOptions.ecosystem);
    selected = selected.filter((repository) => ecosystems.has(repository.ecosystem));
  }
  if (selectedOptions.limit !== undefined) {
    selected = selected.slice(0, selectedOptions.limit);
  }
  return selected;
}

function printRepositoryResult(result) {
  const mark = result.status === "pass" ? "PASS" : "FAIL";
  console.log(`${mark} ${result.name} (${result.ecosystem}) ${result.durationMs}ms`);
  console.log(`  changed: ${result.changedFile ?? "n/a"}`);
  console.log(`  commands: ${result.suggestedCommands.length > 0 ? result.suggestedCommands.join(" | ") : "none"}`);
  console.log(`  validation gate: ${result.validationGate ?? "n/a"}`);
  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      console.log(`  failure: ${failure}`);
    }
  }
  console.log("");
}

function parseArgs(args) {
  const parsed = {
    ecosystem: [],
    repo: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--manifest") {
      parsed.manifest = readValue(args, ++index, arg);
      continue;
    }
    if (arg === "--workdir") {
      parsed.workdir = readValue(args, ++index, arg);
      continue;
    }
    if (arg === "--report") {
      parsed.report = readValue(args, ++index, arg);
      continue;
    }
    if (arg === "--repo") {
      parsed.repo.push(readValue(args, ++index, arg));
      continue;
    }
    if (arg === "--ecosystem") {
      parsed.ecosystem.push(readValue(args, ++index, arg));
      continue;
    }
    if (arg === "--limit") {
      const value = Number.parseInt(readValue(args, ++index, arg), 10);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--limit must be a positive integer");
      }
      parsed.limit = value;
      continue;
    }
    if (arg === "--reuse") {
      parsed.reuse = true;
      continue;
    }
    if (arg === "--keep") {
      parsed.keep = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log(`CodeWard OSS Corpus QA

Usage:
  pnpm qa:corpus [--repo <name>] [--ecosystem <name>] [--limit <n>] [--reuse] [--keep]

Options:
  --manifest <file>    Corpus manifest. Defaults to qa/oss-corpus.json.
  --workdir <dir>      Clone/cache directory. Defaults to .codeward-corpus.
  --report <file>      JSON report path. Defaults to codeward-corpus-report.json.
  --repo <name>        Run one named repository. Repeatable.
  --ecosystem <name>   Run one ecosystem. Repeatable.
  --limit <n>          Run the first n selected repositories.
  --reuse              Reuse an existing shallow clone when available.
  --keep               Keep synthetic working-tree changes after the run.
`);
}

function safeName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
