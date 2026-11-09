import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncDirectoryPlugin } from "./directory-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function prepareRelease(directory, version, date, claudeVersion) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/, "Use a release or alpha/beta/rc semantic version");
  assert.match(date, /^\d{4}-\d{2}-\d{2}$/, "Use an explicit YYYY-MM-DD date");
  assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date);
  const read = relative => readFile(path.join(directory, relative), "utf8");
  const notes = await read(`docs/releases/${version}.md`);
  const releaseNotes = notes.match(/## Plugin release notes\n\n([\s\S]*?)(?:\n\n## |$)/)?.[1].replace(/\s+/g, " ").trim();
  assert.ok(releaseNotes?.startsWith(`QAMap ${version} `), "Release record must have versioned Plugin release notes");

  // Prepare the complete edit set before writing anything. Historic records stay intact.
  const edits = new Map();
  const pkg = JSON.parse(await read("package.json"));
  const previous = pkg.version;
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
  if (claudeVersion === undefined) {
    assert.ok(version === previous || claude.version === previous,
      "Claude versions are independent; pass --claude-version with the next plugin revision");
    claudeVersion = version === previous ? claude.version : version;
  }
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
  edits.set("CHANGELOG.md", changelog.includes(`## ${version} - ${date}`) ? changelog
    : changelog.replace("## Unreleased\n", `## Unreleased\n\n## ${version} - ${date}\n\nnpm and plugin publication are separate steps.\nSee the [${version} release record](docs/releases/${version}.md).\n`));
  for (const [file, contents] of edits) await writeFile(path.join(directory, file), contents);
  await syncDirectoryPlugin(directory);
  return { version, claudeVersion, date, files: edits.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok((args.length === 4 || (args.length === 6 && args[4] === "--claude-version")) && args[0] === "--version" && args[2] === "--date",
    "Usage: node scripts/prepare-release.mjs --version X.Y.Z --date YYYY-MM-DD [--claude-version X.Y.Z]");
  console.log(JSON.stringify(await prepareRelease(root, args[1], args[3], args[5])));
}
