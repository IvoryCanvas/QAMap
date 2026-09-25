import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectDlxCommand } from "./context.js";
import { pathExists } from "./fs.js";
import { writeDefaultConfig } from "./config.js";
import { AGENT_SECTION_START as SECTION_START, AGENT_SECTION_END as SECTION_END, ASK_REVIEW_MARKER, REPORT_REVIEW_MARKER, buildAgentQaSection, type AgentReviewMode } from "./agent-instructions.js";

export { buildAgentQaSection } from "./agent-instructions.js";

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

const SKILL_RELATIVE_ROOT = path.join("skills", "qamap-pr-qa");
const SKILL_BUNDLE_FILES = [
  "SKILL.md",
  path.join("agents", "openai.yaml"),
  path.join("references", "advanced-workflow.md"),
];
const SKILL_TARGET_RELATIVE_PATHS = [
  path.join(".agents", "skills", "qamap-pr-qa"),
  path.join(".claude", "skills", "qamap-pr-qa"),
];

export async function initAgentSetup(rootInput: string, options: { force?: boolean; reviewMode?: AgentReviewMode } = {}): Promise<AgentInitResult> {
  if (options.reviewMode !== undefined && options.reviewMode !== "ask" && options.reviewMode !== "report") throw new Error("Invalid review mode");
  const root = path.resolve(rootInput);
  const dlxCommand = await detectDlxCommand(root);
  const nextCommand = `${dlxCommand} qa brief`;

  const files: AgentInitFile[] = [];
  files.push(await upsertAgentsSection(root, dlxCommand, options.reviewMode));
  for (const targetPath of SKILL_TARGET_RELATIVE_PATHS) {
    files.push(await copyPackagedSkill(root, targetPath, options.force ?? false));
  }
  files.push(await ensureDefaultConfig(root));

  return { root, files, nextCommand };
}

// Changes only the managed AGENTS.md section; skills and configuration are left as they are.
// `explicitAsk` records "ask each time", which overrides a user-level consent.
export async function setProjectReviewMode(rootInput: string, reviewMode: AgentReviewMode, explicitAsk = false): Promise<AgentInitFile> {
  const root = path.resolve(rootInput);
  return upsertAgentsSection(root, await detectDlxCommand(root), reviewMode, explicitAsk);
}

async function upsertAgentsSection(root: string, dlxCommand: string, reviewMode?: AgentReviewMode, explicitAsk = false): Promise<AgentInitFile> {
  const agentsPath = path.join(root, "AGENTS.md");
  const relativePath = "AGENTS.md";
  // A given mode replaces the section; without one, a previously recorded choice is kept.
  let section = buildAgentQaSection(dlxCommand, reviewMode, explicitAsk);

  if (!(await pathExists(agentsPath))) {
    const content = `# Agent Instructions\n\n${section}\n`;
    await fs.writeFile(agentsPath, content, "utf8");
    return { path: relativePath, status: "created", detail: "created with the QAMap Pre-PR QA section" };
  }

  const existing = await fs.readFile(agentsPath, "utf8");
  const startIndex = existing.indexOf(SECTION_START);
  const endIndex = existing.indexOf(SECTION_END);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    const current = existing.slice(startIndex, endIndex);
    if (reviewMode === undefined && current.includes(REPORT_REVIEW_MARKER)) section = buildAgentQaSection(dlxCommand, "report");
    if (reviewMode === undefined && current.includes(ASK_REVIEW_MARKER)) section = buildAgentQaSection(dlxCommand, "ask", true);
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

async function copyPackagedSkill(
  root: string,
  targetRelativePath: string,
  force: boolean,
): Promise<AgentInitFile> {
  const sourceRoot = path.join(packageRoot(), SKILL_RELATIVE_ROOT);
  const targetRoot = path.join(root, targetRelativePath);
  const packagedFiles = await Promise.all(SKILL_BUNDLE_FILES.map(async (relativePath) => ({
    relativePath,
    content: await fs.readFile(path.join(sourceRoot, relativePath), "utf8"),
  })));
  const existingFiles = await Promise.all(packagedFiles.map(async (file) => {
    const targetPath = path.join(targetRoot, file.relativePath);
    const exists = await pathExists(targetPath);
    return {
      ...file,
      targetPath,
      exists,
      existing: exists ? await fs.readFile(targetPath, "utf8") : undefined,
    };
  }));
  const targetExisted = existingFiles.some((file) => file.exists);
  const hasLocalChanges = existingFiles.some((file) => file.exists && file.existing !== file.content);

  if (hasLocalChanges && !force) {
    return {
      path: targetRelativePath,
      status: "skipped",
      detail: "skill bundle contains local changes; pass --force to replace packaged files",
    };
  }
  let changed = false;
  for (const file of existingFiles) {
    if (file.existing === file.content) {
      continue;
    }
    await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
    await fs.writeFile(file.targetPath, file.content, "utf8");
    changed = true;
  }
  if (!changed) {
    return { path: targetRelativePath, status: "unchanged", detail: "packaged skill bundle already installed" };
  }
  if (!targetExisted) {
    return { path: targetRelativePath, status: "created", detail: "installed the packaged QAMap PR QA skill bundle" };
  }
  return {
    path: targetRelativePath,
    status: "updated",
    detail: force ? "replaced packaged skill files (--force)" : "installed missing packaged skill metadata",
  };
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
  lines.push("Hosts that read `AGENTS.md` or project skills can offer QAMap during PR review. Automatic discovery depends on the host.");
  lines.push("");
  lines.push("Try it yourself:");
  lines.push("");
  lines.push(`  ${result.nextCommand}`);
  return lines.join("\n");
}
