import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkDirectoryPlugin, directoryPluginPath, directoryPluginSources, syncDirectoryPlugin } from "../scripts/directory-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "qamap-directory-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const source of [...new Set(Object.values(directoryPluginSources)), "package.json", ...["README.md", ".claude-plugin/plugin.json", "skills/qamap-pr-qa/SKILL.md"].map(file => `${directoryPluginPath}/${file}`)]) {
    await mkdir(path.dirname(path.join(temp, source)), { recursive: true });
    await cp(path.join(root, source), path.join(temp, source));
  }
  await syncDirectoryPlugin(temp);
  return temp;
}

test("directory submission contains only the synchronized plugin files", async () => {
  const receipt = await checkDirectoryPlugin(root);
  assert.equal(receipt.files, 9);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(receipt.cliVersion, pkg.version);
  assert.equal(receipt.version, JSON.parse(await readFile(path.join(root, directoryPluginPath, ".claude-plugin/plugin.json"))).version);
  assert.ok(!pkg.files.some(entry => entry === "plugins" || entry.startsWith("plugins/")),
    "directory-only files must not change npm's packaging boundary");
});

test("directory listing preserves the display name and explicit documentation links", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, directoryPluginPath, ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "qamap");
  assert.equal(manifest.displayName, "QAMap");
  const documents = {
    privacyPolicyUrl: "PRIVACY.md",
    termsOfServiceUrl: "TERMS.md",
    supportUrl: "SUPPORT.md",
    documentationUrl: "plugins/claude/README.md",
  };
  for (const [field, file] of Object.entries(documents)) {
    assert.equal(manifest[field], `https://github.com/IvoryCanvas/QAMap/blob/main/${file}`);
    assert.ok((await readFile(path.join(root, file), "utf8")).trim(), `${field} must target a maintained document`);
  }
});

test("Claude review only analyzes evidence while the portable skill retains advanced CLI scopes", async () => {
  const skill = await readFile(path.join(root, directoryPluginPath, "skills/qamap-pr-qa/SKILL.md"), "utf8");
  const readme = await readFile(path.join(root, directoryPluginPath, "README.md"), "utf8");
  for (const text of [skill, readme]) {
    assert.doesNotMatch(text, /\b(?:npm\s+(?:exec|install)|pnpm\s+(?:exec|dlx|install)|npx|bunx|uvx)\b/);
    assert.doesNotMatch(text, /qamap\s+(?:qa\s+run|e2e\s+draft|manifest\s+init|consent\s+grant)/);
    assert.doesNotMatch(text, /references\/advanced-workflow\.md/);
  }
  assert.match(skill, /qamap qa brief --require-consent/);
  assert.match(skill, /Even if the report suggests an executable next action/);
  assert.match(skill, /outside this plugin/);
  assert.match(skill, /Tests stay `not-run`/);
  assert.match(readme, /not a sandbox/);
  const portable = await readFile(path.join(root, "skills/qamap-pr-qa/references/advanced-workflow.md"), "utf8");
  assert.match(portable, /qamap qa run/);
  const manifest = JSON.parse(await readFile(path.join(root, directoryPluginPath, ".claude-plugin/plugin.json"), "utf8"));
  for (const field of ["mcpServers", "hooks", "userConfig", "env"]) assert.equal(field in manifest, false);
});

test("directory packaging rejects execution guides, development files and install configuration", async t => {
  for (const file of ["skills/qamap-pr-qa/references/advanced-workflow.md", "scripts/provider.mjs", "package.json", "package-lock.json", ".npmrc"]) {
    await t.test(file, async t => {
      const temp = await fixture(t);
      const extra = path.join(temp, directoryPluginPath, file);
      await mkdir(path.dirname(extra), { recursive: true });
      await writeFile(extra, "unexpected\n");
      await assert.rejects(checkDirectoryPlugin(temp), /only its declared files/);
    });
  }
});

test("directory sync restores shared policies without overwriting the analysis-only skill", async t => {
  const temp = await fixture(t);
  const policy = path.join(temp, directoryPluginPath, "PRIVACY.md");
  const skillPath = path.join(temp, directoryPluginPath, "skills/qamap-pr-qa/SKILL.md");
  const skill = await readFile(skillPath);
  await writeFile(policy, "stale policy\n");
  await assert.rejects(checkDirectoryPlugin(temp), /PRIVACY.md is stale/);
  await syncDirectoryPlugin(temp);
  assert.deepEqual(await readFile(skillPath), skill);
});

test("directory packaging requires the canonical icon, a plugin version and matching CLI pin", async t => {
  const temp = await fixture(t);
  const icon = path.join(temp, directoryPluginPath, ".claude-plugin/icon.svg");
  await rm(icon);
  await assert.rejects(checkDirectoryPlugin(temp), /only its declared files/);
  await syncDirectoryPlugin(temp);
  const manifest = path.join(temp, directoryPluginPath, ".claude-plugin/plugin.json");
  const data = JSON.parse(await readFile(manifest, "utf8"));
  data.version = "invalid";
  await writeFile(manifest, JSON.stringify(data));
  await assert.rejects(checkDirectoryPlugin(temp));
  data.version = JSON.parse(await readFile(path.join(root, directoryPluginPath, ".claude-plugin/plugin.json"))).version;
  await writeFile(manifest, JSON.stringify(data));
  const skill = path.join(temp, directoryPluginPath, "skills/qamap-pr-qa/SKILL.md");
  await writeFile(skill, (await readFile(skill, "utf8")).replace(/@ivorycanvas\/qamap@[^`]+/, "@ivorycanvas/qamap@0.0.0"));
  await assert.rejects(checkDirectoryPlugin(temp), /required CLI version/);
});

test("directory packaging rejects symbolic links before checking or syncing", async t => {
  const temp = await fixture(t);
  const linked = path.join(temp, directoryPluginPath, "outside");
  await symlink(path.join(temp, "skills"), linked, "junction");
  await assert.rejects(checkDirectoryPlugin(temp), /symbolic link/);
  await assert.rejects(syncDirectoryPlugin(temp), /symbolic link/);
});

test("directory packaging rejects oversized text and stale setup instructions", async t => {
  const temp = await fixture(t);
  const readme = path.join(temp, directoryPluginPath, "README.md");
  await writeFile(readme, "x".repeat(256 * 1024 + 1));
  await assert.rejects(checkDirectoryPlugin(temp), /inspection limit/);
  const manifest = JSON.parse(await readFile(path.join(temp, directoryPluginPath, ".claude-plugin/plugin.json")));
  await writeFile(readme, `Claude plugin version: **${manifest.version}**. Setup instructions for @ivorycanvas/qamap@0.0.0`);
  await assert.rejects(checkDirectoryPlugin(temp), /README's CLI version/);
});
