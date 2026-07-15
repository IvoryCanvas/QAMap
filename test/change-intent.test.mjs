import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeChangeIntents } from "../dist/change-intent.js";
import { generateE2eDraft, generateE2ePlan } from "../dist/e2e.js";
import { formatAgentQaDraft, formatMarkdownQaDraft, generateQaDraft } from "../dist/qa.js";
import { routeQaScenario } from "../dist/scenario-routing.js";
import {
  addedDiffTextFromEvidence,
  collectAddedDiffEvidence,
} from "../dist/test-plan.js";

test("diff evidence preserves renamed paths and head-side hunk locations", async (t) => {
  const root = await makeRepo(t);
  const original = [
    "export const preferences = {};",
    "export const timezone = 'UTC';",
    "export const locale = 'en';",
  ].join("\n") + "\n";
  await write(root, "src/old-preferences.ts", original);
  commit(root, "benchmark baseline");
  branch(root, "feat/preferences-save");

  git(root, "mv", "src/old-preferences.ts", "src/preferences.ts");
  await write(
    root,
    "src/preferences.ts",
    `${original}export function onSubmitPreferences() { return savePreferences(); }\n`,
  );
  commit(root, "feat: save account preferences");

  const evidence = await collectAddedDiffEvidence(root, { base: "main", head: "HEAD" });
  const hunk = evidence["src/preferences.ts"][0];

  assert.equal(hunk.previousFile, "src/old-preferences.ts");
  assert.equal(hunk.startLine, 4);
  assert.equal(hunk.endLine, 4);
  assert.match(hunk.hunkHeader, /^@@ /);
  assert.match(hunk.lines[0].text, /onSubmitPreferences/);
  assert.deepEqual(hunk.removedLines, []);
});

test("diff evidence traces removed guards to base-side critical QA", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "src/profile.ts",
    [
      "export function saveProfile(user, input) {",
      "  validatePermission(user);",
      "  validateProfile(input);",
      "  return persistProfile(input);",
      "}",
    ].join("\n") + "\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/profile-save");
  await write(
    root,
    "src/profile.ts",
    [
      "export function saveProfile(user, input) {",
      "  return persistProfile(input);",
      "}",
    ].join("\n") + "\n",
  );
  commit(root, "fix: simplify profile save behavior");

  const evidence = await collectAddedDiffEvidence(root, { base: "main", head: "HEAD" });
  const hunk = evidence["src/profile.ts"][0];
  const analysis = await analyze(root, ["src/profile.ts"]);
  const scenario = analysis.intents[0].scenarios.find((item) => /removed guard or validation/i.test(item.title));

  assert.deepEqual(hunk.removedLines.map((line) => line.line), [2, 3]);
  assert.ok(scenario);
  assert.equal(scenario.priority, "critical");
  assert.equal(scenario.confidence, "medium");
  assert.ok(scenario.evidence.every((item) => item.side === "base"));
  assert.ok(scenario.evidence.every((item) => item.relation === "direct"));
  assert.ok(scenario.evidence.some((item) => item.startLine === 2 && /permission/i.test(item.symbol)));
});

test("diff evidence preserves a fully deleted validation file", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "src/legacy-guard.ts",
    "export function validateLegacyPermission(user) { return user.isAllowed; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/remove-legacy-guard");
  await rm(path.join(root, "src/legacy-guard.ts"));
  commit(root, "fix: remove legacy authorization guard");

  const evidence = await collectAddedDiffEvidence(root, { base: "main", head: "HEAD" });
  const analysis = await analyze(root, ["src/legacy-guard.ts"]);
  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const scenario = analysis.intents[0].scenarios.find((item) => /removed guard or validation/i.test(item.title));

  assert.equal(evidence["src/legacy-guard.ts"][0].lines.length, 0);
  assert.equal(evidence["src/legacy-guard.ts"][0].removedLines[0].line, 1);
  assert.equal(scenario?.priority, "critical");
  assert.ok(scenario?.evidence.some((item) => item.side === "base" && item.file === "src/legacy-guard.ts"));
  assert.ok(plan.changedFiles.some((file) => file.status === "D" && file.path === "src/legacy-guard.ts"));
  assert.ok(plan.changeAnalysis.intents[0].scenarios.some((item) => /removed guard or validation/i.test(item.title)));
});

test("removed app configuration guards produce environment QA instead of identity QA", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "app.config.ts",
    "const assertProductionReleaseConfig = () => validateProductionEnv();\nassertProductionReleaseConfig();\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/release-config");
  await write(
    root,
    "app.config.ts",
    "const assertReleaseConfig = () => validateEnvironmentMatrix();\nassertReleaseConfig();\n",
  );
  commit(root, "fix: support QA and production release configuration");

  const analysis = await analyze(root, ["app.config.ts"]);
  const configScenario = analysis.intents[0].scenarios.find((item) => /configuration or release guard/i.test(item.title));

  assert.ok(configScenario);
  assert.equal(configScenario.priority, "critical");
  assert.ok(configScenario.assertions.some((assertion) => /endpoints, channel, and application identity/i.test(assertion)));
  assert.equal(analysis.intents[0].scenarios.some((item) => /unauthorized access/i.test(item.edgeCases.join(" "))), false);
});

test("context-only scenario evidence stays review-only and non-critical", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/settings.ts", "export const settingsLabel = 'Account';\n");
  commit(root, "benchmark baseline");
  branch(root, "fix/settings-redirect");
  await write(root, "src/settings.ts", "export const settingsLabel = 'Profile';\n");
  commit(root, "fix: redirect account after settings update");

  const analysis = await analyze(root, ["src/settings.ts"]);
  const scenario = analysis.intents[0].scenarios.find((item) => /destination routing/i.test(item.title));

  assert.ok(scenario);
  assert.equal(scenario.priority, "recommended");
  assert.equal(scenario.confidence, "low");
  assert.equal(scenario.reviewRequired, true);
  assert.ok(scenario.evidence.every((item) => item.relation === "contextual"));
  const routing = routeQaScenario(scenario);
  assert.equal(routing.decision, "review-only");
  assert.equal(routing.requiredEvidence.length, 0);
  assert.ok(routing.referenceEvidence.length > 0);
  assert.match(routing.reason, /no direct or supporting diff hunk/i);
});

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
  assert.ok(intent.evidence.some((item) => item.kind === "diff" && item.startLine && item.hunkHeader));
  assert.ok(intent.scenarios.every((scenario) => scenario.confidence));
  assert.ok(intent.scenarios.every((scenario) => scenario.evidence.length > 0));
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

test("state updates and navigation options do not fabricate calendar or routing QA", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/editor.tsx", "export function Editor() { return null; }\n");
  commit(root, "benchmark baseline");
  branch(root, "fix/editor-header");
  await write(
    root,
    "src/editor.tsx",
    "export function Editor({ navigation }) { navigation.setOptions({ title: 'Edit link' }); return null; }\n",
  );
  commit(root, "fix: update editor header labels");

  const analysis = await analyze(root, ["src/editor.tsx"]);
  const scenarioTitles = analysis.intents.flatMap((intent) => intent.scenarios.map((scenario) => scenario.title));

  assert.equal(analysis.intents.length, 1);
  assert.equal(scenarioTitles.some((title) => /Scheduling, calendar|destination routing/i.test(title)), false);
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

test("change intent falls back to committed diff signals when commit text is not behavior-bearing", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/pages/billing.tsx", "export function Billing() { return null; }\n");
  commit(root, "benchmark baseline");
  branch(root, "fix/billing-summary");
  await write(
    root,
    "src/pages/billing.tsx",
    [
      "export function Billing() {",
      '  const [status, setStatus] = useState("");',
      "  async function openBilling() {",
      '    const response = await fetch("/api/billing/summary");',
      '    setStatus(response.ok ? "Billing loaded" : "Could not load billing");',
      "  }",
      '  return <button onClick={openBilling}>Open billing</button>;',
      "}",
    ].join("\n"),
  );
  commit(root, "load billing summary");

  const analysis = await analyze(root, ["src/pages/billing.tsx"]);
  const intent = analysis.intents[0];
  const networkScenario = intent?.scenarios.find((scenario) => /failure, timeout, and retry/i.test(scenario.title));

  assert.equal(analysis.source, "diff-only");
  assert.equal(analysis.intents.length, 1);
  assert.equal(intent.commits.length, 0);
  assert.equal(intent.confidence, "low");
  assert.equal(intent.reviewRequired, true);
  assert.match(intent.summary, /commit text did not express a usable intent/i);
  assert.ok(intent.lifecycle.some((stage) => stage.kind === "trigger"));
  assert.ok(intent.lifecycle.some((stage) => stage.kind === "state-change"));
  assert.ok(intent.lifecycle.some((stage) => stage.kind === "side-effect"));
  assert.equal(intent.scenarios.find((scenario) => scenario.kind === "primary")?.priority, "recommended");
  assert.ok(networkScenario);
  assert.equal(routeQaScenario(networkScenario).decision, "recommended");
  assert.equal(intent.scenarios.some((scenario) => /entry payload/i.test(scenario.title)), false);
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
  const qaMarkdown = formatMarkdownQaDraft(qa);
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
  assert.ok(draft.files[0].scenarioAutomation.length > 0);
  assert.ok(draft.files[0].scenarioAutomation.every((receipt) => receipt.decision));
  const calendarScenario = plan.changeAnalysis.intents[0].scenarios.find((scenario) => /calendar/i.test(scenario.title));
  assert.ok(calendarScenario?.evidence.some((item) => item.symbol?.toLowerCase() === "timezone" && item.startLine));
  assert.match(agentSummary.intents[0].title, /Submit account preferences/i);
  assert.ok(agentSummary.intents[0].sources.some((source) => source.file && source.startLine));
  assert.ok(agentSummary.intents[0].lifecycle.some((stage) => stage.phase === "state-change"));
  assert.equal(agentSummary.intents[0].scenarioCount, plan.changeAnalysis.intents[0].scenarios.length);
  assert.ok(agentSummary.intents[0].omittedScenarioCount > 0);
  const agentCalendarScenario = agentSummary.intents[0].scenarios.find((scenario) => /calendar/i.test(scenario.title));
  assert.match(agentCalendarScenario.sources[0].symbol, /timezone/i);
  assert.equal(agentCalendarScenario.sources[0].relation, "direct");
  assert.equal(agentCalendarScenario.sources[0].side, "head");
  assert.ok(agentSummary.intents[0].scenarios.every((scenario) => scenario.confidence));
  assert.ok(agentSummary.intents[0].scenarios.every((scenario) => scenario.sources.length > 0));
  assert.ok(agentSummary.intents[0].scenarios.every((scenario) => scenario.routing?.decision));
  assert.ok(agentSummary.intents[0].scenarios.every((scenario) => scenario.automation?.status));
  assert.ok(agentSummary.scenarioCoverage.required >= 1);
  assert.match(qaMarkdown, /Source: `src\/pages\/preferences\.tsx:\d+` symbol/);
  assert.match(qaMarkdown, /confidence: (?:medium|high)/);
  assert.match(qaMarkdown, /Scenario routing:/);
  assert.match(qaMarkdown, /E2E mapping:/);
  assert.match(qaMarkdown, /## Optional Automation/);
  assert.doesNotMatch(qaMarkdown, /Install command|First E2E Draft Bootstrap/);
  assert.match(spec, /Change intent evidence:/);
  assert.match(spec, /Behavior lifecycle:/);
  assert.match(spec, /Failure, timeout, and retry handling/);

  const oversizedQa = structuredClone(qa);
  oversizedQa.changeAnalysis.intents = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(qa.changeAnalysis.intents[0]),
    title: `${qa.changeAnalysis.intents[0].title} ${index} ${"intent".repeat(40)}`,
  }));
  oversizedQa.flows = Array.from({ length: 20 }, (_, index) => ({
    ...structuredClone(qa.flows[0]),
    title: `${qa.flows[0].title} ${index} ${"flow".repeat(40)}`,
    changedFiles: Array.from({ length: 12 }, (__, fileIndex) => `src/${"nested/".repeat(20)}file-${fileIndex}.tsx`),
    draftSteps: Array.from({ length: 12 }, (__, stepIndex) => `Step ${stepIndex} ${"detail ".repeat(50)}`),
    selectorHints: Array.from({ length: 12 }, (__, selectorIndex) => `[data-testid="${"selector".repeat(20)}-${selectorIndex}"]`),
  }));
  const compactAgentOutput = formatAgentQaDraft(oversizedQa);
  const compactAgentSummary = JSON.parse(compactAgentOutput);
  assert.ok(Buffer.byteLength(compactAgentOutput) <= 4 * 1024);
  assert.equal(compactAgentSummary.intentCount, 12);
  assert.equal(compactAgentSummary.flowCount, 20);
  assert.equal(compactAgentSummary.omittedIntentCount, 12 - compactAgentSummary.intents.length);
  assert.equal(compactAgentSummary.omittedFlowCount, 20 - compactAgentSummary.flows.length);
  assert.ok(compactAgentSummary.intents.length > 0);
  assert.ok(compactAgentSummary.flows.length > 0);
  assert.ok(compactAgentSummary.compaction);

  const pathologicalQa = structuredClone(oversizedQa);
  pathologicalQa.base = `refs/heads/${"base-segment/".repeat(1000)}`;
  pathologicalQa.head = `refs/heads/${"head-segment/".repeat(1000)}`;
  pathologicalQa.manifestPath = `${"manifest/".repeat(1000)}qamap.yaml`;
  const boundedAgentOutput = formatAgentQaDraft(pathologicalQa);
  const boundedAgentSummary = JSON.parse(boundedAgentOutput);
  assert.ok(Buffer.byteLength(boundedAgentOutput) <= 4 * 1024);
  assert.equal(boundedAgentSummary.schema.name, "qamap.qa");
  assert.ok(boundedAgentSummary.intents.length > 0);
  assert.ok(boundedAgentSummary.flows.length > 0);
});

test("evidence-routed failure QA becomes a separate partial Playwright scenario without domain rules", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({
      scripts: { dev: "vite", "test:e2e": "playwright test" },
      dependencies: { react: "19.0.0", vite: "7.0.0", "@playwright/test": "1.56.0" },
    }),
  );
  await write(root, "playwright.config.ts", "export default { use: { baseURL: 'http://127.0.0.1:4173' } };\n");
  await write(
    root,
    "src/pages/jobs/index.tsx",
    [
      "export function JobsPage() {",
      "  async function submitJob() { return fetch('/api/jobs', { method: 'POST' }); }",
      "  return <button data-testid=\"job-submit\" onClick={submitJob}>Submit job</button>;",
      "}",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/job-submission-feedback");

  await write(
    root,
    "src/pages/jobs/index.tsx",
    [
      "export function JobsPage() {",
      "  const [status, setStatus] = useState('');",
      "  async function submitJob() {",
      "    const response = await fetch('/api/jobs', { method: 'POST' });",
      "    setStatus(response.ok ? 'Job queued' : 'Could not queue job');",
      "  }",
      "  return <main>",
      "    <button data-testid=\"job-submit\" onClick={submitJob}>Submit job</button>",
      "    <p>{status}</p>",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: show job submission response and retry feedback");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const failureScenario = file.scenarioAutomation.find((receipt) => receipt.kind === "failure");
  assert.ok(failureScenario);
  assert.equal(failureScenario.decision, "recommended");
  assert.equal(failureScenario.status, "partial");
  assert.equal(failureScenario.mappedSteps, 1);
  assert.equal(failureScenario.mappedAssertions, 1);
  assert.ok(failureScenario.requiredSourceCount > 0);

  const spec = await readFile(path.join(root, file.path), "utf8");
  assert.match(spec, /Routed QA scenario:/);
  assert.match(spec, /Failure, timeout, and retry handling/);
  assert.match(spec, /page\.route\("\*\*\/api\/jobs"/);
  assert.match(spec, /page\.getByTestId\("job-submit"\)\.click\(\)/);
  assert.match(spec, /page\.getByText\("Could not queue job"\)/);
});

test("evidence-routed failure QA does not reuse an unrelated action selector", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({
      scripts: { dev: "vite", "test:e2e": "playwright test" },
      dependencies: { react: "19.0.0", vite: "7.0.0", "@playwright/test": "1.56.0" },
    }),
  );
  await write(root, "playwright.config.ts", "export default { use: { baseURL: 'http://127.0.0.1:4173' } };\n");
  await write(
    root,
    "src/pages/jobs/index.tsx",
    [
      "export function JobsPage() {",
      "  async function queueJob() { return fetch('/api/jobs', { method: 'POST' }); }",
      "  return <main>",
      "    <button data-testid=\"settings-open\">Open settings</button>",
      "    <p>Could not load settings</p>",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/job-submission-feedback");

  await write(
    root,
    "src/pages/jobs/index.tsx",
    [
      "export function JobsPage() {",
      "  const [status, setStatus] = useState('');",
      "  async function queueJob() {",
      "    const response = await fetch('/api/jobs', { method: 'POST' });",
      "    setStatus(response.ok ? 'Job queued' : 'Could not queue job');",
      "  }",
      "  return <main>",
      "    <button data-testid=\"settings-open\">Open settings</button>",
      "    <p>Could not load settings</p>",
      "    <p>{status}</p>",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: show job submission failure and retry feedback");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const failureScenario = file.scenarioAutomation.find((receipt) => receipt.kind === "failure");
  assert.ok(failureScenario);
  assert.equal(failureScenario.decision, "recommended");
  assert.equal(failureScenario.status, "not-compiled");

  const spec = await readFile(path.join(root, file.path), "utf8");
  assert.doesNotMatch(spec, /Routed QA scenario:/);
});

test("Vue conditional actions retain changed UI evidence without unrelated payment setup", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({
      scripts: { dev: "vite", "test:e2e": "playwright test" },
      dependencies: { vue: "3.5.0", vite: "7.0.0", "@playwright/test": "1.56.0" },
    }),
  );
  await write(root, "playwright.config.ts", "export default { use: { baseURL: 'http://127.0.0.1:4173' } };\n");
  await write(
    root,
    "src/pages/documents.vue",
    [
      "<script setup lang=\"ts\">",
      "import { ref } from 'vue';",
      "const subscriptionPlan = 'archived';",
      "const isImportReady = ref(false);",
      "</script>",
      "<template><main><h1>Documents</h1><p>Choose a document</p></main></template>",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/document-import");

  await write(
    root,
    "src/pages/documents.vue",
    [
      "<script setup lang=\"ts\">",
      "import { computed, ref } from 'vue';",
      "const subscriptionPlan = 'archived';",
      "const isImportReady = ref(false);",
      "const isImportComplete = ref(false);",
      "const actionLabel = computed(() => isImportReady.value ? 'Import document' : 'Request access');",
      "function startImport() {",
      "  if (!isImportReady.value) return;",
      "  const params = new URLSearchParams({ source: 'documents' });",
      "  isImportComplete.value = true;",
      "  window.location.href = `/documents/imported?${params.toString()}`;",
      "}",
      "</script>",
      "<template>",
      "  <main>",
      "    <h1>Documents</h1>",
      "    <button type=\"button\" @click=\"startImport\">{{ actionLabel }}</button>",
      "    <p v-if=\"isImportComplete\">Document imported</p>",
      "  </main>",
      "</template>",
    ].join("\n"),
  );
  commit(root, "feat: import document and show completion state");

  const analysis = await analyze(root, ["src/pages/documents.vue"]);
  assert.ok(
    analysis.intents[0].lifecycle.some((stage) => /document imported/i.test(stage.label)),
    JSON.stringify({ lifecycle: analysis.intents[0].lifecycle, evidence: analysis.intents[0].evidence }),
  );
  assert.ok(analysis.intents[0].scenarios.some((scenario) => /conditional state and fallback/i.test(scenario.title)));
  assert.ok(analysis.intents[0].scenarios.some((scenario) => /destination path and query parameters/i.test(scenario.title)));

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const selectors = plan.flows.flatMap((flow) => flow.selectors.map((selector) => selector.value));
  const setupTitles = plan.flows.flatMap((flow) => flow.setupHints.map((hint) => hint.title));
  assert.ok(selectors.includes("Import document"));
  assert.ok(selectors.includes("Request access"));
  assert.ok(selectors.includes("Document imported"));
  assert.equal(setupTitles.some((title) => /payment sandbox/i.test(title)), false);

  const draft = await generateE2eDraft(root, { base: "main", head: "HEAD", output: ".generated-e2e" });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const spec = await readFile(path.join(root, file.path), "utf8");
  assert.match(spec, /page\.getByRole\("button", \{ name: "Import document" \}\)\.click\(\)/);
  assert.match(spec, /page\.getByText\("Document imported"\)/);
  assert.doesNotMatch(spec, /page\.locator\("body"\)/);
});

test("React conditional UI produces state QA from changed behavior evidence", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({
      scripts: { dev: "vite", "test:e2e": "playwright test" },
      dependencies: { react: "19.0.0", vite: "7.0.0", "@playwright/test": "1.56.0" },
    }),
  );
  await write(root, "playwright.config.ts", "export default { use: { baseURL: 'http://127.0.0.1:4173' } };\n");
  await write(
    root,
    "src/pages/notifications.tsx",
    "export function NotificationsPage() { return <main><h1>Notifications</h1></main>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/notification-ready-state");

  await write(
    root,
    "src/pages/notifications.tsx",
    [
      "export function NotificationsPage() {",
      "  const [isNotificationReady, setNotificationReady] = useState(false);",
      "  function sendNotification() { setNotificationReady(true); }",
      "  return <main>",
      "    <h1>Notifications</h1>",
      "    <button onClick={sendNotification}>Send notification</button>",
      "    {isNotificationReady && <p>Notification queued</p>}",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: send notification and show queued state");

  const analysis = await analyze(root, ["src/pages/notifications.tsx"]);
  const conditional = analysis.intents[0].scenarios.find((scenario) => /conditional state and fallback/i.test(scenario.title));
  assert.ok(conditional);
  assert.ok(conditional.evidence.some((item) => item.file === "src/pages/notifications.tsx" && item.startLine));

  const draft = await generateE2eDraft(root, { base: "main", head: "HEAD", output: ".generated-e2e" });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const spec = await readFile(path.join(root, file.path), "utf8");
  assert.match(spec, /page\.getByRole\("button", \{ name: "Send notification" \}\)\.click\(\)/);
  assert.match(spec, /page\.getByText\("Notification queued"\)/);
});

test("presentation-only conditions do not become lifecycle QA scenarios", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "src/components/Banner.tsx",
    "export function Banner() { return <p>Account notice</p>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "style/banner-theme");
  await write(
    root,
    "src/components/Banner.tsx",
    [
      "export function Banner() {",
      "  const shouldUseDarkText = true;",
      "  return <p className={shouldUseDarkText ? 'text-dark' : 'text-light'}>Account notice</p>;",
      "}",
    ].join("\n"),
  );
  commit(root, "fix: preserve banner theme contrast");

  const analysis = await analyze(root, ["src/components/Banner.tsx"]);
  assert.equal(analysis.intents.length, 1);
  assert.equal(
    analysis.intents[0].scenarios.some((scenario) => /conditional state and fallback/i.test(scenario.title)),
    false,
  );
});

async function analyze(root, files) {
  const addedDiffEvidence = await collectAddedDiffEvidence(root, { base: "main", head: "HEAD" });
  const addedDiffText = addedDiffTextFromEvidence(addedDiffEvidence);
  return analyzeChangeIntents(root, {
    base: "main",
    head: "HEAD",
    changedFiles: files.map((file) => ({ status: "M", path: file })),
    addedDiffText,
    addedDiffEvidence,
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
