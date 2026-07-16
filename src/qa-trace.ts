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

export interface QaTraceArtifactInput {
  scenarioId: string;
  flowTitle: string;
  draftPath: string;
  status: E2eScenarioAutomationStatus;
  mappedSteps: number;
  totalSteps: number;
  mappedAssertions: number;
  totalAssertions: number;
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
}

export interface QaReasoningTrace {
  id: string;
  intentId: string;
  status: QaReasoningTraceStatus;
  sources: ChangeIntentEvidence[];
  behavior: QaTraceBehavior[];
  risk: QaTraceRisk;
  scenario: QaTraceScenario;
  artifact?: QaTraceArtifact;
  execution: "not-run";
  gaps: string[];
}

export function qaTraceIdForScenario(scenarioId: string): string {
  return `trace:${scenarioId.replace(/^scenario:/, "")}`;
}

export function buildQaReasoningTraces(
  intents: ChangeIntent[],
  artifacts: QaTraceArtifactInput[],
): QaReasoningTrace[] {
  const artifactByScenario = new Map<string, QaTraceArtifactInput>();
  for (const artifact of artifacts) {
    const current = artifactByScenario.get(artifact.scenarioId);
    if (!current || compareTraceArtifacts(artifact, current) > 0) {
      artifactByScenario.set(artifact.scenarioId, artifact);
    }
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
    const artifactInput = artifactByScenario.get(scenario.id);
    const artifact = artifactInput ? traceArtifact(artifactInput) : undefined;
    const hasLocatedSource = sources.some(isLocatedDiffSource);
    const hasEvidenceLinkedBehavior = behavior.some((stage) => stage.relation === "evidence-linked");
    const gaps = [
      hasLocatedSource ? undefined : "No located diff source supports this scenario.",
      hasEvidenceLinkedBehavior ? undefined : "No lifecycle stage shares this scenario's diff evidence.",
      artifact ? undefined : "No optional automation artifact maps this scenario yet.",
    ].filter((value): value is string => Boolean(value));

    return {
      id: qaTraceIdForScenario(scenario.id),
      intentId: intent.id,
      status: routing.decision === "review-only"
        ? "review-only"
        : hasLocatedSource && hasEvidenceLinkedBehavior
          ? "traceable"
          : "partial",
      sources,
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
      execution: "not-run",
      gaps,
    };
  }));
}

function compareTraceArtifacts(left: QaTraceArtifactInput, right: QaTraceArtifactInput): number {
  const statusRank: Record<E2eScenarioAutomationStatus, number> = {
    compiled: 3,
    partial: 2,
    "not-compiled": 1,
    "review-only": 0,
  };
  const statusDifference = statusRank[left.status] - statusRank[right.status];
  if (statusDifference !== 0) {
    return statusDifference;
  }
  const leftMapped = left.mappedSteps + left.mappedAssertions;
  const rightMapped = right.mappedSteps + right.mappedAssertions;
  return leftMapped - rightMapped;
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

function traceArtifact(input: QaTraceArtifactInput): QaTraceArtifact {
  return {
    flowTitle: input.flowTitle,
    draftPath: input.draftPath,
    status: input.status,
    mappedSteps: input.mappedSteps,
    totalSteps: input.totalSteps,
    mappedAssertions: input.mappedAssertions,
    totalAssertions: input.totalAssertions,
  };
}

function riskStatement(intent: ChangeIntent, scenario: IntentQaScenario): string {
  if (scenario.kind === "primary") {
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
