import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { collectProjectFiles, pathExists, toPosixPath } from "./fs.js";
import { generateTestPlan } from "./test-plan.js";
import { TOOL_NAME, VERSION } from "./version.js";
import type { TestPlanChangedFile, TestPlanOptions } from "./test-plan.js";
import type { ProjectFile } from "./types.js";

export const defaultVerificationManifestPath = ".codeward/manifest.yaml";
export const verificationManifestSchemaUrl =
  "https://raw.githubusercontent.com/IvoryCanvas/codeward/main/schema/codeward-manifest.schema.json";

export type VerificationManifestCriticality = "low" | "medium" | "high";
export type VerificationManifestConfidence = "low" | "medium" | "high";
export type VerificationManifestRunner = "manual" | "maestro" | "playwright";
export type VerificationManifestSourceKind = "declared" | "inferred";
export type VerificationManifestAnchorKind = "api" | "component" | "file" | "route" | "test";
export type VerificationManifestCheckType = "contract" | "edge" | "failure" | "success" | "visual";
export type VerificationManifestMatchKind = "domain" | "flow" | "check";

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

export interface VerificationManifest {
  $schema?: string;
  version: 1;
  domains: VerificationManifestDomain[];
  flows: VerificationManifestFlow[];
}

export interface LoadedVerificationManifest extends VerificationManifest {
  path?: string;
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
  };
}

export interface VerificationManifestMatch {
  kind: VerificationManifestMatchKind;
  id: string;
  name: string;
  manifestPath: string;
  updatePath: string;
  reason: string;
  matchedFiles: string[];
  confidence: VerificationManifestConfidence;
  criticality?: VerificationManifestCriticality;
  runner?: VerificationManifestRunner;
  entryRoute?: string;
  checks?: string[];
  checkType?: VerificationManifestCheckType;
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

export interface VerificationManifestExplainOptions extends TestPlanOptions {}

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

const manifestCandidates = [
  ".codeward/manifest.yaml",
  ".codeward/manifest.yml",
  ".codeward/manifest.json",
];

const defaultMaxManifestFiles = 2500;

export async function loadVerificationManifest(rootInput: string): Promise<LoadedVerificationManifest> {
  const root = path.resolve(rootInput);
  const manifestPath = await findVerificationManifestPath(root);
  if (!manifestPath) {
    return { version: 1, domains: [], flows: [] };
  }

  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = parseVerificationManifest(raw, manifestPath);
  return {
    path: toPosixPath(path.relative(root, manifestPath)),
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
      reason: `Changed files match the declared ${domain.name} domain paths.`,
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
        matchedFiles: anchorMatches.slice(0, 12),
        confidence: flow.source.confidence,
        runner: flow.runner,
        entryRoute: flow.entry?.route,
        checks: [check.title],
        checkType: check.type,
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
    "Review and commit this file when the baseline should become team verification policy.",
  ].join("\n");
}

export async function validateVerificationManifest(rootInput: string, workspaceRootInput?: string): Promise<VerificationManifestValidationResult> {
  const root = path.resolve(rootInput);
  const manifestRoot = path.resolve(workspaceRootInput ?? rootInput);
  const issues: VerificationManifestValidationIssue[] = [];
  let manifest: LoadedVerificationManifest;

  try {
    manifest = await loadVerificationManifest(manifestRoot);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(issue("error", defaultVerificationManifestPath, message, "Fix the manifest syntax or schema, then run `codeward manifest validate` again."));
    return validationResult(root, workspaceRootInput ? manifestRoot : undefined, undefined, "invalid", issues);
  }

  if (!manifest.path) {
    issues.push(issue("error", defaultVerificationManifestPath, "No verification manifest was found.", "Run `codeward manifest init .` to create a baseline."));
    return validationResult(root, workspaceRootInput ? manifestRoot : undefined, undefined, "missing", issues);
  }

  validateDomainDefinitions(manifest, issues);
  validateManifestMetadata(manifest, issues);
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
  const manifest = await loadVerificationManifest(manifestRoot);
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

export function formatVerificationManifestValidationResult(
  result: VerificationManifestValidationResult,
  format: "text" | "json" | "markdown",
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  const lines: string[] = [];
  if (format === "markdown") {
    lines.push("# CodeWard Manifest Validate", "");
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

  lines.push("CodeWard Manifest Validate");
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
    lines.push("# CodeWard Manifest Explain", "");
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

  lines.push("CodeWard Manifest Explain");
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

export function formatVerificationManifestYaml(manifest: VerificationManifest): string {
  return `${YAML.stringify(manifest, { lineWidth: 100 }).trimEnd()}\n`;
}

function buildVerificationManifestBaseline(
  root: string,
  manifestRoot: string,
  files: ProjectFile[],
): VerificationManifest {
  const behaviorFiles = files
    .filter((file) => isBehaviorFile(file.path))
    .map((file) => ({
      ...file,
      path: toPosixPath(path.relative(manifestRoot, path.join(root, file.path))),
    }))
    .filter((file) => !file.path.startsWith("../"));
  const domains = buildBaselineDomains(behaviorFiles).slice(0, 12);
  const flows = buildBaselineFlows(behaviorFiles, domains, inferRunner(files)).slice(0, 16);

  return {
    $schema: verificationManifestSchemaUrl,
    version: 1,
    domains,
    flows,
  };
}

function validateManifestMetadata(
  manifest: LoadedVerificationManifest,
  issues: VerificationManifestValidationIssue[],
): void {
  if (!manifest.$schema) {
    issues.push(issue("info", `${manifest.path} > $schema`, "Manifest does not declare the CodeWard manifest JSON schema.", "Add the `$schema` field generated by `codeward manifest init .` for editor validation."));
    return;
  }
  if (!/schema\/codeward-manifest\.schema\.json$/i.test(manifest.$schema)) {
    issues.push(issue("warning", `${manifest.path} > $schema`, "Manifest points at an unknown schema URL.", "Use the official CodeWard manifest schema URL or remove the field if the team intentionally manages validation elsewhere."));
  }
}

function validateDomainDefinitions(manifest: LoadedVerificationManifest, issues: VerificationManifestValidationIssue[]): void {
  if (manifest.domains.length === 0) {
    issues.push(issue("warning", `${manifest.path} > domains`, "No domains are declared.", "Run `codeward manifest init .` or add product domains manually."));
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
        issues.push(issue("error", `${checkPath}.title`, "Check title is empty.", "Write the behavior the draft must prove, such as `Submit content URL successfully`."));
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
      lines.push(`- Manifest evidence: \`${escapeMarkdownInline(match.manifestPath)}\``);
      lines.push(`- If this is wrong: update \`${escapeMarkdownInline(match.updatePath)}\``);
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
    lines.push(`  Evidence: ${match.manifestPath}`);
    lines.push(`  If wrong: update ${match.updatePath}`);
    if (match.checks && match.checks.length > 0) {
      lines.push(`  Checks: ${match.checks.join("; ")}`);
    }
  }
}

function buildBaselineDomains(files: ProjectFile[]): VerificationManifestDomain[] {
  const grouped = new Map<string, { name: string; files: string[]; from: string[] }>();

  for (const file of files) {
    const candidate = domainCandidateFromPath(file.path);
    if (!candidate) {
      continue;
    }
    const existing = grouped.get(candidate.id);
    if (existing) {
      existing.files.push(file.path);
      existing.from.push(candidate.from);
      continue;
    }
    grouped.set(candidate.id, {
      name: candidate.name,
      files: [file.path],
      from: [candidate.from],
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
        confidence: value.files.length > 1 ? "medium" : "low",
        from: uniqueStrings(value.from).slice(0, 4),
      },
    }));
}

function buildBaselineFlows(
  files: ProjectFile[],
  domains: VerificationManifestDomain[],
  runner: VerificationManifestRunner,
): VerificationManifestFlow[] {
  const flows: VerificationManifestFlow[] = [];
  for (const file of files) {
    const route = routeFromFile(file.path);
    const component = componentNameFromFile(file.path);
    if (!route && !component) {
      continue;
    }
    const domain = bestDomainForFile(domains, file.path);
    const subject = route ? titleCase(route.replace(/^\/+/, "").replace(/[:/]+/g, " ")) : component ?? "Changed UI";
    const id = slugify([domain?.id, subject].filter(Boolean).join(" "));
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
        confidence: route ? "medium" : "low",
        from: [route ? "route-file" : "component-file"],
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
  const record = asRecord(value, `CodeWard manifest must be an object: ${manifestPath}`);
  const version = record.version;
  if (version !== 1) {
    throw new Error(`CodeWard manifest version must be 1: ${manifestPath}`);
  }
  const schema = readOptionalString(record, "$schema");
  const domains = Array.isArray(record.domains)
    ? record.domains.map((domain, index) => normalizeDomain(domain, manifestPath, index))
    : [];
  const flows = Array.isArray(record.flows)
    ? record.flows.map((flow, index) => normalizeFlow(flow, manifestPath, index))
    : [];
  return { $schema: schema, version: 1, domains, flows };
}

function normalizeDomain(value: unknown, manifestPath: string, index: number): VerificationManifestDomain {
  const record = asRecord(value, `CodeWard manifest domain at index ${index} must be an object: ${manifestPath}`);
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
  const record = asRecord(value, `CodeWard manifest flow at index ${index} must be an object: ${manifestPath}`);
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
    `CodeWard manifest anchor at flow ${flowIndex}, index ${anchorIndex} must be an object: ${manifestPath}`,
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
    `CodeWard manifest check at flow ${flowIndex}, index ${checkIndex} must be an object: ${manifestPath}`,
  );
  return {
    id: readRequiredString(record, "id", manifestPath, checkIndex),
    title: readOptionalString(record, "title") ?? readRequiredString(record, "id", manifestPath, checkIndex),
    type: readCheckType(readOptionalString(record, "type") ?? "success", manifestPath, checkIndex),
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

function parseVerificationManifest(raw: string, manifestPath: string): unknown {
  try {
    if (/\.json$/i.test(manifestPath)) {
      return JSON.parse(raw);
    }
    return YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse CodeWard manifest at ${manifestPath}: ${message}`);
  }
}

function summarizeManifest(manifest: VerificationManifest): VerificationManifestInitResult["summary"] {
  return {
    domains: manifest.domains.length,
    flows: manifest.flows.length,
    anchors: manifest.flows.reduce((total, flow) => total + flow.anchors.length, 0),
    checks: manifest.flows.reduce((total, flow) => total + flow.checks.length, 0),
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
    throw new Error(`CodeWard manifest entry at index ${index} is missing ${key}: ${manifestPath}`);
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
  throw new Error(`CodeWard manifest criticality at index ${index} must be low, medium, or high: ${manifestPath}`);
}

function readConfidence(value: string, manifestPath: string, index: number): VerificationManifestConfidence {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  throw new Error(`CodeWard manifest confidence at index ${index} must be low, medium, or high: ${manifestPath}`);
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
  throw new Error(`CodeWard manifest anchor kind at index ${index} is invalid: ${manifestPath}`);
}

function readCheckType(value: string, manifestPath: string, index: number): VerificationManifestCheckType {
  if (value === "contract" || value === "edge" || value === "failure" || value === "success" || value === "visual") {
    return value;
  }
  throw new Error(`CodeWard manifest check type at index ${index} is invalid: ${manifestPath}`);
}
