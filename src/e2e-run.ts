import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { generateE2eDraft, type E2eDraftFile, type E2eDraftOptions, type E2eScenarioAutomationReceipt } from "./e2e.js";
import { toPosixPath } from "./fs.js";
import { captureGitState, compareGitState, terminateProcessTree } from "./qa-execution.js";
import { neutralizeInstructionLikeValues } from "./qa-contract.js";
import type { QaGitStateReceipt } from "./qa.js";
import { TOOL_NAME, VERSION } from "./version.js";
import type { QAMapConfig, QAMapExecutorConfig, QAMapFixtureDeclaration } from "./types.js";

/**
 * Scenario execution — the bounded step after `qamap e2e draft`.
 *
 * QAMap does not own a browser. It resolves one compiled scenario to the draft file that
 * carries it, materializes the fixtures the repository declared for it, invokes the
 * executor the repository configured, and turns the executor's own report into a receipt:
 * pass/fail per assertion, timing, and artifacts only when something failed. The receipt
 * is persisted under `.qamap/runs/e2e/<scenario>/` so a later run of the same id can be
 * compared instead of re-driven by hand.
 *
 * Anything that cannot be proven is reported as `blocked`, never as a pass.
 */

export const e2eRunReceiptDirectory = ".qamap/runs/e2e";
export const e2eRunFixtureDirectory = ".qamap/tmp/e2e-run";

const defaultExecutorTimeoutMs = 300_000;
const defaultSeedTimeoutMs = 60_000;
const maxAssertionErrorChars = 240;
const maxArtifacts = 12;

export type E2eScenarioExecutabilityStatus =
  | "executable"
  | "executor-missing"
  | "fixtures-missing"
  | "not-compiled";

export interface E2eScenarioExecutability {
  status: E2eScenarioExecutabilityStatus;
  executor?: string;
  fixtureIds: string[];
  reason: string;
}

export interface E2eRunOptions extends Omit<E2eDraftOptions, "dryRun" | "force"> {
  config?: QAMapConfig;
  executor?: string;
  timeoutMs?: number;
  /** Draft directory the executor targets; defaults to the runner's conventional output. */
  output?: string;
}

export interface E2eAssertionResult {
  title: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: string;
}

export interface E2eFixtureReceiptItem {
  id: string;
  kind: "file" | "seed";
  status: "materialized" | "executed" | "failed";
  sha256?: string;
  durationMs: number;
  reason?: string;
}

export interface E2eFixturePreparationReceipt {
  status: "ready" | "blocked";
  directory: string;
  fixtures: E2eFixtureReceiptItem[];
  reason?: string;
}

export interface E2eBlockedRunReceipt {
  status: "blocked";
  performed: false;
  scope: "scenario-executor";
  reason: string;
  fixtures?: E2eFixturePreparationReceipt;
}

export interface E2eCompletedRunReceipt {
  status: "passed" | "failed";
  performed: true;
  scope: "scenario-executor";
  executor: string;
  runner: QAMapExecutorConfig["runner"];
  command: string[];
  cwd: string;
  exitCode?: number;
  signal?: string;
  durationMs: number;
  timedOut: boolean;
  assertions: E2eAssertionResult[];
  artifacts: string[];
  fixtures: E2eFixturePreparationReceipt;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  gitState: QaGitStateReceipt;
}

export type E2eRunReceipt = E2eBlockedRunReceipt | E2eCompletedRunReceipt;

export type E2eRunComparisonVerdict = "same" | "regressed" | "recovered" | "changed";

export interface E2eRunComparison {
  verdict: E2eRunComparisonVerdict;
  previousStatus: E2eRunReceipt["status"];
  currentStatus: E2eRunReceipt["status"];
  added: string[];
  removed: string[];
  statusChanged: Array<{ title: string; from: E2eAssertionResult["status"]; to: E2eAssertionResult["status"] }>;
  durationDeltaMs?: number;
}

export interface E2eRunResult {
  tool: { name: string; version: string };
  root: string;
  generatedAt: string;
  scenarioId: string;
  title?: string;
  flowTitle?: string;
  specPath?: string;
  receipt: E2eRunReceipt;
  receiptPath?: string;
  comparison?: E2eRunComparison;
  nextSteps: string[];
}

interface StoredRunReceipt {
  scenarioId: string;
  generatedAt: string;
  title?: string;
  specPath?: string;
  receipt: E2eRunReceipt;
}

/** Which scenarios `qamap e2e run` can execute right now, given the repository's configuration. */
export function assessScenarioExecutability(
  receipt: Pick<E2eScenarioAutomationReceipt, "scenarioId" | "status">,
  config: Pick<QAMapConfig, "executors" | "fixtures" | "scenarioFixtures"> | undefined,
  runner: string = "playwright",
): E2eScenarioExecutability {
  const fixtureIds = config?.scenarioFixtures?.[receipt.scenarioId] ?? [];
  if (receipt.status !== "compiled") {
    return { status: "not-compiled", fixtureIds, reason: `The scenario is ${receipt.status}; only compiled scenarios run.` };
  }
  const executor = selectExecutor(config?.executors, undefined, runner);
  if (!executor) {
    return { status: "executor-missing", fixtureIds, reason: "No executor is configured for this runner in qamap.config.json." };
  }
  const missing = fixtureIds.filter((id) => !config?.fixtures?.[id]);
  if (missing.length > 0) {
    return { status: "fixtures-missing", executor: executor.name, fixtureIds, reason: `Declared fixtures are missing: ${missing.join(", ")}.` };
  }
  return { status: "executable", executor: executor.name, fixtureIds, reason: "A compiled scenario, a configured executor, and declared fixtures are all present." };
}

export async function runE2eScenario(rootInput: string, scenarioIdInput: string, options: E2eRunOptions = {}): Promise<E2eRunResult> {
  const root = path.resolve(rootInput);
  const generatedAt = new Date().toISOString();
  const draft = await generateE2eDraft(root, {
    base: options.base,
    head: options.head,
    workspaceRoot: options.workspaceRoot,
    includeWorkingTree: options.includeWorkingTree,
    validationCommands: options.validationCommands,
    runner: options.runner,
    manifestPath: options.manifestPath,
    output: options.output,
    dryRun: true,
  });
  const located = locateScenario(draft.files, scenarioIdInput);
  if ("error" in located) {
    return finish(root, generatedAt, scenarioIdInput, undefined, blocked(located.error), options);
  }
  const { file, receipt: automation } = located;
  const base = { title: automation.title, flowTitle: file.flowTitle, specPath: file.path };

  if (automation.status !== "compiled") {
    return finish(root, generatedAt, automation.scenarioId, base, blocked(
      `The scenario is ${automation.status}, not compiled; run qamap e2e draft and resolve its blockers before executing it.`,
    ), options);
  }
  if (!(await fileExists(path.join(root, file.path)))) {
    return finish(root, generatedAt, automation.scenarioId, base, blocked(
      `The draft ${file.path} is not written yet; run qamap e2e draft first.`,
    ), options);
  }
  const executor = selectExecutor(options.config?.executors, options.executor, draft.runner);
  if (!executor) {
    return finish(root, generatedAt, automation.scenarioId, base, blocked(
      options.executor
        ? `No executor named ${options.executor} is configured in qamap.config.json.`
        : `No executor is configured for the ${draft.runner} runner in qamap.config.json; add one under executors to make this scenario executable.`,
    ), options);
  }

  const fixtureIds = options.config?.scenarioFixtures?.[automation.scenarioId] ?? [];
  const fixtureDirectory = path.join(root, e2eRunFixtureDirectory, scenarioDirectoryName(automation.scenarioId));
  const artifactDirectory = executor.config.artifactDirectory
    ? path.resolve(root, executor.config.artifactDirectory)
    : path.join(fixtureDirectory, "artifacts");
  const fixtures = await prepareScenarioFixtures(root, fixtureIds, options.config?.fixtures ?? {}, fixtureDirectory);
  if (fixtures.status === "blocked") {
    return finish(root, generatedAt, automation.scenarioId, base, { ...blocked(fixtures.reason ?? "Fixture preparation failed."), fixtures }, options);
  }

  await fs.rm(artifactDirectory, { recursive: true, force: true });
  await fs.mkdir(artifactDirectory, { recursive: true });
  const reportPath = path.join(artifactDirectory, "executor-report.json");
  const cwd = executor.config.cwd ? path.resolve(root, executor.config.cwd) : root;
  const command = executor.config.command.map((token) => substituteTokens(token, {
    file: toPosixPath(path.relative(cwd, path.join(root, file.path))) || file.path,
    grep: grepPatternForTitle(automation.title, file.flowTitle),
    scenarioId: automation.scenarioId,
    fixtureDirectory,
    artifactDirectory,
  }));
  const timeoutMs = options.timeoutMs ?? executor.config.timeoutMs ?? defaultExecutorTimeoutMs;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...executor.config.env,
    QAMAP_SCENARIO_ID: automation.scenarioId,
    QAMAP_FIXTURE_DIR: fixtureDirectory,
    QAMAP_ARTIFACT_DIR: artifactDirectory,
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
  };

  const beforeGitState = await captureGitState(root);
  const execution = await runBoundedCommand(command, cwd, timeoutMs, env);
  const afterGitState = await captureGitState(root);

  const parsed = executor.config.runner === "playwright"
    ? await parsePlaywrightReport(reportPath, execution.stdoutText)
    : undefined;
  const assertions = parsed?.assertions ?? [{
    title: "executor exit code 0",
    status: !execution.timedOut && execution.exitCode === 0 ? "passed" as const : "failed" as const,
    durationMs: execution.durationMs,
    ...(execution.timedOut ? { error: `Timed out after ${timeoutMs}ms.` } : {}),
  }];
  const failed = execution.timedOut || execution.exitCode !== 0 || assertions.some((item) => item.status === "failed");
  const artifacts = failed ? await collectArtifacts(root, artifactDirectory, parsed?.attachments ?? []) : [];

  const receipt: E2eCompletedRunReceipt = {
    status: failed ? "failed" : "passed",
    performed: true,
    scope: "scenario-executor",
    executor: executor.name,
    runner: executor.config.runner,
    command,
    cwd: toPosixPath(path.relative(root, cwd)) || ".",
    ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
    ...(execution.signal ? { signal: execution.signal } : {}),
    durationMs: execution.durationMs,
    timedOut: execution.timedOut,
    assertions,
    artifacts,
    fixtures,
    stdoutBytes: execution.stdoutBytes,
    stderrBytes: execution.stderrBytes,
    stdoutSha256: execution.stdoutSha256,
    stderrSha256: execution.stderrSha256,
    gitState: compareGitState(beforeGitState, afterGitState),
  };
  return finish(root, generatedAt, automation.scenarioId, base, receipt, options);
}

export function diffE2eRunReceipts(previous: E2eRunReceipt, current: E2eRunReceipt): E2eRunComparison {
  const previousAssertions = previous.status === "blocked" ? [] : previous.assertions;
  const currentAssertions = current.status === "blocked" ? [] : current.assertions;
  const previousByTitle = new Map(previousAssertions.map((item) => [item.title, item]));
  const currentByTitle = new Map(currentAssertions.map((item) => [item.title, item]));
  const added = currentAssertions.filter((item) => !previousByTitle.has(item.title)).map((item) => item.title);
  const removed = previousAssertions.filter((item) => !currentByTitle.has(item.title)).map((item) => item.title);
  const statusChanged = currentAssertions
    .filter((item) => previousByTitle.has(item.title) && previousByTitle.get(item.title)?.status !== item.status)
    .map((item) => ({ title: item.title, from: previousByTitle.get(item.title)!.status, to: item.status }));
  let verdict: E2eRunComparisonVerdict = "same";
  if (previous.status === "passed" && current.status === "failed") verdict = "regressed";
  else if (previous.status === "failed" && current.status === "passed") verdict = "recovered";
  else if (previous.status !== current.status || added.length > 0 || removed.length > 0 || statusChanged.length > 0) verdict = "changed";
  const durationDeltaMs = previous.status !== "blocked" && current.status !== "blocked"
    ? current.durationMs - previous.durationMs
    : undefined;
  return {
    verdict,
    previousStatus: previous.status,
    currentStatus: current.status,
    added,
    removed,
    statusChanged,
    ...(durationDeltaMs !== undefined ? { durationDeltaMs } : {}),
  };
}

export function formatMarkdownE2eRun(result: E2eRunResult): string {
  const lines: string[] = [];
  lines.push("# QAMap E2E Run");
  lines.push("");
  lines.push(`Scenario: ${result.scenarioId}`);
  if (result.title) lines.push(`Title: ${result.title}`);
  if (result.flowTitle) lines.push(`Flow: ${result.flowTitle}`);
  if (result.specPath) lines.push(`Draft: ${result.specPath}`);
  lines.push(`Status: ${result.receipt.status}`);
  if (result.receipt.status === "blocked") {
    lines.push(`Reason: ${result.receipt.reason}`);
  } else {
    const receipt = result.receipt;
    lines.push(`Executor: ${receipt.executor} (${receipt.runner})`);
    lines.push(`Duration: ${receipt.durationMs}ms${receipt.timedOut ? " (timed out)" : ""}`);
    if (receipt.exitCode !== undefined) lines.push(`Exit code: ${receipt.exitCode}`);
    lines.push(`Git-observable worktree changes: ${receipt.gitState.changed === null ? "unknown" : receipt.gitState.changed ? "yes" : "no"}`);
    lines.push("");
    lines.push("## Assertions");
    lines.push("");
    for (const assertion of receipt.assertions) {
      lines.push(`- [${assertion.status}] ${assertion.title} (${assertion.durationMs}ms)${assertion.error ? ` — ${assertion.error}` : ""}`);
    }
    if (receipt.fixtures.fixtures.length > 0) {
      lines.push("");
      lines.push("## Fixtures");
      lines.push("");
      for (const fixture of receipt.fixtures.fixtures) {
        lines.push(`- ${fixture.id} (${fixture.kind}): ${fixture.status}${fixture.sha256 ? ` sha256 ${fixture.sha256.slice(0, 12)}` : ""}`);
      }
    }
    if (receipt.artifacts.length > 0) {
      lines.push("");
      lines.push("## Failure Artifacts");
      lines.push("");
      for (const artifact of receipt.artifacts) lines.push(`- ${artifact}`);
    }
  }
  if (result.comparison) {
    lines.push("");
    lines.push("## Compared To Previous Run");
    lines.push("");
    lines.push(`Verdict: ${result.comparison.verdict} (${result.comparison.previousStatus} -> ${result.comparison.currentStatus})`);
    for (const change of result.comparison.statusChanged) {
      lines.push(`- ${change.title}: ${change.from} -> ${change.to}`);
    }
    for (const title of result.comparison.added) lines.push(`- added: ${title}`);
    for (const title of result.comparison.removed) lines.push(`- removed: ${title}`);
    if (result.comparison.durationDeltaMs !== undefined) {
      lines.push(`- duration delta: ${result.comparison.durationDeltaMs >= 0 ? "+" : ""}${result.comparison.durationDeltaMs}ms`);
    }
  }
  if (result.receiptPath) {
    lines.push("");
    lines.push(`Receipt: ${result.receiptPath}`);
  }
  if (result.nextSteps.length > 0) {
    lines.push("");
    lines.push("## Next Steps");
    lines.push("");
    for (const step of result.nextSteps) lines.push(`- ${step}`);
  }
  return `${lines.join("\n")}\n`;
}

// ── internals ───────────────────────────────────────────────────────────────

function blocked(reason: string): E2eBlockedRunReceipt {
  return { status: "blocked", performed: false, scope: "scenario-executor", reason };
}

async function finish(
  root: string,
  generatedAt: string,
  scenarioId: string,
  base: { title?: string; flowTitle?: string; specPath?: string } | undefined,
  receipt: E2eRunReceipt,
  options: E2eRunOptions,
): Promise<E2eRunResult> {
  const result: E2eRunResult = {
    tool: { name: TOOL_NAME, version: VERSION },
    root,
    generatedAt,
    scenarioId,
    ...(base ?? {}),
    receipt,
    nextSteps: [],
  };
  if (receipt.status !== "blocked") {
    const previous = await readLatestReceipt(root, scenarioId);
    if (previous) {
      result.comparison = diffE2eRunReceipts(previous.receipt, receipt);
    }
    result.receiptPath = await writeRunReceipt(root, {
      scenarioId,
      generatedAt,
      title: base?.title,
      specPath: base?.specPath,
      receipt,
    });
  }
  result.nextSteps = nextStepsFor(result, options);
  return neutralizeInstructionLikeValues(result).value;
}

function nextStepsFor(result: E2eRunResult, options: E2eRunOptions): string[] {
  const receipt = result.receipt;
  if (receipt.status === "blocked") {
    return [receipt.reason, "Nothing was executed; the scenario stays review evidence until the blocker is resolved."];
  }
  const steps: string[] = [];
  if (receipt.status === "failed") {
    steps.push("Inspect the failed assertions and the failure artifacts, fix the behavior, then rerun the same scenario id to compare receipts.");
  } else {
    steps.push("Keep this receipt as evidence; rerun the same scenario id after the next change to compare instead of re-driving the flow.");
  }
  if (receipt.gitState.changed) {
    steps.push("The executor changed tracked or untracked files; review those changes before trusting the run.");
  }
  if (options.includeWorkingTree) {
    steps.push("The draft was resolved against the working tree; commit before treating this receipt as pull request evidence.");
  }
  return steps;
}

function locateScenario(
  files: E2eDraftFile[],
  input: string,
): { file: E2eDraftFile; receipt: E2eScenarioAutomationReceipt } | { error: string } {
  const needle = input.trim();
  const candidates: Array<{ file: E2eDraftFile; receipt: E2eScenarioAutomationReceipt }> = [];
  for (const file of files) {
    for (const receipt of file.scenarioAutomation ?? []) {
      const id = receipt.scenarioId;
      const hash = id.replace(/^scenario:/, "");
      if (id === needle || `scenario:${needle}` === id || (needle.length >= 6 && hash.startsWith(needle.replace(/^scenario:/, "")))) {
        candidates.push({ file, receipt });
      }
    }
  }
  const unique = candidates.filter((candidate, index) =>
    candidates.findIndex((other) => other.receipt.scenarioId === candidate.receipt.scenarioId) === index
  );
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) {
    return { error: `The id ${needle} matches ${unique.length} scenarios; pass the full scenario id.` };
  }
  return { error: `No drafted scenario matches ${needle}; run qamap qa or qamap e2e draft --dry-run to list scenario ids.` };
}

function selectExecutor(
  executors: Record<string, QAMapExecutorConfig> | undefined,
  requested: string | undefined,
  runner: string,
): { name: string; config: QAMapExecutorConfig } | undefined {
  if (!executors) return undefined;
  if (requested) {
    const config = executors[requested];
    return config ? { name: requested, config } : undefined;
  }
  const matching = Object.entries(executors).filter(([, config]) => config.runner === runner || config.runner === "command");
  const preferred = matching.find(([, config]) => config.runner === runner) ?? matching[0];
  return preferred ? { name: preferred[0], config: preferred[1] } : undefined;
}

function scenarioDirectoryName(scenarioId: string): string {
  return scenarioId.replace(/^scenario:/, "").replace(/[^a-z0-9]/gi, "");
}

function substituteTokens(
  token: string,
  values: { file: string; grep: string; scenarioId: string; fixtureDirectory: string; artifactDirectory: string },
): string {
  return token
    .replaceAll("{file}", values.file)
    .replaceAll("{grep}", values.grep)
    .replaceAll("{scenarioId}", values.scenarioId)
    .replaceAll("{fixtureDir}", values.fixtureDirectory)
    .replaceAll("{artifactDir}", values.artifactDirectory);
}

/** Playwright routes a scenario as `test("<flow>: <scenario>")`; grep by the scenario title alone so the primary flow test does not match. */
function grepPatternForTitle(title: string, _flowTitle: string): string {
  return escapeRegExp(title.replaceAll('"', "'"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function prepareScenarioFixtures(
  root: string,
  fixtureIds: string[],
  declarations: Record<string, QAMapFixtureDeclaration>,
  directory: string,
): Promise<E2eFixturePreparationReceipt> {
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });
  const items: E2eFixtureReceiptItem[] = [];
  for (const id of fixtureIds) {
    const declaration = declarations[id];
    const startedAt = Date.now();
    if (!declaration) {
      items.push({ id, kind: "file", status: "failed", durationMs: 0, reason: `Fixture ${id} is not declared in qamap.config.json.` });
      continue;
    }
    if (declaration.kind === "file") {
      const source = resolveInside(root, declaration.path);
      const target = resolveInside(directory, declaration.target ?? path.basename(declaration.path));
      if (!source || !target) {
        items.push({ id, kind: "file", status: "failed", durationMs: 0, reason: `Fixture ${id} path must stay inside the repository.` });
        continue;
      }
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(source, target);
        items.push({ id, kind: "file", status: "materialized", sha256: await hashFile(target), durationMs: Date.now() - startedAt });
      } catch (error) {
        items.push({ id, kind: "file", status: "failed", durationMs: Date.now() - startedAt, reason: `Fixture ${id} could not be copied: ${errorMessage(error)}` });
      }
      continue;
    }
    const cwd = declaration.cwd ? resolveInside(root, declaration.cwd) : root;
    if (!cwd) {
      items.push({ id, kind: "seed", status: "failed", durationMs: 0, reason: `Fixture ${id} cwd must stay inside the repository.` });
      continue;
    }
    const execution = await runBoundedCommand(declaration.command, cwd, declaration.timeoutMs ?? defaultSeedTimeoutMs, {
      ...process.env,
      CI: "1",
      QAMAP_FIXTURE_DIR: directory,
    });
    if (execution.timedOut || execution.exitCode !== 0) {
      items.push({
        id,
        kind: "seed",
        status: "failed",
        durationMs: execution.durationMs,
        reason: execution.timedOut ? `Fixture ${id} seed hook timed out.` : `Fixture ${id} seed hook exited with ${execution.exitCode ?? "a signal"}.`,
      });
      continue;
    }
    items.push({ id, kind: "seed", status: "executed", durationMs: execution.durationMs });
  }
  const failed = items.filter((item) => item.status === "failed");
  return {
    status: failed.length > 0 ? "blocked" : "ready",
    directory: toPosixPath(path.relative(root, directory)),
    fixtures: items,
    ...(failed.length > 0 ? { reason: failed.map((item) => item.reason).join(" ") } : {}),
  };
}

interface BoundedExecution {
  exitCode?: number;
  signal?: string;
  durationMs: number;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutText: string;
}

const maxRetainedStdoutBytes = 8 * 1024 * 1024;

/** Argument-vector spawn without a shell, bounded by a timeout that kills the whole process tree. */
async function runBoundedCommand(command: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<BoundedExecution> {
  const [file, ...args] = command;
  const startedAt = Date.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  const stdoutChunks: Buffer[] = [];
  let retained = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdoutHash.update(chunk);
      if (retained < maxRetainedStdoutBytes) {
        stdoutChunks.push(chunk);
        retained += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderrHash.update(chunk);
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid, child, "SIGTERM");
      forceKill = setTimeout(() => terminateProcessTree(child.pid, child, "SIGKILL"), 2_000);
      forceKill.unref();
    }, timeoutMs);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (forceKill) clearTimeout(forceKill);
      resolve({
        ...(exitCode !== null ? { exitCode } : spawnError ? { exitCode: 127 } : {}),
        ...(signal ? { signal } : {}),
        durationMs: Date.now() - startedAt,
        timedOut,
        stdoutBytes,
        stderrBytes,
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
        stdoutText: Buffer.concat(stdoutChunks).toString("utf8"),
      });
    });
  });
}

interface ParsedExecutorReport {
  assertions: E2eAssertionResult[];
  attachments: string[];
}

/** Playwright's JSON reporter: nested suites -> specs -> tests -> results. Only the last result of each test counts. */
async function parsePlaywrightReport(reportPath: string, stdoutText: string): Promise<ParsedExecutorReport | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    const start = stdoutText.indexOf("{");
    if (start < 0) return undefined;
    try {
      raw = JSON.parse(stdoutText.slice(start));
    } catch {
      return undefined;
    }
  }
  if (!raw || typeof raw !== "object") return undefined;
  const assertions: E2eAssertionResult[] = [];
  const attachments: string[] = [];
  const walk = (suite: Record<string, unknown>, prefix: string[]): void => {
    const title = typeof suite.title === "string" && suite.title.trim() ? [...prefix, suite.title.trim()] : prefix;
    for (const spec of asArray(suite.specs)) {
      const specTitle = typeof spec.title === "string" ? spec.title : "untitled";
      for (const test of asArray(spec.tests)) {
        const results = asArray(test.results);
        const last = results[results.length - 1];
        const status = normalizePlaywrightStatus(typeof last?.status === "string" ? last.status : undefined);
        const error = last?.error && typeof last.error === "object" && typeof (last.error as Record<string, unknown>).message === "string"
          ? String((last.error as Record<string, unknown>).message).replace(/\[[0-9;]*m/g, "").slice(0, maxAssertionErrorChars)
          : undefined;
        const projectName = typeof test.projectName === "string" && test.projectName ? ` [${test.projectName}]` : "";
        assertions.push({
          title: [...title.filter((part) => !/\.(spec|test)\.[jt]sx?$/.test(part)), specTitle].join(" > ") + projectName,
          status,
          durationMs: typeof last?.duration === "number" ? Math.round(last.duration) : 0,
          ...(status === "failed" && error ? { error } : {}),
        });
        if (status === "failed") {
          for (const attachment of asArray(last?.attachments)) {
            if (typeof attachment.path === "string") attachments.push(attachment.path);
          }
        }
      }
    }
    for (const child of asArray(suite.suites)) walk(child, title);
  };
  for (const suite of asArray((raw as Record<string, unknown>).suites)) walk(suite, []);
  if (assertions.length === 0) return undefined;
  return { assertions, attachments };
}

function normalizePlaywrightStatus(status: string | undefined): E2eAssertionResult["status"] {
  if (status === "passed") return "passed";
  if (status === "skipped") return "skipped";
  return "failed";
}

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];
}

async function collectArtifacts(root: string, artifactDirectory: string, reported: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const candidate of reported) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.join(root, candidate);
    if (await fileExists(absolute)) found.add(toPosixPath(path.relative(root, absolute)));
  }
  for (const absolute of await listFilesUnder(artifactDirectory)) {
    if (path.basename(absolute) === "executor-report.json") continue;
    found.add(toPosixPath(path.relative(root, absolute)));
  }
  return [...found].sort().slice(0, maxArtifacts);
}

async function listFilesUnder(directory: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return []; // No artifact directory means the executor produced nothing beyond its report.
  }
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isFile()) files.push(absolute);
    else if (entry.isDirectory()) files.push(...(await listFilesUnder(absolute, depth + 1)));
  }
  return files;
}

async function readLatestReceipt(root: string, scenarioId: string): Promise<StoredRunReceipt | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, e2eRunReceiptDirectory, scenarioDirectoryName(scenarioId), "latest.json"), "utf8"));
    return raw && typeof raw === "object" && raw.receipt ? raw as StoredRunReceipt : undefined;
  } catch {
    return undefined;
  }
}

async function writeRunReceipt(root: string, stored: StoredRunReceipt): Promise<string> {
  const directory = path.join(root, e2eRunReceiptDirectory, scenarioDirectoryName(stored.scenarioId));
  await fs.mkdir(directory, { recursive: true });
  const fileName = `${stored.generatedAt.replace(/[:.]/g, "-")}.json`;
  const text = `${JSON.stringify(stored, null, 2)}\n`;
  await fs.writeFile(path.join(directory, fileName), text, "utf8");
  await fs.writeFile(path.join(directory, "latest.json"), text, "utf8");
  return toPosixPath(path.relative(root, path.join(directory, fileName)));
}

function resolveInside(root: string, relative: string): string | undefined {
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  if (relation.startsWith("..") || path.isAbsolute(relation)) return undefined;
  return resolved;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

async function hashFile(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
