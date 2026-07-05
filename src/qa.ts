import path from "node:path";
import { generateE2eDraft } from "./e2e.js";
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
  setupHints: string[];
  manifestUpdatePath?: string;
  why: string[];
}

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
    firstDraftCommand: result.testSuite.hasTestSuite ? undefined : firstDraftCreateCommand(result),
    flows: result.flows.slice(0, agentListLimit).map((flow) => ({
      title: truncateForAgent(flow.title, 80),
      source: flow.source,
      draft: flow.draftPath,
      runnable: flow.runnableStatus,
      entry: flow.entrypointHints[0],
      steps: flow.draftSteps.slice(0, agentListLimit).map((step) => truncateForAgent(step)),
      selectors: flow.selectorHints.slice(0, 5).map((selector) => truncateForAgent(selector, 100)),
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
  if (result.flows.length === 0) {
    lines.push("- Affected: no changed flow candidate was generated from this diff.");
  } else {
    const flowTitles = result.flows.slice(0, 3).map((flow) => escapeMarkdownInline(flow.title)).join(", ");
    const moreFlows = result.flows.length > 3 ? ` and ${result.flows.length - 3} more` : "";
    lines.push(`- Affected: ${flowTitles}${moreFlows}`);
  }
  lines.push(`- Do next: \`${escapeMarkdownInline(nextStepCommand(result))}\``);
  const blocking = result.missingEvidence.filter((item) => item.priority === "required").slice(0, 2);
  if (blocking.length === 0) {
    lines.push("- Blocking: nothing blocking detected; review the draft and run the validation command.");
  } else {
    for (const [index, item] of blocking.entries()) {
      lines.push(`- Blocking${blocking.length > 1 ? ` ${index + 1}` : ""}: ${escapeMarkdownInline(item.title)} — ${escapeMarkdownInline(item.detail)}`);
    }
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
  lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
  lines.push(`- Project: ${formatProjectType(result.project)}`);
  lines.push(`- Recommended runner: ${formatRunnerName(result.runner)}`);
  lines.push(`- Manifest: ${result.manifestPath ? `\`${escapeMarkdownInline(result.manifestPath)}\`` : "not found; using repo signals and PR diff only"}`);
  lines.push(`- Readiness: ${result.readiness.level} (${result.readiness.score}/100)`);
  lines.push(`- Draft flows: ${result.flows.length}`);
  lines.push("");

  if (!result.testSuite.hasTestSuite) {
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
    lines.push(`- \`${escapeMarkdownInline(flow.draftPath)}\`: ${formatRunnableStatus(flow.runnableStatus)}`);
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

function nextStepCommand(result: QaDraftResult): string {
  if (!result.testSuite.hasTestSuite) {
    return firstDraftCreateCommand(result);
  }
  const validationCommand = result.suggestedCommands[0];
  if (validationCommand) {
    return validationCommand;
  }
  const draftPath = result.flows[0]?.draftPath;
  return draftPath ? `review ${draftPath}` : "qamap e2e draft . --dry-run";
}

function firstDraftCreateCommand(result: QaDraftResult): string {
  if (result.runnerSetup.setupCommand) {
    return result.runnerSetup.setupCommand;
  }
  return `qamap e2e draft . --base ${result.base} --head ${result.head}`;
}

function qaFlowFromDraftFile(file: E2eDraftFile): QaDraftFlow {
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
    setupHints: file.setupHints ?? [],
    manifestUpdatePath: file.manifestUpdatePath,
    why: buildFlowReasons(file),
  };
}

function buildFlowReasons(file: E2eDraftFile): string[] {
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
    flows.length > 0
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

  if (!draft.plan.verificationManifestPath) {
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
    flows.length > 0 ? `Start from ${flows[0].draftPath} and close required evidence before treating it as regression coverage.` : undefined,
    missingEvidence.length > 0 ? "Prefer fixing required fixture, selector, runner, or assertion gaps before adding broad manual QA notes." : undefined,
    "A wrong flow recommendation should become a manifest correction, so future PRs improve without another prompt.",
  ].filter((value): value is string => Boolean(value));
  return uniqueStrings(handoff);
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
