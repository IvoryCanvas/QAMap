import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeChangeIntents } from "../dist/change-intent.js";
import { generateE2eDraft, generateE2ePlan } from "../dist/e2e.js";
import { formatAgentQaDraft, generateQaDraft } from "../dist/qa.js";
import { collectAddedDiffText } from "../dist/test-plan.js";

test("change intent clusters related commits into one evidence-backed lifecycle", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/reminder.ts", "export const reminder = false;\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/digest-reminder");

  await write(
    root,
    "src/reminder.ts",
    "export function scheduleDigestReminder() { return notifications.schedule(); }\n",
  );
  commit(root, "feat: schedule a digest reminder after report completion");

  await write(
    root,
    "src/reminder.ts",
    "export function resyncReminder() { setScheduledTime(); return notifications.schedule(); }\n",
  );
  commit(root, "feat: resync the reminder when the report time changes");

  await write(
    root,
    "src/reminder.ts",
    "function reminderKey() { return 'digest'; }\nexport function resyncReminder() { setScheduledTime(); return notifications.schedule(); }\n",
  );
  commit(root, "refactor: extract digest reminder helper");

  await write(
    root,
    "src/reminder.ts",
    "export function openLinkedReport() { return router.push('/reports/current'); }\n",
  );
  commit(root, "feat: open the linked report when the reminder is tapped");

  const analysis = await analyze(root, ["src/reminder.ts"]);

  assert.equal(analysis.source, "commits-and-diff");
  assert.equal(analysis.intents.length, 1);
  const intent = analysis.intents[0];
  assert.equal(intent.confidence, "high");
  assert.match(intent.title, /Schedule a digest reminder after report completion/i);
  assert.equal(intent.commits.length, 4);
  assert.ok(intent.lifecycle.some((stage) => stage.kind === "trigger" && /after report completion/i.test(stage.label)));
  assert.ok(intent.lifecycle.some((stage) => stage.kind === "trigger" && /when the reminder is tapped/i.test(stage.label)));
  assert.ok(intent.lifecycle.some((stage) => stage.kind === "state-change" && /resync/i.test(stage.label)));
  assert.ok(intent.lifecycle.some((stage) => stage.kind === "side-effect" && /schedule/i.test(stage.label)));
  assert.ok(intent.lifecycle.some((stage) => stage.kind === "observable-outcome" && /open the linked report/i.test(stage.label)));
  assert.equal(intent.lifecycle.some((stage) => /helper/i.test(stage.label)), false);
  assert.ok(intent.scenarios.some((scenario) => /calendar.*duplicate/i.test(scenario.title)));
  assert.ok(intent.scenarios.some((scenario) => /destination routing/i.test(scenario.title)));
  assert.ok(intent.evidence.some((item) => item.kind === "commit" && item.commit));
});

test("change intent keeps unrelated feature commits separate", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/profile.ts", "export const profile = {};\n");
  await write(root, "src/archive.ts", "export const archive = {};\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/mixed-work");

  await write(root, "src/profile.ts", "export function submitProfileForm() { return saveProfile(); }\n");
  commit(root, "feat(profile): submit profile form");
  await write(root, "src/archive.ts", "export function exportAuditArchive() { return downloadArchive(); }\n");
  commit(root, "feat(export): export audit archive");

  const analysis = await analyze(root, ["src/profile.ts", "src/archive.ts"]);

  assert.equal(analysis.intents.length, 2);
  assert.ok(analysis.intents.some((intent) => /Submit profile form/i.test(intent.title)));
  assert.ok(analysis.intents.some((intent) => /Export audit archive/i.test(intent.title)));
  assert.ok(analysis.intents.every((intent) => intent.files.length === 1));
});

test("change intent ignores release-only commit metadata", async (t) => {
  const root = await makeRepo(t);
  await write(root, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  commit(root, "benchmark baseline");
  branch(root, "chore/release");
  await write(root, "package.json", '{"name":"fixture","version":"1.0.1"}\n');
  commit(root, "chore: prepare release metadata");

  const analysis = await analyze(root, ["package.json"]);

  assert.equal(analysis.intents.length, 0);
  assert.equal(analysis.source, "none");
  assert.ok(analysis.diagnostics.some((diagnostic) => /did not contain a behavior-bearing/i.test(diagnostic)));
});

test("change intent marks connected working-tree signals as review-required diff evidence", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/form.tsx", "export function Form() { return null; }\n");
  commit(root, "benchmark baseline");

  const analysis = await analyzeChangeIntents(root, {
    base: "main",
    head: "HEAD",
    includeWorkingTree: true,
    changedFiles: [{ status: "M", path: "src/form.tsx" }],
    addedDiffText: {
      "src/form.tsx": [
        "const run = async () => {",
        "function onSubmitProfile() {",
        "  setSavedProfile();",
        "  fetchProfile();",
        "  router.push('/profile');",
        "}",
      ].join("\n"),
    },
  });

  assert.equal(analysis.source, "diff-only");
  assert.equal(analysis.intents.length, 1);
  assert.equal(analysis.intents[0].confidence, "low");
  assert.equal(analysis.intents[0].reviewRequired, true);
  assert.equal(analysis.intents[0].commits.length, 0);
  assert.ok(analysis.intents[0].evidence.every((item) => item.kind === "diff"));
  assert.equal(analysis.intents[0].evidence.some((item) => item.symbol === "async"), false);
});

test("E2E planning promotes commit intent before runner-specific draft generation", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({
      scripts: { dev: "vite", "test:e2e": "playwright test" },
      dependencies: { react: "19.0.0", vite: "7.0.0", "@playwright/test": "1.56.0" },
    }),
  );
  await write(
    root,
    "src/pages/preferences.tsx",
    "export function Preferences() { return <button>Review preferences</button>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/preferences-save");

  await write(
    root,
    "src/pages/preferences.tsx",
    [
      "export function Preferences() {",
      "  async function onSubmitPreferences() {",
      "    await fetch('/api/preferences', { method: 'POST' });",
      "    setSavedTimezone('UTC');",
      "  }",
      "  return <button data-testid=\"preferences-save\" onClick={onSubmitPreferences}>Save preferences</button>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: submit account preferences and persist the selected timezone");

  await write(
    root,
    "src/pages/preferences.tsx",
    [
      "export function Preferences() {",
      "  async function onSubmitPreferences() {",
      "    await fetch('/api/preferences', { method: 'POST' });",
      "    setSavedTimezone('UTC');",
      "  }",
      "  return <main>",
      "    <button data-testid=\"preferences-save\" onClick={onSubmitPreferences}>Save preferences</button>",
      "    <p>Preferences saved</p>",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "fix: show saved preferences after the request completes");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const draft = await generateE2eDraft(root, { base: "main", head: "HEAD", dryRun: true });
  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const agentSummary = JSON.parse(formatAgentQaDraft(qa));
  const writtenDraft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const spec = await readFile(path.join(root, writtenDraft.files[0].path), "utf8");

  assert.equal(plan.changeAnalysis.intents.length, 1);
  assert.match(plan.changeAnalysis.intents[0].title, /Submit account preferences/i);
  assert.equal(plan.flows[0].intentId, plan.changeAnalysis.intents[0].id);
  assert.match(plan.flows[0].title, /Submit account preferences/i);
  assert.doesNotMatch(plan.flows[0].title, /primary journey|smoke flow/i);
  assert.ok(plan.flows[0].steps.some((step) => /persist the selected timezone/i.test(step)));
  assert.ok(plan.flows[0].steps.some((step) => /show saved preferences/i.test(step)));
  assert.match(plan.flows[0].languageBrief.successSignal, /Preferences saved/i);
  assert.ok(plan.behaviorGraph.nodes.some((node) => node.kind === "contract" && node.label === plan.flows[0].title));
  assert.ok(plan.behaviorGraph.nodes.some((node) => node.evidence.some((item) => item.kind === "commit")));
  assert.equal(draft.files[0].source, "change-intent");
  assert.equal(draft.files[0].intentConfidence, "high");
  assert.ok(draft.files[0].qaScenarios.some((scenario) => /failure, timeout, and retry/i.test(scenario.title)));
  assert.match(agentSummary.intents[0].title, /Submit account preferences/i);
  assert.ok(agentSummary.intents[0].lifecycle.some((stage) => stage.phase === "state-change"));
  assert.ok(agentSummary.intents[0].scenarios.some((scenario) => /retry handling/i.test(scenario.title)));
  assert.match(spec, /Change intent evidence:/);
  assert.match(spec, /Behavior lifecycle:/);
  assert.match(spec, /Failure, timeout, and retry handling/);
});

async function analyze(root, files) {
  const addedDiffText = await collectAddedDiffText(root, { base: "main", head: "HEAD" });
  return analyzeChangeIntents(root, {
    base: "main",
    head: "HEAD",
    changedFiles: files.map((file) => ({ status: "M", path: file })),
    addedDiffText,
  });
}

async function makeRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-change-intent-"));
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
