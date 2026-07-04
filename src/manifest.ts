import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { collectProjectFiles, pathExists, toPosixPath } from "./fs.js";
import { generateTestPlan } from "./test-plan.js";
import { TOOL_NAME, VERSION } from "./version.js";
import type { TestPlanChangedFile, TestPlanOptions } from "./test-plan.js";
import type { ProjectFile } from "./types.js";

export const defaultVerificationManifestPath = ".qamap/manifest.yaml";
export const verificationManifestSchemaUrl =
  "https://raw.githubusercontent.com/IvoryCanvas/qamap/main/schema/qamap-manifest.schema.json";

export type VerificationManifestCriticality = "low" | "medium" | "high";
export type VerificationManifestConfidence = "low" | "medium" | "high";
export type VerificationManifestRunner = "manual" | "maestro" | "playwright";
export type VerificationManifestSourceKind = "declared" | "inferred";
export type VerificationManifestAnchorKind = "api" | "component" | "file" | "route" | "test";
export type VerificationManifestCheckType = "contract" | "edge" | "failure" | "success" | "visual";
export type VerificationManifestMatchKind = "domain" | "flow" | "check";
export type VerificationManifestInstructionKind =
  | "adr"
  | "agent-instruction"
  | "context"
  | "goal"
  | "qa-runbook"
  | "release-runbook"
  | "runbook"
  | "test-runbook";
export type VerificationManifestInstructionRole =
  | "agent-skill"
  | "domain-context"
  | "harness-config"
  | "release-policy"
  | "safety-policy"
  | "test-runner"
  | "verification-rubric"
  | "workflow-lifecycle";

export interface VerificationManifestSource {
  kind: VerificationManifestSourceKind;
  confidence: VerificationManifestConfidence;
  from: string[];
}

export interface VerificationManifestDomain {
  id: string;
  name: string;
  paths: string[];
  criticality: VerificationManifestCriticality;
  source: VerificationManifestSource;
}

export interface VerificationManifestEntry {
  route?: string;
  source: VerificationManifestSourceKind;
}

export interface VerificationManifestAnchor {
  kind: VerificationManifestAnchorKind;
  path?: string;
  route?: string;
  symbol?: string;
  source: VerificationManifestSourceKind;
  confidence: VerificationManifestConfidence;
}

export interface VerificationManifestCheck {
  id: string;
  title: string;
  type: VerificationManifestCheckType;
  selector?: string;
  value?: string;
  steps?: string[];
}

export interface VerificationManifestFlow {
  id: string;
  domain?: string;
  name: string;
  entry?: VerificationManifestEntry;
  runner?: VerificationManifestRunner;
  anchors: VerificationManifestAnchor[];
  checks: VerificationManifestCheck[];
  source: VerificationManifestSource;
}

export interface VerificationManifestInstructionFile {
  path: string;
  kind: VerificationManifestInstructionKind;
  confidence: VerificationManifestConfidence;
  roles: VerificationManifestInstructionRole[];
  signals: string[];
}

export interface VerificationManifestContext {
  instructionFiles: VerificationManifestInstructionFile[];
  validationCommands: string[];
  safetyRules: string[];
  source: VerificationManifestSource;
}

export interface VerificationManifest {
  $schema?: string;
  version: 1;
  context?: VerificationManifestContext;
  domains: VerificationManifestDomain[];
  flows: VerificationManifestFlow[];
}

export interface LoadedVerificationManifest extends VerificationManifest {
  path?: string;
}

export interface VerificationManifestLoadOptions {
  manifestPath?: string;
}

export interface VerificationManifestInitOptions {
  workspaceRoot?: string;
  write?: string;
  force?: boolean;
  maxFiles?: number;
}

export interface VerificationManifestInitResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  workspaceRoot?: string;
  manifestRoot: string;
  path: string;
  generatedAt: string;
  manifest: VerificationManifest;
  summary: {
    domains: number;
    flows: number;
    anchors: number;
    checks: number;
    contextSources: number;
    validationCommands: number;
    safetyRules: number;
  };
}

export interface VerificationManifestMatch {
  kind: VerificationManifestMatchKind;
  id: string;
  name: string;
  manifestPath: string;
  updatePath: string;
  reason: string;
  evidenceSources: string[];
  nextActions: string[];
  repairHints: string[];
  matchedFiles: string[];
  confidence: VerificationManifestConfidence;
  criticality?: VerificationManifestCriticality;
  runner?: VerificationManifestRunner;
  entryRoute?: string;
  checks?: string[];
  checkType?: VerificationManifestCheckType;
  checkSelector?: string;
  checkValue?: string;
  checkSteps?: string[];
}

export type VerificationManifestValidationSeverity = "info" | "warning" | "error";
export type VerificationManifestValidationStatus = "valid" | "needs-work" | "missing" | "invalid";

export interface VerificationManifestValidationIssue {
  severity: VerificationManifestValidationSeverity;
  path: string;
  message: string;
  recommendation: string;
}

export interface VerificationManifestValidationResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  workspaceRoot?: string;
  manifestPath?: string;
  generatedAt: string;
  status: VerificationManifestValidationStatus;
  summary: {
    errors: number;
    warnings: number;
    info: number;
  };
  issues: VerificationManifestValidationIssue[];
}

export interface VerificationManifestExplainOptions extends TestPlanOptions {
  manifestPath?: string;
}

export interface VerificationManifestExplainResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  workspaceRoot?: string;
  manifestPath?: string;
  generatedAt: string;
  base: string;
  head: string;
  includeWorkingTree: boolean;
  changedFiles: TestPlanChangedFile[];
  matches: VerificationManifestMatch[];
}

export interface VerificationManifestContextOptions {
  workspaceRoot?: string;
  maxFiles?: number;
}

export interface VerificationManifestContextRoleSummary {
  role: VerificationManifestInstructionRole;
  sources: string[];
}

export interface VerificationManifestContextResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  workspaceRoot?: string;
  manifestRoot: string;
  manifestPath?: string;
  generatedAt: string;
  context?: VerificationManifestContext;
  roleSummary: VerificationManifestContextRoleSummary[];
  diagnostics: VerificationManifestValidationIssue[];
  summary: {
    contextSources: number;
    roles: number;
    validationCommands: number;
    safetyRules: number;
    diagnostics: number;
  };
}

const manifestCandidates = [
  ".qamap/manifest.yaml",
  ".qamap/manifest.yml",
  ".qamap/manifest.json",
];

const defaultMaxManifestFiles = 2500;

export async function loadVerificationManifest(
  rootInput: string,
  options: VerificationManifestLoadOptions = {},
): Promise<LoadedVerificationManifest> {
  const root = path.resolve(rootInput);
  const manifestPath = options.manifestPath ? path.resolve(options.manifestPath) : await findVerificationManifestPath(root);
  if (!manifestPath) {
    return { version: 1, domains: [], flows: [] };
  }

  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = parseVerificationManifest(raw, manifestPath);
  return {
    path: displayManifestPath(root, manifestPath),
    ...normalizeVerificationManifest(parsed, manifestPath),
  };
}

export async function writeVerificationManifestBaseline(
  rootInput: string,
  options: VerificationManifestInitOptions = {},
): Promise<VerificationManifestInitResult> {
  const root = path.resolve(rootInput);
  const manifestRoot = path.resolve(options.workspaceRoot ?? rootInput);
  const outputPath = path.resolve(manifestRoot, options.write ?? defaultVerificationManifestPath);
  if (!options.force && (await pathExists(outputPath))) {
    throw new Error(`Refusing to overwrite ${outputPath}. Pass --force to replace it.`);
  }

  const files = await collectProjectFiles(root, options.maxFiles ?? defaultMaxManifestFiles);
  const manifest = buildVerificationManifestBaseline(root, manifestRoot, files);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, formatVerificationManifestYaml(manifest), "utf8");

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    workspaceRoot: options.workspaceRoot ? manifestRoot : undefined,
    manifestRoot,
    path: outputPath,
    generatedAt: new Date().toISOString(),
    manifest,
    summary: summarizeManifest(manifest),
  };
}

export function matchVerificationManifest(
  manifest: LoadedVerificationManifest,
  changedFiles: TestPlanChangedFile[],
): VerificationManifestMatch[] {
  if (!manifest.path || changedFiles.length === 0) {
    return [];
  }

  const filePaths = changedFiles.map((file) => file.path);
  const matches: VerificationManifestMatch[] = [];

  for (const domain of manifest.domains) {
    const matchedFiles = filePaths.filter((file) => domain.paths.some((pattern) => matchesPathPattern(file, pattern)));
    if (matchedFiles.length === 0) {
      continue;
    }
    matches.push({
      kind: "domain",
      id: domain.id,
      name: domain.name,
      manifestPath: `${manifest.path} > domains.${domain.id}.paths`,
      updatePath: `${manifest.path} > domains.${domain.id}.paths`,
      reason: `Changed files match the manifest ${domain.name} domain paths.`,
      evidenceSources: domain.source.from,
      nextActions: domainNextActions(domain),
      repairHints: domainRepairHints(manifest.path, domain),
      matchedFiles: matchedFiles.slice(0, 12),
      confidence: domain.source.confidence,
      criticality: domain.criticality,
    });
  }

  for (const flow of manifest.flows) {
    const anchorMatches = matchFlowAnchors(flow, filePaths);
    if (anchorMatches.length === 0) {
      continue;
    }
    matches.push({
      kind: "flow",
      id: flow.id,
      name: flow.name,
      manifestPath: `${manifest.path} > flows.${flow.id}.anchors`,
      updatePath: `${manifest.path} > flows.${flow.id}.anchors`,
      reason: `Changed files match anchors for the ${flow.name} flow.`,
      evidenceSources: flow.source.from,
      nextActions: flowNextActions(flow),
      repairHints: flowRepairHints(manifest.path, flow),
      matchedFiles: anchorMatches.slice(0, 12),
      confidence: flow.source.confidence,
      runner: flow.runner,
      entryRoute: flow.entry?.route,
      checks: flow.checks.map((check) => check.title),
    });
    for (const check of flow.checks.slice(0, 4)) {
      matches.push({
        kind: "check",
        id: `${flow.id}.${check.id}`,
        name: check.title,
        manifestPath: `${manifest.path} > flows.${flow.id}.checks.${check.id}`,
        updatePath: `${manifest.path} > flows.${flow.id}.checks`,
        reason: `The ${flow.name} flow declares this ${check.type} verification check.`,
        evidenceSources: flow.source.from,
        nextActions: checkNextActions(flow, check),
        repairHints: checkRepairHints(manifest.path, flow, check),
        matchedFiles: anchorMatches.slice(0, 12),
        confidence: flow.source.confidence,
        runner: flow.runner,
        entryRoute: flow.entry?.route,
        checks: [check.title],
        checkType: check.type,
        checkSelector: check.selector,
        checkValue: check.value,
        checkSteps: check.steps,
      });
    }
  }

  return dedupeManifestMatches(matches).slice(0, 18);
}

export function changedFilesRelativeToManifestRoot(
  changedFiles: TestPlanChangedFile[],
  rootInput: string,
  manifestRootInput: string,
): TestPlanChangedFile[] {
  const root = path.resolve(rootInput);
  const manifestRoot = path.resolve(manifestRootInput);
  if (root === manifestRoot) {
    return changedFiles;
  }
  return changedFiles.map((file) => ({
    ...file,
    path: toPosixPath(path.relative(manifestRoot, path.join(root, file.path))),
  }));
}

export function formatVerificationManifestInitResult(result: VerificationManifestInitResult): string {
  return [
    `Wrote ${result.path}`,
    `Domains: ${result.summary.domains}`,
    `Flows: ${result.summary.flows}`,
    `Anchors: ${result.summary.anchors}`,
    `Checks: ${result.summary.checks}`,
    `Context sources: ${result.summary.contextSources}`,
    `Validation commands: ${result.summary.validationCommands}`,
    `Safety rules: ${result.summary.safetyRules}`,
    "Review and commit this file when the baseline should become team verification policy.",
  ].join("\n");
}

export async function validateVerificationManifest(
  rootInput: string,
  workspaceRootInput?: string,
  manifestPathInput?: string,
): Promise<VerificationManifestValidationResult> {
  const root = path.resolve(rootInput);
  const manifestRoot = path.resolve(workspaceRootInput ?? rootInput);
  const issues: VerificationManifestValidationIssue[] = [];
  let manifest: LoadedVerificationManifest;

  try {
    manifest = await loadVerificationManifest(manifestRoot, { manifestPath: manifestPathInput });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(issue("error", defaultVerificationManifestPath, message, "Fix the manifest syntax or schema, then run `qamap manifest validate` again."));
    return validationResult(root, workspaceRootInput ? manifestRoot : undefined, undefined, "invalid", issues);
  }

  if (!manifest.path) {
    issues.push(issue("error", defaultVerificationManifestPath, "No verification manifest was found.", "Run `qamap manifest init .` to create a baseline."));
    return validationResult(root, workspaceRootInput ? manifestRoot : undefined, undefined, "missing", issues);
  }

  validateDomainDefinitions(manifest, issues);
  validateManifestMetadata(manifest, issues);
  await validateManifestContext(manifest, manifestRoot, issues);
  await validateFlowDefinitions(manifest, manifestRoot, issues);

  const status = issues.some((item) => item.severity === "error")
    ? "invalid"
    : issues.some((item) => item.severity === "warning")
      ? "needs-work"
      : "valid";
  return validationResult(root, workspaceRootInput ? manifestRoot : undefined, manifest.path, status, issues);
}

export async function explainVerificationManifest(
  rootInput: string,
  options: VerificationManifestExplainOptions = {},
): Promise<VerificationManifestExplainResult> {
  const testPlan = await generateTestPlan(rootInput, options);
  const manifestRoot = testPlan.workspaceRoot ?? testPlan.root;
  const manifest = await loadVerificationManifest(manifestRoot, { manifestPath: options.manifestPath });
  const manifestChangedFiles = changedFilesRelativeToManifestRoot(testPlan.changedFiles, testPlan.root, manifestRoot);
  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root: testPlan.root,
    workspaceRoot: testPlan.workspaceRoot,
    manifestPath: manifest.path,
    generatedAt: new Date().toISOString(),
    base: testPlan.base,
    head: testPlan.head,
    includeWorkingTree: testPlan.includeWorkingTree,
    changedFiles: testPlan.changedFiles,
    matches: matchVerificationManifest(manifest, manifestChangedFiles),
  };
}

export async function analyzeVerificationManifestContext(
  rootInput: string,
  options: VerificationManifestContextOptions = {},
): Promise<VerificationManifestContextResult> {
  const root = path.resolve(rootInput);
  const manifestRoot = path.resolve(options.workspaceRoot ?? rootInput);
  const manifest = await loadVerificationManifest(manifestRoot);
  const files = await collectProjectFiles(root, options.maxFiles ?? defaultMaxManifestFiles);
  const scannedContext = buildManifestContext(root, manifestRoot, files);
  const context = manifest.context ?? scannedContext;
  const roleSummary = summarizeContextRoles(context);
  const diagnostics = await buildContextDiagnostics(manifest, context, scannedContext, manifestRoot);

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    workspaceRoot: options.workspaceRoot ? manifestRoot : undefined,
    manifestRoot,
    manifestPath: manifest.path,
    generatedAt: new Date().toISOString(),
    context,
    roleSummary,
    diagnostics,
    summary: {
      contextSources: context?.instructionFiles.length ?? 0,
      roles: roleSummary.length,
      validationCommands: context?.validationCommands.length ?? 0,
      safetyRules: context?.safetyRules.length ?? 0,
      diagnostics: diagnostics.length,
    },
  };
}

export function formatVerificationManifestValidationResult(
  result: VerificationManifestValidationResult,
  format: "text" | "json" | "markdown",
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  const lines: string[] = [];
  if (format === "markdown") {
    lines.push("# QAMap Manifest Validate", "");
    lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
    if (result.workspaceRoot) {
      lines.push(`- Workspace root: \`${escapeMarkdownInline(result.workspaceRoot)}\``);
    }
    lines.push(`- Status: ${result.status}`);
    lines.push(`- Manifest: ${result.manifestPath ? `\`${escapeMarkdownInline(result.manifestPath)}\`` : "not found"}`);
    lines.push(`- Issues: ${result.summary.errors} errors, ${result.summary.warnings} warnings, ${result.summary.info} info`);
    lines.push("");
    if (result.issues.length > 0) {
      lines.push("## Issues", "");
      for (const item of result.issues) {
        lines.push(`- [${item.severity}] \`${escapeMarkdownInline(item.path)}\`: ${escapeMarkdownInline(item.message)}`);
        lines.push(`  - Fix: ${escapeMarkdownInline(item.recommendation)}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  lines.push("QAMap Manifest Validate");
  lines.push(`Root: ${result.root}`);
  if (result.workspaceRoot) {
    lines.push(`Workspace root: ${result.workspaceRoot}`);
  }
  lines.push(`Status: ${result.status}`);
  lines.push(`Manifest: ${result.manifestPath ?? "not found"}`);
  lines.push(`Issues: ${result.summary.errors} errors, ${result.summary.warnings} warnings, ${result.summary.info} info`);
  for (const item of result.issues) {
    lines.push(`- [${item.severity}] ${item.path}: ${item.message}`);
    lines.push(`  Fix: ${item.recommendation}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatVerificationManifestExplainResult(
  result: VerificationManifestExplainResult,
  format: "text" | "json" | "markdown",
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  const lines: string[] = [];
  if (format === "markdown") {
    lines.push("# QAMap Manifest Explain", "");
    lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
    if (result.workspaceRoot) {
      lines.push(`- Workspace root: \`${escapeMarkdownInline(result.workspaceRoot)}\``);
    }
    lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
    lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
    lines.push(`- Manifest: ${result.manifestPath ? `\`${escapeMarkdownInline(result.manifestPath)}\`` : "not found"}`);
    lines.push(`- Changed files: ${result.changedFiles.length}`);
    lines.push(`- Matches: ${result.matches.length}`);
    lines.push("");
    appendExplainMatches(lines, result.matches, "markdown");
    return lines.join("\n");
  }

  lines.push("QAMap Manifest Explain");
  lines.push(`Root: ${result.root}`);
  if (result.workspaceRoot) {
    lines.push(`Workspace root: ${result.workspaceRoot}`);
  }
  lines.push(`Base: ${result.base}`);
  lines.push(`Head: ${result.head}`);
  lines.push(`Manifest: ${result.manifestPath ?? "not found"}`);
  lines.push(`Changed files: ${result.changedFiles.length}`);
  lines.push(`Matches: ${result.matches.length}`);
  appendExplainMatches(lines, result.matches, "text");
  return `${lines.join("\n")}\n`;
}

export function formatVerificationManifestContextResult(
  result: VerificationManifestContextResult,
  format: "text" | "json" | "markdown",
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  const context = result.context;
  const lines: string[] = [];
  if (format === "markdown") {
    lines.push("# QAMap Manifest Context", "");
    lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
    if (result.workspaceRoot) {
      lines.push(`- Workspace root: \`${escapeMarkdownInline(result.workspaceRoot)}\``);
    }
    lines.push(`- Manifest root: \`${escapeMarkdownInline(result.manifestRoot)}\``);
    lines.push(`- Manifest: ${result.manifestPath ? `\`${escapeMarkdownInline(result.manifestPath)}\`` : "not found"}`);
    lines.push(`- Context sources: ${result.summary.contextSources}`);
    lines.push(`- Roles: ${result.summary.roles}`);
    lines.push(`- Validation commands: ${result.summary.validationCommands}`);
    lines.push(`- Safety rules: ${result.summary.safetyRules}`);
    lines.push(`- Diagnostics: ${result.summary.diagnostics}`);
    lines.push("");

    if (!context) {
      lines.push("No repo-local context sources were found.", "");
      appendContextDiagnostics(lines, result.diagnostics, "markdown");
      return lines.join("\n");
    }

    appendContextRoleSummary(lines, result.roleSummary, "markdown");
    appendContextSources(lines, context.instructionFiles, "markdown");
    appendContextValues(lines, "Validation Commands", context.validationCommands, "markdown");
    appendContextValues(lines, "Safety Rules", context.safetyRules, "markdown");
    appendContextDiagnostics(lines, result.diagnostics, "markdown");
    return lines.join("\n");
  }

  lines.push("QAMap Manifest Context");
  lines.push(`Root: ${result.root}`);
  if (result.workspaceRoot) {
    lines.push(`Workspace root: ${result.workspaceRoot}`);
  }
  lines.push(`Manifest root: ${result.manifestRoot}`);
  lines.push(`Manifest: ${result.manifestPath ?? "not found"}`);
  lines.push(`Context sources: ${result.summary.contextSources}`);
  lines.push(`Roles: ${result.summary.roles}`);
  lines.push(`Validation commands: ${result.summary.validationCommands}`);
  lines.push(`Safety rules: ${result.summary.safetyRules}`);
  lines.push(`Diagnostics: ${result.summary.diagnostics}`);
  lines.push("");

  if (!context) {
    lines.push("No repo-local context sources were found.");
    appendContextDiagnostics(lines, result.diagnostics, "text");
    return `${lines.join("\n")}\n`;
  }

  appendContextRoleSummary(lines, result.roleSummary, "text");
  appendContextSources(lines, context.instructionFiles, "text");
  appendContextValues(lines, "Validation Commands", context.validationCommands, "text");
  appendContextValues(lines, "Safety Rules", context.safetyRules, "text");
  appendContextDiagnostics(lines, result.diagnostics, "text");
  return `${lines.join("\n")}\n`;
}

export function formatVerificationManifestYaml(manifest: VerificationManifest): string {
  return `${YAML.stringify(manifest, { lineWidth: 100 }).trimEnd()}\n`;
}

function buildVerificationManifestBaseline(
  root: string,
  manifestRoot: string,
  files: ProjectFile[],
): VerificationManifest {
  const context = buildManifestContext(root, manifestRoot, files);
  const behaviorFiles = files
    .filter((file) => isBehaviorFile(file.path))
    .map((file) => ({
      ...file,
      path: toPosixPath(path.relative(manifestRoot, path.join(root, file.path))),
    }))
    .filter((file) => !file.path.startsWith("../"));
  const domains = buildBaselineDomains(behaviorFiles, context).slice(0, 12);
  const flows = buildBaselineFlows(behaviorFiles, domains, inferRunner(files), context).slice(0, 16);

  return {
    $schema: verificationManifestSchemaUrl,
    version: 1,
    ...(context ? { context } : {}),
    domains,
    flows,
  };
}

function validateManifestMetadata(
  manifest: LoadedVerificationManifest,
  issues: VerificationManifestValidationIssue[],
): void {
  if (!manifest.$schema) {
    issues.push(issue("info", `${manifest.path} > $schema`, "Manifest does not declare the QAMap manifest JSON schema.", "Add the `$schema` field generated by `qamap manifest init .` for editor validation."));
    return;
  }
  if (!/schema\/qamap-manifest\.schema\.json$/i.test(manifest.$schema)) {
    issues.push(issue("warning", `${manifest.path} > $schema`, "Manifest points at an unknown schema URL.", "Use the official QAMap manifest schema URL or remove the field if the team intentionally manages validation elsewhere."));
  }
}

function validateDomainDefinitions(manifest: LoadedVerificationManifest, issues: VerificationManifestValidationIssue[]): void {
  if (manifest.domains.length === 0) {
    issues.push(issue("warning", `${manifest.path} > domains`, "No domains are declared.", "Run `qamap manifest init .` or add product domains manually."));
  }
  const ids = new Set<string>();
  for (const domain of manifest.domains) {
    const basePath = `${manifest.path} > domains.${domain.id}`;
    if (ids.has(domain.id)) {
      issues.push(issue("error", basePath, `Duplicate domain id '${domain.id}'.`, "Give each domain a stable unique id."));
    }
    ids.add(domain.id);
    if (domain.paths.length === 0) {
      issues.push(issue("error", `${basePath}.paths`, "Domain has no path patterns.", "Add at least one path pattern so PR changes can map to this domain."));
    }
    if (domain.source.kind === "inferred" && domain.source.confidence === "low") {
      issues.push(issue("info", `${basePath}.source`, "Domain is inferred with low confidence.", "Review the domain name and paths, then mark the source as declared if the team accepts it."));
    }
  }
}

async function validateManifestContext(
  manifest: LoadedVerificationManifest,
  manifestRoot: string,
  issues: VerificationManifestValidationIssue[],
): Promise<void> {
  if (!manifest.context) {
    return;
  }

  const contextPath = `${manifest.path} > context`;
  if (manifest.context.source.kind === "inferred") {
    issues.push(issue(
      "info",
      `${contextPath}.source`,
      "Instruction and runbook context was inferred from repository documents.",
      "Treat this context as advisory until a human confirms which rules are product verification policy.",
    ));
  }

  if (manifest.context.instructionFiles.some((file) => file.confidence === "low")) {
    issues.push(issue(
      "info",
      `${contextPath}.instructionFiles`,
      "Some instruction-derived context has low confidence.",
      "Use it as a hint for manifest refinement, not as product truth, until the team reviews it.",
    ));
  }

  const seen = new Set<string>();
  for (const [index, file] of manifest.context.instructionFiles.entries()) {
    const filePath = `${contextPath}.instructionFiles[${index}]`;
    if (seen.has(file.path)) {
      issues.push(issue("warning", filePath, `Duplicate context source '${file.path}'.`, "Keep one context entry per source file."));
    }
    seen.add(file.path);
    if (!(await pathExists(path.join(manifestRoot, file.path)))) {
      issues.push(issue("warning", `${filePath}.path`, `Context source '${file.path}' was not found.`, "Remove stale context sources or regenerate the manifest baseline."));
    }
  }
}

async function validateFlowDefinitions(
  manifest: LoadedVerificationManifest,
  manifestRoot: string,
  issues: VerificationManifestValidationIssue[],
): Promise<void> {
  if (manifest.flows.length === 0) {
    issues.push(issue("warning", `${manifest.path} > flows`, "No flows are declared.", "Add at least one flow when the repo has user-facing or contract-critical behavior."));
  }
  const domainIds = new Set(manifest.domains.map((domain) => domain.id));
  const flowIds = new Set<string>();
  for (const flow of manifest.flows) {
    const basePath = `${manifest.path} > flows.${flow.id}`;
    if (flowIds.has(flow.id)) {
      issues.push(issue("error", basePath, `Duplicate flow id '${flow.id}'.`, "Give each flow a stable unique id."));
    }
    flowIds.add(flow.id);
    if (flow.domain && !domainIds.has(flow.domain)) {
      issues.push(issue("error", `${basePath}.domain`, `Flow references unknown domain '${flow.domain}'.`, "Use an existing domain id or add the missing domain."));
    }
    if (flow.anchors.length === 0) {
      issues.push(issue("error", `${basePath}.anchors`, "Flow has no anchors.", "Add route, component, file, API, or test anchors so PR changes can match this flow."));
    }
    if (flow.checks.length === 0) {
      issues.push(issue("warning", `${basePath}.checks`, "Flow has no verification checks.", "Add success, failure, edge, contract, or visual checks to shape generated drafts."));
    }
    const checkIds = new Set<string>();
    for (const [index, check] of flow.checks.entries()) {
      const checkPath = `${basePath}.checks[${index}]`;
      if (checkIds.has(check.id)) {
        issues.push(issue("error", `${checkPath}.id`, `Duplicate check id '${check.id}'.`, "Give each check in a flow a stable unique id so generated evidence can map back to one requirement."));
      }
      checkIds.add(check.id);
      if (!check.title.trim()) {
        issues.push(issue("error", `${checkPath}.title`, "Check title is empty.", "Write the behavior the draft must prove, such as `Submit media link successfully`."));
      }
    }
    const anchorKeys = new Set<string>();
    for (const [index, anchor] of flow.anchors.entries()) {
      const anchorPath = `${basePath}.anchors[${index}]`;
      const anchorKey = `${anchor.kind}:${anchor.path ?? ""}:${anchor.route ?? ""}:${anchor.symbol ?? ""}`;
      if (anchorKeys.has(anchorKey)) {
        issues.push(issue("warning", anchorPath, "Duplicate anchor detected.", "Keep only one anchor per route, path, or symbol so recommendations stay easy to explain."));
      }
      anchorKeys.add(anchorKey);
      if (!anchor.path && !anchor.route && !anchor.symbol) {
        issues.push(issue("error", anchorPath, "Anchor has no path, route, or symbol.", "Add a matchable path, route, or symbol."));
      }
      if (anchor.path && !anchor.path.includes("*") && !(await pathExists(path.join(manifestRoot, anchor.path)))) {
        issues.push(issue("warning", `${anchorPath}.path`, `Anchor path '${anchor.path}' was not found.`, "Confirm the path is relative to the manifest root or replace it with a glob pattern."));
      }
      if (anchor.route && !anchor.route.startsWith("/")) {
        issues.push(issue("warning", `${anchorPath}.route`, `Route '${anchor.route}' does not start with '/'.`, "Use absolute route hints such as `/checkout`."));
      }
    }
    if (flow.source.kind === "inferred" && flow.source.confidence === "low") {
      issues.push(issue("info", `${basePath}.source`, "Flow is inferred with low confidence.", "Review the flow name, anchors, and checks before relying on it as team policy."));
    }
  }
}

function validationResult(
  root: string,
  workspaceRoot: string | undefined,
  manifestPath: string | undefined,
  status: VerificationManifestValidationStatus,
  issues: VerificationManifestValidationIssue[],
): VerificationManifestValidationResult {
  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    workspaceRoot,
    manifestPath,
    generatedAt: new Date().toISOString(),
    status,
    summary: {
      errors: issues.filter((item) => item.severity === "error").length,
      warnings: issues.filter((item) => item.severity === "warning").length,
      info: issues.filter((item) => item.severity === "info").length,
    },
    issues,
  };
}

function issue(
  severity: VerificationManifestValidationSeverity,
  itemPath: string,
  message: string,
  recommendation: string,
): VerificationManifestValidationIssue {
  return {
    severity,
    path: itemPath,
    message,
    recommendation,
  };
}

function appendExplainMatches(
  lines: string[],
  matches: VerificationManifestMatch[],
  format: "text" | "markdown",
): void {
  if (matches.length === 0) {
    lines.push(format === "markdown" ? "No manifest matches were found for the changed files." : "No manifest matches were found for the changed files.");
    return;
  }

  if (format === "markdown") {
    lines.push("## Matches", "");
    for (const match of matches) {
      lines.push(`### ${escapeMarkdownInline(match.name)} \`${escapeMarkdownInline(match.id)}\``);
      lines.push("");
      lines.push(`- Kind: ${match.kind}`);
      lines.push(`- Confidence: ${match.confidence}`);
      if (match.criticality) {
        lines.push(`- Criticality: ${match.criticality}`);
      }
      if (match.entryRoute) {
        lines.push(`- Entry route: \`${escapeMarkdownInline(match.entryRoute)}\``);
      }
      lines.push(`- Why this was recommended: ${escapeMarkdownInline(match.reason)}`);
      if (match.evidenceSources.length > 0) {
        lines.push(`- Evidence sources: ${match.evidenceSources.map(escapeMarkdownInline).join(", ")}`);
      }
      lines.push(`- Manifest evidence: \`${escapeMarkdownInline(match.manifestPath)}\``);
      lines.push(`- If this is wrong: update \`${escapeMarkdownInline(match.updatePath)}\``);
      appendGuidanceList(lines, "Next actions", match.nextActions, "markdown");
      appendGuidanceList(lines, "Repair hints", match.repairHints, "markdown");
      if (match.checks && match.checks.length > 0) {
        lines.push("- Checks:");
        for (const check of match.checks) {
          lines.push(`  - ${escapeMarkdownInline(check)}`);
        }
      }
      if (match.matchedFiles.length > 0) {
        lines.push("- Matched files:");
        for (const file of match.matchedFiles) {
          lines.push(`  - \`${escapeMarkdownInline(file)}\``);
        }
      }
      lines.push("");
    }
    return;
  }

  lines.push("");
  lines.push("Matches:");
  for (const match of matches) {
    lines.push(`- ${match.name} (${match.kind}, ${match.confidence})`);
    lines.push(`  Why: ${match.reason}`);
    if (match.evidenceSources.length > 0) {
      lines.push(`  Evidence sources: ${match.evidenceSources.join(", ")}`);
    }
    lines.push(`  Evidence: ${match.manifestPath}`);
    lines.push(`  If wrong: update ${match.updatePath}`);
    appendGuidanceList(lines, "Next actions", match.nextActions, "text");
    appendGuidanceList(lines, "Repair hints", match.repairHints, "text");
    if (match.checks && match.checks.length > 0) {
      lines.push(`  Checks: ${match.checks.join("; ")}`);
    }
  }
}

function domainNextActions(domain: VerificationManifestDomain): string[] {
  return [
    `Confirm this PR really affects the ${domain.name} domain before spending time on unrelated broad smoke tests.`,
    domain.criticality === "high"
      ? "Require explicit validation evidence because this domain is marked high criticality."
      : `Use the matched domain as the boundary for focused verification instead of testing the whole repository.`,
  ];
}

function domainRepairHints(manifestPath: string, domain: VerificationManifestDomain): string[] {
  return [
    `If unrelated files keep matching, narrow ${manifestPath} > domains.${domain.id}.paths.`,
    `If this is a real product area, mark ${manifestPath} > domains.${domain.id}.source as declared after team review.`,
  ];
}

function flowNextActions(flow: VerificationManifestFlow): string[] {
  const actions = [
    `Draft or review E2E coverage for the ${flow.name} flow, not just the changed file.`,
  ];
  if (flow.entry?.route) {
    actions.push(`Start the draft from the manifest entry route ${flow.entry.route}.`);
  }
  if (flow.runner) {
    actions.push(`Prefer the manifest runner ${flow.runner} unless the local project setup says otherwise.`);
  }
  if (flow.checks.length > 0) {
    actions.push(`Cover the declared checks: ${flow.checks.slice(0, 3).map((check) => check.title).join("; ")}.`);
  }
  return actions;
}

function flowRepairHints(manifestPath: string, flow: VerificationManifestFlow): string[] {
  const hints = [
    `If these files do not belong to this flow, update ${manifestPath} > flows.${flow.id}.anchors.`,
    `If the generated test starts from the wrong screen, update ${manifestPath} > flows.${flow.id}.entry.route.`,
  ];
  if (flow.checks.length === 0) {
    hints.push(`Add concrete success, failure, or edge checks under ${manifestPath} > flows.${flow.id}.checks.`);
  } else {
    hints.push(`If the recommended assertions feel vague, rewrite ${manifestPath} > flows.${flow.id}.checks in team language.`);
  }
  return hints;
}

function checkNextActions(
  flow: VerificationManifestFlow,
  check: VerificationManifestCheck,
): string[] {
  return [
    `Add or review one assertion for this ${check.type} case: ${check.title}.`,
    `Keep the assertion tied to the ${flow.name} flow so the draft proves product behavior rather than implementation detail.`,
  ];
}

function checkRepairHints(
  manifestPath: string,
  flow: VerificationManifestFlow,
  check: VerificationManifestCheck,
): string[] {
  return [
    `If this is no longer required, remove or rename ${manifestPath} > flows.${flow.id}.checks.${check.id}.`,
    `If the behavior is still required but hard to automate, add fixture, selector, or setup notes near ${manifestPath} > flows.${flow.id}.checks.`,
  ];
}

function appendGuidanceList(
  lines: string[],
  title: string,
  values: string[],
  format: "text" | "markdown",
): void {
  if (values.length === 0) {
    return;
  }
  if (format === "markdown") {
    lines.push(`- ${title}:`);
    for (const value of values.slice(0, 4)) {
      lines.push(`  - ${escapeMarkdownInline(value)}`);
    }
    return;
  }
  lines.push(`  ${title}:`);
  for (const value of values.slice(0, 4)) {
    lines.push(`  - ${value}`);
  }
}

function appendContextRoleSummary(
  lines: string[],
  roleSummary: VerificationManifestContextRoleSummary[],
  format: "text" | "markdown",
): void {
  if (format === "markdown") {
    lines.push("## Role Summary", "");
    if (roleSummary.length === 0) {
      lines.push("No context roles were classified.", "");
      return;
    }
    for (const item of roleSummary) {
      lines.push(
        `- \`${escapeMarkdownInline(item.role)}\`: ${item.sources
          .map((source) => `\`${escapeMarkdownInline(source)}\``)
          .join(", ")}`,
      );
    }
    lines.push("");
    return;
  }

  lines.push("Role Summary");
  if (roleSummary.length === 0) {
    lines.push("- No context roles were classified.");
    lines.push("");
    return;
  }
  for (const item of roleSummary) {
    lines.push(`- ${item.role}: ${item.sources.join(", ")}`);
  }
  lines.push("");
}

function appendContextSources(
  lines: string[],
  instructionFiles: VerificationManifestInstructionFile[],
  format: "text" | "markdown",
): void {
  if (format === "markdown") {
    lines.push("## Context Sources", "");
    if (instructionFiles.length === 0) {
      lines.push("No instruction, runbook, ADR, goal, or context files were captured.", "");
      return;
    }
    for (const file of instructionFiles) {
      lines.push(`### \`${escapeMarkdownInline(file.path)}\``);
      lines.push(`- Kind: \`${escapeMarkdownInline(file.kind)}\``);
      lines.push(`- Confidence: \`${escapeMarkdownInline(file.confidence)}\``);
      lines.push(
        `- Roles: ${
          file.roles.length > 0
            ? file.roles.map((role) => `\`${escapeMarkdownInline(role)}\``).join(", ")
            : "none"
        }`,
      );
      lines.push(
        `- Signals: ${
          file.signals.length > 0
            ? file.signals.map((signal) => `\`${escapeMarkdownInline(signal)}\``).join(", ")
            : "none"
        }`,
      );
      lines.push("");
    }
    return;
  }

  lines.push("Context Sources");
  if (instructionFiles.length === 0) {
    lines.push("- No instruction, runbook, ADR, goal, or context files were captured.");
    lines.push("");
    return;
  }
  for (const file of instructionFiles) {
    lines.push(`- ${file.path}`);
    lines.push(`  Kind: ${file.kind}`);
    lines.push(`  Confidence: ${file.confidence}`);
    lines.push(`  Roles: ${file.roles.length > 0 ? file.roles.join(", ") : "none"}`);
    lines.push(`  Signals: ${file.signals.length > 0 ? file.signals.join(", ") : "none"}`);
  }
  lines.push("");
}

function appendContextValues(
  lines: string[],
  title: string,
  values: string[],
  format: "text" | "markdown",
): void {
  if (format === "markdown") {
    lines.push(`## ${title}`, "");
    if (values.length === 0) {
      lines.push("None detected.", "");
      return;
    }
    for (const value of values) {
      lines.push(`- \`${escapeMarkdownInline(value)}\``);
    }
    lines.push("");
    return;
  }

  lines.push(title);
  if (values.length === 0) {
    lines.push("- None detected.");
    lines.push("");
    return;
  }
  for (const value of values) {
    lines.push(`- ${value}`);
  }
  lines.push("");
}

function appendContextDiagnostics(
  lines: string[],
  diagnostics: VerificationManifestValidationIssue[],
  format: "text" | "markdown",
): void {
  if (format === "markdown") {
    lines.push("## Diagnostics", "");
    if (diagnostics.length === 0) {
      lines.push("No context diagnostics.", "");
      return;
    }
    for (const item of diagnostics) {
      lines.push(`- [${item.severity}] \`${escapeMarkdownInline(item.path)}\`: ${escapeMarkdownInline(item.message)}`);
      lines.push(`  - Fix: ${escapeMarkdownInline(item.recommendation)}`);
    }
    lines.push("");
    return;
  }

  lines.push("Diagnostics");
  if (diagnostics.length === 0) {
    lines.push("- No context diagnostics.");
    lines.push("");
    return;
  }
  for (const item of diagnostics) {
    lines.push(`- [${item.severity}] ${item.path}: ${item.message}`);
    lines.push(`  Fix: ${item.recommendation}`);
  }
  lines.push("");
}

async function buildContextDiagnostics(
  manifest: LoadedVerificationManifest,
  context: VerificationManifestContext | undefined,
  scannedContext: VerificationManifestContext | undefined,
  manifestRoot: string,
): Promise<VerificationManifestValidationIssue[]> {
  const issues: VerificationManifestValidationIssue[] = [];
  const manifestPath = manifest.path ?? defaultVerificationManifestPath;

  if (!context || context.instructionFiles.length === 0) {
    issues.push(
      issue(
        "warning",
        `${manifestPath} > context`,
        "No repo-local context sources were found.",
        "Add CONTEXT.md, ADRs, QA runbooks, or local agent instruction docs, then run `qamap manifest init .` from the default branch.",
      ),
    );
    return issues;
  }

  if (!manifest.path) {
    issues.push(
      issue(
        "info",
        defaultVerificationManifestPath,
        "No verification manifest was found; this context report is a read-only preview.",
        "Run `qamap manifest init .` from the default branch when this baseline should become team verification policy.",
      ),
    );
  }

  if (manifest.path && !manifest.context && scannedContext) {
    issues.push(
      issue(
        "warning",
        `${manifest.path} > context`,
        "The manifest has no context section, but repo-local context files were detected.",
        "Regenerate the manifest or manually add reviewed `context.instructionFiles` entries.",
      ),
    );
  }

  if (contextHasRole(context, "verification-rubric") && manifestCheckCount(manifest) === 0) {
    issues.push(
      issue(
        "warning",
        `${manifestPath} > flows`,
        "Verification rubric context exists, but no manifest checks are declared.",
        "Add flow checks or regenerate the baseline so rubric knowledge can shape E2E drafts.",
      ),
    );
  }

  if (contextHasRole(context, "test-runner") && context.validationCommands.length === 0) {
    issues.push(
      issue(
        "warning",
        `${manifestPath} > context.validationCommands`,
        "Test runner context exists, but no validation commands were inferred.",
        "Add explicit commands such as `pnpm test` to the context docs or manifest config.",
      ),
    );
  }

  if (contextHasRole(context, "safety-policy") && context.safetyRules.length === 0) {
    issues.push(
      issue(
        "warning",
        `${manifestPath} > context.safetyRules`,
        "Safety policy context exists, but no safety rules were extracted.",
        "Make no-write, no-publish, no-token, or approval rules explicit in short imperative sentences.",
      ),
    );
  }

  for (const file of context.instructionFiles) {
    const sourcePath = path.resolve(manifestRoot, file.path);
    if (!(await pathExists(sourcePath))) {
      issues.push(
        issue(
          "warning",
          `${manifestPath} > context.instructionFiles.${file.path}`,
          "Context source no longer exists on disk.",
          "Remove this source from the manifest or update the path after moving the document.",
        ),
      );
      continue;
    }
    if (file.roles.length === 0) {
      issues.push(
        issue(
          "info",
          `${manifestPath} > context.instructionFiles.${file.path}.roles`,
          "Context source has no classified role.",
          "Add clearer headings or keep this source as advisory-only context.",
        ),
      );
    }
    if (file.roles.length > 5) {
      issues.push(
        issue(
          "info",
          `${manifestPath} > context.instructionFiles.${file.path}.roles`,
          "Context source matches many roles and may be broad or noisy.",
          "Split broad docs or move important QA rules into focused runbooks.",
        ),
      );
    }
  }

  return issues;
}

function summarizeContextRoles(
  context: VerificationManifestContext | undefined,
): VerificationManifestContextRoleSummary[] {
  if (!context) {
    return [];
  }
  const sourcesByRole = new Map<VerificationManifestInstructionRole, string[]>();
  for (const file of context.instructionFiles) {
    for (const role of file.roles) {
      sourcesByRole.set(role, [...(sourcesByRole.get(role) ?? []), file.path]);
    }
  }
  return [...sourcesByRole.entries()]
    .map(([role, sources]) => ({
      role,
      sources: uniqueStrings(sources).sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.role.localeCompare(right.role));
}

function contextHasRole(
  context: VerificationManifestContext | undefined,
  role: VerificationManifestInstructionRole,
): boolean {
  return context?.instructionFiles.some((file) => file.roles.includes(role)) ?? false;
}

function manifestCheckCount(manifest: VerificationManifest): number {
  return manifest.flows.reduce((total, flow) => total + flow.checks.length, 0);
}

function buildManifestContext(
  root: string,
  manifestRoot: string,
  files: ProjectFile[],
): VerificationManifestContext | undefined {
  const instructionFiles: VerificationManifestInstructionFile[] = [];
  const validationCommands: string[] = [];
  const safetyRules: string[] = [];

  for (const file of files) {
    if (!file.text) {
      continue;
    }
    const kind = instructionKindForFile(file.path);
    if (!kind) {
      continue;
    }

    const manifestPath = toPosixPath(path.relative(manifestRoot, path.join(root, file.path)));
    if (manifestPath.startsWith("../")) {
      continue;
    }

    const commands = extractValidationCommands(file.text);
    const rules = extractSafetyRules(file.text);
    const roles = classifyInstructionRoles(file.path, file.text, kind, commands, rules);
    const signals = [
      ...commands.map(() => "validation-command"),
      ...rules.map(() => "safety-rule"),
      ...roles.map((role) => `role:${role}`),
      kind === "adr" ? "architecture-decision" : "",
      kind === "goal" ? "goal-document" : "",
      kind === "context" ? "domain-language" : "",
    ].filter(Boolean);

    instructionFiles.push({
      path: manifestPath,
      kind,
      confidence: instructionConfidence(kind, signals),
      roles,
      signals: uniqueStrings(signals).slice(0, 6),
    });
    validationCommands.push(...commands);
    safetyRules.push(...rules);
  }

  if (instructionFiles.length === 0 && validationCommands.length === 0 && safetyRules.length === 0) {
    return undefined;
  }

  return {
    instructionFiles: instructionFiles
      .sort((left, right) => contextKindRank(left.kind) - contextKindRank(right.kind) || left.path.localeCompare(right.path))
      .slice(0, 24),
    validationCommands: uniqueStrings(validationCommands).slice(0, 12),
    safetyRules: uniqueStrings(safetyRules).slice(0, 12),
    source: {
      kind: "inferred",
      confidence: instructionFiles.some((file) => file.confidence === "medium") ? "medium" : "low",
      from: uniqueStrings([
        ...instructionFiles.map((file) => contextSourceLabel(file.kind)),
        ...instructionFiles.flatMap((file) => file.roles.map(contextRoleLabel)),
      ]).slice(0, 10),
    },
  };
}

function buildBaselineDomains(
  files: ProjectFile[],
  context?: VerificationManifestContext,
): VerificationManifestDomain[] {
  const grouped = new Map<string, { name: string; files: string[]; from: string[] }>();

  for (const file of files) {
    const candidate = domainCandidateFromPath(file.path);
    if (!candidate) {
      continue;
    }
    const existing = grouped.get(candidate.id);
    const contextEvidence = contextEvidenceForTerms(context, [candidate.id, candidate.name]);
    if (existing) {
      existing.files.push(file.path);
      existing.from.push(candidate.from);
      existing.from.push(...contextEvidence);
      continue;
    }
    grouped.set(candidate.id, {
      name: candidate.name,
      files: [file.path],
      from: [candidate.from, ...contextEvidence],
    });
  }

  return [...grouped.entries()]
    .sort((left, right) => right[1].files.length - left[1].files.length)
    .map(([id, value]) => ({
      id,
      name: value.name,
      paths: domainPatterns(value.files).slice(0, 5),
      criticality: "medium",
      source: {
        kind: "inferred",
        confidence: value.files.length > 1 || value.from.some((item) => item.endsWith("-context")) ? "medium" : "low",
        from: uniqueStrings(value.from).slice(0, 4),
      },
    }));
}

function buildBaselineFlows(
  files: ProjectFile[],
  domains: VerificationManifestDomain[],
  runner: VerificationManifestRunner,
  context?: VerificationManifestContext,
): VerificationManifestFlow[] {
  const flows: VerificationManifestFlow[] = [];
  for (const file of files) {
    const route = routeFromFile(file.path);
    const component = componentNameFromFile(file.path);
    if (!route && !component) {
      continue;
    }
    const domain = bestDomainForFile(domains, file.path);
    const inferredSubject = route ? titleCase(route.replace(/^\/+/, "").replace(/[:/]+/g, " ")) : component ?? "Changed UI";
    const subject = contextFlowSubjectForTerms(
      context,
      [inferredSubject, domain?.id, domain?.name].filter(Boolean) as string[],
      inferredSubject,
    );
    const id = slugify([domain?.id, subject].filter(Boolean).join(" "));
    const contextEvidence = contextEvidenceForTerms(context, [subject, domain?.name, domain?.id].filter(Boolean) as string[]);
    const anchors: VerificationManifestAnchor[] = [
      {
        kind: route ? "route" : "component",
        path: file.path,
        route,
        symbol: route ? undefined : component,
        source: "inferred",
        confidence: route ? "high" : "medium",
      },
    ];

    flows.push({
      id,
      domain: domain?.id,
      name: subject,
      entry: route ? { route, source: "inferred" } : undefined,
      runner,
      anchors,
      checks: checksForFlow(subject, file.text),
      source: {
        kind: "inferred",
        confidence: route || contextEvidence.length > 0 ? "medium" : "low",
        from: uniqueStrings([route ? "route-file" : "component-file", ...contextEvidence]),
      },
    });
  }
  return dedupeFlows(flows);
}

function checksForFlow(subject: string, text?: string): VerificationManifestCheck[] {
  const checks: VerificationManifestCheck[] = [
    {
      id: "happy-path",
      title: `${subject} happy path works`,
      type: "success",
    },
  ];
  if (text && /\b(?:fetch|axios|graphql|mutation|query|api|request)\b/i.test(text)) {
    checks.push(
      {
        id: "api-success-fixture",
        title: `${subject} uses deterministic success fixture data`,
        type: "contract",
      },
      {
        id: "api-failure-fixture",
        title: `${subject} handles failed, empty, or unauthorized responses`,
        type: "failure",
      },
    );
  } else {
    checks.push({
      id: "visible-result",
      title: `${subject} shows the expected visible result`,
      type: "success",
    });
  }
  return checks;
}

function instructionKindForFile(file: string): VerificationManifestInstructionKind | undefined {
  const normalized = toPosixPath(file);
  const lower = normalized.toLowerCase();
  const basename = path.basename(normalized);

  if (basename === "CONTEXT.md" || basename === "CONTEXT-MAP.md") {
    return "context";
  }
  if (/^(?:docs\/)?adrs?\//i.test(normalized) || /\/adrs?\//i.test(normalized)) {
    return "adr";
  }
  if (/^(?:\.?goals|goals)\//i.test(normalized) || /\/goals\//i.test(normalized)) {
    return "goal";
  }
  if (
    basename === "AGENTS.md" ||
    basename === "CLAUDE.md" ||
    basename === "GEMINI.md" ||
    /^(?:\.codex|\.claude|\.agent-core|\.github\/instructions)\//i.test(normalized)
  ) {
    return "agent-instruction";
  }
  if (/docs\/.*(?:qa|quality).*\.md$/i.test(lower)) {
    return "qa-runbook";
  }
  if (/docs\/.*(?:test|e2e|playwright|maestro).*\.md$/i.test(lower)) {
    return "test-runbook";
  }
  if (/docs\/.*(?:release|deploy|publish).*\.md$/i.test(lower)) {
    return "release-runbook";
  }
  if (/docs\/.*runbook.*\.md$/i.test(lower)) {
    return "runbook";
  }
  return undefined;
}

function instructionConfidence(
  kind: VerificationManifestInstructionKind,
  signals: string[],
): VerificationManifestConfidence {
  if (kind === "agent-instruction") {
    return signals.length > 0 ? "medium" : "low";
  }
  return "medium";
}

function classifyInstructionRoles(
  file: string,
  text: string,
  kind: VerificationManifestInstructionKind,
  commands: string[],
  rules: string[],
): VerificationManifestInstructionRole[] {
  const normalized = toPosixPath(file).toLowerCase();
  const roles: VerificationManifestInstructionRole[] = [];

  if (
    kind === "context" ||
    kind === "adr" ||
    kind === "goal" ||
    /(?:product|domain|business|customer|user flow|journey|scenario|feature|screen|route|제품|도메인|사용자|고객|플로우|시나리오)/i.test(text)
  ) {
    roles.push("domain-context");
  }
  if (
    kind === "qa-runbook" ||
    kind === "test-runbook" ||
    commands.length > 0 ||
    /(?:verify|verification|qa|test|e2e|playwright|maestro|assert|coverage|evidence|fixture|selector|acceptance criteria|rubric|검증|테스트|근거|기준|커버리지)/i.test(text)
  ) {
    roles.push("verification-rubric");
  }
  if (
    commands.length > 0 ||
    kind === "test-runbook" ||
    /(?:playwright|maestro|jest|vitest|node --test|pytest|go test|cargo test|runner|test command|검증 명령|테스트 명령)/i.test(text)
  ) {
    roles.push("test-runner");
  }
  if (
    rules.length > 0 ||
    /(?:do not (?:commit|push|merge|publish|print|expose|write)|never (?:create|commit|push|merge|publish|print|expose|write)|must not|read-only|secret|credential|guardrail|forbid|절대|금지|하지 말|하면 안|토큰|비밀|권한)/i.test(text)
  ) {
    roles.push("safety-policy");
  }
  if (
    kind === "release-runbook" ||
    /(?:release|deploy|publish|changelog)/i.test(normalized) ||
    /(?:\b(?:publish|deploy|tag)\b|npm publish|version bump|릴리즈|배포|버전)/i.test(text)
  ) {
    roles.push("release-policy");
  }
  if (
    kind === "goal" ||
    /(?:lifecycle|workflow|process|goal|adr|review|iterate|iteration|loop|handoff|plan|implement|decision|작업 흐름|라이프사이클|목표|리뷰|반복|절차|계획|결정)/i.test(text)
  ) {
    roles.push("workflow-lifecycle");
  }
  if (
    /(?:^|\/)skills?\//.test(normalized) ||
    (/(?:^|\n)name:\s*[\w-]+/i.test(text) && /(?:^|\n)description:\s+/i.test(text)) ||
    /\bskill\b/i.test(text)
  ) {
    roles.push("agent-skill");
  }
  if (
    /(?:^|\/)(?:\.agent-core|\.github\/instructions|\.codex|\.claude)(?:\/|$)/.test(normalized) ||
    (kind === "agent-instruction" && /(?:harness|mcp|hook|settings|agent config|agent instruction|에이전트|하네스)/i.test(text))
  ) {
    roles.push("harness-config");
  }

  return uniqueStrings(roles) as VerificationManifestInstructionRole[];
}

function extractValidationCommands(text: string): string[] {
  const commands: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const candidates = [...line.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
    const stripped = cleanMarkdownLine(line);
    if (/^(?:pnpm|npm|yarn|bun|npx|node|pytest|go|cargo|maestro|playwright|gradle|mvn|\.\/gradlew)\b/i.test(stripped)) {
      candidates.push(stripped);
    }
    for (const candidate of candidates) {
      const command = normalizeCommand(candidate);
      if (command && isValidationCommand(command)) {
        commands.push(command);
      }
    }
  }
  return uniqueStrings(commands).slice(0, 12);
}

function extractSafetyRules(text: string): string[] {
  const rules: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = redactSensitiveText(cleanMarkdownLine(line));
    if (cleaned.length < 8 || cleaned.length > 220) {
      continue;
    }
    if (/\bdo not (?:belong|require|show)\b/i.test(cleaned)) {
      continue;
    }
    if (
      /(?:do not|don't|never|must not|read-only|\/tmp|token|secret|credential|절대|금지|하지 말|하면 안|커밋|푸시|PR 생성)/i.test(
        cleaned,
      )
    ) {
      rules.push(cleaned);
    }
  }
  return uniqueStrings(rules).slice(0, 12);
}

function normalizeCommand(value: string): string | undefined {
  const command = redactSensitiveText(value.trim().replace(/^\$\s*/, "").replace(/^>\s*/, ""));
  if (!command || command.length > 140 || /(?:publish|login|token|secret|password|rm\s+-rf)/i.test(command)) {
    return undefined;
  }
  return command.replace(/\s+/g, " ");
}

function isValidationCommand(command: string): boolean {
  return (
    /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|test:[\w:-]+|e2e|lint|typecheck|check|build|verify|coverage)\b/i.test(command) ||
    /^(?:npx\s+)?playwright\s+test\b/i.test(command) ||
    /^maestro\s+test\b/i.test(command) ||
    /^node\s+--test\b/i.test(command) ||
    /^pytest\b/i.test(command) ||
    /^go\s+test\b/i.test(command) ||
    /^cargo\s+test\b/i.test(command) ||
    /^(?:gradle|\.\/gradlew)\s+(?:test|check)\b/i.test(command) ||
    /^mvn\s+test\b/i.test(command)
  );
}

function cleanMarkdownLine(value: string): string {
  return value
    .replace(/^\s{0,3}(?:[-*]|\d+\.)\s+/, "")
    .replace(/^\s{0,3}#+\s*/, "")
    .trim();
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bnpm_[A-Za-z0-9]{12,}\b/g, "[redacted-token]")
    .replace(/\b(TOKEN|SECRET|PASSWORD|API_KEY|AUTH_TOKEN)=\S+/gi, "$1=[redacted]")
    .replace(/_authToken=\S+/gi, "_authToken=[redacted]");
}

function contextEvidenceForTerms(context: VerificationManifestContext | undefined, terms: string[]): string[] {
  if (!context) {
    return [];
  }
  const normalizedTerms = uniqueStrings(
    terms
      .flatMap((term) => [term, slugify(term), term.replace(/\s+/g, "-")])
      .map((term) => term.toLowerCase())
      .filter((term) => term.length >= 3),
  );
  if (normalizedTerms.length === 0) {
    return [];
  }
  const evidence = context.instructionFiles
    .filter((file) => {
      const filePath = file.path.toLowerCase();
      return normalizedTerms.some((term) => filePath.includes(term));
    })
    .map((file) => contextSourceLabel(file.kind));
  return uniqueStrings(evidence);
}

function contextFlowSubjectForTerms(
  context: VerificationManifestContext | undefined,
  terms: string[],
  fallback: string,
): string {
  if (!context) {
    return fallback;
  }
  const normalizedTerms = uniqueStrings(
    terms
      .flatMap((term) => [term, slugify(term), term.replace(/\s+/g, "-")])
      .map((term) => term.toLowerCase())
      .filter((term) => term.length >= 3),
  );
  if (normalizedTerms.length === 0) {
    return fallback;
  }

  const candidates = context.instructionFiles
    .filter((file) => file.roles.includes("domain-context") || file.roles.includes("verification-rubric"))
    .map((file) => contextFlowSubjectCandidate(file.path, normalizedTerms))
    .filter(Boolean) as string[];
  const best = candidates
    .filter((candidate) => slugify(candidate) !== slugify(fallback))
    .sort((left, right) => right.length - left.length)[0];
  return best ?? fallback;
}

function contextFlowSubjectCandidate(filePath: string, normalizedTerms: string[]): string | undefined {
  const basename = path.basename(toPosixPath(filePath)).replace(/\.[^.]+$/, "");
  const slug = slugify(basename);
  if (!slug || !normalizedTerms.some((term) => slug.includes(term))) {
    return undefined;
  }
  const cleanSlug = slug
    .split("-")
    .filter((part) => !["adr", "context", "decision", "doc", "docs", "goal", "note", "notes", "runbook", "spec"].includes(part))
    .join("-");
  if (!cleanSlug || cleanSlug.split("-").length < 2) {
    return undefined;
  }
  return titleCase(cleanSlug);
}

function contextSourceLabel(kind: VerificationManifestInstructionKind): string {
  if (kind === "agent-instruction") {
    return "agent-instruction-context";
  }
  if (kind === "context") {
    return "context-document-context";
  }
  return `${kind}-context`;
}

function contextRoleLabel(role: VerificationManifestInstructionRole): string {
  return `${role}-context`;
}

function contextKindRank(kind: VerificationManifestInstructionKind): number {
  const ranks: Record<VerificationManifestInstructionKind, number> = {
    context: 0,
    adr: 1,
    goal: 2,
    "qa-runbook": 3,
    "test-runbook": 4,
    "release-runbook": 5,
    runbook: 6,
    "agent-instruction": 7,
  };
  return ranks[kind];
}

function inferRunner(files: ProjectFile[]): VerificationManifestRunner {
  const packageText = files.find((file) => file.path === "package.json")?.text ?? "";
  if (/\b(?:expo|react-native)\b/i.test(packageText) || files.some((file) => /(?:^|\/)app\.json$/.test(file.path))) {
    return "maestro";
  }
  if (/\b(?:next|react|vite|vue|nuxt|svelte|remix|astro|angular|playwright)\b/i.test(packageText)) {
    return "playwright";
  }
  return "manual";
}

function routeFromFile(file: string): string | undefined {
  const normalized = toPosixPath(file);
  const pagesMatch = normalized.match(/(?:^|\/)(?:src\/)?pages\/(.+)\.(?:[cm]?[jt]sx?|vue|svelte)$/);
  if (pagesMatch && !pagesMatch[1].startsWith("_")) {
    return normalizeRouteSegments(pagesMatch[1].replace(/\/index$/, ""));
  }
  const appMatch = normalized.match(/(?:^|\/)(?:src\/)?app\/(.+)\/(?:page|route)\.(?:[cm]?[jt]sx?)$/);
  if (appMatch) {
    const withoutGroups = appMatch[1]
      .split("/")
      .filter((segment) => !/^\(.+\)$/.test(segment))
      .join("/");
    return normalizeRouteSegments(withoutGroups);
  }
  return undefined;
}

function normalizeRouteSegments(value: string): string {
  const route = value
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/^\[(\.\.\.)?(.+)\]$/, ":$2"))
    .join("/");
  return `/${route || ""}`;
}

function componentNameFromFile(file: string): string | undefined {
  const basename = path.basename(file).replace(/\.[^.]+$/, "");
  if (!/(?:page|screen|view|modal|form|flow|checkout|submit|complete)$/i.test(basename)) {
    return undefined;
  }
  return titleCase(basename);
}

function domainCandidateFromPath(file: string): { id: string; name: string; from: string } | undefined {
  const segments = file.split("/").filter(Boolean);
  const keyedIndex = segments.findIndex((segment) =>
    ["apps", "domains", "entities", "features", "modules", "packages", "services"].includes(segment),
  );
  if (keyedIndex >= 0 && segments[keyedIndex + 1]) {
    return domainCandidate(segments[keyedIndex + 1], segments[keyedIndex]);
  }
  const routeIndex = segments.findIndex((segment) => ["app", "pages", "screens"].includes(segment));
  if (routeIndex >= 0) {
    const segment = segments
      .slice(routeIndex + 1)
      .find((item) => item && !item.startsWith("_") && !item.startsWith("+") && !/^\(.+\)$/.test(item));
    if (segment) {
      return domainCandidate(segment, segments[routeIndex]);
    }
  }
  return undefined;
}

function domainCandidate(value: string, from: string): { id: string; name: string; from: string } | undefined {
  const clean = value.replace(/\.[^.]+$/, "").replace(/^\[(.+)\]$/, "$1");
  const id = slugify(clean);
  if (!id || ["api", "components", "hooks", "lib", "shared", "src", "utils"].includes(id)) {
    return undefined;
  }
  return { id, name: titleCase(clean), from };
}

function bestDomainForFile(domains: VerificationManifestDomain[], file: string): VerificationManifestDomain | undefined {
  return domains.find((domain) => domain.paths.some((pattern) => matchesPathPattern(file, pattern)));
}

function domainPatterns(files: string[]): string[] {
  return uniqueStrings(files.map(domainPatternForFile).filter(Boolean) as string[]);
}

function domainPatternForFile(file: string): string | undefined {
  const segments = file.split("/").filter(Boolean);
  const basename = segments.at(-1);
  const dir = segments.slice(0, -1).join("/");
  if (!basename || !dir) {
    return undefined;
  }
  const owningDir = segments.at(-2);
  if (owningDir && ["app", "pages", "screens"].includes(owningDir)) {
    return file;
  }
  return `${dir}/**`;
}

function matchFlowAnchors(flow: VerificationManifestFlow, files: string[]): string[] {
  const matched = new Set<string>();
  for (const file of files) {
    for (const anchor of flow.anchors) {
      if (anchor.path && matchesPathPattern(file, anchor.path)) {
        matched.add(file);
      }
      if (anchor.route) {
        const routeSignal = normalizePathForMatch(anchor.route).replace(/^\//, "");
        if (routeSignal && normalizePathForMatch(file).includes(routeSignal)) {
          matched.add(file);
        }
      }
    }
  }
  return [...matched];
}

function matchesPathPattern(file: string, pattern: string): boolean {
  const normalizedFile = normalizePathForMatch(file);
  const normalizedPattern = normalizePathForMatch(pattern);
  if (!normalizedPattern) {
    return false;
  }
  if (!normalizedPattern.includes("*")) {
    return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
  }
  const regex = new RegExp(
    `^${normalizedPattern
      .split("**")
      .map((part) => part.split("*").map(escapeRegex).join("[^/]*"))
      .join(".*")}$`,
  );
  return regex.test(normalizedFile);
}

function isBehaviorFile(file: string): boolean {
  return /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(file) && !/(?:^|\/)(?:tests?|__tests__|e2e|dist|build)\//i.test(file);
}

function normalizeVerificationManifest(value: unknown, manifestPath: string): VerificationManifest {
  const record = asRecord(value, `QAMap manifest must be an object: ${manifestPath}`);
  const version = record.version;
  if (version !== 1) {
    throw new Error(`QAMap manifest version must be 1: ${manifestPath}`);
  }
  const schema = readOptionalString(record, "$schema");
  const domains = Array.isArray(record.domains)
    ? record.domains.map((domain, index) => normalizeDomain(domain, manifestPath, index))
    : [];
  const flows = Array.isArray(record.flows)
    ? record.flows.map((flow, index) => normalizeFlow(flow, manifestPath, index))
    : [];
  const context = normalizeContext(record.context, manifestPath);
  return { $schema: schema, version: 1, ...(context ? { context } : {}), domains, flows };
}

function normalizeContext(value: unknown, manifestPath: string): VerificationManifestContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const instructionFiles = Array.isArray(record.instructionFiles)
    ? record.instructionFiles.map((item, index) => normalizeInstructionFile(item, manifestPath, index))
    : [];
  const validationCommands = readStringArray(record, "validationCommands");
  const safetyRules = readStringArray(record, "safetyRules");
  return {
    instructionFiles,
    validationCommands,
    safetyRules,
    source: readSource(record.source, "context", manifestPath, 0),
  };
}

function normalizeInstructionFile(
  value: unknown,
  manifestPath: string,
  index: number,
): VerificationManifestInstructionFile {
  const record = asRecord(value, `QAMap manifest context file at index ${index} must be an object: ${manifestPath}`);
  return {
    path: readRequiredString(record, "path", manifestPath, index),
    kind: readInstructionKind(readOptionalString(record, "kind") ?? "agent-instruction", manifestPath, index),
    confidence: readConfidence(readOptionalString(record, "confidence") ?? "low", manifestPath, index),
    roles: readStringArray(record, "roles").map((role) => readInstructionRole(role, manifestPath, index)),
    signals: readStringArray(record, "signals"),
  };
}

function normalizeDomain(value: unknown, manifestPath: string, index: number): VerificationManifestDomain {
  const record = asRecord(value, `QAMap manifest domain at index ${index} must be an object: ${manifestPath}`);
  const id = readRequiredString(record, "id", manifestPath, index);
  return {
    id,
    name: readOptionalString(record, "name") ?? id,
    paths: readStringArray(record, "paths"),
    criticality: readCriticality(readOptionalString(record, "criticality") ?? "medium", manifestPath, index),
    source: readSource(record.source, "domain", manifestPath, index),
  };
}

function normalizeFlow(value: unknown, manifestPath: string, index: number): VerificationManifestFlow {
  const record = asRecord(value, `QAMap manifest flow at index ${index} must be an object: ${manifestPath}`);
  const id = readRequiredString(record, "id", manifestPath, index);
  return {
    id,
    domain: readOptionalString(record, "domain"),
    name: readOptionalString(record, "name") ?? id,
    entry: normalizeEntry(record.entry),
    runner: readRunner(readOptionalString(record, "runner")),
    anchors: Array.isArray(record.anchors)
      ? record.anchors.map((anchor, anchorIndex) => normalizeAnchor(anchor, manifestPath, index, anchorIndex))
      : [],
    checks: Array.isArray(record.checks)
      ? record.checks.map((check, checkIndex) => normalizeCheck(check, manifestPath, index, checkIndex))
      : [],
    source: readSource(record.source, "flow", manifestPath, index),
  };
}

function normalizeEntry(value: unknown): VerificationManifestEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    route: readOptionalString(record, "route"),
    source: readSourceKind(readOptionalString(record, "source") ?? "declared"),
  };
}

function normalizeAnchor(
  value: unknown,
  manifestPath: string,
  flowIndex: number,
  anchorIndex: number,
): VerificationManifestAnchor {
  const record = asRecord(
    value,
    `QAMap manifest anchor at flow ${flowIndex}, index ${anchorIndex} must be an object: ${manifestPath}`,
  );
  return {
    kind: readAnchorKind(readOptionalString(record, "kind") ?? "file", manifestPath, anchorIndex),
    path: readOptionalString(record, "path"),
    route: readOptionalString(record, "route"),
    symbol: readOptionalString(record, "symbol"),
    source: readSourceKind(readOptionalString(record, "source") ?? "declared"),
    confidence: readConfidence(readOptionalString(record, "confidence") ?? "medium", manifestPath, anchorIndex),
  };
}

function normalizeCheck(
  value: unknown,
  manifestPath: string,
  flowIndex: number,
  checkIndex: number,
): VerificationManifestCheck {
  const record = asRecord(
    value,
    `QAMap manifest check at flow ${flowIndex}, index ${checkIndex} must be an object: ${manifestPath}`,
  );
  return {
    id: readRequiredString(record, "id", manifestPath, checkIndex),
    title: readOptionalString(record, "title") ?? readRequiredString(record, "id", manifestPath, checkIndex),
    type: readCheckType(readOptionalString(record, "type") ?? "success", manifestPath, checkIndex),
    selector: readOptionalString(record, "selector"),
    value: readOptionalString(record, "value"),
    steps: readStringArray(record, "steps"),
  };
}

function readSource(value: unknown, label: string, manifestPath: string, index: number): VerificationManifestSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: "declared",
      confidence: "medium",
      from: [label],
    };
  }
  const record = value as Record<string, unknown>;
  return {
    kind: readSourceKind(readOptionalString(record, "kind") ?? "declared"),
    confidence: readConfidence(readOptionalString(record, "confidence") ?? "medium", manifestPath, index),
    from: readStringArray(record, "from"),
  };
}

async function findVerificationManifestPath(root: string): Promise<string | undefined> {
  for (const candidate of manifestCandidates) {
    const absolutePath = path.join(root, candidate);
    if (await pathExists(absolutePath)) {
      return absolutePath;
    }
  }
  return undefined;
}

function displayManifestPath(root: string, manifestPath: string): string {
  const relative = path.relative(root, manifestPath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return toPosixPath(relative);
  }
  return toPosixPath(manifestPath);
}

function parseVerificationManifest(raw: string, manifestPath: string): unknown {
  try {
    if (/\.json$/i.test(manifestPath)) {
      return JSON.parse(raw);
    }
    return YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse QAMap manifest at ${manifestPath}: ${message}`);
  }
}

function summarizeManifest(manifest: VerificationManifest): VerificationManifestInitResult["summary"] {
  return {
    domains: manifest.domains.length,
    flows: manifest.flows.length,
    anchors: manifest.flows.reduce((total, flow) => total + flow.anchors.length, 0),
    checks: manifest.flows.reduce((total, flow) => total + flow.checks.length, 0),
    contextSources: manifest.context?.instructionFiles.length ?? 0,
    validationCommands: manifest.context?.validationCommands.length ?? 0,
    safetyRules: manifest.context?.safetyRules.length ?? 0,
  };
}

function dedupeFlows(flows: VerificationManifestFlow[]): VerificationManifestFlow[] {
  const seen = new Map<string, VerificationManifestFlow>();
  for (const flow of flows) {
    if (!seen.has(flow.id)) {
      seen.set(flow.id, flow);
    }
  }
  return [...seen.values()];
}

function dedupeManifestMatches(matches: VerificationManifestMatch[]): VerificationManifestMatch[] {
  const seen = new Map<string, VerificationManifestMatch>();
  for (const match of matches) {
    const key = `${match.kind}:${match.id}:${match.manifestPath}`;
    if (!seen.has(key)) {
      seen.set(key, match);
    }
  }
  return [...seen.values()];
}

function normalizePathForMatch(value: string): string {
  return toPosixPath(value).replace(/^\.\/+/, "").replace(/\/+$/g, "").toLowerCase();
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleCase(value: string): string {
  return value
    .replace(/\.[^.]+$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9:]+/)
    .filter(Boolean)
    .map((part) => {
      if (part.startsWith(":")) {
        return part;
      }
      return part[0].toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, key: string, manifestPath: string, index: number): string {
  const value = readOptionalString(record, key);
  if (!value) {
    throw new Error(`QAMap manifest entry at index ${index} is missing ${key}: ${manifestPath}`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readCriticality(value: string, manifestPath: string, index: number): VerificationManifestCriticality {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error(`QAMap manifest criticality at index ${index} must be low, medium, or high: ${manifestPath}`);
}

function readConfidence(value: string, manifestPath: string, index: number): VerificationManifestConfidence {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error(`QAMap manifest confidence at index ${index} must be low, medium, or high: ${manifestPath}`);
}

function readSourceKind(value: string): VerificationManifestSourceKind {
  return value === "inferred" ? "inferred" : "declared";
}

function readRunner(value?: string): VerificationManifestRunner | undefined {
  if (value === "manual" || value === "maestro" || value === "playwright") {
    return value;
  }
  return undefined;
}

function readAnchorKind(value: string, manifestPath: string, index: number): VerificationManifestAnchorKind {
  if (value === "api" || value === "component" || value === "file" || value === "route" || value === "test") {
    return value;
  }
  throw new Error(`QAMap manifest anchor kind at index ${index} is invalid: ${manifestPath}`);
}

function readCheckType(value: string, manifestPath: string, index: number): VerificationManifestCheckType {
  if (value === "contract" || value === "edge" || value === "failure" || value === "success" || value === "visual") {
    return value;
  }
  throw new Error(`QAMap manifest check type at index ${index} is invalid: ${manifestPath}`);
}

function readInstructionKind(value: string, manifestPath: string, index: number): VerificationManifestInstructionKind {
  if (
    value === "adr" ||
    value === "agent-instruction" ||
    value === "context" ||
    value === "goal" ||
    value === "qa-runbook" ||
    value === "release-runbook" ||
    value === "runbook" ||
    value === "test-runbook"
  ) {
    return value;
  }
  throw new Error(`QAMap manifest context kind at index ${index} is invalid: ${manifestPath}`);
}

function readInstructionRole(value: string, manifestPath: string, index: number): VerificationManifestInstructionRole {
  if (
    value === "agent-skill" ||
    value === "domain-context" ||
    value === "harness-config" ||
    value === "release-policy" ||
    value === "safety-policy" ||
    value === "test-runner" ||
    value === "verification-rubric" ||
    value === "workflow-lifecycle"
  ) {
    return value;
  }
  throw new Error(`QAMap manifest context role at index ${index} is invalid: ${manifestPath}`);
}
