import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./fs.js";
import type { MatchedCoreFlow } from "./flows.js";
import type { TestPlanChangedFile } from "./test-plan.js";

export type DomainLanguageSource = "core-flow" | "changed-file" | "ui-copy";
export type DomainLanguageConfidence = "high" | "medium" | "low";

export interface DomainLanguageTerm {
  term: string;
  source: DomainLanguageSource;
  confidence: DomainLanguageConfidence;
  files: string[];
}

export interface DomainScenarioSuggestion {
  title: string;
  intent: string;
  checks: string[];
  files: string[];
  source: DomainLanguageSource;
}

export interface DomainLanguageSummary {
  terms: DomainLanguageTerm[];
  scenarios: DomainScenarioSuggestion[];
  guidance: string[];
}

interface PathTermCandidate {
  term: string;
  confidence: DomainLanguageConfidence;
}

const maxFilesPerTerm = 8;

export async function buildDomainLanguageSummary(
  rootInput: string,
  changedFiles: TestPlanChangedFile[],
  coreFlows: MatchedCoreFlow[],
): Promise<DomainLanguageSummary> {
  const root = path.resolve(rootInput);
  const files = changedFiles.map((file) => file.path).filter((file) => !isTestLikeFile(file));
  const termMap = new Map<string, DomainLanguageTerm>();

  for (const flow of coreFlows) {
    addTerm(termMap, flow.name, "core-flow", "high", flow.matchedFiles);
  }

  for (const file of files) {
    for (const candidate of termsFromPath(file)) {
      addTerm(termMap, candidate.term, "changed-file", candidate.confidence, [file]);
    }
  }

  for (const term of await collectUiCopyTerms(root, files)) {
    addTerm(termMap, term.term, "ui-copy", "low", term.files);
  }

  const terms = [...termMap.values()]
    .filter((term) => isUsefulTerm(term.term))
    .sort(compareTerms)
    .slice(0, 12);
  const scenarios = buildScenarioSuggestions(terms, coreFlows);

  return {
    terms,
    scenarios,
    guidance: [
      "Prefer these product words in generated test names, PR notes, and reviewer checklists.",
      "Promote high-confidence repeated terms into `.codeward/flows.yml` when the team agrees they describe a durable user flow.",
      "Use the suggested scenarios as starting points, then replace generic actor or outcome wording with the team's domain language.",
    ],
  };
}

function addTerm(
  terms: Map<string, DomainLanguageTerm>,
  rawTerm: string,
  source: DomainLanguageSource,
  confidence: DomainLanguageConfidence,
  files: string[],
): void {
  const term = source === "core-flow" ? rawTerm.trim() : titleCase(rawTerm);
  if (!isUsefulTerm(term)) {
    return;
  }
  const key = term.toLowerCase();
  const existing = terms.get(key);
  if (!existing) {
    terms.set(key, {
      term,
      source,
      confidence,
      files: uniqueStrings(files).slice(0, maxFilesPerTerm),
    });
    return;
  }
  existing.files = uniqueStrings([...existing.files, ...files]).slice(0, maxFilesPerTerm);
  if (confidenceRank(confidence) > confidenceRank(existing.confidence)) {
    existing.confidence = confidence;
    existing.source = source;
  }
}

function buildScenarioSuggestions(
  terms: DomainLanguageTerm[],
  coreFlows: MatchedCoreFlow[],
): DomainScenarioSuggestion[] {
  const scenarios: DomainScenarioSuggestion[] = [];

  for (const flow of coreFlows.slice(0, 4)) {
    scenarios.push({
      title: flow.name,
      intent: `Verify the team-approved "${flow.name}" flow with the words reviewers already use for this behavior.`,
      checks:
        flow.checks.length > 0
          ? flow.checks
          : [
              "Start from the entry point a real user uses.",
              "Complete the main action.",
              "Confirm the user-visible result.",
            ],
      files: flow.matchedFiles,
      source: "core-flow",
    });
  }

  for (const term of terms.filter((item) => item.source !== "core-flow").slice(0, 5)) {
    scenarios.push({
      title: `${term.term} primary journey`,
      intent: `Use "${term.term}" as the shared name for this changed behavior until the team chooses a better domain term.`,
      checks: [
        `Start from the normal entry point for ${term.term}.`,
        `Complete the main ${term.term} action with realistic data.`,
        `Confirm the visible result, saved state, navigation, or event that proves ${term.term} worked.`,
        `Try one empty, blocked, rejected, or failed ${term.term} path that a real user could hit.`,
      ],
      files: term.files,
      source: term.source,
    });
  }

  return dedupeScenarios(scenarios).slice(0, 6);
}

async function collectUiCopyTerms(
  root: string,
  files: string[],
): Promise<Array<{ term: string; files: string[] }>> {
  const terms: Array<{ term: string; files: string[] }> = [];
  for (const file of files.filter(isUiImplementationFile).slice(0, 8)) {
    const absolutePath = path.join(root, file);
    if (!(await pathExists(absolutePath))) {
      continue;
    }
    const text = await fs.readFile(absolutePath, "utf8");
    for (const term of extractUiCopyTerms(text)) {
      terms.push({ term, files: [file] });
    }
  }
  return terms;
}

function termsFromPath(file: string): PathTermCandidate[] {
  if (!isDomainLanguageFile(file)) {
    return [];
  }
  const terms: PathTermCandidate[] = [];
  const segments = file.split("/");
  const semanticKeys: Array<{ key: string; confidence: DomainLanguageConfidence }> = [
    { key: "features", confidence: "high" },
    { key: "domains", confidence: "high" },
    { key: "modules", confidence: "high" },
    { key: "services", confidence: "high" },
    { key: "entities", confidence: "high" },
    { key: "pages", confidence: "medium" },
    { key: "screens", confidence: "medium" },
    { key: "app", confidence: "medium" },
  ];
  for (const { key, confidence } of semanticKeys) {
    const index = segments.indexOf(key);
    const value = normalizeSegment(semanticSegmentAfterKey(segments, index));
    if (value) {
      terms.push({ term: value, confidence });
    }
  }
  const basename = normalizeSegment(path.basename(file));
  if (basename) {
    terms.push({ term: basename, confidence: "medium" });
  }
  return uniquePathTermCandidates(terms);
}

function semanticSegmentAfterKey(segments: string[], keyIndex: number): string | undefined {
  if (keyIndex < 0) {
    return undefined;
  }
  for (const segment of segments.slice(keyIndex + 1)) {
    if (!isStructuralSegment(segment)) {
      return segment;
    }
  }
  return undefined;
}

function isStructuralSegment(segment: string): boolean {
  const normalized = segment.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
  return structuralSegments.has(normalized);
}

function extractUiCopyTerms(text: string): string[] {
  const terms: string[] = [];
  const patterns = [
    /\b(?:accessibilityLabel|aria-label|placeholder|title|label)=["']([^"']{2,80})["']/g,
    /<Text[^>]*>\s*([^<{]{2,80})\s*<\/Text>/g,
    /(?:button|cta|action|screen|page)Title\s*[:=]\s*["']([^"']{2,80})["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = normalizeUiCopy(match[1] ?? "");
      if (value) {
        terms.push(value);
      }
    }
  }
  return uniqueStrings(terms).slice(0, 8);
}

function normalizeUiCopy(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 60) {
    return undefined;
  }
  if (/TODO|http|www\.|[{}[\]();]/i.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function normalizeSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value
    .replace(/\.(?:d\.)?(?:[cm]?[jt]sx?|vue|svelte|css|scss|sass|less|json|ya?ml|md|py|go|rs|kt|java|swift|cs|png|jpe?g|webp|gif|svg)$/i, "")
    .replace(/(?:Api|Service|Controller|Component|Screen)$/g, "")
    .replace(/^_+|_+$/g, "")
    .trim();
  if (/^use[A-Z]/.test(normalized)) {
    return undefined;
  }
  return isUsefulTerm(normalized) ? normalized : undefined;
}

function isDomainLanguageFile(file: string): boolean {
  if (/(?:^|\/)(?:assets?|images?|icons?|fonts?)\//i.test(file)) {
    return false;
  }
  if (/(?:package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb|Podfile\.lock|\.xcodeproj|eas\.json|app\.config\.)/i.test(file)) {
    return false;
  }
  return true;
}

function isUiImplementationFile(file: string): boolean {
  return /\.(?:tsx|jsx|vue|svelte)$/i.test(file);
}

function isTestLikeFile(file: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|tests?|specs?|e2e)\//i.test(file) ||
    /(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/i.test(file) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(file) ||
    /(?:^|\/)[^/]+_test\.(?:py|go)$/i.test(file)
  );
}

function isUsefulTerm(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
  const ignored = new Set([
    "api",
    "apis",
    "app",
    "client",
    "component",
    "components",
    "config",
    "controller",
    "content",
    "doc",
    "docs",
    "index",
    "ios",
    "android",
    "layout",
    "model",
    "navigation",
    "navigations",
    "page",
    "pages",
    "provider",
    "providers",
    "readme",
    "route",
    "routes",
    "screen",
    "screens",
    "service",
    "services",
    "shared",
    "src",
    "test",
    "tests",
    "ui",
    "util",
    "utils",
  ]);
  return normalized.length > 1 && !ignored.has(normalized);
}

function compareTerms(left: DomainLanguageTerm, right: DomainLanguageTerm): number {
  const confidenceDiff = confidenceRank(right.confidence) - confidenceRank(left.confidence);
  if (confidenceDiff !== 0) {
    return confidenceDiff;
  }
  const fileDiff = right.files.length - left.files.length;
  if (fileDiff !== 0) {
    return fileDiff;
  }
  return left.term.localeCompare(right.term);
}

function confidenceRank(confidence: DomainLanguageConfidence): number {
  if (confidence === "high") {
    return 3;
  }
  if (confidence === "medium") {
    return 2;
  }
  return 1;
}

function titleCase(value: string): string {
  if (/[가-힣]/.test(value)) {
    return value.trim();
  }
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      if (/^[A-Z0-9]+$/.test(part)) {
        return part;
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function dedupeScenarios(scenarios: DomainScenarioSuggestion[]): DomainScenarioSuggestion[] {
  const seen = new Set<string>();
  const deduped: DomainScenarioSuggestion[] = [];
  for (const scenario of scenarios) {
    const key = scenario.title.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(scenario);
  }
  return deduped;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function uniquePathTermCandidates(values: PathTermCandidate[]): PathTermCandidate[] {
  const candidates = new Map<string, PathTermCandidate>();
  for (const value of values) {
    const key = value.term.toLowerCase();
    const existing = candidates.get(key);
    if (!existing || confidenceRank(value.confidence) > confidenceRank(existing.confidence)) {
      candidates.set(key, value);
    }
  }
  return [...candidates.values()];
}

const structuralSegments = new Set([
  "app",
  "apps",
  "components",
  "content",
  "docs",
  "features",
  "layouts",
  "modules",
  "navigation",
  "navigations",
  "pages",
  "providers",
  "routes",
  "screens",
  "services",
  "shared",
  "src",
]);
