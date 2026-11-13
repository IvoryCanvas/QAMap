import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkDirectoryPlugin, directoryPluginSources } from "./directory-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const digest = value => createHash("sha256").update(value).digest("hex");

async function safeRead(directory, relative) {
  let current = directory;
  for (const part of relative.split("/")) {
    assert.ok(part && part !== "." && part !== "..", "Invalid release input path");
    current = path.join(current, part);
    assert.ok(!(await lstat(current)).isSymbolicLink(), `Release input must not be a symbolic link: ${relative}`);
  }
  return readFile(current, "utf8");
}

export async function prepareRelease(directory, version, date, claudeVersion, options = {}) {
  const channels = [...new Set(options.channels ?? [])].sort();
  assert.ok(channels.length && channels.every(channel => ["npm", "openai", "claude"].includes(channel)),
    "Explicit --channels npm,openai and/or claude are required");
  assert.ok(!claudeVersion || channels.includes("claude"), "--claude-version requires the claude channel");
  if (channels.includes("claude")) assert.ok(claudeVersion, "The claude channel requires an explicit --claude-version");
  const inputs = new Map();
  const read = async relative => {
    const content = await safeRead(directory, relative);
    inputs.set(relative, digest(content));
    return content;
  };
  const pkg = JSON.parse(await read("package.json"));
  const previous = pkg.version;
  version ??= previous;
  if (version !== previous) assert.ok(channels.includes("npm") && channels.includes("openai"),
    "npm and OpenAI portable versions are coupled; select both channels explicitly to change them");
  if (!channels.includes("npm")) assert.equal(version, previous, "Unselected npm version cannot change");
  for (const source of Object.values(directoryPluginSources)) await read(source);
  await checkDirectoryPlugin(directory);
  assert.match(version, /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/, "Use a release or alpha/beta/rc semantic version");
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/, "Use an explicit YYYY-MM-DD date");
  assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date);
  const notes = await read(`docs/releases/${version}.md`);
  const releaseNotes = notes.match(/## Plugin release notes\n\n([\s\S]*?)(?:\n\n## |$)/)?.[1].replace(/\s+/g, " ").trim();
  assert.ok(releaseNotes?.startsWith(`QAMap ${version} `), "Release record must have versioned Plugin release notes");

  // Prepare the complete edit set before writing anything. Historic records stay intact.
  const edits = new Map();
  pkg.version = version;
  edits.set("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  const lock = JSON.parse(await read("package-lock.json"));
  lock.version = version;
  lock.packages[""].version = version;
  edits.set("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  for (const file of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    const data = JSON.parse(await read(file));
    data.version = version;
    if (file.startsWith(".codex")) {
      data.requires_local_executor = true;
      data.extensions ??= {};
      data.extensions["com.openai"] ??= {};
      data.extensions["com.openai"].publication = {
        ...data.extensions["com.openai"].publication,
        release_notes: releaseNotes,
      };
    }
    edits.set(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  const claudeManifest = "plugins/claude/.claude-plugin/plugin.json";
  const claude = JSON.parse(await read(claudeManifest));
  claudeVersion ??= claude.version;
  assert.match(claudeVersion, /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/, "Use a semantic version for the Claude plugin");
  claude.version = claudeVersion;
  edits.set(claudeManifest, `${JSON.stringify(claude, null, 2)}\n`);
  const submission = JSON.parse(await read("plugin/submission.json"));
  submission.releaseNotes = releaseNotes;
  edits.set("plugin/submission.json", `${JSON.stringify(submission, null, 2)}\n`);
  const source = await read("src/version.ts");
  assert.match(source, /export const VERSION = "[^"]+";/);
  edits.set("src/version.ts", source.replace(/export const VERSION = "[^"]+";/, `export const VERSION = "${version}";`));
  for (const file of ["skills/qamap-pr-qa/SKILL.md", "skills/qamap-pr-qa/references/advanced-workflow.md", "plugins/claude/skills/qamap-pr-qa/SKILL.md", "plugins/claude/README.md", "docs/claude-code.md", "docs/ko/claude-code.md", "docs/agent-skill.md"]) {
    edits.set(file, (await read(file)).replaceAll(`@ivorycanvas/qamap@${previous}`, `@ivorycanvas/qamap@${version}`)
      .replaceAll(`paired with QAMap ${previous}.`, `paired with QAMap ${version}.`)
      .replaceAll(`The ${previous} skill`, `The ${version} skill`)
      .replaceAll(`${previous} 스킬에는`, `${version} 스킬에는`));
  }
  edits.set("plugins/claude/README.md", edits.get("plugins/claude/README.md")
    .replace(/Claude plugin version: \*\*[^*]+\*\*/, `Claude plugin version: **${claudeVersion}**`));
  const changelog = await read("CHANGELOG.md");
  edits.set("CHANGELOG.md", version === previous || changelog.includes(`## ${version} - ${date}`) ? changelog
    : changelog.replace("## Unreleased\n", `## Unreleased\n\n## ${version} - ${date}\n\nnpm and plugin publication are separate steps.\nSee the [${version} release record](docs/releases/${version}.md).\n`));
  if (channels.includes("claude")) {
    for (const [destination, source] of Object.entries(directoryPluginSources)) {
      edits.set(`plugins/claude/${destination}`, await read(source));
    }
  }
  const selected = file => {
    if (file.startsWith("plugins/claude/")) return channels.includes("claude")
      || channels.includes("npm") && ["plugins/claude/README.md", "plugins/claude/skills/qamap-pr-qa/SKILL.md"].includes(file);
    if (file === ".codex-plugin/plugin.json" || file === "plugin/submission.json") return channels.includes("openai");
    return channels.includes("npm");
  };
  const changes = [];
  for (const [file, content] of edits) {
    if (!selected(file)) continue;
    const before = await read(file);
    if (before !== content) changes.push({ path: file, beforeSha256: digest(before), afterSha256: digest(content), bytes: Buffer.byteLength(content) });
  }
  let sourceCommit = null;
  let sourceDirty = null;
  try {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    sourceDirty = execFileSync("git", ["status", "--porcelain"], { cwd: directory, stdio: ["ignore", "pipe", "ignore"] }).length > 0;
  } catch { /* isolated fixture */ }
  const plan = { version, claudeVersion, date, channels, sourceCommit, sourceDirty,
    inputs: [...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([file, sha256]) => ({ path: file, sha256 })),
    files: changes.sort((a, b) => a.path.localeCompare(b.path)) };
  const planSha256 = digest(JSON.stringify(plan));
  if (!options.apply) return { ...plan, planSha256, applied: false };
  assert.equal(options.expectedPlan, planSha256, "Release inputs or selections changed; preview again and supply the matching --plan-sha256");
  assert.ok(sourceDirty !== true, "Commit or isolate the reviewed inputs before applying a release plan");
  // Recheck every read input before the first write, including unmodified sources.
  for (const { path: file, sha256 } of plan.inputs) assert.equal(digest(await safeRead(directory, file)), sha256, `Release input changed: ${file}`);
  for (const change of plan.files) await writeFile(path.join(directory, change.path), edits.get(change.path));
  await checkDirectoryPlugin(directory);
  return { ...plan, planSha256, applied: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { version: { type: "string" }, date: { type: "string" },
    channels: { type: "string" }, "claude-version": { type: "string" }, "dry-run": { type: "boolean" },
    apply: { type: "boolean" }, "plan-sha256": { type: "string" } } });
  assert.ok(values.date, "--date is required");
  assert.ok(!values.apply || !values["dry-run"], "Choose preview or --apply, not both");
  assert.ok(!values.apply || /^[a-f0-9]{64}$/.test(values["plan-sha256"] ?? ""), "--apply requires the preview's --plan-sha256");
  const channels = values.channels?.split(",");
  if (channels?.includes("npm") || channels?.includes("openai")) assert.ok(values.version, "Portable release channels require an explicit --version");
  console.log(JSON.stringify(await prepareRelease(root, values.version, values.date, values["claude-version"],
    { channels, apply: values.apply, expectedPlan: values["plan-sha256"] }), null, 2));
}
