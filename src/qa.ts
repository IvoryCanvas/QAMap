import path from "node:path";
import { formatDraftReadinessStage, generateE2eDraft } from "./e2e.js";
import type {
  E2eDraftActionItem,
  E2eDraftFile,
  E2eDraftOptions,
  E2eDraftReadinessSummary,
  E2eDraftResult,
  E2eFlowLanguageBrief,
  E2eProjectType,
  E2eRunnerName,
} from "./e2e.js";
import { TOOL_NAME, VERSION } from "./version.js";

export interface QaDraftOptions extends Omit<E2eDraftOptions, "dryRun" | "output"> {}

export interface QaDraftResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  generatedAt: string;
  base: string;
  head: string;
  project: E2eProjectType;
  runner: E2eRunnerName;
  manifestPath?: string;
  noCloud: true;
  noLlmToken: true;
  testSuite: E2eDraftResult["plan"]["testSuite"];
  bootstrap: E2eDraftResult["plan"]["bootstrap"];
  runnerSetup: E2eDraftResult["plan"]["runnerSetup"];
  changeAnalysis: E2eDraftResult["plan"]["changeAnalysis"];
  readiness: E2eDraftReadinessSummary;
  flows: QaDraftFlow[];
  missingEvidence: QaDraftMissingEvidence[];
  prChecklist: string[];
  agentHandoff: string[];
  suggestedCommands: string[];
}

export interface QaDraftFlow {
  title: string;
  source: string;
  draftPath: string;
  runnableStatus?: E2eDraftFile["runnableStatus"];
  promotionStatus?: E2eDraftFile["promotionStatus"];
  changedFiles: string[];
  userJourney?: E2eFlowLanguageBrief;
  draftSteps: string[];
  coverageTargets: string[];
  entrypointHints: string[];
  selectorHints: string[];
  existingEvidencePaths: string[];
  verificationMode?: QaVerificationMode;
  setupHints: string[];
  manifestUpdatePath?: string;
  why: string[];
}

type QaVerificationMode = "existing-test-evidence" | "configuration" | "documentation" | "generated-artifact";

export interface QaDraftMissingEvidence {
  flowTitle: string;
  priority: "required" | "recommended";
  kind: string;
  title: string;
  detail: string;
}

export async function generateQaDraft(rootInput: string, options: QaDraftOptions = {}): Promise<QaDraftResult> {
  const root = path.resolve(rootInput);
  const draft = await generateE2eDraft(root, {
    ...options,
    dryRun: true,
  });
  const flows = draft.files.map((file) => qaFlowFromDraftFile(file));
  const missingEvidence = buildMissingEvidence(draft.files);

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    generatedAt: new Date().toISOString(),
    base: draft.plan.base,
    head: draft.plan.head,
    project: draft.plan.project.type,
    runner: draft.runner,
    manifestPath: draft.plan.verificationManifestPath,
    noCloud: true,
    noLlmToken: true,
    testSuite: draft.plan.testSuite,
    bootstrap: draft.plan.bootstrap,
    runnerSetup: draft.plan.runnerSetup,
    changeAnalysis: draft.plan.changeAnalysis,
    readiness: draft.readinessSummary,
    flows,
    missingEvidence,
    prChecklist: buildPrChecklist(draft, flows, missingEvidence),
    agentHandoff: buildAgentHandoff(draft, flows, missingEvidence),
    suggestedCommands: draft.plan.suggestedCommands,
  };
}

const agentListLimit = 6;

function truncateForAgent(value: string, maxLength = 140): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function formatAgentQaDraft(result: QaDraftResult): string {
  const requiredEvidence = result.missingEvidence
    .filter((item) => item.priority === "required")
    .slice(0, 8)
    .map((item) => ({ flow: truncateForAgent(item.flowTitle, 80), kind: item.kind, title: truncateForAgent(item.title) }));
  const requiredBootstrap = result.bootstrap.steps
    .filter((step) => step.status === "required")
    .slice(0, 3)
    .map((step) => ({ title: truncateForAgent(step.title, 80), action: truncateForAgent(step.action) }));
  const summary = {
    schema: { name: "qamap.qa", version: 1 },
    base: result.base,
    head: result.head,
    project: result.project,
    runner: result.runner,
    manifest: result.manifestPath ?? null,
    readiness: { score: result.readiness.score, level: result.readiness.level },
    testSuite: { present: result.testSuite.hasTestSuite, files: result.testSuite.testFileCount },
    intents: result.changeAnalysis.intents.slice(0, 3).map((intent) => ({
      title: truncateForAgent(intent.title, 100),
      confidence: intent.confidence,
      reviewRequired: intent.reviewRequired,
      evidence: intent.evidence.slice(0, 4).map((item) => truncateForAgent(item.value, 100)),
      lifecycle: intent.lifecycle.slice(0, 8).map((stage) => ({
        phase: stage.kind,
        label: truncateForAgent(stage.label, 120),
      })),
      scenarios: intent.scenarios.slice(0, 4).map((scenario) => ({
        priority: scenario.priority,
        kind: scenario.kind,
        title: truncateForAgent(scenario.title, 100),
        assertions: scenario.assertions.slice(0, 3).map((assertion) => truncateForAgent(assertion, 120)),
      })),
    })),
    firstDraftCommand: !result.testSuite.hasTestSuite && needsGeneratedDraft(result)
      ? firstDraftCreateCommand(result)
      : undefined,
    flows: result.flows.slice(0, agentListLimit).map((flow) => ({
      title: truncateForAgent(flow.title, 80),
      source: flow.source,
      draft: flow.draftPath,
      runnable: flow.runnableStatus,
      verificationMode: flow.verificationMode,
      entry: flow.entrypointHints[0],
      changedFiles: flow.changedFiles.slice(0, 4),
      reviewQuestion: flow.userJourney?.reviewQuestion
        ? truncateForAgent(flow.userJourney.reviewQuestion, 180)
        : undefined,
      successSignal: flow.userJourney?.successSignal
        ? truncateForAgent(flow.userJourney.successSignal)
        : undefined,
      steps: flow.draftSteps.slice(0, agentListLimit).map((step) => truncateForAgent(step)),
      selectors: flow.selectorHints.slice(0, 5).map((selector) => truncateForAgent(selector, 100)),
      existingEvidence: flow.existingEvidencePaths.length > 0 ? flow.existingEvidencePaths.slice(0, 4) : undefined,
      evidence: flow.why.slice(0, 2).map((reason) => truncateForAgent(reason)),
    })),
    requiredEvidence,
    recommendedEvidenceCount: result.missingEvidence.filter((item) => item.priority === "recommended").length,
    requiredBootstrap,
    prChecklist: result.prChecklist.slice(0, agentListLimit).map((item) => truncateForAgent(item)),
    commands: result.suggestedCommands.slice(0, 4),
  };
  return `${JSON.stringify(summary)}\n`;
}

export function formatMarkdownQaDraft(result: QaDraftResult): string {
  const lines: string[] = [];
  lines.push("# QAMap QA Draft");
  lines.push("");
  lines.push("> Local-first PR QA skill output. No cloud. No LLM token. Manifest is optional, not required for first use.");
  lines.push("");
  lines.push("## At a Glance");
  lines.push("");
  const primaryIntent = result.changeAnalysis.intents[0];
  if (primaryIntent) {
    lines.push(`- Change intent: ${escapeMarkdownInline(primaryIntent.title)} [${primaryIntent.confidence}]`);
    const lifecycle = summarizeIntentLifecycle(primaryIntent.lifecycle);
    if (lifecycle) {
      lines.push(`- Behavior lifecycle: ${escapeMarkdownInline(lifecycle)}`);
    }
    if (primaryIntent.reviewRequired) {
      lines.push("- Intent confidence: human review is required before treating generated scenarios as regression policy.");
    }
  } else {
    lines.push("- Change intent: not inferred; heuristic flow suggestions remain review-only.");
  }
  if (result.flows.length === 0) {
    lines.push("- Affected behavior: no changed flow candidate was generated from this diff.");
  } else {
    const flowTitles = result.flows.slice(0, 3).map((flow) => escapeMarkdownInline(flow.title)).join(", ");
    const moreFlows = result.flows.length > 3 ? ` and ${result.flows.length - 3} more` : "";
    lines.push(`- Affected behavior: ${flowTitles}${moreFlows}`);
    const primaryFlow = result.flows[0];
    if (primaryFlow.userJourney?.reviewQuestion) {
      lines.push(`- Verify before merge: ${escapeMarkdownInline(primaryFlow.userJourney.reviewQuestion)}`);
    }
    const evidence = atAGlanceEvidence(primaryFlow);
    if (evidence.length > 0) {
      lines.push(`- Evidence found: ${evidence.map(escapeMarkdownInline).join("; ")}`);
    }
    if (primaryFlow.existingEvidencePaths.length > 0) {
      lines.push(
        `- Existing test evidence: ${primaryFlow.existingEvidencePaths.slice(0, 3).map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`,
      );
    } else if (primaryFlow.verificationMode) {
      lines.push(`- Verification mode: ${formatVerificationMode(primaryFlow.verificationMode)}; no new product-journey E2E draft is proposed.`);
    } else {
      lines.push(
        `- Proposed draft: \`${escapeMarkdownInline(primaryFlow.draftPath)}\` (${formatRunnableStatus(primaryFlow.runnableStatus)})`,
      );
    }
  }
  lines.push(`- Next command: \`${escapeMarkdownInline(nextStepCommand(result))}\``);
  const blocking = result.missingEvidence.filter((item) => item.priority === "required").slice(0, 2);
  if (blocking.length === 0) {
    lines.push("- Missing before trust: no required evidence gap detected; review the draft and run the validation command.");
  } else {
    for (const [index, item] of blocking.entries()) {
      lines.push(
        `- Missing before trust${blocking.length > 1 ? ` ${index + 1}` : ""}: ${escapeMarkdownInline(item.title)} — ${escapeMarkdownInline(item.detail)}`,
      );
    }
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
  lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
  lines.push(`- Project: ${formatProjectType(result.project)}`);
  lines.push(`- Automation adapter: ${formatRunnerName(result.runner)}`);
  lines.push(`- Manifest: ${result.manifestPath ? `\`${escapeMarkdownInline(result.manifestPath)}\`` : "not found; using repo signals and PR diff only"}`);
  lines.push(`- Stage: ${formatDraftReadinessStage(result.readiness)}`);
  lines.push(`- Draft flows: ${result.flows.length}`);
  lines.push("");

  appendQaChangeIntentMarkdown(lines, result);

  if (!result.testSuite.hasTestSuite && needsGeneratedDraft(result)) {
    lines.push("## First E2E Draft Bootstrap");
    lines.push("");
    lines.push(
      `QAMap did not find committed test files for this target. The next step is to create the first runnable starter draft, not to stop at a checklist.`,
    );
    lines.push("");
    lines.push(`- Recommended first runner: ${formatRunnerName(result.runner)}`);
    lines.push(`- Create command: \`${escapeMarkdownInline(firstDraftCreateCommand(result))}\``);
    const installCommand = result.runnerSetup.installCommands[0];
    if (installCommand) {
      lines.push(`- Install command: \`${escapeMarkdownInline(installCommand)}\``);
    }
    const filesToCreate = uniqueStrings([...result.runnerSetup.filesToCreate, ...result.flows.map((flow) => flow.draftPath)]);
    if (filesToCreate.length > 0) {
      lines.push("- Draft files QAMap can create:");
      for (const file of filesToCreate.slice(0, 6)) {
        lines.push(`  - \`${escapeMarkdownInline(file)}\``);
      }
    }
    const filesToUpdate = result.runnerSetup.filesToUpdate;
    if (filesToUpdate.length > 0) {
      lines.push(`- Files to update: ${filesToUpdate.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`);
    }
    lines.push("- Generated drafts are starter E2E code; keep them review-only until the changed flow has real assertions, fixtures, and selectors.");
    lines.push("");
  }

  lines.push("## PR Comment Draft");
  lines.push("");
  lines.push("### Affected Flow");
  lines.push("");
  if (result.flows.length === 0) {
    lines.push("- No changed flow candidate was generated. Run from a branch with changed files or include working tree changes.");
  } else {
    for (const flow of result.flows) {
      lines.push(`- ${escapeMarkdownInline(flow.title)} (${flow.source})`);
      if (flow.userJourney) {
        lines.push(`  - User journey: ${escapeMarkdownInline(flow.userJourney.actor)} -> ${escapeMarkdownInline(flow.userJourney.trigger)} -> ${escapeMarkdownInline(flow.userJourney.goal)}`);
        lines.push(`  - Success signal: ${escapeMarkdownInline(flow.userJourney.successSignal)}`);
        lines.push(`  - Reviewer question: ${escapeMarkdownInline(flow.userJourney.reviewQuestion)}`);
      }
      if (flow.changedFiles.length > 0) {
        lines.push(`  - Changed files: ${flow.changedFiles.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`);
      }
      for (const reason of flow.why.slice(0, 3)) {
        lines.push(`  - Why: ${escapeMarkdownInline(reason)}`);
      }
    }
  }
  lines.push("");

  lines.push("### Suggested E2E / QA Draft");
  lines.push("");
  for (const flow of result.flows) {
    if (flow.existingEvidencePaths.length > 0) {
      lines.push(
        `- Run existing test evidence: ${flow.existingEvidencePaths.slice(0, 4).map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`,
      );
    } else if (flow.verificationMode) {
      lines.push(`- Run ${formatVerificationMode(flow.verificationMode)} with the suggested repository validation command; no new product-journey E2E draft is proposed.`);
    } else {
      lines.push(`- \`${escapeMarkdownInline(flow.draftPath)}\`: ${formatRunnableStatus(flow.runnableStatus)}`);
    }
    const routeHint = flow.entrypointHints.find((hint) => hint.startsWith("route:"));
    if (routeHint) {
      lines.push(`  - Entrypoint: ${escapeMarkdownInline(routeHint)}`);
    }
    const steps = flow.draftSteps.length > 0 ? flow.draftSteps : fallbackDraftSteps(flow);
    for (const step of steps.slice(0, 5)) {
      lines.push(`  - ${escapeMarkdownInline(step)}`);
    }
    if (flow.selectorHints.length > 0) {
      lines.push(`  - Selector evidence: ${flow.selectorHints.slice(0, 3).map(escapeMarkdownInline).join("; ")}`);
    }
    if (flow.manifestUpdatePath) {
      lines.push(`  - If wrong: update \`${escapeMarkdownInline(flow.manifestUpdatePath)}\``);
    }
  }
  lines.push("");

  lines.push("### Missing Evidence Before Trusting This PR");
  lines.push("");
  if (result.missingEvidence.length === 0) {
    lines.push("- No required evidence gap was detected in the generated QA draft. Still run the project validation command before merge.");
  } else {
    for (const item of result.missingEvidence.slice(0, 6)) {
      lines.push(`- [${item.priority}] ${item.kind}: ${escapeMarkdownInline(item.title)} - ${escapeMarkdownInline(item.detail)} (${escapeMarkdownInline(item.flowTitle)})`);
    }
    if (result.missingEvidence.length > 6) {
      lines.push(`- ... ${result.missingEvidence.length - 6} more lower-priority items (see \`--format json\` for the full list)`);
    }
  }
  lines.push("");

  lines.push("### PR Checklist");
  lines.push("");
  for (const item of result.prChecklist) {
    lines.push(`- [ ] ${escapeMarkdownInline(item)}`);
  }
  lines.push("");

  lines.push("## Agent Handoff");
  lines.push("");
  for (const item of result.agentHandoff) {
    lines.push(`- ${escapeMarkdownInline(item)}`);
  }
  lines.push("");

  return lines.join("\n");
}

function appendQaChangeIntentMarkdown(lines: string[], result: QaDraftResult): void {
  lines.push("## Change Intent Evidence");
  lines.push("");
  if (result.changeAnalysis.intents.length === 0) {
    lines.push("No behavior-bearing commit intent was found. QAMap did not promote inferred names into trusted QA scenarios.");
    lines.push("");
    return;
  }
  for (const intent of result.changeAnalysis.intents.slice(0, 3)) {
    lines.push(`### ${escapeMarkdownInline(intent.title)}`);
    lines.push("");
    lines.push(`- Confidence: ${intent.confidence}${intent.reviewRequired ? "; review required" : ""}`);
    for (const commit of intent.commits.slice(0, 5)) {
      lines.push(`- Evidence: \`${commit.sha.slice(0, 12)}\` ${escapeMarkdownInline(commit.subject)}`);
    }
    lines.push("- Lifecycle:");
    for (const stage of intent.lifecycle.slice(0, 10)) {
      lines.push(`  - ${stage.kind}: ${escapeMarkdownInline(stage.label)}`);
    }
    lines.push("- QA scenarios:");
    for (const scenario of intent.scenarios.slice(0, 4)) {
      lines.push(`  - [${scenario.priority}] ${escapeMarkdownInline(scenario.title)}`);
      for (const assertion of scenario.assertions.slice(0, 2)) {
        lines.push(`    - Assert: ${escapeMarkdownInline(assertion)}`);
      }
    }
    lines.push("");
  }
}

function summarizeIntentLifecycle(lifecycle: QaDraftResult["changeAnalysis"]["intents"][number]["lifecycle"]): string {
  const preferredPhases = ["trigger", "condition", "state-change", "side-effect", "observable-outcome"];
  const selected = preferredPhases
    .map((phase) => lifecycle.find((stage) => stage.kind === phase))
    .filter((stage): stage is NonNullable<typeof stage> => Boolean(stage));
  const fallback = selected.length > 0 ? selected : lifecycle.slice(0, 5);
  return fallback.map((stage) => `${stage.kind}: ${stage.label}`).join(" -> ");
}

function nextStepCommand(result: QaDraftResult): string {
  if (!result.testSuite.hasTestSuite && needsGeneratedDraft(result)) {
    return firstDraftCreateCommand(result);
  }
  const validationCommand = result.suggestedCommands[0];
  if (validationCommand) {
    return validationCommand;
  }
  const draftPath = result.flows[0]?.draftPath;
  return draftPath ? `review ${draftPath}` : "qamap e2e draft . --dry-run";
}

function atAGlanceEvidence(flow: QaDraftFlow): string[] {
  const stableSelector = flow.selectorHints.find((selector) =>
    /^(?:web-test-id|test-id|input-web-test-id|input-test-id|accessibility-label|role-button):/i.test(selector)
  ) ?? flow.selectorHints[0];
  const evidence = [
    flow.changedFiles[0] ? `changed file ${flow.changedFiles[0]}` : undefined,
    flow.entrypointHints[0],
    stableSelector,
  ].filter((value): value is string => Boolean(value));
  return uniqueStrings(evidence).slice(0, 3);
}

function firstDraftCreateCommand(result: QaDraftResult): string {
  if (result.runnerSetup.setupCommand) {
    return result.runnerSetup.setupCommand;
  }
  return `qamap e2e draft . --base ${result.base} --head ${result.head}`;
}

function qaFlowFromDraftFile(file: E2eDraftFile): QaDraftFlow {
  const verificationMode = verificationModeForTitle(file.flowTitle);
  return {
    title: file.flowTitle,
    source: formatDraftSource(file.source),
    draftPath: file.path,
    runnableStatus: file.runnableStatus,
    promotionStatus: file.promotionStatus,
    changedFiles: file.changedFiles ?? [],
    userJourney: file.languageBrief,
    draftSteps: file.draftSteps ?? [],
    coverageTargets: file.coverageTargets ?? [],
    entrypointHints: file.entrypointHints ?? [],
    selectorHints: file.selectorHints ?? [],
    existingEvidencePaths: isChangedTestEvidenceTitle(file.flowTitle) ? (file.changedFiles ?? []) : [],
    verificationMode,
    setupHints: file.setupHints ?? [],
    manifestUpdatePath: file.manifestUpdatePath,
    why: buildFlowReasons(file),
  };
}

function buildFlowReasons(file: E2eDraftFile): string[] {
  const verificationMode = verificationModeForTitle(file.flowTitle);
  if (verificationMode === "existing-test-evidence") {
    return ["Changed test files are existing QA evidence; run them instead of generating a duplicate draft."];
  }
  if (verificationMode === "configuration") {
    return ["Only build or runtime configuration changed; verify affected variants instead of inventing a product journey."];
  }
  if (verificationMode === "documentation") {
    return ["Documentation changed without a runtime product surface; validate the documented contract against repository behavior."];
  }
  if (verificationMode === "generated-artifact") {
    return ["Generated output changed; reproduce and validate the artifact instead of inventing a product journey."];
  }
  return [
    file.promotionReason,
    file.primaryEntrypoint ? `Primary entrypoint inferred as ${file.primaryEntrypoint}.` : undefined,
    file.coverageTargetCount ? `${file.coverageTargetCount} coverage target${file.coverageTargetCount === 1 ? "" : "s"} were selected for this flow.` : undefined,
    file.inferredSelectorCount ? `${file.inferredSelectorCount} selector hint${file.inferredSelectorCount === 1 ? "" : "s"} were detected.` : undefined,
  ].filter((value): value is string => Boolean(value));
}

function buildMissingEvidence(files: E2eDraftFile[]): QaDraftMissingEvidence[] {
  const evidence: QaDraftMissingEvidence[] = [];
  for (const file of files) {
    for (const item of file.actionItems ?? []) {
      evidence.push(missingEvidenceFromAction(file, item));
    }
    const actionText = normalizeEvidenceText(
      (file.actionItems ?? []).map((item) => `${item.title} ${item.detail}`).join(" "),
    );
    for (const blocker of file.executionBlockers ?? []) {
      if (actionTextCoversBlocker(actionText, blocker)) {
        continue;
      }
      evidence.push({
        flowTitle: file.flowTitle,
        priority: "required",
        kind: "blocker",
        title: "Resolve execution blocker",
        detail: blocker,
      });
    }
  }
  const unique = uniqueMissingEvidence(evidence);
  const required = unique.filter((item) => item.priority === "required");
  const recommended = unique.filter((item) => item.priority !== "required");
  return [...required, ...recommended].slice(0, 12);
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\uAC00-\uD7A3 ]+/g, " ").replace(/\s+/g, " ").trim();
}

function actionTextCoversBlocker(actionText: string, blocker: string): boolean {
  if (!actionText) {
    return false;
  }
  const blockerTokens = normalizeEvidenceText(blocker).split(" ").filter((token) => token.length > 3);
  if (blockerTokens.length === 0) {
    return false;
  }
  const covered = blockerTokens.filter((token) => actionText.includes(token)).length;
  return covered / blockerTokens.length >= 0.7;
}

function missingEvidenceFromAction(file: E2eDraftFile, item: E2eDraftActionItem): QaDraftMissingEvidence {
  return {
    flowTitle: file.flowTitle,
    priority: item.priority,
    kind: item.kind,
    title: item.title,
    detail: item.detail,
  };
}

function uniqueMissingEvidence(items: QaDraftMissingEvidence[]): QaDraftMissingEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.flowTitle}:${item.priority}:${item.kind}:${item.title}:${item.detail}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildPrChecklist(
  draft: E2eDraftResult,
  flows: QaDraftFlow[],
  missingEvidence: QaDraftMissingEvidence[],
): string[] {
  const checklist = [
    flows[0]?.existingEvidencePaths.length
      ? `Run the changed test evidence: ${flows[0].existingEvidencePaths.slice(0, 4).join(", ")}.`
      : flows[0]?.verificationMode
        ? `Run ${formatVerificationMode(flows[0].verificationMode)} with ${draft.plan.suggestedCommands[0] ?? "the nearest repository validation command"}.`
      : flows.length > 0
        ? `Review the generated draft path: ${flows.map((flow) => flow.draftPath).slice(0, 3).join(", ")}.`
      : "Run QAMap again after adding branch or working tree changes.",
    flows[0]?.userJourney?.reviewQuestion
      ? `Answer the reviewer question: ${flows[0].userJourney.reviewQuestion}`
      : "Name the user-visible behavior or contract this PR can break.",
  ];

  const required = missingEvidence.filter((item) => item.priority === "required");
  for (const item of required.slice(0, 4)) {
    checklist.push(`${item.title}: ${item.detail}`);
  }

  const validationCommand = draft.plan.suggestedCommands.find((command) => /\b(?:e2e|test|playwright|maestro)\b/i.test(command))
    ?? draft.plan.suggestedCommands[0];
  if (validationCommand) {
    checklist.push(`Run local validation: ${validationCommand}`);
  }

  if (!draft.plan.verificationManifestPath && flows.some((flow) => !flow.verificationMode)) {
    checklist.push("If this recommendation is useful, run `qamap manifest init .` later and review the generated manifest as team QA memory.");
  }

  return uniqueStrings(checklist).slice(0, 8);
}

function buildAgentHandoff(
  draft: E2eDraftResult,
  flows: QaDraftFlow[],
  missingEvidence: QaDraftMissingEvidence[],
): string[] {
  const handoff = [
    "Use this as a local PR QA skill result, not as proof that browser or device QA already passed.",
    draft.dryRun ? "No files were written because this command previews QA work only." : undefined,
    flows[0]?.existingEvidencePaths.length
      ? `Run the changed test evidence (${flows[0].existingEvidencePaths.slice(0, 3).join(", ")}) and record the result before handoff.`
      : flows[0]?.verificationMode
        ? `Run ${formatVerificationMode(flows[0].verificationMode)} and record the command and result before handoff; do not invent a product-journey E2E for this diff alone.`
      : flows.length > 0
        ? `Start from ${flows[0].draftPath} and close required evidence before treating it as regression coverage.`
        : undefined,
    missingEvidence.length > 0 ? "Close required evidence gaps before treating this QA draft as merge proof." : undefined,
    flows.some((flow) => !flow.verificationMode)
      ? "A wrong flow recommendation should become a manifest correction, so future PRs improve without another prompt."
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return uniqueStrings(handoff);
}

function isChangedTestEvidenceTitle(title: string): boolean {
  return /^Changed test evidence verification checklist$/i.test(title.trim());
}

function verificationModeForTitle(title: string): QaVerificationMode | undefined {
  if (isChangedTestEvidenceTitle(title)) {
    return "existing-test-evidence";
  }
  if (/\bconfiguration verification\b/i.test(title)) {
    return "configuration";
  }
  if (/\bdocumentation verification\b/i.test(title)) {
    return "documentation";
  }
  if (/\bgenerated artifact verification\b/i.test(title)) {
    return "generated-artifact";
  }
  return undefined;
}

function needsGeneratedDraft(result: QaDraftResult): boolean {
  return result.flows.some((flow) => !flow.verificationMode);
}

function formatVerificationMode(mode: QaVerificationMode): string {
  if (mode === "existing-test-evidence") {
    return "the changed test evidence";
  }
  if (mode === "configuration") {
    return "build and configuration verification";
  }
  if (mode === "documentation") {
    return "documentation contract verification";
  }
  return "generated artifact verification";
}

function fallbackDraftSteps(flow: QaDraftFlow): string[] {
  if (!flow.userJourney) {
    return ["Review the changed files and create the smallest QA path that proves the changed behavior."];
  }
  return [
    flow.userJourney.trigger,
    flow.userJourney.goal,
    `Assert ${flow.userJourney.successSignal}.`,
  ];
}

function formatDraftSource(source: E2eDraftFile["source"]): string {
  if (source === "verification-manifest") {
    return "manifest-backed";
  }
  if (source === "domain-language") {
    return "domain-language";
  }
  if (source === "change-intent") {
    return "commit-and-diff-intent";
  }
  if (source === "core-flow") {
    return "core-flow";
  }
  return "repo-signals";
}

function formatRunnableStatus(status: E2eDraftFile["runnableStatus"]): string {
  if (status === "runnable-candidate") {
    return "runnable candidate";
  }
  if (status === "near-runnable") {
    return "near runnable";
  }
  return "review only";
}

function formatProjectType(type: E2eProjectType): string {
  if (type === "expo-react-native") {
    return "Expo / React Native";
  }
  if (type === "react-native") {
    return "React Native";
  }
  if (type === "web") {
    return "Web";
  }
  if (type === "api-service") {
    return "API / service";
  }
  if (type === "design-tokens") {
    return "Design tokens";
  }
  if (type === "data-catalog") {
    return "Data catalog";
  }
  if (type === "cli") {
    return "CLI";
  }
  return "Unknown";
}

function formatRunnerName(runner: E2eRunnerName): string {
  if (runner === "maestro") {
    return "Maestro";
  }
  if (runner === "playwright") {
    return "Playwright";
  }
  return "Manual";
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}
