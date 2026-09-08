#!/usr/bin/env node
// Agent token benchmark: runs a fixed public task suite through one provider
// twice per task, once with generic tools only and once with QAMap tools added,
// and records provider-reported token usage, tool calls, wall-clock, and
// deterministic task success. Without a provider key the run is skipped.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { aggregateRuns, compareQualityGatedRuns } from "./agent-bench/aggregate.mjs";
import { judgeSuccess } from "./agent-bench/judge.mjs";
import { snapshotEvidenceFixture } from "./agent-bench/evidence-quality.mjs";
import { runAgentLoop } from "./agent-bench/loop.mjs";
import { createProvider, DEFAULT_MAX_OUTPUT_TOKENS } from "./agent-bench/provider.mjs";
import { formatTextReport } from "./agent-bench/report.mjs";
import { compareRepositoryArms, createRepositoryEnvironment, isRepositoryArm, prebuildRepositoryIndex, repositoryPairing } from "./agent-bench/repository-arms.mjs";
import { createScriptedProvider } from "./agent-bench/scripted.mjs";
import { loadSuite } from "./agent-bench/suite.mjs";
import { createToolExecutor, toolSchemaSha256, toolsForArm } from "./agent-bench/tools.mjs";
import { exists, materializeFixtureRepo } from "./lib/fixture-repo.mjs";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.resolve(readArg("--config") ?? "agent-bench.config.json");
const dryRun = args.includes("--dry-run");
const save = args.includes("--save");
const assertContract = args.includes("--assert");
const format = readArg("--format") ?? "text";
const armFilter = readArg("--arm");
const taskFilter = readArg("--task");
const runsOverride = readArg("--runs");

if (!["json", "text"].includes(format)) {
  throw new Error("--format must be json or text");
}

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
validateConfig(config);
const runs = runsOverride === undefined ? config.runs : parsePositiveInteger(runsOverride, "--runs");
if (armFilter !== undefined && !config.arms.includes(armFilter)) {
  throw new Error(`--arm must be one of ${config.arms.join(", ")}`);
}
const arms = armFilter === undefined ? config.arms : [armFilter];
const maxOutputTokens = config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
const maxProviderRequests = parsePositiveInteger(readArg("--max-requests") ?? config.maxProviderRequests ?? 100, "--max-requests");
const requestTimeoutMs = config.requestTimeoutMs ?? 60_000;
const carryOverPaths = config.carryOverPaths ?? [".qamap"];
const repositoryExperiment = config.arms.some(isRepositoryArm);
const cliPath = path.join(repositoryRoot, "dist", "cli.js");
if (!(await exists(cliPath))) {
  throw new Error("dist/cli.js is missing; run `pnpm build` before the agent benchmark.");
}

if (taskFilter !== undefined && !config.tasks.includes(taskFilter)) throw new Error("--task must name a task in the selected config.");
const suite = await loadSuite({ repositoryRoot, taskIds: taskFilter ? [taskFilter] : config.tasks });
const systemPrompt = await fs.readFile(path.resolve(repositoryRoot, config.systemPrompt), "utf8");
const packageJson = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"));
const pinnedBase = {
  implementationSha256: await implementationFingerprint(),
  runs,
  maxOutputTokens,
  maxProviderRequests,
  requestTimeoutMs,
  systemPromptSha256: sha256(systemPrompt),
  toolSchemaSha256: Object.fromEntries(config.arms.map((arm) => [arm, toolSchemaSha256(toolsForArm(arm))])),
  suiteSha256: suite.sha256,
  qamapVersion: packageJson.version,
  carryOverPaths,
};

const setup = dryRun ? { kind: "dry-run", provider: "scripted", model: null } : resolveProvider(config.provider);
let report;
if (setup.kind === "skipped") {
  report = buildReport({
    status: "skipped",
    reason: setup.reason,
    pinned: { provider: setup.provider, model: setup.model, ...pinnedBase },
    tasks: suite.tasks.map((task) => ({ id: task.id, title: task.title, firstAuthoring: task.firstAuthoring, arms: {} })),
  });
} else {
  const tasks = [];
  for (const task of suite.tasks) {
    const armResults = {};
    for (const arm of arms) {
      armResults[arm] = await runArm({ task, arm, setup });
    }
    tasks.push({ id: task.id, title: task.title, firstAuthoring: task.firstAuthoring, arms: armResults });
  }
  report = buildReport({
    status: dryRun ? "dry-run" : "measured",
    pinned: { provider: dryRun ? "scripted" : setup.provider.name, model: setup.model, ...pinnedBase },
    tasks,
  });
}

if (format === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(formatTextReport(report));
}

if (save) {
  await fs.mkdir("bench-results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join("bench-results", `agent-bench-${stamp}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write(`\nSaved: ${outputPath}\n`);
}

// A skipped run is not a failure: CI without a provider key must stay green.
if (assertContract && report.status !== "skipped" && !report.summary.passed) {
  console.error(`\nAgent benchmark failed its harness or measured task-quality checks (${report.summary.failedRuns} errored run(s)).`);
  process.exitCode = 1;
}

async function runArm({ task, arm, setup }) {
  const tools = toolsForArm(arm);
  const records = [];
  let carried = null;
  try {
    for (let index = 0; index < runs; index += 1) {
      const firstAuthoring = task.firstAuthoring && index === 0;
      const record = { run: index + 1, firstAuthoring, success: false };
      let prepared;
      let executor;
      try {
        prepared = await materializeTaskRepo(task, carried, arm);
        const evidenceTask = task.successCriteria.some((criterion) => criterion.kind === "qa-evidence");
        const protectedFixture = evidenceTask ? await snapshotEvidenceFixture(prepared.repositoryRoot) : null;
        if (repositoryExperiment) {
          record.repositoryCache = prepared.repositoryCache;
          record.pairing = await repositoryPairing({ task, repositoryRoot: prepared.repositoryRoot,
            env: prepared.env, provider: setup.kind === "dry-run" ? "scripted" : setup.provider.name,
            model: setup.model, system: systemPrompt, tools, maxOutputTokens });
        }
        executor = await createToolExecutor({ repositoryRoot: prepared.repositoryRoot, cliPath,
          env: prepared.env, measureIO: repositoryExperiment });
        const provider = setup.kind === "dry-run" ? createScriptedProvider({ arm,
          staticReview: task.successCriteria.some((criterion) => criterion.kind === "qa-evidence") }) : setup.provider;
        const loop = await runAgentLoop({
          provider,
          tools,
          executor,
          system: systemPrompt,
          prompt: task.prompt,
          maxTurns: task.maxTurns,
        });
        Object.assign(record, loop);
        const verdict = await judgeSuccess(task.successCriteria, prepared.repositoryRoot, { env: prepared.env });
        if (protectedFixture) {
          const unchanged = protectedFixture === await snapshotEvidenceFixture(prepared.repositoryRoot);
          verdict.checks.push({ kind: "protected-fixture", description: "Fixture bytes and modes are unchanged independently of Git state.", passed: unchanged });
          verdict.success &&= unchanged;
        }
        Object.assign(record, { success: verdict.success && (!repositoryExperiment || loop.stopReason === "end-turn"), checks: verdict.checks });
        if (verdict.quality) record.quality = verdict.quality;
        if (setup.kind === "dry-run") {
          // Wall-clock is not a measurement in a dry run and would break
          // deterministic output.
          record.wallClockMs = null;
        }
        if (task.firstAuthoring) {
          carried = await collectCarryOver(prepared.repositoryRoot, carried);
        }
      } catch (error) {
        if (error?.receipt) Object.assign(record, error.receipt);
        record.error = sanitizeMessage(error, prepared?.tempRoot);
      } finally {
        if (repositoryExperiment && executor) record.io = executor.measurements();
        await prepared?.cleanup?.();
      }
      records.push(record);
    }
  } finally {
    if (carried) await fs.rm(carried, { recursive: true, force: true });
  }
  return { runs: records, aggregate: aggregateRuns(records) };
}

async function materializeTaskRepo(task, carried, arm) {
  const { baseOverlay, headOverlay, commitMessage } = task.fixture;
  let tempRoot;
  let env;
  let repositoryCache;
  try {
    const materialized = await materializeFixtureRepo({
      fixtureRoot: task.fixtureRoot,
      tempPrefix: "qamap-agent-bench-",
      baseDirs: baseOverlay === "base" ? ["base"] : ["base", baseOverlay],
      commits: [{ dir: headOverlay, message: commitMessage }],
      identity: { name: "QAMap Agent Benchmark", email: "agent-benchmark@qamap.local" },
      git,
      afterBaseline: async ({ repositoryRoot: root, tempRoot: temporary }) => {
        tempRoot = temporary;
        if (repositoryExperiment) env = await createRepositoryEnvironment(temporary);
        for (const input of task.inputs ?? []) {
          const destination = path.resolve(root, input.to);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.copyFile(path.join(task.dir, input.from), destination);
        }
        if ((task.inputs ?? []).length > 0) {
          await git(root, ["add", "-A"]);
          await git(root, ["commit", "-m", "docs: add task inputs"]);
        }
        // A task without first authoring models a team that already verified
        // this area: a manifest baseline is committed on main before the change.
        if (!task.firstAuthoring) {
          await execFileAsync(process.execPath, [cliPath, "manifest", "init", "."], { cwd: root, env });
          await git(root, ["add", ".qamap"]);
          await git(root, ["commit", "-m", "chore: add verification manifest baseline"]);
        }
        if (repositoryExperiment) {
          repositoryCache = { treatment: arm === "qamap-warm" ? "base-prebuilt" : "empty",
            isolation: "per-task-arm-run", setup: { status: "not-requested", wallClockMs: null } };
          if (arm === "qamap-warm") repositoryCache.setup = await prebuildRepositoryIndex({
            repositoryRoot: root, cliPath, env, dryRun,
          });
        }
      },
    });
    if (carried) {
      await fs.cp(carried, materialized.repositoryRoot, { recursive: true, force: true });
    }
    return { ...materialized, env, repositoryCache };
  } catch (error) {
    if (tempRoot) await fs.rm(tempRoot, { recursive: true, force: true });
    throw new Error(sanitizeMessage(error, tempRoot));
  }
}

// Durable QA context left behind by one run (by default `.qamap/`) is copied
// into the next run of the same task and arm. That is the only state shared
// between runs and the reason steady-state runs can differ from first authoring.
async function collectCarryOver(root, previous) {
  let holding = null;
  for (const relative of carryOverPaths) {
    const source = path.join(root, relative);
    if (!(await exists(source))) continue;
    holding ??= await fs.mkdtemp(path.join(os.tmpdir(), "qamap-agent-bench-carry-"));
    await fs.cp(source, path.join(holding, relative), { recursive: true, force: true });
  }
  if (previous) await fs.rm(previous, { recursive: true, force: true });
  return holding;
}

function resolveProvider(providerConfig) {
  const name = process.env[providerConfig.nameEnv];
  const model = process.env[providerConfig.modelEnv];
  const apiKey = process.env[providerConfig.apiKeyEnv];
  const visible = { provider: name ?? null, model: model ?? null };
  if (!apiKey) return { kind: "skipped", reason: "provider key not configured", ...visible };
  if (!name) return { kind: "skipped", reason: "provider not configured", ...visible };
  if (!model) return { kind: "skipped", reason: "provider model not configured", ...visible };
  return {
    kind: "provider",
    ...visible,
    provider: createProvider({ name, model, apiKey, maxOutputTokens, maxRequests: maxProviderRequests, requestTimeoutMs }),
  };
}

function buildReport({ status, reason, pinned, tasks }) {
  return {
    schema: { name: "qamap.agent-benchmark", version: 1 },
    status,
    ...(reason ? { reason } : {}),
    pinned: { ...pinned, ...(repositoryExperiment ? { repositoryExperiment: {
      cacheIsolation: "per-task-arm-run", warmBaseline: "same-root-base-before-head-overlay", carryOver: "none",
    } } : {}) },
    normativeMetrics: [
      "provider-input-tokens",
      "provider-output-tokens",
      "provider-cache-read-tokens",
      "provider-cache-write-tokens",
      "tool-calls",
      "turns",
      "wall-clock-ms",
      "local-success-checks",
    ],
    interpretation: [
      "Token counts come only from provider usage fields; nothing is estimated.",
      "QAMap itself makes no model request; both arms spend the calling agent's tokens.",
      "No provider pricing or money-saved figure is inferred.",
      "Success is judged by deterministic local checks, never by reading the model's prose.",
      "Token differences are eligible only for paired measured arms whose local task checks all pass. Dry-run and skipped runs do not establish task quality or token savings.",
      "Input counts retain provider-native definitions; cache counts are separate and are not added to or subtracted from input counts. Providers are not compared against each other.",
      "The first-authoring column is the first run from a bare repository; steady-state runs reuse carried-over QA context, so any saving starts on the second run.",
      ...(repositoryExperiment ? [
        "Repository arms override carry-over: every run has an isolated repository, home, and temp/cache environment; first-authoring is only a task label, not evidence of cross-run cache reuse.",
        "Warm setup builds the SAME root's base index before the fixture head overlay. Setup costs are separate from agent wall-clock; observed head rebuild/reuse counters are recorded under io.repositoryIndexes, never inferred from the arm name.",
        "Executor I/O is UTF-8 bytes, not tokens: direct reads and tool responses are measured; subprocess filesystem reads are unknown. Full-report diagnostic reads are separate from agent recovery reads, which can be capped prefixes.",
        "Local criteria are the existing task checks, not proof that generated browser tests were executed. Dry runs exercise the harness only; no provider quality or savings are established.",
      ] : []),
    ],
    tasks: tasks.map((task) => ({ ...task, comparison: compareQualityGatedRuns(task.arms, status),
      ...(repositoryExperiment ? { repositoryComparisons: compareRepositoryArms(task.arms, status) } : {}) })),
    summary: summarize(status, tasks),
  };
}

function summarize(status, tasks) {
  const byArm = {};
  for (const task of tasks) {
    for (const [arm, result] of Object.entries(task.arms)) {
      const entry = byArm[arm] ?? (byArm[arm] = { runs: 0, completedRuns: 0, failedRuns: 0, successfulRuns: 0 });
      entry.runs += result.aggregate.runs;
      entry.completedRuns += result.aggregate.completedRuns;
      entry.failedRuns += result.aggregate.failedRuns;
      entry.successfulRuns += result.aggregate.successfulRuns;
    }
  }
  const failedRuns = Object.values(byArm).reduce((sum, entry) => sum + entry.failedRuns, 0);
  const harnessPassed = failedRuns === 0;
  const qualityPassed = status === "measured" ? Object.values(byArm).length > 0
    && Object.values(byArm).every((entry) => entry.runs > 0 && entry.successfulRuns === entry.runs) : null;
  return {
    status,
    tasks: tasks.length,
    arms: Object.keys(byArm),
    runsPerArm: runs,
    failedRuns,
    byArm,
    harnessPassed,
    qualityPassed,
    passed: harnessPassed && (qualityPassed ?? true),
  };
}

function validateConfig(value) {
  if (value?.requestTimeoutMs !== undefined && (!Number.isSafeInteger(value.requestTimeoutMs)
    || value.requestTimeoutMs < 1 || value.requestTimeoutMs > 300_000)) throw new Error("requestTimeoutMs must be between 1 and 300000.");
  if (!value || value.schemaVersion !== 1) {
    throw new Error("Agent benchmark config must use schemaVersion 1.");
  }
  if (!Number.isInteger(value.runs) || value.runs <= 0) {
    throw new Error("Agent benchmark config requires a positive integer runs.");
  }
  if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.some((id) => typeof id !== "string")) {
    throw new Error("Agent benchmark config requires a non-empty tasks array of task ids.");
  }
  if (!Array.isArray(value.arms) || value.arms.length === 0 || value.arms.some((arm) => !["generic", "qamap"].includes(arm) && !isRepositoryArm(arm))) {
    throw new Error("Agent benchmark config arms must list generic, qamap, qamap-cold, and/or qamap-warm.");
  }
  if (new Set(value.arms).size !== value.arms.length) throw new Error("Agent benchmark arms must be unique.");
  if (value.arms.some(isRepositoryArm) && (!Array.isArray(value.carryOverPaths) || value.carryOverPaths.length !== 0)) {
    throw new Error("Repository cold/warm arms require carryOverPaths: [] for identical paired task inputs.");
  }
  const provider = value.provider;
  for (const field of ["nameEnv", "modelEnv", "apiKeyEnv"]) {
    if (!provider || typeof provider[field] !== "string" || provider[field].trim().length === 0) {
      throw new Error(`Agent benchmark config provider.${field} must name an environment variable.`);
    }
  }
  if (typeof value.systemPrompt !== "string" || value.systemPrompt.trim().length === 0) {
    throw new Error("Agent benchmark config requires a systemPrompt path.");
  }
  if (value.maxOutputTokens !== undefined && (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens <= 0)) {
    throw new Error("Agent benchmark config maxOutputTokens must be a positive integer when provided.");
  }
  if (
    value.carryOverPaths !== undefined &&
    (!Array.isArray(value.carryOverPaths) || value.carryOverPaths.some((item) => typeof item !== "string" || item.startsWith("/") || item.includes("..")))
  ) {
    throw new Error("Agent benchmark config carryOverPaths must be repository-relative paths.");
  }
}

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function sanitizeMessage(error, tempRoot) {
  let message = error instanceof Error ? error.message : String(error);
  if (tempRoot) message = message.split(tempRoot).join("<tmp>");
  return message.split(os.tmpdir()).join("<tmp>");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function implementationFingerprint() {
  const hash = createHash("sha256");
  async function visit(relative) {
    const stats = await fs.stat(path.join(repositoryRoot, relative));
    if (stats.isDirectory()) {
      for (const name of (await fs.readdir(path.join(repositoryRoot, relative))).sort()) await visit(`${relative}/${name}`);
    } else if (/\.(?:m?js)$/.test(relative)) {
      hash.update(relative); hash.update("\0");
      hash.update(await fs.readFile(path.join(repositoryRoot, relative))); hash.update("\0");
    }
  }
  for (const relative of ["dist", "scripts/agent-bench", "scripts/agent-bench.mjs", "scripts/lib/fixture-repo.mjs"]) await visit(relative);
  return hash.digest("hex");
}

async function git(cwd, gitArgs) {
  await execFileAsync("git", gitArgs, { cwd });
}
