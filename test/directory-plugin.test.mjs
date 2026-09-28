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
  for (const source of [...new Set(Object.values(directoryPluginSources)), "package.json", `${directoryPluginPath}/README.md`]) {
    await mkdir(path.dirname(path.join(temp, source)), { recursive: true });
    await cp(path.join(root, source), path.join(temp, source));
  }
  await syncDirectoryPlugin(temp);
  return temp;
}

test("directory submission contains only the synchronized plugin files", async () => {
  const receipt = await checkDirectoryPlugin(root);
  assert.equal(receipt.files, 10);
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(receipt.version, pkg.version);
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

test("directory packaging rejects development files and install configuration", async t => {
  for (const file of ["scripts/provider.mjs", "package.json", "package-lock.json", ".npmrc"]) {
    await t.test(file, async t => {
      const temp = await fixture(t);
      const extra = path.join(temp, directoryPluginPath, file);
      await mkdir(path.dirname(extra), { recursive: true });
      await writeFile(extra, "unexpected\n");
      await assert.rejects(checkDirectoryPlugin(temp), /only its declared files/);
    });
  }
});

test("directory packaging detects drift and refreshes shared consent instructions", async t => {
  const temp = await fixture(t);
  const skill = path.join(temp, directoryPluginPath, "skills/qamap-pr-qa/SKILL.md");
  await writeFile(skill, "Run without consent.\n");
  await assert.rejects(checkDirectoryPlugin(temp), /SKILL.md is stale/);
  await syncDirectoryPlugin(temp);
  assert.match(await readFile(skill, "utf8"), /qa brief --require-consent/);
});

test("directory packaging requires the canonical icon and matching version", async t => {
  const temp = await fixture(t);
  const icon = path.join(temp, directoryPluginPath, ".claude-plugin/icon.svg");
  await rm(icon);
  await assert.rejects(checkDirectoryPlugin(temp), /only its declared files/);
  await syncDirectoryPlugin(temp);
  const manifest = path.join(temp, directoryPluginPath, ".claude-plugin/plugin.json");
  const data = JSON.parse(await readFile(manifest, "utf8"));
  data.version = "0.0.0";
  await writeFile(manifest, JSON.stringify(data));
  await assert.rejects(checkDirectoryPlugin(temp), /plugin.json is stale/);
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
  await writeFile(readme, "Setup instructions for @ivorycanvas/qamap@0.0.0");
  await assert.rejects(checkDirectoryPlugin(temp), /README's CLI version/);
});
