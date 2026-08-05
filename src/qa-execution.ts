import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  generateQaDraft,
} from "./qa.js";
import type {
  QaBlockedExecutionReceipt,
  QaCompletedExecutionReceipt,
  QaDraftOptions,
  QaDraftResult,
} from "./qa.js";
import { neutralizedInstructionText } from "./qa-contract.js";

const defaultTimeoutMs = 5 * 60 * 1000;
const maximumTimeoutMs = 30 * 60 * 1000;
const maximumCommandLength = 2_048;

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
  const workspaceRoot = path.resolve(result.analysisScope.workspaceRoot);
  const execution = await executeSelectedCommand(command, workspaceRoot, {
    timeoutMs,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
  });
  return {
    ...result,
    execution,
  };
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
    lines.push(`- Working directory: \`${result.execution.cwd}\``);
    lines.push(`- Exit code: ${result.execution.exitCode ?? "not available"}`);
    lines.push(`- Duration: ${result.execution.durationMs} ms`);
    lines.push(`- Timed out: ${result.execution.timedOut ? "yes" : "no"}`);
    lines.push(
      `- Output evidence: stdout ${result.execution.stdoutBytes} bytes ` +
        `(\`${result.execution.stdoutSha256.slice(0, 12)}\`), stderr ${result.execution.stderrBytes} bytes ` +
        `(\`${result.execution.stderrSha256.slice(0, 12)}\`)`,
    );
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

    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      const passed = !spawnError && !timedOut && exitCode === 0;
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
      });
    });
  });
}

function terminateProcessTree(
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
