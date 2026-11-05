import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const directories = [];
const source = (...rows) => `${rows.join("\n")}\n`;

after(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
});

async function brief(files, changes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-same-line-bindings-"));
  directories.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", NO_COLOR: "1" };
  const git = (...args) => exec("git", args, { cwd: root, env });
  const write = async values => {
    for (const [name, text] of Object.entries(values)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), text);
    }
  };
  await write(files);
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "chore: baseline");
  await git("checkout", "-q", "-b", "fix/same-line-binding");
  await write(changes);
  await git("add", "-A");
  await git("commit", "-q", "-m", "fix: normalize label case");
  // Only tracked source and its diff are inspected; fixture imports and calls
  // are never executed to decide whether a reference belongs to a declaration.
  const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "brief", root, "--base", "main",
    "--output", path.join(directory, "reports")], { cwd: root, env });
  assert.equal(stderr, "");
  assert.match(stdout, /Static analysis only: no tests were run, no LLM was called\./);
  return stdout;
}

for (const [name, firstLine] of [
  ["a parameter", "function normalize(value) { return value.trim(); } export function wrapper(normalize, value) {"],
  ["a destructured parameter", "function normalize(value) { return value.trim(); } export function wrapper({ normalize }, value) {"],
  ["a local variable", "const normalize = value => value.trim(); export function wrapper(value) { const normalize = other;"],
]) {
  test(`${name} sharing a module declaration's line is not a reference to that module binding`, async () => {
    const before = source(firstLine, "  return normalize(value);", "}");
    const output = await brief({ "src/normalize.mjs": before }, {
      "src/normalize.mjs": before.replace("value.trim()", "value.trim().toLowerCase()"),
    });
    // Line 2 is unchanged, so a wrong link cannot be hidden by the changed-line
    // exclusion. Only the module binding's body changed on line 1.
    assert.doesNotMatch(output, /src\/normalize\.mjs:2 in wrapper/);
    assert.doesNotMatch(output, /normalize: unresolved references[^\n]*src\/normalize\.mjs:2/);
  });
}

test("an actual module call remains linked when its owner starts on the same declaration line", async () => {
  const before = source("function normalize(value) { return value.trim(); } export function wrapper(value) {",
    "  return normalize(value);", "}");
  const output = await brief({ "src/normalize.mjs": before }, {
    "src/normalize.mjs": before.replace("value.trim()", "value.trim().toLowerCase()"),
  });
  assert.match(output, /src\/normalize\.mjs:2 in wrapper\| return normalize\(value\);/);
  assert.doesNotMatch(output, /normalize: unresolved references[^\n]*src\/normalize\.mjs:2/);
});

test("an import alias remains linked when its owner's declaration shares the import line", async () => {
  const before = source("export function normalize(value) { return value.trim(); }");
  const output = await brief({
    "src/normalize.mjs": before,
    "src/view.mjs": source("import { normalize as tidy } from './normalize.mjs'; export function display(value) {",
      "  return tidy(value);", "}"),
  }, { "src/normalize.mjs": before.replace("value.trim()", "value.trim().toLowerCase()") });
  assert.match(output, /src\/view\.mjs:2 in display \(as tidy\)\| return tidy\(value\);/);
  assert.doesNotMatch(output, /normalize: unresolved references[^\n]*src\/view\.mjs:2/);
});
