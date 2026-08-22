// Deterministic success judgement for agent benchmark tasks. Every criterion
// is a local check against the repository the agent worked in: a file exists,
// a command exits with a code, a command prints a string, or a JSON value
// equals an expected literal. The model's prose is never read.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SECRET_ENV_PATTERN = /(key|token|secret|password|passwd|credential)/i;

export const LOCAL_CRITERIA_KINDS = ["file-exists", "command-exit", "stdout-includes", "json-path-equals"];

export async function judgeSuccess(criteria, repositoryRoot, { timeoutMs = 60_000 } = {}) {
  const root = path.resolve(repositoryRoot);
  const checks = [];
  for (const criterion of criteria) {
    let passed = false;
    let detail;
    try {
      passed = await evaluate(criterion, root, timeoutMs);
    } catch (error) {
      detail = (error instanceof Error ? error.message : String(error)).split(root).join("<repo>");
    }
    checks.push({
      kind: criterion.kind,
      description: criterion.description ?? describe(criterion),
      passed,
      ...(detail ? { detail } : {}),
    });
  }
  return { success: checks.length > 0 && checks.every((check) => check.passed), checks };
}

export function readJsonPath(value, jsonPath) {
  const segments = String(jsonPath)
    .split(".")
    .filter((segment) => segment.length > 0);
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    const key = Array.isArray(current) && /^\d+$/.test(segment) ? Number(segment) : segment;
    current = current[key];
  }
  return current;
}

async function evaluate(criterion, root, timeoutMs) {
  switch (criterion.kind) {
    case "file-exists": {
      const stats = await fs.stat(resolveInside(root, criterion.path)).catch(() => null);
      return Boolean(stats && stats.isFile());
    }
    case "command-exit": {
      const result = await runCommand(criterion.command, root, timeoutMs);
      return result.code === (criterion.exitCode ?? 0);
    }
    case "stdout-includes": {
      const result = await runCommand(criterion.command, root, timeoutMs);
      return result.stdout.includes(criterion.includes);
    }
    case "json-path-equals": {
      const file = resolveInside(root, criterion.path);
      // A missing answer file is an ordinary failed check, not a harness error.
      if (!(await fs.stat(file).catch(() => null))) return false;
      const text = await fs.readFile(file, "utf8");
      const actual = readJsonPath(JSON.parse(text), criterion.jsonPath);
      return actual !== undefined && JSON.stringify(actual) === JSON.stringify(criterion.equals);
    }
    default:
      throw new Error(`Unsupported success criterion kind "${criterion.kind}".`);
  }
}

function describe(criterion) {
  switch (criterion.kind) {
    case "file-exists":
      return `file exists: ${criterion.path}`;
    case "command-exit":
      return `command exits ${criterion.exitCode ?? 0}: ${criterion.command.join(" ")}`;
    case "stdout-includes":
      return `stdout includes ${JSON.stringify(criterion.includes)}: ${criterion.command.join(" ")}`;
    case "json-path-equals":
      return `${criterion.path} ${criterion.jsonPath} equals ${JSON.stringify(criterion.equals)}`;
    default:
      return String(criterion.kind);
  }
}

async function runCommand(command, cwd, timeoutMs) {
  const [file, ...commandArgs] = command;
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_ENV_PATTERN.test(key)) env[key] = value;
  }
  try {
    const result = await execFileAsync(file, commandArgs, {
      cwd,
      env: { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout: String(result.stdout ?? "") };
  } catch (error) {
    if (error && typeof error.code === "number") {
      return { code: error.code, stdout: String(error.stdout ?? "") };
    }
    throw error;
  }
}

function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, String(relativePath));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Criterion path escapes the repository root.");
  }
  return resolved;
}
