import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeBranchDivergence } from "../dist/branch-divergence.js";
import { generateQaDraft } from "../dist/qa.js";

test("reports target-only behavior that overlaps a proposed branch change", async (t) => {
  const root = await makeRepo(t);
  const file = "src/navigation/header.ts";
  await write(root, file, "export const headerMode = 'standard';\n");
  commit(root, "chore: baseline");

  branch(root, "feature/compact-header");
  await write(root, file, "export const headerMode = 'compact';\n");
  commit(root, "feat: add compact header mode");

  git(root, "switch", "main");
  await write(root, file, "export const headerMode = 'safe-default';\n");
  commit(root, "fix: preserve the safe header default");
  git(root, "switch", "feature/compact-header");

  const analysis = await analyzeBranchDivergence({
    root,
    base: "main",
    head: "HEAD",
  });

  assert.equal(analysis.intents.length, 1);
  const [intent] = analysis.intents;
  assert.equal(intent.files[0], file);
  assert.match(intent.title, /preserve target-branch behavior/i);
  assert.equal(intent.reviewRequired, true);
  assert.equal(intent.scenarios[0].priority, "critical");
  assert.equal(intent.scenarios[0].reviewRequired, true);
  assert.ok(intent.evidence.some((item) =>
    item.kind === "diff" && item.file === file && item.side === "base" && item.startLine === 1
  ));
  assert.ok(intent.evidence.some((item) =>
    item.kind === "diff" && item.file === file && item.side === "head" && item.startLine === 1
  ));
  assert.ok(intent.evidence.some((item) =>
    item.file === file && item.side === "base" && /safe header default/i.test(item.value)
  ));
  assert.ok(intent.evidence.some((item) =>
    item.file === file && item.side === "head" && /compact header mode/i.test(item.value)
  ));

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  assert.equal(qa.execution.status, "not-run");
  assert.ok(qa.changeAnalysis.intents.some((candidate) => candidate.id === intent.id));
  assert.ok(qa.traces.some((trace) =>
    /preserves target-only and proposed behavior/i.test(trace.scenario.title)
  ));
});

test("does not report diverged branches that change different behavior files", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/navigation/header.ts", "export const headerMode = 'standard';\n");
  await write(root, "src/navigation/sidebar.ts", "export const sidebarMode = 'standard';\n");
  commit(root, "chore: baseline");

  branch(root, "feature/compact-header");
  await write(root, "src/navigation/header.ts", "export const headerMode = 'compact';\n");
  commit(root, "feat: add compact header mode");

  git(root, "switch", "main");
  await write(root, "src/navigation/sidebar.ts", "export const sidebarMode = 'safe-default';\n");
  commit(root, "fix: preserve the safe sidebar default");
  git(root, "switch", "feature/compact-header");

  const analysis = await analyzeBranchDivergence({ root, base: "main", head: "HEAD" });

  assert.deepEqual(analysis.intents, []);
});

test("does not report independently committed patch-equivalent changes", async (t) => {
  const root = await makeRepo(t);
  const file = "src/navigation/header.ts";
  await write(root, file, "export const headerMode = 'standard';\n");
  commit(root, "chore: baseline");

  branch(root, "feature/safe-header");
  await write(root, file, "export const headerMode = 'safe-default';\n");
  commit(root, "feat: use the safe header default");

  git(root, "switch", "main");
  await write(root, file, "export const headerMode = 'safe-default';\n");
  commit(root, "fix: preserve the safe header default");
  git(root, "switch", "feature/safe-header");

  const analysis = await analyzeBranchDivergence({ root, base: "main", head: "HEAD" });

  assert.deepEqual(analysis.intents, []);
});

test("does not report a normal branch whose target is its ancestor", async (t) => {
  const root = await makeRepo(t);
  const file = "src/navigation/header.ts";
  await write(root, file, "export const headerMode = 'standard';\n");
  commit(root, "chore: baseline");

  branch(root, "feature/compact-header");
  await write(root, file, "export const headerMode = 'compact';\n");
  commit(root, "feat: add compact header mode");

  const analysis = await analyzeBranchDivergence({ root, base: "main", head: "HEAD" });

  assert.deepEqual(analysis.intents, []);
});

test("does not turn documentation-only branch divergence into product QA", async (t) => {
  const root = await makeRepo(t);
  const file = "docs/integration.md";
  await write(root, file, "# Integration\n\nShared guidance.\n");
  commit(root, "docs: add integration guidance");

  branch(root, "docs/feature-guidance");
  await write(root, file, "# Integration\n\nFeature branch guidance.\n");
  commit(root, "docs: explain feature integration");

  git(root, "switch", "main");
  await write(root, file, "# Integration\n\nTarget branch guidance.\n");
  commit(root, "docs: clarify target integration");
  git(root, "switch", "docs/feature-guidance");

  const analysis = await analyzeBranchDivergence({ root, base: "main", head: "HEAD" });

  assert.deepEqual(analysis.intents, []);
});

async function makeRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-branch-divergence-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "qamap@example.test");
  git(root, "config", "user.name", "QAMap Test");
  git(root, "config", "gc.auto", "0");
  git(root, "config", "maintenance.auto", "false");
  await write(root, "package.json", JSON.stringify({ type: "module" }, null, 2) + "\n");
  return root;
}

async function write(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
}

function branch(root, name) {
  git(root, "switch", "-c", name);
}

function git(root, ...args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}
