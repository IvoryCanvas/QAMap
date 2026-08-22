import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./fs.js";
import { isSeverity } from "./severity.js";
import type { QAMapConfig, QAMapExecutorConfig, QAMapExecutorRunner, QAMapFixtureDeclaration, ResolvedQAMapConfig, Severity } from "./types.js";

const configFileNames = ["qamap.config.json", ".qamap.json"];

export const defaultConfigFileName = "qamap.config.json";

export const defaultConfig: QAMapConfig = {
  $schema: "https://raw.githubusercontent.com/IvoryCanvas/qamap/main/schema/qamap.schema.json",
  failOn: "high",
  ignoreRules: [],
  maxFiles: 2000,
  severity: {},
  validationCommands: [],
};

export async function loadConfig(rootInput: string, explicitPath?: string): Promise<ResolvedQAMapConfig> {
  const root = path.resolve(rootInput);
  const configPath = explicitPath ? path.resolve(root, explicitPath) : await findConfigPath(root);

  if (!configPath) {
    return { config: {} };
  }

  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read QAMap config at ${configPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse QAMap config at ${configPath}: ${message}`);
  }

  return {
    path: configPath,
    config: normalizeConfig(parsed, configPath),
  };
}

export async function writeDefaultConfig(rootInput: string, fileName = defaultConfigFileName, force = false): Promise<string> {
  const root = path.resolve(rootInput);
  const outputPath = path.resolve(root, fileName);
  if (!force && (await pathExists(outputPath))) {
    throw new Error(`Refusing to overwrite ${outputPath}. Pass --force to replace it.`);
  }

  const text = `${JSON.stringify(defaultConfig, null, 2)}\n`;
  await fs.writeFile(outputPath, text, "utf8");
  return outputPath;
}

async function findConfigPath(root: string): Promise<string | undefined> {
  for (const fileName of configFileNames) {
    const candidate = path.join(root, fileName);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeConfig(value: unknown, configPath: string): QAMapConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`QAMap config must be a JSON object: ${configPath}`);
  }

  const record = value as Record<string, unknown>;
  const config: QAMapConfig = {};

  if (typeof record.$schema === "string") {
    config.$schema = record.$schema;
  }

  if (record.failOn !== undefined) {
    if (typeof record.failOn !== "string" || !isSeverity(record.failOn)) {
      throw new Error(`QAMap config failOn must be one of: info, low, medium, high`);
    }
    config.failOn = record.failOn;
  }

  if (record.maxFiles !== undefined) {
    const maxFiles = record.maxFiles;
    if (typeof maxFiles !== "number" || !Number.isInteger(maxFiles) || maxFiles < 1) {
      throw new Error("QAMap config maxFiles must be a positive integer");
    }
    config.maxFiles = maxFiles;
  }

  if (record.ignoreRules !== undefined) {
    if (!Array.isArray(record.ignoreRules) || !record.ignoreRules.every((item) => typeof item === "string")) {
      throw new Error("QAMap config ignoreRules must be an array of rule ids");
    }
    config.ignoreRules = [...new Set(record.ignoreRules.map((item) => item.toUpperCase()))];
  }

  if (record.severity !== undefined) {
    if (!record.severity || typeof record.severity !== "object" || Array.isArray(record.severity)) {
      throw new Error("QAMap config severity must be an object of rule id to severity");
    }
    config.severity = normalizeSeverityOverrides(record.severity as Record<string, unknown>);
  }

  if (record.executors !== undefined) {
    config.executors = normalizeExecutors(record.executors);
  }

  if (record.fixtures !== undefined) {
    config.fixtures = normalizeFixtures(record.fixtures);
  }

  if (record.scenarioFixtures !== undefined) {
    config.scenarioFixtures = normalizeScenarioFixtures(record.scenarioFixtures, config.fixtures ?? {});
  }

  if (record.validationCommands !== undefined) {
    if (
      !Array.isArray(record.validationCommands) ||
      !record.validationCommands.every((item) => typeof item === "string" && item.trim().length > 0)
    ) {
      throw new Error("QAMap config validationCommands must be an array of non-empty strings");
    }
    config.validationCommands = [...new Set(record.validationCommands.map((item) => item.trim()))];
  }

  return config;
}

function normalizeSeverityOverrides(value: Record<string, unknown>): Record<string, Severity> {
  const overrides: Record<string, Severity> = {};
  for (const [ruleId, severity] of Object.entries(value)) {
    if (typeof severity !== "string" || !isSeverity(severity)) {
      throw new Error(`QAMap config severity for ${ruleId} must be one of: info, low, medium, high`);
    }
    overrides[ruleId.toUpperCase()] = severity;
  }
  return overrides;
}

const executorRunners = new Set(["playwright", "command"]);
const executorTokenPattern = /\{(file|grep|scenarioId|fixtureDir|artifactDir)\}/g;

function normalizeCommandArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    throw new Error(`QAMap config ${label} must be a non-empty array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function normalizeOptionalTimeout(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1_000) {
    throw new Error(`QAMap config ${label} must be an integer of at least 1000`);
  }
  return value;
}

function normalizeExecutors(value: unknown): Record<string, QAMapExecutorConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("QAMap config executors must be an object of executor name to executor");
  }
  const executors: Record<string, QAMapExecutorConfig> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`QAMap config executor name must be lowercase letters, digits, or dashes: ${name}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`QAMap config executor ${name} must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    if (typeof entry.runner !== "string" || !executorRunners.has(entry.runner)) {
      throw new Error(`QAMap config executor ${name} runner must be playwright or command`);
    }
    const command = normalizeCommandArray(entry.command, `executor ${name} command`);
    // A file token is what lets the executor target one draft; without it every run would execute everything.
    if (!command.some((item) => /\{file\}/.test(item))) {
      throw new Error(`QAMap config executor ${name} command must reference {file}`);
    }
    for (const item of command) {
      for (const match of item.matchAll(/\{([^}]*)\}/g)) {
        if (!`{${match[1]}}`.match(executorTokenPattern)) {
          throw new Error(`QAMap config executor ${name} command uses unknown token {${match[1]}}`);
        }
      }
    }
    if (entry.cwd !== undefined && (typeof entry.cwd !== "string" || entry.cwd.trim().length === 0)) {
      throw new Error(`QAMap config executor ${name} cwd must be a non-empty string`);
    }
    if (entry.artifactDirectory !== undefined && (typeof entry.artifactDirectory !== "string" || entry.artifactDirectory.trim().length === 0)) {
      throw new Error(`QAMap config executor ${name} artifactDirectory must be a non-empty string`);
    }
    if (entry.env !== undefined) {
      if (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env) ||
        !Object.values(entry.env as Record<string, unknown>).every((item) => typeof item === "string")) {
        throw new Error(`QAMap config executor ${name} env must be an object of string values`);
      }
    }
    executors[name] = {
      runner: entry.runner as QAMapExecutorRunner,
      command,
      ...(entry.cwd !== undefined ? { cwd: (entry.cwd as string).trim() } : {}),
      ...(entry.timeoutMs !== undefined ? { timeoutMs: normalizeOptionalTimeout(entry.timeoutMs, `executor ${name} timeoutMs`) } : {}),
      ...(entry.artifactDirectory !== undefined ? { artifactDirectory: (entry.artifactDirectory as string).trim() } : {}),
      ...(entry.env !== undefined ? { env: { ...(entry.env as Record<string, string>) } } : {}),
    };
  }
  return executors;
}

function normalizeFixtures(value: unknown): Record<string, QAMapFixtureDeclaration> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("QAMap config fixtures must be an object of fixture id to declaration");
  }
  const fixtures: Record<string, QAMapFixtureDeclaration> = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) {
      throw new Error(`QAMap config fixture id must be lowercase letters, digits, or dashes: ${id}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`QAMap config fixture ${id} must be an object`);
    }
    const entry = raw as Record<string, unknown>;
    const description = entry.description === undefined ? undefined : String(entry.description);
    if (entry.kind === "file") {
      if (typeof entry.path !== "string" || entry.path.trim().length === 0) {
        throw new Error(`QAMap config fixture ${id} path must be a non-empty string`);
      }
      if (entry.target !== undefined && (typeof entry.target !== "string" || entry.target.trim().length === 0)) {
        throw new Error(`QAMap config fixture ${id} target must be a non-empty string`);
      }
      fixtures[id] = {
        kind: "file",
        path: entry.path.trim(),
        ...(entry.target !== undefined ? { target: (entry.target as string).trim() } : {}),
        ...(description !== undefined ? { description } : {}),
      };
      continue;
    }
    if (entry.kind === "seed") {
      fixtures[id] = {
        kind: "seed",
        command: normalizeCommandArray(entry.command, `fixture ${id} command`),
        ...(entry.cwd !== undefined ? { cwd: String(entry.cwd).trim() } : {}),
        ...(entry.timeoutMs !== undefined ? { timeoutMs: normalizeOptionalTimeout(entry.timeoutMs, `fixture ${id} timeoutMs`) } : {}),
        ...(description !== undefined ? { description } : {}),
      };
      continue;
    }
    throw new Error(`QAMap config fixture ${id} kind must be file or seed`);
  }
  return fixtures;
}

function normalizeScenarioFixtures(
  value: unknown,
  fixtures: Record<string, QAMapFixtureDeclaration>,
): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("QAMap config scenarioFixtures must be an object of scenario id to fixture ids");
  }
  const bindings: Record<string, string[]> = {};
  for (const [scenarioId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^scenario:[a-f0-9]{6,}$/.test(scenarioId)) {
      throw new Error(`QAMap config scenarioFixtures key must be a scenario id: ${scenarioId}`);
    }
    if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string" && item.trim().length > 0)) {
      throw new Error(`QAMap config scenarioFixtures ${scenarioId} must be an array of fixture ids`);
    }
    const ids = [...new Set(raw.map((item) => item.trim()))];
    for (const id of ids) {
      if (!fixtures[id]) {
        throw new Error(`QAMap config scenarioFixtures ${scenarioId} references unknown fixture ${id}`);
      }
    }
    bindings[scenarioId] = ids;
  }
  return bindings;
}
