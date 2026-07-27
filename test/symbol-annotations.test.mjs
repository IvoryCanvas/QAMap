import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectChangedQaSymbolAnnotations,
  parseQaSymbolAnnotations,
} from "../dist/symbol-annotations.js";
import { collectAddedDiffEvidence } from "../dist/test-plan.js";

test("parses QAMap JSDoc tags attached to a named exported symbol", () => {
  const source = [
    "/**",
    " * Submit one campaign application.",
    " *",
    " * @qamapFlow campaign-application",
    " * @qamapStage action Submit the application",
    " * @qamapOutcome Application status becomes submitted",
    " * @qamapRisk Duplicate submission",
    " */",
    "export async function submitApplication(input) {",
    "  return saveApplication(input);",
    "}",
    "",
  ].join("\n");

  const result = parseQaSymbolAnnotations("src/application.ts", source);

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.annotations.length, 1);
  assert.deepEqual(result.annotations[0], {
    file: "src/application.ts",
    symbol: "submitApplication",
    declarationKind: "function",
    declarationStartLine: 9,
    declarationEndLine: 11,
    commentStartLine: 1,
    commentEndLine: 8,
    flows: [{ value: "campaign-application", line: 4 }],
    stages: [{
      kind: "action",
      value: "action Submit the application",
      label: "Submit the application",
      line: 5,
    }],
    outcomes: [{ value: "Application status becomes submitted", line: 6 }],
    risks: [{ value: "Duplicate submission", line: 7 }],
  });
});

test("accepts decorators and normalizes documented lifecycle aliases", () => {
  const source = [
    "/**",
    " * @qamapFlow workspace/settings",
    " * @qamapStage transition Persist the selected workspace",
    " * @qamapStage effect Publish the workspace update",
    " */",
    "@trace({ kind: 'settings' })",
    "export class WorkspaceSettings {",
    "  save() {}",
    "}",
    "",
  ].join("\n");

  const result = parseQaSymbolAnnotations("src/settings.ts", source);

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.annotations[0].declarationStartLine, 7);
  assert.deepEqual(
    result.annotations[0].stages.map((stage) => stage.kind),
    ["state-change", "side-effect"],
  );
});

test("reports malformed or stale annotations instead of silently consuming them", () => {
  const source = [
    "/**",
    " * @qamapFlows checkout",
    " * @qamapFlow checkout flow",
    " * @qamapStage submit",
    " * @qamapOutcome",
    " */",
    "const submitCheckout = () => true;",
    "",
  ].join("\n");

  const result = parseQaSymbolAnnotations("src/checkout.ts", source);

  assert.equal(result.annotations.length, 0);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ["unknown-tag", "unattached"],
  );
});

test("applies an existing annotation only when its exported symbol changed", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "src/actions.ts",
    [
      "/**",
      " * @qamapFlow campaign-application",
      " * @qamapStage action Submit the application",
      " * @qamapOutcome Application status becomes submitted",
      " * @qamapRisk Duplicate submission",
      " */",
      "export async function submitApplication(input) {",
      "  return saveApplication(input);",
      "}",
      "",
      "/**",
      " * @qamapFlow campaign-list",
      " * @qamapOutcome Campaign label is visible",
      " */",
      "export function formatCampaignLabel(campaign) {",
      "  return campaign.name;",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/campaign-application");
  await write(
    root,
    "src/actions.ts",
    [
      "/**",
      " * @qamapFlow campaign-application",
      " * @qamapStage action Submit the application",
      " * @qamapOutcome Application status becomes submitted",
      " * @qamapRisk Duplicate submission",
      " */",
      "export async function submitApplication(input) {",
      "  return saveApplication({ ...input, source: 'campaign-detail' });",
      "}",
      "",
      "/**",
      " * @qamapFlow campaign-list",
      " * @qamapOutcome Campaign label is visible",
      " */",
      "export function formatCampaignLabel(campaign) {",
      "  return campaign.name;",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: preserve campaign application source");

  const addedDiffEvidence = await collectAddedDiffEvidence(root, { base: "main", head: "HEAD" });
  const result = await collectChangedQaSymbolAnnotations(root, {
    head: "HEAD",
    changedFiles: [{ status: "M", path: "src/actions.ts" }],
    addedDiffEvidence,
  });

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.annotations.length, 1);
  assert.equal(result.annotations[0].symbol, "submitApplication");
  assert.equal(result.annotations[0].changedLine, 8);
  assert.deepEqual(result.annotations[0].flows.map((flow) => flow.value), ["campaign-application"]);
});

test("does not turn an annotation-only diff into changed behavior evidence", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "src/profile.ts",
    [
      "export function saveProfile(input) {",
      "  return persistProfile(input);",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "docs/profile-qa-context");
  await write(
    root,
    "src/profile.ts",
    [
      "/**",
      " * @qamapFlow profile-save",
      " * @qamapOutcome Profile changes are visible",
      " */",
      "export function saveProfile(input) {",
      "  return persistProfile(input);",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "docs: annotate profile QA context");

  const addedDiffEvidence = await collectAddedDiffEvidence(root, { base: "main", head: "HEAD" });
  const result = await collectChangedQaSymbolAnnotations(root, {
    head: "HEAD",
    changedFiles: [{ status: "M", path: "src/profile.ts" }],
    addedDiffEvidence,
  });

  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.annotations.length, 0);
});

async function makeRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-symbol-annotations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "qamap@example.test");
  git(root, "config", "user.name", "QAMap Test");
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
