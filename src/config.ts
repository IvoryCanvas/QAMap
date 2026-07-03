import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./fs.js";
import { isSeverity } from "./severity.js";
import type { QAMapConfig, ResolvedQAMapConfig, Severity } from "./types.js";

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
