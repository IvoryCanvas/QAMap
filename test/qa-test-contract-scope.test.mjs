import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectAddedDiffEvidence,
  formatAgentQaDraft,
  formatAgentQaFullReport,
  generateQaDraft,
} from "../dist/index.js";

test("merged target tests do not become changed contracts, including in a changed file", async (t) => {
  for (const prefix of ["", "packages/library/"]) {
    await t.test(prefix || "repository root", async (t) => {
      const root = await makeRepo(t);
      const file = `${prefix}test/value.test.mjs`;
      const separator = "// Unchanged separator.\n".repeat(12);
      const upstreamBefore = "test('keeps the default label', () => {});\n";
      const upstreamAfter = "test('keeps the updated label', () => {});\n";
      const feature = "test('preserves the selected value', () => {});\n";
      await put(root, `${prefix}package.json`, JSON.stringify({ scripts: { test: "node --test" } }));
      await put(root, file, upstreamBefore + separator);
      commit(root, "chore: baseline");
      git(root, "switch", "-c", "feat/selected-value");
      await put(root, file, upstreamBefore + separator + feature);
      commit(root, "fix: preserve the selected value");
      git(root, "switch", "main");
      await put(root, file, upstreamAfter + separator);
      await put(root, `${prefix}test/label.test.mjs`, "test('renders the shared label', () => {});\n");
      commit(root, "fix: update the shared label");
      git(root, "switch", "feat/selected-value");
      git(root, "merge", "--no-ff", "main", "-m", "Merge main");

      const target = path.join(root, prefix);
      const options = {
        base: "main", head: "HEAD", automaticWorkspaceScope: false,
        ...(prefix ? { workspaceRoot: root } : {}),
      };
      const qa = await generateQaDraft(target, options);
      assert.deepEqual(qa.changedTestContracts.map(({ title }) => title), ["preserves the selected value"]);
      assert.equal(qa.changedTestContracts[0].file, "test/value.test.mjs");
      const full = JSON.parse(formatAgentQaFullReport(qa));
      const compact = JSON.parse(formatAgentQaDraft(qa));
      assert.equal(full.testContracts.declared, 1);
      assert.equal(compact.testContracts.declared, 1);
      assert.equal(compact.execution.status, "not-run");
      assert.deepEqual(full.evidence.changedTestContracts, qa.changedTestContracts);

      await put(root, `${prefix}test/local.test.mjs`, "test('retains the local draft', () => {});\n");
      const local = await generateQaDraft(target, { ...options, includeWorkingTree: true });
      assert.deepEqual(local.currentDelta.repositoryContracts.map(({ title }) => title), ["retains the local draft"]);
      assert.deepEqual(local.changedTestContracts.map(({ title }) => title), [
        "retains the local draft", "preserves the selected value",
      ]);
      assert.equal(local.execution.status, "not-run");
    });
  }
});

test("restored baseline declarations do not enter changed contracts through latest-commit priority", async (t) => {
  const root = await makeRepo(t);
  const file = "test/value.test.mjs";
  const original = "test('preserves the default value', () => {});\n";
  const separator = "// Unchanged separator.\n".repeat(12);
  await put(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  await put(root, file, original + separator);
  commit(root, "chore: baseline");
  git(root, "switch", "-c", "fix/value-contract");
  await put(root, file, "test('uses a temporary value', () => {});\n" + separator);
  commit(root, "fix: adjust the default value");
  await put(root, file, original + separator + "test('preserves a custom value', () => {});\n");
  commit(root, "fix: restore the default and preserve custom values");

  const options = { base: "main", head: "HEAD" };
  const evidence = await collectAddedDiffEvidence(root, options);
  assert.equal(evidence[file].some((hunk) => hunk.lines.some((line) => line.text.includes("default value"))), false);
  const qa = await generateQaDraft(root, options);
  assert.deepEqual(qa.changedTestContracts.map(({ title }) => title), ["preserves a custom value"]);
  assert.equal(qa.execution.status, "not-run");
});

test("priority evidence keeps current head locations after target-branch insertions", async (t) => {
  const root = await makeRepo(t);
  const file = "test/value.test.mjs";
  const before = "// Unchanged baseline.\n".repeat(20);
  const declaration = "test('preserves the selected value', () => {});\n";
  await put(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  await put(root, file, before);
  commit(root, "chore: baseline");
  git(root, "switch", "-c", "feat/selected-value");
  await put(root, file, before + declaration);
  commit(root, "fix: preserve the selected value");
  git(root, "switch", "main");
  await put(root, file, "// Upstream header.\n".repeat(8) + before);
  commit(root, "chore: add the shared header");
  git(root, "switch", "feat/selected-value");
  git(root, "merge", "--no-ff", "main", "-m", "Merge main");

  const source = await readFile(path.join(root, file), "utf8");
  const expectedLine = source.split("\n").findIndex((line) => line.startsWith("test(")) + 1;
  assert.equal(expectedLine, 29);
  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  assert.deepEqual(qa.changedTestContracts, [{
    file, line: expectedLine, title: "preserves the selected value", framework: "javascript",
  }]);
});

test("current latest-commit contracts still rank ahead of earlier branch contracts", async (t) => {
  const root = await makeRepo(t);
  await put(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  commit(root, "chore: baseline");
  git(root, "switch", "-c", "feat/value-contracts");
  await put(root, "test/a-value.test.mjs", "test('preserves an earlier value', () => {});\n");
  commit(root, "fix: preserve an earlier value");
  await put(root, "test/z-value.test.mjs", "test('preserves the latest value', () => {});\n");
  commit(root, "fix: preserve the latest value");

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  assert.deepEqual(qa.changedTestContracts.map(({ title }) => title), [
    "preserves the latest value", "preserves an earlier value",
  ]);
  assert.equal(qa.execution.status, "not-run");
});

async function makeRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-test-contract-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.test");
  git(root, "config", "core.hooksPath", "/dev/null");
  return root;
}

async function put(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(root, message) {
  git(root, "add", ".");
  git(root, "commit", "-m", message);
}
