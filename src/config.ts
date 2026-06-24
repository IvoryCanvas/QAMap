import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./fs.js";
import { isSeverity } from "./severity.js";
import type { CodeWardConfig, ResolvedCodeWardConfig, Severity } from "./types.js";

const configFileNames = ["codeward.config.json", ".codeward.json"];

export const defaultConfigFileName = "codeward.config.json";

export const defaultConfig: CodeWardConfig = {
  $schema: "https://raw.githubusercontent.com/IvoryCanvas/codeward/main/schema/codeward.schema.json",
  failOn: "high",
  ignoreRules: [],
  maxFiles: 2000,
  severity: {},
};

export async function loadConfig(rootInput: string, explicitPath?: string): Promise<ResolvedCodeWardConfig> {
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
    throw new Error(`Could not read CodeWard config at ${configPath}: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse CodeWard config at ${configPath}: ${message}`);
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

function normalizeConfig(value: unknown, configPath: string): CodeWardConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`CodeWard config must be a JSON object: ${configPath}`);
  }

  const record = value as Record<string, unknown>;
  const config: CodeWardConfig = {};

  if (typeof record.$schema === "string") {
    config.$schema = record.$schema;
  }

  if (record.failOn !== undefined) {
    if (typeof record.failOn !== "string" || !isSeverity(record.failOn)) {
      throw new Error(`CodeWard config failOn must be one of: info, low, medium, high`);
    }
    config.failOn = record.failOn;
  }

  if (record.maxFiles !== undefined) {
    const maxFiles = record.maxFiles;
    if (typeof maxFiles !== "number" || !Number.isInteger(maxFiles) || maxFiles < 1) {
      throw new Error("CodeWard config maxFiles must be a positive integer");
    }
    config.maxFiles = maxFiles;
  }

  if (record.ignoreRules !== undefined) {
    if (!Array.isArray(record.ignoreRules) || !record.ignoreRules.every((item) => typeof item === "string")) {
      throw new Error("CodeWard config ignoreRules must be an array of rule ids");
    }
    config.ignoreRules = [...new Set(record.ignoreRules.map((item) => item.toUpperCase()))];
  }

  if (record.severity !== undefined) {
    if (!record.severity || typeof record.severity !== "object" || Array.isArray(record.severity)) {
      throw new Error("CodeWard config severity must be an object of rule id to severity");
    }
    config.severity = normalizeSeverityOverrides(record.severity as Record<string, unknown>);
  }

  return config;
}

function normalizeSeverityOverrides(value: Record<string, unknown>): Record<string, Severity> {
  const overrides: Record<string, Severity> = {};
  for (const [ruleId, severity] of Object.entries(value)) {
    if (typeof severity !== "string" || !isSeverity(severity)) {
      throw new Error(`CodeWard config severity for ${ruleId} must be one of: info, low, medium, high`);
    }
    overrides[ruleId.toUpperCase()] = severity;
  }
  return overrides;
}
