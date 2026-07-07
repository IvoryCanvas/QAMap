import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./fs.js";

interface ProjectSnapshot {
  packageManager?: string;
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
}

export async function generateAgentContext(rootInput: string): Promise<string> {
  const root = path.resolve(rootInput);
  const snapshot = await readProjectSnapshot(root);

  const lines: string[] = [];
  lines.push("# Agent Instructions");
  lines.push("");
  lines.push("These instructions apply to the whole repository.");
  lines.push("");
  lines.push("## Project Snapshot");
  lines.push("");
  lines.push(`- Package manager: ${snapshot.packageManager ?? "unknown"}`);
  if (snapshot.buildCommand) {
    lines.push(`- Build command: \`${snapshot.buildCommand}\``);
  }
  if (snapshot.testCommand) {
    lines.push(`- Test command: \`${snapshot.testCommand}\``);
  }
  if (snapshot.lintCommand) {
    lines.push(`- Lint command: \`${snapshot.lintCommand}\``);
  }
  lines.push("");
  lines.push("## Working Rules");
  lines.push("");
  lines.push("- Keep changes focused on the requested behavior.");
  lines.push("- Prefer existing project patterns over new abstractions.");
  lines.push("- Do not commit generated output, local reports, dependency folders, or environment files.");
  lines.push("- Never create or suggest branches with a `codex/` prefix.");
  lines.push("- Use `feat/`, `fix/`, `refactor/`, `style/`, `hotfix/`, `chore/`, or `docs/` branch prefixes.");
  lines.push("");
  lines.push("## Validation");
  lines.push("");
  if (snapshot.testCommand) {
    lines.push(`- Run \`${snapshot.testCommand}\` before proposing a merge.`);
  } else {
    lines.push("- Add or document a validation command before relying on AI-generated changes.");
  }
  if (snapshot.buildCommand) {
    lines.push(`- Run \`${snapshot.buildCommand}\` when changing build-sensitive code.`);
  }
  if (snapshot.lintCommand) {
    lines.push(`- Run \`${snapshot.lintCommand}\` when changing formatting or lint-sensitive code.`);
  }
  lines.push("");
  lines.push("## Pre-PR QA");
  lines.push("");
  lines.push(`- Before opening a pull request, run \`${dlxCommandFor(snapshot.packageManager)} qa . --base origin/main --head HEAD --format agent\` and address the required evidence and bootstrap items it reports.`);
  lines.push("- Treat the output as QA planning evidence, not as proof that browser, device, or manual QA passed.");
  lines.push("- For UI-affecting changes, review the suggested E2E draft before handing the pull request to a human.");
  lines.push("");
  lines.push("## Repository Boundaries");
  lines.push("");
  lines.push("- Do not push directly to `main`.");
  lines.push("- Do not merge pull requests unless you are a maintainer with explicit repository access.");
  lines.push("- Do not publish packages, rotate secrets, or change CI permissions without maintainer approval.");
  lines.push("");

  return lines.join("\n");
}

async function readProjectSnapshot(root: string): Promise<ProjectSnapshot> {
  const packageJsonPath = path.join(root, "package.json");
  const packageManager = await detectPackageManager(root);

  if (!(await pathExists(packageJsonPath))) {
    return { packageManager };
  }

  try {
    const parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const commandPrefix = commandPrefixFor(packageManager ?? parsed.packageManager);
    return {
      packageManager: packageManager ?? parsed.packageManager,
      testCommand: parsed.scripts?.test ? `${commandPrefix} test` : undefined,
      buildCommand: parsed.scripts?.build ? `${commandPrefix} run build` : undefined,
      lintCommand: parsed.scripts?.lint ? `${commandPrefix} run lint` : undefined,
    };
  } catch {
    return { packageManager };
  }
}

async function detectPackageManager(root: string): Promise<string | undefined> {
  if (await pathExists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await pathExists(path.join(root, "yarn.lock"))) {
    return "yarn";
  }
  if ((await pathExists(path.join(root, "bun.lock"))) || (await pathExists(path.join(root, "bun.lockb")))) {
    return "bun";
  }
  if (await pathExists(path.join(root, "package-lock.json"))) {
    return "npm";
  }
  if (await pathExists(path.join(root, "package.json"))) {
    return "npm";
  }
  return undefined;
}

export async function detectDlxCommand(rootInput: string): Promise<string> {
  const packageManager = await detectPackageManager(path.resolve(rootInput));
  return dlxCommandFor(packageManager);
}

function dlxCommandFor(packageManager: string | undefined): string {
  const normalized = packageManager?.split("@")[0];
  if (normalized === "pnpm") {
    return "pnpm dlx @ivorycanvas/qamap";
  }
  if (normalized === "yarn") {
    return "yarn dlx @ivorycanvas/qamap";
  }
  if (normalized === "bun") {
    return "bunx @ivorycanvas/qamap";
  }
  return "npx @ivorycanvas/qamap";
}

function commandPrefixFor(packageManager: string | undefined): string {
  const normalized = packageManager?.split("@")[0];
  if (normalized === "pnpm") {
    return "pnpm";
  }
  if (normalized === "yarn") {
    return "yarn";
  }
  if (normalized === "bun") {
    return "bun";
  }
  return "npm";
}
