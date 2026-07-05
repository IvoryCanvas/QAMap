import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./fs.js";
import type { MatchedDomain } from "./domains.js";
import type { MatchedCoreFlow } from "./flows.js";
import type { TestPlanChangedFile } from "./test-plan.js";

export type DomainLanguageSource = "core-flow" | "domain-manifest" | "changed-file" | "ui-copy";
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
  routes?: string[];
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

interface BehaviorScenarioCandidate {
  title: string;
  term: string;
  behavior: string;
  files: string[];
  domainFileCount: number;
}

const maxFilesPerTerm = 8;

export async function buildDomainLanguageSummary(
  rootInput: string,
  changedFiles: TestPlanChangedFile[],
  coreFlows: MatchedCoreFlow[],
  domains: MatchedDomain[] = [],
  addedDiffText: Record<string, string> = {},
): Promise<DomainLanguageSummary> {
  const root = path.resolve(rootInput);
  const files = changedFiles.map((file) => file.path).filter((file) => !isTestLikeFile(file));
  const termMap = new Map<string, DomainLanguageTerm>();

  for (const flow of coreFlows) {
    addTerm(termMap, flow.name, "core-flow", "high", flow.matchedFiles);
  }

  for (const domain of domains) {
    addTerm(termMap, domain.name, "domain-manifest", "high", domain.matchedFiles);
    for (const alias of domain.aliases) {
      addTerm(termMap, alias, "domain-manifest", "medium", domain.matchedFiles);
    }
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
  const behaviorScenarios = buildBehaviorScenarioSuggestions(terms, files, addedDiffText);
  const scenarios = buildScenarioSuggestions(terms, coreFlows, domains, behaviorScenarios);

  return {
    terms,
    scenarios,
    guidance: [
      "Prefer these product words in generated test names, PR notes, and reviewer checklists.",
      "Promote durable product terms into `.qamap/domains.yml`, then promote end-to-end journeys into `.qamap/flows.yml`.",
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
  const term = source === "core-flow" || source === "domain-manifest" ? rawTerm.trim() : titleCase(rawTerm);
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
    existing.term = term;
    existing.confidence = confidence;
    existing.source = source;
  }
}

function buildScenarioSuggestions(
  terms: DomainLanguageTerm[],
  coreFlows: MatchedCoreFlow[],
  domains: MatchedDomain[],
  behaviorScenarios: DomainScenarioSuggestion[] = [],
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

  for (const domain of domains.slice(0, 4)) {
    if (domain.scenarios.length > 0) {
      for (const scenario of domain.scenarios.slice(0, 2)) {
        scenarios.push({
          title: scenario.title,
          intent: `Verify the team-approved "${domain.name}" domain with shared product language.`,
          checks:
            scenario.checks.length > 0
              ? scenario.checks
              : [
                  `Start from the normal entry point for ${domain.name}.`,
                  `Complete the main ${domain.name} action.`,
                  `Confirm the user-visible result for ${domain.name}.`,
                ],
          files: domain.matchedFiles,
          routes: domain.routes,
          source: "domain-manifest",
        });
      }
      continue;
    }
    scenarios.push({
      title: primaryJourneyTitle(domain.name),
      intent: `Use "${domain.name}" as the shared name for this changed behavior until the team chooses a more specific scenario.`,
      checks: [
        `Start from the normal entry point for ${domain.name}.`,
        `Complete the main ${domain.name} action with realistic data.`,
        `Confirm the visible result, saved state, navigation, or event that proves ${domain.name} worked.`,
        `Try one empty, blocked, rejected, or failed ${domain.name} path that a real user could hit.`,
      ],
      files: domain.matchedFiles,
      routes: domain.routes,
      source: "domain-manifest",
    });
  }

  scenarios.push(...behaviorScenarios);

  for (const term of terms
    .filter((item) => item.source !== "core-flow")
    .filter((item) => !hasBehaviorScenarioForTerm(item, behaviorScenarios))
    .slice(0, 5)) {
    scenarios.push({
      title: primaryJourneyTitle(term.term),
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

function primaryJourneyTitle(name: string): string {
  return `${name.replace(/\s+primary\s+journey\s*$/i, "").trim()} primary journey`;
}

function hasBehaviorScenarioForTerm(term: DomainLanguageTerm, scenarios: DomainScenarioSuggestion[]): boolean {
  const prefix = `${term.term.toLowerCase()} `;
  return scenarios.some((scenario) => scenario.source === "changed-file" && scenario.title.toLowerCase().startsWith(prefix));
}

function buildBehaviorScenarioSuggestions(
  terms: DomainLanguageTerm[],
  files: string[],
  addedDiffText: Record<string, string> = {},
): DomainScenarioSuggestion[] {
  const candidates = new Map<string, BehaviorScenarioCandidate>();
  for (const file of files.filter(isDomainLanguageFile)) {
    const term = bestBehaviorDomainTermForFile(terms, file);
    if (!term) {
      continue;
    }
    const behavior = behaviorLabelFromAddedText(addedDiffText[file], term.term) ?? behaviorLabelFromPath(file, term.term);
    if (!behavior) {
      continue;
    }
    const title = `${term.term} ${behavior}`;
    const key = title.toLowerCase();
    const existing = candidates.get(key);
    if (existing) {
      existing.files = uniqueStrings([...existing.files, file]).slice(0, maxFilesPerTerm);
      continue;
    }
    candidates.set(key, {
      title,
      term: term.term,
      behavior,
      files: [file],
      domainFileCount: term.files.length,
    });
  }

  return selectBehaviorScenarioCandidates([...candidates.values()])
    .map((candidate) => ({
      title: candidate.title,
      intent: `Verify the changed "${candidate.behavior}" behavior inside ${candidate.term} instead of stopping at a generic primary journey.`,
      checks: [
        `Start from the ${candidate.term} entry point that exposes ${candidate.behavior}.`,
        `Exercise ${candidate.behavior} with realistic data from the changed branch.`,
        `Confirm the visible result, saved state, navigation, request, or event that proves ${candidate.behavior} worked.`,
        `Try one empty, blocked, rejected, or failed ${candidate.behavior} path that a real user or caller could hit.`,
      ],
      files: candidate.files,
      source: "changed-file",
    }));
}

function selectBehaviorScenarioCandidates(candidates: BehaviorScenarioCandidate[]): BehaviorScenarioCandidate[] {
  const selected: BehaviorScenarioCandidate[] = [];
  const deferred: BehaviorScenarioCandidate[] = [];
  const selectedByTerm = new Map<string, number>();
  for (const candidate of candidates.sort(compareBehaviorScenarioCandidates)) {
    const currentTermCount = selectedByTerm.get(candidate.term) ?? 0;
    if (currentTermCount < 2) {
      selected.push(candidate);
      selectedByTerm.set(candidate.term, currentTermCount + 1);
    } else {
      deferred.push(candidate);
    }
    if (selected.length === 4) {
      return selected;
    }
  }
  return [...selected, ...deferred].slice(0, 4);
}

function bestBehaviorDomainTermForFile(terms: DomainLanguageTerm[], file: string): DomainLanguageTerm | undefined {
  return terms
    .filter((term) => term.source !== "ui-copy" && filesOverlap([file], term.files))
    .filter((term) => !isBehaviorOnlyTerm(term.term, file))
    .sort(compareTerms)[0];
}

function filesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftFile) => right.some((rightFile) => sameOrNestedFileReference(leftFile, rightFile)));
}

function sameOrNestedFileReference(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparisonPath(left);
  const normalizedRight = normalizeComparisonPath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

function normalizeComparisonPath(file: string): string {
  return file.replace(/^\.\/+/, "").replace(/\/+$/g, "");
}

function isBehaviorOnlyTerm(term: string, file: string): boolean {
  const basenameTokens = behaviorTokensFromText(path.basename(file));
  const termTokens = behaviorTokensFromText(term);
  if (termTokens.length < 2 || basenameTokens.length === 0) {
    return false;
  }
  return termTokens.every((token) => basenameTokens.some((basenameToken) => sameToken(token, basenameToken)));
}

const addedLabelMatcher =
  /(?:aria-label|accessibilityLabel)=["']([^"'{}<>\n]{3,60})["']|data-testid=["']([^"'{}<>\n]{3,60})["']|testID=["']([^"'{}<>\n]{3,60})["']/g;

const addedActionTextMatcher = /<(?:button|Button|Pressable|a|Link)\b[^<>]*>\s*([^<>{}\n]{3,60})\s*</g;

function behaviorLabelFromAddedText(addedText: string | undefined, domainTerm: string): string | undefined {
  if (!addedText) {
    return undefined;
  }
  const domainTokens = behaviorTokensFromText(domainTerm);
  let fallback: string | undefined;
  const labels: string[] = [];
  for (const match of addedText.matchAll(addedLabelMatcher)) {
    labels.push(match[1] ?? match[2] ?? match[3]);
  }
  for (const match of addedText.matchAll(addedActionTextMatcher)) {
    labels.push(match[1].trim());
  }
  for (const label of labels) {
    const tokens = behaviorTokensFromText(label)
      .filter((token) => !domainTokens.some((domainToken) => sameToken(domainToken, token)))
      .filter((token) => !behaviorStructuralTokens.has(token));
    if (tokens.length === 0 || tokens.length > 4) {
      continue;
    }
    if (tokens.length === 1 && !behaviorActionTokens.has(tokens[0]) && !isLikelyBusinessObjectToken(tokens[0])) {
      continue;
    }
    const title = titleCase(tokens.map(formatBehaviorToken).join(" "));
    if (tokens.some((token) => behaviorActionTokens.has(token))) {
      return title;
    }
    fallback ??= title;
  }
  return fallback;
}

function behaviorLabelFromPath(file: string, domainTerm: string): string | undefined {
  const basename = path.basename(file).replace(/\.(?:d\.)?(?:[cm]?[jt]sx?|vue|svelte|css|scss|sass|less|json|ya?ml|md|py|go|rs|kt|java|swift|cs)$/i, "");
  const domainTokens = behaviorTokensFromText(domainTerm);
  const tokens = behaviorTokensFromText(basename)
    .filter((token) => !domainTokens.some((domainToken) => sameToken(domainToken, token)))
    .filter((token) => !behaviorStructuralTokens.has(token));
  if (tokens.length === 0) {
    return undefined;
  }
  if (tokens.length === 1 && !behaviorActionTokens.has(tokens[0]) && !isLikelyBusinessObjectToken(tokens[0])) {
    return undefined;
  }
  return titleCase(tokens.map(formatBehaviorToken).join(" "));
}

function behaviorTokensFromText(value: string): string[] {
  return uniqueStrings(
    value
      .replace(/\.[^.]+$/g, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9가-힣]+/)
      .map((part) => part.toLowerCase())
      .filter(Boolean),
  );
}

function sameToken(left: string, right: string): boolean {
  return singularizeToken(left) === singularizeToken(right);
}

function singularizeToken(token: string): string {
  return token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
}

function formatBehaviorToken(token: string): string {
  const acronyms: Record<string, string> = {
    api: "API",
    id: "ID",
    url: "URL",
    urls: "URLs",
    ui: "UI",
  };
  return acronyms[token] ?? token;
}

function isLikelyBusinessObjectToken(token: string): boolean {
  return token.length > 4 && !behaviorStructuralTokens.has(token);
}

function compareBehaviorScenarioCandidates(left: BehaviorScenarioCandidate, right: BehaviorScenarioCandidate): number {
  const domainImpactDiff = right.domainFileCount - left.domainFileCount;
  if (domainImpactDiff !== 0) {
    return domainImpactDiff;
  }
  const actionDiff = Number(hasActionToken(right.behavior)) - Number(hasActionToken(left.behavior));
  if (actionDiff !== 0) {
    return actionDiff;
  }
  const fileDiff = right.files.length - left.files.length;
  if (fileDiff !== 0) {
    return fileDiff;
  }
  return left.title.localeCompare(right.title);
}

function hasActionToken(value: string): boolean {
  return behaviorTokensFromText(value).some((token) => behaviorActionTokens.has(token));
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
    { key: "src", confidence: "medium" },
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
  return /^v?\d+(?:-\d+)?$/i.test(normalized) || structuralSegments.has(normalized);
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
  if (isRouteSyntaxSegment(value)) {
    return undefined;
  }
  const normalized = value
    .replace(/\.(?:d\.)?(?:[cm]?[jt]sx?|vue|svelte|css|scss|sass|less|json|ya?ml|md|py|go|rs|kt|java|swift|cs|png|jpe?g|webp|gif|svg)$/i, "")
    .replace(/(?:Api|Service|Controller|Component|Screen)$/g, "")
    .replace(/^_+|_+$/g, "")
    .trim();
  if (isRouteSyntaxSegment(normalized)) {
    return undefined;
  }
  if (/^use[A-Z]/.test(normalized)) {
    return undefined;
  }
  return isUsefulTerm(normalized) ? normalized : undefined;
}

function isRouteSyntaxSegment(value: string): boolean {
  return /^\([^)]*\)$/.test(value) || /^\[{1,2}(?:\.\.\.)?[^/\]]+\]{1,2}$/.test(value);
}

function isDomainLanguageFile(file: string): boolean {
  if (/(?:^|\/)(?:assets?|images?|icons?|fonts?)\//i.test(file)) {
    return false;
  }
  if (isGeneratedOutputFile(file)) {
    return false;
  }
  if (/(?:^|\/)(?:\.agents?|\.claude|\.cursor|\.dev|\.gemini|\.github|docs?)\//i.test(file)) {
    return false;
  }
  if (/(?:^|\/)(?:AGENTS|CLAUDE|CODEX|DECISIONS|GEMINI|README|SKILL)\.md$/i.test(file)) {
    return false;
  }
  if (/(?:^|\/)\.gitignore$/i.test(file)) {
    return false;
  }
  if (/(?:^|\/)(?:CHANGELOG|RELEASES?|release-notes?|\.release-please-manifest)\.(?:md|json)$/i.test(file)) {
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

function isGeneratedOutputFile(file: string): boolean {
  return (
    /(?:^|\/)(?:dist|build|out|coverage|generated|__generated__|codegen)\//i.test(file) ||
    /(?:^|\/)(?:public|src|lib|packages?)\/(?:generated|__generated__|codegen)\//i.test(file) ||
    /(?:^|\/)[^/]*(?:generated|codegen)[^/]*\.(?:[cm]?[jt]sx?|json|ya?ml|css|scss|md)$/i.test(file) ||
    /\.(?:generated|gen)\.[cm]?[jt]sx?$/i.test(file)
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
  "common",
  "commons",
  "controller",
  "controllers",
  "core",
  "docs",
  "handler",
  "handlers",
  "helper",
  "helpers",
  "lib",
  "libs",
  "features",
  "layouts",
  "middleware",
  "middlewares",
  "modules",
  "navigation",
  "navigations",
  "pages",
  "private",
  "protected",
  "public",
  "providers",
  "routes",
  "screens",
  "services",
  "shared",
  "src",
  "util",
  "utils",
]);

const behaviorStructuralTokens = new Set([
  "api",
  "apis",
  "button",
  "card",
  "client",
  "component",
  "components",
  "container",
  "controller",
  "dialog",
  "drawer",
  "form",
  "fragment",
  "hook",
  "hooks",
  "index",
  "item",
  "layout",
  "list",
  "modal",
  "overview",
  "page",
  "pages",
  "panel",
  "provider",
  "route",
  "screen",
  "screens",
  "section",
  "service",
  "services",
  "style",
  "styles",
  "tab",
  "tabs",
  "util",
  "utils",
  "view",
  "widget",
]);

const behaviorActionTokens = new Set([
  "add",
  "apply",
  "approve",
  "auth",
  "block",
  "cancel",
  "change",
  "charge",
  "check",
  "complete",
  "confirm",
  "connect",
  "create",
  "delete",
  "detail",
  "edit",
  "fallback",
  "filter",
  "login",
  "logout",
  "open",
  "purchase",
  "reject",
  "remove",
  "renew",
  "reset",
  "save",
  "search",
  "select",
  "submit",
  "sync",
  "update",
  "upload",
  "verify",
]);
