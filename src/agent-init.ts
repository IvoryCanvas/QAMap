import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectDlxCommand } from "./context.js";
import { pathExists } from "./fs.js";
import { writeDefaultConfig } from "./config.js";

export type AgentInitFileStatus = "created" | "updated" | "unchanged" | "skipped";

export interface AgentInitFile {
  path: string;
  status: AgentInitFileStatus;
  detail: string;
}

export interface AgentInitResult {
  root: string;
  files: AgentInitFile[];
  nextCommand: string;
}

const SECTION_START = "<!-- qamap:agent:start -->";
const SECTION_END = "<!-- qamap:agent:end -->";
const SKILL_RELATIVE_PATH = path.join("skills", "qamap-pr-qa", "SKILL.md");
const SKILL_TARGET_RELATIVE_PATH = path.join(".claude", "skills", "qamap-pr-qa", "SKILL.md");

export async function initAgentSetup(rootInput: string, options: { force?: boolean } = {}): Promise<AgentInitResult> {
  const root = path.resolve(rootInput);
  const dlxCommand = await detectDlxCommand(root);
  const nextCommand = `${dlxCommand} qa . --base origin/main --head HEAD --format agent`;

  const files: AgentInitFile[] = [];
  files.push(await upsertAgentsSection(root, dlxCommand));
  files.push(await copyPackagedSkill(root, options.force ?? false));
  files.push(await ensureDefaultConfig(root));

  return { root, files, nextCommand };
}

export function buildAgentQaSection(dlxCommand: string): string {
  return [
    SECTION_START,
    "## Pre-PR QA (QAMap)",
    "",
    "Before opening or updating a pull request, run this local, token-free QA pass:",
    "",
    "```sh",
    `${dlxCommand} qa . --base origin/main --head HEAD --format agent`,
    "```",
    "",
    "- Read `intents[].scenarios[].sources` first: each accepted scenario should point to a commit or exact diff file and line.",
    "- Address every `requiredEvidence` item before handing the pull request to a human.",
    "- Treat `automation` as opt-in. Generate or set up an E2E adapter only after the scenario and source evidence are accepted.",
    "- Treat the result as QA planning evidence, not as proof that browser, device, or manual QA passed.",
    "- The full agent workflow lives in `.claude/skills/qamap-pr-qa/SKILL.md` when installed via `qamap init --agent`.",
    SECTION_END,
  ].join("\n");
}

async function upsertAgentsSection(root: string, dlxCommand: string): Promise<AgentInitFile> {
  const agentsPath = path.join(root, "AGENTS.md");
  const relativePath = "AGENTS.md";
  const section = buildAgentQaSection(dlxCommand);

  if (!(await pathExists(agentsPath))) {
    const content = `# Agent Instructions\n\n${section}\n`;
    await fs.writeFile(agentsPath, content, "utf8");
    return { path: relativePath, status: "created", detail: "created with the QAMap Pre-PR QA section" };
  }

  const existing = await fs.readFile(agentsPath, "utf8");
  const startIndex = existing.indexOf(SECTION_START);
  const endIndex = existing.indexOf(SECTION_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const updated = existing.slice(0, startIndex) + section + existing.slice(endIndex + SECTION_END.length);
    if (updated === existing) {
      return { path: relativePath, status: "unchanged", detail: "QAMap section already up to date" };
    }
    await fs.writeFile(agentsPath, updated, "utf8");
    return { path: relativePath, status: "updated", detail: "refreshed the QAMap Pre-PR QA section in place" };
  }

  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await fs.writeFile(agentsPath, `${existing}${separator}${section}\n`, "utf8");
  return { path: relativePath, status: "updated", detail: "appended the QAMap Pre-PR QA section; existing content untouched" };
}

async function copyPackagedSkill(root: string, force: boolean): Promise<AgentInitFile> {
  const sourcePath = path.join(packageRoot(), SKILL_RELATIVE_PATH);
  const targetPath = path.join(root, SKILL_TARGET_RELATIVE_PATH);
  const relativePath = SKILL_TARGET_RELATIVE_PATH;

  const skillContent = await fs.readFile(sourcePath, "utf8");

  if (await pathExists(targetPath)) {
    const existing = await fs.readFile(targetPath, "utf8");
    if (existing === skillContent) {
      return { path: relativePath, status: "unchanged", detail: "packaged skill already installed" };
    }
    if (!force) {
      return { path: relativePath, status: "skipped", detail: "differs from the packaged skill; pass --force to replace it" };
    }
    await fs.writeFile(targetPath, skillContent, "utf8");
    return { path: relativePath, status: "updated", detail: "replaced with the packaged skill (--force)" };
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, skillContent, "utf8");
  return { path: relativePath, status: "created", detail: "installed the packaged QAMap PR QA skill" };
}

async function ensureDefaultConfig(root: string): Promise<AgentInitFile> {
  const configPath = path.join(root, "qamap.config.json");
  if (await pathExists(configPath)) {
    return { path: "qamap.config.json", status: "unchanged", detail: "existing config kept" };
  }
  await writeDefaultConfig(root, "qamap.config.json", false);
  return { path: "qamap.config.json", status: "created", detail: "default config written" };
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function formatAgentInitReport(result: AgentInitResult): string {
  const lines: string[] = [];
  lines.push("# QAMap Agent Setup");
  lines.push("");
  for (const file of result.files) {
    lines.push(`- [${file.status}] \`${file.path}\` — ${file.detail}`);
  }
  lines.push("");
  lines.push("Agents that read `AGENTS.md` (or the installed skill) will now run QAMap before handing off a pull request.");
  lines.push("");
  lines.push("Try it yourself:");
  lines.push("");
  lines.push(`  ${result.nextCommand}`);
  return lines.join("\n");
}
