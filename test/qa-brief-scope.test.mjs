import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeFixtureRepo } from "../scripts/lib/fixture-repo.mjs";
import { generateQaDraft } from "../dist/qa.js";
import { buildQaBrief } from "../dist/qa-brief.js";

async function repository(t, base, head) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-scope-"));
  t.after(() => fs.rm(staging, { recursive: true, force: true }));
  for (const [dir, files] of [["base", base], ["head", head ?? {}]]) {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(staging, dir, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  const fixture = await materializeFixtureRepo({ fixtureRoot: staging,
    commits: head ? [{ dir: "head", message: "refactor: simplify helper" }] : [] });
  t.after(fixture.cleanup);
  return fixture.repositoryRoot;
}
const brief = async (root, options = {}) => buildQaBrief(await generateQaDraft(root, { base: "main", head: "HEAD", ...options }));
const hint = /No committed change between main and HEAD; uncommitted edits exist\. Add --include-working-tree to review them\./;

test("an empty committed diff distinguishes clean, edited and included working trees", async t => {
  const original = "export function allowance(value) { return Math.max(0, value); }\n";
  const root = await repository(t, { "src/capacity.mjs": original });
  assert.doesNotMatch(await brief(root), hint);
  await fs.writeFile(path.join(root, "src/capacity.mjs"), original.replace("Math.max(0, value)", "value"));
  assert.match(await brief(root), hint);
  const local = await brief(root, { includeWorkingTree: true });
  assert.doesNotMatch(local, hint);
  assert.match(local, /1 changed files/);
  assert.match(local, /-1\|export function allowance.*Math.max/);
});

test("an untracked file also produces an actionable empty-diff hint", async t => {
  const root = await repository(t, { "README.md": "Fixture\n" });
  await fs.writeFile(path.join(root, "new.mjs"), "export const allowance = 1;\n");
  assert.match(await brief(root), hint);
  assert.doesNotMatch(await brief(root, { includeWorkingTree: true }), hint);
});

test("the empty-diff hint stays within an explicitly selected literal package path", async t => {
  const file = "export function allowance(value) { return value; }\n";
  const root = await repository(t, { "packages/[app]/value.mjs": file, "packages/lib/value.mjs": file });
  const selected = path.join(root, "packages/[app]");
  await fs.writeFile(path.join(root, "packages/lib/value.mjs"), file.replace("value;", "value + 1;"));
  assert.doesNotMatch(await brief(selected), hint);
  await fs.writeFile(path.join(selected, "value.mjs"), file.replace("value;", "value + 2;"));
  assert.match(await brief(selected), hint);
});

test("a nonempty committed diff does not report an empty-range hint", async t => {
  const original = "export function allowance(value) { return Math.max(0, value); }\n";
  const root = await repository(t, { "value.mjs": original }, { "value.mjs": original.replace("Math.max(0, value)", "value") });
  await fs.writeFile(path.join(root, "value.mjs"), original.replace("Math.max(0, value)", "value + 1"));
  const output = await brief(root);
  assert.doesNotMatch(output, hint);
  assert.match(output, /1 changed files/);
});

test("direct package analysis aligns Git paths, index paths, contracts and runtime candidates", async t => {
  const root = await repository(t, {
    "packages/app/package.json": JSON.stringify({ name: "fixture-app", private: true }),
    "packages/app/src/select.mjs": "export async function selectPolicy(moduleName) { return import('./policy.mjs'); }\n",
    "packages/app/src/policy.mjs": "export const accept = value => value >= 0;\n",
    "packages/app/test/select.test.mjs": "import { selectPolicy } from '../src/select.mjs';\ntest('explicit module choice', async () => { await selectPolicy('./policy.mjs'); });\n",
    "packages/lib/value.mjs": "export const value = 1;\n",
  }, {
    "packages/app/src/select.mjs": "export async function selectPolicy(moduleName) { return import(moduleName); }\n",
    "packages/lib/value.mjs": "export const value = 2;\n",
  });
  const result = await generateQaDraft(path.join(root, "packages/app"), { base: "main", head: "HEAD" });
  assert.equal(result.analysisScope.mode, "explicit-package");
  assert.equal(result.analysisScope.workspaceRoot, await fs.realpath(root));
  assert.ok(result.repositoryImpact.boundaries.some(item => item.reason === "runtime-module-candidate-not-executed" && item.file === "packages/app/src/select.mjs"));
  assert.ok(result.repositoryImpact.boundaries.every(item => item.reason !== "changed-file-not-indexed"));
  const output = await buildQaBrief(result);
  assert.match(output, /limited to packages\/app\//);
  assert.match(output, /Runtime module candidate at packages\/app\/src\/select\.mjs:1/);
  assert.doesNotMatch(output, /### packages\/lib\/value/);
  assert.equal(result.execution.status, "not-run");
});
