import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPluginBundles, zipFiles } from "../scripts/plugin-bundle.mjs";
import { prepareRelease } from "../scripts/prepare-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const json = async file => JSON.parse(await readFile(file, "utf8"));

// Read local ZIP entries as an independent consumer, not from generator metadata.
function unzipStored(bytes) {
  const entries = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18);
    const names = bytes.readUInt16LE(offset + 26);
    const extras = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + names).toString();
    const start = offset + 30 + names + extras;
    entries.set(name, bytes.subarray(start, start + size));
    offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  return entries;
}

test("review bundles omit development and publishing inputs and expose usable manifest paths", async t => {
  const output = await mkdtemp(path.join(os.tmpdir(), "qamap-review-bundle-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const result = await buildPluginBundles(root, output);
  const openai = unzipStored(await readFile(path.join(output, `qamap-openai-${result.version}.zip`)));
  const claude = unzipStored(await readFile(path.join(output, `qamap-claude-${result.claudeVersion}.zip`)));
  const manifest = JSON.parse(openai.get(".codex-plugin/plugin.json"));
  for (const files of [openai, claude]) {
    assert.ok(files.has("skills/qamap-pr-qa/SKILL.md"));
    assert.ok(files.has("PRIVACY.md"));
    for (const name of files.keys()) assert.doesNotMatch(name, /^(?:scripts|test|dist|node_modules)\/|(?:^|\/)(?:\.npmrc|\.env|package(?:-lock)?\.json)$/);
  }
  assert.ok(claude.has(".claude-plugin/plugin.json"));
  assert.equal(claude.size, 9);
  assert.equal(claude.has("skills/qamap-pr-qa/references/advanced-workflow.md"), false);
  assert.ok(openai.has("skills/qamap-pr-qa/references/advanced-workflow.md"));
  assert.equal(JSON.parse(claude.get(".claude-plugin/plugin.json")).version, result.claudeVersion);
  assert.equal(manifest.requires_local_executor, true);
  assert.ok(openai.has(manifest.interface.logo.slice(2)));
  const fields = await json(path.join(output, `qamap-submission-fields-${result.version}.json`));
  assert.equal(fields.openai.portal, "https://platform.openai.com/plugins");
  assert.equal(fields.claude.portal, "https://claude.ai/directory/manage");
  assert.equal(fields.claude.version, result.claudeVersion);
  assert.equal(fields.claude.requiredCLI, result.version);
  assert.equal(fields.claude.scope, "analysis-only");
  assert.equal(fields.releaseNotes, manifest.extensions["com.openai"].publication.release_notes);
  assert.equal(fields.reviewCases.positive.length, 5);
  assert.equal(fields.reviewCases.negative.length, 3);
  const original = await readFile(path.join(output, `qamap-openai-${result.version}.zip`));
  await buildPluginBundles(root, output);
  assert.deepEqual(await readFile(path.join(output, `qamap-openai-${result.version}.zip`)), original);
});

test("archive paths cannot escape the plugin root", () => {
  for (const name of ["../.npmrc", "/tmp/config", "a/../../key", "a\\config", "a/./b"]) {
    assert.throws(() => zipFiles([[name, Buffer.from("secret")]]), /Unsafe archive path/);
  }
});

test("bundle generation rejects source links instead of packaging their targets", async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "qamap-review-links-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const copy = path.join(temporary, "source");
  // Only the files needed before the input enumeration; no fixture repository execution.
  for (const name of ["package.json", ".codex-plugin", ".claude-plugin", "plugin", "plugins", "skills", "brand", "LICENSE", "PRIVACY.md", "TERMS.md", "SUPPORT.md", "SECURITY.md"]) {
    await cp(path.join(root, name), path.join(copy, name), { recursive: true });
  }
  await symlink(path.join(root, "package.json"), path.join(copy, "skills", "extra-key"));
  await assert.rejects(buildPluginBundles(copy, path.join(temporary, "output")), /symbolic link/);
});

test("release preparation aligns current pins, preserves history and can be repeated", async t => {
  const copy = await mkdtemp(path.join(os.tmpdir(), "qamap-prepare-version-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  for (const name of ["package.json", "package-lock.json", "src/version.ts", ".codex-plugin", ".claude-plugin", "plugin", "plugins", "skills", "brand", "docs", "CHANGELOG.md", "LICENSE", "PRIVACY.md", "TERMS.md", "SUPPORT.md", "SECURITY.md"]) {
    await cp(path.join(root, name), path.join(copy, name), { recursive: true });
  }
  const history = await readFile(path.join(copy, "docs/releases/0.5.2.md"));
  const manifestPath = path.join(copy, ".codex-plugin/plugin.json");
  const manifest = await json(manifestPath);
  manifest.extensions["com.openai"].publication.countries = ["KR", "US"];
  manifest.extensions["com.openai"].publication.translations = { "ko-KR": { subtitle: "변경 근거로 PR 검토" } };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(copy, "docs/releases/0.5.4.md"), "# QAMap 0.5.4\n\n## Plugin release notes\n\nQAMap 0.5.4 preserves the local evidence boundary.\n");
  await prepareRelease(copy, "0.5.4", "2026-11-07", "0.5.5");
  await prepareRelease(copy, "0.5.4", "2026-11-07");
  assert.equal((await json(path.join(copy, "package.json"))).version, "0.5.4");
  assert.deepEqual((await json(manifestPath)).extensions["com.openai"].publication.countries, ["KR", "US"]);
  assert.deepEqual((await json(manifestPath)).extensions["com.openai"].publication.translations, manifest.extensions["com.openai"].publication.translations);
  assert.equal((await json(path.join(copy, "package-lock.json"))).packages[""].version, "0.5.4");
  assert.match(await readFile(path.join(copy, "skills/qamap-pr-qa/SKILL.md"), "utf8"), /@ivorycanvas\/qamap@0\.5\.4/);
  assert.equal((await json(path.join(copy, "plugins/claude/.claude-plugin/plugin.json"))).version, "0.5.5");
  const claudeSkill = await readFile(path.join(copy, "plugins/claude/skills/qamap-pr-qa/SKILL.md"), "utf8");
  assert.match(claudeSkill, /@ivorycanvas\/qamap@0\.5\.4/);
  assert.doesNotMatch(claudeSkill, /references\/advanced-workflow/);
  assert.match(await readFile(path.join(copy, "plugins/claude/README.md"), "utf8"), /Claude plugin version: \*\*0\.5\.5\*\*/);
  assert.match(await readFile(path.join(copy, "docs/ko/claude-code.md"), "utf8"), /@ivorycanvas\/qamap@0\.5\.4/);
  assert.equal((await readFile(path.join(copy, "CHANGELOG.md"), "utf8")).split("## 0.5.4 -").length, 2);
  assert.deepEqual(await readFile(path.join(copy, "docs/releases/0.5.2.md")), history);
  await assert.rejects(prepareRelease(copy, "0.5.5", "2026-11-08"), /ENOENT/);
  assert.equal((await json(path.join(copy, "package.json"))).version, "0.5.4");
  await writeFile(path.join(copy, "docs/releases/0.5.5.md"), "# QAMap 0.5.5\n\n## Plugin release notes\n\nQAMap 0.5.5 preserves the local evidence boundary.\n");
  await assert.rejects(prepareRelease(copy, "0.5.5", "2026-11-09"), /--claude-version/);
  assert.equal((await json(path.join(copy, "package.json"))).version, "0.5.4");
  assert.equal((await json(path.join(copy, "plugins/claude/.claude-plugin/plugin.json"))).version, "0.5.5");
});
