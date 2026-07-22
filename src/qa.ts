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
  E2eScenarioAutomationReceipt,
} from "./e2e.js";
import type { ChangeIntentEvidence } from "./change-intent.js";
import { buildQaReasoningTraces } from "./qa-trace.js";
import type { QaReasoningTrace } from "./qa-trace.js";
import { routeQaScenario } from "./scenario-routing.js";
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
  baseResolution: E2eDraftResult["plan"]["baseResolution"];
  head: string;
  includeWorkingTree: boolean;
  project: E2eProjectType;
  runner: E2eRunnerName;
  manifestPath?: string;
  noCloud: true;
  noLlmToken: true;
  execution: QaExecutionReceipt;
  testSuite: E2eDraftResult["plan"]["testSuite"];
  bootstrap: E2eDraftResult["plan"]["bootstrap"];
  runnerSetup: E2eDraftResult["plan"]["runnerSetup"];
  changeAnalysis: E2eDraftResult["plan"]["changeAnalysis"];
  traces: QaReasoningTrace[];
  route: QaRouteDecision;
  readiness: QaReadinessSummary;
  flows: QaDraftFlow[];
  missingEvidence: QaDraftMissingEvidence[];
  prChecklist: string[];
  agentHandoff: string[];
  suggestedCommands: string[];
}

export type QaReadinessBasis = "optional-automation" | "repository-validation";
export type QaVerificationStatus = "ready-to-run" | "command-needed";
export type QaRouteStatus =
  | "draft-ready"
  | "draft-near-runnable"
  | "draft-needs-work"
  | "draft-blocked"
  | "verification-ready-to-run"
  | "verification-command-needed";
export type QaRouteNextAction =
  | "review-and-run-draft"
  | "complete-draft-evidence"
  | "run-repository-command"
  | "define-repository-command";

export interface QaRouteDecision {
  basis: QaReadinessBasis;
  status: QaRouteStatus;
  nextAction: QaRouteNextAction;
  command?: string;
}

export interface QaReadinessSummary extends E2eDraftReadinessSummary {
  basis: QaReadinessBasis;
  automationApplicable: boolean;
  verificationStatus?: QaVerificationStatus;
}

export interface QaExecutionReceipt {
  status: "not-run";
  performed: false;
  scope: "static-analysis-and-draft-mapping";
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
  scenarioAutomation: E2eScenarioAutomationReceipt[];
  why: string[];
}

type QaVerificationMode =
  | "command-contract"
  | "analysis-rule"
  | "existing-test-evidence"
  | "configuration"
  | "documentation"
  | "generated-artifact";

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
  const qaFiles = draft.plan.changedFiles.length > 0 ? draft.files : [];
  const flows = qaFiles.map((file) => qaFlowFromDraftFile(file));
  const changedFiles = draft.plan.changedFiles.map((file) => file.path);
  const preferredVerificationCommand = buildChangedTestVerificationCommand(
    flows,
    changedFiles,
    draft.plan.suggestedCommands,
  );
  const suggestedCommands = preferredVerificationCommand
    ? uniqueStrings([preferredVerificationCommand, ...draft.plan.suggestedCommands])
    : draft.plan.suggestedCommands;
  const missingEvidence = buildMissingEvidence(qaFiles);
  const traces = buildQaReasoningTraces(
    draft.plan.changeAnalysis.intents,
    flows.flatMap((flow) => flow.scenarioAutomation.map((receipt) => ({
      scenarioId: receipt.scenarioId,
      flowTitle: flow.title,
      draftPath: flow.draftPath,
      status: receipt.status,
      mappedSteps: receipt.mappedSteps,
      totalSteps: receipt.totalSteps,
      mappedAssertions: receipt.mappedAssertions,
      totalAssertions: receipt.totalAssertions,
    }))),
  );
  const readiness = buildQaReadiness(draft.readinessSummary, flows, suggestedCommands, changedFiles);
  const route = buildQaRouteDecision(readiness, suggestedCommands);

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    generatedAt: new Date().toISOString(),
    base: draft.plan.base,
    baseResolution: draft.plan.baseResolution,
    head: draft.plan.head,
    includeWorkingTree: draft.plan.includeWorkingTree,
    project: draft.plan.project.type,
    runner: draft.runner,
    manifestPath: draft.plan.verificationManifestPath,
    noCloud: true,
    noLlmToken: true,
    execution: {
      status: "not-run",
      performed: false,
      scope: "static-analysis-and-draft-mapping",
    },
    testSuite: draft.plan.testSuite,
    bootstrap: draft.plan.bootstrap,
    runnerSetup: draft.plan.runnerSetup,
    changeAnalysis: draft.plan.changeAnalysis,
    traces,
    route,
    readiness,
    flows,
    missingEvidence,
    prChecklist: buildPrChecklist(draft, flows, suggestedCommands),
    agentHandoff: buildAgentHandoff(draft, flows, missingEvidence, suggestedCommands),
    suggestedCommands,
  };
}

function buildQaRouteDecision(
  readiness: QaReadinessSummary,
  suggestedCommands: string[],
): QaRouteDecision {
  if (readiness.basis === "repository-validation") {
    const command = suggestedCommands[0];
    return command
      ? {
          basis: "repository-validation",
          status: "verification-ready-to-run",
          nextAction: "run-repository-command",
          command,
        }
      : {
          basis: "repository-validation",
          status: "verification-command-needed",
          nextAction: "define-repository-command",
        };
  }

  return {
    basis: "optional-automation",
    status: `draft-${readiness.level}`,
    nextAction: readiness.level === "ready" ? "review-and-run-draft" : "complete-draft-evidence",
  };
}

function buildQaReadiness(
  readiness: E2eDraftReadinessSummary,
  flows: QaDraftFlow[],
  suggestedCommands: string[],
  changedFiles: string[],
): QaReadinessSummary {
  const repositoryValidation = flows.length > 0 && (
    flows.every((flow) => Boolean(flow.verificationMode)) ||
    shouldRunChangedTestEvidence(flows, changedFiles)
  );
  if (!repositoryValidation) {
    return {
      ...readiness,
      basis: "optional-automation",
      automationApplicable: true,
    };
  }
  return {
    ...readiness,
    basis: "repository-validation",
    automationApplicable: false,
    verificationStatus: suggestedCommands.length > 0 ? "ready-to-run" : "command-needed",
  };
}

function shouldRunChangedTestEvidence(flows: QaDraftFlow[], changedFiles: string[]): boolean {
  const changed = new Set(changedFiles);
  const hasChangedRelatedTest = flows.some((flow) =>
    flow.existingEvidencePaths.some((file) => changed.has(file))
  );
  const scenarioReceipts = flows.flatMap((flow) => flow.scenarioAutomation);
  return hasChangedRelatedTest &&
    scenarioReceipts.length > 0 &&
    scenarioReceipts.every((receipt) => receipt.decision === "review-only");
}

function buildChangedTestVerificationCommand(
  flows: QaDraftFlow[],
  changedFiles: string[],
  suggestedCommands: string[],
): string | undefined {
  const changed = new Set(changedFiles);
  const changedEvidence = uniqueStrings(
    flows.flatMap((flow) => flow.existingEvidencePaths).filter((file) => changed.has(file)),
  );
  if (changedEvidence.length === 0) {
    return undefined;
  }
  const pytest = suggestedCommands.find((command) => /^pytest(?:\s|$)/i.test(command));
  const pythonTests = changedEvidence.filter((file) => /(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/i.test(file));
  if (pytest && pythonTests.length > 0) {
    return `pytest ${pythonTests.slice(0, 4).join(" ")}`;
  }
  const packageTest = suggestedCommands.find((command) => /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test(?:\s|$)/i.test(command));
  if (packageTest && pythonTests.length > 0) {
    return `${packageTest} -- ${pythonTests.slice(0, 4).join(" ")}`;
  }
  return undefined;
}

const agentListLimit = 6;
const agentPayloadByteLimit = 4 * 1024 - 1;

function truncateForAgent(value: string, maxLength = 140): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function formatAgentQaDraft(result: QaDraftResult): string {
  const scenarioAutomationById = new Map(
    result.flows.flatMap((flow) => flow.scenarioAutomation).map((receipt) => [receipt.scenarioId, receipt]),
  );
  const requiredEvidence = result.missingEvidence
    .filter((item) => item.priority === "required")
    .slice(0, 8)
    .map((item) => ({ flow: truncateForAgent(item.flowTitle, 80), kind: item.kind, title: truncateForAgent(item.title) }));
  const requiredBootstrap = result.bootstrap.steps
    .filter((step) => step.status === "required" && step.category !== "runner")
    .slice(0, 3)
    .map((step) => ({ title: truncateForAgent(step.title, 80), action: truncateForAgent(step.action) }));
  const summary = {
    schema: { name: "qamap.qa", version: 1 },
    base: result.base,
    baseSource: result.baseResolution.source,
    head: result.head,
    project: result.project,
    runner: result.runner,
    manifest: result.manifestPath ?? null,
    execution: result.execution,
    route: result.route,
    readiness: {
      score: result.readiness.score,
      level: result.readiness.level,
      basis: result.readiness.basis,
      automationApplicable: result.readiness.automationApplicable,
      verificationStatus: result.readiness.verificationStatus,
    },
    scenarioCoverage: {
      automationApplicable: result.readiness.automationApplicable,
      required: result.readiness.requiredScenarios,
      recommended: result.readiness.recommendedScenarios,
      reviewOnly: result.readiness.reviewOnlyScenarios,
      compiled: result.readiness.compiledScenarios,
      partial: result.readiness.partialScenarios,
      notCompiled: result.readiness.notCompiledScenarios,
      requiredGaps: result.readiness.requiredScenarioGaps,
    },
    traceCount: result.traces.length,
    omittedTraceCount: Math.max(0, result.traces.length - 2),
    traces: result.traces.slice(0, 2).map((trace) => ({
      id: trace.id,
      status: trace.status,
      source: trace.sources[0] ? formatAgentEvidenceSource(trace.sources[0]) : undefined,
      behavior: trace.behavior[0]
        ? {
            id: trace.behavior[0].stageId,
            phase: trace.behavior[0].phase,
            label: truncateForAgent(trace.behavior[0].label, 100),
            relation: trace.behavior[0].relation,
          }
        : undefined,
      risk: {
        kind: trace.risk.kind,
        statement: truncateForAgent(trace.risk.statement, 140),
      },
      scenario: {
        id: trace.scenario.id,
        decision: trace.scenario.decision,
        title: truncateForAgent(trace.scenario.title, 100),
      },
      artifact: trace.artifact
        ? {
            draft: truncateForAgent(trace.artifact.draftPath, 120),
            status: trace.artifact.status,
          }
        : undefined,
      execution: trace.execution,
    })),
    testSuite: { present: result.testSuite.hasTestSuite, files: result.testSuite.testFileCount },
    intentCount: result.changeAnalysis.intents.length,
    omittedIntentCount: Math.max(0, result.changeAnalysis.intents.length - 3),
    intents: result.changeAnalysis.intents.slice(0, 3).map((intent) => ({
      title: truncateForAgent(intent.title, 100),
      confidence: intent.confidence,
      reviewRequired: intent.reviewRequired,
      evidence: intent.evidence.slice(0, 2).map((item) => truncateForAgent(item.value, 100)),
      sources: strongestEvidence(intent.evidence, 1).map(formatAgentEvidenceSource),
      lifecycle: selectAgentLifecycleStages(intent.lifecycle.map((stage) => ({
        phase: stage.kind,
        label: truncateForAgent(stage.label, 120),
      })), 6),
      scenarioCount: intent.scenarios.length,
      omittedScenarioCount: Math.max(0, intent.scenarios.length - 2),
      scenarios: intent.scenarios.slice(0, 2).map((scenario) => {
        const routing = routeQaScenario(scenario);
        const automation = scenarioAutomationById.get(scenario.id);
        return {
          id: scenario.id,
          priority: scenario.priority,
          kind: scenario.kind,
          title: truncateForAgent(scenario.title, 100),
          confidence: scenario.confidence ?? "low",
          reviewRequired: scenario.reviewRequired ?? true,
          sources: strongestEvidence(scenario.evidence, 1).map(formatAgentEvidenceSource),
          assertions: scenario.assertions.slice(0, 2).map((assertion) => truncateForAgent(assertion, 120)),
          routing: {
            decision: routing.decision,
            reason: truncateForAgent(routing.reason, 160),
            requiredSources: routing.requiredEvidence.length,
            referenceSources: routing.referenceEvidence.length,
          },
          automation: automation
            ? {
                status: automation.status,
                mappedSteps: automation.mappedSteps,
                totalSteps: automation.totalSteps,
                mappedAssertions: automation.mappedAssertions,
                totalAssertions: automation.totalAssertions,
                blocker: automation.blockers[0] ? truncateForAgent(automation.blockers[0], 160) : undefined,
              }
            : undefined,
        };
      }),
    })),
    automation: needsGeneratedDraft(result)
      ? {
          optIn: true,
          adapter: result.runner,
          setupStatus: result.runnerSetup.status,
          draftCommand: `qamap e2e draft . --base ${result.base} --head ${result.head}`,
          setupCommand: result.runnerSetup.status === "proposed" ? result.runnerSetup.setupCommand : undefined,
        }
      : undefined,
    flowCount: result.flows.length,
    omittedFlowCount: Math.max(0, result.flows.length - agentListLimit),
    flows: result.flows.slice(0, agentListLimit).map((flow) => ({
      title: truncateForAgent(flow.title, 80),
      source: truncateForAgent(flow.source, 60),
      draft: truncateForAgent(flow.draftPath, 140),
      runnable: flow.runnableStatus,
      verificationMode: flow.verificationMode,
      entry: flow.entrypointHints[0] ? truncateForAgent(flow.entrypointHints[0], 140) : undefined,
      changedFiles: flow.changedFiles.slice(0, 4).map((file) => truncateForAgent(file, 140)),
      reviewQuestion: flow.userJourney?.reviewQuestion
        ? truncateForAgent(flow.userJourney.reviewQuestion, 180)
        : undefined,
      successSignal: flow.userJourney?.successSignal
        ? truncateForAgent(flow.userJourney.successSignal)
        : undefined,
      steps: flow.draftSteps.slice(0, agentListLimit).map((step) => truncateForAgent(step)),
      selectors: flow.selectorHints.slice(0, 5).map((selector) => truncateForAgent(selector, 100)),
      existingEvidence: flow.existingEvidencePaths.length > 0
        ? flow.existingEvidencePaths.slice(0, 4).map((file) => truncateForAgent(file, 140))
        : undefined,
      scenarioAutomation: flow.scenarioAutomation.slice(0, 4).map((receipt) => ({
        id: receipt.scenarioId,
        decision: receipt.decision,
        status: receipt.status,
      })),
      evidence: flow.why.slice(0, 2).map((reason) => truncateForAgent(reason)),
    })),
    requiredEvidence,
    recommendedEvidenceCount: result.missingEvidence.filter((item) => item.priority === "recommended").length,
    requiredBootstrap,
    prChecklist: result.prChecklist.slice(0, agentListLimit).map((item) => truncateForAgent(item)),
    commands: result.suggestedCommands.slice(0, 4).map((command) => truncateForAgent(command, 180)),
  };
  return `${serializeAgentSummary(summary)}\n`;
}

interface AgentSummaryShape {
  [key: string]: unknown;
  traces: Array<{
    id?: unknown;
    status?: unknown;
    source?: Record<string, string | number>;
    behavior?: { id?: unknown; phase?: unknown; label?: string; relation?: unknown };
    risk?: { kind?: unknown; statement?: string };
    scenario?: { id?: unknown; decision?: unknown; title?: string };
    artifact?: { draft?: string; status?: unknown };
    execution?: unknown;
  }>;
  intents: Array<{
    title?: unknown;
    confidence?: unknown;
    reviewRequired?: unknown;
    evidence?: string[];
    sources?: unknown[];
    lifecycle: unknown[];
    scenarioCount?: number;
    omittedScenarioCount?: number;
    scenarios: Array<{
      id?: unknown;
      priority?: unknown;
      kind?: unknown;
      title?: unknown;
      confidence?: unknown;
      sources?: unknown[];
      assertions: string[];
      routing?: {
        decision?: unknown;
        reason?: string;
        requiredSources?: unknown;
        referenceSources?: unknown;
      };
      automation?: {
        status?: unknown;
        mappedSteps?: unknown;
        totalSteps?: unknown;
        mappedAssertions?: unknown;
        totalAssertions?: unknown;
        blocker?: string;
      };
    }>;
  }>;
  flows: Array<{
    title?: unknown;
    source?: unknown;
    draft?: unknown;
    runnable?: unknown;
    verificationMode?: unknown;
    entry?: unknown;
    reviewQuestion?: unknown;
    successSignal?: unknown;
    changedFiles: string[];
    steps: string[];
    selectors: string[];
    existingEvidence?: string[];
    scenarioAutomation?: unknown[];
    evidence: string[];
  }>;
  requiredEvidence: unknown[];
  requiredBootstrap: unknown[];
  prChecklist: string[];
  commands: string[];
}

type CompactAgentFlowShape = Omit<AgentSummaryShape["flows"][number], "evidence"> & {
  evidence?: string[];
};

function serializeAgentSummary(summary: AgentSummaryShape): string {
  const payload = JSON.stringify(summary);
  if (Buffer.byteLength(payload) <= agentPayloadByteLimit) {
    return payload;
  }

  const compact = {
    ...summary,
    traces: summary.traces.slice(0, 2),
    intents: summary.intents.slice(0, 2).map((intent) => ({
      ...intent,
      lifecycle: selectAgentLifecycleStages(intent.lifecycle, 4),
      scenarios: intent.scenarios.slice(0, 2).map((scenario) => ({
        ...scenario,
        assertions: scenario.assertions.slice(0, 1),
      })),
    })),
    flows: summary.flows.slice(0, 3).map((flow) => ({
      ...flow,
      changedFiles: flow.changedFiles.slice(0, 2),
      steps: flow.steps.slice(0, 3),
      selectors: flow.selectors.slice(0, 2),
      existingEvidence: flow.existingEvidence?.slice(0, 2),
      evidence: flow.evidence.slice(0, 1),
    })),
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - Math.min(2, summary.intents.length)),
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - Math.min(3, summary.flows.length)),
    requiredEvidence: summary.requiredEvidence.slice(0, 5),
    requiredBootstrap: summary.requiredBootstrap.slice(0, 2),
    prChecklist: summary.prChecklist.slice(0, 4),
    commands: summary.commands.slice(0, 3),
    compaction: { maxBytes: agentPayloadByteLimit, originalBytes: Buffer.byteLength(payload) },
  };
  const compactPayload = JSON.stringify(compact);
  if (Buffer.byteLength(compactPayload) <= agentPayloadByteLimit) {
    return compactPayload;
  }

  const minimalIntents = compact.intents.slice(0, 1).map((intent) => ({
    ...intent,
    lifecycle: selectAgentLifecycleStages(intent.lifecycle, 3),
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 1),
    scenarios: intent.scenarios.slice(0, 1),
  }));
  const minimalFlows = compact.flows.slice(0, 2).map((flow, index) => index === 0
    ? {
        ...flow,
        steps: flow.steps.slice(0, 2),
        selectors: flow.selectors.slice(0, 1),
        existingEvidence: flow.existingEvidence?.slice(0, 1),
      }
    : secondaryAgentFlow(flow));
  const minimalPayload = JSON.stringify({
    ...compact,
    omittedTraceCount: Math.max(0, numericCount(summary.traceCount) - Math.min(1, compact.traces.length)),
    traces: compact.traces.slice(0, 1),
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - minimalIntents.length),
    intents: minimalIntents,
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - minimalFlows.length),
    flows: minimalFlows,
    requiredEvidence: compact.requiredEvidence.slice(0, 3),
    requiredBootstrap: compact.requiredBootstrap.slice(0, 1),
    prChecklist: compact.prChecklist.slice(0, 2),
    commands: compact.commands.slice(0, 2),
  });
  if (Buffer.byteLength(minimalPayload) <= agentPayloadByteLimit) {
    return minimalPayload;
  }

  const leanIntents = compact.intents.slice(0, 1).map((intent) => ({
    title: intent.title,
    confidence: intent.confidence,
    reviewRequired: intent.reviewRequired,
    evidence: [],
    lifecycle: selectAgentLifecycleStages(intent.lifecycle, 3).map(emergencyAgentLifecycleStage),
    scenarioCount: intent.scenarioCount,
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 2),
    scenarios: intent.scenarios.slice(0, 2).map((scenario) => ({
      id: scenario.id,
      priority: scenario.priority,
      kind: scenario.kind,
      title: scenario.title,
      confidence: scenario.confidence,
      sources: scenario.sources?.slice(0, 1).map(compactAgentEvidenceSource),
      assertions: scenario.assertions.slice(0, 1).map((assertion) => truncateForAgent(assertion, 80)),
      routing: scenario.routing
        ? {
            decision: scenario.routing.decision,
            reason: `Evidence-backed ${String(scenario.routing.decision ?? "review-only")} routing.`,
            requiredSources: scenario.routing.requiredSources,
            referenceSources: scenario.routing.referenceSources,
          }
        : undefined,
      automation: scenario.automation
        ? {
            status: scenario.automation.status,
            mappedSteps: scenario.automation.mappedSteps,
            totalSteps: scenario.automation.totalSteps,
            mappedAssertions: scenario.automation.mappedAssertions,
            totalAssertions: scenario.automation.totalAssertions,
          }
        : undefined,
    })),
  }));
  const leanTraces = compact.traces.slice(0, 1).map((trace) => ({
    id: trace.id,
    status: trace.status,
    source: trace.source
      ? {
          kind: trace.source.kind,
          reason: "Located diff evidence.",
          file: trace.source.file,
          relation: trace.source.relation,
          side: trace.source.side,
          startLine: trace.source.startLine,
        }
      : undefined,
    behavior: trace.behavior
      ? {
          id: trace.behavior.id,
          phase: trace.behavior.phase,
          label: truncateForAgent(String(trace.behavior.label ?? ""), 45),
          relation: trace.behavior.relation,
        }
      : undefined,
    risk: trace.risk
      ? {
          kind: trace.risk.kind,
          statement: compactAgentRiskStatement(trace.risk.kind),
        }
      : undefined,
    scenario: trace.scenario
      ? {
          id: trace.scenario.id,
          decision: trace.scenario.decision,
          title: truncateForAgent(String(trace.scenario.title ?? ""), 55),
        }
      : undefined,
    artifact: trace.artifact
      ? {
          draft: truncateForAgent(String(trace.artifact.draft ?? ""), 60),
          status: trace.artifact.status,
        }
      : undefined,
    execution: trace.execution,
  }));
  const leanFlows = compact.flows.slice(0, 3).map((flow, index) => index === 0
    ? {
        title: flow.title,
        source: truncateForAgent(String(flow.source ?? ""), 40),
        draft: flow.draft,
        verificationMode: flow.verificationMode,
        entry: flow.entry,
        changedFiles: flow.changedFiles.slice(0, 1).map((file) => truncateForAgent(file, 80)),
        reviewQuestion: flow.reviewQuestion
          ? truncateForAgent(String(flow.reviewQuestion), 100)
          : undefined,
        successSignal: flow.successSignal
          ? truncateForAgent(String(flow.successSignal), 100)
          : undefined,
        steps: flow.steps.slice(0, 1).map((step) => truncateForAgent(step, 80)),
        selectors: flow.selectors.slice(0, 1),
        existingEvidence: flow.existingEvidence
          ?.slice(0, 1)
          .map((file) => truncateForAgent(file, 100)),
      }
    : secondaryAgentFlow(flow));
  const leanPayload = JSON.stringify({
    schema: summary.schema,
    base: truncateForAgent(String(summary.base ?? ""), 120),
    head: truncateForAgent(String(summary.head ?? ""), 120),
    project: summary.project,
    runner: summary.runner,
    manifest: summary.manifest ? truncateForAgent(String(summary.manifest), 120) : null,
    execution: summary.execution,
    route: summary.route,
    readiness: summary.readiness,
    scenarioCoverage: summary.scenarioCoverage,
    traceCount: summary.traceCount,
    omittedTraceCount: Math.max(0, numericCount(summary.traceCount) - leanTraces.length),
    traces: leanTraces,
    testSuite: summary.testSuite,
    intentCount: summary.intentCount,
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - leanIntents.length),
    intents: leanIntents,
    flowCount: summary.flowCount,
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - leanFlows.length),
    flows: leanFlows,
    requiredEvidence: compact.requiredEvidence.slice(0, 1),
    recommendedEvidenceCount: summary.recommendedEvidenceCount,
    requiredBootstrap: [],
    prChecklist: compact.prChecklist.slice(0, 1),
    commands: compact.commands.slice(0, 1),
    compaction: { maxBytes: agentPayloadByteLimit, originalBytes: Buffer.byteLength(payload), lean: true },
  });
  if (Buffer.byteLength(leanPayload) <= agentPayloadByteLimit) {
    return leanPayload;
  }

  const emergencyIntents = summary.intents.slice(0, 1).map((intent) => ({
    title: truncateForAgent(String(intent.title ?? ""), 60),
    confidence: intent.confidence,
    reviewRequired: intent.reviewRequired,
    evidence: [],
    lifecycle: selectAgentLifecycleStages(intent.lifecycle, 3).map(compactAgentLifecycleStage),
    scenarioCount: intent.scenarioCount,
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 2),
    scenarios: intent.scenarios.slice(0, 2).map((scenario) => ({
      id: scenario.id,
      priority: scenario.priority,
      kind: scenario.kind,
      title: truncateForAgent(String(scenario.title ?? ""), 60),
      confidence: scenario.confidence,
      sources: scenario.sources?.slice(0, 1).map(emergencyAgentEvidenceSource),
      assertions: [],
      routing: scenario.routing
        ? {
            decision: scenario.routing.decision,
            reason: "Evidence-backed route.",
            requiredSources: scenario.routing.requiredSources,
            referenceSources: scenario.routing.referenceSources,
          }
        : undefined,
      automation: scenario.automation
        ? {
            status: scenario.automation.status,
            mappedSteps: scenario.automation.mappedSteps,
            totalSteps: scenario.automation.totalSteps,
            mappedAssertions: scenario.automation.mappedAssertions,
            totalAssertions: scenario.automation.totalAssertions,
          }
        : undefined,
    })),
  }));
  const emergencyFlows = summary.flows.slice(0, 3).map((flow, index) => index === 0
    ? {
        title: truncateForAgent(String(flow.title ?? ""), 60),
        source: truncateForAgent(String(flow.source ?? ""), 30),
        draft: truncateForAgent(String(flow.draft ?? ""), 80),
        verificationMode: flow.verificationMode,
        entry: flow.entry ? truncateForAgent(String(flow.entry), 80) : undefined,
        changedFiles: flow.changedFiles.slice(0, 1).map((file) => truncateForAgent(file, 80)),
        reviewQuestion: flow.reviewQuestion
          ? truncateForAgent(String(flow.reviewQuestion), 100)
          : undefined,
        successSignal: flow.successSignal
          ? truncateForAgent(String(flow.successSignal), 100)
          : undefined,
        steps: flow.steps.slice(0, 1).map((step) => truncateForAgent(step, 60)),
        selectors: flow.selectors.slice(0, 1).map((selector) => truncateForAgent(selector, 60)),
        existingEvidence: flow.existingEvidence
          ?.slice(0, 1)
          .map((file) => truncateForAgent(file, 80)),
      }
    : secondaryAgentFlow(flow, { title: 55, source: 24, draft: 60, file: 60, question: 80, success: 80 }));
  const emergencyTraces = leanTraces.slice(0, 1);
  const emergencySummary = {
    schema: summary.schema,
    base: truncateForAgent(String(summary.base ?? ""), 180),
    head: truncateForAgent(String(summary.head ?? ""), 180),
    project: summary.project,
    runner: summary.runner,
    manifest: summary.manifest ? truncateForAgent(String(summary.manifest), 180) : null,
    execution: summary.execution,
    route: summary.route,
    readiness: summary.readiness,
    scenarioCoverage: summary.scenarioCoverage,
    traceCount: summary.traceCount,
    omittedTraceCount: Math.max(0, numericCount(summary.traceCount) - emergencyTraces.length),
    traces: emergencyTraces,
    testSuite: summary.testSuite,
    intentCount: summary.intentCount,
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - emergencyIntents.length),
    intents: emergencyIntents,
    flowCount: summary.flowCount,
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - emergencyFlows.length),
    flows: emergencyFlows,
    requiredEvidence: summary.requiredEvidence.slice(0, 1),
    recommendedEvidenceCount: summary.recommendedEvidenceCount,
    requiredBootstrap: [],
    prChecklist: summary.prChecklist.slice(0, 1).map((item) => truncateForAgent(item, 100)),
    commands: summary.commands.slice(0, 1).map((command) => truncateForAgent(command, 100)),
    compaction: { maxBytes: agentPayloadByteLimit, originalBytes: Buffer.byteLength(payload), emergency: true },
  };
  const emergencyPayload = JSON.stringify(emergencySummary);
  if (Buffer.byteLength(emergencyPayload) <= agentPayloadByteLimit) {
    return emergencyPayload;
  }

  const floorIntents = emergencyIntents.slice(0, 1).map((intent) => ({
    ...intent,
    title: truncateForAgent(String(intent.title ?? ""), 45),
    lifecycle: selectAgentLifecycleStages(intent.lifecycle, 2),
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 1),
    scenarios: intent.scenarios.slice(0, 1).map((scenario) => ({
      ...scenario,
      title: truncateForAgent(String(scenario.title ?? ""), 45),
      sources: scenario.sources?.slice(0, 1),
      assertions: [],
    })),
  }));
  const floorFlows = emergencyFlows.slice(0, 2).map((flow, index) => index === 0
    ? {
        ...flow,
        title: truncateForAgent(String(flow.title ?? ""), 45),
        draft: truncateForAgent(String(flow.draft ?? ""), 60),
        entry: flow.entry ? truncateForAgent(String(flow.entry), 60) : undefined,
        changedFiles: flow.changedFiles.slice(0, 1).map((file) => truncateForAgent(file, 60)),
        reviewQuestion: flow.reviewQuestion
          ? truncateForAgent(String(flow.reviewQuestion), 75)
          : undefined,
        successSignal: flow.successSignal
          ? truncateForAgent(String(flow.successSignal), 75)
          : undefined,
        steps: flow.steps.slice(0, 1).map((step) => truncateForAgent(step, 45)),
        selectors: flow.selectors.slice(0, 1).map((selector) => truncateForAgent(selector, 45)),
        existingEvidence: flow.existingEvidence
          ?.slice(0, 1)
          .map((file) => truncateForAgent(file, 60)),
      }
    : secondaryAgentFlow(flow, { title: 45, source: 18, draft: 45, file: 45, question: 60, success: 60 }));
  return JSON.stringify({
    schema: summary.schema,
    base: truncateForAgent(String(summary.base ?? ""), 80),
    head: truncateForAgent(String(summary.head ?? ""), 80),
    project: summary.project,
    runner: summary.runner,
    manifest: summary.manifest ? truncateForAgent(String(summary.manifest), 80) : null,
    execution: summary.execution,
    route: summary.route,
    readiness: summary.readiness,
    scenarioCoverage: summary.scenarioCoverage,
    traceCount: summary.traceCount,
    omittedTraceCount: Math.max(0, numericCount(summary.traceCount) - emergencyTraces.length),
    traces: emergencyTraces,
    testSuite: summary.testSuite,
    intentCount: summary.intentCount,
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - floorIntents.length),
    intents: floorIntents,
    flowCount: summary.flowCount,
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - floorFlows.length),
    flows: floorFlows,
    requiredEvidence: [],
    recommendedEvidenceCount: summary.recommendedEvidenceCount,
    requiredBootstrap: [],
    prChecklist: [],
    commands: summary.commands.slice(0, 1).map((command) => truncateForAgent(command, 70)),
    compaction: {
      maxBytes: agentPayloadByteLimit,
      originalBytes: Buffer.byteLength(payload),
      emergency: true,
      floor: true,
    },
  });
}

function numericCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function secondaryAgentFlow(
  flow: CompactAgentFlowShape,
  limits: {
    title?: number;
    source?: number;
    draft?: number;
    file?: number;
    question?: number;
    success?: number;
  } = {},
): AgentSummaryShape["flows"][number] {
  return {
    title: truncateForAgent(String(flow.title ?? ""), limits.title ?? 60),
    source: truncateForAgent(String(flow.source ?? ""), limits.source ?? 30),
    draft: truncateForAgent(String(flow.draft ?? ""), limits.draft ?? 70),
    verificationMode: flow.verificationMode,
    changedFiles: flow.changedFiles
      .slice(0, 1)
      .map((file) => truncateForAgent(file, limits.file ?? 70)),
    reviewQuestion: flow.reviewQuestion
      ? truncateForAgent(String(flow.reviewQuestion), limits.question ?? 90)
      : undefined,
    successSignal: flow.successSignal
      ? truncateForAgent(String(flow.successSignal), limits.success ?? 90)
      : undefined,
    steps: [],
    selectors: [],
    evidence: [],
  };
}

function selectAgentLifecycleStages<T>(stages: T[], limit: number): T[] {
  if (stages.length <= limit) return stages;
  const phasePriority = ["trigger", "state-change", "observable-outcome", "side-effect", "action", "condition"];
  const selectedIndexes: number[] = [];
  for (const phase of phasePriority) {
    const index = stages.findIndex((stage, candidateIndex) =>
      !selectedIndexes.includes(candidateIndex) && lifecycleStagePhase(stage) === phase
    );
    if (index !== -1) selectedIndexes.push(index);
    if (selectedIndexes.length >= limit) break;
  }
  for (let index = 0; index < stages.length && selectedIndexes.length < limit; index += 1) {
    if (!selectedIndexes.includes(index)) selectedIndexes.push(index);
  }
  return selectedIndexes.sort((left, right) => left - right).map((index) => stages[index]);
}

function lifecycleStagePhase(stage: unknown): string | undefined {
  if (!stage || typeof stage !== "object") return undefined;
  const value = stage as Record<string, unknown>;
  return typeof value.phase === "string" ? value.phase : typeof value.kind === "string" ? value.kind : undefined;
}

function compactAgentEvidenceSource(source: unknown): unknown {
  if (!source || typeof source !== "object") return source;
  const value = source as Record<string, unknown>;
  return {
    kind: value.kind,
    reason: "Located evidence.",
    sourceRole: value.sourceRole,
    commit: value.commit,
    file: value.file,
    previousFile: value.previousFile,
    symbol: value.symbol,
    relation: value.relation,
    side: value.side,
    startLine: value.startLine,
    endLine: value.endLine,
    hunk: typeof value.hunk === "string" ? truncateForAgent(value.hunk, 70) : value.hunk,
  };
}

function emergencyAgentEvidenceSource(source: unknown): unknown {
  if (!source || typeof source !== "object") return source;
  const value = source as Record<string, unknown>;
  return {
    kind: value.kind,
    reason: "Located evidence.",
    sourceRole: value.sourceRole,
    commit: value.commit,
    file: value.file,
    symbol: value.symbol,
    relation: value.relation,
    side: value.side,
    startLine: value.startLine,
  };
}

function compactAgentLifecycleStage(stage: unknown): unknown {
  if (!stage || typeof stage !== "object") return stage;
  const value = stage as Record<string, unknown>;
  return {
    phase: value.phase,
    label: truncateForAgent(String(value.label ?? ""), 45),
  };
}

function emergencyAgentLifecycleStage(stage: unknown): unknown {
  if (!stage || typeof stage !== "object") return stage;
  const value = stage as Record<string, unknown>;
  return {
    phase: value.phase,
    label: truncateForAgent(String(value.label ?? ""), 35),
  };
}

function compactAgentRiskStatement(kind: unknown): string {
  const statements: Record<string, string> = {
    primary: "The expected outcome may regress.",
    failure: "Failure handling may regress.",
    boundary: "Boundary behavior may regress.",
    "state-transition": "State transitions may regress.",
  };
  return statements[String(kind)] ?? "The changed behavior may regress.";
}

function formatAgentEvidenceSource(evidence: ChangeIntentEvidence): Record<string, string | number> {
  const source: Record<string, string | number> = {
    kind: evidence.kind,
    reason: truncateForAgent(evidence.value, 90),
  };
  if (evidence.sourceRole && evidence.sourceRole !== "product") source.sourceRole = evidence.sourceRole;
  if (evidence.commit) source.commit = evidence.commit.slice(0, 12);
  if (evidence.file) source.file = evidence.file;
  if (evidence.previousFile) source.previousFile = evidence.previousFile;
  if (evidence.symbol) source.symbol = evidence.symbol;
  if (evidence.relation) source.relation = evidence.relation;
  if (evidence.side) source.side = evidence.side;
  if (evidence.startLine !== undefined) source.startLine = evidence.startLine;
  if (evidence.endLine !== undefined) source.endLine = evidence.endLine;
  if (evidence.hunkHeader) source.hunk = truncateForAgent(evidence.hunkHeader, 80);
  return source;
}

function strongestEvidence(evidence: ChangeIntentEvidence[], limit: number): ChangeIntentEvidence[] {
  return evidence
    .map((item, index) => ({ item, index }))
    .sort((left, right) => evidenceStrength(right.item) - evidenceStrength(left.item) || left.index - right.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

function evidenceStrength(evidence: ChangeIntentEvidence): number {
  const relationScore = evidence.relation === "direct" ? 2 : evidence.relation === "supporting" ? 1 : 0;
  if (evidence.kind === "diff" && evidence.file && evidence.startLine !== undefined) return 4 + relationScore;
  if (evidence.kind === "diff" && evidence.file) return 2 + relationScore;
  if (evidence.commit) return 1;
  return 0;
}

export function formatMarkdownQaDraft(result: QaDraftResult): string {
  const lines: string[] = [];
  lines.push("# QAMap QA Draft");
  lines.push("");
  lines.push("> Local-first PR QA skill output. No cloud. No LLM token. Manifest is optional, not required for first use.");
  lines.push("");
  lines.push("## At a Glance");
  lines.push("");
  lines.push("- Product QA execution: not run; this command performed static analysis and draft mapping only.");
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
        `- QA proposal: ${primaryFlow.draftSteps.length || fallbackDraftSteps(primaryFlow).length} review steps; executable automation remains optional.`,
      );
    }
  }
  const nextCommand = nextStepCommand(result);
  if (nextCommand) {
    lines.push(`- Repository validation: \`${escapeMarkdownInline(nextCommand)}\``);
  }
  const verificationOnly = result.readiness.basis === "repository-validation";
  const blocking = result.missingEvidence.filter((item) => item.priority === "required").slice(0, 2);
  if (verificationOnly) {
    lines.push("- Optional automation: not applicable; this diff routes to existing repository validation.");
  } else if (blocking.length === 0) {
    lines.push("- Optional automation: no required draft-mapping gap detected; review the scenario sources and run repository validation.");
  } else {
    for (const [index, item] of blocking.entries()) {
      lines.push(
        `- Optional automation gap${blocking.length > 1 ? ` ${index + 1}` : ""}: ${escapeMarkdownInline(item.title)}: ${escapeMarkdownInline(item.detail)}`,
      );
    }
  }
  const hasTraces = result.traces.length > 0;
  const traceRouting = hasTraces
    ? summarizeTraceRouting(result.traces)
    : {
        required: result.readiness.requiredScenarios,
        recommended: result.readiness.recommendedScenarios,
        reviewOnly: result.readiness.reviewOnlyScenarios,
      };
  const routedScenarios = hasTraces
    ? result.traces.length
    : result.readiness.requiredScenarios +
      result.readiness.recommendedScenarios +
      result.readiness.reviewOnlyScenarios;
  lines.push(
    routedScenarios > 0
      ? `- QA analysis: completed independently of runner setup; ${routedScenarios} diff-backed scenario${routedScenarios === 1 ? "" : "s"} routed for review.`
      : `- QA analysis: completed independently of runner setup; ${result.flows.length} affected flow${result.flows.length === 1 ? "" : "s"} mapped for review.`,
  );
  if (routedScenarios > 0) {
    lines.push(
      `- Scenario routing: ${traceRouting.required} required, ` +
        `${traceRouting.recommended} recommended, ${traceRouting.reviewOnly} review-only.`,
    );
    if (verificationOnly) {
      const modes = uniqueStrings(
        result.flows
          .map((flow) => flow.verificationMode)
          .filter((mode): mode is QaVerificationMode => Boolean(mode))
          .map(formatVerificationMode),
      );
      lines.push(
        `- Repository verification mapping: ${routedScenarios} routed scenario${routedScenarios === 1 ? "" : "s"}` +
          `${modes.length > 0 ? ` use ${modes.join(", ")}` : " use existing repository evidence"}; ` +
          "no product E2E draft mapping is expected.",
      );
    } else {
      const traceAutomation = hasTraces
        ? summarizeTraceAutomation(result.traces)
        : {
            compiled: result.readiness.compiledScenarios,
            partial: result.readiness.partialScenarios,
            notCompiled: result.readiness.notCompiledScenarios,
            reviewOnly: result.readiness.reviewOnlyScenarios,
          };
      lines.push(
        `- E2E draft mapping: ${traceAutomation.compiled} fully mapped, ` +
          `${traceAutomation.partial} partially mapped, ${traceAutomation.notCompiled} not mapped, ` +
          `${traceAutomation.reviewOnly} review-only; no tests executed.`,
      );
    }
    if (hasTraces) {
      const traceable = result.traces.filter((trace) => trace.status === "traceable").length;
      lines.push(
        `- Reasoning trace: ${result.traces.length}/${routedScenarios} scenario${routedScenarios === 1 ? "" : "s"} traced; ` +
          `${traceable} fully connect diff evidence to affected behavior, risk, and QA routing.`,
      );
    }
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
  lines.push(`- Base selection: ${escapeMarkdownInline(result.baseResolution.reason)}`);
  lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
  lines.push(`- Change scope: ${result.includeWorkingTree ? "committed and uncommitted working-tree changes" : "committed branch changes only"}`);
  lines.push(`- Project: ${formatProjectType(result.project)}`);
  lines.push(`- Manifest: ${result.manifestPath ? `\`${escapeMarkdownInline(result.manifestPath)}\`` : "not found; using repo signals and PR diff only"}`);
  if (verificationOnly) {
    lines.push(`- Repository verification stage: ${formatRepositoryVerificationStage(result, nextCommand)}`);
    lines.push("- Optional automation readiness: not applicable to this verification-only diff.");
  } else {
    lines.push(`- Automation stage: ${formatDraftReadinessStage(result.readiness)}`);
  }
  lines.push("- QA analysis and scenario routing do not require the optional automation runner to be installed.");
  lines.push(`- Draft flows: ${result.flows.length}`);
  lines.push("");

  appendQaDecisionLayers(lines, result, nextCommand);

  appendQaReasoningTraceMarkdown(lines, result);

  appendQaChangeIntentMarkdown(lines, result);

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

  lines.push("### Suggested QA Scenarios");
  lines.push("");
  for (const flow of result.flows) {
    if (flow.existingEvidencePaths.length > 0) {
      lines.push(
        `- Run existing test evidence: ${flow.existingEvidencePaths.slice(0, 4).map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`,
      );
    } else if (flow.verificationMode) {
      lines.push(`- Run ${formatVerificationMode(flow.verificationMode)} with the suggested repository validation command; no new product-journey E2E draft is proposed.`);
    } else {
      lines.push(`- ${escapeMarkdownInline(flow.title)}`);
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

  lines.push("### Draft Mapping And Context Gaps");
  lines.push("");
  if (result.missingEvidence.length === 0) {
    lines.push("- No required automation or context gap was detected. Still review the QA reasoning and run the project validation command before merge.");
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

  if (needsGeneratedDraft(result)) {
    lines.push("## Optional Automation");
    lines.push("");
    lines.push(
      "The QA judgment above does not require adopting this adapter. Use this section only when the team wants to turn an accepted scenario into executable coverage.",
    );
    lines.push("");
    lines.push(`- Adapter candidate: ${formatRunnerName(result.runner)}`);
    lines.push(`- Draft target: \`${escapeMarkdownInline(result.flows[0]?.draftPath ?? "generated E2E file")}\` (${formatRunnableStatus(result.flows[0]?.runnableStatus)})`);
    lines.push(`- Preview or create a draft: \`qamap e2e draft . --base ${escapeMarkdownInline(result.base)} --head ${escapeMarkdownInline(result.head)}\``);
    if (result.runnerSetup.status === "proposed" && result.runnerSetup.setupCommand) {
      lines.push(`- If the team accepts this adapter, inspect its setup proposal: \`${escapeMarkdownInline(result.runnerSetup.setupCommand)}\``);
    }
    const primaryStatus = result.flows[0]?.runnableStatus;
    lines.push(
      primaryStatus === "runnable-candidate"
        ? "- Static checks passed for this candidate, but QAMap did not run the target application. Run the repository command before claiming the scenario passed."
        : "- Keep generated code review-only until its scenario sources, assertions, fixtures, and selectors are confirmed.",
    );
    lines.push("");
  }

  return lines.join("\n");
}

function appendQaDecisionLayers(
  lines: string[],
  result: QaDraftResult,
  nextCommand: string | undefined,
): void {
  const scenarios = result.changeAnalysis.intents.flatMap((intent) => intent.scenarios);
  const automationByScenario = new Map(
    result.flows.flatMap((flow) =>
      flow.scenarioAutomation.map((receipt) => [receipt.scenarioId, { receipt, flow }] as const)
    ),
  );
  const staticRunnableFlows = result.flows.filter((flow) => flow.runnableStatus === "runnable-candidate");
  const contractScenarios = scenarios.filter((scenario) => {
    const automation = automationByScenario.get(scenario.id)?.receipt;
    return !automation || automation.status !== "compiled";
  });

  lines.push("## QA Decision Layers");
  lines.push("");
  lines.push("### 1. Important QA And Risk Map");
  lines.push("");
  lines.push(
    scenarios.length > 0
      ? `- ${scenarios.length} diff-backed scenario${scenarios.length === 1 ? "" : "s"} remain in the review scope regardless of current automation readiness.`
      : "- No diff-backed scenario was inferred; heuristic suggestions remain review-only.",
  );
  lines.push("- Runner, selector, fixture, or environment gaps do not remove an important risk from this layer.");
  lines.push("");

  lines.push("### 2. Executable Evidence Available Now");
  lines.push("");
  if (nextCommand) {
    lines.push(`- Repository command: \`${escapeMarkdownInline(nextCommand)}\` (selected but not run by QAMap).`);
  }
  for (const flow of staticRunnableFlows.slice(0, 4)) {
    lines.push(
      `- Static-runnable draft: \`${escapeMarkdownInline(flow.draftPath)}\` for ${escapeMarkdownInline(flow.title)}; self-checks passed, target application not executed.`,
    );
  }
  if (!nextCommand && staticRunnableFlows.length === 0) {
    lines.push("- None yet. QAMap is not claiming executable coverage for this change.");
  }
  lines.push("");

  lines.push("### 3. Manual Or Agent QA Contracts");
  lines.push("");
  if (contractScenarios.length === 0) {
    lines.push("- No unmapped scenario contract remains.");
  } else {
    for (const scenario of contractScenarios.slice(0, 6)) {
      const automation = automationByScenario.get(scenario.id)?.receipt;
      lines.push(`- [${scenario.priority}] ${escapeMarkdownInline(scenario.title)}`);
      if (scenario.setup[0]) {
        lines.push(`  - Setup: ${escapeMarkdownInline(scenario.setup[0])}`);
      }
      if (scenario.steps[0]) {
        lines.push(`  - Action: ${escapeMarkdownInline(scenario.steps[0])}`);
      }
      if (scenario.assertions[0]) {
        lines.push(`  - Proof: ${escapeMarkdownInline(scenario.assertions[0])}`);
      }
      if (automation?.blockers[0]) {
        lines.push(`  - Automation gap: ${escapeMarkdownInline(automation.blockers[0])}`);
      }
    }
  }
  lines.push("");
}

function summarizeTraceRouting(traces: QaReasoningTrace[]): {
  required: number;
  recommended: number;
  reviewOnly: number;
} {
  return traces.reduce((summary, trace) => {
    if (trace.scenario.decision === "required") summary.required += 1;
    else if (trace.scenario.decision === "recommended") summary.recommended += 1;
    else summary.reviewOnly += 1;
    return summary;
  }, { required: 0, recommended: 0, reviewOnly: 0 });
}

function summarizeTraceAutomation(traces: QaReasoningTrace[]): {
  compiled: number;
  partial: number;
  notCompiled: number;
  reviewOnly: number;
} {
  return traces.reduce((summary, trace) => {
    const status = trace.artifact?.status;
    if (status === "compiled") summary.compiled += 1;
    else if (status === "partial") summary.partial += 1;
    else if (status === "review-only") summary.reviewOnly += 1;
    else summary.notCompiled += 1;
    return summary;
  }, { compiled: 0, partial: 0, notCompiled: 0, reviewOnly: 0 });
}

function appendQaReasoningTraceMarkdown(lines: string[], result: QaDraftResult): void {
  const verificationMode = result.flows.find((flow) => flow.verificationMode)?.verificationMode;
  lines.push("## QA Reasoning Trace");
  lines.push("");
  lines.push(
    "> Each trace is a deterministic explanation of why a QA scenario exists. Traceable reasoning is not proof that the target application passed QA.",
  );
  lines.push("");
  if (result.traces.length === 0) {
    lines.push("No diff-backed QA reasoning trace was produced for this change.");
    lines.push("");
    return;
  }

  for (const trace of result.traces.slice(0, 6)) {
    lines.push(`### \`${escapeMarkdownInline(trace.id)}\` [${trace.status}]`);
    lines.push("");
    if (trace.sources.length > 0) {
      lines.push(
        `1. Diff evidence: ${trace.sources.slice(0, 2).map((source) => `${formatEvidenceReference(source)} - ${escapeMarkdownInline(source.value)}`).join("; ")}`,
      );
    } else {
      lines.push("1. Diff evidence: no concrete source location was found.");
    }
    if (trace.behavior.length > 0) {
      lines.push(
        `2. Affected behavior: ${trace.behavior.slice(0, 2).map((stage) => `${stage.phase}: ${escapeMarkdownInline(stage.label)} [${stage.relation}]`).join(" -> ")}`,
      );
    } else {
      lines.push("2. Affected behavior: no lifecycle stage was linked.");
    }
    lines.push(`3. Risk: ${escapeMarkdownInline(trace.risk.statement)}`);
    lines.push(
      `4. QA scenario: [${trace.scenario.decision}] ${escapeMarkdownInline(trace.scenario.title)}`,
    );
    if (trace.scenario.assertions[0]) {
      lines.push(`5. Expected proof: ${escapeMarkdownInline(trace.scenario.assertions[0])}`);
    } else {
      lines.push("5. Expected proof: no observable assertion was inferred.");
    }
    if (verificationMode) {
      lines.push(
        `6. Repository verification: ${formatVerificationMode(verificationMode)}; no product E2E artifact is expected.`,
      );
    } else if (trace.artifact) {
      lines.push(
        `6. Optional artifact: \`${escapeMarkdownInline(trace.artifact.draftPath)}\` - ` +
          `${formatScenarioAutomationStatus(trace.artifact.status)} ` +
          `(steps ${trace.artifact.mappedSteps}/${trace.artifact.totalSteps}; ` +
          `assertions ${trace.artifact.mappedAssertions}/${trace.artifact.totalAssertions})`,
      );
    } else {
      lines.push("6. Optional artifact: no deterministic draft mapping was produced.");
    }
    lines.push("7. Execution: not run.");
    const relevantGaps = verificationMode
      ? trace.gaps.filter((gap) => !/automation artifact|draft mapping/i.test(gap))
      : trace.gaps;
    for (const gap of relevantGaps.slice(0, 2)) {
      lines.push(`- Trace gap: ${escapeMarkdownInline(gap)}`);
    }
    lines.push("");
  }
  if (result.traces.length > 6) {
    lines.push(`... ${result.traces.length - 6} more trace${result.traces.length - 6 === 1 ? "" : "s"} are available with \`--format json\`.`);
    lines.push("");
  }
}

function appendQaChangeIntentMarkdown(lines: string[], result: QaDraftResult): void {
  const verificationMode = result.flows.find((flow) => flow.verificationMode)?.verificationMode;
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
      const source = stage.evidence.find((item) => item.file || item.commit);
      const sourceSuffix = source ? ` (${formatEvidenceReference(source)})` : "";
      lines.push(`  - ${stage.kind}: ${escapeMarkdownInline(stage.label)}${sourceSuffix}`);
    }
    lines.push("- QA scenarios:");
    for (const scenario of intent.scenarios.slice(0, 4)) {
      const confidence = scenario.confidence ?? "low";
      const reviewRequired = scenario.reviewRequired ?? true;
      const routing = routeQaScenario(scenario);
      const automation = findScenarioAutomation(result, scenario.id);
      lines.push(
        `  - [${scenario.priority}] ${escapeMarkdownInline(scenario.title)} ` +
        `(confidence: ${confidence}${reviewRequired ? "; review required" : ""})`,
      );
      const trace = result.traces.find((item) => item.scenario.id === scenario.id);
      if (trace) {
        lines.push(`    - Trace: \`${escapeMarkdownInline(trace.id)}\``);
      }
      lines.push(`    - Routing: ${routing.decision} - ${escapeMarkdownInline(routing.reason)}`);
      lines.push(
        `    - Evidence role: ${routing.requiredEvidence.length} required diff source${routing.requiredEvidence.length === 1 ? "" : "s"}; ` +
          `${routing.referenceEvidence.length} reference source${routing.referenceEvidence.length === 1 ? "" : "s"}`,
      );
      if (automation) {
        if (verificationMode) {
          lines.push(
            `    - Repository verification: ${formatVerificationMode(verificationMode)}; product E2E mapping is not applicable.`,
          );
        } else {
          lines.push(
            `    - E2E draft mapping: ${formatScenarioAutomationStatus(automation.status)} ` +
              `(steps ${automation.mappedSteps}/${automation.totalSteps}; assertions ${automation.mappedAssertions}/${automation.totalAssertions})`,
          );
          for (const blocker of automation.blockers.slice(0, 2)) {
            lines.push(`      - Blocker: ${escapeMarkdownInline(blocker)}`);
          }
        }
      }
      for (const source of strongestEvidence(scenario.evidence, 3)) {
        lines.push(
          `    - Source: ${formatEvidenceReference(source)}: ${escapeMarkdownInline(source.value)}`,
        );
      }
      for (const assertion of scenario.assertions.slice(0, 2)) {
        lines.push(`    - Assert: ${escapeMarkdownInline(assertion)}`);
      }
    }
    lines.push("");
  }
}

function formatScenarioAutomationStatus(status: E2eScenarioAutomationReceipt["status"]): string {
  if (status === "compiled") return "fully mapped (not executed)";
  if (status === "partial") return "partially mapped (not executed)";
  if (status === "not-compiled") return "not mapped";
  return "review only";
}

function findScenarioAutomation(
  result: QaDraftResult,
  scenarioId: string,
): E2eScenarioAutomationReceipt | undefined {
  return result.flows.flatMap((flow) => flow.scenarioAutomation).find((receipt) => receipt.scenarioId === scenarioId);
}

function formatEvidenceReference(evidence: ChangeIntentEvidence): string {
  if (evidence.commit) {
    return `commit \`${evidence.commit.slice(0, 12)}\``;
  }
  const lineRange = evidence.startLine === undefined
    ? ""
    : evidence.endLine !== undefined && evidence.endLine !== evidence.startLine
      ? `:${evidence.startLine}-${evidence.endLine}`
      : `:${evidence.startLine}`;
  const location = evidence.file ? `\`${escapeMarkdownInline(evidence.file)}${lineRange}\`` : evidence.kind;
  const symbol = evidence.symbol ? ` symbol \`${escapeMarkdownInline(evidence.symbol)}\`` : "";
  const qualifiers = [evidence.sourceRole, evidence.relation, evidence.side].filter(Boolean).join(", ");
  return `${location}${symbol}${qualifiers ? ` [${qualifiers}]` : ""}`;
}

function summarizeIntentLifecycle(lifecycle: QaDraftResult["changeAnalysis"]["intents"][number]["lifecycle"]): string {
  const start = lifecycle.find((stage) => stage.kind === "trigger")
    ?? lifecycle.find((stage) => stage.kind === "action");
  const selected = [
    start,
    ...["condition", "state-change", "side-effect", "observable-outcome"]
      .map((phase) => lifecycle.find((stage) => stage.kind === phase)),
  ]
    .filter((stage): stage is NonNullable<typeof stage> => Boolean(stage));
  const fallback = selected.length > 0 ? selected : lifecycle.slice(0, 5);
  return fallback.map((stage) => `${stage.kind}: ${stage.label}`).join(" -> ");
}

function nextStepCommand(result: QaDraftResult): string | undefined {
  const validationCommand = result.suggestedCommands[0];
  if (validationCommand) {
    return validationCommand;
  }
  return undefined;
}

function formatRepositoryVerificationStage(result: QaDraftResult, command?: string): string {
  if (result.readiness.verificationStatus === "ready-to-run" && command) {
    return `ready to run \`${escapeMarkdownInline(command)}\`; QAMap has not executed it`;
  }
  return "validation command needed; QAMap found the verification target but no repository command";
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

function qaFlowFromDraftFile(file: E2eDraftFile): QaDraftFlow {
  const verificationMode = verificationModeForDraftFile(file);
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
    existingEvidencePaths: isChangedTestEvidenceTitle(file.flowTitle)
      ? (file.changedFiles ?? [])
      : (file.coverageEvidencePaths ?? []),
    verificationMode,
    setupHints: file.setupHints ?? [],
    manifestUpdatePath: file.manifestUpdatePath,
    scenarioAutomation: file.scenarioAutomation ?? [],
    why: buildFlowReasons(file),
  };
}

function buildFlowReasons(file: E2eDraftFile): string[] {
  const verificationMode = verificationModeForDraftFile(file);
  if (verificationMode === "command-contract") {
    return ["CLI behavior changed; verify arguments, output, side effects, and exit codes instead of inventing a product journey."];
  }
  if (verificationMode === "analysis-rule") {
    return ["Analyzer rules changed; verify positive, negative, and neighboring-rule controls instead of inventing a product journey."];
  }
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
      if (item.kind === "runner" || item.kind === "validation") {
        continue;
      }
      evidence.push(missingEvidenceFromAction(file, item));
    }
  }
  const unique = uniqueMissingEvidence(evidence);
  const required = unique.filter((item) => item.priority === "required");
  const recommended = unique.filter((item) => item.priority !== "required");
  return [...required, ...recommended].slice(0, 12);
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
  suggestedCommands: string[],
): string[] {
  const testEvidenceLabel = flows[0]?.verificationMode === "existing-test-evidence"
    ? "changed test evidence"
    : "related test evidence";
  const checklist = [
    flows[0]?.existingEvidencePaths.length
      ? `Run the ${testEvidenceLabel}: ${flows[0].existingEvidencePaths.slice(0, 4).join(", ")}.`
      : flows[0]?.verificationMode
        ? `Run ${formatVerificationMode(flows[0].verificationMode)} with ${suggestedCommands[0] ?? "the nearest repository validation command"}.`
      : draft.plan.changeAnalysis.intents[0]
        ? `Review the proposed QA scenarios and their sources for: ${draft.plan.changeAnalysis.intents[0].title}.`
      : flows.length > 0
        ? `Review the affected-flow evidence for: ${flows.map((flow) => flow.title).slice(0, 3).join(", ")}.`
      : "Run QAMap again after adding branch or working tree changes.",
    flows[0]?.userJourney?.reviewQuestion
      ? `Answer the reviewer question: ${flows[0].userJourney.reviewQuestion}`
      : "Name the user-visible behavior or contract this PR can break.",
  ];

  const validationCommand = suggestedCommands.find((command) => /\b(?:e2e|test|playwright|maestro)\b/i.test(command))
    ?? suggestedCommands[0];
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
  suggestedCommands: string[],
): string[] {
  const testEvidenceLabel = flows[0]?.verificationMode === "existing-test-evidence"
    ? "changed test evidence"
    : "related test evidence";
  const handoff = [
    "Use this as a local PR QA skill result, not as proof that browser or device QA already passed.",
    draft.dryRun ? "No files were written because this command previews QA work only." : undefined,
    flows[0]?.existingEvidencePaths.length
      ? `Run the ${testEvidenceLabel} (${flows[0].existingEvidencePaths.slice(0, 3).join(", ")}) and record the result before handoff.`
      : flows[0]?.verificationMode
        ? `Run ${formatVerificationMode(flows[0].verificationMode)} with ${suggestedCommands[0] ?? "the nearest repository command"} and record the result before handoff; do not invent a product-journey E2E for this diff alone.`
      : draft.plan.changeAnalysis.intents[0]
        ? `Review each proposed scenario and its diff sources for ${draft.plan.changeAnalysis.intents[0].title} before using it as PR policy.`
      : flows.length > 0
        ? `Review the affected-flow evidence for ${flows[0].title} before using it as PR policy.`
        : undefined,
    missingEvidence.length > 0
      ? "Treat selector, fixture, runner, and draft-mapping gaps as optional automation work; they do not replace review of the QA reasoning."
      : undefined,
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
  if (/\bCLI command verification checklist$/i.test(title.trim())) {
    return "command-contract";
  }
  if (/^Static analysis rule\b/i.test(title.trim())) {
    return "analysis-rule";
  }
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

function verificationModeForDraftFile(file: E2eDraftFile): QaVerificationMode | undefined {
  const scenarioSourceRoles = (file.qaScenarios ?? [])
    .flatMap((scenario) => scenario.evidence)
    .map((source) => source.sourceRole)
    .filter((role): role is NonNullable<typeof role> => Boolean(role));
  if (scenarioSourceRoles.length > 0 && scenarioSourceRoles.every((role) => role === "command")) {
    return "command-contract";
  }
  if (file.qaScenarios?.some((scenario) => /analysis rule positive and negative controls/i.test(scenario.title))) {
    return "analysis-rule";
  }
  return verificationModeForTitle(file.flowTitle);
}

function needsGeneratedDraft(result: QaDraftResult): boolean {
  return result.flows.some((flow) => !flow.verificationMode);
}

function formatVerificationMode(mode: QaVerificationMode): string {
  if (mode === "command-contract") {
    return "CLI command contract verification";
  }
  if (mode === "analysis-rule") {
    return "analyzer rule boundary verification";
  }
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
    return "static-runnable candidate; not executed";
  }
  if (status === "near-runnable") {
    return "partially mapped; not executed";
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
