import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { analyzeChangeIntents } from "../dist/change-intent.js";
import { generateE2eDraft, generateE2ePlan } from "../dist/e2e.js";
import { formatAgentQaDraft, formatMarkdownQaDraft, generateQaDraft } from "../dist/qa.js";
import { buildQaReasoningTraces, qaTraceIdForScenario } from "../dist/qa-trace.js";
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
  assert.equal(reviewTrace.behavior[0].relation, "evidence-linked");
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
  assert.equal(partialTrace.behavior[0].relation, "intent-context");
  assert.equal(partialTrace.artifact?.draftPath, "tests/e2e/preferences.spec.ts");
  assert.ok(partialTrace.gaps.some((gap) => /No lifecycle stage shares/.test(gap)));
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
  assert.ok(compactSummary.traces.length > 0);
  assert.equal(typeof compactSummary.traces[0].source.file, "string");
  assert.ok(compactSummary.intents[0].scenarios[0].sources.length > 0);
  assert.equal(compactSummary.flows[0].source, qa.flows[0].source);
  assert.ok(compactSummary.flows[0].changedFiles.length > 0);
  assert.equal(typeof compactSummary.flows[0].reviewQuestion, "string");
  assert.equal(typeof compactSummary.flows[0].successSignal, "string");
  assert.ok(compactSummary.flows[0].steps.length > 0);
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
  assert.ok(
    plan.flows[0].steps.some((step) => /verify visible text "Preferences saved" appears/i.test(step)),
    `expected observable outcome in flow steps, got: ${JSON.stringify(plan.flows[0].steps)}`,
  );
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
  assert.ok(requiredTrace.sources.some((source) => source.file === "src/pages/preferences.tsx" && source.startLine));
  assert.ok(requiredTrace.behavior.some((stage) => stage.relation === "evidence-linked"));
  assert.ok(requiredTrace.artifact?.draftPath.endsWith(".spec.ts"));
  assert.equal(requiredTrace.execution, "not-run");
  assert.equal(agentSummary.traceCount, qa.traces.length);
  assert.ok(agentSummary.traces.length > 0);
  assert.ok(agentSummary.traces.every((trace) => trace.source?.file && trace.behavior?.phase));
  assert.ok(agentSummary.traces.every((trace) => trace.execution === "not-run"));
  assert.match(qaMarkdown, /Source: `src\/pages\/preferences\.tsx:\d+` symbol/);
  assert.match(qaMarkdown, /confidence: (?:medium|high)/);
  assert.match(qaMarkdown, /Scenario routing:/);
  assert.match(qaMarkdown, /E2E draft mapping:/);
  assert.match(qaMarkdown, /## QA Reasoning Trace/);
  assert.match(qaMarkdown, /1\. Diff evidence:[\s\S]*2\. Affected behavior:[\s\S]*3\. Risk:[\s\S]*4\. QA scenario:/);
  assert.match(qaMarkdown, /Product QA execution: not run/);
  assert.equal(agentSummary.execution.status, "not-run");
  assert.match(qaMarkdown, /## Optional Automation/);
  assert.doesNotMatch(qaMarkdown, /Install command|First E2E Draft Bootstrap/);
  assert.match(spec, /Change intent evidence:/);
  assert.match(spec, /Behavior lifecycle:/);
  assert.match(spec, /trace:[a-f0-9]{12}/);
  assert.match(spec, /Diff source: src\/pages\/preferences\.tsx:\d+/);
  assert.match(spec, /Failure, timeout, and retry handling/);

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
