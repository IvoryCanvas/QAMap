import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { analyzeChangeIntents } from "../dist/change-intent.js";
import { generateE2eDraft, generateE2ePlan } from "../dist/e2e.js";
import {
  formatAgentQaDraft,
  formatMarkdownQaDraft,
  formatTextQaDraft,
  generateQaDraft,
} from "../dist/qa.js";
import {
  buildQaReasoningTraces,
  qaTraceIdForScenario,
  summarizeQaTraceEvidence,
} from "../dist/qa-trace.js";
import { routeQaScenario } from "../dist/scenario-routing.js";
import { classifyChangeSourceRole } from "../dist/source-role.js";
import {
  addedDiffTextFromEvidence,
  collectAddedDiffEvidence,
} from "../dist/test-plan.js";

test("QA reasoning traces expose weak links without claiming product execution", () => {
  const commitEvidence = {
    kind: "commit",
    value: "feat: save preferences",
    commit: "abc123",
    relation: "contextual",
  };
  const reviewScenario = {
    id: "scenario:review-only",
    kind: "failure",
    priority: "recommended",
    title: "Failure handling",
    rationale: "Review the failure path.",
    setup: [],
    steps: ["Trigger the failure."],
    assertions: ["Verify the failure remains recoverable."],
    edgeCases: [],
    evidence: [commitEvidence],
  };
  const reviewIntent = {
    id: "intent:review-only",
    title: "Save preferences",
    summary: "Save preferences.",
    confidence: "low",
    commits: [],
    files: ["src/preferences.ts"],
    keywords: ["preferences"],
    evidence: [commitEvidence],
    lifecycle: [{
      id: "stage:review-only",
      kind: "action",
      label: "Save preferences.",
      confidence: "low",
      evidence: [commitEvidence],
      files: ["src/preferences.ts"],
    }],
    scenarios: [reviewScenario],
    reviewRequired: true,
  };

  const [reviewTrace] = buildQaReasoningTraces([reviewIntent], []);
  assert.equal(reviewTrace.id, qaTraceIdForScenario(reviewScenario.id));
  assert.equal(reviewTrace.status, "review-only");
  assert.equal(reviewTrace.evidenceAssessment.disposition, "source-gap");
  assert.equal(reviewTrace.evidenceAssessment.uniqueSourceCount, 1);
  assert.equal(reviewTrace.behavior[0].relation, "evidence-linked");
  assert.equal(reviewTrace.manifestCorrection.kind, "add-or-correct-flow");
  assert.equal(reviewTrace.manifestCorrection.target, ".qamap/manifest.yaml > flows");
  assert.equal(reviewTrace.manifestCorrection.requiresHumanApproval, true);
  assert.equal(reviewTrace.scenario.authority, "qamap-inference");
  assert.equal(reviewTrace.scenario.approvalRequired, true);
  assert.equal(reviewTrace.scenario.testClass, "edge");
  assert.equal(reviewTrace.execution, "not-run");
  assert.ok(reviewTrace.gaps.some((gap) => /No located diff source/.test(gap)));
  assert.ok(reviewTrace.gaps.some((gap) => /No optional automation artifact/.test(gap)));

  const diffEvidence = {
    kind: "diff",
    value: "Changed line invokes savePreferences.",
    file: "src/preferences.ts",
    symbol: "savePreferences",
    relation: "direct",
    side: "head",
    startLine: 12,
    endLine: 12,
  };
  const partialScenario = { ...reviewScenario, id: "scenario:partial", evidence: [diffEvidence] };
  const partialIntent = { ...reviewIntent, id: "intent:partial", scenarios: [partialScenario] };
  const [partialTrace] = buildQaReasoningTraces([partialIntent], [{
    scenarioId: partialScenario.id,
    flowTitle: "Preferences",
    draftPath: "tests/e2e/preferences-review.md",
    status: "not-compiled",
    mappedSteps: 0,
    totalSteps: 1,
    mappedAssertions: 0,
    totalAssertions: 1,
    manifestUpdatePath: ".qamap/manifest.yaml > flows.preferences.anchors",
  }, {
    scenarioId: partialScenario.id,
    flowTitle: "Preferences",
    draftPath: "tests/e2e/preferences.spec.ts",
    status: "compiled",
    mappedSteps: 1,
    totalSteps: 1,
    mappedAssertions: 1,
    totalAssertions: 1,
  }]);
  assert.equal(partialTrace.status, "partial");
  assert.equal(partialTrace.evidenceAssessment.disposition, "mapping-gap");
  assert.equal(partialTrace.behavior[0].relation, "intent-context");
  assert.equal(partialTrace.artifact?.draftPath, "tests/e2e/preferences-review.md");
  assert.equal(partialTrace.artifact?.status, "partial");
  assert.equal(partialTrace.artifact?.flowCount, 2);
  assert.equal(partialTrace.artifact?.compiledFlowCount, 1);
  assert.equal(partialTrace.artifact?.flows.length, 2);
  assert.equal(partialTrace.manifestCorrection.kind, "review-existing");
  assert.equal(partialTrace.manifestCorrection.target, ".qamap/manifest.yaml > flows.preferences.anchors");
  assert.equal(partialTrace.manifestCorrection.candidate.sourceFile, "src/preferences.ts");
  assert.equal(partialTrace.manifestCorrection.candidate.sourceSymbol, "savePreferences");
  assert.equal(partialTrace.manifestCorrection.candidate.sourceLine, 12);
  assert.ok(partialTrace.gaps.some((gap) => /1 of 2 affected flow artifacts/.test(gap)));
  assert.ok(partialTrace.gaps.some((gap) => /No lifecycle stage shares/.test(gap)));

  const evidenceSummary = summarizeQaTraceEvidence([
    partialTrace,
    { ...partialTrace, id: "trace:duplicate-source" },
  ]);
  assert.deepEqual(evidenceSummary, {
    totalTraces: 2,
    confirmed: 0,
    sourceGaps: 0,
    mappingGaps: 2,
    uniqueSources: 1,
  });
});

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

test("working-tree diff evidence includes untracked source with head-side locations", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/existing.ts", "export const existing = true;\n");
  commit(root, "benchmark baseline");
  await write(
    root,
    "src/rules/new-analysis-rule.ts",
    [
      "const schedulingVocabulary = /schedule|calendar/i;",
      "export function analyzeEvidence(value) {",
      "  return schedulingVocabulary.test(value);",
      "}",
    ].join("\n") + "\n",
  );

  const withoutWorkingTree = await collectAddedDiffEvidence(root, {
    base: "main",
    head: "HEAD",
  });
  const evidence = await collectAddedDiffEvidence(root, {
    base: "main",
    head: "HEAD",
    includeWorkingTree: true,
  });
  const hunk = evidence["src/rules/new-analysis-rule.ts"][0];

  assert.equal(withoutWorkingTree["src/rules/new-analysis-rule.ts"], undefined);
  assert.equal(hunk.baseStartLine, 0);
  assert.equal(hunk.startLine, 1);
  assert.equal(hunk.endLine, 4);
  assert.equal(hunk.lines[0].line, 1);
  assert.match(hunk.lines[0].text, /schedulingVocabulary/);
  assert.equal(
    addedDiffTextFromEvidence(evidence)["src/rules/new-analysis-rule.ts"],
    [
      "const schedulingVocabulary = /schedule|calendar/i;",
      "export function analyzeEvidence(value) {",
      "  return schedulingVocabulary.test(value);",
      "}",
      "",
    ].join("\n"),
  );
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

test("calendar view vocabulary does not imply scheduling boundaries", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "src/home-view.tsx",
    "export function HomeView() { return <button>Notebook</button>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/notebook-layout");

  await write(
    root,
    "src/home-view.tsx",
    [
      "import { Calendar } from 'lucide-react';",
      "export function HomeView({ view, setView }) {",
      "  return <button aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>",
      "    <Calendar /> Calendar",
      "  </button>;",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: add compact notebook home layout");

  const analysis = await analyze(root, ["src/home-view.tsx"]);
  const scenarios = analysis.intents.flatMap((intent) => intent.scenarios);

  assert.equal(scenarios.some((scenario) => /scheduling, calendar, and duplicate boundary/i.test(scenario.title)), false);
});

test("instrumentation changes route timing payload and duplicate-event QA", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "src/registration.ts",
    "export async function register() { return submitRegistration(); }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/registration-event");

  await write(
    root,
    "src/registration.ts",
    [
      "export async function register(analyticsClient) {",
      "  const result = await submitRegistration();",
      "  if (result.ok) analyticsClient.track('registration_completed', { source: 'form' });",
      "  return result;",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "fix: restore registration completion instrumentation");

  const analysis = await analyze(root, ["src/registration.ts"]);
  const scenario = analysis.intents
    .flatMap((intent) => intent.scenarios)
    .find((candidate) => /instrumentation event timing, payload, and duplication/i.test(candidate.title));

  assert.ok(scenario);
  assert.equal(scenario.priority, "critical");
  assert.ok(scenario.evidence.some((item) =>
    item.kind === "diff" &&
    item.file === "src/registration.ts" &&
    item.startLine
  ));
  assert.ok(scenario.assertions.some((assertion) => /emitted once/i.test(assertion)));
  assert.ok(scenario.edgeCases.some((edgeCase) => /duplicate callback/i.test(edgeCase)));
});

test("concise QA output shows repeated scenario titles only once", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/preferences.tsx", "export const Preferences = () => <p>Idle</p>;\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/preferences-state");
  await write(
    root,
    "src/preferences.tsx",
    [
      "export function Preferences({ isEnabled }) {",
      "  return isEnabled ? <p>Preferences enabled</p> : <p>Preferences disabled</p>;",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: show the current preferences state");

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  assert.ok(qa.traces.length > 0);
  const original = qa.traces[0];
  const repeated = structuredClone(original);
  repeated.id = `${original.id}:repeated`;
  const independent = structuredClone(original);
  independent.id = `${original.id}:independent`;
  independent.scenario.title = "Independent boundary proof";
  qa.traces = [original, repeated, independent];

  const output = formatTextQaDraft(qa);
  const verifySection = output.split("Verify before merge\n")[1].split("\n\nEvidence")[0];
  assert.equal(verifySection.split(original.scenario.title).length - 1, 1);
  assert.match(verifySection, /Independent boundary proof/);
  assert.match(verifySection, /1 more scenario\(s\) are available in the full report/);
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

test("a broad conventional scope does not merge unrelated product intents", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/share.ts", "export const shareState = 'idle';\n");
  await write(root, "src/preferences.ts", "export const timezone = 'UTC';\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/web-bundle");

  await write(root, "src/share.ts", "export function shareReport() { return navigator.share({ url: '/report' }); }\n");
  commit(root, "feat(web): share the current report");
  await write(root, "src/preferences.ts", "export function saveTimezone() { return persistTimezone('UTC'); }\n");
  commit(root, "feat(web): save account timezone preferences");

  const analysis = await analyze(root, ["src/share.ts", "src/preferences.ts"]);

  assert.equal(analysis.intents.length, 2);
  assert.ok(analysis.intents.some((intent) => /Share the current report/i.test(intent.title)));
  assert.ok(analysis.intents.some((intent) => /Save account timezone preferences/i.test(intent.title)));
});

test("single-keyword bridges do not collapse a long PR into one change intent", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/reminder.ts", "export const reminder = 'idle';\n");
  await write(root, "src/profile.ts", "export const profile = 'idle';\n");
  await write(root, "src/preferences.ts", "export const preferences = 'idle';\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/mixed-product-work");

  await write(root, "src/reminder.ts", "export function scheduleReminder() { return deliverReminder(); }\n");
  commit(root, "feat(web): schedule reminder delivery");
  await write(root, "src/profile.ts", "export function showReminderProfile() { return openProfile(); }\n");
  commit(root, "feat(web): show reminder profile");
  await write(root, "src/preferences.ts", "export function saveProfilePreferences() { return persistPreferences(); }\n");
  commit(root, "feat(web): save profile preferences");

  const analysis = await analyze(root, ["src/reminder.ts", "src/profile.ts", "src/preferences.ts"]);

  assert.equal(analysis.intents.length, 3);
  assert.ok(analysis.intents.some((intent) => /Schedule reminder delivery/i.test(intent.title)));
  assert.ok(analysis.intents.some((intent) => /Show reminder profile/i.test(intent.title)));
  assert.ok(analysis.intents.some((intent) => /Save profile preferences/i.test(intent.title)));
  assert.ok(analysis.intents.every((intent) => intent.commits.length === 1));
  assert.ok(analysis.intents.every((intent) => intent.files.length === 1));
});

test("infrastructure commit keywords do not attach to unrelated product symbols", async (t) => {
  const root = await makeRepo(t);
  await write(root, "turbo.json", '{"globalEnv":[]}\n');
  await write(root, "src/review.tsx", "export function Review() { return null; }\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/mixed-infrastructure-and-product");

  await write(root, "turbo.json", '{"globalEnv":["LINK_DEV_PHASE"]}\n');
  commit(root, "feat(env): enable link dev phase deployment");
  await write(
    root,
    "src/review.tsx",
    "export function Review() { const [phase, setPhase] = useState('review'); return <button onClick={() => setPhase('done')}>{phase}</button>; }\n",
  );
  commit(root, "feat(playground): add review phase control");

  const analysis = await analyze(root, ["turbo.json", "src/review.tsx"]);

  assert.equal(analysis.intents.length, 2);
  const infrastructureIntent = analysis.intents.find((intent) => /Link dev phase deployment/i.test(intent.title));
  const productIntent = analysis.intents.find((intent) => /Add review phase control/i.test(intent.title));
  assert.ok(infrastructureIntent);
  assert.ok(productIntent);
  assert.deepEqual(infrastructureIntent.files, ["turbo.json"]);
  assert.deepEqual(productIntent.files, ["src/review.tsx"]);
  assert.equal(productIntent.commits.some((item) => /link dev phase deployment/i.test(item.subject)), false);
});

test("a related feature title remains primary when an earlier fix shares its diff", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/review.tsx", "export function Review() { return null; }\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/review-view");

  await write(root, "src/review.tsx", "export function Review() { return <main>Ready</main>; }\n");
  commit(root, "fix(web): prepare review UI artifacts");
  await write(
    root,
    "src/review.tsx",
    "export function Review() { const [view, setView] = useState('compare'); return <button onClick={() => setView('usage')}>{view}</button>; }\n",
  );
  commit(root, "feat(web): add component review view");

  const analysis = await analyze(root, ["src/review.tsx"]);

  assert.equal(analysis.intents.length, 1);
  assert.match(analysis.intents[0].title, /Add component review view/i);
  assert.equal(analysis.intents[0].commits.length, 2);
});

test("behavior hidden in a chore commit remains covered beside a feature intent", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/share.ts", "export const shareState = 'idle';\n");
  await write(root, "src/pages/public-entry.tsx", "export function PublicEntry() { return null; }\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/mixed-release");

  await write(
    root,
    "src/share.ts",
    "export async function shareReport() { await navigator.share({ url: '/report' }); showToast('Shared'); }\n",
  );
  commit(root, "feat: share the current report");

  await write(
    root,
    "src/pages/public-entry.tsx",
    [
      "export function PublicEntry({ router, ready }) {",
      "  function openPublicEntry() {",
      "    if (!ready) return;",
      "    window.sessionStorage.setItem('public-entry', 'opened');",
      "    router.push('/public/entry');",
      "    showToast('Public entry opened');",
      "  }",
      "  return <button onClick={openPublicEntry}>Open public entry</button>;",
      "}",
    ].join("\n"),
  );
  commit(root, "chore(web): prepare 3.0.0 release");

  const analysis = await analyze(root, ["src/share.ts", "src/pages/public-entry.tsx"]);

  assert.equal(analysis.source, "commits-and-diff");
  assert.equal(analysis.intents.length, 2);
  assert.ok(analysis.intents.some((intent) => intent.commits.length > 0 && intent.files.includes("src/share.ts")));
  assert.ok(analysis.intents.some((intent) =>
    intent.commits.length === 0 && intent.files.includes("src/pages/public-entry.tsx")
  ));
});

test("static assets do not crowd behavior source out of commit intent evidence", async (t) => {
  const root = await makeRepo(t);
  const assetFiles = Array.from({ length: 24 }, (_, index) => `public/preview/asset-${index}.svg`);
  for (const file of assetFiles) {
    await write(root, file, `<svg><title>${file}</title></svg>\n`);
  }
  await write(root, "src/pages/preview.tsx", "export function Preview() { return null; }\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/public-preview");
  for (const [index, file] of assetFiles.entries()) {
    await write(root, file, `<svg><title>updated-${index}</title></svg>\n`);
  }
  await write(
    root,
    "src/pages/preview.tsx",
    [
      "export function Preview({ router }) {",
      "  async function handleShare() { await navigator.share({ url: '/public/preview' }); }",
      "  function openPreview() { router.push('/public/preview'); showToast('Preview opened'); }",
      "  return <button onClick={openPreview}>Open preview</button>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: open the public preview after sharing");

  const analysis = await analyze(root, [...assetFiles, "src/pages/preview.tsx"]);
  const intent = analysis.intents[0];

  assert.ok(intent.files.includes("src/pages/preview.tsx"));
  assert.equal(intent.files.some((file) => file.endsWith(".svg")), false);
  assert.ok(intent.evidence.some((item) => item.kind === "diff" && item.file === "src/pages/preview.tsx"));
});

test("share icons and playground names do not fabricate share or media lifecycle QA", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/playground.tsx", "export function Playground() { return null; }\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/component-review");
  await write(
    root,
    "src/playground.tsx",
    [
      "import { Share } from './icons';",
      "export function PlaygroundReview() {",
      "  const [view, setView] = useState('preview');",
      "  return <main>",
      "    <button onClick={() => setView('usage')}>Usage review</button>",
      "    <IconButton icon={<Share />} aria-label='Share icon preview' />",
      "    <p>{view}</p>",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: add playground component review view");

  const analysis = await analyze(root, ["src/playground.tsx"]);
  const titles = analysis.intents.flatMap((intent) => intent.scenarios.map((scenario) => scenario.title));

  assert.equal(titles.some((title) => /Share completion/i.test(title)), false);
  assert.equal(titles.some((title) => /Media start/i.test(title)), false);
});

test("source roles distinguish product behavior from commands and analysis rules", () => {
  assert.equal(
    classifyChangeSourceRole(
      "src/services/summaryReminder.ts",
      "export function scheduleReminder() { return notifications.schedule(); }",
    ).role,
    "product",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/rules/rule-engine.ts",
      "const evidencePattern = /schedule|reminder/; export function analyzeEvidence() {}",
    ).role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole("src/cli.ts", "const command = process.argv[2];").role,
    "command",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/source-role.ts",
      "const sourceSignal = /commander|yargs|meow|cac/; export function classifyChangeSourceRole() {}",
    ).role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/test-plan.ts",
      "export async function collectAddedDiffEvidence(): Promise<AddedDiffEvidence> { return {}; }",
    ).role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/repository-plan.ts",
      "export interface TestPlanResult { suggestedCommands: string[] }\nexport function collectChangedFiles(): GitChangedFile[] { return []; }",
    ).role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/git-context.ts",
      "export function resolveBaseRef(value: string) { if (!Number.isFinite(value.length)) throw new Error('invalid ref'); return value; }",
    ).role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/qa-trace.ts",
      "export function buildReasoningTrace(intent, evidence) { return routeQaScenario(intent.scenarios[0]); }",
    ).role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole("src/qa.ts", "if (evidence.sourceRole) source.sourceRole = evidence.sourceRole;").role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/context.ts",
      "Tell the agent to inspect route.nextAction before qa run and never repeat it when execution.performed is true.",
    ).role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole("src/index.ts", "export { classifyChangeSourceRole } from './source-role.js';").role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole(
      "schema/qamap-agent.schema.json",
      '"sourceRole": { "enum": ["product", "analysis-rule"] }',
    ).role,
    "analysis-rule",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/rules/discount.ts",
      "const couponPattern = /^[A-Z]+$/; export function evaluateDiscount(evidence) { return couponPattern.test(evidence.code); }",
    ).role,
    "product",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/features/media/ImageAnalyzer.ts",
      "export function analyzeImage(image) { return image.width > 100; }",
    ).role,
    "product",
  );
  assert.equal(
    classifyChangeSourceRole(
      "src/components/SelectBuilder.ts",
      "export function buildSelect(builder) { return builder.option('compact'); }",
    ).role,
    "product",
  );
  assert.equal(classifyChangeSourceRole("test/fixtures/rule-engine.ts").role, "test");
  assert.equal(classifyChangeSourceRole("bench.config.json").role, "test");
  assert.equal(classifyChangeSourceRole("scripts/bench.mjs").role, "test");
  assert.equal(classifyChangeSourceRole("playwright.config.ts").role, "test");
  assert.equal(classifyChangeSourceRole("vite.config.ts").role, "configuration");
});

test("analysis rules and CLI surfaces receive role-specific QA without product-domain false positives", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "rule-cli", type: "module", bin: { "rule-cli": "dist/cli.js" } }),
  );
  await write(
    root,
    "src/rules/rule-engine.ts",
    "export function analyzeEvidence(source) { return /request/.test(source); }\n",
  );
  await write(
    root,
    "src/cli.ts",
    "const command = process.argv[2]; if (command === 'inspect') console.log('ok');\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/rule-output");
  await write(
    root,
    "src/rules/rule-engine.ts",
    [
      "const schedulingVocabulary = /scheduledAt|reminder|calendar|timezone/i;",
      "const validationVocabulary = /guard|validation|permission/i;",
      "export function analyzeEvidence(source) {",
      "  return {",
      "    request: /request|response/.test(source),",
      "    vocabularyOnly: schedulingVocabulary.test(source) || validationVocabulary.test(source),",
      "  };",
      "}",
    ].join("\n"),
  );
  await write(
    root,
    "src/cli.ts",
    [
      "const [command, ...args] = process.argv.slice(2);",
      "if (command === 'inspect' && args.includes('--format=json')) {",
      "  process.stdout.write(JSON.stringify({ status: 'ok' }));",
      "} else {",
      "  process.stderr.write('usage: inspect --format=json');",
      "  process.exitCode = 2;",
      "}",
    ].join("\n"),
  );
  commit(root, "fix: improve analyzer and command QA precision");

  const analysis = await analyze(root, ["src/rules/rule-engine.ts", "src/cli.ts"]);
  const intent = analysis.intents[0];
  const titles = intent.scenarios.map((scenario) => scenario.title);

  assert.ok(intent.evidence.some((item) => item.sourceRole === "analysis-rule"));
  assert.ok(intent.evidence.some((item) => item.sourceRole === "command"));
  assert.ok(titles.some((title) => /analysis rule positive and negative controls/i.test(title)));
  assert.ok(titles.some((title) => /CLI arguments, output, and exit behavior/i.test(title)));
  assert.equal(titles.some((title) => /Scheduling, calendar|Removed guard|destination routing/i.test(title)), false);
  assert.ok(intent.lifecycle.some((stage) => /stdout, stderr, exit status/i.test(stage.label)));
  assert.ok(
    intent.scenarios
      .flatMap((scenario) => scenario.assertions)
      .some((value) => /command produces the expected stdout, stderr, generated files, and exit status/i.test(value)),
  );
  assert.equal(intent.scenarios.flatMap((scenario) => scenario.assertions).some((value) => /Verify observe/i.test(value)), false);

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const flow = plan.flows.find((candidate) => candidate.intentId === intent.id);
  assert.ok(flow);
  assert.equal(plan.flows.length, 1);
  assert.equal(flow.kind, "command");
  assert.equal(flow.languageBrief.actor, "CLI user or maintainer");
  assert.equal(flow.setupHints.some((hint) => hint.kind === "network" || hint.kind === "fixture"), false);
  assert.equal(flow.fixtureReadiness.status, "not-needed");
  assert.equal(flow.fixtureReadiness.apiEndpoints.length, 0);
});

test("analysis-only changes stay analyzer verification even inside a CLI repository", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "rule-cli", type: "module", bin: { "rule-cli": "dist/cli.js" } }),
  );
  await write(
    root,
    "src/rules/rule-engine.ts",
    "export function analyzeEvidence(source) { return /request/.test(source); }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/rule-boundary");
  await write(
    root,
    "src/rules/rule-engine.ts",
    [
      "const schedulingVocabulary = /scheduledAt|calendar/i;",
      "export function analyzeEvidence(source) {",
      "  return /request/.test(source) && !schedulingVocabulary.test(source);",
      "}",
    ].join("\n"),
  );
  commit(root, "fix: avoid analyzer vocabulary false positives");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const flow = plan.flows.find((candidate) => candidate.intentId);

  assert.ok(flow);
  assert.equal(flow.kind, "domain");
  assert.equal(flow.languageBrief.actor, "Analyzer maintainer or reviewer");
  assert.match(flow.languageBrief.successSignal, /positive controls emit located findings/i);
  assert.equal(flow.languageBrief.successSignal.includes("stdout"), false);
  assert.equal(flow.setupHints.some((hint) => hint.kind === "network" || hint.kind === "fixture"), false);

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const qaMarkdown = formatMarkdownQaDraft(qa);
  assert.equal(qa.flows[0].verificationMode, "analysis-rule");
  assert.equal(qa.readiness.basis, "repository-validation");
  assert.equal(qa.readiness.automationApplicable, false);
  assert.equal(qa.readiness.verificationStatus, "command-needed");
  assert.equal(qa.readiness.requiredScenarioGaps, 0);
  assert.ok(qa.traces.some((trace) =>
    /miss intended evidence or report unrelated behavior/i.test(trace.risk.statement),
  ));
  assert.equal(qa.flows[0].why.some((reason) => /positive, negative, and neighboring-rule controls/i.test(reason)), true);
  assert.equal(qa.prChecklist.some((item) => /manifest init/i.test(item)), false);
  assert.match(qaMarkdown, /Repository verification stage: validation command needed/);
  assert.match(qaMarkdown, /Optional automation readiness: not applicable/);
  assert.doesNotMatch(qaMarkdown, /Automation stage: setup needed/);
  assert.doesNotMatch(qaMarkdown, /- E2E draft mapping:/);
  assert.doesNotMatch(qaMarkdown, /Trace gap: No optional automation artifact/);

  const oversizedQa = structuredClone(qa);
  oversizedQa.changeAnalysis.intents = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(qa.changeAnalysis.intents[0]),
    title: `${qa.changeAnalysis.intents[0].title} ${index} ${"intent".repeat(40)}`,
  }));
  oversizedQa.flows = Array.from({ length: 20 }, (_, index) => ({
    ...structuredClone(qa.flows[0]),
    title: `${qa.flows[0].title} ${index} ${"flow".repeat(40)}`,
    changedFiles: Array.from({ length: 12 }, (__, fileIndex) => `src/${"nested/".repeat(20)}file-${fileIndex}.ts`),
    draftSteps: Array.from({ length: 12 }, (__, stepIndex) => `Step ${stepIndex} ${"detail ".repeat(50)}`),
    selectorHints: Array.from({ length: 12 }, (__, selectorIndex) => `[data-testid="${"selector".repeat(20)}-${selectorIndex}"]`),
  }));
  oversizedQa.base = `refs/heads/${"base-segment/".repeat(1000)}`;
  oversizedQa.head = `refs/heads/${"head-segment/".repeat(1000)}`;
  oversizedQa.manifestPath = `${"manifest/".repeat(1000)}qamap.yaml`;
  const compactOutput = formatAgentQaDraft(oversizedQa);
  const compactSummary = JSON.parse(compactOutput);

  assert.ok(Buffer.byteLength(compactOutput) <= 4 * 1024);
  assert.ok(compactSummary.compaction.lean || compactSummary.compaction.emergency);
  assert.equal(compactSummary.flows[0].verificationMode, "analysis-rule");
  assert.equal(compactSummary.readiness.basis, "repository-validation");
  assert.equal(compactSummary.readiness.automationApplicable, false);
  assert.equal(compactSummary.route.basis, "repository-validation");
  assert.equal(compactSummary.route.status, "verification-command-needed");
  assert.equal(compactSummary.route.nextAction, "define-repository-command");
  assert.equal(compactSummary.scenarioCoverage.automationApplicable, false);
  assert.equal(compactSummary.scenarioCoverage.requiredGaps, 0);
  assert.deepEqual(compactSummary.evidenceSummary, qa.evidenceSummary);
  if (qa.evidenceSummary.sourceGaps + qa.evidenceSummary.mappingGaps > 0) {
    assert.equal(compactSummary.manifestCorrection.requiresHumanApproval, true);
    assert.match(compactSummary.manifestCorrection.target, /\.qamap\/manifest\.yaml/);
  }
  assert.ok(compactSummary.traces.length > 0);
  assert.equal(typeof compactSummary.traces[0].source.file, "string");
  assert.match(compactSummary.traces[0].risk.statement, /miss intended evidence or report unrelated behavior/i);
  assert.ok(compactSummary.intents[0].scenarios[0].sources.length > 0);
  assert.equal(compactSummary.flows[0].source, qa.flows[0].source);
  assert.ok(compactSummary.flows[0].changedFiles.length > 0);
  assert.equal(typeof compactSummary.flows[0].reviewQuestion, "string");
  assert.equal(typeof compactSummary.flows[0].successSignal, "string");
  assert.ok(compactSummary.flows[0].steps.length > 0);
});

test("compacted agent payloads keep identifier values whole and disclose a full report", async (t) => {
  const root = await makeRepo(t);
  const pageFile = "src/deeply/nested/preferences/panels/workspace/settingsPanel.tsx";
  await write(root, "package.json", JSON.stringify({ name: "identifier-app", private: true }));
  await write(root, pageFile, "export const SettingsPanel = () => 'idle';\n");
  commit(root, "chore: baseline");
  branch(root, "feature/long-journey");
  await write(
    root,
    pageFile,
    [
      "export function SettingsPanel(confirmed) {",
      "  if (!confirmed) return 'Confirmation required';",
      "  return 'Workspace density preferences restored';",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: add workspace preferences density reset confirmation banner journey");

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const oversizedQa = structuredClone(qa);
  oversizedQa.changeAnalysis.intents = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(qa.changeAnalysis.intents[0]),
    title: `${qa.changeAnalysis.intents[0].title} ${index} ${"intent".repeat(40)}`,
  }));
  oversizedQa.flows = Array.from({ length: 20 }, (_, index) => ({
    ...structuredClone(qa.flows[0]),
    title: `${qa.flows[0].title} ${index} ${"flow".repeat(40)}`,
    changedFiles: Array.from({ length: 12 }, () => pageFile),
    draftSteps: Array.from({ length: 12 }, (__, stepIndex) => `Step ${stepIndex} ${"detail ".repeat(50)}`),
  }));

  const fullReportPath = path.join(os.tmpdir(), "qamap-test-agent-full-report.json");
  const compactOutput = formatAgentQaDraft(oversizedQa, { fullReportPath });
  const compactSummary = JSON.parse(compactOutput);

  assert.ok(Buffer.byteLength(compactOutput) <= 4 * 1024 - 1);
  assert.ok(compactSummary.compaction, "the oversized payload must have compacted");

  const identifierKeys = new Set([
    "draft",
    "changedFiles",
    "existingEvidence",
    "file",
    "files",
    "commands",
    "selectors",
    "entry",
  ]);
  const partialIdentifiers = [];
  const walk = (node, keyName) => {
    if (typeof node === "string") {
      if (identifierKeys.has(keyName) && node.endsWith("…")) {
        partialIdentifiers.push(`${keyName}: ${node}`);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, keyName);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, value] of Object.entries(node)) walk(value, key);
    }
  };
  walk(compactSummary, "");
  assert.deepEqual(partialIdentifiers, [], "identifier values must never be emitted as partial strings");

  assert.equal(compactSummary.compaction.fullReport, fullReportPath);

  const qaModule = await import("../dist/qa.js");
  assert.equal(typeof qaModule.formatAgentQaFullReport, "function");
  const fullReport = JSON.parse(qaModule.formatAgentQaFullReport(oversizedQa));
  assert.equal(fullReport.schema.name, "qamap.qa");
  assert.equal(fullReport.flows.length >= compactSummary.flows.length, true);
  assert.ok(Buffer.byteLength(JSON.stringify(fullReport)) > 4 * 1024 - 1);
});

test("repository analysis plumbing does not become product boundary QA", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "change-inspector", type: "module", bin: { inspect: "dist/cli.js" } }),
  );
  await write(
    root,
    "src/repository-plan.ts",
    [
      "export interface TestPlanResult { suggestedCommands: string[] }",
      "export function collectChangedFiles(): string[] { return []; }",
    ].join("\n"),
  );
  await write(root, "src/git-context.ts", "export const baseVariables = ['GITHUB_BASE_REF'];\n");
  commit(root, "benchmark baseline");
  branch(root, "fix/repository-analysis");
  await write(
    root,
    "src/repository-plan.ts",
    [
      "export interface TestPlanResult { suggestedCommands: string[]; changedFiles: string[] }",
      "export function collectChangedFiles(): string[] { return []; }",
      "export function discoverSuggestedCommands(serviceName: string): string[] {",
      "  const backgroundService = /(?:worker|scheduler|consumer)/i.test(serviceName);",
      "  return backgroundService ? [] : ['test'];",
      "}",
    ].join("\n"),
  );
  await write(
    root,
    "src/git-context.ts",
    [
      "export const baseVariables = [",
      "  'GITHUB_BASE_REF',",
      "  'BITBUCKET_PR_DESTINATION_BRANCH',",
      "];",
      "export function resolveBaseRef(value: string) {",
      "  if (!Number.isFinite(value.length)) throw new Error('invalid ref');",
      "  return value;",
      "}",
    ].join("\n"),
  );
  commit(root, "fix: improve repository analysis command discovery");

  const analysis = await analyze(root, ["src/repository-plan.ts", "src/git-context.ts"]);
  const titles = analysis.intents.flatMap((intent) => intent.scenarios.map((scenario) => scenario.title));
  const lifecycleLabels = analysis.intents.flatMap((intent) =>
    intent.lifecycle.map((stage) => stage.label),
  );
  const gitContextEvidence = analysis.intents
    .flatMap((intent) => intent.evidence)
    .filter((item) => item.file === "src/git-context.ts");

  assert.ok(analysis.intents.flatMap((intent) => intent.evidence).some((item) => item.sourceRole === "analysis-rule"));
  assert.ok(gitContextEvidence.length > 0);
  assert.ok(gitContextEvidence.every((item) => item.sourceRole === "analysis-rule"));
  assert.equal(lifecycleLabels.some((label) => /\bis finite\b/i.test(label)), false);
  assert.ok(lifecycleLabels.some((label) => /positive and negative controls/i.test(label)));
  assert.ok(titles.some((title) => /analysis rule positive and negative controls/i.test(title)));
  assert.equal(titles.some((title) => /Scheduling, calendar/i.test(title)), false);
  assert.equal(titles.some((title) => /Destination path|destination routing/i.test(title)), false);
  assert.equal(titles.some((title) => /Changed conditional state and fallback/i.test(title)), false);
  assert.equal(titles.some((title) => /Failure, timeout, and retry handling/i.test(title)), false);
});

test("agent execution contract generators do not become product state-transition QA", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "agent-context-generator", type: "module", bin: { inspect: "dist/cli.js" } }),
  );
  await write(
    root,
    "src/context.ts",
    "export function generateInstructions() { return 'Run repository validation before handoff.'; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/agent-validation-receipt");
  await write(
    root,
    "src/context.ts",
    [
      "export function generateInstructions() {",
      "  return [",
      "    'Inspect route.nextAction before qa run.',",
      "    'Apply the agent execution policy before repository code execution.',",
      "    'Do not repeat validation when execution.performed is true.',",
      "  ].join('\\n');",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: add bounded agent validation receipt");

  const analysis = await analyze(root, ["src/context.ts"]);
  const evidence = analysis.intents.flatMap((intent) => intent.evidence);
  const titles = analysis.intents.flatMap((intent) => intent.scenarios.map((scenario) => scenario.title));

  assert.ok(evidence.some((item) =>
    item.file === "src/context.ts" && item.sourceRole === "analysis-rule"
  ));
  assert.equal(titles.some((title) => /state transition|persisted state|re-entry/i.test(title)), false);
  assert.ok(titles.some((title) => /analysis rule positive and negative controls/i.test(title)));
});

test("package API exports do not imply network failure QA", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/index.ts", "export { parseRecord } from './record.js';\n");
  commit(root, "benchmark baseline");
  branch(root, "fix/package-api");
  await write(
    root,
    "src/index.ts",
    "export { parseRecord, formatRecord } from './record.js';\n",
  );
  commit(root, "fix: export package root API");

  const analysis = await analyze(root, ["src/index.ts"]);
  const titles = analysis.intents.flatMap((intent) => intent.scenarios.map((scenario) => scenario.title));

  assert.ok(analysis.intents.some((intent) => /export package root API/i.test(intent.title)));
  assert.equal(titles.some((title) => /Failure, timeout, and retry handling/i.test(title)), false);
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

test("persisted record date validation does not fabricate scheduling QA", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/storage.ts", "export const readStoredRecords = () => []\n");
  commit(root, "benchmark baseline");
  branch(root, "fix/storage-validation");
  await write(
    root,
    "src/storage.ts",
    [
      "const parseStoredTimestamp = (value) =>",
      "  (typeof value === 'string' || typeof value === 'number') &&",
      "  !Number.isNaN(new Date(value).getTime());",
      "export const readStoredRecords = (records) => records.filter((record) => parseStoredTimestamp(record.createdAt));",
    ].join("\n"),
  );
  commit(root, "fix: reject not a number persisted records");

  const analysis = await analyze(root, ["src/storage.ts"]);
  const scenarioTitles = analysis.intents.flatMap((intent) => intent.scenarios.map((scenario) => scenario.title));

  assert.equal(analysis.intents.length, 1);
  assert.equal(scenarioTitles.some((title) => /Scheduling, calendar/i.test(title)), false);
  assert.ok(scenarioTitles.some((title) => /persisted context|re-entry|stale state/i.test(title)));
  const lifecycleLabels = analysis.intents.flatMap((intent) => intent.lifecycle.map((stage) => stage.label));
  assert.ok(lifecycleLabels.some((label) => /not a number/i.test(label)));
  assert.equal(lifecycleLabels.some((label) => /na n/i.test(label)), false);
});

test("recording the current server timestamp does not fabricate scheduling QA", async (t) => {
  const root = await makeRepo(t);
  await write(root, "src/audit.py", "def record_consent():\n    return None\n");
  commit(root, "benchmark baseline");
  branch(root, "feat/consent-audit");
  await write(
    root,
    "src/audit.py",
    "def record_consent():\n    consent_agreed_at = timezone.now()\n    return consent_agreed_at\n",
  );
  commit(root, "feat: record consent audit timestamp");

  const analysis = await analyze(root, ["src/audit.py"]);
  const scenarioTitles = analysis.intents.flatMap((intent) => intent.scenarios.map((scenario) => scenario.title));

  assert.equal(analysis.intents.length, 1);
  assert.equal(scenarioTitles.some((title) => /Scheduling, calendar/i.test(title)), false);
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

test("release-shaped web changes recover diff-first sharing, access, time, media, and storage QA", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }),
  );
  await write(root, "src/components/PreviewLanding/index.tsx", "export function PreviewLanding() { return null; }\n");
  await write(root, "src/lib/availability.ts", "export const isAvailable = () => false;\n");
  await write(root, "src/lib/scopedContext.ts", "export const captureContext = () => {};\n");
  await write(root, "src/middleware.ts", "export function middleware() { return requireLogin(); }\n");
  await write(root, "src/pages/public/preview.tsx", "export function PublicPreview() { return null; }\n");
  commit(root, "benchmark baseline");
  branch(root, "chore/web-release");

  await write(
    root,
    "src/components/PreviewLanding/index.tsx",
    [
      "export function PreviewLanding({ onOpen }) {",
      "  const audioRef = useRef(null);",
      "  async function handleShare() {",
      "    try {",
      "      await navigator.share({ url: getCanonicalShareUrl(window.location.origin) });",
      "    } catch {",
      "      await navigator.clipboard.writeText(getCanonicalShareUrl(window.location.origin));",
      "    }",
      "  }",
      "  async function handlePlayback() {",
      "    if (audioRef.current?.paused) await audioRef.current.play();",
      "    else audioRef.current?.pause();",
      "  }",
      "  function resetPlayback() { audioRef.current.currentTime = 0; }",
      "  return <main>",
      "    <audio ref={audioRef} onEnded={() => resetPlayback()} />",
      "    <button onClick={handlePlayback}>Preview audio</button>",
      "    <button onClick={handleShare}>Share preview</button>",
      "    <button onClick={() => onOpen('preview')}>Open preview</button>",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  await write(
    root,
    "src/lib/availability.ts",
    [
      "export const PREVIEW_WINDOW = {",
      "  startAt: '2026-08-01T00:00:00Z',",
      "  endAt: '2026-08-31T23:59:59Z',",
      "};",
      "export const isAvailable = (now) => now >= Date.parse(PREVIEW_WINDOW.startAt) && now <= Date.parse(PREVIEW_WINDOW.endAt);",
    ].join("\n"),
  );
  await write(
    root,
    "src/lib/scopedContext.ts",
    [
      "export function captureContext(id) { window.sessionStorage.setItem('preview-context', id); }",
      "export function clearContext(id) {",
      "  if (window.sessionStorage.getItem('preview-context') === id) window.sessionStorage.removeItem('preview-context');",
      "}",
    ].join("\n"),
  );
  await write(
    root,
    "src/middleware.ts",
    [
      "const PUBLIC_ASSET_PATHS = ['/preview-assets/'];",
      "export function middleware(request) {",
      "  if (PUBLIC_ASSET_PATHS.some((prefix) => request.path.startsWith(prefix))) return NextResponse.next();",
      "  return requireLogin(request);",
      "}",
    ].join("\n"),
  );
  await write(
    root,
    "src/pages/public/preview.tsx",
    [
      "export function PublicPreview({ router }) {",
      "  function openItem(id) {",
      "    const params = new URLSearchParams({ source: 'preview' });",
      "    router.push(`/public/items/${id}?${params.toString()}`);",
      "  }",
      "  return <PreviewLanding onOpen={openItem} />;",
      "}",
    ].join("\n"),
  );
  commit(root, "chore(web): prepare 2.4.0 release");

  const files = [
    "src/components/PreviewLanding/index.tsx",
    "src/lib/availability.ts",
    "src/lib/scopedContext.ts",
    "src/middleware.ts",
    "src/pages/public/preview.tsx",
  ];
  const analysis = await analyze(root, files);
  const intent = analysis.intents[0];
  const titles = intent.scenarios.map((scenario) => scenario.title);

  assert.equal(analysis.source, "diff-only");
  assert.match(intent.title, /Preview Landing changed behavior/i);
  assert.ok(titles.some((title) => /Share completion, cancellation, and fallback/i.test(title)));
  assert.ok(titles.some((title) => /Public and protected entry access/i.test(title)), JSON.stringify(titles));
  assert.ok(titles.some((title) => /Availability window boundaries/i.test(title)));
  assert.ok(titles.some((title) => /Media start, stop, completion, and restart state/i.test(title)));
  assert.ok(titles.some((title) => /Scoped persisted context isolation and cleanup/i.test(title)));

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const flow = plan.flows.find((candidate) => candidate.intentId === intent.id);
  assert.ok(flow);
  assert.equal(flow.fixtureReadiness.status, "not-needed");
  assert.ok(flow.qaScenarios.some((scenario) => /Share completion/i.test(scenario.title)));

  const draft = await generateE2eDraft(root, { base: "main", head: "HEAD", output: ".generated-e2e" });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const shareReceipt = file.scenarioAutomation.find((receipt) => /Share completion/i.test(receipt.title));
  const mediaReceipt = file.scenarioAutomation.find((receipt) => /Media start/i.test(receipt.title));
  assert.equal(shareReceipt?.status, "compiled");
  assert.equal(mediaReceipt?.status, "compiled");
  const spec = await readFile(path.join(root, file.path), "utf8");
  assert.match(spec, /__qamapShareState/);
  assert.match(spec, /__qamapMediaState/);
  assert.match(spec, /qamap_probe=share-source/);
  const transpiled = ts.transpileModule(spec, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  const syntaxErrors = (transpiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(syntaxErrors, []);
});

test("release-shaped account changes promote located diff intent without a test runner", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "19.0.0", vite: "7.0.0" } }),
  );
  await write(root, "src/pages/preferences.tsx", "export function Preferences() { return null; }\n");
  commit(root, "benchmark baseline");
  branch(root, "chore/account-release");
  await write(
    root,
    "src/pages/preferences.tsx",
    [
      "export function Preferences({ router }) {",
      "  function savePreferences() {",
      "    window.localStorage.setItem('timezone', 'UTC');",
      "    showToast('Preferences saved');",
      "    router.replace('/account?tab=preferences');",
      "  }",
      "  return <button onClick={() => savePreferences()}>Save preferences</button>;",
      "}",
    ].join("\n"),
  );
  commit(root, "chore: prepare account release");

  const analysis = await analyze(root, ["src/pages/preferences.tsx"]);
  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const flow = plan.flows.find((candidate) => candidate.intentId === analysis.intents[0]?.id);

  assert.equal(analysis.source, "diff-only");
  assert.equal(analysis.intents.length, 1);
  assert.ok(flow);
  assert.equal(flow.intentConfidence, "low");
  assert.equal(flow.fixtureReadiness.status, "not-needed");
  assert.ok(flow.qaScenarios.some((scenario) => /persisted context|re-entry/i.test(scenario.title)));
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
  const qaText = formatTextQaDraft(qa);
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
  assert.ok(
    plan.flows[0].lifecycle.some((stage) => /persist the selected timezone/i.test(stage.label)),
    "the reasoning lifecycle should retain the intended persistence effect",
  );
  assert.ok(
    plan.flows[0].lifecycle.some((stage) => /fetch|saved timezone/i.test(stage.label)),
    "the reasoning lifecycle should retain implementation effects",
  );
  assert.equal(
    plan.flows[0].lifecycle.some(
      (stage) => stage.kind === "trigger" && /^after the request completes/i.test(stage.label),
    ),
    false,
    "outcome timing should not replace the actual user trigger",
  );
  assert.doesNotMatch(
    plan.flows[0].steps.filter((step) => !/^verify\b/i.test(step)).join("\n"),
    /persist the selected timezone|setSavedTimezone|invoke fetch/i,
  );
  assert.ok(
    plan.flows[0].steps.some((step) => /verify visible text "Preferences saved" appears/i.test(step)),
    `expected observable outcome in flow steps, got: ${JSON.stringify(plan.flows[0].steps)}`,
  );
  const primaryScenario = plan.flows[0].qaScenarios.find((scenario) => scenario.kind === "primary");
  assert.ok(
    primaryScenario?.assertions.some((assertion) => /persist the selected timezone/i.test(assertion)),
    "persistence should remain an explicit QA requirement even when the draft cannot prove it",
  );
  assert.doesNotMatch(
    plan.flows[0].steps.join("\n"),
    /verify persist the selected timezone/i,
    "an unproven persistence requirement should not become a fake executable assertion",
  );
  assert.match(plan.flows[0].languageBrief.trigger, /submit account preferences/i);
  assert.doesNotMatch(plan.flows[0].languageBrief.trigger, /after the request completes/i);
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
  const agentIntentSources = [
    ...(agentSummary.intents[0].sources ?? []),
    ...agentSummary.intents[0].scenarios.flatMap((scenario) => scenario.sources ?? []),
  ];
  assert.ok(agentIntentSources.some((source) => source.file && source.startLine));
  assert.ok(agentSummary.intents[0].lifecycle.some((stage) => stage.phase === "state-change"));
  assert.equal(agentSummary.intents[0].scenarioCount, plan.changeAnalysis.intents[0].scenarios.length);
  assert.ok(agentSummary.intents[0].omittedScenarioCount > 0);
  const agentCalendarScenario = agentSummary.intents[0].scenarios.find((scenario) => /calendar/i.test(scenario.title));
  assert.ok(
    agentCalendarScenario,
    `expected the compact agent payload to retain calendar evidence: ${JSON.stringify({
      bytes: Buffer.byteLength(formatAgentQaDraft(qa)),
      compaction: agentSummary.compaction,
      scenarios: agentSummary.intents[0].scenarios.map((scenario) => scenario.title),
    })}`,
  );
  assert.match(agentCalendarScenario.sources[0].symbol, /timezone/i);
  assert.equal(agentCalendarScenario.sources[0].relation, "direct");
  assert.equal(agentCalendarScenario.sources[0].side, "head");
  assert.ok(agentSummary.intents[0].scenarios.every((scenario) => scenario.confidence));
  assert.ok(agentSummary.intents[0].scenarios.every((scenario) => scenario.sources.length > 0));
  assert.ok(agentSummary.intents[0].scenarios.every((scenario) => scenario.routing?.decision));
  assert.ok(agentSummary.intents[0].scenarios.every((scenario) => scenario.automation?.status));
  assert.ok(agentSummary.scenarioCoverage.required >= 1);
  const requiredTrace = qa.traces.find((trace) => trace.scenario.decision === "required");
  assert.ok(requiredTrace);
  assert.equal(requiredTrace.status, "traceable");
  assert.equal(requiredTrace.evidenceAssessment.disposition, "confirmed");
  assert.ok(requiredTrace.sources.some((source) => source.file === "src/pages/preferences.tsx" && source.startLine));
  assert.ok(requiredTrace.behavior.some((stage) => stage.relation === "evidence-linked"));
  assert.ok(requiredTrace.artifact?.draftPath.endsWith(".spec.ts"));
  assert.equal(requiredTrace.manifestCorrection.requiresHumanApproval, true);
  assert.equal(requiredTrace.execution, "not-run");
  assert.equal(agentSummary.traceCount, qa.traces.length);
  assert.deepEqual(agentSummary.evidenceSummary, qa.evidenceSummary);
  assert.equal(
    agentSummary.evidenceSummary.uniqueSources,
    new Set(qa.traces.flatMap((trace) => trace.sources.map((source) => JSON.stringify(source)))).size,
  );
  assert.ok(agentSummary.traces.length > 0);
  assert.ok(agentSummary.traces.every((trace) => trace.source?.file && trace.behavior?.phase));
  assert.ok(agentSummary.traces.every((trace) => trace.execution === "not-run"));
  assert.match(qaMarkdown, /Source: `src\/pages\/preferences\.tsx:\d+` symbol/);
  assert.match(qaMarkdown, /confidence: (?:medium|high)/);
  assert.match(qaMarkdown, /Scenario routing:/);
  assert.match(qaMarkdown, /E2E draft mapping:/);
  assert.match(qaMarkdown, /Evidence status: \d+ confirmed/);
  assert.match(qaMarkdown, /## QA Reasoning Trace/);
  assert.match(qaMarkdown, /Evidence status: `confirmed`/);
  assert.match(qaMarkdown, /If this trace is wrong: review `\.qamap\/manifest\.yaml > flows`/);
  assert.match(qaMarkdown, /1\. Diff evidence:[\s\S]*2\. Affected behavior:[\s\S]*3\. Risk:[\s\S]*4\. QA scenario:/);
  assert.match(qaMarkdown, /Product QA execution: not run/);
  assert.match(qaText, /^QAMap QA$/m);
  assert.match(qaText, /REQUIRED\s+Submit account preferences/i);
  assert.match(qaText, /Evidence: src\/pages\/preferences\.tsx:\d+/);
  assert.match(qaText, /Routing: \d+ required, \d+ recommended, \d+ review-only/);
  assert.match(qaText, /Optional E2E mapping: \d+ mapped, \d+ partial, \d+ unmapped; not executed/);
  assert.doesNotMatch(qaText, /## QA Reasoning Trace/);
  assert.equal(agentSummary.execution.status, "not-run");
  assert.match(qaMarkdown, /## Optional Automation/);
  assert.doesNotMatch(qaMarkdown, /Install command|First E2E Draft Bootstrap/);
  assert.match(spec, /Change intent evidence:/);
  assert.match(spec, /Behavior lifecycle:/);
  assert.match(spec, /trace:[a-f0-9]{12}/);
  assert.match(spec, /Diff source: src\/pages\/preferences\.tsx:\d+/);
  assert.match(spec, /Failure, timeout, and retry handling/);
  assert.equal(
    spec.match(/getByTestId\("preferences-save"\)\.click\(\)/g)?.length,
    1,
    "the generated primary path should perform the user action once",
  );
  assert.doesNotMatch(spec, /test\.fixme/);
  const primaryReceipt = writtenDraft.files[0].scenarioAutomation.find(
    (receipt) => receipt.kind === "primary",
  );
  assert.equal(primaryReceipt?.status, "partial", JSON.stringify(primaryReceipt));
  assert.equal(primaryReceipt?.mappedSteps, primaryReceipt?.totalSteps);
  assert.equal(primaryReceipt?.mappedAssertions, 1);
  assert.equal(primaryReceipt?.totalAssertions, 2);
  assert.match(primaryReceipt?.blockers.join("\n") ?? "", /1 selected assertion.*did not map/i);

  const staleReadinessQa = structuredClone(qa);
  staleReadinessQa.readiness.requiredScenarios = 40;
  staleReadinessQa.readiness.recommendedScenarios = 30;
  staleReadinessQa.readiness.reviewOnlyScenarios = 20;
  const traceBasedMarkdown = formatMarkdownQaDraft(staleReadinessQa);
  const requiredTraceCount = qa.traces.filter((trace) => trace.scenario.decision === "required").length;
  const recommendedTraceCount = qa.traces.filter((trace) => trace.scenario.decision === "recommended").length;
  const reviewOnlyTraceCount = qa.traces.filter((trace) => trace.scenario.decision === "review-only").length;
  assert.match(
    traceBasedMarkdown,
    new RegExp(`Scenario routing: ${requiredTraceCount} required, ${recommendedTraceCount} recommended, ${reviewOnlyTraceCount} review-only`),
  );
  assert.match(traceBasedMarkdown, new RegExp(`Reasoning trace: ${qa.traces.length}/${qa.traces.length} scenarios? traced`));
  assert.doesNotMatch(traceBasedMarkdown, /Reasoning trace: \d+\/90/);

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
    existingEvidencePaths: [`test/flow-${index}.test.ts`],
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
  assert.equal(typeof compactAgentSummary.flows[0].source, "string");
  assert.ok(Array.isArray(compactAgentSummary.flows[0].steps));
  assert.deepEqual(compactAgentSummary.flows[0].existingEvidence, ["test/flow-0.test.ts"]);
  if (compactAgentSummary.flows.length > 1) {
    assert.deepEqual(compactAgentSummary.flows[1].existingEvidence, ["test/flow-1.test.ts"]);
  }
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

test("React storage evidence compiles reload persistence into the primary Playwright draft", async (t) => {
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
    "src/pages/density.tsx",
    "export function DensityPage() { return <p>Default density</p>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/density-persistence");

  await write(
    root,
    "src/pages/density.tsx",
    [
      "import { useState } from 'react';",
      "",
      "export function DensityPage() {",
      "  const [density, setDensity] = useState(() => window.localStorage.getItem('workspace-density') ?? 'comfortable');",
      "  const [saved, setSaved] = useState(false);",
      "",
      "  function saveDensity() {",
      "    window.localStorage.setItem('workspace-density', density);",
      "    setSaved(true);",
      "  }",
      "",
      "  return <main>",
      "    <input aria-label=\"Workspace density\" value={density} onChange={(event) => setDensity(event.target.value)} />",
      "    <button data-testid=\"density-save\" onClick={saveDensity}>Save density</button>",
      "    {saved ? <p>Density saved</p> : null}",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: persist workspace density and restore it after re-entry");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const spec = await readFile(path.join(root, file.path), "utf8");
  const primaryReceipt = file.scenarioAutomation.find((receipt) => receipt.kind === "primary");
  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const agent = JSON.parse(formatAgentQaDraft(qa));
  const densityFlow = agent.flows.find((candidate) => /density/i.test(candidate.title));

  assert.match(spec, /const persistedField = page\.getByLabel\("Workspace density"\)/);
  assert.match(spec, /Repository evidence links localStorage key "workspace-density"/);
  assert.match(spec, /await persistedField\.fill\(persistedValue\)/);
  assert.match(spec, /await page\.reload\(\)/);
  assert.match(spec, /await expect\(persistedField\)\.toHaveValue\(persistedValue\)/);
  assert.equal(spec.match(/getByTestId\("density-save"\)\.click\(\)/g)?.length, 1);
  assert.match(file.languageBrief.trigger, /save density/i);
  assert.doesNotMatch(file.languageBrief.trigger, /re-entry/i);
  assert.equal(
    primaryReceipt?.status,
    "compiled",
    JSON.stringify({ primaryReceipt, scenarios: file.qaScenarios, spec }),
  );
  assert.equal(primaryReceipt?.mappedAssertions, primaryReceipt?.totalAssertions);
  assert.ok(densityFlow?.focus, JSON.stringify(densityFlow));
  assert.match(densityFlow.focus.action, /save density/i);
  assert.ok(
    densityFlow.focus.assertion,
    JSON.stringify({ densityFlow, scenarios: qa.changeAnalysis.intents.flatMap((intent) => intent.scenarios) }),
  );
  assert.match(densityFlow.focus.assertion, /density/i);
});

test("Vue storage evidence compiles the same persistence proof without framework-specific rules", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({
      scripts: { dev: "vite", "test:e2e": "playwright test" },
      dependencies: { vue: "3.5.0", vite: "7.0.0", "@playwright/test": "1.56.0" },
    }),
  );
  await write(
    root,
    "src/pages/draft.vue",
    "<template><p>Untitled draft</p></template>\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/draft-persistence");

  await write(
    root,
    "src/pages/draft.vue",
    [
      "<script setup>",
      "import { ref } from 'vue';",
      "",
      "const title = ref(window.sessionStorage.getItem('draft-title') ?? '');",
      "const saved = ref(false);",
      "",
      "function saveDraft() {",
      "  window.sessionStorage.setItem('draft-title', title.value);",
      "  saved.value = true;",
      "}",
      "</script>",
      "",
      "<template>",
      "  <main>",
      "    <input aria-label=\"Draft title\" v-model=\"title\" />",
      "    <button data-testid=\"draft-save\" @click=\"saveDraft\">Save draft</button>",
      "    <p v-if=\"saved\">Draft saved</p>",
      "  </main>",
      "</template>",
    ].join("\n"),
  );
  commit(root, "feat: persist draft title and restore it after re-entry");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const spec = await readFile(path.join(root, file.path), "utf8");
  const primaryReceipt = file.scenarioAutomation.find((receipt) => receipt.kind === "primary");
  const conditionalReceipt = file.scenarioAutomation.find((receipt) =>
    receipt.kind === "state-transition" && /conditional state and fallback/i.test(receipt.title)
  );

  assert.match(spec, /const persistedField = page\.getByLabel\("Draft title"\)/);
  assert.match(spec, /Repository evidence links sessionStorage key "draft-title"/);
  assert.match(spec, /await page\.reload\(\)/);
  assert.match(spec, /await expect\(persistedField\)\.toHaveValue\(persistedValue\)/);
  assert.equal(
    spec.match(/getByTestId\("draft-save"\)\.click\(\)/g)?.length,
    2,
    "The persistence proof and transient completion-state proof each exercise the save action.",
  );
  assert.equal(conditionalReceipt?.status, "compiled");
  assert.equal(
    spec.match(/expect\(page\.getByText\("Draft saved"\)\)\.not\.toBeVisible\(\)/g)?.length,
    2,
  );
  assert.match(file.languageBrief.trigger, /save draft/i);
  assert.doesNotMatch(file.languageBrief.trigger, /re-entry/i);
  assert.equal(
    primaryReceipt?.status,
    "compiled",
    JSON.stringify({ primaryReceipt, scenarios: file.qaScenarios, spec }),
  );
});

test("a storage write without matching restoration evidence stays partial", async (t) => {
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
    "src/pages/filter.tsx",
    "export function FilterPage() { return <p>All records</p>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/filter-persistence");

  await write(
    root,
    "src/pages/filter.tsx",
    [
      "import { useState } from 'react';",
      "",
      "export function FilterPage() {",
      "  const [filter, setFilter] = useState('all');",
      "  const restoredFilter = window.localStorage.getItem('different-filter-key');",
      "",
      "  function saveFilter() {",
      "    window.localStorage.setItem('records-filter', filter);",
      "  }",
      "",
      "  return <main>",
      "    <input aria-label=\"Records filter\" value={filter} onChange={(event) => setFilter(event.target.value)} />",
      "    <button data-testid=\"filter-save\" onClick={saveFilter}>Save filter</button>",
      "    <p>{restoredFilter}</p>",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: persist the records filter for re-entry");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const spec = await readFile(path.join(root, file.path), "utf8");
  const primaryReceipt = file.scenarioAutomation.find((receipt) => receipt.kind === "primary");

  assert.doesNotMatch(spec, /const persistedField|await page\.reload\(\)|toHaveValue\(persistedValue\)/);
  assert.notEqual(
    primaryReceipt?.status,
    "compiled",
    JSON.stringify({ primaryReceipt, scenarios: file.qaScenarios, spec }),
  );
  assert.match(primaryReceipt?.blockers.join("\n") ?? "", /assertion.*did not map/i);
});

test("one change intent produces separate QA flows for distinct user surfaces", async (t) => {
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
    "src/features/account/pages/PlanPage.tsx",
    [
      "import { completeTransaction } from '../../transactions/services/transactionService';",
      "export function PlanPage() { return <p>Free plan</p>; }",
    ].join("\n") + "\n",
  );
  await write(
    root,
    "src/features/credits/pages/CreditPage.tsx",
    [
      "import { completeTransaction } from '../../transactions/services/transactionService';",
      "export function CreditPage() { return <p>No credits</p>; }",
    ].join("\n") + "\n",
  );
  await write(
    root,
    "src/features/transactions/services/transactionService.ts",
    "export async function completeTransaction() { return { status: 'idle' }; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/transaction-completion");

  await write(
    root,
    "src/features/account/pages/PlanPage.tsx",
    [
      "import { completeTransaction } from '../../transactions/services/transactionService';",
      "export function PlanPage() {",
      "  return <section>",
      "    <button data-testid=\"plan-confirm\" onClick={completeTransaction}>Confirm plan</button>",
      "    <p>Plan activated</p>",
      "  </section>;",
      "}",
    ].join("\n") + "\n",
  );
  await write(
    root,
    "src/features/credits/pages/CreditPage.tsx",
    [
      "import { completeTransaction } from '../../transactions/services/transactionService';",
      "export function CreditPage() {",
      "  return <section>",
      "    <button data-testid=\"credits-confirm\" onClick={completeTransaction}>Confirm credits</button>",
      "    <p>Credits updated</p>",
      "  </section>;",
      "}",
    ].join("\n") + "\n",
  );
  await write(
    root,
    "src/features/transactions/services/transactionService.ts",
    "export async function completeTransaction() { return { status: 'completed' }; }\n",
  );
  commit(root, "feat: complete a transaction and refresh the affected product state");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const intent = plan.changeAnalysis.intents[0];
  const intentFlows = plan.flows.filter((flow) => flow.intentId === intent?.id);
  const accountFlow = intentFlows.find((flow) =>
    flow.files.some((file) => file.includes("/account/")),
  );
  const creditsFlow = intentFlows.find((flow) =>
    flow.files.some((file) => file.includes("/credits/")),
  );

  assert.equal(plan.changeAnalysis.intents.length, 1);
  assert.equal(intentFlows.length, 2);
  assert.ok(accountFlow);
  assert.ok(creditsFlow);
  assert.match(accountFlow.title, /Account/i);
  assert.match(creditsFlow.title, /Credits/i);
  assert.match(accountFlow.languageBrief.successSignal, /Plan activated/i);
  assert.doesNotMatch(accountFlow.languageBrief.successSignal, /Credits updated/i);
  assert.match(creditsFlow.languageBrief.successSignal, /Credits updated/i);
  assert.doesNotMatch(creditsFlow.languageBrief.successSignal, /Plan activated/i);
  assert.ok(accountFlow.files.some((file) => file.includes("/transactions/")));
  assert.ok(creditsFlow.files.some((file) => file.includes("/transactions/")));
  assert.ok(
    accountFlow.intentEvidence
      .filter((evidence) => evidence.file)
      .every((evidence) => !evidence.file.includes("/credits/")),
  );
  assert.ok(
    creditsFlow.intentEvidence
      .filter((evidence) => evidence.file)
      .every((evidence) => !evidence.file.includes("/account/")),
  );
  const accountPrimary = accountFlow.qaScenarios.find((scenario) => scenario.kind === "primary");
  const creditsPrimary = creditsFlow.qaScenarios.find((scenario) => scenario.kind === "primary");
  assert.ok(accountPrimary.assertions.some((assertion) => /Plan activated/i.test(assertion)));
  assert.ok(creditsPrimary.assertions.some((assertion) => /Credits updated/i.test(assertion)));

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const accountQaFlow = qa.flows.find((flow) =>
    flow.changedFiles.some((file) => file.includes("/account/")),
  );
  const creditsQaFlow = qa.flows.find((flow) =>
    flow.changedFiles.some((file) => file.includes("/credits/")),
  );
  assert.ok(accountQaFlow);
  assert.ok(creditsQaFlow);
  const primaryTrace = qa.traces.find(
    (trace) => trace.scenario.id === intent.scenarios.find((scenario) => scenario.kind === "primary")?.id,
  );
  assert.ok(primaryTrace);
  assert.equal(primaryTrace.status, "traceable");
  assert.equal(primaryTrace.artifact?.status, "compiled");
  assert.equal(primaryTrace.artifact?.flowCount, 2);
  assert.equal(primaryTrace.artifact?.compiledFlowCount, 2);
  const multiFlowAgentSummary = JSON.parse(formatAgentQaDraft(qa));
  const multiFlowTrace = multiFlowAgentSummary.traces.find(
    (trace) => trace.scenario?.id === primaryTrace.scenario.id,
  );
  assert.equal(multiFlowTrace?.artifact?.flowCoverage, "2/2");
  assert.match(formatMarkdownQaDraft(qa), /flow coverage 2\/2/);

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".qamap-e2e",
  });
  const accountDraft = draft.files.find((file) =>
    file.changedFiles.some((changedFile) => changedFile.includes("/account/")),
  );
  const creditsDraft = draft.files.find((file) =>
    file.changedFiles.some((changedFile) => changedFile.includes("/credits/")),
  );
  assert.ok(accountDraft);
  assert.ok(creditsDraft);
  assert.notEqual(accountDraft.path, creditsDraft.path);
  const accountPrimaryReceipt = accountDraft.scenarioAutomation.find(
    (receipt) => receipt.kind === "primary",
  );
  const creditsPrimaryReceipt = creditsDraft.scenarioAutomation.find(
    (receipt) => receipt.kind === "primary",
  );
  const accountDraftContent = await readFile(path.join(root, accountDraft.path), "utf8");
  const creditsDraftContent = await readFile(path.join(root, creditsDraft.path), "utf8");
  assert.ok(accountPrimaryReceipt);
  assert.ok(creditsPrimaryReceipt);
  assert.equal(
    accountPrimaryReceipt.status,
    "compiled",
    `${JSON.stringify(accountPrimaryReceipt)}\n${accountDraftContent}`,
  );
  assert.equal(
    creditsPrimaryReceipt.status,
    "compiled",
    `${JSON.stringify(creditsPrimaryReceipt)}\n${creditsDraftContent}`,
  );
  assert.ok(accountPrimaryReceipt.mappedSteps > 0, JSON.stringify(accountPrimaryReceipt));
  assert.ok(accountPrimaryReceipt.mappedAssertions > 0, JSON.stringify(accountPrimaryReceipt));
  assert.ok(creditsPrimaryReceipt.mappedSteps > 0, JSON.stringify(creditsPrimaryReceipt));
  assert.ok(creditsPrimaryReceipt.mappedAssertions > 0, JSON.stringify(creditsPrimaryReceipt));
  assert.match(accountDraftContent, /getByTestId\("plan-confirm"\)\.click/);
  assert.match(accountDraftContent, /getByText\("Plan activated"\)/);
  assert.doesNotMatch(accountDraftContent, /credits-confirm|Credits updated/);
  assert.match(creditsDraftContent, /getByTestId\("credits-confirm"\)\.click/);
  assert.match(creditsDraftContent, /getByText\("Credits updated"\)/);
  assert.doesNotMatch(creditsDraftContent, /plan-confirm|Plan activated/);
  assert.doesNotMatch(`${accountDraftContent}\n${creditsDraftContent}`, /test\.fixme/);

  const oversizedQa = structuredClone(qa);
  oversizedQa.changeAnalysis.intents = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(qa.changeAnalysis.intents[0]),
    title: `${qa.changeAnalysis.intents[0].title} ${index} ${"intent".repeat(40)}`,
  }));
  oversizedQa.flows = [
    structuredClone(accountQaFlow),
    structuredClone(creditsQaFlow),
    ...Array.from({ length: 18 }, (_, index) => ({
      ...structuredClone(index % 2 === 0 ? accountQaFlow : creditsQaFlow),
      title: `Additional surface ${index} ${"flow".repeat(40)}`,
      changedFiles: Array.from(
        { length: 12 },
        (__, fileIndex) => `src/${"nested/".repeat(20)}file-${fileIndex}.tsx`,
      ),
      draftSteps: Array.from({ length: 12 }, (__, stepIndex) => `Step ${stepIndex} ${"detail ".repeat(50)}`),
      selectorHints: Array.from(
        { length: 12 },
        (__, selectorIndex) => `[data-testid="${"selector".repeat(20)}-${selectorIndex}"]`,
      ),
    })),
  ];
  oversizedQa.base = `refs/heads/${"base-segment/".repeat(1000)}`;
  oversizedQa.head = `refs/heads/${"head-segment/".repeat(1000)}`;
  oversizedQa.manifestPath = `${"manifest/".repeat(1000)}qamap.yaml`;

  const compactOutput = formatAgentQaDraft(oversizedQa);
  const compactSummary = JSON.parse(compactOutput);
  assert.ok(Buffer.byteLength(compactOutput) <= 4 * 1024);
  assert.ok(compactSummary.compaction.emergency);
  assert.equal(compactSummary.flowCount, 20);
  assert.ok(compactSummary.flows.length >= 2);
  assert.match(compactSummary.flows[0].title, /Account/i);
  assert.match(compactSummary.flows[0].successSignal, /Plan activated/i);
  assert.match(compactSummary.flows[1].title, /Credits/i);
  assert.match(compactSummary.flows[1].successSignal, /Credits updated/i);
  assert.ok(compactSummary.flows[1].changedFiles.some((file) => file.includes("credits")));
  assert.equal(compactSummary.omittedFlowCount, 20 - compactSummary.flows.length);
});

test("an unchanged success message can ground QA when the same surface has direct diff evidence", async (t) => {
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
    "src/features/jobs/components/JobPanel.tsx",
    [
      "export function JobPanel() {",
      "  function submitJob() { return undefined; }",
      "  return <section>",
      "    <button onClick={submitJob}>Submit job</button>",
      "    <p>Job queued</p>",
      "  </section>;",
      "}",
    ].join("\n") + "\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/job-submission");

  await write(
    root,
    "src/features/jobs/components/JobPanel.tsx",
    [
      "export function JobPanel() {",
      "  async function submitJob() {",
      "    await fetch('/api/jobs', { method: 'POST' });",
      "  }",
      "  return <section>",
      "    <button onClick={submitJob}>Submit job</button>",
      "    <p>Job queued</p>",
      "  </section>;",
      "}",
    ].join("\n") + "\n",
  );
  commit(root, "feat: submit a background job");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const flow = plan.flows.find((candidate) => candidate.intentId);
  const successSelector = flow?.selectors.find((selector) => selector.value === "Job queued");

  assert.ok(flow);
  assert.ok(successSelector, JSON.stringify(flow.selectors));
  assert.notEqual(successSelector?.addedInDiff, true);
  assert.match(flow.languageBrief.successSignal, /Job queued/i);
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

test("state setter evidence does not compile a second user interaction", async (t) => {
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
    "src/pages/records.tsx",
    "export function Records() { return <main><h1>Records</h1></main>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/record-pinning");

  await write(
    root,
    "src/pages/records.tsx",
    [
      "export function Records() {",
      "  const [isPinned, setPinned] = useState(false);",
      "  return <main>",
      "    <button data-testid=\"pin-record\" onClick={() => setPinned(true)}>Pin</button>",
      "    {isPinned ? <p>Pinned record appears first</p> : null}",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: pin a workspace record and show it first");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const primaryScenario = file.scenarioAutomation.find((receipt) => receipt.kind === "primary");
  assert.equal(primaryScenario?.mappedSteps, 1);
  assert.equal(primaryScenario?.mappedAssertions, 1);

  const spec = await readFile(path.join(root, file.path), "utf8");
  assert.equal((spec.match(/\.click\(\)/g) ?? []).length, 1);
  assert.match(spec, /page\.getByTestId\("pin-record"\)\.click\(\)/);
  assert.match(spec, /page\.getByText\("Pinned record appears first"\)/);
});

test("unrelated callback props do not become the representative action for broad changes", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/SharedPanel.tsx";
  await write(
    root,
    file,
    "export function SharedPanel() { return <section>Shared panel</section>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/shared-component-foundation");

  await write(
    root,
    file,
    [
      "export function SharedPanel({ onClose }) {",
      "  return <section>",
      "    <button onClick={onClose}>Dismiss</button>",
      "    <p>Shared panel</p>",
      "  </section>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: adopt shared component foundation");

  const analysis = await analyze(root, [file]);
  const [intent] = analysis.intents;
  const primary = intent.scenarios.find((scenario) => scenario.kind === "primary");
  assert.ok(primary);
  assert.equal(primary.steps.some((step) => /\bclose\b/i.test(step)), false);
  assert.ok(primary.steps.some((step) => /shared component foundation/i.test(step)));
  assert.equal(intent.lifecycle.some((stage) => /\bclose\b/i.test(stage.label)), false);
  assert.equal(primary.evidence.some((item) => item.symbol === "onClose"), false);
});

test("callback props remain representative when the commit explicitly changes that action", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/NotificationPanel.tsx";
  await write(
    root,
    file,
    "export function NotificationPanel() { return <section>Notifications</section>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/notification-panel-close");

  await write(
    root,
    file,
    [
      "export function NotificationPanel({ onClose }) {",
      "  return <section>",
      "    <button onClick={onClose}>Close notifications</button>",
      "  </section>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: close notification panel");

  const analysis = await analyze(root, [file]);
  const primary = analysis.intents[0].scenarios.find((scenario) => scenario.kind === "primary");
  assert.ok(primary);
  assert.ok(primary.steps.some((step) => /\bclose\b/i.test(step)));
});

test("callback action synonyms retain behavior supported by the commit intent", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/ItemPreview.tsx";
  await write(
    root,
    file,
    "export function ItemPreview() { return <section>Item</section>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/item-preview");

  await write(
    root,
    file,
    [
      "export function ItemPreview({ onView }) {",
      "  return <section>",
      "    <button onClick={onView}>Show item preview</button>",
      "  </section>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: show item preview");

  const analysis = await analyze(root, [file]);
  const primary = analysis.intents[0].scenarios.find((scenario) => scenario.kind === "primary");
  assert.ok(primary);
  assert.ok(primary.steps.some((step) => /\bview\b/i.test(step)));
});

test("browser scheduling helpers do not become observable product proof", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/ReviewPanel.tsx";
  await write(
    root,
    file,
    "export function ReviewPanel() { return <section>Review</section>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/contextual-review");

  await write(
    root,
    file,
    [
      "export function ReviewPanel() {",
      "  function alignPanel() {",
      "    requestAnimationFrame(() => setAligned(true));",
      "  }",
      "  return <button onClick={alignPanel}>Review layout</button>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: add contextual component review");

  const analysis = await analyze(root, [file]);
  const [intent] = analysis.intents;
  const primary = intent.scenarios.find((scenario) => scenario.kind === "primary");
  assert.ok(primary);
  assert.equal(intent.lifecycle.some((stage) => /requestAnimationFrame/i.test(stage.label)), false);
  assert.equal(primary.assertions.some((assertion) => /requestAnimationFrame/i.test(assertion)), false);
});

test("product request calls remain side-effect evidence", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/ReviewRequest.tsx";
  await write(
    root,
    file,
    "export function ReviewRequest() { return <section>Review</section>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/review-request");

  await write(
    root,
    file,
    [
      "export function ReviewRequest() {",
      "  function sendReviewRequest() {",
      "    return requestReview();",
      "  }",
      "  return <button onClick={sendReviewRequest}>Request review</button>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: request component review");

  const analysis = await analyze(root, [file]);
  assert.ok(
    analysis.intents[0].lifecycle.some((stage) =>
      stage.kind === "side-effect" &&
      stage.evidence.some((item) => item.symbol === "requestReview" && item.startLine)
    ),
  );
});

test("visible outcomes survive browser scheduling implementation details", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/AlignedPanel.tsx";
  await write(
    root,
    file,
    "export function AlignedPanel() { return <section>Panel</section>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/aligned-panel");

  await write(
    root,
    file,
    [
      "export function AlignedPanel() {",
      "  const [isAligned, setAligned] = useState(false);",
      "  function alignPanel() {",
      "    requestAnimationFrame(() => setAligned(true));",
      "  }",
      "  return <section>",
      "    <button onClick={alignPanel}>Align panel</button>",
      "    {isAligned && <p>Panel aligned</p>}",
      "  </section>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: show aligned panel result");

  const analysis = await analyze(root, [file]);
  const primary = analysis.intents[0].scenarios.find((scenario) => scenario.kind === "primary");
  assert.ok(primary);
  assert.ok(primary.assertions.some((assertion) => /aligned panel|panel aligned/i.test(assertion)));
  assert.equal(primary.assertions.some((assertion) => /requestAnimationFrame/i.test(assertion)), false);
  assert.equal(
    analysis.intents[0].lifecycle.some((stage) => /requestAnimationFrame/i.test(stage.label)),
    false,
  );
});

test("built-in type predicates do not become QA lifecycle conditions", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/CatalogBanner.tsx";
  await write(
    root,
    file,
    "export function CatalogBanner() { return <section>Catalog</section>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/catalog-banner");

  await write(
    root,
    file,
    [
      "export function CatalogBanner({ rawEntries }) {",
      "  const entries = Array.isArray(rawEntries) ? rawEntries : [];",
      "  function openCatalog() { return navigate('/catalog'); }",
      "  return <button onClick={openCatalog}>Open catalog ({entries.length})</button>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: add catalog entry banner");

  const analysis = await analyze(root, [file]);
  const primary = analysis.intents[0].scenarios.find((scenario) => scenario.kind === "primary");
  assert.ok(primary);
  assert.equal(
    analysis.intents[0].lifecycle.some((stage) =>
      stage.evidence.some((item) => /^(?:Array\.)?isArray$/i.test(item.symbol ?? ""))
    ),
    false,
  );
  assert.equal(primary.steps.some((step) => /\bis array\b/i.test(step)), false);
});

test("visible product outcomes survive built-in type predicate filtering", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/CatalogResults.tsx";
  await write(
    root,
    file,
    "export function CatalogResults() { return <section>Catalog</section>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/catalog-results");

  await write(
    root,
    file,
    [
      "export function CatalogResults({ entries }) {",
      "  if (Array.isArray(entries)) {",
      "    showCatalogResults();",
      "  }",
      "  return <section>Catalog results</section>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: show catalog results");

  const analysis = await analyze(root, [file]);
  assert.ok(
    analysis.intents[0].lifecycle.some((stage) =>
      stage.kind === "observable-outcome" &&
      stage.evidence.some((item) => item.symbol === "showCatalogResults")
    ),
  );
  assert.equal(
    analysis.intents[0].lifecycle.some((stage) => /\bis array\b/i.test(stage.label)),
    false,
  );
});

test("product-defined readiness predicates remain lifecycle evidence", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/WorkspacePanel.tsx";
  await write(
    root,
    file,
    "export function WorkspacePanel() { return <section>Workspace</section>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/workspace-ready");

  await write(
    root,
    file,
    [
      "export function WorkspacePanel({ workspace }) {",
      "  if (isWorkspaceReady(workspace)) {",
      "    showWorkspacePanel();",
      "  }",
      "  return <section>Workspace ready</section>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: show ready workspace");

  const analysis = await analyze(root, [file]);
  assert.ok(
    analysis.intents[0].lifecycle.some((stage) =>
      stage.kind === "condition" &&
      stage.evidence.some((item) => item.symbol === "isWorkspaceReady")
    ),
  );
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
  const stateReceipt = file.scenarioAutomation.find((receipt) =>
    receipt.kind === "state-transition" && /conditional state and fallback/i.test(receipt.title)
  );
  assert.equal(stateReceipt?.status, "not-compiled");
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
  const stateReceipt = file.scenarioAutomation.find((receipt) =>
    receipt.kind === "state-transition" && /conditional state and fallback/i.test(receipt.title)
  );
  assert.equal(stateReceipt?.status, "compiled");
  assert.equal(stateReceipt?.mappedSteps, 2);
  assert.equal(stateReceipt?.mappedAssertions, 2);
  const spec = await readFile(path.join(root, file.path), "utf8");
  assert.match(spec, /page\.getByRole\("button", \{ name: "Send notification" \}\)\.click\(\)/);
  assert.match(spec, /page\.getByText\("Notification queued"\)/);
  assert.match(spec, /expect\(page\.getByText\("Notification queued"\)\)\.not\.toBeVisible\(\)/);
  assert.match(spec, /await page\.reload\(\)/);
});

test("Vue local state transitions compile visible outcome and re-entry proof", async (t) => {
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
    "src/pages/workspaces.vue",
    "<template><main><h1>Workspaces</h1></main></template>\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/workspace-ready-state");

  await write(
    root,
    "src/pages/workspaces.vue",
    [
      "<script setup lang=\"ts\">",
      "import { ref } from 'vue';",
      "const isWorkspaceReady = ref(false);",
      "function revealWorkspace() { isWorkspaceReady.value = true; }",
      "</script>",
      "<template>",
      "  <main>",
      "    <h1>Workspaces</h1>",
      "    <button type=\"button\" @click=\"revealWorkspace\">Reveal workspace</button>",
      "    <p v-if=\"isWorkspaceReady\">Workspace ready</p>",
      "  </main>",
      "</template>",
    ].join("\n"),
  );
  commit(root, "feat: reveal workspace ready state");

  const draft = await generateE2eDraft(root, { base: "main", head: "HEAD", output: ".generated-e2e" });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const stateReceipt = file.scenarioAutomation.find((receipt) =>
    receipt.kind === "state-transition" && /conditional state and fallback/i.test(receipt.title)
  );
  assert.equal(stateReceipt?.status, "compiled");
  assert.equal(stateReceipt?.mappedSteps, 2);
  assert.equal(stateReceipt?.mappedAssertions, 2);

  const spec = await readFile(path.join(root, file.path), "utf8");
  assert.match(spec, /page\.getByRole\("button", \{ name: "Reveal workspace" \}\)\.click\(\)/);
  assert.match(spec, /expect\(page\.getByText\("Workspace ready"\)\)\.not\.toBeVisible\(\)/);
  assert.match(spec, /expect\(page\.getByText\("Workspace ready"\)\)\.toBeVisible\(\)/);
  assert.match(spec, /await page\.reload\(\)/);
});

test("state changes outside a user handler do not borrow a nearby action", async (t) => {
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
    "src/pages/status.tsx",
    "export function StatusPage() { return <main><h1>Status</h1></main>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/automatic-status");

  await write(
    root,
    "src/pages/status.tsx",
    [
      "export function StatusPage() {",
      "  const [isStatusReady, setStatusReady] = useState(false);",
      "  function inspectStatus() { console.info('status inspected'); }",
      "  useEffect(() => { setStatusReady(true); }, []);",
      "  return <main>",
      "    <h1>Status</h1>",
      "    <button onClick={inspectStatus}>Inspect status</button>",
      "    {isStatusReady && <p>Status ready</p>}",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: show automatic readiness state");

  const draft = await generateE2eDraft(root, { base: "main", head: "HEAD", output: ".generated-e2e" });
  const file = draft.files.find((candidate) => candidate.source === "change-intent");
  assert.ok(file);
  const stateReceipt = file.scenarioAutomation.find((receipt) =>
    receipt.kind === "state-transition" && /conditional state and fallback/i.test(receipt.title)
  );
  assert.equal(stateReceipt?.status, "not-compiled");

  const spec = await readFile(path.join(root, file.path), "utf8");
  assert.doesNotMatch(spec, /Routed QA scenario:.*conditional state and fallback/is);
});

test("URL-backed UI modes become restoration QA with representative controls", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({
      scripts: { dev: "vite" },
      dependencies: { react: "19.0.0", vite: "7.0.0" },
    }),
  );
  await write(
    root,
    "src/pages/review.tsx",
    "export function ReviewPage() { return <main><h1>Component review</h1></main>; }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/review-modes");

  await write(
    root,
    "src/pages/review.tsx",
    [
      "const isMode = (value) => value === 'preview' || value === 'compare' || value === 'usage';",
      "const modes = [",
      "  { value: 'preview', label: 'Preview' },",
      "  { value: 'compare', label: 'Compare' },",
      "  { value: 'usage', label: 'Usage' },",
      "];",
      "export function ReviewPage() {",
      "  const [mode, setMode] = useState('preview');",
      "  useEffect(() => {",
      "    const params = new URLSearchParams(window.location.search);",
      "    const requestedMode = params.get('mode');",
      "    if (isMode(requestedMode)) setMode(requestedMode);",
      "  }, []);",
      "  useEffect(() => {",
      "    const url = new URL(window.location.href);",
      "    if (mode === 'preview') url.searchParams.delete('mode');",
      "    else url.searchParams.set('mode', mode);",
      "    window.history.replaceState(null, '', url);",
      "  }, [mode]);",
      "  return <main>",
      "    <h1>Component review</h1>",
      "    <Segmented options={modes} value={mode} onChange={setMode} />",
      "    {mode === 'compare' && <h2>Compare changes</h2>}",
      "    {mode === 'usage' && <h2>Usage examples</h2>}",
      "  </main>;",
      "}",
    ].join("\n"),
  );
  commit(root, "feat: add URL-backed component review modes");

  const analysis = await analyze(root, ["src/pages/review.tsx"]);
  const urlState = analysis.intents[0].scenarios.find((scenario) => /URL-backed state restoration/i.test(scenario.title));
  assert.ok(urlState);
  assert.ok(urlState.evidence.some((item) => /reads query parameter "mode"/i.test(item.value)));
  assert.ok(urlState.evidence.some((item) => /writes query parameter "mode"/i.test(item.value)));
  assert.ok(urlState.evidence.some((item) => /removes query parameter "mode"/i.test(item.value)));
  assert.ok(urlState.evidence.some((item) => /preview, compare, usage/i.test(item.value)));
  assert.equal(
    analysis.intents[0].scenarios.some((scenario) => /Destination path and query parameters/i.test(scenario.title)),
    false,
  );

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD", runner: "playwright" });
  const selectors = plan.flows.flatMap((flow) => flow.selectors.map((selector) => selector.value));
  assert.ok(selectors.includes("Preview"));
  assert.ok(selectors.includes("Compare"));
  assert.ok(selectors.includes("Usage"));
});

test("QA keeps assets and fixture evidence with the owning workspace flow", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({
      private: true,
      workspaces: ["apps/*"],
      scripts: { dev: "vite", "test:e2e": "playwright test" },
      devDependencies: { "@playwright/test": "1.56.0", vite: "7.0.0" },
    }),
  );
  await write(root, "playwright.config.ts", "export default { use: { baseURL: 'http://127.0.0.1:4173' } };\n");
  await write(
    root,
    "apps/studio/src/pages/exports.tsx",
    "export function ExportsPage() { return <main><h1>Exports</h1></main>; }\n",
  );
  await write(
    root,
    "apps/studio/src/mocks/exportHandlers.ts",
    [
      'import { http, HttpResponse } from "msw";',
      "export const exportHandlers = [",
      '  http.get("/api/exports", () => HttpResponse.json({ exports: [] })),',
      "];",
    ].join("\n"),
  );
  await write(
    root,
    "apps/admin/src/features/exports/exportMock.ts",
    "export const adminExportMock = { reports: [] };\n",
  );
  await write(
    root,
    "apps/studio/src/features/account/api/accountApi.ts",
    "export async function loadAccount() { return apiClient.getAccount(); }\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/export-share-state");

  await write(
    root,
    "apps/studio/src/features/account/api/accountApi.ts",
    "export async function loadAccount() { return apiClient.getAccount({ includeDetails: true }); }\n",
  );
  commit(root, "fix: refresh account detail request");

  await write(
    root,
    "apps/studio/src/pages/exports.tsx",
    [
      'import closeIcon from "../../public/export-panel/close.svg";',
      "export function ExportsPage() {",
      '  const [status, setStatus] = useState("");',
      "  async function onShare() {",
      "    await fetch('/api/exports');",
      "    if (navigator.share) {",
      "      await navigator.share({ url: '/exports' });",
      "      setStatus('Export shared');",
      "    } else {",
      "      await navigator.clipboard.writeText('/exports');",
      "      setStatus('Export link copied');",
      "    }",
      "  }",
      "  return <main>",
      "    <h1>Exports</h1>",
      '    <img src={closeIcon} alt="Close export panel" />',
      '    <button data-testid="export-share" onClick={onShare}>Share export</button>',
      '    <p title="event_step">{status}</p>',
      "  </main>;",
      "}",
    ].join("\n"),
  );
  await write(root, "apps/studio/public/export-panel/close.svg", "<svg><path d=\"M0 0L1 1\" /></svg>\n");
  commit(root, "fix: refine export panel header and actions");

  const analysis = await analyze(root, [
    "apps/studio/src/pages/exports.tsx",
    "apps/studio/public/export-panel/close.svg",
  ]);
  assert.ok(analysis.intents[0].lifecycle.some((stage) => /share/i.test(stage.label)));
  assert.equal(analysis.intents[0].lifecycle.some((stage) => /\bon share\b/i.test(stage.label)), false);

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD", runner: "playwright" });
  const exportPlanFlow = plan.flows.find((flow) => flow.files.includes("apps/studio/src/pages/exports.tsx"));
  const accountPlanFlow = plan.flows.find((flow) =>
    flow.files.includes("apps/studio/src/features/account/api/accountApi.ts")
  );
  assert.ok(exportPlanFlow);
  assert.ok(accountPlanFlow);
  assert.equal(exportPlanFlow.fixtureReadiness.apiEndpoints.some((endpoint) => /account/i.test(endpoint)), false);
  assert.deepEqual(accountPlanFlow.fixtureReadiness.apiEndpoints, []);
  assert.equal(accountPlanFlow.fixtureReadiness.apiEndpoints.includes("/api/accountApi"), false);
  assert.match(accountPlanFlow.fixtureReadiness.nextActions[0], /accountApi\.ts/);
  assert.match(accountPlanFlow.fixtureReadiness.nextActions[0], /did not invent one/);

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD", runner: "playwright" });
  const markdown = formatMarkdownQaDraft(qa);
  const agent = JSON.parse(formatAgentQaDraft(qa));
  const primaryFlow = qa.flows.find((flow) => flow.changedFiles.includes("apps/studio/src/pages/exports.tsx"));

  assert.ok(primaryFlow);
  assert.notEqual(primaryFlow.title, "Refine export panel header and actions");
  assert.match(primaryFlow.title, /share/i);
  assert.ok(primaryFlow.changedFiles.includes("apps/studio/public/export-panel/close.svg"));
  assert.equal(
    qa.flows.some((flow) => flow.changedFiles.length > 0 && flow.changedFiles.every((file) => file.endsWith(".svg"))),
    false,
  );
  assert.equal(primaryFlow.selectorHints.some((selector) => /event_step/.test(selector)), false);
  assert.ok(
    qa.missingEvidence.some((item) => /apps\/studio\/src\/mocks\/exportHandlers\.ts/.test(item.detail)),
  );
  assert.equal(
    qa.missingEvidence.some((item) => /apps\/admin\/src\/features\/exports\/exportMock\.ts/.test(item.detail)),
    false,
  );
  assert.deepEqual(qa.execution, {
    status: "not-run",
    performed: false,
    scope: "static-analysis-and-draft-mapping",
  });
  assert.equal(agent.execution.status, "not-run");
  assert.match(markdown, /Product QA execution: not run/i);
  assert.doesNotMatch(markdown, /E2E mapping: \d+ compiled/);
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

test("form validation mode changes produce edit-trigger-correction QA across unrelated forms", async (t) => {
  const root = await makeRepo(t);
  const file = "src/forms/SupportRequestForm.tsx";
  await write(
    root,
    file,
    [
      "export function SupportRequestForm() {",
      "  const form = useForm({ mode: 'onChange' });",
      "  return <form><input name=\"subject\" /><button>Send request</button></form>;",
      "}",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/support-validation-timing");
  await write(
    root,
    file,
    [
      "export function SupportRequestForm() {",
      "  const form = useForm({ mode: 'onBlur' });",
      "  return <form><input name=\"subject\" /><button>Send request</button></form>;",
      "}",
    ].join("\n"),
  );
  commit(root, "fix: wait until field exit before validating support request");

  const analysis = await analyze(root, [file]);
  const scenario = analysis.intents[0].scenarios.find((candidate) =>
    /validation timing across edit, blur, correction, and submit/i.test(candidate.title)
  );
  assert.ok(scenario);
  assert.equal(scenario.kind, "state-transition");
  assert.equal(scenario.priority, "critical");
  assert.ok(scenario.evidence.some((item) => item.file === file && item.side === "head"));
  assert.ok(scenario.assertions.some((assertion) => /correcting the value clears stale feedback/i.test(assertion)));
  assert.ok(
    analysis.intents[0].lifecycle.some((stage) =>
      stage.kind === "condition" &&
      stage.evidence.some((item) => item.symbol === "form-validation-mode" && item.startLine)
    ),
  );
});

test("React form evidence compiles validation recovery and a valid submission path", async (t) => {
  const root = await makeRepo(t);
  await write(
    root,
    "package.json",
    JSON.stringify({
      scripts: { dev: "vite", "test:e2e": "playwright test" },
      dependencies: {
        react: "19.0.0",
        "react-hook-form": "7.62.0",
        vite: "7.0.0",
        "@playwright/test": "1.56.0",
      },
    }),
  );
  await write(root, "playwright.config.ts", "export default { use: { baseURL: 'http://127.0.0.1:4173' } };\n");
  const file = "src/pages/feedback.tsx";
  const source = (mode) => [
    "import { useState } from 'react';",
    "import { useForm } from 'react-hook-form';",
    "",
    "export function FeedbackPage() {",
    "  const [submitted, setSubmitted] = useState(false);",
    `  const { register, handleSubmit, formState: { errors } } = useForm({ mode: '${mode}' });`,
    "  return <form onSubmit={handleSubmit(() => setSubmitted(true))}>",
    "    <input type=\"email\" data-testid=\"email-input\" {...register('email', { required: 'Email required' })} />",
    "    {errors.email ? <p data-testid=\"email-error\">Invalid email</p> : null}",
    "    <button type=\"submit\" data-testid=\"feedback-submit\">Send feedback</button>",
    "    {submitted ? <p data-testid=\"feedback-sent\">Feedback sent</p> : null}",
    "  </form>;",
    "}",
  ].join("\n");
  await write(root, file, source("onChange"));
  commit(root, "benchmark baseline");
  branch(root, "fix/feedback-validation");
  await write(root, file, source("onTouched"));
  commit(root, "fix: defer email validation until field exit and clear feedback after correction");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const fileDraft = draft.files.find((candidate) =>
    candidate.scenarioAutomation.some((receipt) => /validation timing across edit/i.test(receipt.title))
  );
  assert.ok(fileDraft);
  const spec = await readFile(path.join(root, fileDraft.path), "utf8");
  const primaryReceipt = fileDraft.scenarioAutomation.find((receipt) => receipt.kind === "primary");
  const recoveryReceipt = fileDraft.scenarioAutomation.find((receipt) =>
    /validation timing across edit/i.test(receipt.title)
  );

  assert.equal(primaryReceipt?.status, "compiled");
  assert.equal(recoveryReceipt?.status, "compiled");
  assert.match(spec, /page\.goto\("\/feedback"\)/);
  assert.match(spec, /validatedField\.fill\("person@example\.com"\)/);
  assert.match(spec, /getByTestId\("feedback-submit"\)\.click\(\)/);
  assert.match(spec, /getByTestId\("feedback-sent"\)\)\.toBeVisible\(\)/);
  assert.match(spec, /validationField\.fill\("not-an-email"\)/);
  assert.match(spec, /expect\(validationError\)\.not\.toBeVisible\(\)/);
  assert.match(spec, /validationField\.blur\(\)/);
  assert.match(spec, /expect\(validationError\)\.toBeVisible\(\)/);
  assert.doesNotMatch(spec, /QAMap could not infer a stable locator|test\.fixme/);
});

test("Vue form evidence compiles the same validation recovery contract", async (t) => {
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
  const file = "src/pages/invitation.vue";
  const source = (mode) => [
    "<script setup>",
    "import { ref } from 'vue';",
    `const formOptions = { mode: '${mode}' };`,
    "const errors = ref({ email: '' });",
    "const submitted = ref(false);",
    "function submitInvitation() { submitted.value = true; }",
    "</script>",
    "<template>",
    "  <form @submit.prevent=\"submitInvitation\">",
    "    <input type=\"email\" data-testid=\"invite-email\" required />",
    "    <p v-if=\"errors.email\" data-testid=\"invite-email-error\">Invalid email</p>",
    "    <button type=\"submit\" data-testid=\"invite-submit\">Send invitation</button>",
    "    <p v-if=\"submitted\" data-testid=\"invitation-sent\">Invitation sent</p>",
    "  </form>",
    "</template>",
  ].join("\n");
  await write(root, file, source("onChange"));
  commit(root, "benchmark baseline");
  branch(root, "fix/invitation-validation");
  await write(root, file, source("onTouched"));
  commit(root, "fix: defer invitation email validation until field exit");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const fileDraft = draft.files.find((candidate) =>
    candidate.scenarioAutomation.some((receipt) => /validation timing across edit/i.test(receipt.title))
  );
  const recoveryReceipt = fileDraft?.scenarioAutomation.find((receipt) =>
    /validation timing across edit/i.test(receipt.title)
  );
  assert.ok(fileDraft);
  assert.equal(recoveryReceipt?.status, "compiled");
  const spec = await readFile(path.join(root, fileDraft.path), "utf8");
  assert.match(spec, /getByTestId\("invite-email"\)/);
  assert.match(spec, /getByTestId\("invite-email-error"\)/);
  assert.match(spec, /getByTestId\("invite-submit"\)/);
  assert.match(spec, /getByTestId\("invitation-sent"\)/);
});

test("non-form interaction mode changes do not fabricate validation timing QA", async (t) => {
  const root = await makeRepo(t);
  const file = "src/components/Canvas.tsx";
  await write(
    root,
    file,
    "export const canvasInteraction = { mode: 'onChange' };\n",
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/canvas-interaction");
  await write(
    root,
    file,
    "export const canvasInteraction = { mode: 'onTouched' };\n",
  );
  commit(root, "fix: update canvas interaction mode");

  const analysis = await analyze(root, [file]);
  assert.equal(
    analysis.intents[0].scenarios.some((scenario) => /validation timing/i.test(scenario.title)),
    false,
  );
});

test("format mode vocabulary does not fabricate form validation QA", async (t) => {
  const root = await makeRepo(t);
  const file = "src/pages/formats.tsx";
  await write(root, file, "export const exportOptions = { mode: 'onChange' };\n");
  commit(root, "benchmark baseline");
  branch(root, "fix/export-format-mode");
  await write(root, file, "export const exportOptions = { mode: 'onTouched' };\n");
  commit(root, "fix: update export format interaction mode");

  const analysis = await analyze(root, [file]);
  assert.equal(
    analysis.intents[0].scenarios.some((scenario) => /validation timing/i.test(scenario.title)),
    false,
  );
});

test("symbol QA annotations refine a changed lifecycle without replacing diff evidence", async (t) => {
  const root = await makeRepo(t);
  const file = "src/recovery.ts";
  await write(
    root,
    file,
    [
      "/**",
      " * @qamapFlow account-recovery",
      " * @qamapStage action Submit the recovery request",
      " * @qamapOutcome Recovery request is accepted",
      " * @qamapRisk Duplicate recovery request",
      " */",
      "export async function submitRecovery(input) {",
      "  return requestRecovery(input);",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/account-recovery");
  await write(
    root,
    file,
    [
      "/**",
      " * @qamapFlow account-recovery",
      " * @qamapStage action Submit the recovery request",
      " * @qamapOutcome Recovery request is accepted",
      " * @qamapRisk Duplicate recovery request",
      " */",
      "export async function submitRecovery(input) {",
      "  return requestRecovery({ ...input, retry: true });",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "fix: preserve account recovery retries");

  const analysis = await analyze(root, [file]);
  const intent = analysis.intents[0];
  const riskScenario = intent.scenarios.find((scenario) => scenario.title === "Duplicate recovery request");

  assert.deepEqual(analysis.symbolAnnotations, {
    applied: 1,
    files: [file],
    symbols: ["submitRecovery"],
    flows: ["account-recovery"],
    diagnostics: 0,
  });
  assert.ok(intent.lifecycle.some((stage) =>
    stage.kind === "action" &&
    stage.label === "Submit the recovery request." &&
    stage.evidence.some((item) => item.kind === "diff" && item.startLine === 8)
  ));
  assert.ok(intent.lifecycle.some((stage) =>
    stage.kind === "observable-outcome" &&
    stage.label === "Recovery request is accepted." &&
    stage.evidence.some((item) => item.value.includes("@qamapOutcome"))
  ));
  assert.ok(riskScenario);
  assert.equal(routeQaScenario(riskScenario).decision, "recommended");
  assert.ok(riskScenario.evidence.some((item) =>
    item.kind === "diff" &&
    item.symbol === "submitRecovery" &&
    item.startLine === 8 &&
    item.value.includes("@qamapRisk")
  ));
  assert.ok(riskScenario.evidence.some((item) =>
    item.kind === "source" &&
    item.startLine === 5 &&
    item.value === "@qamapRisk Duplicate recovery request"
  ));
  assert.ok(riskScenario.assertions.some((assertion) => /Recovery request is accepted/i.test(assertion)));
});

test("symbol QA annotations preserve service outcomes and state-transition risks", async (t) => {
  const root = await makeRepo(t);
  const file = "src/publication.ts";
  await write(
    root,
    file,
    [
      "/**",
      " * @qamapFlow document-publication",
      " * @qamapStage side-effect Publish the document",
      " * @qamapOutcome Document status becomes published",
      " * @qamapRisk Stale publication callback",
      " */",
      "export async function publishDocument(document) {",
      "  return sendPublication(document);",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "feat/document-publication");
  await write(
    root,
    file,
    [
      "/**",
      " * @qamapFlow document-publication",
      " * @qamapStage side-effect Publish the document",
      " * @qamapOutcome Document status becomes published",
      " * @qamapRisk Stale publication callback",
      " */",
      "export async function publishDocument(document) {",
      "  const response = await sendPublication(document);",
      "  return persistPublicationStatus(document.id, response.status);",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: persist document publication completion");

  const analysis = await analyze(root, [file]);
  const riskScenario = analysis.intents[0].scenarios.find((scenario) =>
    scenario.title === "Stale publication callback"
  );

  assert.equal(analysis.symbolAnnotations?.applied, 1);
  assert.ok(analysis.intents[0].lifecycle.some((stage) =>
    stage.kind === "side-effect" && stage.label === "Publish the document."
  ));
  assert.ok(analysis.intents[0].lifecycle.some((stage) =>
    stage.kind === "observable-outcome" && stage.label === "Document status becomes published."
  ));
  assert.ok(riskScenario);
  assert.equal(riskScenario.kind, "state-transition");
  assert.equal(routeQaScenario(riskScenario).decision, "recommended");
});

test("symbol QA outcomes keep repository-visible success assertions executable", async (t) => {
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
  const file = "src/pages/renewal.tsx";
  const source = (guard) => [
    "/**",
    " * @qamapFlow subscription-renewal",
    " * @qamapStage action Renew the subscription",
    " * @qamapOutcome Subscription status becomes active",
    " * @qamapRisk Duplicate renewal request",
    " */",
    "export default function RenewalPage() {",
    "  const [status, setStatus] = useState('idle');",
    "  const [renewing, setRenewing] = useState(false);",
    "  async function renew() {",
    guard,
    "    setRenewing(true);",
    "    await renewSubscription();",
    "    setStatus('active');",
    "  }",
    "  return <main>",
    "    <button data-testid=\"renew-subscription\" onClick={renew}>Renew subscription</button>",
    "    {status === 'active' ? <p>Subscription active</p> : null}",
    "  </main>;",
    "}",
    "async function renewSubscription() {",
    "  const response = await fetch('/api/subscriptions/renew', { method: 'POST' });",
    "  if (!response.ok) throw new Error('Could not renew subscription');",
    "  return response.json();",
    "}",
  ].filter(Boolean).join("\n");
  await write(root, file, source(""));
  commit(root, "benchmark baseline");
  branch(root, "fix/renewal-duplicate");
  await write(root, file, source("    if (renewing) return;"));
  commit(root, "fix: prevent duplicate subscription renewal requests");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const flow = plan.flows.find((candidate) => /subscription/i.test(candidate.title));

  assert.ok(flow);
  assert.equal(flow.languageBrief.successSignal, 'visible text "Subscription active" appears');
  assert.ok(flow.selectors.some((selector) =>
    selector.kind === "visible-text" && selector.value === "Subscription active"
  ));
  assert.ok(flow.qaScenarios.some((scenario) => scenario.title === "Duplicate renewal request"));

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const fileDraft = draft.files.find((candidate) => candidate.intentId === flow.intentId);
  const duplicateReceipt = fileDraft?.scenarioAutomation.find((receipt) =>
    receipt.title === "Duplicate renewal request"
  );
  assert.ok(fileDraft);
  assert.equal(duplicateReceipt?.status, "compiled");
  assert.equal(duplicateReceipt?.mappedSteps, 2);
  assert.equal(duplicateReceipt?.mappedAssertions, 2);

  const spec = await readFile(path.join(root, fileDraft.path), "utf8");
  assert.match(spec, /page\.route\("\*\*\/api\/subscriptions\/renew"/);
  assert.match(spec, /await repeatedAction\.click\(\)/);
  assert.match(spec, /element\.click\(\)/);
  assert.match(spec, /expect\(requestCount\)\.toBe\(1\)/);
  assert.match(spec, /page\.getByText\("Subscription active"\)/);
});

test("duplicate action QA stays uncompiled without an observable request boundary", async (t) => {
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
  const file = "src/pages/export.tsx";
  const source = (guard) => [
    "/**",
    " * @qamapFlow document-export",
    " * @qamapStage action Export the document",
    " * @qamapOutcome Document export becomes ready",
    " * @qamapRisk Duplicate export request",
    " */",
    "export default function ExportPage() {",
    "  const [exporting, setExporting] = useState(false);",
    "  const [ready, setReady] = useState(false);",
    "  async function exportDocument() {",
    guard,
    "    setExporting(true);",
    "    await Promise.resolve();",
    "    setReady(true);",
    "    setExporting(false);",
    "  }",
    "  return <main>",
    "    <button data-testid=\"export-document\" disabled={exporting} onClick={exportDocument}>Export document</button>",
    "    {ready ? <p>Document export ready</p> : null}",
    "  </main>;",
    "}",
  ].filter(Boolean).join("\n");
  await write(root, file, source(""));
  commit(root, "benchmark baseline");
  branch(root, "fix/export-duplicate");
  await write(root, file, source("    if (exporting) return;"));
  commit(root, "fix: prevent duplicate document exports");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const fileDraft = draft.files.find((candidate) =>
    candidate.scenarioAutomation.some((receipt) => receipt.title === "Duplicate export request")
  );
  const duplicateReceipt = fileDraft?.scenarioAutomation.find((receipt) =>
    receipt.title === "Duplicate export request"
  );

  assert.ok(fileDraft);
  assert.equal(duplicateReceipt?.status, "not-compiled");
  const spec = await readFile(path.join(root, fileDraft.path), "utf8");
  assert.doesNotMatch(spec, /qamap-repeated-action-check/);
  assert.doesNotMatch(spec, /let requestCount = 0/);
});

test("duplicate domain options do not become a repeated-action browser test", async (t) => {
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
  const file = "src/pages/export-formats.tsx";
  const source = (formats) => [
    "/**",
    " * @qamapFlow document-export",
    " * @qamapStage action Export the document",
    " * @qamapOutcome Document export becomes ready",
    " * @qamapRisk Duplicate export formats",
    " */",
    "export default function ExportFormatsPage() {",
    `  const formats = ${JSON.stringify(formats)};`,
    "  async function exportDocument() {",
    "    await fetch('/api/documents/export', { method: 'POST' });",
    "  }",
    "  return <main>",
    "    <button data-testid=\"export-document\" onClick={exportDocument}>Export document</button>",
    "    <p>Document export ready</p>",
    "    <span>{formats.join(', ')}</span>",
    "  </main>;",
    "}",
  ].join("\n");
  await write(root, file, source(["pdf"]));
  commit(root, "benchmark baseline");
  branch(root, "feat/export-formats");
  await write(root, file, source(["pdf", "docx"]));
  commit(root, "feat: support multiple document export formats");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const fileDraft = draft.files.find((candidate) =>
    candidate.scenarioAutomation.some((receipt) => receipt.title === "Duplicate export formats")
  );
  const optionReceipt = fileDraft?.scenarioAutomation.find((receipt) =>
    receipt.title === "Duplicate export formats"
  );

  assert.ok(fileDraft);
  assert.equal(optionReceipt?.status, "not-compiled");
  const spec = await readFile(path.join(root, fileDraft.path), "utf8");
  assert.doesNotMatch(spec, /qamap-repeated-action-check/);
});

test("duplicate action QA follows an annotated service into a Vue user flow", async (t) => {
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
  const serviceFile = "src/services/save-document.ts";
  const serviceSource = (guard) => [
    "let saving = false;",
    "/**",
    " * @qamapFlow document-save",
    " * @qamapStage action Save the document",
    " * @qamapOutcome Document status becomes saved",
    " * @qamapRisk Duplicate save request",
    " */",
    "export async function saveDocument() {",
    guard,
    "  saving = true;",
    "  try {",
    "    const response = await fetch('/api/documents/save', { method: 'POST' });",
    "    if (!response.ok) throw new Error('Could not save document');",
    "    return response.json();",
    "  } finally {",
    "    saving = false;",
    "  }",
    "}",
  ].filter(Boolean).join("\n");
  await write(root, serviceFile, serviceSource(""));
  await write(
    root,
    "src/pages/documents.vue",
    [
      "<script setup lang=\"ts\">",
      "import { ref } from 'vue';",
      "import { saveDocument } from '../services/save-document';",
      "const saved = ref(false);",
      "async function save() {",
      "  await saveDocument();",
      "  saved.value = true;",
      "}",
      "</script>",
      "<template>",
      "  <main>",
      "    <button data-testid=\"save-document\" @click=\"save\">Save document</button>",
      "    <p v-if=\"saved\">Document saved</p>",
      "  </main>",
      "</template>",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/document-save-duplicate");
  await write(root, serviceFile, serviceSource("  if (saving) return;"));
  commit(root, "fix: prevent duplicate document save requests");

  const draft = await generateE2eDraft(root, {
    base: "main",
    head: "HEAD",
    output: ".generated-e2e",
  });
  const fileDraft = draft.files.find((candidate) =>
    candidate.scenarioAutomation.some((receipt) => receipt.title === "Duplicate save request")
  );
  const duplicateReceipt = fileDraft?.scenarioAutomation.find((receipt) =>
    receipt.title === "Duplicate save request"
  );

  assert.ok(fileDraft);
  assert.equal(duplicateReceipt?.status, "compiled");
  assert.equal(duplicateReceipt?.mappedSteps, 2);
  assert.equal(duplicateReceipt?.mappedAssertions, 2);
  const spec = await readFile(path.join(root, fileDraft.path), "utf8");
  assert.match(spec, /page\.goto\("\/documents"\)/);
  assert.match(spec, /page\.route\("\*\*\/api\/documents\/save"/);
  assert.match(spec, /page\.getByTestId\("save-document"\)/);
  assert.match(spec, /page\.getByText\("Document saved"\)/);
  assert.match(spec, /expect\(requestCount\)\.toBe\(1\)/);
});

test("symbol annotations inside analyzer rules do not become product QA", async (t) => {
  const root = await makeRepo(t);
  const file = "src/rules/route-analyzer.ts";
  await write(
    root,
    file,
    [
      "/**",
      " * @qamapFlow product-checkout",
      " * @qamapOutcome Checkout succeeds",
      " * @qamapRisk Fabricated checkout failure",
      " */",
      "export function analyzeRouteEvidence(value) {",
      "  const evidencePattern = /route|destination/;",
      "  return evidencePattern.test(value);",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "benchmark baseline");
  branch(root, "fix/route-analysis");
  await write(
    root,
    file,
    [
      "/**",
      " * @qamapFlow product-checkout",
      " * @qamapOutcome Checkout succeeds",
      " * @qamapRisk Fabricated checkout failure",
      " */",
      "export function analyzeRouteEvidence(value) {",
      "  const evidencePattern = /route|destination|redirect/;",
      "  return evidencePattern.test(value);",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "fix: cover redirect evidence in route analysis");

  const analysis = await analyze(root, [file]);

  assert.equal(analysis.symbolAnnotations, undefined);
  assert.equal(
    analysis.intents.flatMap((intent) => intent.scenarios).some((scenario) =>
      scenario.title === "Fabricated checkout failure"
    ),
    false,
  );
  assert.ok(analysis.intents.flatMap((intent) => intent.scenarios).some((scenario) =>
    /analysis rule positive and negative controls/i.test(scenario.title)
  ));
});

test("change intents prioritize the newest independent feature for review", async (t) => {
  const root = await makeRepo(t);
  const profileFile = "src/profile/saveProfile.ts";
  const archiveFile = "src/archive/openArchive.ts";
  const analyzerFile = "src/rules/requestRule.ts";

  await write(root, profileFile, "export const saveProfile = () => 'idle';\n");
  await write(root, archiveFile, "export const openArchive = () => 'idle';\n");
  await write(root, analyzerFile, "export const matchesRequest = (source) => /request/.test(source);\n");
  commit(root, "chore: baseline");
  branch(root, "feature/review-order");

  await write(
    root,
    profileFile,
    [
      "export function saveProfile(name) {",
      "  if (!name) throw new Error('Profile name is required');",
      "  localStorage.setItem('profile-name', name);",
      "  return 'Profile saved';",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: save profile preferences");

  await write(
    root,
    archiveFile,
    [
      "export function openArchive(blockId) {",
      "  if (!blockId) return 'Archive block is required';",
      "  window.location.assign(`/archive/${blockId}`);",
      "  return 'Archive opened';",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: open archived records");

  await write(
    root,
    analyzerFile,
    [
      "const ignoredVocabulary = /calendar|scheduledAt/i;",
      "export const matchesRequest = (source) => /request/.test(source) && !ignoredVocabulary.test(source);",
      "",
    ].join("\n"),
  );
  commit(root, "chore: refine analyzer controls");

  const analysis = await analyze(root, [profileFile, archiveFile, analyzerFile]);

  assert.ok(analysis.intents.length >= 2);
  assert.match(analysis.intents[0].title, /open archived records/i);
  assert.match(analysis.intents[1].title, /save profile preferences/i);
  const residualIntentIndex = analysis.intents.findIndex((intent) =>
    /static analysis rule|changed behavior/i.test(intent.title)
  );
  assert.ok(residualIntentIndex > 1);
});

test("a cleanup tip commit does not displace the substantive change intent", async (t) => {
  const root = await makeRepo(t);
  const dialogFile = "src/reports/resetReportPreferences.ts";

  await write(root, dialogFile, "export const resetReportPreferences = () => 'idle';\n");
  commit(root, "chore: baseline");
  branch(root, "feature/report-preferences-reset");

  await write(
    root,
    dialogFile,
    [
      "export function resetReportPreferences(confirmed) {",
      "  if (!confirmed) return 'Reset requires confirmation';",
      "  localStorage.removeItem('report-preferences');",
      "  return 'Report preferences reset';",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: add report preferences reset dialog");

  await write(
    root,
    dialogFile,
    [
      "export function resetReportPreferences(isConfirmed) {",
      "  if (!isConfirmed) return 'Reset requires confirmation';",
      "  localStorage.removeItem('report-preferences');",
      "  return 'Report preferences reset';",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "fix: minor refactor");

  const analysis = await analyze(root, [dialogFile]);

  assert.match(analysis.intents[0].title, /report preferences reset dialog/i);
  const cleanupIntentIndex = analysis.intents.findIndex((intent) =>
    /minor refactor/i.test(intent.title)
  );
  assert.ok(cleanupIntentIndex > 0, "cleanup intent must be demoted, not dropped");
});

test("a flow without a diff-anchored outcome gets an honest success signal instead of a tautology", async (t) => {
  const root = await makeRepo(t);
  const pageFile = "src/pages/exportBatching.tsx";
  await write(root, "package.json", JSON.stringify({ name: "journal-app", private: true }));
  await write(root, pageFile, "export const ExportBatching = () => 'idle';\n");
  commit(root, "chore: baseline");
  branch(root, "feature/export-batching");
  await write(
    root,
    pageFile,
    [
      "import { useState } from \"react\";",
      "export function ExportBatching() {",
      "  const [applied, setApplied] = useState(false);",
      "  return (",
      "    <main>",
      "      <button data-testid=\"apply-batching\" onClick={() => setApplied(true)}>Apply batching</button>",
      "      {applied ? <p>Batching preference applied</p> : null}",
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: tune journal export batching");

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const journey = qa.flows[0].userJourney;

  assert.ok(journey);
  // The signal must not restate the flow title or fall back to a circular
  // "verify the result matches the intent" sentence.
  assert.doesNotMatch(journey.successSignal, /matches the commit intent/i);
  assert.doesNotMatch(journey.successSignal, /^verify\b/i);
  assert.match(journey.successSignal, /define the expected user-visible result/i);
  assert.equal(journey.successSignalUnresolved, true);
  assert.doesNotMatch(journey.reviewQuestion, /produce this outcome: Verify/i);
  assert.match(journey.reviewQuestion, /What user-visible outcome should .* produce\?/i);

  // Fallback draft steps must not turn the honest sentence into an assertion.
  const qaMarkdown = formatMarkdownQaDraft(qa);
  assert.doesNotMatch(qaMarkdown, /Assert no diff-anchored observable outcome/i);
});

test("a diff-anchored visible outcome keeps its concrete success signal", async (t) => {
  const root = await makeRepo(t);
  const pageFile = "src/pages/journalExport.tsx";
  await write(root, "package.json", JSON.stringify({ name: "journal-web", private: true }));
  await write(root, pageFile, "export const JournalExport = () => 'idle';\n");
  commit(root, "chore: baseline");
  branch(root, "feature/export-confirmation");
  await write(
    root,
    pageFile,
    [
      "import { useState } from \"react\";",
      "export function JournalExport() {",
      "  const [done, setDone] = useState(false);",
      "  return (",
      "    <main>",
      "      <button data-testid=\"export-journal\" onClick={() => setDone(true)}>Export journal</button>",
      "      {done ? <p>Journal export completed</p> : null}",
      "    </main>",
      "  );",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: confirm journal export completion");

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const journey = qa.flows[0].userJourney;

  assert.ok(journey);
  assert.match(journey.successSignal, /Journal export completed/);
  assert.notEqual(journey.successSignalUnresolved, true);
});

test("ticket tags stay in the intent title once and out of derived sentences", async (t) => {
  const root = await makeRepo(t);
  const invoiceFile = "src/invoices/bindInvite.ts";
  const noticeFile = "src/notices/expireNotice.ts";
  await write(root, invoiceFile, "export const bindInvite = () => 'idle';\n");
  await write(root, noticeFile, "export const expireNotice = () => 'idle';\n");
  commit(root, "chore: baseline");
  branch(root, "feature/ticket-tags");

  await write(
    root,
    invoiceFile,
    [
      "export function bindInvite(address) {",
      "  if (!address) throw new Error('Invite address is required');",
      "  localStorage.setItem('invite-address', address);",
      "  return 'Invite bound';",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "fix: bind the invite to the invited address [APP-42]");

  await write(
    root,
    noticeFile,
    [
      "export function expireNotice(daysLeft) {",
      "  if (daysLeft <= 0) return 'Notice expired';",
      "  return 'Notice active';",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "[QA-104] fix: expire stale notices after the retention window");

  const analysis = await analyze(root, [invoiceFile, noticeFile]);

  const inviteIntent = analysis.intents.find((intent) => /bind the invite/i.test(intent.title));
  const noticeIntent = analysis.intents.find((intent) => /expire stale notices/i.test(intent.title));
  assert.ok(inviteIntent, "trailing-tag commit must still produce its intent");
  assert.ok(noticeIntent, "leading-tag commit must still produce its intent");

  // The tag survives exactly once, in the title, as provenance.
  assert.match(inviteIntent.title, /\[APP-42\]$/);
  assert.match(noticeIntent.title, /\[QA-104\]$/);

  // Derived sentences must be clean.
  for (const intent of [inviteIntent, noticeIntent]) {
    for (const stage of intent.lifecycle) {
      assert.doesNotMatch(stage.label, /APP-42|QA-104/);
    }
    for (const scenario of intent.scenarios) {
      for (const assertion of scenario.assertions) {
        assert.doesNotMatch(assertion, /APP-42|QA-104/);
      }
    }
    assert.doesNotMatch(intent.summary, /APP-42|QA-104/);
  }
});

test("short acronym directory segments keep their uppercase form in flow titles", async (t) => {
  const root = await makeRepo(t);
  const noticeFile = "modules/ee/inspector/notice.tsx";
  await write(root, "package.json", JSON.stringify({ name: "acronym-app", private: true }));
  await write(root, noticeFile, "export const Notice = () => 'visible';\n");
  commit(root, "chore: baseline");
  branch(root, "feature/notice");
  await write(
    root,
    noticeFile,
    [
      "export function Notice(dismissed) {",
      "  if (dismissed) return 'hidden';",
      "  return 'visible';",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "fix: hide the dismissed inspector notice");

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const titles = qa.flows.map((flow) => flow.title).join(" | ");
  assert.doesNotMatch(titles, /\bEe\b/);
  assert.match(titles, /\bEE\b/);
});

test("symbol-derived lifecycle labels read behaviorally instead of exposing raw identifiers", async (t) => {
  const root = await makeRepo(t);
  const draftFile = "src/journals/saveJournalDraft.ts";
  await write(root, draftFile, "export const saveJournalDraft = () => 'idle';\n");
  commit(root, "chore: baseline");
  branch(root, "feature/journal-draft");
  await write(
    root,
    draftFile,
    [
      "export function saveJournalDraft(draft) {",
      "  setDraftMode(draft);",
      "  sendJournalReceipt(draft);",
      "  showSavedBanner();",
      "  return 'Draft stored';",
      "}",
      "",
    ].join("\n"),
  );
  commit(root, "feat: keep a journal draft while editing");

  const analysis = await analyze(root, [draftFile]);
  const labels = analysis.intents.flatMap((intent) => intent.lifecycle.map((stage) => stage.label));
  const joined = labels.join(" | ");

  // Setter-derived state changes read as behavior, not as the setter name.
  assert.match(joined, /Update the draft mode state\./);
  assert.doesNotMatch(joined, /Update state through setDraftMode/);
  // Side effects and outcomes that cannot be phrased naturally mark the
  // identifier as code instead of presenting it as prose.
  assert.match(joined, /Invoke `sendJournalReceipt`\./);
  assert.match(joined, /Observe the result of `showSavedBanner`\./);

  // Derived assertions keep the code marking.
  const assertions = analysis.intents.flatMap((intent) =>
    intent.scenarios.flatMap((scenario) => scenario.assertions)
  );
  assert.ok(assertions.some((assertion) => assertion.includes("`showSavedBanner`")));

  // Exact symbols stay available as evidence.
  const evidenceSymbols = analysis.intents.flatMap((intent) =>
    intent.evidence.map((item) => item.symbol).filter(Boolean)
  );
  assert.ok(evidenceSymbols.includes("setDraftMode"));
});

test("a branch of only cleanup commits keeps its newest cleanup intent first", async (t) => {
  const root = await makeRepo(t);
  const labelFile = "src/listings/listingLabels.ts";
  const entryFile = "src/journals/journalEntry.ts";

  await write(root, labelFile, "export const listingLabel = () => 'Listing';\n");
  await write(root, entryFile, "export const journalEntry = () => 'Entry';\n");
  commit(root, "chore: baseline");
  branch(root, "chore/cleanup-pass");

  await write(root, labelFile, "export const listingLabel = () => 'Listing label';\n");
  commit(root, "fix: reformat listing labels");

  await write(root, entryFile, "export const journalEntry = () => 'Journal entry';\n");
  commit(root, "fix: minor refactor");

  const analysis = await analyze(root, [labelFile, entryFile]);

  assert.ok(analysis.intents.length >= 2);
  assert.match(analysis.intents[0].title, /minor refactor/i);
});

test("diff evidence reserves the latest commit before large branch history", async (t) => {
  const root = await makeRepo(t);
  const latestTestFile = "src/z-latest/RevenueScreen.test.tsx";
  const historicalFiles = Array.from(
    { length: 200 },
    (_, index) => `src/history/Feature${String(index).padStart(3, "0")}.ts`,
  );

  for (const file of historicalFiles) {
    await write(root, file, "export const state = 'before';\n");
  }
  await write(root, latestTestFile, "it('keeps the original layout', () => expect(true).toBe(true));\n");
  commit(root, "chore: baseline");
  branch(root, "feature/large-history");

  for (const file of historicalFiles) {
    await write(root, file, "export const state = 'after';\n");
  }
  commit(root, "feat: migrate historical surfaces");

  await write(
    root,
    latestTestFile,
    [
      "it('keeps the original layout', () => expect(true).toBe(true));",
      "it('matches the current reward layout', () => expect(true).toBe(true));",
      "",
    ].join("\n"),
  );
  commit(root, "fix: align the current reward layout");

  const evidence = await collectAddedDiffEvidence(root, { base: "main", head: "HEAD" });

  assert.equal(Object.keys(evidence).length, 200);
  assert.equal(Object.keys(evidence)[0], latestTestFile);
  assert.ok(
    evidence[latestTestFile].some((hunk) =>
      hunk.lines.some((line) => /matches the current reward layout/i.test(line.text))
    ),
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
