import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { defaultDomainManifestPath } from "./domains.js";
import { generateE2ePlan } from "./e2e.js";
import { defaultFlowManifestPath } from "./flows.js";
import { pathExists, toPosixPath } from "./fs.js";
import { TOOL_NAME, VERSION } from "./version.js";
import type { DomainDefinition, DomainScenarioDefinition } from "./domains.js";
import type { E2eFlow, E2ePlanOptions, E2ePlanResult } from "./e2e.js";
import type { CoreFlowDefinition, CoreFlowPriority } from "./flows.js";

export interface ManifestSuggestionOptions extends E2ePlanOptions {}

export interface DomainManifestSuggestionResult {
  tool: {
    name: string;
    version: string;
  };
  kind: "domain-manifest-suggestion";
  root: string;
  workspaceRoot?: string;
  manifestRoot: string;
  generatedAt: string;
  base: string;
  head: string;
  includeWorkingTree: boolean;
  changedFiles: string[];
  domains: DomainDefinition[];
  yaml: string;
}

export interface FlowManifestSuggestionResult {
  tool: {
    name: string;
    version: string;
  };
  kind: "flow-manifest-suggestion";
  root: string;
  workspaceRoot?: string;
  manifestRoot: string;
  generatedAt: string;
  base: string;
  head: string;
  includeWorkingTree: boolean;
  changedFiles: string[];
  flows: CoreFlowDefinition[];
  yaml: string;
}

export async function generateDomainManifestSuggestion(
  rootInput: string,
  options: ManifestSuggestionOptions = {},
): Promise<DomainManifestSuggestionResult> {
  const plan = await generateE2ePlan(rootInput, options);
  const domains = buildSuggestedDomains(plan);
  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    kind: "domain-manifest-suggestion",
    root: plan.root,
    workspaceRoot: plan.workspaceRoot,
    manifestRoot: plan.workspaceRoot ?? plan.root,
    generatedAt: new Date().toISOString(),
    base: plan.base,
    head: plan.head,
    includeWorkingTree: plan.includeWorkingTree,
    changedFiles: plan.changedFiles.map((file) => manifestRelativeFile(plan, file.path)),
    domains,
    yaml: formatSuggestedDomainManifestYaml(domains),
  };
}

export async function generateFlowManifestSuggestion(
  rootInput: string,
  options: ManifestSuggestionOptions = {},
): Promise<FlowManifestSuggestionResult> {
  const plan = await generateE2ePlan(rootInput, options);
  const domains = buildSuggestedDomains(plan);
  const flows = buildSuggestedFlows(plan, domains);
  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    kind: "flow-manifest-suggestion",
    root: plan.root,
    workspaceRoot: plan.workspaceRoot,
    manifestRoot: plan.workspaceRoot ?? plan.root,
    generatedAt: new Date().toISOString(),
    base: plan.base,
    head: plan.head,
    includeWorkingTree: plan.includeWorkingTree,
    changedFiles: plan.changedFiles.map((file) => manifestRelativeFile(plan, file.path)),
    flows,
    yaml: formatSuggestedFlowManifestYaml(flows),
  };
}

export function formatDomainManifestSuggestion(result: DomainManifestSuggestionResult, format: "text" | "json" | "markdown"): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "markdown") {
    const lines = manifestSuggestionHeader("Domain Manifest Suggestion", result);
    lines.push("## Suggested Domains");
    lines.push("");
    if (result.domains.length === 0) {
      lines.push("No durable domain candidates were detected from the changed files.");
      lines.push("");
    } else {
      for (const domain of result.domains) {
        lines.push(`- ${domain.name} \`${domain.id}\`: ${domain.files.join(", ")}`);
      }
      lines.push("");
    }
    lines.push("## YAML");
    lines.push("");
    lines.push("```yaml");
    lines.push(result.yaml.trimEnd());
    lines.push("```");
    lines.push("");
    return lines.join("\n");
  }
  return result.yaml;
}

export function formatFlowManifestSuggestion(result: FlowManifestSuggestionResult, format: "text" | "json" | "markdown"): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "markdown") {
    const lines = manifestSuggestionHeader("Core Flow Manifest Suggestion", result);
    lines.push("## Suggested Flows");
    lines.push("");
    if (result.flows.length === 0) {
      lines.push("No durable core flow candidates were detected from the changed files.");
      lines.push("");
    } else {
      for (const flow of result.flows) {
        lines.push(`- ${flow.name} \`${flow.id}\` [${flow.priority}]: ${flow.files.join(", ")}`);
      }
      lines.push("");
    }
    lines.push("## YAML");
    lines.push("");
    lines.push("```yaml");
    lines.push(result.yaml.trimEnd());
    lines.push("```");
    lines.push("");
    return lines.join("\n");
  }
  return result.yaml;
}

export async function writeSuggestedManifest(
  rootInput: string,
  fileName: string,
  content: string,
  force = false,
): Promise<string> {
  const root = path.resolve(rootInput);
  const outputPath = path.resolve(root, fileName);
  if (!force && (await pathExists(outputPath))) {
    throw new Error(`Refusing to overwrite ${outputPath}. Pass --force to replace it.`);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, "utf8");
  return outputPath;
}

function buildSuggestedDomains(plan: E2ePlanResult): DomainDefinition[] {
  const domains: DomainDefinition[] = [];
  const terms = plan.domainLanguage.terms.filter((term) => term.files.length > 0).slice(0, 8);

  for (const term of terms) {
    const files = uniqueStrings(term.files.map((file) => manifestRelativeFile(plan, file)).filter(isBehaviorFile));
    const patterns = uniqueStrings(files.map(domainFilePattern)).slice(0, 4);
    if (patterns.length === 0) {
      continue;
    }
    const id = slugify(term.term);
    const scenarios = scenariosForTerm(plan, term.term, files);
    domains.push({
      id,
      name: term.term,
      aliases: [],
      files: patterns,
      routes: routeHintsForFiles(plan, term.files).slice(0, 4),
      tags: ["suggested"],
      scenarios,
    });
  }

  if (domains.length === 0) {
    for (const flow of plan.flows.slice(0, 4)) {
      const subject = durableSubject(flow.title);
      const files = uniqueStrings(flow.files.map((file) => manifestRelativeFile(plan, file)).filter(isBehaviorFile));
      const patterns = uniqueStrings(files.map(domainFilePattern)).slice(0, 4);
      if (!subject || patterns.length === 0) {
        continue;
      }
      domains.push({
        id: slugify(subject),
        name: subject,
        aliases: [],
        files: patterns,
        routes: routeHintsForFiles(plan, flow.files).slice(0, 4),
        tags: ["suggested"],
        scenarios: [
          {
            title: `${subject} primary journey`,
            checks: checksForFlow(flow),
          },
        ],
      });
    }
  }

  return dedupeDomains(domains).slice(0, 8);
}

function buildSuggestedFlows(plan: E2ePlanResult, domains: DomainDefinition[]): CoreFlowDefinition[] {
  const flows: CoreFlowDefinition[] = [];
  const scenarios = plan.domainLanguage.scenarios.length > 0
    ? plan.domainLanguage.scenarios
    : plan.flows.map((flow) => ({
        title: flow.title,
        intent: flow.reason,
        checks: flow.steps,
        files: flow.files,
        source: "changed-file" as const,
      }));

  for (const scenario of scenarios.slice(0, 8)) {
    const baseFlow = bestFlowForFiles(plan.flows, scenario.files);
    const localFiles = scenario.files.length > 0 ? scenario.files : (baseFlow?.files ?? []);
    const files = uniqueStrings(localFiles.map((file) => manifestRelativeFile(plan, file)).filter(isBehaviorFile));
    const patterns = uniqueStrings(files.map(domainFilePattern)).slice(0, 5);
    if (patterns.length === 0) {
      continue;
    }
    const flowDomains = domainIdsForFiles(files, domains);
    const checks = scenario.checks.length > 0 ? scenario.checks : baseFlow ? checksForFlow(baseFlow) : genericFlowChecks(scenario.title);
    flows.push({
      id: slugify(scenario.title),
      name: scenario.title,
      priority: priorityForFlow(scenario.title, baseFlow),
      domains: flowDomains,
      files: patterns,
      routes: uniqueStrings([
        ...routesForScenario(scenario),
        ...routeHintsForFiles(plan, localFiles),
      ]).slice(0, 4),
      tags: ["suggested"],
      checks: checks.slice(0, 6),
    });
  }

  if (flows.length === 0) {
    for (const flow of plan.flows.slice(0, 4)) {
      const files = uniqueStrings(flow.files.map((file) => manifestRelativeFile(plan, file)).filter(isBehaviorFile));
      const patterns = uniqueStrings(files.map(domainFilePattern)).slice(0, 5);
      if (patterns.length === 0) {
        continue;
      }
      flows.push({
        id: slugify(flow.title),
        name: flow.title,
        priority: priorityForFlow(flow.title, flow),
        domains: domainIdsForFiles(files, domains),
        files: patterns,
        routes: routeHintsForFiles(plan, flow.files).slice(0, 4),
        tags: ["suggested"],
        checks: checksForFlow(flow),
      });
    }
  }

  return dedupeFlows(flows).slice(0, 8);
}

function manifestSuggestionHeader(
  title: string,
  result: DomainManifestSuggestionResult | FlowManifestSuggestionResult,
): string[] {
  const lines: string[] = [];
  lines.push(`# CodeWard ${title}`);
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  if (result.workspaceRoot) {
    lines.push(`- Workspace root: \`${escapeMarkdownInline(result.workspaceRoot)}\``);
  }
  lines.push(`- Manifest root: \`${escapeMarkdownInline(result.manifestRoot)}\``);
  lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
  lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
  if (result.includeWorkingTree) {
    lines.push("- Includes working tree changes: yes");
  }
  lines.push(`- Changed files considered: ${result.changedFiles.length}`);
  lines.push("");
  return lines;
}

function formatSuggestedDomainManifestYaml(domains: DomainDefinition[]): string {
  return [
    "# Suggested by CodeWard. Review names, routes, and checks before committing.",
    "# Commit this file as .codeward/domains.yml only when these words match team language.",
    YAML.stringify({ domains }, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
}

function formatSuggestedFlowManifestYaml(flows: CoreFlowDefinition[]): string {
  return [
    "# Suggested by CodeWard. Review priorities, routes, and checks before committing.",
    "# Commit this file as .codeward/flows.yml only when these journeys are team-approved.",
    YAML.stringify({ flows }, { lineWidth: 0 }).trimEnd(),
    "",
  ].join("\n");
}

function scenariosForTerm(plan: E2ePlanResult, term: string, manifestFiles: string[]): DomainScenarioDefinition[] {
  const normalizedTerm = normalizeToken(term);
  const scenario = plan.domainLanguage.scenarios.find((item) => {
    const normalizedTitle = normalizeToken(item.title);
    return normalizedTitle === normalizedTerm || normalizedTitle.startsWith(`${normalizedTerm}-`) || normalizedTitle.includes(normalizedTerm);
  });
  if (scenario) {
    return [
      {
        title: scenario.title,
        checks: scenario.checks.length > 0 ? scenario.checks.slice(0, 6) : genericFlowChecks(scenario.title),
      },
    ];
  }

  const localFiles = manifestFiles.map((file) => localRelativeFile(plan, file));
  const flow = bestFlowForFiles(plan.flows, localFiles);
  return [
    {
      title: `${term} primary journey`,
      checks: flow ? checksForFlow(flow) : genericFlowChecks(term),
    },
  ];
}

function routesForScenario(scenario: unknown): string[] {
  if (!scenario || typeof scenario !== "object" || !("routes" in scenario)) {
    return [];
  }
  const routes = (scenario as { routes?: unknown }).routes;
  return Array.isArray(routes) ? routes.filter((route): route is string => typeof route === "string") : [];
}

function checksForFlow(flow: E2eFlow): string[] {
  const checks = uniqueStrings([
    ...flow.steps,
    ...flow.coverage.filter((target) => target.priority === "critical").flatMap((target) => target.checks),
  ]);
  return checks.length > 0 ? checks.slice(0, 6) : genericFlowChecks(flow.title);
}

function genericFlowChecks(subject: string): string[] {
  return [
    `Start from the normal entry point for ${subject}.`,
    `Complete the main ${subject} action with realistic data.`,
    `Confirm the visible result, saved state, navigation, or emitted event.`,
    `Try one empty, blocked, rejected, or failed ${subject} path that a real user could hit.`,
  ];
}

function priorityForFlow(title: string, flow: E2eFlow | undefined): CoreFlowPriority {
  const text = `${title}\n${flow?.files.join("\n") ?? ""}`.toLowerCase();
  if (/(checkout|billing|payment|purchase|subscription|auth|login|signup|permission|security|settlement)/.test(text)) {
    return "critical";
  }
  if (flow?.coverage.some((target) => target.priority === "critical")) {
    return "recommended";
  }
  return "optional";
}

function routeHintsForFiles(plan: E2ePlanResult, files: string[]): string[] {
  const routes = new Set<string>();
  const relatedFlows = plan.flows.filter((flow) => overlaps(flow.files, files));
  for (const flow of relatedFlows) {
    for (const entrypoint of flow.entrypoints) {
      if (entrypoint.kind === "route") {
        routes.add(entrypoint.value);
      }
    }
  }
  for (const file of files) {
    const route = routeFromFile(file);
    if (route) {
      routes.add(route);
    }
  }
  return [...routes].slice(0, 6);
}

function bestFlowForFiles(flows: E2eFlow[], files: string[]): E2eFlow | undefined {
  let best: { flow: E2eFlow; score: number } | undefined;
  for (const flow of flows) {
    const score = overlapScore(flow.files, files);
    if (!best || score > best.score) {
      best = { flow, score };
    }
  }
  return best && best.score > 0 ? best.flow : flows[0];
}

function domainIdsForFiles(files: string[], domains: DomainDefinition[]): string[] {
  return domains
    .filter((domain) =>
      files.some((file) => domain.files.some((pattern) => fileMatchesPattern(file, pattern))) ||
      files.some((file) => normalizeToken(file).includes(domain.id)),
    )
    .map((domain) => domain.id)
    .slice(0, 4);
}

function dedupeDomains(domains: DomainDefinition[]): DomainDefinition[] {
  const seen = new Set<string>();
  const result: DomainDefinition[] = [];
  for (const domain of domains) {
    if (seen.has(domain.id)) {
      continue;
    }
    seen.add(domain.id);
    result.push(domain);
  }
  return result;
}

function dedupeFlows(flows: CoreFlowDefinition[]): CoreFlowDefinition[] {
  const seen = new Set<string>();
  const result: CoreFlowDefinition[] = [];
  for (const flow of flows) {
    if (seen.has(flow.id)) {
      continue;
    }
    seen.add(flow.id);
    result.push(flow);
  }
  return result;
}

function domainFilePattern(file: string): string {
  const segments = file.split("/");
  const anchors = ["features", "domains", "modules", "pages", "app", "routes", "screens", "services", "entities", "packages", "apps"];
  for (const anchor of anchors) {
    const index = segments.lastIndexOf(anchor);
    if (index >= 0) {
      const nextSegment = meaningfulSegmentAfter(segments, index);
      if (nextSegment) {
        const nextIndex = segments.indexOf(nextSegment, index + 1);
        return `${segments.slice(0, nextIndex + 1).join("/")}/**`;
      }
    }
  }
  const directory = path.posix.dirname(file);
  return directory === "." || directory === "src" ? file : `${directory}/**`;
}

function meaningfulSegmentAfter(segments: string[], index: number): string | undefined {
  for (const segment of segments.slice(index + 1)) {
    const normalized = normalizeToken(segment.replace(/\.[^.]+$/g, ""));
    if (normalized && !ignoredPathSegments.has(normalized) && !/^\[.+\]$/.test(segment) && !/^\(.+\)$/.test(segment)) {
      return segment;
    }
  }
  return undefined;
}

function routeFromFile(file: string): string | undefined {
  const segments = file.split("/");
  const rootIndex = Math.max(segments.lastIndexOf("app"), segments.lastIndexOf("pages"), segments.lastIndexOf("routes"));
  if (rootIndex < 0) {
    return undefined;
  }
  const routeSegments = segments.slice(rootIndex + 1).map(normalizeRouteSegment).filter(Boolean);
  const visibleSegments = routeSegments.filter((segment) => !["index", "page", "route", "layout"].includes(segment));
  return visibleSegments.length > 0 ? `/${visibleSegments.join("/")}` : "/";
}

function normalizeRouteSegment(segment: string): string {
  const stem = segment
    .replace(/\.(?:d\.)?(?:[cm]?[jt]sx?|vue|svelte|mdx?)$/i, "")
    .replace(/Page$/i, "");
  const dynamic = stem.match(/^\[([^[\].]+)\]$/)?.[1];
  if (dynamic) {
    return `:${normalizeRouteParam(dynamic)}`;
  }
  if (/^\([^)]*\)$/.test(stem) || stem.startsWith("_")) {
    return "";
  }
  return slugify(stem);
}

function normalizeRouteParam(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_$]+/g, "");
  return normalized || "param";
}

function overlaps(left: string[], right: string[]): boolean {
  return overlapScore(left, right) > 0;
}

function overlapScore(left: string[], right: string[]): number {
  let score = 0;
  for (const leftFile of left) {
    for (const rightFile of right) {
      if (leftFile === rightFile || leftFile.endsWith(`/${rightFile}`) || rightFile.endsWith(`/${leftFile}`)) {
        score += 3;
      } else if (path.posix.dirname(leftFile) === path.posix.dirname(rightFile)) {
        score += 1;
      }
    }
  }
  return score;
}

function manifestRelativeFile(plan: E2ePlanResult, file: string): string {
  if (!plan.workspaceRoot) {
    return file;
  }
  const packagePrefix = toPosixPath(path.relative(plan.workspaceRoot, plan.root));
  if (!packagePrefix || packagePrefix.startsWith("..") || path.isAbsolute(packagePrefix)) {
    return file;
  }
  return toPosixPath(path.posix.join(packagePrefix, file));
}

function localRelativeFile(plan: E2ePlanResult, manifestFile: string): string {
  if (!plan.workspaceRoot) {
    return manifestFile;
  }
  const packagePrefix = toPosixPath(path.relative(plan.workspaceRoot, plan.root));
  if (!packagePrefix || packagePrefix.startsWith("..") || path.isAbsolute(packagePrefix)) {
    return manifestFile;
  }
  return manifestFile.startsWith(`${packagePrefix}/`) ? manifestFile.slice(packagePrefix.length + 1) : manifestFile;
}

function fileMatchesPattern(file: string, pattern: string): boolean {
  const prefix = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
  return file === prefix || file.startsWith(`${prefix}/`);
}

function durableSubject(title: string): string | undefined {
  const cleaned = title
    .replace(/\b(?:ui smoke flow|api contract smoke checklist|api contract smoke flow|state transition flow|workflow smoke checklist|workflow smoke flow|configuration verification checklist|configuration verification flow|content and theme smoke flow)\b/gi, "")
    .trim();
  return cleaned.length > 1 ? titleCase(cleaned) : undefined;
}

function isBehaviorFile(file: string): boolean {
  return (
    !/(?:^|\/)(?:__tests__|tests?|specs?|e2e)\//i.test(file) &&
    !/(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/i.test(file) &&
    !/(?:^|\/)(?:docs?|\.github)\//i.test(file) &&
    !/(?:^|\/)(?:README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT|SECURITY)\.md$/i.test(file) &&
    !/(?:^|\/)(?:package|tsconfig|codeward\.config)\.json$/i.test(file)
  );
}

function slugify(value: string): string {
  const slug = value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "suggested-flow";
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function titleCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}

const ignoredPathSegments = new Set([
  "api",
  "app",
  "apps",
  "component",
  "components",
  "index",
  "layout",
  "page",
  "pages",
  "route",
  "routes",
  "screen",
  "screens",
  "src",
  "ui",
]);

export const defaultSuggestedDomainManifestPath = defaultDomainManifestPath;
export const defaultSuggestedFlowManifestPath = defaultFlowManifestPath;
