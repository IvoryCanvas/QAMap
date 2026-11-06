import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { analyzeChangeIntents } from "../dist/change-intent.js";
import { collectAddedDiffEvidence, addedDiffTextFromEvidence } from "../dist/test-plan.js";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
const git = (root, ...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function put(root, file, text) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), text);
}
function commit(root, message) { git(root, "add", "."); git(root, "commit", "-qm", message); }
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-intent-history-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(directory, "origin");
  await fs.mkdir(root);
  git(root, "init", "-qb", "main");
  return { root, directory };
}
async function analyze(root, files, extra = {}) {
  const options = { base: "main", head: "HEAD", ...extra };
  const evidence = await collectAddedDiffEvidence(root, options);
  return analyzeChangeIntents(root, { ...options,
    changedFiles: files.map(file => ({ status: "M", path: file })),
    addedDiffEvidence: evidence, addedDiffText: addedDiffTextFromEvidence(evidence) });
}
const before = "export function finishRefresh(mode, result) {\n  return result;\n}\n";
const after = "export function finishRefresh(mode, result) {\n  if (mode === 'paused') return result.catch(() => undefined);\n  return result;\n}\n";

test("shallow merged history cannot turn an unrelated boundary subject into the PR's QA intent", async t => {
  const { root, directory } = await fixture(t);
  await put(root, "src/refresh.mjs", before);
  await put(root, "src/panel.mjs", "export const hints = [];\n");
  commit(root, "chore: baseline");
  await put(root, "src/panel.mjs", "export const hints = ['visible'];\n");
  commit(root, "fix: show matching hints and validate selected rows");
  const unrelated = git(root, "rev-parse", "HEAD");
  git(root, "branch", "feature/refresh");
  for (let index = 0; index < 5; index++) {
    await put(root, "README.md", "Shared notes " + index + "\n");
    commit(root, "docs: update shared notes");
  }
  const base = git(root, "rev-parse", "main");
  git(root, "switch", "-q", "feature/refresh");
  await put(root, "src/refresh.mjs", after);
  commit(root, "fix: handle errors from paused refreshes");
  git(root, "merge", "--no-ff", "-qm", "Merge main", "main");
  const clone = path.join(directory, "shallow");
  git(directory, "clone", "-q", "--depth=3", "--single-branch", "--branch=feature/refresh", pathToFileURL(root).href, clone);
  git(clone, "branch", "main", base);
  assert.equal(git(clone, "show", "-s", "--format=%P", unrelated), "", "the unrelated commit is a shallow boundary");
  const analysis = await analyze(clone, ["src/refresh.mjs"]);
  assert.ok(analysis.intents.some(intent => /paused refresh/i.test(intent.title)));
  assert.ok(analysis.intents.every(intent => !/matching hints|selected rows/i.test(intent.title)));
  assert.ok(!analysis.commits.some(commit => commit.sha === unrelated));
  assert.ok(analysis.diagnostics.some(message => /parent|boundary/i.test(message)));
});

test("a reverted side change cannot seed an intent for the remaining source delta", async t => {
  const { root } = await fixture(t);
  await put(root, "src/refresh.mjs", before);
  await put(root, "src/panel.mjs", "export const hints = [];\n");
  commit(root, "chore: baseline");
  git(root, "switch", "-qc", "feature/refresh");
  await put(root, "src/panel.mjs", "export const hints = ['visible'];\n");
  commit(root, "fix: show matching hints and validate selected rows");
  await put(root, "src/panel.mjs", "export const hints = [];\n");
  commit(root, "refactor: restore the panel baseline");
  await put(root, "src/refresh.mjs", after);
  commit(root, "fix: handle errors from paused refreshes");
  const analysis = await analyze(root, ["src/refresh.mjs"]);
  assert.ok(analysis.intents.some(intent => /paused refresh/i.test(intent.title)));
  assert.ok(analysis.intents.every(intent => !/matching hints|selected rows/i.test(intent.title)));
});

test("a complete branch merge retains both real feature intents and their changed files", async t => {
  const { root } = await fixture(t);
  await put(root, "src/refresh.mjs", before);
  await put(root, "src/panel.mjs", "export const hints = [];\n");
  commit(root, "chore: baseline");
  git(root, "switch", "-qc", "feature/panel");
  await put(root, "src/panel.mjs", "export const hints = ['visible'];\n");
  commit(root, "feat: show matching hints for selected rows");
  git(root, "switch", "-qc", "feature/refresh", "main");
  await put(root, "src/refresh.mjs", after);
  commit(root, "fix: handle errors from paused refreshes");
  git(root, "merge", "--no-ff", "-qm", "Merge feature/panel", "feature/panel");
  const analysis = await analyze(root, ["src/refresh.mjs", "src/panel.mjs"]);
  assert.ok(analysis.intents.some(intent => /paused refresh/i.test(intent.title)));
  assert.ok(analysis.intents.some(intent => /matching hints/i.test(intent.title)));
  assert.equal(analysis.commits.length, 2, "second-parent feature evidence remains valid in complete history");
});
