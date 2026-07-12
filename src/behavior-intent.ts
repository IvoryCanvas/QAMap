import {
  createBehaviorEdge,
  createBehaviorNodeId,
  type BehaviorAnalysisContext,
  type BehaviorAnalyzerAdapter,
  type BehaviorConfidence,
  type BehaviorEvidence,
  type BehaviorGraphFragment,
  type BehaviorNode,
  type BehaviorNodeKind,
} from "./behavior.js";
import type {
  BehaviorLifecycleStage,
  ChangeIntent,
  ChangeIntentAnalysis,
  ChangeIntentEvidence,
  ChangeIntentConfidence,
} from "./change-intent.js";

export interface ChangeIntentBehaviorAdapterOptions {
  analysis: ChangeIntentAnalysis;
}

export function createChangeIntentBehaviorAdapter(
  options: ChangeIntentBehaviorAdapterOptions,
): BehaviorAnalyzerAdapter {
  return {
    id: "qamap.change-intent",
    version: "1",
    detect: () => ({
      confidence: detectionConfidence(options.analysis.intents),
      reason: options.analysis.intents.length > 0
        ? "Behavior-bearing commit and diff evidence produced runner-independent change intents."
        : "No behavior-bearing change intent was available.",
      evidence: options.analysis.intents.slice(0, 8).map((intent) => intent.title),
    }),
    analyze: (context) => buildChangeIntentFragment(context, options.analysis.intents),
  };
}

function buildChangeIntentFragment(
  context: BehaviorAnalysisContext,
  intents: ChangeIntent[],
): BehaviorGraphFragment {
  const nodes: BehaviorNode[] = [];
  const edges = [];
  const changedFiles = new Set(context.changedFiles.map((file) => file.path));

  for (const intent of intents) {
    const confidence = behaviorConfidence(intent.confidence);
    const intentFiles = uniqueStrings(intent.files);
    const directlyChangedFiles = intentFiles.filter((file) => changedFiles.has(file));
    const impactFiles = directlyChangedFiles.length > 0
      ? directlyChangedFiles
      : context.changedFiles.map((file) => file.path).slice(0, 12);
    const contractId = createBehaviorNodeId("contract", "change-intent", intent.id);
    nodes.push({
      id: contractId,
      kind: "contract",
      label: intent.title,
      confidence,
      evidence: intent.evidence.map(toBehaviorEvidence),
      attributes: {
        contractType: "change-intent",
        intentId: intent.id,
        summary: intent.summary,
        reviewRequired: intent.reviewRequired,
        commitCount: intent.commits.length,
      },
      impact: impactFiles.length > 0
        ? {
            kind: directlyChangedFiles.length > 0 ? "direct" : "propagated",
            changedFiles: uniqueStrings(impactFiles),
          }
        : undefined,
    });

    for (const file of intentFiles) {
      const sourceId = createBehaviorNodeId("source", file);
      const direct = changedFiles.has(file);
      nodes.push({
        id: sourceId,
        kind: "source",
        label: file,
        confidence: "high",
        evidence: [{ kind: direct ? "diff" : "source", value: file, file }],
        attributes: { path: file },
        impact: direct ? { kind: "direct", changedFiles: [file] } : undefined,
      });
      edges.push(
        direct
          ? createBehaviorEdge("impacts", sourceId, contractId, "high", [{ kind: "diff", value: file, file }])
          : createBehaviorEdge("implemented-by", contractId, sourceId, "medium", [{ kind: "source", value: file, file }]),
      );
    }

    let previousStageId: string | undefined;
    intent.lifecycle.forEach((stage, index) => {
      const stageKind = nodeKindForLifecycle(stage);
      const stageId = createBehaviorNodeId(stageKind, "change-intent", intent.id, stage.id);
      const stageFiles = uniqueStrings([
        ...stage.files,
        ...stage.evidence.map((item) => item.file).filter((file): file is string => Boolean(file)),
      ]);
      nodes.push({
        id: stageId,
        kind: stageKind,
        label: stage.label,
        confidence: behaviorConfidence(stage.confidence),
        evidence: stage.evidence.map(toBehaviorEvidence),
        attributes: {
          intentId: intent.id,
          lifecyclePhase: stage.kind,
          order: index + 1,
        },
        impact: stageFiles.length > 0
          ? { kind: "direct", changedFiles: stageFiles }
          : impactFiles.length > 0
            ? { kind: "propagated", changedFiles: uniqueStrings(impactFiles) }
            : undefined,
      });
      edges.push(
        createBehaviorEdge(
          stage.kind === "observable-outcome" ? "expects" : "contains",
          contractId,
          stageId,
          behaviorConfidence(stage.confidence),
          stage.evidence.map(toBehaviorEvidence),
        ),
      );
      if (previousStageId) {
        edges.push(createBehaviorEdge("precedes", previousStageId, stageId, behaviorConfidence(stage.confidence)));
      }
      previousStageId = stageId;

      for (const file of stageFiles) {
        const sourceId = createBehaviorNodeId("source", file);
        if (intentFiles.includes(file)) {
          edges.push(createBehaviorEdge("implemented-by", stageId, sourceId, "high", [
            { kind: changedFiles.has(file) ? "diff" : "source", value: file, file },
          ]));
        }
      }
    });

    for (const scenario of intent.scenarios) {
      for (const [assertionIndex, assertion] of scenario.assertions.entries()) {
        const assertionId = createBehaviorNodeId(
          "assertion",
          "change-intent",
          intent.id,
          scenario.id,
          String(assertionIndex),
          assertion,
        );
        nodes.push({
          id: assertionId,
          kind: "assertion",
          label: assertion,
          confidence: scenario.priority === "critical" ? confidence : "medium",
          evidence: scenario.evidence.map(toBehaviorEvidence),
          attributes: {
            intentId: intent.id,
            scenarioId: scenario.id,
            scenarioKind: scenario.kind,
            scenarioTitle: scenario.title,
            priority: scenario.priority,
          },
          impact: impactFiles.length > 0
            ? { kind: "propagated", changedFiles: uniqueStrings(impactFiles) }
            : undefined,
        });
        edges.push(createBehaviorEdge("expects", contractId, assertionId, scenario.priority === "critical" ? confidence : "medium"));
      }
    }
  }

  return { nodes, edges };
}

function nodeKindForLifecycle(stage: BehaviorLifecycleStage): BehaviorNodeKind {
  if (stage.kind === "condition" || stage.kind === "state-change") {
    return "state";
  }
  if (stage.kind === "side-effect") {
    return "effect";
  }
  if (stage.kind === "observable-outcome") {
    return "assertion";
  }
  return "action";
}

function toBehaviorEvidence(evidence: ChangeIntentEvidence): BehaviorEvidence {
  if (evidence.kind === "commit") {
    return {
      kind: "commit",
      value: evidence.commit ? `${evidence.commit.slice(0, 12)} ${evidence.value}` : evidence.value,
    };
  }
  return {
    kind: evidence.kind,
    value: evidence.symbol ? `${evidence.symbol}: ${evidence.value}` : evidence.value,
    file: evidence.file,
  };
}

function detectionConfidence(intents: ChangeIntent[]): "none" | BehaviorConfidence {
  if (intents.length === 0) {
    return "none";
  }
  if (intents.some((intent) => intent.confidence === "high")) {
    return "high";
  }
  if (intents.some((intent) => intent.confidence === "medium")) {
    return "medium";
  }
  return "low";
}

function behaviorConfidence(confidence: ChangeIntentConfidence): BehaviorConfidence {
  return confidence;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
