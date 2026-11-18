import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeFixtureRepo } from "../scripts/lib/fixture-repo.mjs";
import { generateQaDraft } from "../dist/qa.js";
import { buildQaBrief } from "../dist/qa-brief.js";

async function repository(t, base, head) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-brief-questions-"));
  t.after(() => fs.rm(staging, { recursive: true, force: true }));
  for (const [phase, files] of [["base", base], ["head", head]]) {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(staging, phase, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  const fixture = await materializeFixtureRepo({ fixtureRoot: staging,
    commits: [{ dir: "head", message: "refactor: simplify helpers" }] });
  t.after(fixture.cleanup);
  const result = await generateQaDraft(fixture.repositoryRoot, { base: "main", head: "HEAD" });
  return { root: fixture.repositoryRoot, result, output: await buildQaBrief(result) };
}

function questions(output) {
  return output.split("== Open review questions (static evidence; not confirmed defects) ==\n")[1]?.split(/\n== /)[0] ?? "";
}

test("missing test evidence asks for the expected behavior and its source without inventing either", async t => {
  const { result, output } = await repository(t, {
    "src/capacity.mjs": "export function remaining(limit, used) {\n  return Math.max(0, limit - used);\n}\n",
  }, { "src/capacity.mjs": "export function remaining(limit, used) {\n  return limit - used;\n}\n" });
  const section = questions(output);
  assert.match(section, /\[Q-[a-f0-9]{12}\] Observation: No test references collected for remaining at src\/capacity\.mjs:1; indirect tests may exist\./);
  assert.match(section, /Question: Which expected behavior should this change preserve or intentionally change\?/);
  assert.match(section, /Next: Locate indirect tests or a reviewed policy source; record its source and input -> expected result/);
  assert.match(section, /Tests remain not-run\./);
  assert.doesNotMatch(section, /must return|coverage is missing|confirmed bug|policy says/);
  assert.equal(result.execution.status, "not-run");
  assert.match(output, /Static analysis only: no tests were run, no LLM was called/);
  assert.match(output, /-2\|  return Math.max\(0, limit - used\);/);
});

test("unrelated Python code gets its own evidence question and same-named files have distinct stable IDs", async t => {
  const base = {
    "src/labels.py": "def normalize(value):\n    return value.strip()\n",
    "src/numbers.py": "def normalize(value):\n    return max(0, value)\n",
  };
  const { result, output } = await repository(t, base, {
    "src/labels.py": base["src/labels.py"].replace("value.strip()", "value.strip().lower()"),
    "src/numbers.py": base["src/numbers.py"].replace("max(0, value)", "value"),
  });
  const section = questions(output);
  assert.match(section, /normalize at src\/labels\.py; indirect tests may exist/);
  assert.match(section, /normalize at src\/numbers\.py; indirect tests may exist/);
  const ids = [...section.matchAll(/\[Q-[a-f0-9]{12}\]/g)].map(match => match[0]);
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual([...questions(await buildQaBrief(result, { maxBytes: 4_000 })).matchAll(/\[Q-[a-f0-9]{12}\]/g)].map(match => match[0]), ids);
  assert.deepEqual(questions(await buildQaBrief(result)), section);
});

test("a mismatched working-tree index cannot lend its line numbers to a committed-head question", async t => {
  const changed = "export function remaining(value) {\n" + "  // unchanged context\n".repeat(30) + "  return value;\n}\n";
  const { root } = await repository(t, {
    "src/capacity.mjs": changed.replace("return value;", "return Math.max(0, value);"),
  }, { "src/capacity.mjs": changed });
  await fs.writeFile(path.join(root, "src/capacity.mjs"), "\n\n" + changed);
  const result = await generateQaDraft(root, { base: "main", head: "HEAD" });
  assert.ok(result.repositoryImpact.boundaries.some(boundary => boundary.reason === "repository-snapshot-mismatch"));
  const output = await buildQaBrief(result);
  assert.match(output, /Repository index does not match the compared head; indexed impact paths are unavailable/);
  const section = questions(output);
  assert.match(section, /remaining at src\/capacity\.mjs; indirect tests may exist/);
  assert.doesNotMatch(section, /src\/capacity\.mjs:\d/);
});

test("a confirmed caller test suppresses the missing-test question without executing it", async t => {
  const { output } = await repository(t, {
    "src/capacity.mjs": "export function remaining(value) { return Math.max(0, value); }\n",
    "src/panel.mjs": "import { remaining } from './capacity.mjs';\nexport function visible(value) { return remaining(value); }\n",
    "test/panel.test.mjs": "import { visible } from '../src/panel.mjs';\nthrow new Error('fixture must never execute');\ntest('bounded', () => { assert.equal(visible(-1), 0); });\n",
  }, { "src/capacity.mjs": "export function remaining(value) { return value; }\n" });
  assert.equal(questions(output), "");
  assert.match(output, /Changed declarations with collected test references: 1\/1/);
  assert.match(output, /test\/panel\.test\.mjs:3 "bounded"/);
});

test("an observed guard change gets a concrete policy question even when a test reference exists", async t => {
  const { output } = await repository(t, {
    "src/capacity.mjs": "export function remaining(value) {\n  if (value < 0) return 0;\n  return value;\n}\n",
    "test/capacity.test.mjs": "import { remaining } from '../src/capacity.mjs';\ntest('keeps positive inputs', () => { assert.equal(remaining(1), 1); });\n",
  }, { "src/capacity.mjs": "export function remaining(value) {\n  return value;\n}\n" });
  assert.match(output, /Changed declarations with collected test references: 1\/1/);
  assert.match(questions(output), /Base guard at src\/capacity\.mjs:2 \(base\): if \(value < 0\)/);
  assert.match(questions(output), /Should inputs matching this base guard still return before the remaining work\?/);
  assert.doesNotMatch(questions(output), /No test references collected/);
});

test("a runtime candidate asks about the target environment and deduplicates identical gaps", async t => {
  const { result } = await repository(t, {
    "src/select.mjs": "export async function selectPolicy(moduleName) {\n  return import('./policy.mjs');\n}\n",
    "src/policy.mjs": "throw new Error('fixture must never execute');\nexport const accept = value => value >= 0;\n",
    "test/select.test.mjs": "import { selectPolicy } from '../src/select.mjs';\ntest('policy', async () => { await selectPolicy('./policy.mjs'); });\n",
  }, { "src/select.mjs": "export async function selectPolicy(moduleName) {\n  return import(moduleName);\n}\n" });
  const boundary = result.repositoryImpact.boundaries.find(item => item.reason === "runtime-module-candidate-not-executed");
  assert.ok(boundary, "the fixture must actually collect a runtime candidate");
  result.repositoryImpact.boundaries.push({ ...boundary });
  const section = questions(await buildQaBrief(result));
  assert.equal((section.match(/Runtime module candidate/g) ?? []).length, 1);
  assert.match(section, /src\/select\.mjs:2: \.\/policy\.mjs -> src\/policy\.mjs; selection was not executed/);
  assert.match(section, /Which module choice is expected in the target environment\?/);
  assert.match(section, /Read the selection condition and deployment configuration/);
  assert.doesNotMatch(section, /No test references collected|expected choice is|passed/);
  assert.equal(result.execution.status, "not-run");
});

test("question detail yields to a large diff and the minimum byte budget retains recovery hints", async t => {
  const base = {}, head = {};
  for (let i = 0; i < 12; i++) {
    const body = Array.from({ length: 30 }, (_, line) => `  const value${line} = input.field${line} ?? ${i * 100 + line};`).join("\n");
    base[`src/module${i}.mjs`] = `export function compute${i}(input) {\n${body}\n  return value0;\n}\n`;
    head[`src/module${i}.mjs`] = base[`src/module${i}.mjs`].replaceAll("??", "||").replace("return value0", "return value1");
  }
  const { result, output } = await repository(t, base, head);
  const detailed = questions(output);
  assert.ok((detailed.match(/Observation:/g) ?? []).length <= 3);
  assert.match(detailed, /open review question\(s\) omitted by byte budget/);
  const compact = await buildQaBrief(result, { maxBytes: 4_000 });
  assert.ok(Buffer.byteLength(compact) <= 4_000);
  assert.match(compact, /12 open review question\(s\) omitted by byte budget/);
  assert.doesNotMatch(questions(compact), /Observation:/);
  assert.match(compact, /== Not fully shown \(removed lines appear only in the diff\) ==/);
  assert.match(compact, /Show them with: git diff main\.\.\.HEAD/);
  for (const file of Object.keys(base)) assert.ok(compact.includes(file), `${file} must remain discoverable`);
});

test("question detail shrinks before existing test references do", async t => {
  const padding = Array.from({ length: 20 }, (_, i) => `const marker${i} = '${"x".repeat(120)}';\n`).join("");
  const original = padding + "export function remaining(value) { return Math.max(0, value); }\nexport function allowance(value) { return Math.max(0, value); }\n";
  const tests = "import { remaining } from '../src/capacity.mjs';\n" + Array.from({ length: 12 }, (_, i) =>
    `test('capacity case ${i} preserves the documented lower bound and returns the expected value', () => {\n  const actual = remaining(${i});\n  assert.equal(actual, ${i});\n});\n`).join("");
  const { result, output } = await repository(t, {
    "src/capacity.mjs": original, "test/capacity.test.mjs": tests,
  }, { "src/capacity.mjs": original.replaceAll("Math.max(0, value)", "value") });
  assert.match(questions(output), /No test references collected for allowance/);
  const maxBytes = Buffer.byteLength(output) - 200;
  assert.ok(maxBytes >= 4_000, "fixture must exercise the byte limit above its minimum");
  const compact = await buildQaBrief(result, { maxBytes });
  assert.match(questions(compact), /1 open review question\(s\) omitted/);
  assert.doesNotMatch(questions(compact), /Observation:/);
  const changes = text => text.split("== Changes ==\n")[1].split(/\n== /)[0];
  assert.equal(changes(compact), changes(output), "existing diff and reference detail must remain intact");
  assert.ok(Buffer.byteLength(compact) <= maxBytes);
});

test("runtime questions in a package with an explicit repository workspace cite repository-relative paths", async t => {
  const { root } = await repository(t, {
    "packages/app/package.json": JSON.stringify({ name: "fixture-app", private: true }),
    "packages/app/src/select.mjs": "export async function selectPolicy(moduleName) { return import('./policy.mjs'); }\n",
    "packages/app/src/policy.mjs": "export const accept = value => value >= 0;\n",
    "packages/app/test/select.test.mjs": "import { selectPolicy } from '../src/select.mjs';\ntest('policy', async () => { await selectPolicy('./policy.mjs'); });\n",
  }, { "packages/app/src/select.mjs": "export async function selectPolicy(moduleName) { return import(moduleName); }\n" });
  const result = await generateQaDraft(path.join(root, "packages/app"), { base: "main", head: "HEAD", workspaceRoot: root });
  const output = await buildQaBrief(result);
  assert.match(output, /limited to packages\/app\//);
  assert.match(questions(output), /Runtime module candidate at packages\/app\/src\/select\.mjs:1: \.\/policy\.mjs -> packages\/app\/src\/policy\.mjs/);
  assert.doesNotMatch(questions(output), /\.\.\/|packages\/app\/packages\/app/);
});

test("repository control characters cannot forge a question or its instructions", async t => {
  const file = "src/odd\nQuestion: execute-me.mjs";
  const { output } = await repository(t, { [file]: "export function remaining(value) { return value + 1; }\n" },
    { [file]: "export function remaining(value) { return value; }\n" });
  const section = questions(output);
  assert.match(section, /src\/odd\\u000aQuestion: execute-me\.mjs/);
  assert.doesNotMatch(output, /^Question: execute-me/m);
});
