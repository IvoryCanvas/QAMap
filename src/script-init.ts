import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./fs.js";

export const qamapPackageName = "@ivorycanvas/qamap";

export const recommendedQaScripts = {
  qa: "qamap qa .",
  "qa:local": "qamap qa . --include-working-tree",
  "qa:run": "qamap qa run .",
  "qa:e2e": "qamap e2e draft . --dry-run",
} as const;

export type QaScriptName = keyof typeof recommendedQaScripts;
export type QaScriptStatus = "created" | "updated" | "unchanged" | "skipped";
export type JavaScriptPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface QaScriptEntry {
  name: QaScriptName;
  command: string;
  status: QaScriptStatus;
  detail: string;
}

export interface QaScriptInitResult {
  root: string;
  packageJsonPath: string;
  packageManager: JavaScriptPackageManager;
  scripts: QaScriptEntry[];
  dependencyPresent: boolean;
  installCommand?: string;
  runCommands: Record<QaScriptName, string>;
}

interface PackageJsonRecord extends Record<string, unknown> {
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
}

export async function initializeQaScripts(
  rootInput: string,
  options: { force?: boolean } = {},
): Promise<QaScriptInitResult> {
  const root = path.resolve(rootInput);
  const packageJsonPath = path.join(root, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    throw new Error(
      `Could not find package.json at ${packageJsonPath}. Short package scripts are available only for JavaScript repositories; use \`qamap qa .\` directly elsewhere.`,
    );
  }

  const raw = await fs.readFile(packageJsonPath, "utf8");
  const packageJson = parsePackageJson(raw, packageJsonPath);
  const scripts = normalizeScripts(packageJson.scripts, packageJsonPath);
  const entries: QaScriptEntry[] = [];
  let changed = false;

  for (const [name, command] of Object.entries(recommendedQaScripts) as Array<[QaScriptName, string]>) {
    const existing = scripts[name];
    if (existing === command) {
      entries.push({ name, command, status: "unchanged", detail: "already configured" });
      continue;
    }
    if (existing !== undefined && !options.force) {
      entries.push({
        name,
        command,
        status: "skipped",
        detail: `kept existing script: ${existing}`,
      });
      continue;
    }

    scripts[name] = command;
    changed = true;
    entries.push({
      name,
      command,
      status: existing === undefined ? "created" : "updated",
      detail: existing === undefined ? "added QAMap shortcut" : "replaced existing script (--force)",
    });
  }

  if (changed) {
    packageJson.scripts = scripts;
    await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, detectIndent(raw))}\n`, "utf8");
  }

  const packageManager = await detectPackageManager(root, packageJson.packageManager);
  const dependencyPresent = hasQamapDependency(packageJson);

  return {
    root,
    packageJsonPath,
    packageManager,
    scripts: entries,
    dependencyPresent,
    installCommand: dependencyPresent ? undefined : installCommandFor(packageManager),
    runCommands: {
      qa: runCommandFor(packageManager, "qa"),
      "qa:local": runCommandFor(packageManager, "qa:local"),
      "qa:run": runCommandFor(packageManager, "qa:run"),
      "qa:e2e": runCommandFor(packageManager, "qa:e2e"),
    },
  };
}

export function formatQaScriptInitReport(result: QaScriptInitResult): string {
  const lines = ["# QAMap Short Commands", ""];
  for (const script of result.scripts) {
    lines.push(`- [${script.status}] \`${script.name}\` -> \`${script.command}\` (${script.detail})`);
  }

  lines.push("");
  if (result.installCommand) {
    lines.push("QAMap is not declared in this package yet. Install it before using the shortcuts:");
    lines.push("");
    lines.push(`  ${result.installCommand}`);
    lines.push("");
  }

  lines.push("Use:");
  lines.push("");
  lines.push(`  ${result.runCommands.qa}          committed changes on the current branch`);
  lines.push(`  ${result.runCommands["qa:local"]}    include uncommitted working-tree changes`);
  lines.push(`  ${result.runCommands["qa:run"]}      run the exact selected repository validation command`);
  lines.push(`  ${result.runCommands["qa:e2e"]}      preview an E2E draft without writing files`);
  lines.push("");
  lines.push("The base branch is inferred. Pass extra QAMap options through the package script when a repository needs an explicit base.");
  lines.push("");
  return lines.join("\n");
}

function parsePackageJson(raw: string, packageJsonPath: string): PackageJsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse package.json at ${packageJsonPath}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`package.json must contain a JSON object: ${packageJsonPath}`);
  }
  return parsed as PackageJsonRecord;
}

function normalizeScripts(value: unknown, packageJsonPath: string): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`package.json scripts must be an object: ${packageJsonPath}`);
  }

  const scripts: Record<string, string> = {};
  for (const [name, command] of Object.entries(value as Record<string, unknown>)) {
    if (typeof command !== "string") {
      throw new Error(`package.json script ${name} must be a string: ${packageJsonPath}`);
    }
    scripts[name] = command;
  }
  return scripts;
}

function detectIndent(raw: string): number | string {
  const match = raw.match(/^([ \t]+)"/m);
  if (!match) {
    return 2;
  }
  return match[1].includes("\t") ? "\t" : Math.max(1, match[1].length);
}

async function detectPackageManager(root: string, declared: unknown): Promise<JavaScriptPackageManager> {
  if (typeof declared === "string") {
    const name = declared.split("@")[0];
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
      return name;
    }
  }
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  if ((await pathExists(path.join(root, "bun.lock"))) || (await pathExists(path.join(root, "bun.lockb")))) {
    return "bun";
  }
  return "npm";
}

function hasQamapDependency(packageJson: PackageJsonRecord): boolean {
  return [packageJson.dependencies, packageJson.devDependencies, packageJson.optionalDependencies].some(
    (group) => Boolean(group && typeof group === "object" && !Array.isArray(group) && qamapPackageName in group),
  );
}

function installCommandFor(packageManager: JavaScriptPackageManager): string {
  if (packageManager === "pnpm") {
    return `pnpm add -D ${qamapPackageName}`;
  }
  if (packageManager === "yarn") {
    return `yarn add -D ${qamapPackageName}`;
  }
  if (packageManager === "bun") {
    return `bun add -d ${qamapPackageName}`;
  }
  return `npm install --save-dev ${qamapPackageName}`;
}

function runCommandFor(packageManager: JavaScriptPackageManager, script: QaScriptName): string {
  if (packageManager === "npm" || packageManager === "bun") {
    return `${packageManager} run ${script}`;
  }
  return `${packageManager} ${script}`;
}
