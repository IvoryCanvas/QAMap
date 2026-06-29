import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { pathExists, toPosixPath } from "./fs.js";
import type { TestPlanChangedFile } from "./test-plan.js";

export const defaultFlowManifestPath = ".codeward/flows.yml";

export type CoreFlowPriority = "critical" | "recommended" | "optional";

export interface CoreFlowDefinition {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  priority: CoreFlowPriority;
  domains: string[];
  files: string[];
  routes: string[];
  tags: string[];
  checks: string[];
}

export interface CoreFlowManifest {
  path?: string;
  flows: CoreFlowDefinition[];
}

export interface MatchedCoreFlow {
  id: string;
  name: string;
  priority: CoreFlowPriority;
  reason: string;
  matchedFiles: string[];
  matchedSignals: string[];
  routes: string[];
  checks: string[];
}

const flowManifestCandidates = [
  ".codeward/flows.yml",
  ".codeward/flows.yaml",
  ".codeward/flows.json",
];

const priorityWeights: Record<CoreFlowPriority, number> = {
  critical: 3,
  recommended: 2,
  optional: 1,
};

export async function loadCoreFlowManifest(rootInput: string): Promise<CoreFlowManifest> {
  const root = path.resolve(rootInput);
  const manifestPath = await findFlowManifestPath(root);
  if (!manifestPath) {
    return { flows: [] };
  }

  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = parseFlowManifest(raw, manifestPath);
  return {
    path: toPosixPath(path.relative(root, manifestPath)),
    flows: normalizeCoreFlows(parsed, manifestPath),
  };
}

export function matchCoreFlows(
  manifest: CoreFlowManifest,
  changedFiles: TestPlanChangedFile[],
): MatchedCoreFlow[] {
  if (manifest.flows.length === 0 || changedFiles.length === 0) {
    return [];
  }

  const files = changedFiles.map((file) => file.path);
  return manifest.flows
    .map((flow) => matchCoreFlow(flow, files))
    .filter((flow): flow is MatchedCoreFlow => Boolean(flow))
    .sort((left, right) => {
      const priorityDiff = priorityWeights[right.priority] - priorityWeights[left.priority];
      if (priorityDiff !== 0) {
        return priorityDiff;
      }
      return right.matchedFiles.length + right.matchedSignals.length - (left.matchedFiles.length + left.matchedSignals.length);
    })
    .slice(0, 10);
}

export async function writeDefaultCoreFlowManifest(
  rootInput: string,
  fileName = defaultFlowManifestPath,
  force = false,
): Promise<string> {
  const root = path.resolve(rootInput);
  const outputPath = path.resolve(root, fileName);
  if (!force && (await pathExists(outputPath))) {
    throw new Error(`Refusing to overwrite ${outputPath}. Pass --force to replace it.`);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, defaultCoreFlowManifestText(), "utf8");
  return outputPath;
}

function matchCoreFlow(flow: CoreFlowDefinition, changedFiles: string[]): MatchedCoreFlow | undefined {
  const matchedFiles = new Set<string>();
  const matchedSignals = new Set<string>();

  for (const file of changedFiles) {
    if (flow.files.some((pattern) => matchesPathPattern(file, pattern))) {
      matchedFiles.add(file);
      matchedSignals.add("file pattern");
    }
    const fileTokens = pathTokens(file);
    for (const domain of flow.domains) {
      const normalizedDomain = normalizeToken(domain);
      if (normalizedDomain && fileTokens.includes(normalizedDomain)) {
        matchedFiles.add(file);
        matchedSignals.add(`domain:${domain}`);
      }
    }
    for (const route of flow.routes) {
      const routeSignal = normalizeRoute(route);
      if (routeSignal && normalizePathForMatch(file).includes(routeSignal)) {
        matchedFiles.add(file);
        matchedSignals.add(`route:${route}`);
      }
    }
    for (const tag of flow.tags) {
      const normalizedTag = normalizeToken(tag);
      if (normalizedTag && fileTokens.includes(normalizedTag)) {
        matchedFiles.add(file);
        matchedSignals.add(`tag:${tag}`);
      }
    }
  }

  if (matchedFiles.size === 0) {
    return undefined;
  }

  const signals = [...matchedSignals];
  return {
    id: flow.id,
    name: flow.name,
    priority: flow.priority,
    reason: `Changed files match ${signals.slice(0, 4).join(", ")} for this declared core flow.`,
    matchedFiles: [...matchedFiles].slice(0, 20),
    matchedSignals: signals.slice(0, 12),
    routes: flow.routes.slice(0, 10),
    checks: flow.checks.slice(0, 10),
  };
}

function parseFlowManifest(raw: string, manifestPath: string): unknown {
  try {
    if (/\.json$/i.test(manifestPath)) {
      return JSON.parse(raw);
    }
    return YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse CodeWard flow manifest at ${manifestPath}: ${message}`);
  }
}

function normalizeCoreFlows(value: unknown, manifestPath: string): CoreFlowDefinition[] {
  const record = asRecord(value, `CodeWard flow manifest must be an object: ${manifestPath}`);
  const rawFlows = record.flows;
  if (!Array.isArray(rawFlows)) {
    throw new Error(`CodeWard flow manifest flows must be an array: ${manifestPath}`);
  }
  return rawFlows.map((flow, index) => normalizeCoreFlow(flow, manifestPath, index));
}

function normalizeCoreFlow(value: unknown, manifestPath: string, index: number): CoreFlowDefinition {
  const record = asRecord(value, `CodeWard flow manifest flow at index ${index} must be an object: ${manifestPath}`);
  const id = readRequiredString(record, "id", manifestPath, index);
  const name = readOptionalString(record, "name") ?? readOptionalString(record, "title") ?? id;
  const priority = normalizePriority(readOptionalString(record, "priority") ?? "recommended", manifestPath, index);
  const files = readStringArray(record, "files");
  const domains = readStringArray(record, "domains");
  const routes = readStringArray(record, "routes");
  const tags = readStringArray(record, "tags");
  const checks = readStringArray(record, "checks");

  if (files.length + domains.length + routes.length + tags.length === 0) {
    throw new Error(
      `CodeWard flow manifest flow ${id} must include at least one of files, domains, routes, or tags: ${manifestPath}`,
    );
  }

  return {
    id,
    name,
    description: readOptionalString(record, "description"),
    owner: readOptionalString(record, "owner"),
    priority,
    domains,
    files,
    routes,
    tags,
    checks,
  };
}

async function findFlowManifestPath(root: string): Promise<string | undefined> {
  for (const candidate of flowManifestCandidates) {
    const absolutePath = path.join(root, candidate);
    if (await pathExists(absolutePath)) {
      return absolutePath;
    }
  }
  return undefined;
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

function pathTokens(file: string): string[] {
  return file
    .replace(/\.[^.\/]+$/g, "")
    .split("/")
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^a-zA-Z0-9]+/))
    .map(normalizeToken)
    .filter(Boolean);
}

function normalizeRoute(route: string): string {
  return normalizePathForMatch(route).replace(/^\//, "");
}

function normalizePathForMatch(value: string): string {
  return toPosixPath(value).replace(/^\.\/+/, "").replace(/\/+$/g, "").toLowerCase();
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    throw new Error(`CodeWard flow manifest flow at index ${index} is missing ${key}: ${manifestPath}`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function normalizePriority(value: string, manifestPath: string, index: number): CoreFlowPriority {
  if (value === "critical" || value === "recommended" || value === "optional") {
    return value;
  }
  throw new Error(
    `CodeWard flow manifest flow at index ${index} has invalid priority ${value}; expected critical, recommended, or optional: ${manifestPath}`,
  );
}

function defaultCoreFlowManifestText(): string {
  return [
    "# Commit this file when your team wants CodeWard to know the flows humans care about.",
    "flows:",
    "  - id: primary-success-path",
    "    name: Primary success path",
    "    priority: critical",
    "    domains: []",
    "    files:",
    "      - src/**",
    "    routes: []",
    "    tags: []",
    "    checks:",
    "      - Verify the happy path from entry point to completion.",
    "      - Verify one realistic failure, empty, or blocked state.",
    "",
  ].join("\n");
}
