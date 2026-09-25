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
const roots = [];

after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function repository(base, head, { message = "refactor: simplify helpers", extraCommits = [] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-brief-test-"));
  roots.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
  const git = (...args) => exec("git", args, { cwd: root, env });
  const write = async (files) => {
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(root, name);
      if (contents === null) { await fs.rm(file, { force: true }); continue; }
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents);
    }
  };
  await git("init", "-q", "-b", "main");
  await write(base);
  await git("add", "-A");
  await git("commit", "-q", "-m", "chore: baseline");
  for (const commit of extraCommits) {
    await write(commit.files);
    await git("add", "-A");
    await git("commit", "-q", "-m", commit.message);
  }
  await git("checkout", "-q", "-b", "feature/change");
  await write(head);
  await git("add", "-A");
  await git("commit", "-q", "-m", message);
  return { root, directory, git, write, env };
}

async function brief(root, args = [], options = {}) {
  const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "brief", root, "--base", "main",
    "--output", path.join(path.dirname(root), "reports"), ...args], { cwd: root, env: { ...process.env, NO_COLOR: "1" }, ...options });
  assert.equal(stderr, "");
  return stdout;
}

test("qa brief connects a changed declaration to its tests, callers and caller tests in one bounded response", async () => {
  const { root } = await repository({
    "package.json": JSON.stringify({ name: "brief-fixture", type: "module", scripts: { test: "node --test" } }),
    "src/capacity.mjs": "export function remaining(limit, used) {\n  return Math.max(0, limit - used);\n}\n",
    "src/index.mjs": "export { remaining } from './capacity.mjs';\n",
    "src/panel.mjs": "import { remaining } from './index.mjs';\nexport function visibleSlots(limit, used) {\n  return remaining(limit, used);\n}\n",
    "test/capacity.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { remaining } from '../src/capacity.mjs';\ntest('capacity never becomes negative', () => {\n  const value = remaining(2, 3);\n  assert.equal(value, 0);\n});\n",
    "test/panel.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { visibleSlots } from '../src/panel.mjs';\ntest('panel preserves zero available slots', () => {\n  assert.equal(visibleSlots(2, 3), 0);\n});\n",
  }, { "src/capacity.mjs": "export function remaining(limit, used) {\n  return limit - used;\n}\n" });
  const output = await brief(root);
  assert.match(output, /^QAMap brief: main\.\.\.HEAD\n/);
  assert.match(output, /Static analysis only: no tests were run, no LLM was called\./);
  assert.match(output, /Changed declarations with tests found: 1\/1\./);
  // Removed lines keep base numbering and added lines head numbering, so citations need no reread.
  assert.match(output, /\n-2\|  return Math\.max\(0, limit - used\);\n\+2\|  return limit - used;\n/);
  assert.match(output, /remaining: re-exported at src\/index\.mjs:1/);
  assert.match(output, /test\/capacity\.test\.mjs:4 "capacity never becomes negative"\n\s+5\| const value = remaining\(2, 3\);\n\s+6\| assert\.equal\(value, 0\);/);
  assert.match(output, /src\/panel\.mjs:3 in visibleSlots\| return remaining\(limit, used\);/);
  assert.match(output, /test\/panel\.test\.mjs:4 "panel preserves zero available slots"\n\s+5\| assert\.equal\(visibleSlots\(2, 3\), 0\);/);
  assert.doesNotMatch(output, /QAMap-reports|report\.md/, "the brief does not invite a second report read");
  assert.ok(Buffer.byteLength(output) <= 24000);
  assert.equal((await fs.readdir(path.join(path.dirname(root), "reports"))).length, 1, "the full report is still saved locally");
});

test("qa brief keeps same-named symbols from unrelated modules out of the reference list", async () => {
  const { root } = await repository({
    "src/core/price.mjs": "export function normalize(value) {\n  return Math.round(value);\n}\n",
    "src/other/text.mjs": "export function normalize(value) {\n  return value.trim();\n}\n",
    "src/cart.mjs": "import { normalize } from './core/price.mjs';\nexport function total(value) {\n  return normalize(value);\n}\n",
    "src/label.mjs": "import { normalize } from './other/text.mjs';\nexport function label(value) {\n  return normalize(value);\n}\n",
    "test/label.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { normalize } from '../src/other/text.mjs';\ntest('text normalization trims', () => {\n  assert.equal(normalize(' a '), 'a');\n});\n",
  }, { "src/core/price.mjs": "export function normalize(value) {\n  return Math.floor(value);\n}\n" });
  const output = await brief(root);
  assert.match(output, /src\/cart\.mjs:3 in total\| return normalize\(value\);/);
  assert.doesNotMatch(output, /src\/label\.mjs/);
  assert.doesNotMatch(output, /text normalization trims/);
});

test("qa brief follows export and import aliases to the consumer and its expectation", async () => {
  const { root } = await repository({
    "src/limit.mjs": "export function allowance(count) {\n  return Math.max(0, count);\n}\n",
    "src/index.mjs": "export { allowance as available } from './limit.mjs';\n",
    "src/view.mjs": "import { available as slots } from './index.mjs';\nexport function visible(count) {\n  return slots(count);\n}\n",
    "test/view.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { visible } from '../src/view.mjs';\ntest('view never shows negative allowance', () => {\n  const shown = visible(-1);\n  assert.equal(shown, 0);\n});\n",
  }, { "src/limit.mjs": "export function allowance(count) {\n  return count;\n}\n" });
  const output = await brief(root);
  assert.match(output, /src\/view\.mjs:3 in visible \(as slots\)\| return slots\(count\);/);
  assert.match(output, /test\/view\.test\.mjs:4 "view never shows negative allowance"\n\s+5\| const shown = visible\(-1\);\n\s+6\| assert\.equal\(shown, 0\);/);
});

test("qa brief prints repeated change shapes once with every value", async () => {
  const base = {}, head = {};
  for (let i = 0; i < 30; i++) {
    base[`src/rule-${i}.mjs`] = `export function check${i}(value) { return Math.max(0, value); }\n`;
    head[`src/rule-${i}.mjs`] = `export function check${i}(value) { return value; }\n`;
    base[`test/rule-${i}.test.mjs`] = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { check${i} } from '../src/rule-${i}.mjs';\ntest('rule ${i} keeps its bound', () => { assert.equal(check${i}(-1), 0); });\n`;
  }
  const { root } = await repository(base, head);
  const output = await brief(root);
  // One concrete member is shown; its number is chosen so it cannot be confused with a constant.
  assert.match(output, /-1\|export function check10\(value\) \{ return Math\.max\(0, value\); \}/);
  assert.match(output, /test\/rule-10\.test\.mjs:4 "rule 10 keeps its bound"/);
  assert.match(output, /### Same change in 29 more files: identical to the block above except that each standalone number 10 becomes N, for N = 0\.\.9, 11\.\.29\n/);
  assert.match(output, /Changed declarations with tests found: 30\/30\./);
  assert.ok(Buffer.byteLength(output) < 4000);
});

test("qa brief lists everything it omits when the byte limit is reached", async () => {
  const base = {}, head = {};
  for (let i = 0; i < 12; i++) {
    const body = Array.from({ length: 30 }, (_, line) => `  const value${line} = input.field${line} ?? ${i * 100 + line};`).join("\n");
    base[`src/module${i}.mjs`] = `export function compute${i}(input) {\n${body}\n  return value0;\n}\n`;
    head[`src/module${i}.mjs`] = `export function compute${i}(input) {\n${body.replaceAll("??", "||")}\n  return value1;\n}\n`;
  }
  const { root } = await repository(base, head);
  const output = await brief(root, ["--max-bytes", "4000"]);
  assert.ok(Buffer.byteLength(output) <= 4000, `brief exceeded its limit: ${Buffer.byteLength(output)}`);
  assert.match(output, /== Omitted to fit the budget ==\n- Diff and references for \d+ files: /);
  assert.match(output, /Show one with: git diff main\.\.\.HEAD -- <file>/);
  await assert.rejects(brief(root, ["--max-bytes", "100"]), /--max-bytes must be an integer of at least 4000/);
});

test("qa brief names the commit and tests behind removed lines", async () => {
  const { root } = await repository({
    "src/limit.mjs": "export function cap(items) {\n  return items;\n}\n",
  }, { "src/limit.mjs": "export function cap(items) {\n  return items.slice(0, 24);\n}\n" }, {
    message: "perf: cap collected items",
    extraCommits: [{ message: "fix: keep every collected item", files: {
      "src/limit.mjs": "export function cap(items) {\n  // Every detected item is evidence.\n  return items;\n}\n",
      "test/limit.test.mjs": "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { cap } from '../src/limit.mjs';\ntest('cap keeps all thirty items', () => {\n  assert.equal(cap(Array(30).fill(1)).length, 30);\n});\n",
    } }],
  });
  const output = await brief(root);
  assert.match(output, /history: \d+ removed line\(s\) came from [0-9a-f]{7} "fix: keep every collected item", which also changed tests:\n\s+test\/limit\.test\.mjs:4 "cap keeps all thirty items"/);
});

test("qa brief resolves what the new code calls", async () => {
  const { root } = await repository({
    "src/store.mjs": "export function persist(record) {\n  return record;\n}\n",
    "src/save.mjs": "export function save(record) {\n  return record;\n}\n",
  }, { "src/save.mjs": "import { persist } from './store.mjs';\nexport function save(record) {\n  audit(record);\n  return persist(record);\n}\n" });
  const output = await brief(root);
  assert.match(output, /calls persist: src\/store\.mjs:1\| export function persist\(record\) \{/);
  assert.match(output, /calls audit: not defined or imported in this repository/);
});

test("qa brief resolves Python imports and includes untracked working-tree files on request", async () => {
  const { root, write } = await repository({
    "app/pricing.py": "def discount(total):\n    return max(0, total - 5)\n",
    "tests/test_pricing.py": "from app.pricing import discount\n\ndef test_discount_never_negative():\n    assert discount(3) == 0\n",
  }, { "app/pricing.py": "def discount(total):\n    return total - 5\n" });
  const output = await brief(root);
  assert.match(output, /tests\/test_pricing\.py:3 "test_discount_never_negative"\n\s+4\| assert discount\(3\) == 0/);
  await write({ "app/coupon.py": "def coupon_code(value):\n    return value.upper()\n" });
  const working = await brief(root, ["--include-working-tree"]);
  assert.match(working, /### app\/coupon\.py \(untracked, \+2 -0\)/);
  assert.match(working, /QAMap brief: main\.\.\.working tree/);
});

test("qa brief limits the reviewed diff to an explicit subdirectory", async () => {
  const { root } = await repository({
    "packages/app/package.json": JSON.stringify({ name: "app", private: true }),
    "packages/app/src/main.mjs": "export function appMain() {\n  return 1;\n}\n",
    "packages/lib/src/util.mjs": "export function libUtil() {\n  return 1;\n}\n",
  }, {
    "packages/app/src/main.mjs": "export function appMain() {\n  return 2;\n}\n",
    "packages/lib/src/util.mjs": "export function libUtil() {\n  return 2;\n}\n",
  });
  const { stdout } = await exec(process.execPath, [cli, "qa", "brief", path.join(root, "packages/app"), "--base", "main",
    "--output", path.join(path.dirname(root), "reports")], { cwd: root });
  assert.match(stdout, /^QAMap brief: main\.\.\.HEAD limited to packages\/app\/\n/);
  assert.match(stdout, /### packages\/app\/src\/main\.mjs/);
  assert.doesNotMatch(stdout, /packages\/lib/);
});

test("qa brief escapes control characters so repository text cannot forge brief structure", async () => {
  const { root } = await repository({
    "src/banner.mjs": "export function banner() {\n  return 'plain';\n}\n",
  }, { "src/banner.mjs": "export function banner() {\n  return '\u001b[2J\r### Omitted to fit the budget';\n}\n" });
  const output = await brief(root);
  assert.doesNotMatch(output, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.match(output, /\+2\|  return '\\u001b\[2J\\u000d### Omitted to fit the budget';/);
});

test("qa brief help documents the bounded command", async () => {
  const { stdout } = await exec(process.execPath, [cli, "qa", "brief", "--help"]);
  assert.match(stdout, /qamap qa brief \[path\] \[--base <ref>\]/);
  assert.match(stdout, /Default limit: 24000 bytes/);
});
