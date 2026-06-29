import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { pathExists, toPosixPath } from "./fs.js";
import type { TestPlanChangedFile } from "./test-plan.js";

export const defaultDomainManifestPath = ".codeward/domains.yml";

export interface DomainScenarioDefinition {
  title: string;
  checks: string[];
}

export interface DomainDefinition {
  id: string;
  name: string;
  description?: string;
  aliases: string[];
  files: string[];
  routes: string[];
  tags: string[];
  scenarios: DomainScenarioDefinition[];
}

export interface DomainManifest {
  path?: string;
  domains: DomainDefinition[];
}

export interface MatchedDomain {
  id: string;
  name: string;
  reason: string;
  matchedFiles: string[];
  matchedSignals: string[];
  aliases: string[];
  routes: string[];
  scenarios: DomainScenarioDefinition[];
}

const domainManifestCandidates = [
  ".codeward/domains.yml",
  ".codeward/domains.yaml",
  ".codeward/domains.json",
];

export async function loadDomainManifest(rootInput: string): Promise<DomainManifest> {
  const root = path.resolve(rootInput);
  const manifestPath = await findDomainManifestPath(root);
  if (!manifestPath) {
    return { domains: [] };
  }

  const raw = await fs.readFile(manifestPath, "utf8");
  const parsed = parseDomainManifest(raw, manifestPath);
  return {
    path: toPosixPath(path.relative(root, manifestPath)),
    domains: normalizeDomains(parsed, manifestPath),
  };
}

export function matchDomains(
  manifest: DomainManifest,
  changedFiles: TestPlanChangedFile[],
): MatchedDomain[] {
  if (manifest.domains.length === 0 || changedFiles.length === 0) {
    return [];
  }

  const files = changedFiles.map((file) => file.path);
  return manifest.domains
    .map((domain) => matchDomain(domain, files))
    .filter((domain): domain is MatchedDomain => Boolean(domain))
    .sort((left, right) => right.matchedFiles.length + right.matchedSignals.length - (left.matchedFiles.length + left.matchedSignals.length))
    .slice(0, 12);
}

export async function writeDefaultDomainManifest(
  rootInput: string,
  fileName = defaultDomainManifestPath,
  force = false,
): Promise<string> {
  const root = path.resolve(rootInput);
  const outputPath = path.resolve(root, fileName);
  if (!force && (await pathExists(outputPath))) {
    throw new Error(`Refusing to overwrite ${outputPath}. Pass --force to replace it.`);
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, defaultDomainManifestText(), "utf8");
  return outputPath;
}

function matchDomain(domain: DomainDefinition, changedFiles: string[]): MatchedDomain | undefined {
  const matchedFiles = new Set<string>();
  const matchedSignals = new Set<string>();
  const domainTokens = [domain.id, domain.name, ...domain.aliases].map(normalizeToken).filter(Boolean);

  for (const file of changedFiles) {
    if (domain.files.some((pattern) => matchesPathPattern(file, pattern))) {
      matchedFiles.add(file);
      matchedSignals.add("file pattern");
    }
    const fileTokens = pathTokens(file);
    for (const token of domainTokens) {
      if (fileTokens.includes(token)) {
        matchedFiles.add(file);
        matchedSignals.add(`domain:${token}`);
      }
    }
    for (const route of domain.routes) {
      const routeSignal = normalizeRoute(route);
      if (routeSignal && normalizePathForMatch(file).includes(routeSignal)) {
        matchedFiles.add(file);
        matchedSignals.add(`route:${route}`);
      }
    }
    for (const tag of domain.tags) {
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
    id: domain.id,
    name: domain.name,
    reason: `Changed files match ${signals.slice(0, 4).join(", ")} for this declared domain.`,
    matchedFiles: [...matchedFiles].slice(0, 20),
    matchedSignals: signals.slice(0, 12),
    aliases: domain.aliases.slice(0, 10),
    routes: domain.routes.slice(0, 10),
    scenarios: domain.scenarios.slice(0, 6),
  };
}

function parseDomainManifest(raw: string, manifestPath: string): unknown {
  try {
    if (/\.json$/i.test(manifestPath)) {
      return JSON.parse(raw);
    }
    return YAML.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse CodeWard domain manifest at ${manifestPath}: ${message}`);
  }
}

function normalizeDomains(value: unknown, manifestPath: string): DomainDefinition[] {
  const record = asRecord(value, `CodeWard domain manifest must be an object: ${manifestPath}`);
  const rawDomains = record.domains;
  if (!Array.isArray(rawDomains)) {
    throw new Error(`CodeWard domain manifest domains must be an array: ${manifestPath}`);
  }
  return rawDomains.map((domain, index) => normalizeDomain(domain, manifestPath, index));
}

function normalizeDomain(value: unknown, manifestPath: string, index: number): DomainDefinition {
  const record = asRecord(value, `CodeWard domain manifest domain at index ${index} must be an object: ${manifestPath}`);
  const id = readRequiredString(record, "id", manifestPath, index);
  const name = readOptionalString(record, "name") ?? readOptionalString(record, "title") ?? id;
  const aliases = readStringArray(record, "aliases");
  const files = readStringArray(record, "files");
  const routes = readStringArray(record, "routes");
  const tags = readStringArray(record, "tags");
  const scenarios = readScenarioArray(record, "scenarios", manifestPath, index);

  if (files.length + aliases.length + routes.length + tags.length === 0) {
    throw new Error(
      `CodeWard domain manifest domain ${id} must include at least one of aliases, files, routes, or tags: ${manifestPath}`,
    );
  }

  return {
    id,
    name,
    description: readOptionalString(record, "description"),
    aliases,
    files,
    routes,
    tags,
    scenarios,
  };
}

async function findDomainManifestPath(root: string): Promise<string | undefined> {
  for (const candidate of domainManifestCandidates) {
    const absolutePath = path.join(root, candidate);
    if (await pathExists(absolutePath)) {
      return absolutePath;
    }
  }
  return undefined;
}

function readScenarioArray(
  record: Record<string, unknown>,
  key: string,
  manifestPath: string,
  domainIndex: number,
): DomainScenarioDefinition[] {
  const value = record[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item, index) => normalizeScenario(item, manifestPath, domainIndex, index))
    .filter((item): item is DomainScenarioDefinition => Boolean(item));
}

function normalizeScenario(
  value: unknown,
  manifestPath: string,
  domainIndex: number,
  scenarioIndex: number,
): DomainScenarioDefinition | undefined {
  if (typeof value === "string") {
    const title = value.trim();
    return title ? { title, checks: [] } : undefined;
  }
  const record = asRecord(
    value,
    `CodeWard domain manifest scenario at domain ${domainIndex}, index ${scenarioIndex} must be a string or object: ${manifestPath}`,
  );
  const title = readOptionalString(record, "title") ?? readOptionalString(record, "name");
  if (!title) {
    throw new Error(
      `CodeWard domain manifest scenario at domain ${domainIndex}, index ${scenarioIndex} is missing title: ${manifestPath}`,
    );
  }
  return {
    title,
    checks: readStringArray(record, "checks"),
  };
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
    throw new Error(`CodeWard domain manifest domain at index ${index} is missing ${key}: ${manifestPath}`);
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

function defaultDomainManifestText(): string {
  return [
    "# Commit this file when your team wants CodeWard to know product/domain language.",
    "domains:",
    "  - id: billing",
    "    name: Billing",
    "    aliases:",
    "      - checkout",
    "      - subscription",
    "    files:",
    "      - src/features/billing/**",
    "    routes:",
    "      - /billing",
    "    tags: []",
    "    scenarios:",
    "      - title: Billing primary journey",
    "        checks:",
    "          - Start from the normal billing entry point.",
    "          - Complete the primary billing action with realistic data.",
    "          - Confirm the visible result or saved state.",
    "",
  ].join("\n");
}
