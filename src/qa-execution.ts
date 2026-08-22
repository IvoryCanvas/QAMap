import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import path from "node:path";
import {
  generateQaDraft,
} from "./qa.js";
import type {
  QaBlockedExecutionReceipt,
  QaCompletedExecutionReceipt,
  QaDraftOptions,
  QaDraftResult,
  QaGitStateReceipt,
} from "./qa.js";
import {
  neutralizeInstructionLikeValues,
  neutralizedInstructionText,
} from "./qa-contract.js";

const defaultTimeoutMs = 5 * 60 * 1000;
const maximumTimeoutMs = 30 * 60 * 1000;
const maximumCommandLength = 2_048;
const maximumGitStatePaths = 2_048;
const maximumGitOutputBytes = 8 * 1024 * 1024;
const maximumGitStateFileBytes = 32 * 1024 * 1024;
const gitStateReceiptPathLimit = 8;

export interface RunQaValidationOptions extends QaDraftOptions {
  timeoutMs?: number;
  onStdout?: (chunk: Uint8Array) => void;
  onStderr?: (chunk: Uint8Array) => void;
}

export async function runQaValidation(
  rootInput: string,
  options: RunQaValidationOptions = {},
): Promise<QaDraftResult> {
  const result = await generateQaDraft(rootInput, options);
  const command = result.route.command;

  if (result.route.nextAction !== "run-repository-command") {
    return withBlockedExecution(
      result,
      `The selected action is ${result.route.nextAction}; qa run executes only an existing repository validation command.`,
      command,
    );
  }
  if (
    result.action.id !== result.route.nextAction ||
    !result.action.executesProjectCode ||
    result.action.untrustedEvidenceCanEscalate
  ) {
    return withBlockedExecution(
      result,
      "The selected route and action contract do not authorize repository command execution.",
      command,
    );
  }
  if (!command || !result.suggestedCommands.includes(command)) {
    return withBlockedExecution(
      result,
      "QAMap did not select an exact existing repository validation command.",
      command,
    );
  }
  if (!isExecutableSelectedCommand(command)) {
    return withBlockedExecution(
      result,
      "The selected command contains an unsupported control character, exceeds the execution limit, or crossed the repository trust boundary.",
      command,
    );
  }

  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const executionRoot = qaCommandWorkingDirectory(result);
  const execution = await executeSelectedCommand(command, executionRoot, {
    timeoutMs,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });
  const protectedExecution = neutralizeInstructionLikeValues(execution);
  return {
    ...result,
    execution: protectedExecution.value,
    evidenceBoundary: {
      ...result.evidenceBoundary,
      neutralizedValues:
        result.evidenceBoundary.neutralizedValues + protectedExecution.neutralizedValues,
    },
  };
}

function qaCommandWorkingDirectory(result: QaDraftResult): string {
  const workspaceRoot = path.resolve(result.analysisScope.workspaceRoot);
  if (
    result.analysisScope.commandCwd === "selected-package" &&
    result.analysisScope.selectedPath
  ) {
    return path.resolve(workspaceRoot, result.analysisScope.selectedPath);
  }
  return workspaceRoot;
}

export function formatMarkdownQaValidation(result: QaDraftResult): string {
  const lines = [
    "# QAMap QA Run",
    "",
    "> QAMap re-analyzed the current change before selecting and executing repository validation.",
    "",
    "## Decision",
    "",
  ];
  const intent = result.changeAnalysis.intents[0];
  lines.push(`- Change intent: ${intent ? markdownText(intent.title) : "not inferred"}`);
  lines.push(
    `- Affected behavior: ${
      result.flows.length > 0
        ? result.flows.slice(0, 3).map((flow) => markdownText(flow.title)).join(", ")
        : "no changed flow candidate"
    }`,
  );
  lines.push(`- Selected action: ${result.route.nextAction}`);
  lines.push(
    `- Capability receipt: ${result.capabilities.map((capability) =>
      `${capability.id} ${capability.status}/${capability.level}`
    ).join("; ")}`,
  );
  const source = result.traces
    .flatMap((candidate) => candidate.sources)
    .find((candidate) => candidate.file);
  if (source?.file) {
    const line = source.startLine ? `:${source.startLine}` : "";
    lines.push(`- Strongest source: \`${markdownCode(`${source.file}${line}`)}\``);
  }
  lines.push("");
  lines.push("## Execution Receipt");
  lines.push("");
  if (result.execution.status === "blocked") {
    lines.push("- Status: blocked");
    lines.push("- Performed: no");
    lines.push(`- Reason: ${markdownText(result.execution.reason)}`);
    if (result.execution.command) {
      lines.push(`- Selected command: \`${markdownCode(result.execution.command)}\``);
    }
  } else if (result.execution.status === "not-run") {
    lines.push("- Status: not run");
    lines.push("- Performed: no");
  } else {
    lines.push(`- Status: ${result.execution.status}`);
    lines.push("- Performed: yes");
    lines.push(`- Command: \`${markdownCode(result.execution.command)}\``);
    const commandLocation = result.analysisScope.commandCwd === "selected-package" &&
        result.analysisScope.selectedPath
      ? `selected package \`${markdownCode(result.analysisScope.selectedPath)}\``
      : "workspace root";
    lines.push(`- Working directory: ${commandLocation} (command-relative \`${result.execution.cwd}\`)`);
    lines.push(`- Exit code: ${result.execution.exitCode ?? "not available"}`);
    lines.push(`- Duration: ${result.execution.durationMs} ms`);
    lines.push(`- Timed out: ${result.execution.timedOut ? "yes" : "no"}`);
    lines.push(
      `- Output evidence: stdout ${result.execution.stdoutBytes} bytes ` +
        `(\`${result.execution.stdoutSha256.slice(0, 12)}\`), stderr ${result.execution.stderrBytes} bytes ` +
        `(\`${result.execution.stderrSha256.slice(0, 12)}\`)`,
    );
    if (result.execution.gitState.observed) {
      lines.push(
        `- Git-observable worktree changes: ${result.execution.gitState.changed ? "yes" : "no"}`,
      );
      if (result.execution.gitState.changed) {
        if (result.execution.gitState.headChanged || result.execution.gitState.branchChanged) {
          lines.push(
            `- Git reference changed: ${
              [
                result.execution.gitState.headChanged ? "HEAD" : undefined,
                result.execution.gitState.branchChanged ? "branch" : undefined,
              ].filter(Boolean).join(" and ")
            }`,
          );
        }
        lines.push(`- Changed path count: ${result.execution.gitState.changedPathCount}`);
        if (result.execution.gitState.changedPaths.length > 0) {
          lines.push(
            `- Changed paths: ${result.execution.gitState.changedPaths
              .map((candidate) => `\`${markdownCode(markdownText(candidate))}\``)
              .join(", ")}${result.execution.gitState.truncated ? ", ..." : ""}`,
          );
        }
      }
    } else {
      lines.push(`- Git-observable worktree changes: unknown; ${result.execution.gitState.reason}`);
    }
  }
  lines.push("");
  lines.push(
    "Command output is not embedded in the receipt. Human terminal mode streams it directly; JSON and agent formats retain only bounded metadata and hashes.",
  );
  lines.push("");
  return lines.join("\n");
}

function withBlockedExecution(
  result: QaDraftResult,
  reason: string,
  command?: string,
): QaDraftResult {
  const execution: QaBlockedExecutionReceipt = {
    status: "blocked",
    performed: false,
    scope: "repository-validation",
    reason,
    ...(command ? { command } : {}),
  };
  return {
    ...result,
    execution,
  };
}

function isExecutableSelectedCommand(command: string): boolean {
  return command.length > 0 &&
    command.length <= maximumCommandLength &&
    !/[\0\r\n]/.test(command) &&
    command !== neutralizedInstructionText;
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) {
    return defaultTimeoutMs;
  }
  if (!Number.isInteger(value) || value < 1_000 || value > maximumTimeoutMs) {
    throw new Error(`qa run timeout must be between 1000 and ${maximumTimeoutMs} milliseconds`);
  }
  return value;
}

async function executeSelectedCommand(
  command: string,
  cwd: string,
  options: {
    timeoutMs: number;
    onStdout?: (chunk: Uint8Array) => void;
    onStderr?: (chunk: Uint8Array) => void;
  },
): Promise<QaCompletedExecutionReceipt> {
  const startedAt = Date.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  const beforeGitState = await captureGitState(cwd);

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: repositoryCommandEnvironment(),
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      stdoutHash.update(chunk);
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      stderrHash.update(chunk);
      options.onStderr?.(chunk);
    });

    let spawnError = false;
    child.once("error", () => {
      spawnError = true;
    });

    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid, child, "SIGTERM");
      forceKillTimeout = setTimeout(() => {
        terminateProcessTree(child.pid, child, "SIGKILL");
      }, 2_000);
      forceKillTimeout.unref();
    }, options.timeoutMs);

    child.once("close", async (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      const passed = !spawnError && !timedOut && exitCode === 0;
      const afterGitState = await captureGitState(cwd);
      resolve({
        status: passed ? "passed" : "failed",
        performed: true,
        scope: "repository-validation",
        command,
        cwd: ".",
        ...(exitCode === null ? {} : { exitCode }),
        ...(signal ? { signal } : {}),
        durationMs: Date.now() - startedAt,
        timedOut,
        stdoutBytes,
        stderrBytes,
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
        gitState: compareGitState(beforeGitState, afterGitState),
      });
    });
  });
}

export interface GitStateSnapshot {
  fingerprint: string;
  entries: Map<string, string>;
  head: string;
  branch: string;
}

export async function captureGitState(root: string): Promise<GitStateSnapshot | undefined> {
  try {
    const [statusOutput, headOutput, branchOutput] = await Promise.all([
      runGitForState(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      runGitForState(root, ["rev-parse", "--verify", "HEAD"]),
      runGitForState(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    ]);
    const statuses = parseGitStatus(statusOutput);
    const paths = [...statuses.keys()].sort();
    if (paths.length > maximumGitStatePaths) {
      return undefined;
    }
    const entries = new Map<string, string>();
    const fileBudget = { remainingBytes: maximumGitStateFileBytes };
    for (const candidate of paths) {
      entries.set(
        candidate,
        `${statuses.get(candidate)}:${await fingerprintGitPath(root, candidate, fileBudget)}`,
      );
    }
    const head = headOutput.toString("utf8").trim();
    const branch = branchOutput.toString("utf8").trim();
    return {
      entries,
      head,
      branch,
      fingerprint: fingerprintGitEntries(entries, head, branch),
    };
  } catch {
    return undefined;
  }
}

export function compareGitState(
  before: GitStateSnapshot | undefined,
  after: GitStateSnapshot | undefined,
): QaGitStateReceipt {
  if (!before || !after) {
    return {
      observed: false,
      changed: null,
      reason: "Git worktree state could not be read within the bounded observation policy.",
    };
  }
  const paths = [...new Set([...before.entries.keys(), ...after.entries.keys()])]
    .filter((candidate) => before.entries.get(candidate) !== after.entries.get(candidate))
    .sort();
  return {
    observed: true,
    changed: before.fingerprint !== after.fingerprint,
    changedPathCount: paths.length,
    changedPaths: paths.slice(0, gitStateReceiptPathLimit),
    truncated: paths.length > gitStateReceiptPathLimit,
    headChanged: before.head !== after.head,
    branchChanged: before.branch !== after.branch,
    beforeSha256: before.fingerprint,
    afterSha256: after.fingerprint,
  };
}

async function runGitForState(root: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceededLimit = false;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximumGitOutputBytes) {
        exceededLimit = true;
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode !== 0 || exceededLimit) {
        reject(new Error("bounded Git state query failed"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function parseGitStatus(output: Buffer): Map<string, string> {
  const records = output.toString("utf8").split("\0");
  const statuses = new Map<string, string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) {
      continue;
    }
    const status = record.slice(0, 2);
    const candidate = record.slice(3);
    statuses.set(candidate, status);
    if (status[0] === "R" || status[0] === "C") {
      const source = records[index + 1];
      if (source) {
        statuses.set(source, `${status}:source`);
        index += 1;
      }
    }
  }
  return statuses;
}

async function fingerprintGitPath(
  root: string,
  relativePath: string,
  budget: { remainingBytes: number },
): Promise<string> {
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return "outside-workspace";
  }
  try {
    const stat = await lstat(absolutePath);
    if (stat.isSymbolicLink()) {
      return `symlink:${sha256(await readlink(absolutePath))}`;
    }
    if (!stat.isFile()) {
      return `mode:${stat.mode}`;
    }
    if (stat.size > budget.remainingBytes) {
      throw new Error("Git state file hashing exceeded its bounded byte budget");
    }
    budget.remainingBytes -= stat.size;
    return `file:${stat.mode}:${await hashFile(absolutePath)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "deleted";
    }
    throw error;
  }
}

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

function fingerprintGitEntries(
  entries: Map<string, string>,
  head: string,
  branch: string,
): string {
  const hash = createHash("sha256");
  hash.update(`HEAD\0${head}\0BRANCH\0${branch}\0`);
  for (const [candidate, fingerprint] of entries) {
    hash.update(candidate);
    hash.update("\0");
    hash.update(fingerprint);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function terminateProcessTree(
  pid: number | undefined,
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process-group termination is unavailable.
    }
  }
  child.kill(signal);
}

function repositoryCommandEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // Node propagates this marker to child processes launched from node:test.
  // Removing it prevents a repository test command from being skipped as recursive.
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function markdownText(value: string): string {
  return value.replaceAll("\n", " ").replaceAll("\r", " ").trim();
}

function markdownCode(value: string): string {
  return value.replaceAll("`", "\\`");
}
