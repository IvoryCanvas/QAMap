import assert from "node:assert/strict";
import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const directoryPluginPath = "plugins/claude";
export const directoryPluginSources = {
  ".claude-plugin/plugin.json": ".claude-plugin/plugin.json",
  ".claude-plugin/icon.svg": "brand/source/qamap-app-icon.svg",
  "skills/qamap-pr-qa/SKILL.md": "skills/qamap-pr-qa/SKILL.md",
  "skills/qamap-pr-qa/references/advanced-workflow.md": "skills/qamap-pr-qa/references/advanced-workflow.md",
  "LICENSE": "LICENSE",
  "PRIVACY.md": "PRIVACY.md",
  "SUPPORT.md": "SUPPORT.md",
  "TERMS.md": "TERMS.md",
  "SECURITY.md": "SECURITY.md",
};

async function inventory(root, relative = "") {
  const directory = path.join(root, relative);
  assert.ok((await lstat(directory)).isDirectory(), `${directory} must be a real directory`);
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const entry = relative ? `${relative}/${name}` : name;
    const info = await lstat(path.join(root, entry));
    assert.ok(!info.isSymbolicLink(), `${entry} must not be a symbolic link`);
    if (info.isDirectory()) files.push(...await inventory(root, entry));
    else {
      assert.ok(info.isFile(), `${entry} must be a regular file`);
      assert.ok(info.size <= 256 * 1024, `${entry} exceeds the directory inspection limit`);
      files.push(entry);
    }
  }
  return files;
}

export async function checkDirectoryPlugin(root = repositoryRoot) {
  const bundle = path.join(root, directoryPluginPath);
  const files = await inventory(bundle);
  const expected = [...Object.keys(directoryPluginSources), "README.md"].sort();
  assert.deepEqual(files.sort(), expected, "Directory plugin must contain only its declared files");
  for (const [destination, source] of Object.entries(directoryPluginSources)) {
    assert.deepEqual(await readFile(path.join(bundle, destination)), await readFile(path.join(root, source)),
      `${destination} is stale; run node scripts/directory-plugin.mjs --write`);
  }
  const manifest = JSON.parse(await readFile(path.join(bundle, ".claude-plugin/plugin.json"), "utf8"));
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.name, "qamap");
  const readme = await readFile(path.join(bundle, "README.md"), "utf8");
  assert.ok(readme.includes(`@ivorycanvas/qamap@${pkg.version}`), "Update the directory README's CLI version");
  assert.ok(readme.trim().split(/\s+/).length >= 40, "Directory README must describe the plugin");
  const icon = await readFile(path.join(bundle, ".claude-plugin/icon.svg"), "utf8");
  assert.match(icon, /width="1024" height="1024"/);
  assert.doesNotMatch(icon, /<(?:script|image|foreignObject)\b|(?:href|onload)=/i);
  return { path: directoryPluginPath, version: manifest.version, files: files.length };
}

export async function syncDirectoryPlugin(root = repositoryRoot) {
  // Never follow an existing destination link while refreshing committed copies.
  const bundle = path.join(root, directoryPluginPath);
  await inventory(bundle);
  for (const [destination, source] of Object.entries(directoryPluginSources)) {
    const target = path.join(bundle, destination);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, source), target);
  }
  return checkDirectoryPlugin(root);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--write"),
    "Usage: node scripts/directory-plugin.mjs [--write]");
  const result = args[0] === "--write" ? await syncDirectoryPlugin() : await checkDirectoryPlugin();
  console.log(`Directory plugin valid: ${result.path}, ${result.files} files, version ${result.version}.`);
}
