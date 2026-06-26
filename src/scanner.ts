import { promises as fs } from "node:fs";
import path from "node:path";
import { collectProjectFiles, getFile, getFilesUnder, pathExists } from "./fs.js";
import { TOOL_NAME, VERSION } from "./version.js";
import type { Finding, ProjectFile, ScanCounts, ScanOptions, ScanResult, Severity } from "./types.js";

const defaultMaxFiles = 2000;

const instructionFileNames = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
]);

const mcpConfigNames = new Set([
  ".mcp.json",
  "mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  "claude_desktop_config.json",
]);

const secretKeyPattern = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i;

export async function scanProject(rootInput: string, options: ScanOptions = {}): Promise<ScanResult> {
  const root = path.resolve(rootInput);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`CodeWard expected a directory: ${root}`);
  }

  const files = await collectProjectFiles(root, options.maxFiles ?? defaultMaxFiles);
  const rawFindings = [
    ...checkAgentInstructions(files),
    ...checkInstructionConflicts(files),
    ...checkSuspiciousInstructionText(files),
    ...checkMcpConfig(files),
    ...checkPackageScripts(files),
    ...checkGitHubActions(files),
    ...checkCommittedEnvFiles(files),
    ...checkCommunityHealth(files),
  ];
  const findings = applyFindingPolicy(rawFindings, options);

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    scannedAt: new Date().toISOString(),
    filesInspected: files.length,
    config:
      options.configPath || options.ignoreRules?.length || Object.keys(options.severityOverrides ?? {}).length
        ? {
            path: options.configPath,
            ignoredRules: normalizeRuleIds(options.ignoreRules ?? []),
            severityOverrides: normalizeSeverityOverrides(options.severityOverrides ?? {}),
          }
        : undefined,
    findings,
    counts: countFindings(findings),
  };
}

function countFindings(findings: Finding[]): ScanCounts {
  return findings.reduce<ScanCounts>(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { info: 0, low: 0, medium: 0, high: 0 },
  );
}

function finding(input: Omit<Finding, "recommendation"> & { recommendation?: string }): Finding {
  return {
    recommendation: "Review this finding and add an explicit repository policy.",
    ...input,
  };
}

function applyFindingPolicy(findings: Finding[], options: ScanOptions): Finding[] {
  const ignoredRules = new Set(normalizeRuleIds(options.ignoreRules ?? []));
  const severityOverrides = normalizeSeverityOverrides(options.severityOverrides ?? {});

  return findings
    .filter((item) => !ignoredRules.has(item.id.toUpperCase()))
    .map((item) => {
      const override = severityOverrides[item.id.toUpperCase()];
      if (!override || override === item.severity) {
        return item;
      }
      return {
        ...item,
        originalSeverity: item.severity,
        severity: override,
      };
    });
}

function normalizeRuleIds(ruleIds: string[]): string[] {
  return [...new Set(ruleIds.map((ruleId) => ruleId.toUpperCase()))];
}

function normalizeSeverityOverrides(overrides: Record<string, Severity>): Record<string, Severity> {
  return Object.fromEntries(Object.entries(overrides).map(([ruleId, severity]) => [ruleId.toUpperCase(), severity]));
}

function getInstructionFiles(files: ProjectFile[]): ProjectFile[] {
  return files.filter((file) => {
    if (instructionFileNames.has(file.path)) {
      return true;
    }
    return file.path.startsWith(".cursor/rules/") && /\.(md|mdc)$/i.test(file.path);
  });
}

function checkAgentInstructions(files: ProjectFile[]): Finding[] {
  const instructionFiles = getInstructionFiles(files);

  if (instructionFiles.length > 0) {
    return [];
  }

  return [
    finding({
      id: "CW001",
      title: "Missing agent instructions",
      severity: "medium",
      message: "No AGENTS.md, CLAUDE.md, Cursor rules, or Copilot instruction file was found.",
      recommendation:
        "Add AGENTS.md or an equivalent agent instruction file with build, test, review, and repository boundary rules.",
    }),
  ];
}

function checkInstructionConflicts(files: ProjectFile[]): Finding[] {
  const instructionFiles = getInstructionFiles(files).filter((file) => file.text);
  if (instructionFiles.length === 0) {
    return [];
  }

  const lines = instructionFiles.flatMap((file) =>
    file
      .text!.split(/\r?\n/)
      .map((line, index) => ({ file: file.path, line: index + 1, text: line.trim() }))
      .filter((line) => line.text.length > 0),
  );

  const signals = new Map<string, string[]>();
  for (const line of lines) {
    addSignal(signals, line, "package-manager:npm", /\b(use|prefer|run)\s+npm\b/i);
    addSignal(signals, line, "package-manager:pnpm", /\b(use|prefer|run)\s+pnpm\b/i);
    addSignal(signals, line, "package-manager:yarn", /\b(use|prefer|run)\s+yarn\b/i);
    addSignal(signals, line, "package-manager:bun", /\b(use|prefer|run)\s+bun\b/i);
    addSignal(signals, line, "tests:required", /\b(always|must|required|run)\b.{0,40}\btests?\b/i);
    addSignal(signals, line, "tests:skip", /\b(skip|avoid|do not|don't|never)\b.{0,40}\btests?\b/i);

    if (/push directly to (main|master)/i.test(line.text) && !/\b(do not|don't|never|avoid|no)\b/i.test(line.text)) {
      pushSignal(signals, "main-push:allowed", line);
    }
    if (/\b(do not|don't|never|avoid|no)\b.{0,40}push directly to (main|master)/i.test(line.text)) {
      pushSignal(signals, "main-push:forbidden", line);
    }
  }

  const conflicts: string[] = [];
  const packageManagers = ["npm", "pnpm", "yarn", "bun"].filter((name) => signals.has(`package-manager:${name}`));
  if (packageManagers.length > 1) {
    conflicts.push(`Multiple package managers mentioned: ${packageManagers.join(", ")}`);
  }
  if (signals.has("tests:required") && signals.has("tests:skip")) {
    conflicts.push("Instructions both require and discourage tests.");
  }
  if (signals.has("main-push:allowed") && signals.has("main-push:forbidden")) {
    conflicts.push("Instructions both allow and forbid direct pushes to the default branch.");
  }

  if (conflicts.length === 0) {
    return [];
  }

  return [
    finding({
      id: "CW002",
      title: "Conflicting agent instructions",
      severity: "medium",
      message: conflicts.join(" "),
      recommendation:
        "Consolidate agent instructions so coding agents get one clear policy for package management, validation, and protected branches.",
      evidence: Array.from(signals.values()).flat().slice(0, 4).join(" | "),
    }),
  ];
}

function addSignal(
  signals: Map<string, string[]>,
  line: { file: string; line: number; text: string },
  key: string,
  pattern: RegExp,
): void {
  if (pattern.test(line.text)) {
    pushSignal(signals, key, line);
  }
}

function pushSignal(
  signals: Map<string, string[]>,
  key: string,
  line: { file: string; line: number; text: string },
): void {
  const existing = signals.get(key) ?? [];
  existing.push(`${line.file}:${line.line}`);
  signals.set(key, existing);
}

function checkSuspiciousInstructionText(files: ProjectFile[]): Finding[] {
  const instructionFiles = getInstructionFiles(files).filter((file) => file.text);
  const findings: Finding[] = [];
  const suspiciousPatterns = [
    {
      label: "instruction override",
      pattern: new RegExp(["ignore", "(?:all\\s+)?previous", "instructions"].join("\\s+"), "i"),
    },
    {
      label: "secret exposure request",
      pattern: /\b(?:print|reveal|dump|show|upload|send)\b.{0,80}\b(?:secret|token|api key|private key|\.env)\b/i,
    },
    {
      label: "credential exfiltration",
      pattern: /\b(?:curl|wget|post|upload)\b.{0,80}\b(?:secret|token|\.env|credential)\b/i,
    },
  ];

  for (const file of instructionFiles) {
    const lines = file.text!.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = suspiciousPatterns.find((item) => item.pattern.test(line));
      if (!match) {
        continue;
      }

      findings.push(
        finding({
          id: "CW003",
          title: "Suspicious agent instruction text",
          severity: "high",
          file: file.path,
          message: `Instruction file contains text that matches a suspicious ${match.label} pattern.`,
          recommendation:
            "Remove untrusted instruction text or move examples into clearly fenced documentation that agents should not follow.",
          evidence: `${file.path}:${index + 1} ${redact(line.trim())}`,
        }),
      );
    }
  }

  return findings;
}

function checkMcpConfig(files: ProjectFile[]): Finding[] {
  const findings: Finding[] = [];
  const configs = files.filter((file) => mcpConfigNames.has(file.path) && file.text);

  for (const config of configs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config.text!);
    } catch {
      findings.push(
        finding({
          id: "CW004",
          title: "Unreadable MCP configuration",
          severity: "medium",
          file: config.path,
          message: "MCP configuration could not be parsed as JSON.",
          recommendation: "Fix the JSON syntax so MCP tooling and security checks can inspect the configuration.",
        }),
      );
      continue;
    }

    inspectMcpValue(parsed, config.path, "$", findings);
  }

  return findings;
}

function inspectMcpValue(value: unknown, file: string, location: string, findings: Finding[]): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectMcpValue(item, file, `${location}[${index}]`, findings));
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.command === "string") {
    const args = Array.isArray(record.args) ? record.args.map(String) : [];
    const commandRisk = classifyCommandRisk(record.command, args);
    if (commandRisk) {
      findings.push(
        finding({
          id: "CW004",
          title: "Risky MCP command",
          severity: commandRisk.severity,
          file,
          message: commandRisk.message,
          recommendation:
            "Prefer pinned, narrow MCP server commands and avoid shell wrappers, publish commands, direct pushes, or pipe-to-shell installers.",
          evidence: `${location}.command=${record.command}`,
        }),
      );
    }
  }

  if (record.env && typeof record.env === "object" && !Array.isArray(record.env)) {
    for (const [key, envValue] of Object.entries(record.env as Record<string, unknown>)) {
      if (!secretKeyPattern.test(key) || typeof envValue !== "string" || isPlaceholderSecret(envValue)) {
        continue;
      }

      findings.push(
        finding({
          id: "CW005",
          title: "Secret-like value in MCP config",
          severity: "high",
          file,
          message: `MCP config appears to embed a real value for ${key}.`,
          recommendation:
            "Reference secrets through environment variables or a secret manager instead of committing concrete values.",
          evidence: `${location}.env.${key}=${redact(envValue)}`,
        }),
      );
    }
  }

  for (const [key, child] of Object.entries(record)) {
    inspectMcpValue(child, file, `${location}.${key}`, findings);
  }
}

function classifyCommandRisk(command: string, args: string[]): { severity: Severity; message: string } | undefined {
  const executable = path.basename(command).toLowerCase();
  const argsText = args.join(" ");
  const fullCommand = `${command} ${argsText}`;

  if (["sh", "bash", "zsh", "fish", "cmd", "powershell", "pwsh"].includes(executable)) {
    return {
      severity: "high",
      message: "MCP server is launched through a shell, which makes the executed behavior harder to audit.",
    };
  }

  if (/\b(?:curl|wget)\b.+\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i.test(fullCommand)) {
    return {
      severity: "high",
      message: "MCP command appears to download and execute a remote script.",
    };
  }

  if (/\b(?:git\s+push|gh\s+pr\s+merge|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish)\b/i.test(fullCommand)) {
    return {
      severity: "high",
      message: "MCP command appears able to publish, push, or merge changes.",
    };
  }

  if (/\b(?:sudo|chmod\s+777|rm\s+-rf\s+(?:\/|~|\$HOME|\*))\b/i.test(fullCommand)) {
    return {
      severity: "high",
      message: "MCP command contains a destructive or privileged shell operation.",
    };
  }

  if (/\bdocker\b/i.test(command) && /\b--privileged\b/i.test(argsText)) {
    return {
      severity: "medium",
      message: "MCP command starts a privileged container.",
    };
  }

  return undefined;
}

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return true;
  }
  return (
    normalized.startsWith("$") ||
    normalized.startsWith("${") ||
    /^<.*>$/.test(normalized) ||
    /\b(?:your|example|placeholder|replace|changeme|todo)\b/i.test(normalized)
  );
}

function checkPackageScripts(files: ProjectFile[]): Finding[] {
  const packageFile = getFile(files, "package.json");
  if (!packageFile?.text) {
    return [];
  }

  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(packageFile.text) as { scripts?: Record<string, string> };
  } catch {
    return [
      finding({
        id: "CW006",
        title: "Unreadable package.json",
        severity: "medium",
        file: "package.json",
        message: "package.json could not be parsed.",
        recommendation: "Fix package.json so agents and CI can discover project scripts reliably.",
      }),
    ];
  }

  const findings: Finding[] = [];
  const testScript = parsed.scripts?.test;
  if (!testScript || /no test specified|exit\s+1/i.test(testScript)) {
    findings.push(
      finding({
        id: "CW006",
        title: "Missing test script",
        severity: "medium",
        file: "package.json",
        message: "package.json does not define a usable test script.",
        recommendation:
          "Add a real test script so AI-generated changes have a default validation command.",
      }),
    );
  }

  for (const [name, script] of Object.entries(parsed.scripts ?? {})) {
    const risk = classifyScriptRisk(script);
    if (!risk) {
      continue;
    }

    findings.push(
      finding({
        id: "CW009",
        title: "Risky package script",
        severity: risk.severity,
        file: "package.json",
        message: `The "${name}" script ${risk.message}`,
        recommendation:
          "Keep publish, push, merge, and destructive scripts outside default agent workflows or gate them with maintainer-only release processes.",
        evidence: `"${name}": "${redact(script)}"`,
      }),
    );
  }

  return findings;
}

function classifyScriptRisk(script: string): { severity: Severity; message: string } | undefined {
  if (/\b(?:git\s+push|gh\s+pr\s+merge|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish)\b/i.test(script)) {
    return { severity: "high", message: "can publish, push, or merge changes." };
  }

  if (/\b(?:curl|wget)\b.+\|\s*(?:sh|bash|zsh|pwsh|powershell)\b/i.test(script)) {
    return { severity: "high", message: "downloads and executes a remote script." };
  }

  if (/\brm\s+-rf\s+(?:\/|~|\$HOME|\*)\b/i.test(script)) {
    return { severity: "high", message: "contains a destructive remove command." };
  }

  return undefined;
}

function checkGitHubActions(files: ProjectFile[]): Finding[] {
  const workflowFiles = getFilesUnder(files, ".github/workflows").filter((file) => /\.(ya?ml)$/i.test(file.path));

  if (workflowFiles.length === 0) {
    return [
      finding({
        id: "CW007",
        title: "Missing CI workflow",
        severity: "low",
        message: "No GitHub Actions workflow was found.",
        recommendation: "Add a CI workflow that runs tests for pull requests and the default branch.",
      }),
    ];
  }

  const findings: Finding[] = [];
  for (const workflow of workflowFiles) {
    const text = workflow.text ?? "";
    if (/permissions:\s*write-all/i.test(text)) {
      findings.push(
        finding({
          id: "CW010",
          title: "Broad workflow permissions",
          severity: "medium",
          file: workflow.path,
          message: "Workflow grants write-all permissions.",
          recommendation:
            "Set the narrowest required permissions, usually contents: read for test workflows.",
        }),
      );
    }

    if (/contents:\s*write/i.test(text) && !/release|publish/i.test(workflow.path)) {
      findings.push(
        finding({
          id: "CW010",
          title: "Broad workflow permissions",
          severity: "medium",
          file: workflow.path,
          message: "Workflow grants contents: write outside an obvious release workflow.",
          recommendation:
            "Use contents: read for validation workflows and reserve contents: write for maintainer-controlled release jobs.",
        }),
      );
    }

    if (/pull_request_target:/i.test(text) && /actions\/checkout/i.test(text)) {
      findings.push(
        finding({
          id: "CW010",
          title: "Risky pull_request_target workflow",
          severity: "medium",
          file: workflow.path,
          message: "Workflow uses pull_request_target with checkout.",
          recommendation:
            "Avoid checking out untrusted pull request code in pull_request_target workflows unless the workflow is carefully sandboxed.",
        }),
      );
    }
  }

  return findings;
}

function checkCommittedEnvFiles(files: ProjectFile[]): Finding[] {
  return files
    .filter((file) => {
      const basename = path.basename(file.path);
      return basename.startsWith(".env") && basename !== ".env.example";
    })
    .map((file) =>
      finding({
        id: "CW008",
        title: "Committed environment file",
        severity: "high",
        file: file.path,
        message: "A local environment file appears to be present in the repository.",
        recommendation:
          "Remove committed environment files, rotate any exposed secrets, and keep only safe examples such as .env.example.",
      }),
    );
}

function checkCommunityHealth(files: ProjectFile[]): Finding[] {
  const required = ["LICENSE", "SECURITY.md", "CONTRIBUTING.md"];
  const missing = required.filter((file) => !files.some((candidate) => candidate.path === file));

  if (missing.length === 0) {
    return [];
  }

  return [
    finding({
      id: "CW011",
      title: "Missing community health files",
      severity: "low",
      message: `Missing ${missing.join(", ")}.`,
      recommendation:
        "Add license, contribution, and security policy files so public contributors know how to participate safely.",
    }),
  ];
}

function redact(value: string): string {
  return value
    .replace(/(ghp_|github_pat_|sk-[A-Za-z0-9_-]*|[A-Za-z0-9_]{20,})/g, "[redacted]")
    .slice(0, 180);
}

export async function hasAgentInstructions(root: string): Promise<boolean> {
  for (const fileName of instructionFileNames) {
    if (await pathExists(path.join(root, fileName))) {
      return true;
    }
  }
  return pathExists(path.join(root, ".cursor/rules"));
}
