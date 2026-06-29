import path from "node:path";
import { collectProjectFiles } from "./fs.js";
import type { ProjectFile } from "./types.js";

export type CoverageEvidenceStatus = "covered" | "partial" | "missing";
export type CoverageEvidenceConfidence = "high" | "medium" | "low";

export interface CoverageTargetLike {
  title: string;
  checks: string[];
}

export interface FlowCoverageInput {
  title: string;
  files: string[];
  coverage: CoverageTargetLike[];
}

export interface TestSuiteEvidenceFile {
  path: string;
  testNames: string[];
  imports: string[];
  signals: string[];
}

export interface TestSuiteInventory {
  hasTestSuite: boolean;
  testFileCount: number;
  frameworkSignals: string[];
  files: TestSuiteEvidenceFile[];
}

export interface TestSuiteSummary {
  hasTestSuite: boolean;
  testFileCount: number;
  frameworkSignals: string[];
}

export interface CoverageEvidence {
  targetTitle: string;
  status: CoverageEvidenceStatus;
  confidence: CoverageEvidenceConfidence;
  files: string[];
  signals: string[];
  reason: string;
}

const maxInventoryFiles = 20000;
const maxEvidenceFiles = 6;

export async function collectTestSuiteInventory(root: string): Promise<TestSuiteInventory> {
  const projectFiles = await collectProjectFiles(root, maxInventoryFiles);
  const files = projectFiles.filter((file) => isTestLikeFile(file.path)).map(toTestEvidenceFile);
  return {
    hasTestSuite: files.length > 0,
    testFileCount: files.length,
    frameworkSignals: detectFrameworkSignals(projectFiles, files),
    files,
  };
}

export function summarizeTestSuiteInventory(inventory: TestSuiteInventory): TestSuiteSummary {
  return {
    hasTestSuite: inventory.hasTestSuite,
    testFileCount: inventory.testFileCount,
    frameworkSignals: inventory.frameworkSignals,
  };
}

export function evaluateFlowCoverageEvidence(
  flow: FlowCoverageInput,
  inventory: TestSuiteInventory,
): CoverageEvidence[] {
  return flow.coverage.map((target) => evaluateCoverageTarget(flow, target, inventory));
}

function evaluateCoverageTarget(
  flow: FlowCoverageInput,
  target: CoverageTargetLike,
  inventory: TestSuiteInventory,
): CoverageEvidence {
  if (!inventory.hasTestSuite) {
    return {
      targetTitle: target.title,
      status: "missing",
      confidence: "high",
      files: [],
      signals: [],
      reason: "No existing test files were detected, so CodeWard cannot find coverage evidence for this target.",
    };
  }

  const relatedFiles = findRelatedTestFiles(flow, inventory.files);
  if (relatedFiles.length === 0) {
    return {
      targetTitle: target.title,
      status: "missing",
      confidence: "medium",
      files: [],
      signals: [],
      reason: "No related test files were found for the changed flow.",
    };
  }

  const groups = signalGroupsForTarget(target.title);
  const matchedGroups = groups.filter((group) =>
    relatedFiles.some((file) => group.patterns.some((pattern) => pattern.test(searchableEvidenceText(file)))),
  );
  const evidenceFiles = relatedFiles
    .filter((file) => matchedGroups.some((group) => group.patterns.some((pattern) => pattern.test(searchableEvidenceText(file)))))
    .slice(0, maxEvidenceFiles)
    .map((file) => file.path);

  if (matchedGroups.length === 0) {
    return {
      targetTitle: target.title,
      status: target.title === "Primary success path" ? "partial" : "missing",
      confidence: "low",
      files: relatedFiles.slice(0, maxEvidenceFiles).map((file) => file.path),
      signals: [],
      reason:
        target.title === "Primary success path"
          ? "Related tests exist, but CodeWard did not find explicit success-path wording or assertions."
          : "Related tests exist, but CodeWard did not find target-specific coverage signals.",
    };
  }

  const rawStatus = coverageStatusForMatchedGroups(target.title, groups.length, matchedGroups.length);
  const status = rawStatus === "covered" && isBroadFlow(flow) ? "partial" : rawStatus;
  return {
    targetTitle: target.title,
    status,
    confidence: status === "covered" ? "medium" : "low",
    files: evidenceFiles,
    signals: matchedGroups.map((group) => group.label),
    reason:
      rawStatus === "covered" && status === "partial"
        ? "Related tests contain matching signals, but the flow is broad enough that CodeWard treats the evidence as partial."
        : status === "covered"
        ? "Related tests contain signals that match this coverage target."
        : "Related tests contain some signals for this target, but the evidence looks incomplete.",
  };
}

function toTestEvidenceFile(file: ProjectFile): TestSuiteEvidenceFile {
  const text = file.text ?? "";
  const testNames = extractTestNames(text);
  const imports = extractImports(text);
  return {
    path: file.path,
    testNames,
    imports,
    signals: extractSignals(`${file.path}\n${testNames.join("\n")}\n${text}`),
  };
}

function findRelatedTestFiles(flow: FlowCoverageInput, files: TestSuiteEvidenceFile[]): TestSuiteEvidenceFile[] {
  const flowTokens = meaningfulTokens([flow.title, ...flow.files].join("\n"));
  if (flowTokens.length === 0) {
    return [];
  }
  return files.filter((file) => {
    const testTokens = meaningfulTokens([file.path, ...file.imports, ...file.testNames].join("\n"));
    const overlap = flowTokens.filter((token) => testTokens.includes(token));
    return overlap.length > 0 || importsFlowFile(file.imports, flow.files);
  });
}

function importsFlowFile(imports: string[], flowFiles: string[]): boolean {
  return imports.some((importPath) => {
    const importStem = normalizePathForMatch(importPath);
    if (!importStem) {
      return false;
    }
    return flowFiles.some((file) => normalizePathForMatch(file).endsWith(importStem));
  });
}

function normalizePathForMatch(value: string): string {
  return value
    .replace(/\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|swift)$/i, "")
    .replace(/^\.\//, "")
    .replace(/\.\.\//g, "")
    .toLowerCase();
}

function extractTestNames(text: string): string[] {
  const names: string[] = [];
  const matcher = /\b(?:describe|it|test)\s*(?:\.\w+)?\s*\(\s*(["'`])([^"'`]+)\1/g;
  for (const match of text.matchAll(matcher)) {
    names.push(normalizeText(match[2]));
  }
  return uniqueStrings(names).slice(0, 40);
}

function extractImports(text: string): string[] {
  const imports: string[] = [];
  const importMatcher = /\bfrom\s+["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(importMatcher)) {
    imports.push(match[1] ?? match[2]);
  }
  return uniqueStrings(imports).slice(0, 80);
}

function extractSignals(text: string): string[] {
  const lowered = text.toLowerCase();
  const signals = [
    ["success", /\b(success|happy path|renders?|visible|complete[sd]?|submit(?:s|ted)?|save[sd]?|created|loads?)\b/],
    ["loading", /\b(loading|pending|spinner|skeleton|progress)\b/],
    ["empty", /\b(empty|no results?|zero results?|not found|blank state)\b/],
    ["error", /\b(error|failure|failed|reject(?:ed)?|throws?|exception)\b/],
    ["unauthorized", /\b(unauthorized|unauthenticated|forbidden|permission denied|401|403|expired session)\b/],
    ["network failure", /\b(timeout|network error|offline|server error|500|502|503|504|retry)\b/],
    ["api contract", /\b(contract|schema|response|request|status code|payload|headers?)\b/],
    ["state transition", /\b(state|transition|cache|stale|optimistic|refresh|re-entry|restart|resume|back navigation)\b/],
    ["config variant", /\b(config|fallback|feature flag|flag on|flag off|enabled|disabled|environment|env)\b/],
    ["viewport", /\b(viewport|mobile|desktop|responsive|small screen|dark mode|focus|disabled)\b/],
    ["locale", /\b(locale|i18n|translation|translated|theme)\b/],
    ["boundary input", /\b(invalid|validation|duplicate|boundary|missing|required|too long|empty input)\b/],
    ["browser viewport", /\b(browser|playwright|viewport|mobile|desktop|chromium|webkit|firefox)\b/],
    ["startup", /\b(startup|boot|runtime|install|build|clean checkout)\b/],
  ] as const;
  return signals.filter(([, pattern]) => pattern.test(lowered)).map(([label]) => label);
}

function signalGroupsForTarget(title: string): Array<{ label: string; patterns: RegExp[] }> {
  if (title === "Primary success path") {
    return [{ label: "success", patterns: [/\b(success|happy path|renders?|visible|complete[sd]?|submit(?:s|ted)?|save[sd]?|created|loads?)\b/i] }];
  }
  if (title === "Loading, empty, error, and success states") {
    return [
      { label: "loading", patterns: [/\b(loading|pending|spinner|skeleton|progress)\b/i] },
      { label: "empty", patterns: [/\b(empty|no results?|zero results?|not found|blank state)\b/i] },
      { label: "error", patterns: [/\b(error|failure|failed|reject(?:ed)?|throws?|exception)\b/i] },
      { label: "success", patterns: [/\b(success|renders?|visible|complete[sd]?|loads?)\b/i] },
    ];
  }
  if (title === "Navigation and re-entry") {
    return [{ label: "navigation", patterns: [/\b(back|forward|navigation|navigate|route|re-entry|refresh|resume|restart)\b/i] }];
  }
  if (title === "API contract compatibility") {
    return [{ label: "api contract", patterns: [/\b(contract|schema|response|request|status code|payload|headers?|200|201)\b/i] }];
  }
  if (title === "Network and server failure handling") {
    return [{ label: "network failure", patterns: [/\b(timeout|network error|offline|server error|500|502|503|504|retry|4xx|5xx)\b/i] }];
  }
  if (title === "State transition boundaries") {
    return [{ label: "state transition", patterns: [/\b(state|transition|cache|stale|optimistic|refresh|re-entry|restart|resume)\b/i] }];
  }
  if (title === "Authorization and permission states") {
    return [{ label: "authorization", patterns: [/\b(unauthorized|unauthenticated|forbidden|permission denied|401|403|expired session|auth|session)\b/i] }];
  }
  if (title === "Viewport and visual variants" || title === "Browser viewport regression") {
    return [{ label: "viewport", patterns: [/\b(viewport|mobile|desktop|responsive|small screen|dark mode|focus|disabled)\b/i] }];
  }
  if (title === "Locale and theme variants") {
    return [{ label: "locale/theme", patterns: [/\b(locale|i18n|translation|translated|theme|dark mode)\b/i] }];
  }
  if (title === "Configuration variants") {
    return [{ label: "configuration", patterns: [/\b(config|fallback|feature flag|flag on|flag off|enabled|disabled|environment|env)\b/i] }];
  }
  if (title === "Clean install and runtime startup") {
    return [{ label: "startup", patterns: [/\b(startup|boot|runtime|install|build|clean checkout)\b/i] }];
  }
  if (title === "Invalid, blocked, or boundary input") {
    return [{ label: "boundary input", patterns: [/\b(invalid|validation|duplicate|boundary|missing|required|too long|empty input|blocked)\b/i] }];
  }
  return [{ label: title.toLowerCase(), patterns: [new RegExp(escapeRegExp(title), "i")] }];
}

function coverageStatusForMatchedGroups(title: string, groupCount: number, matchedCount: number): CoverageEvidenceStatus {
  if (title === "Loading, empty, error, and success states") {
    return matchedCount >= 3 ? "covered" : "partial";
  }
  if (groupCount <= 1) {
    return "covered";
  }
  return matchedCount >= Math.min(2, groupCount) ? "covered" : "partial";
}

function isBroadFlow(flow: FlowCoverageInput): boolean {
  return flow.files.length > 12 || /^Changed\b/.test(flow.title);
}

function searchableEvidenceText(file: TestSuiteEvidenceFile): string {
  return [file.path, ...file.testNames, ...file.imports, ...file.signals].join("\n");
}

function detectFrameworkSignals(projectFiles: ProjectFile[], testFiles: TestSuiteEvidenceFile[]): string[] {
  const text = projectFiles.map((file) => `${file.path}\n${file.text ?? ""}`).join("\n").toLowerCase();
  const signals: string[] = [];
  if (/@playwright\/test|playwright\.config/.test(text)) {
    signals.push("playwright");
  }
  if (/\bvitest\b|from ["']vitest["']/.test(text)) {
    signals.push("vitest");
  }
  if (/\bjest\b|from ["']@jest/.test(text)) {
    signals.push("jest");
  }
  if (/\bnode:test\b|node --test/.test(text)) {
    signals.push("node:test");
  }
  if (/\bcypress\b|cypress\//.test(text)) {
    signals.push("cypress");
  }
  if (testFiles.some((file) => /(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/i.test(file.path))) {
    signals.push("pytest");
  }
  if (/\.maestro\//.test(testFiles.map((file) => file.path).join("\n"))) {
    signals.push("maestro");
  }
  return uniqueStrings(signals);
}

function isTestLikeFile(file: string): boolean {
  const basename = path.basename(file);
  if (/(?:^|\/)__pycache__\//.test(file) || /\.pyc$/i.test(file) || basename === "__init__.py") {
    return false;
  }
  return (
    /(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/i.test(file) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(file) ||
    /(?:^|\/)[^/]+_test\.(?:py|go)$/i.test(file) ||
    /(?:^|\/)[^/]+(?:Test|Tests|Spec)\.(?:java|kt|cs|swift)$/i.test(file) ||
    /(?:^|\/)[^/]+_(?:test|spec)\.rs$/i.test(file) ||
    /(?:^|\/)\.maestro\/[^/]+\.ya?ml$/i.test(file)
  );
}

function meaningfulTokens(text: string): string[] {
  const ignored = new Set([
    "app",
    "apps",
    "api",
    "apis",
    "changed",
    "checklist",
    "component",
    "components",
    "contract",
    "flow",
    "index",
    "init",
    "page",
    "pages",
    "route",
    "routes",
    "screen",
    "screens",
    "smoke",
    "service",
    "services",
    "client",
    "clients",
    "spec",
    "src",
    "test",
    "tests",
    "ui",
    "workflow",
  ]);
  return uniqueStrings(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/)
      .map((part) => part.toLowerCase())
      .filter((part) => part.length > 2 && !ignored.has(part)),
  );
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
