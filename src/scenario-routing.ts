import type { ChangeIntentEvidence, IntentQaScenario } from "./change-intent.js";

export type QaScenarioDecision = "required" | "recommended" | "review-only";

export interface QaScenarioSelectionReceipt {
  scenarioId: string;
  decision: QaScenarioDecision;
  reason: string;
  requiredEvidence: ChangeIntentEvidence[];
  referenceEvidence: ChangeIntentEvidence[];
}

export function routeQaScenario(scenario: IntentQaScenario): QaScenarioSelectionReceipt {
  const requiredEvidence = scenario.evidence.filter(isRequiredScenarioEvidence);
  const requiredKeys = new Set(requiredEvidence.map(evidenceKey));
  const referenceEvidence = scenario.evidence.filter((evidence) => !requiredKeys.has(evidenceKey(evidence)));

  if (requiredEvidence.length === 0) {
    return {
      scenarioId: scenario.id,
      decision: "review-only",
      reason:
        "Kept for review only because no direct or supporting diff hunk with a concrete source location supports this scenario.",
      requiredEvidence,
      referenceEvidence,
    };
  }

  const sourceSummary = describeRequiredEvidence(requiredEvidence);
  const evidenceVerb = requiredEvidence.length === 1 ? "supports" : "support";
  if (scenario.priority === "critical") {
    return {
      scenarioId: scenario.id,
      decision: "required",
      reason: `Selected as required because ${sourceSummary} ${evidenceVerb} this critical ${scenario.kind} scenario.`,
      requiredEvidence,
      referenceEvidence,
    };
  }

  return {
    scenarioId: scenario.id,
    decision: "recommended",
    reason: `Selected as recommended because ${sourceSummary} ${evidenceVerb} this ${scenario.kind} scenario.`,
    requiredEvidence,
    referenceEvidence,
  };
}

export function isRequiredScenarioEvidence(evidence: ChangeIntentEvidence): boolean {
  return evidence.kind === "diff" &&
    Boolean(evidence.file) &&
    evidence.startLine !== undefined &&
    evidence.relation !== "contextual";
}

function describeRequiredEvidence(evidence: ChangeIntentEvidence[]): string {
  const direct = evidence.filter((item) => item.relation === "direct").length;
  const supporting = evidence.length - direct;
  const parts: string[] = [];
  if (direct > 0) {
    parts.push(`${direct} direct diff hunk${direct === 1 ? "" : "s"}`);
  }
  if (supporting > 0) {
    parts.push(`${supporting} supporting diff hunk${supporting === 1 ? "" : "s"}`);
  }
  return joinHumanList(parts);
}

function joinHumanList(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? "located diff evidence";
  }
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
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
