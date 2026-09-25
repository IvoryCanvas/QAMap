// Measures one coding-agent host reviewing the same change with and without QAMap.
// Each run gets a fresh fixture repository, home directory and host session; usage
// comes from the host's own per-model receipt. Nothing is estimated from bytes.
//
//   node scripts/agent-bench/review-host.mjs --engine <prefix with bin/qamap> --out <dir> [--runs 3]
//     [--arms standalone,qamap] [--case <id>] [--model <id>] [--concurrency 4] [--dry-run]
//
// The host is the Claude Code CLI (`claude -p --output-format stream-json`). Provider
// charges apply to real runs. --dry-run materializes every fixture and stops before
// starting the host.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const suiteFiles = { regression: "cases.mjs", extended: "extended-cases.mjs", confirmation: "confirmation-cases.mjs",
  completeness: "completeness-cases.mjs", release: "release-cases.mjs" };
const hostEnvironment = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_PID", "CLAUDE_CODE_SYNC_SESSION_REFS",
  "CLAUDE_CODE_TEE_SDK_STDOUT", "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD", "CLAUDE_ADDITIONAL_DIRECTORIES", "GH_TOKEN", "GITHUB_TOKEN"];
export const hostTools = { allowed: ["Bash", "Read", "Grep", "Glob", "Skill"],
  disallowed: ["Agent", "Task", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite"] };

export async function loadSuite(file = path.join(root, "test/benchmarks/review-host/cases.json")) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function evidenceCase(suite, id) {
  const module = await import(pathToFileURL(path.join(root, "test/benchmarks/report-only-evidence", suiteFiles[suite])).href);
  const entry = module.cases.find((item) => item.id === id);
  if (!entry) throw new Error(`Unknown evidence case: ${suite}/${id}`);
  return entry;
}

function gitEnvironment(home) {
  return { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture Author", GIT_AUTHOR_EMAIL: "author@fixture.test", GIT_COMMITTER_NAME: "Fixture Author",
    GIT_COMMITTER_EMAIL: "author@fixture.test", GIT_AUTHOR_DATE: "2026-09-22T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-22T00:00:00Z" };
}

async function writeFiles(directory, files) {
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(directory, name.endsWith(".fixture") ? name.slice(0, -".fixture".length) : name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
}

async function copyOverlay(source, directory) {
  await fs.cp(source, directory, { recursive: true });
  for (const name of await fs.readdir(directory, { recursive: true })) {
    if (name.endsWith(".fixture")) await fs.rename(path.join(directory, name), path.join(directory, name.slice(0, -".fixture".length)));
  }
}

// Builds `main` plus one change commit on `feature/change`. A repository-revert case
// clones this repository's own history up to a merged fix, removes later refs, and
// reverts the fix's source paths as the change under review.
export async function materializeCase(entry, { directory, home, engineBin, arm }) {
  const repo = path.join(directory, "repo");
  const env = gitEnvironment(home);
  const git = (...args) => execFileSync("git", args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString().trim();
  if (entry.kind === "repository-revert") {
    execFileSync("git", ["clone", "-q", "--no-local", "--no-tags", root, repo], { env });
    git("checkout", "-q", "-B", "main", entry.baseCommit);
    git("remote", "remove", "origin");
    for (const ref of git("for-each-ref", "--format=%(refname)").split("\n").filter((name) => name && name !== "refs/heads/main")) git("update-ref", "-d", ref);
    git("reflog", "expire", "--expire=now", "--all");
    git("gc", "-q", "--prune=now");
  } else {
    await fs.mkdir(repo, { recursive: true });
    git("init", "-q", "-b", "main");
    if (entry.kind === "fixture") await copyOverlay(path.join(root, entry.fixture, "base"), repo);
    else await writeFiles(repo, (await evidenceCase(entry.suite, entry.id)).base);
  }
  git("config", "gc.auto", "0");
  if (arm === "qamap") {
    execFileSync(path.join(engineBin, "qamap"), ["init", "--agent", "--review-mode", "report"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  }
  git("add", "-A");
  if (git("status", "--porcelain")) git("commit", "-q", "-m", entry.kind === "repository-revert" ? "chore: add QAMap agent setup" : "chore: project baseline");
  git("checkout", "-q", "-b", "feature/change");
  let message = entry.message;
  if (entry.kind === "repository-revert") {
    const patch = execFileSync("git", ["-C", root, "show", "--format=", entry.revertCommit, "--", ...entry.revertPaths], { maxBuffer: 64 * 1024 * 1024 });
    execFileSync("git", ["apply", "-R", "--whitespace=nowarn"], { cwd: repo, env, input: patch });
  } else if (entry.kind === "fixture") {
    await copyOverlay(path.join(root, entry.fixture, "head"), repo);
  } else {
    const source = await evidenceCase(entry.suite, entry.id);
    await writeFiles(repo, source.head);
    message = source.message;
  }
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return { repo, base: git("rev-parse", "main"), head: git("rev-parse", "HEAD") };
}

// The host's result event carries per-model usage including forked skill contexts;
// its top-level `usage` covers only the main loop and is kept for diagnostics.
export function summarizeHostRun(stdout) {
  const events = stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.findLast((event) => event.type === "result");
  const requests = new Set();
  const tools = [];
  for (const event of events) {
    if (event.type !== "assistant" || !event.message) continue;
    if (event.message.id) requests.add(event.message.id);
    for (const block of event.message.content ?? []) if (block.type === "tool_use") tools.push(block.name);
  }
  const models = result?.modelUsage ?? null;
  const fields = ["inputTokens", "cacheCreationInputTokens", "cacheReadInputTokens", "outputTokens"];
  const complete = !!models && Object.values(models).every((usage) => fields.every((field) => Number.isSafeInteger(usage[field])));
  const sum = (field) => complete ? Object.values(models).reduce((total, usage) => total + usage[field], 0) : null;
  const usage = { input: sum("inputTokens"), cacheWrite: sum("cacheCreationInputTokens"), cacheRead: sum("cacheReadInputTokens"), output: sum("outputTokens") };
  return {
    completed: result?.subtype === "success" && result?.is_error === false,
    usage, totalTokens: complete ? usage.input + usage.cacheWrite + usage.cacheRead + usage.output : null,
    uncachedInputTokens: complete ? usage.input + usage.cacheWrite : null,
    costUsd: result?.total_cost_usd ?? null, models: models ? Object.keys(models) : [],
    turns: result?.num_turns ?? null, requests: requests.size, tools, answer: result?.result ?? "",
  };
}

function runHost({ cwd, home, pathPrefix, prompt, model, transcript, timeoutMs }) {
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const key of hostEnvironment) delete env[key];
  if (pathPrefix) env.PATH = `${pathPrefix}${path.delimiter}${process.env.PATH}`;
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", ...(model ? ["--model", model] : []), "--no-session-persistence",
    "--strict-mcp-config", "--max-turns", "60", "--allowedTools", ...hostTools.allowed, "--disallowedTools", ...hostTools.disallowed];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", async (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString();
      await fs.writeFile(transcript, stdout);
      resolve({ code, stdout, stderr: Buffer.concat(err).toString().slice(-2000), wallMs: Date.now() - started });
    });
  });
}

export async function runOne(entry, { suite, arm, run, engine, model, out, dryRun = false, timeoutMs = 900_000 }) {
  const label = `${entry.id}.${arm}.run${run}`;
  const outDir = path.join(out, label);
  await fs.mkdir(outDir, { recursive: false });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-review-host-"));
  try {
    const home = path.join(directory, "home");
    await fs.mkdir(home);
    const engineBin = path.join(path.resolve(engine), "bin");
    const { repo, base, head } = await materializeCase(entry, { directory, home, engineBin, arm });
    const prompt = arm === "qamap" ? `${suite.qamapPrefix} ${suite.prompt}` : suite.prompt;
    const record = { schema: { name: "qamap.review-host-run", version: 1 }, case: entry.id, arm, run, model, base, head,
      promptSha256: createHash("sha256").update(prompt).digest("hex"), tools: hostTools };
    if (dryRun) {
      await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify({ ...record, status: "dry-run" }, null, 2));
      return { label, status: "dry-run" };
    }
    const host = await runHost({ cwd: repo, home, pathPrefix: arm === "qamap" ? engineBin : undefined, prompt, model,
      transcript: path.join(outDir, "transcript.jsonl"), timeoutMs });
    const summary = summarizeHostRun(host.stdout);
    const changed = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
    const status = host.code === 0 && summary.completed && summary.totalTokens !== null ? "completed" : "ineligible";
    await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify({ ...record, status, exitCode: host.code, wallMs: host.wallMs,
      workingTreeChanged: changed.length > 0, stderrTail: host.stderr, ...summary }, null, 2));
    await fs.writeFile(path.join(outDir, "answer.md"), summary.answer);
    return { label, status, totalTokens: summary.totalTokens, requests: summary.requests, tools: summary.tools.join(",") };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: { engine: { type: "string" }, out: { type: "string" }, runs: { type: "string", default: "3" },
    arms: { type: "string", default: "standalone,qamap" }, case: { type: "string" }, model: { type: "string" },
    concurrency: { type: "string", default: "4" }, "dry-run": { type: "boolean", default: false }, suite: { type: "string" } } });
  if (!values.engine || !values.out) throw new Error("--engine and --out are required");
  const out = path.resolve(values.out);
  const relative = path.relative(root, out);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("Keep measurement output outside the repository");
  await fs.mkdir(out, { recursive: true });
  const suite = await loadSuite(values.suite);
  const cases = suite.cases.filter((entry) => !values.case || entry.id === values.case);
  const arms = values.arms.split(",");
  // Alternate arm order per case and run so neither arm always warms the host's prompt cache.
  const jobs = [];
  for (let run = 1; run <= Number(values.runs); run++) cases.forEach((entry, index) => {
    const ordered = (index + run) % 2 === 0 ? arms : [...arms].reverse();
    for (const arm of ordered) jobs.push({ entry, arm, run });
  });
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      let line;
      try { line = await runOne(job.entry, { suite, arm: job.arm, run: job.run, engine: values.engine, model: values.model, out, dryRun: values["dry-run"] }); }
      catch (error) { line = { label: `${job.entry.id}.${job.arm}.run${job.run}`, status: "harness-error", message: String(error.message ?? error) }; }
      await fs.appendFile(path.join(out, "runs.jsonl"), `${JSON.stringify(line)}\n`);
      process.stdout.write(`${JSON.stringify(line)}\n`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
