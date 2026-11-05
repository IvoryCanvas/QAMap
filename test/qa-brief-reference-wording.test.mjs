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
const original = source("export function normalize(value) {", "  return value.trim();", "}");
const changed = original.replace("value.trim()", "value.trim().toLowerCase()");

after(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
});

async function brief(files) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-reference-wording-"));
  directories.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", NO_COLOR: "1" };
  const git = (...args) => exec("git", args, { cwd: root, env });
  for (const [name, text] of Object.entries({ "src/normalizer.mjs": original, ...files })) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  await git("init", "-q", "-b", "main");
  await git("add", "-A");
  await git("commit", "-q", "-m", "chore: baseline");
  await git("checkout", "-q", "-b", "feat/reference-wording");
  await fs.writeFile(path.join(root, "src/normalizer.mjs"), changed);
  await git("add", "-A");
  await git("commit", "-q", "-m", "fix: normalize label case");
  // These neutral fixtures are source evidence only. Their imports and test
  // bodies are never executed by the brief command.
  const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "brief", root, "--base", "main",
    "--output", path.join(directory, "reports")], { cwd: root, env });
  assert.equal(stderr, "");
  assert.match(stdout, /Static analysis only: no tests were run, no LLM was called\./);
  return stdout;
}

function normalizerBlock(output) {
  const start = output.indexOf("### src/normalizer.mjs");
  assert.notEqual(start, -1);
  return output.slice(start).split(/\n(?=### |== )/)[0];
}

function referenceCount(output, tested) {
  assert.match(output, new RegExp(`Changed declarations with collected test references: ${tested}/1 `));
  assert.match(output, /direct or through callers; JavaScript\/TypeScript bindings are checked, other languages may use name matches/);
  assert.match(output, /references do not establish executed coverage/);
  assert.doesNotMatch(output, /No test file names|no test file names it/);
}

test("a test importing an unresolved build output remains visible without a claim that tests are absent", async () => {
  const output = await brief({
    "test/normalizer.test.mjs": source("import assert from 'node:assert/strict';", "import test from 'node:test';",
      "import { normalize } from '../dist/normalizer.js';", "test('uses the public build entry', () => {",
      "  assert.equal(normalize(' X '), 'x');", "});"),
  });
  referenceCount(output, 0);
  const block = normalizerBlock(output);
  assert.match(block, /normalize: unresolved references \(binding not resolved\):[^\n]*test\/normalizer\.test\.mjs:5/);
  assert.match(block, /normalize: no confirmed references collected outside the changed lines/);
  assert.doesNotMatch(block, /normalize: collected test references/);
  assert.doesNotMatch(block, /test\/normalizer\.test\.mjs:4 "uses the public build entry"/);
  assert.match(output, /No collected test references: normalize \(collection is incomplete; tests may reach them indirectly\)/);
});

test("an unseen test contract is described as an absence of collected references rather than an absence of tests", async () => {
  const output = await brief({
    "src/view.mjs": source("import { normalize } from './normalizer.mjs';", "export function display(value) {", "  return normalize(value);", "}"),
    "test/unrelated.test.mjs": source("import test from 'node:test';", "import assert from 'node:assert/strict';",
      "test('checks a separate calculation', () => { assert.equal(1 + 1, 2); });"),
  });
  referenceCount(output, 0);
  const block = normalizerBlock(output);
  assert.match(block, /src\/view\.mjs:3 in display/);
  assert.match(block, /normalize: no collected test references \(indirect coverage not checked\)/);
  assert.match(output, /No collected test references: normalize/);
  assert.doesNotMatch(block, /unresolved references \(binding not resolved\)/);
});

test("a binding-confirmed named alias remains a collected test reference", async () => {
  const output = await brief({
    "test/normalizer.test.mjs": source("import assert from 'node:assert/strict';", "import test from 'node:test';",
      "import { normalize as tidy } from '../src/normalizer.mjs';", "test('normalizes a label', () => {",
      "  assert.equal(tidy(' X '), 'x');", "});"),
  });
  referenceCount(output, 1);
  const block = normalizerBlock(output);
  assert.match(block, /normalize: collected test references/);
  assert.match(block, /test\/normalizer\.test\.mjs:4 "normalizes a label"/);
  assert.match(block, /5\| assert\.equal\(tidy\(' X '\), 'x'\);/);
  assert.doesNotMatch(block, /unresolved references \(binding not resolved\)/);
  assert.doesNotMatch(output, /No collected test references: normalize/);
});

test("a confirmed caller's test contributes to the reference count without implying execution", async () => {
  const output = await brief({
    "src/view.mjs": source("import { normalize } from './normalizer.mjs';", "export function display(value) {", "  return normalize(value);", "}"),
    "test/view.test.mjs": source("import assert from 'node:assert/strict';", "import test from 'node:test';",
      "import { display } from '../src/view.mjs';", "test('renders normalized labels', () => {",
      "  assert.equal(display(' X '), 'x');", "});"),
  });
  referenceCount(output, 1);
  const block = normalizerBlock(output);
  assert.match(block, /src\/view\.mjs:3 in display/);
  assert.match(block, /test\/view\.test\.mjs:4 "renders normalized labels"/);
  assert.match(block, /5\| assert\.equal\(display\(' X '\), 'x'\);/);
  assert.doesNotMatch(block, /normalize: no collected test references/);
  assert.doesNotMatch(output, /No collected test references: normalize/);
});
