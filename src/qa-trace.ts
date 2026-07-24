import type {
  BehaviorLifecycleStage,
  BehaviorLifecycleStageKind,
  ChangeIntent,
  ChangeIntentEvidence,
  IntentQaScenario,
  IntentQaScenarioKind,
} from "./change-intent.js";
import type { E2eScenarioAutomationStatus } from "./e2e.js";
import { routeQaScenario } from "./scenario-routing.js";
import type { QaScenarioDecision } from "./scenario-routing.js";

export type QaReasoningTraceStatus = "traceable" | "partial" | "review-only";
export type QaTraceBehaviorRelation = "evidence-linked" | "intent-context";
export type QaTraceEvidenceDisposition = "confirmed" | "source-gap" | "mapping-gap";
export type QaTraceManifestCorrectionKind = "review-existing" | "add-or-correct-flow";

export interface QaTraceArtifactInput {
  scenarioId: string;
  flowTitle: string;
  draftPath: string;
  status: E2eScenarioAutomationStatus;
  mappedSteps: number;
  totalSteps: number;
  mappedAssertions: number;
  totalAssertions: number;
  manifestUpdatePath?: string;
}

export interface QaTraceManifestContextInput {
  flowTitle: string;
  changedFiles: string[];
  manifestUpdatePath: string;
}

export interface QaTraceBehavior {
  stageId: string;
  phase: BehaviorLifecycleStageKind;
  label: string;
  relation: QaTraceBehaviorRelation;
}

export interface QaTraceRisk {
  kind: IntentQaScenarioKind;
  statement: string;
}

export interface QaTraceScenario {
  id: string;
  title: string;
  decision: QaScenarioDecision;
  routingReason: string;
  assertions: string[];
}

export interface QaTraceArtifact {
  flowTitle: string;
  draftPath: string;
  status: E2eScenarioAutomationStatus;
  mappedSteps: number;
  totalSteps: number;
  mappedAssertions: number;
  totalAssertions: number;
  flowCount: number;
  compiledFlowCount: number;
  flows: Array<Omit<QaTraceArtifactInput, "scenarioId">>;
}

export interface QaTraceEvidenceAssessment {
  disposition: QaTraceEvidenceDisposition;
  reason: string;
  uniqueSourceCount: number;
}

export interface QaTraceManifestCorrection {
  kind: QaTraceManifestCorrectionKind;
  target: string;
  reason: string;
  action: string;
  candidate: {
    scenarioId: string;
    checkTitle: string;
    sourceFile?: string;
    sourceSymbol?: string;
    sourceLine?: number;
  };
  requiresHumanApproval: true;
}

export interface QaTraceEvidenceSummary {
  totalTraces: number;
  confirmed: number;
  sourceGaps: number;
  mappingGaps: number;
  uniqueSources: number;
}

export interface QaReasoningTrace {
  id: string;
  intentId: string;
  status: QaReasoningTraceStatus;
  sources: ChangeIntentEvidence[];
  evidenceAssessment: QaTraceEvidenceAssessment;
  behavior: QaTraceBehavior[];
  risk: QaTraceRisk;
  scenario: QaTraceScenario;
  artifact?: QaTraceArtifact;
  manifestCorrection: QaTraceManifestCorrection;
  execution: "not-run";
  gaps: string[];
}

export function qaTraceIdForScenario(scenarioId: string): string {
  return `trace:${scenarioId.replace(/^scenario:/, "")}`;
}

export function buildQaReasoningTraces(
  intents: ChangeIntent[],
  artifacts: QaTraceArtifactInput[],
  manifestContexts: QaTraceManifestContextInput[] = [],
): QaReasoningTrace[] {
  const artifactsByScenario = new Map<string, QaTraceArtifactInput[]>();
  for (const artifact of artifacts) {
    const current = artifactsByScenario.get(artifact.scenarioId) ?? [];
    current.push(artifact);
    artifactsByScenario.set(artifact.scenarioId, current);
  }

  return intents.flatMap((intent) => intent.scenarios.map((scenario) => {
    const routing = routeQaScenario(scenario);
    const sources = strongestTraceEvidence(
      routing.requiredEvidence.length > 0
        ? [...routing.requiredEvidence, ...routing.referenceEvidence]
        : scenario.evidence,
      3,
    );
    const behavior = traceBehavior(intent.lifecycle, scenario, sources);
    const artifactInputs = artifactsByScenario.get(scenario.id) ?? [];
    const artifact = artifactInputs.length > 0 ? traceArtifact(artifactInputs) : undefined;
    const hasLocatedSource = sources.some(isLocatedDiffSource);
    const hasEvidenceLinkedBehavior = behavior.some((stage) => stage.relation === "evidence-linked");
    const evidenceAssessment = assessTraceEvidence(sources, hasLocatedSource, hasEvidenceLinkedBehavior);
    const gaps = [
      hasLocatedSource ? undefined : "No located diff source supports this scenario.",
      hasEvidenceLinkedBehavior ? undefined : "No lifecycle stage shares this scenario's diff evidence.",
      artifact ? undefined : "No optional automation artifact maps this scenario yet.",
      artifact && artifact.compiledFlowCount < artifact.flowCount
        ? `${artifact.compiledFlowCount} of ${artifact.flowCount} affected flow artifacts fully map this scenario.`
        : undefined,
    ].filter((value): value is string => Boolean(value));

    return {
      id: qaTraceIdForScenario(scenario.id),
      intentId: intent.id,
      status: routing.decision === "review-only"
        ? "review-only"
        : evidenceAssessment.disposition === "confirmed"
          ? "traceable"
          : "partial",
      sources,
      evidenceAssessment,
      behavior,
      risk: {
        kind: scenario.kind,
        statement: riskStatement(intent, scenario),
      },
      scenario: {
        id: scenario.id,
        title: scenario.title,
        decision: routing.decision,
        routingReason: routing.reason,
        assertions: scenario.assertions.slice(0, 3),
      },
      artifact,
      manifestCorrection: traceManifestCorrection(
        scenario,
        sources,
        artifactInputs,
        manifestContexts,
        evidenceAssessment,
      ),
      execution: "not-run",
      gaps,
    };
  }));
}

export function summarizeQaTraceEvidence(traces: QaReasoningTrace[]): QaTraceEvidenceSummary {
  const uniqueSources = new Set(
    traces.flatMap((trace) => trace.sources.map(evidenceKey)),
  );
  return {
    totalTraces: traces.length,
    confirmed: traces.filter((trace) => trace.evidenceAssessment.disposition === "confirmed").length,
    sourceGaps: traces.filter((trace) => trace.evidenceAssessment.disposition === "source-gap").length,
    mappingGaps: traces.filter((trace) => trace.evidenceAssessment.disposition === "mapping-gap").length,
    uniqueSources: uniqueSources.size,
  };
}

function traceBehavior(
  lifecycle: BehaviorLifecycleStage[],
  scenario: IntentQaScenario,
  sources: ChangeIntentEvidence[],
): QaTraceBehavior[] {
  const linked = lifecycle.filter((stage) =>
    stage.evidence.some((stageEvidence) =>
      scenario.evidence.some((scenarioEvidence) => evidenceOverlaps(stageEvidence, scenarioEvidence))
    )
  );
  if (linked.length > 0) {
    return linked.slice(0, 3).map((stage) => traceBehaviorStage(stage, "evidence-linked"));
  }

  const sourceFiles = new Set(sources.map((source) => source.file).filter((file): file is string => Boolean(file)));
  const contextual = lifecycle.filter((stage) =>
    stage.files.some((file) => sourceFiles.has(file)) ||
    stage.evidence.some((evidence) => Boolean(evidence.file && sourceFiles.has(evidence.file)))
  );
  const fallback = contextual.length > 0 ? contextual : lifecycle.slice(0, 1);
  return fallback.slice(0, 2).map((stage) => traceBehaviorStage(stage, "intent-context"));
}

function traceBehaviorStage(
  stage: BehaviorLifecycleStage,
  relation: QaTraceBehaviorRelation,
): QaTraceBehavior {
  return {
    stageId: stage.id,
    phase: stage.kind,
    label: stage.label,
    relation,
  };
}

function traceArtifact(inputs: QaTraceArtifactInput[]): QaTraceArtifact {
  const representative = inputs.find((input) => input.status !== "compiled") ?? inputs[0];
  const compiledFlowCount = inputs.filter((input) => input.status === "compiled").length;
  const mappedSteps = inputs.reduce((sum, input) => sum + input.mappedSteps, 0);
  const totalSteps = inputs.reduce((sum, input) => sum + input.totalSteps, 0);
  const mappedAssertions = inputs.reduce((sum, input) => sum + input.mappedAssertions, 0);
  const totalAssertions = inputs.reduce((sum, input) => sum + input.totalAssertions, 0);
  const status: E2eScenarioAutomationStatus = compiledFlowCount === inputs.length
    ? "compiled"
    : inputs.every((input) => input.status === "review-only")
      ? "review-only"
      : mappedSteps > 0 || mappedAssertions > 0
        ? "partial"
        : "not-compiled";
  return {
    flowTitle: representative.flowTitle,
    draftPath: representative.draftPath,
    status,
    mappedSteps,
    totalSteps,
    mappedAssertions,
    totalAssertions,
    flowCount: inputs.length,
    compiledFlowCount,
    flows: inputs.map(({ scenarioId: _scenarioId, ...input }) => input),
  };
}

function assessTraceEvidence(
  sources: ChangeIntentEvidence[],
  hasLocatedSource: boolean,
  hasEvidenceLinkedBehavior: boolean,
): QaTraceEvidenceAssessment {
  const uniqueSourceCount = new Set(sources.map(evidenceKey)).size;
  if (!hasLocatedSource) {
    return {
      disposition: "source-gap",
      reason: "The scenario has context, but no exact changed-file line supports it.",
      uniqueSourceCount,
    };
  }
  if (!hasEvidenceLinkedBehavior) {
    return {
      disposition: "mapping-gap",
      reason: "A changed-file source exists, but it could not be joined to an affected lifecycle stage.",
      uniqueSourceCount,
    };
  }
  return {
    disposition: "confirmed",
    reason: "An exact diff source is joined to an affected lifecycle stage.",
    uniqueSourceCount,
  };
}

function traceManifestCorrection(
  scenario: IntentQaScenario,
  sources: ChangeIntentEvidence[],
  artifactInputs: QaTraceArtifactInput[],
  manifestContexts: QaTraceManifestContextInput[],
  assessment: QaTraceEvidenceAssessment,
): QaTraceManifestCorrection {
  const artifactTarget = artifactInputs
    .map((input) => input.manifestUpdatePath)
    .find((target): target is string => Boolean(target));
  const sourceFiles = new Set(
    sources.map((source) => source.file).filter((file): file is string => Boolean(file)),
  );
  const matchedContext = manifestContexts.find((context) =>
    context.changedFiles.some((file) => sourceFiles.has(file))
  );
  const contextTarget = matchedContext?.manifestUpdatePath;
  const existingTarget = artifactTarget ?? contextTarget;
  const matchedFlowTitle = artifactInputs.find((input) => input.manifestUpdatePath === artifactTarget)?.flowTitle ??
    matchedContext?.flowTitle;
  const source = sources.find(isLocatedDiffSource) ?? sources.find((item) => Boolean(item.file));
  const action = existingTarget
    ? `Review the matched "${matchedFlowTitle ?? scenario.title}" anchors and checks, then refine or remove the mapping if the team rejects it.`
    : assessment.disposition === "source-gap"
      ? `Add a concrete changed-file anchor and observable check for "${scenario.title}", or keep the scenario out of shared policy.`
      : `Bind the located source to the correct flow anchor and check for "${scenario.title}", or remove the scenario from shared policy.`;
  return {
    kind: existingTarget ? "review-existing" : "add-or-correct-flow",
    target: existingTarget ?? ".qamap/manifest.yaml > flows",
    reason: "Repo-local QA memory should change only after a reviewer confirms the correction.",
    action,
    candidate: {
      scenarioId: scenario.id,
      checkTitle: scenario.title,
      sourceFile: source?.file,
      sourceSymbol: source?.symbol,
      sourceLine: source?.startLine,
    },
    requiresHumanApproval: true,
  };
}

function riskStatement(intent: ChangeIntent, scenario: IntentQaScenario): string {
  if (scenario.kind === "primary") {
    if (hasSourceRole(scenario.evidence, intent.evidence, "analysis-rule")) {
      return "The changed analyzer may miss intended evidence or report unrelated behavior as a finding.";
    }
    if (hasSourceRole(scenario.evidence, intent.evidence, "command")) {
      return "The changed command may accept invalid input or produce incorrect output, artifacts, or exit status.";
    }
    return `The changed behavior "${intent.title}" may not reach its intended observable outcome.`;
  }
  if (scenario.kind === "failure") {
    return `${scenario.title} may leave the changed behavior in an incorrect or unrecoverable state.`;
  }
  if (scenario.kind === "boundary") {
    return `${scenario.title} may produce a result outside the intended boundary.`;
  }
  return `${scenario.title} may leave stale or inconsistent state after the change.`;
}

function hasSourceRole(
  scenarioEvidence: ChangeIntentEvidence[],
  intentEvidence: ChangeIntentEvidence[],
  role: ChangeIntentEvidence["sourceRole"],
): boolean {
  const locatedScenarioEvidence = scenarioEvidence.filter((item) => item.kind === "diff" && item.file);
  const evidence = locatedScenarioEvidence.length > 0 ? locatedScenarioEvidence : intentEvidence;
  return evidence.some((item) => item.sourceRole === role);
}

function strongestTraceEvidence(evidence: ChangeIntentEvidence[], limit: number): ChangeIntentEvidence[] {
  return uniqueEvidence(evidence)
    .map((item, index) => ({ item, index }))
    .sort((left, right) => traceEvidenceStrength(right.item) - traceEvidenceStrength(left.item) || left.index - right.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

function traceEvidenceStrength(evidence: ChangeIntentEvidence): number {
  const relationScore = evidence.relation === "direct" ? 2 : evidence.relation === "supporting" ? 1 : 0;
  if (isLocatedDiffSource(evidence)) return 4 + relationScore;
  if (evidence.kind === "diff" && evidence.file) return 2 + relationScore;
  if (evidence.commit) return 1;
  return 0;
}

function isLocatedDiffSource(evidence: ChangeIntentEvidence): boolean {
  return evidence.kind === "diff" && Boolean(evidence.file) && evidence.startLine !== undefined;
}

function evidenceOverlaps(left: ChangeIntentEvidence, right: ChangeIntentEvidence): boolean {
  if (evidenceKey(left) === evidenceKey(right)) {
    return true;
  }
  if (left.file && left.file === right.file) {
    if (left.startLine !== undefined && right.startLine !== undefined) {
      const leftEnd = left.endLine ?? left.startLine;
      const rightEnd = right.endLine ?? right.startLine;
      return left.startLine <= rightEnd && right.startLine <= leftEnd;
    }
    return Boolean(left.symbol && right.symbol && left.symbol === right.symbol);
  }
  return Boolean(left.commit && right.commit && left.commit === right.commit);
}

function uniqueEvidence(evidence: ChangeIntentEvidence[]): ChangeIntentEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = evidenceKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function evidenceKey(evidence: ChangeIntentEvidence): string {
  return [
    evidence.kind,
    evidence.sourceRole ?? "",
    evidence.commit ?? "",
    evidence.file ?? "",
    evidence.previousFile ?? "",
    evidence.symbol ?? "",
    evidence.relation ?? "",
    evidence.side ?? "",
    evidence.startLine ?? "",
    evidence.endLine ?? "",
    evidence.hunkHeader ?? "",
    evidence.value,
  ].join(":");
}
