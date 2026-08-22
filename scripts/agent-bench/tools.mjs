// Tool layer for the agent token benchmark. Generic tools give an agent
// ordinary repository access; the QAMap arm adds three tools that shell out to
// the local CLI. Every tool runs inside the throwaway fixture repository with a
// timeout, an output byte cap, and an environment stripped of secret-like
// variables, so model-chosen commands never see the provider key.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const SECRET_ENV_PATTERN = /(key|token|secret|password|passwd|credential)/i;
const MAX_GREP_FILE_BYTES = 512 * 1024;

export const GENERIC_TOOLS = [
  {
    name: "bash",
    description:
      "Run one shell command from the repository root and return its stdout, stderr, and exit code. " +
      "Output is truncated to a fixed byte cap. Network access is not part of the benchmark contract.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to run with bash -c." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file by repository-relative path. Output is truncated to a fixed byte cap.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative file path." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a repository-relative directory. Directory names end with a slash.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative directory; defaults to the root." },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "grep",
    description:
      "Search text files under a repository-relative path with a JavaScript regular expression and return " +
      "file:line matches. Version-control and dependency directories are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression source." },
        path: { type: "string", description: "Repository-relative file or directory; defaults to the root." },
        maxResults: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches; defaults to 50." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];

export const QAMAP_TOOLS = [
  {
    name: "qamap_qa",
    description:
      "Run `qamap qa . --base main --head HEAD` and return its report: changed behavior, QA scenarios, " +
      "diff evidence, and the next safe action. Static analysis only; it does not run product code.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["text", "markdown", "agent", "json"],
          description: "Report format; defaults to text.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "qamap_qa_run",
    description:
      "Run `qamap qa run . --base main --head HEAD`: re-analyze the change and execute only the existing " +
      "repository validation command QAMap selected, returning an explicit execution receipt.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "qamap_e2e_draft_dry_run",
    description:
      "Run `qamap e2e draft . --base main --head HEAD --dry-run` to preview the optional automation draft " +
      "for the changed flow without writing files.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

export function toolsForArm(arm) {
  if (arm === "generic") return GENERIC_TOOLS;
  if (arm === "qamap") return [...GENERIC_TOOLS, ...QAMAP_TOOLS];
  throw new Error(`Unknown benchmark arm "${arm}".`);
}

export function toolSchemaSha256(tools) {
  const canonical = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function createToolExecutor({
  repositoryRoot,
  cliPath,
  timeoutMs = 60_000,
  maxOutputBytes = 16_384,
}) {
  const root = path.resolve(repositoryRoot);
  const sanitize = await createPathSanitizer(root);
  const env = scrubbedEnvironment();

  async function runCommand(file, commandArgs) {
    try {
      const result = await execFileAsync(file, commandArgs, {
        cwd: root,
        env,
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes * 8,
      });
      return formatCommandOutput(result.stdout, result.stderr, 0, false);
    } catch (error) {
      const code = typeof error.code === "number" ? error.code : 1;
      return formatCommandOutput(error.stdout ?? "", error.stderr ?? "", code, Boolean(error.killed));
    }
  }

  function runQamap(commandArgs) {
    return runCommand(process.execPath, [cliPath, ...commandArgs]);
  }

  const handlers = {
    bash: (input) => runCommand("bash", ["-c", requireString(input, "command")]),
    read_file: async (input) => {
      const file = resolveInside(root, requireString(input, "path"));
      const stats = await fs.stat(file);
      if (!stats.isFile()) throw new Error("Path is not a file.");
      const handle = await fs.open(file, "r");
      try {
        const buffer = Buffer.alloc(Math.min(stats.size, maxOutputBytes));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    },
    list_dir: async (input) => {
      const directory = resolveInside(root, optionalString(input, "path") ?? ".");
      const entries = await fs.readdir(directory, { withFileTypes: true });
      return entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort()
        .join("\n");
    },
    grep: async (input) => {
      const pattern = new RegExp(requireString(input, "pattern"));
      const start = resolveInside(root, optionalString(input, "path") ?? ".");
      const limit = Number.isInteger(input.maxResults) ? Math.min(Math.max(input.maxResults, 1), 200) : 50;
      const matches = [];
      await grepPath(start, root, pattern, matches, limit);
      return matches.length > 0 ? matches.join("\n") : "No matches.";
    },
    qamap_qa: (input) => {
      const format = optionalString(input, "format") ?? "text";
      if (!["text", "markdown", "agent", "json"].includes(format)) {
        throw new Error("format must be text, markdown, agent, or json.");
      }
      return runQamap(["qa", ".", "--base", "main", "--head", "HEAD", "--format", format]);
    },
    qamap_qa_run: () => runQamap(["qa", "run", ".", "--base", "main", "--head", "HEAD"]),
    qamap_e2e_draft_dry_run: () =>
      runQamap(["e2e", "draft", ".", "--base", "main", "--head", "HEAD", "--dry-run"]),
  };

  return {
    async execute(name, input) {
      const handler = handlers[name];
      if (!handler) throw new Error(`Unknown tool "${name}".`);
      const output = await handler(input && typeof input === "object" ? input : {});
      return truncate(sanitize(output), maxOutputBytes);
    },
  };
}

async function grepPath(target, root, pattern, matches, limit) {
  if (matches.length >= limit) return;
  const stats = await fs.stat(target);
  if (stats.isDirectory()) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await grepPath(path.join(target, entry.name), root, pattern, matches, limit);
      if (matches.length >= limit) return;
    }
    return;
  }
  if (!stats.isFile() || stats.size > MAX_GREP_FILE_BYTES) return;
  const text = await fs.readFile(target, "utf8");
  if (text.includes("\u0000")) return;
  const relative = path.relative(root, target).split(path.sep).join("/");
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (pattern.test(line)) {
      matches.push(`${relative}:${index + 1}: ${line}`);
      if (matches.length >= limit) return;
    }
  }
}

function formatCommandOutput(stdout, stderr, code, timedOut) {
  const parts = [String(stdout)];
  if (String(stderr).length > 0) parts.push(`[stderr]\n${stderr}`);
  parts.push(timedOut ? `[timed out; exit ${code}]` : `[exit ${code}]`);
  return parts.join("\n");
}

function requireString(input, field) {
  const value = input[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}

function optionalString(input, field) {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function resolveInside(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path escapes the repository root.");
  }
  return resolved;
}

function truncate(text, maxBytes) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return `${Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")}\n[truncated to ${maxBytes} bytes]`;
}

function scrubbedEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
}

// Tool output may echo absolute temporary paths (for example a recovery report
// path). They are replaced before the text reaches the model so no machine
// path leaves the benchmark host.
async function createPathSanitizer(root) {
  const replacements = new Map();
  const add = async (value, placeholder) => {
    replacements.set(value, placeholder);
    try {
      replacements.set(await fs.realpath(value), placeholder);
    } catch {
      // A path that cannot be resolved still gets its literal replacement.
    }
  };
  await add(root, "<repo>");
  await add(path.dirname(root), "<tmp>");
  await add(os.tmpdir(), "<tmp>");
  const ordered = [...replacements.entries()].sort((left, right) => right[0].length - left[0].length);
  return (text) => {
    let output = String(text);
    for (const [value, placeholder] of ordered) {
      output = output.split(value).join(placeholder);
    }
    return output;
  };
}
