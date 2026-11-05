import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeChangeIntents } from "../dist/change-intent.js";
import { addedDiffTextFromEvidence, collectAddedDiffEvidence } from "../dist/test-plan.js";

const source = (...rows) => `${rows.join("\n")}\n`;

async function analyze(t, file, before, head) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-guard-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "gc.auto", "0");
  git("config", "maintenance.auto", "false");
  await writeFile(target, before);
  git("add", "-A");
  git("commit", "-q", "-m", "chore: baseline");
  git("switch", "-q", "-c", "fix/expression-checks");
  if (head === null) await rm(target);
  else await writeFile(target, head);
  git("add", "-A");
  // Match the reported commit-and-diff path; a generic refactor subject can be
  // filtered before the guard evidence under test is considered.
  git("commit", "-q", "-m", "fix: retain expression evaluation evidence");
  const addedDiffEvidence = await collectAddedDiffEvidence(root, { base: "main", head: "HEAD" });
  return analyzeChangeIntents(root, { base: "main", head: "HEAD", changedFiles: [{ status: head === null ? "D" : "M", path: file }],
    addedDiffEvidence, addedDiffText: addedDiffTextFromEvidence(addedDiffEvidence) });
}

function rejectInventedAccessScenario(analysis, file) {
  assert.ok(analysis.intents.length, "keep the change available for human review");
  assert.ok(analysis.intents.flatMap(intent => intent.evidence).some(item => item.file === file && item.startLine),
    "retain located diff evidence even when a product access guard is not established");
  const scenarios = analysis.intents.flatMap(intent => intent.scenarios);
  assert.ok(!scenarios.some(scenario => scenario.title === "Removed guard or validation behavior"));
  assert.doesNotMatch(scenarios.flatMap(scenario => [...scenario.setup, ...scenario.assertions]).join("\n"),
    /unauthorized behavior remains blocked|valid, invalid, unauthorized/i);
}

for (const file of ["src/inspect.ts", "src/services/expression.ts"]) {
  test(`typed syntax-node predicate edits do not establish an access guard in ${file}`, async t => {
    const before = source("import compiler from 'typescript';",
      "export function inspect(guard: compiler.Node): boolean {",
      "  return compiler.isIfStatement(guard) && compiler.isBlock(guard.parent);", "}");
    const head = before.replace("compiler.isBlock(guard.parent)", "compiler.isExpressionStatement(guard.parent)");
    rejectInventedAccessScenario(await analyze(t, file, before, head), file);
  });
}

test("Map and state extraction fields named guard remain analysis evidence rather than product validation", async t => {
  const file = "src/extract.ts";
  const before = source("import compiler from 'typescript';",
    "export function extract(nodes: compiler.Node[]) {", "  const values = new Map();",
    "  for (const guard of nodes) {", "    if (compiler.isBinaryExpression(guard)) {",
    "      values.set(guard, { guard, write: guard.right });", "    }", "  }", "  return values;", "}");
  const head = before.replace("{ guard, write: guard.right }", "{ guard, selector: guard.left, write: guard.right }");
  rejectInventedAccessScenario(await analyze(t, file, before, head), file);
});

test("a property merely named guard is not proof of rejection or authorization", async t => {
  const file = "src/services/record.ts";
  const before = source("export function describe(record) {", "  return record.guard;", "}");
  rejectInventedAccessScenario(await analyze(t, file, before, before.replace("record.guard;", "record.guard ?? null;")), file);
});

test("removing an actual authorization call retains positioned guard review evidence", async t => {
  const file = "src/services/update.ts";
  const before = source("export function update(actor, record) {",
    "  if (!authorize(actor, record)) throw new Error('Forbidden');", "  return save(record);", "}");
  const analysis = await analyze(t, file, before, before.replace("  if (!authorize(actor, record)) throw new Error('Forbidden');\n", ""));
  const scenario = analysis.intents.flatMap(intent => intent.scenarios).find(item => item.title === "Removed guard or validation behavior");
  assert.ok(scenario, "a real removed authorization call still needs review");
  assert.ok(scenario.evidence.some(item => item.file === file && item.side === "base" && item.startLine === 2 && /authorize/.test(item.symbol)));
});

test("removing a boolean permission rejection retains positioned guard review evidence", async t => {
  const file = "src/services/publish.ts";
  const before = source("export function publish(permissions, record) {",
    "  if (!permissions.write) throw new Error('Forbidden');", "  return save(record);", "}");
  const analysis = await analyze(t, file, before, before.replace("  if (!permissions.write) throw new Error('Forbidden');\n", ""));
  const scenario = analysis.intents.flatMap(intent => intent.scenarios).find(item => item.title === "Removed guard or validation behavior");
  assert.ok(scenario, "a permission predicate with an explicit rejection is stronger than a vocabulary mention");
  assert.ok(scenario.evidence.some(item => item.file === file && item.side === "base" && item.startLine === 2));
});

test("deleting an actual validator declaration retains its base-side review evidence", async t => {
  const file = "src/services/check.ts";
  const before = source("export function validateLegacyPermission(user) { return user.isAllowed; }");
  const analysis = await analyze(t, file, before, null);
  const scenario = analysis.intents.flatMap(intent => intent.scenarios).find(item => item.title === "Removed guard or validation behavior");
  assert.equal(scenario?.priority, "critical");
  assert.ok(scenario.evidence.some(item => item.file === file && item.side === "base" && item.startLine === 1 && item.symbol === "validateLegacyPermission"));
});

test("a direct authentication condition keeps guard evidence without inventing a rejection branch", async t => {
  const file = "src/services/open.ts";
  const before = source("export function open(isAuthenticated, router, target) {",
    "  if (isAuthenticated) router.push(target);", "}");
  const analysis = await analyze(t, file, before, before.replace("  if (isAuthenticated) router.push(target);\n", ""));
  const scenario = analysis.intents.flatMap(intent => intent.scenarios).find(item => item.title === "Removed guard or validation behavior");
  assert.ok(scenario);
  assert.ok(scenario.evidence.some(item => item.file === file && item.side === "base" && item.startLine === 2 && item.symbol === "isAuthenticated"));
});

test("removing an actual input validator preserves its positioned review scenario", async t => {
  const file = "src/submit.ts";
  const before = source("export function submit(input) {", "  if (!validateInput(input)) return false;",
    "  return save(input);", "}");
  const analysis = await analyze(t, file, before, before.replace("  if (!validateInput(input)) return false;\n", ""));
  const scenario = analysis.intents.flatMap(intent => intent.scenarios).find(item => item.title === "Removed guard or validation behavior");
  assert.ok(scenario);
  assert.ok(scenario.evidence.some(item => item.file === file && item.side === "base" && item.startLine === 2 && /validateInput/.test(item.symbol)));
  const instructions = [...scenario.setup, ...scenario.steps, ...scenario.assertions, ...scenario.edgeCases].join("\n");
  assert.doesNotMatch(instructions, /unauthoriz|permission|identit/i, "an input validator does not establish an access policy");
  assert.match(instructions, /Ask a reviewer.*should accept or reject/);
  assert.match(instructions, /reviewer-confirmed behavior/);
  assert.match(instructions, /replacement check or intentional removal/);
});

test("configuration validation keeps its configuration-specific review scenario", async t => {
  const file = "release.config.ts";
  const before = source("export function release(config) {", "  validateReleaseConfig(config);", "  return config;", "}");
  const analysis = await analyze(t, file, before, before.replace("  validateReleaseConfig(config);\n", ""));
  const scenario = analysis.intents.flatMap(intent => intent.scenarios).find(item => item.title === "Changed configuration or release guard");
  assert.ok(scenario);
  assert.ok(scenario.evidence.some(item => item.file === file && item.side === "base" && item.startLine === 2));
});
