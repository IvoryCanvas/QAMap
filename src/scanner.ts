import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { collectProjectFiles, getFile, getFilesUnder, pathExists } from "./fs.js";
import { TOOL_NAME, VERSION } from "./version.js";
import type { Finding, ProjectFile, ScanCounts, ScanOptions, ScanResult, Severity } from "./types.js";

const defaultMaxFiles = 2000;

const instructionFileNames = new Set([
  "AGENTS.md",
  "AGENTS.override.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".cursorrules",
]);

const instructionDirectoryPatterns = [
  { directory: ".cursor/rules", pattern: /\.(md|mdc)$/i },
  { directory: ".claude/rules", pattern: /\.(md|mdc)$/i },
  { directory: ".github/instructions", pattern: /\.instructions\.md$/i },
];

const mcpConfigNames = new Set([
  ".mcp.json",
  "mcp.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  "claude_desktop_config.json",
]);

const agentSettingsNames = new Set([".claude/settings.json", ".claude/settings.local.json", ".gemini/settings.json"]);

const secretKeyPattern = /(token|secret|password|passwd|api[_-]?key|private[_-]?key|credential)/i;

export async function scanProject(rootInput: string, options: ScanOptions = {}): Promise<ScanResult> {
  const root = path.resolve(rootInput);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error(`QAMap expected a directory: ${root}`);
  }

  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  if (workspaceRoot) {
    const workspaceStat = await fs.stat(workspaceRoot);
    if (!workspaceStat.isDirectory()) {
      throw new Error(`QAMap expected a workspace root directory: ${workspaceRoot}`);
    }
    const relativeRoot = path.relative(workspaceRoot, root);
    if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
      throw new Error(`QAMap scan path must be inside workspace root: ${root}`);
    }
  }

  const files = await collectProjectFiles(root, options.maxFiles ?? defaultMaxFiles);
  const workspaceFiles =
    workspaceRoot && workspaceRoot !== root ? await collectWorkspaceGuardrailFiles(workspaceRoot) : [];
  const guardrailFiles = dedupeFiles([...files, ...workspaceFiles]);
  const rawFindings = [
    ...checkAgentInstructions(guardrailFiles),
    ...checkInstructionConflicts(guardrailFiles),
    ...checkSuspiciousInstructionText(guardrailFiles),
    ...checkMcpConfig(guardrailFiles),
    ...checkAgentSettings(guardrailFiles),
    ...checkPackageScripts(files),
    ...checkApiContractSource(files),
    ...checkGitHubActions(guardrailFiles),
    ...checkCommittedEnvFiles(files),
    ...checkCommunityHealth(guardrailFiles),
  ];
  const findings = applyFindingPolicy(rawFindings, options);

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    workspaceRoot,
    scannedAt: new Date().toISOString(),
    filesInspected: files.length + workspaceFiles.length,
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

async function collectWorkspaceGuardrailFiles(workspaceRoot: string): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  const candidatePaths = [
    ...instructionFileNames,
    ...mcpConfigNames,
    ...agentSettingsNames,
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
  ];

  for (const relativePath of candidatePaths) {
    const file = await readProjectFileIfPresent(workspaceRoot, relativePath);
    if (file) {
      files.push(file);
    }
  }

  for (const ruleDirectory of instructionDirectoryPatterns) {
    const instructionRoot = path.join(workspaceRoot, ruleDirectory.directory);
    if (await pathExists(instructionRoot)) {
      files.push(...(await collectTextFilesUnder(workspaceRoot, instructionRoot, ruleDirectory.pattern)));
    }
  }

  const workflowRoot = path.join(workspaceRoot, ".github/workflows");
  if (await pathExists(workflowRoot)) {
    files.push(...(await collectTextFilesUnder(workspaceRoot, workflowRoot, /\.(ya?ml)$/i)));
  }

  return dedupeFiles(files);
}

async function readProjectFileIfPresent(root: string, relativePath: string): Promise<ProjectFile | undefined> {
  const absolutePath = path.join(root, relativePath);
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return undefined;
    }
    return {
      path: relativePath,
      absolutePath,
      size: stat.size,
      text: await fs.readFile(absolutePath, "utf8"),
    };
  } catch {
    return undefined;
  }
}

async function collectTextFilesUnder(root: string, directory: string, pattern: RegExp): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];

  async function walk(currentDirectory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (!pattern.test(relativePath)) {
        continue;
      }

      const stat = await fs.stat(absolutePath);
      files.push({
        path: relativePath,
        absolutePath,
        size: stat.size,
        text: await fs.readFile(absolutePath, "utf8"),
      });
    }
  }

  await walk(directory);
  return files;
}

function dedupeFiles(files: ProjectFile[]): ProjectFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.absolutePath)) {
      return false;
    }
    seen.add(file.absolutePath);
    return true;
  });
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
    return instructionDirectoryPatterns.some((ruleDirectory) =>
      matchesDirectoryPattern(file.path, ruleDirectory.directory, ruleDirectory.pattern),
    );
  });
}

function matchesDirectoryPattern(filePath: string, directory: string, pattern: RegExp): boolean {
  const prefix = directory.endsWith("/") ? directory : `${directory}/`;
  return filePath.startsWith(prefix) && pattern.test(filePath);
}

function checkAgentInstructions(files: ProjectFile[]): Finding[] {
  const instructionFiles = getInstructionFiles(files);

  if (instructionFiles.length > 0) {
    return [];
  }

  return [
    finding({
      id: "QM001",
      title: "Missing agent instructions",
      severity: "medium",
      message: "No AGENTS.md, Claude, Cursor, Copilot, or Gemini instruction file was found.",
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
      id: "QM002",
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
          id: "QM003",
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
  const configs = files.filter((file) => (mcpConfigNames.has(file.path) || agentSettingsNames.has(file.path)) && file.text);

  for (const config of configs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config.text!);
    } catch {
      if (!mcpConfigNames.has(config.path)) {
        continue;
      }
      findings.push(
        finding({
          id: "QM004",
          title: "Unreadable MCP configuration",
          severity: "medium",
          file: config.path,
          message: "MCP configuration could not be parsed as JSON.",
          recommendation: "Fix the JSON syntax so MCP tooling and security checks can inspect the configuration.",
        }),
      );
      continue;
    }

    if (mcpConfigNames.has(config.path)) {
      inspectMcpValue(parsed, config.path, "$", findings);
      continue;
    }

    if (isRecord(parsed) && parsed.mcpServers) {
      inspectMcpValue(parsed.mcpServers, config.path, "$.mcpServers", findings);
    }
  }

  return findings;
}

function checkAgentSettings(files: ProjectFile[]): Finding[] {
  const findings: Finding[] = [];
  const settingsFiles = files.filter((file) => agentSettingsNames.has(file.path) && file.text);

  for (const settingsFile of settingsFiles) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(settingsFile.text!);
    } catch {
      findings.push(
        finding({
          id: "QM012",
          title: "Unreadable agent settings",
          severity: "medium",
          file: settingsFile.path,
          message: "Agent settings could not be parsed as JSON.",
          recommendation: "Fix the JSON syntax so agent hooks, permissions, and tool configuration can be inspected.",
        }),
      );
      continue;
    }

    inspectAgentHooks(parsed, settingsFile.path, findings);
    inspectAgentPermissions(parsed, settingsFile.path, findings);
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
          id: "QM004",
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
          id: "QM005",
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

function inspectAgentHooks(value: unknown, file: string, findings: Finding[]): void {
  if (!isRecord(value) || !value.hooks) {
    return;
  }

  inspectHookValue(value.hooks, file, "$.hooks", findings);
}

function inspectHookValue(value: unknown, file: string, location: string, findings: Finding[]): void {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectHookValue(item, file, `${location}[${index}]`, findings));
    return;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.command === "string") {
    const risk = classifyHookRisk(record.command);
    if (risk) {
      findings.push(
        finding({
          id: "QM012",
          title: "Risky agent hook command",
          severity: risk.severity,
          file,
          message: risk.message,
          recommendation:
            "Keep agent hooks narrow, auditable, and non-destructive; avoid hooks that publish, push, merge, remove files, or exfiltrate secrets.",
          evidence: `${location}.command=${redact(record.command)}`,
        }),
      );
    }
  }

  for (const [key, child] of Object.entries(record)) {
    inspectHookValue(child, file, `${location}.${key}`, findings);
  }
}

function inspectAgentPermissions(value: unknown, file: string, findings: Finding[]): void {
  if (!isRecord(value) || !isRecord(value.permissions)) {
    return;
  }

  const allowList = value.permissions.allow;
  if (!Array.isArray(allowList)) {
    return;
  }

  for (const [index, item] of allowList.entries()) {
    const risk = typeof item === "string" ? classifyShellPermission(item) : undefined;
    if (!risk) {
      continue;
    }

    findings.push(
      finding({
        id: "QM012",
        title: risk.title,
        severity: risk.severity,
        file,
        message: risk.message,
        recommendation:
          "Replace broad Bash allow rules with specific, read-only commands and keep destructive operations behind explicit maintainer review.",
        evidence: `$.permissions.allow[${index}]=${redact(item)}`,
      }),
    );
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
        id: "QM006",
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
        id: "QM006",
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
        id: "QM009",
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

function classifyHookRisk(command: string): { severity: Severity; message: string } | undefined {
  const scriptRisk = classifyScriptRisk(command);
  if (scriptRisk) {
    return {
      severity: scriptRisk.severity,
      message: `Agent hook ${scriptRisk.message}`,
    };
  }

  if (/\b(?:sudo|chmod\s+777)\b/i.test(command)) {
    return { severity: "high", message: "Agent hook contains a privileged or broad permission command." };
  }

  if (/\b(?:curl|wget|nc|ncat|scp|rsync)\b.{0,120}\b(?:secret|token|credential|private[_-]?key|\.env)\b/i.test(command)) {
    return { severity: "high", message: "Agent hook appears able to exfiltrate secrets or local environment data." };
  }

  if (/\b(?:cat|printenv|env)\b.{0,80}\b(?:secret|token|credential|private[_-]?key|\.env)\b/i.test(command)) {
    return { severity: "high", message: "Agent hook appears to print or expose secret-like data." };
  }

  return undefined;
}

function classifyShellPermission(
  value: string,
): { title: string; severity: Severity; message: string } | undefined {
  const match = value.match(/^Bash\((.*)\)$/i);
  if (!match) {
    return undefined;
  }

  const commandPattern = match[1].trim();
  if (commandPattern === "*") {
    return {
      title: "Broad agent shell permission",
      severity: "medium",
      message: "Agent settings allow any Bash command.",
    };
  }

  if (classifyScriptRisk(commandPattern)) {
    return {
      title: "Risky agent shell permission",
      severity: "high",
      message: "Agent settings allow risky publish, push, merge, destructive, or pipe-to-shell command patterns.",
    };
  }

  if (/\b(?:sudo|chmod\s+777)\b/i.test(commandPattern)) {
    return {
      title: "Risky agent shell permission",
      severity: "high",
      message: "Agent settings allow privileged or broad permission command patterns.",
    };
  }

  return undefined;
}

function checkApiContractSource(files: ProjectFile[]): Finding[] {
  const proseApiDocs = files.filter(isProseApiDoc);
  if (proseApiDocs.length === 0 || hasMachineReadableApiContract(files)) {
    return [];
  }

  const evidence = proseApiDocs
    .slice(0, 3)
    .map((file) => file.path)
    .join(", ");

  return [
    finding({
      id: "QM013",
      title: "Documentation-only API contract",
      severity: "low",
      file: proseApiDocs[0].path,
      message:
        "API endpoints appear to be documented in prose, but no machine-readable contract source was found.",
      recommendation:
        "Choose a single source of truth for API contracts, such as OpenAPI, protobuf, GraphQL SDL, AsyncAPI, or another IDL that can generate docs and client types.",
      evidence,
    }),
  ];
}

function isProseApiDoc(file: ProjectFile): boolean {
  if (!file.text || !/\.(md|mdx|txt)$/i.test(file.path)) {
    return false;
  }

  const basename = path.basename(file.path).toLowerCase();
  const pathSignal = /(?:^|[-_/])(api|apis|endpoint|endpoints|contract|swagger|openapi)(?:[-_.]|$)/i.test(file.path);
  if (!pathSignal && !/\bapi\b/i.test(basename)) {
    return false;
  }

  return /\b(GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_/{:.-]+/.test(file.text);
}

function hasMachineReadableApiContract(files: ProjectFile[]): boolean {
  return files.some((file) => {
    const basename = path.basename(file.path).toLowerCase();
    const extension = path.extname(file.path).toLowerCase();

    if (["buf.yaml", "buf.gen.yaml", "asyncapi.yaml", "asyncapi.yml", "asyncapi.json"].includes(basename)) {
      return true;
    }
    if (/^openapi\.(json|ya?ml)$/i.test(basename) || /^swagger\.(json|ya?ml)$/i.test(basename)) {
      return true;
    }
    if (extension === ".proto" || extension === ".graphql" || extension === ".graphqls") {
      return true;
    }
    if (/schema\.graphqls?$/i.test(file.path)) {
      return true;
    }

    return false;
  });
}

function checkGitHubActions(files: ProjectFile[]): Finding[] {
  const workflowFiles = getFilesUnder(files, ".github/workflows").filter((file) => /\.(ya?ml)$/i.test(file.path));

  if (workflowFiles.length === 0) {
    return [
      finding({
        id: "QM007",
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
          id: "QM010",
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
          id: "QM010",
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
          id: "QM010",
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
        id: "QM008",
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
      id: "QM011",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function hasAgentInstructions(root: string): Promise<boolean> {
  for (const fileName of instructionFileNames) {
    if (await pathExists(path.join(root, fileName))) {
      return true;
    }
  }
  for (const ruleDirectory of instructionDirectoryPatterns) {
    if (await pathExists(path.join(root, ruleDirectory.directory))) {
      return true;
    }
  }
  return false;
}
