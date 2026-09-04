export const qaCapabilityIds = [
  "change-intent",
  "behavior-impact",
  "scenario-routing",
  "repository-validation",
  "automation-draft",
] as const;

export type QaCapabilityId = (typeof qaCapabilityIds)[number];
export type QaCapabilityStatus = "available" | "limited" | "not-applicable" | "unavailable";
export type QaCapabilityLevel = "deep" | "structural" | "generic";

export interface QaCapabilityResult {
  id: QaCapabilityId;
  status: QaCapabilityStatus;
  level: QaCapabilityLevel;
  reason: string;
  evidence: string[];
}

export interface QaCapabilityContext {
  intents: {
    total: number;
    evidenceBacked: number;
  };
  traces: {
    total: number;
    confirmed: number;
  };
  scenarios: {
    total: number;
    routed: number;
    reviewOnly: number;
  };
  repositoryValidation: {
    applicable: boolean;
    commandAvailable: boolean;
    contractCount: number;
    testSuitePresent: boolean;
  };
  automation: {
    applicable: boolean;
    compiled: number;
    partial: number;
    notCompiled: number;
    requiredGaps: number;
  };
}

interface QaCapabilityDefinition {
  id: QaCapabilityId;
  evaluate(context: QaCapabilityContext): Omit<QaCapabilityResult, "id">;
}

const qaCapabilityRegistry: readonly QaCapabilityDefinition[] = [
  {
    id: "change-intent",
    evaluate: ({ intents }) => {
      if (intents.total === 0) {
        return {
          status: "unavailable",
          level: "generic",
          reason: "No behavior-bearing commit and diff intent was found.",
          evidence: [],
        };
      }
      const complete = intents.evidenceBacked === intents.total;
      return {
        status: complete ? "available" : "limited",
        level: complete ? "deep" : "structural",
        reason: complete
          ? "Every inferred change intent retains located repository evidence."
          : "At least one change intent still depends on contextual or low-confidence evidence.",
        evidence: [`${intents.evidenceBacked}/${intents.total} intents retain located diff evidence`],
      };
    },
  },
  {
    id: "behavior-impact",
    evaluate: ({ traces }) => {
      if (traces.total === 0) {
        return {
          status: "unavailable",
          level: "generic",
          reason: "No affected behavior trace was produced.",
          evidence: [],
        };
      }
      const complete = traces.confirmed === traces.total;
      return {
        status: complete ? "available" : "limited",
        level: complete ? "deep" : "structural",
        reason: complete
          ? "Every behavior trace connects a located source to a lifecycle stage."
          : "Some behavior traces have a source or lifecycle mapping gap.",
        evidence: [`${traces.confirmed}/${traces.total} traces have confirmed causal evidence`],
      };
    },
  },
  {
    id: "scenario-routing",
    evaluate: ({ scenarios }) => {
      if (scenarios.total === 0) {
        return {
          status: "unavailable",
          level: "generic",
          reason: "No QA scenario was selected from the current change.",
          evidence: [],
        };
      }
      if (scenarios.routed === 0) {
        return {
          status: "limited",
          level: "generic",
          reason: "Scenarios exist for review, but none has enough located evidence to become required or recommended.",
          evidence: [`${scenarios.reviewOnly}/${scenarios.total} scenarios are review-only`],
        };
      }
      const complete = scenarios.reviewOnly === 0;
      return {
        status: complete ? "available" : "limited",
        level: complete ? "deep" : "structural",
        reason: complete
          ? "Every selected scenario is routed from located diff evidence."
          : "Evidence-backed scenarios are available, while some contextual scenarios remain review-only.",
        evidence: [
          `${scenarios.routed}/${scenarios.total} scenarios are required or recommended`,
          `${scenarios.reviewOnly} scenarios are review-only`,
        ],
      };
    },
  },
  {
    id: "repository-validation",
    evaluate: ({ repositoryValidation }) => {
      const evidence = [
        repositoryValidation.contractCount > 0
          ? `${repositoryValidation.contractCount} changed repository test contracts`
          : undefined,
        repositoryValidation.testSuitePresent ? "an existing test suite was detected" : undefined,
      ].filter((value): value is string => Boolean(value));
      if (repositoryValidation.applicable && repositoryValidation.commandAvailable) {
        return {
          status: "available",
          level: "deep",
          reason: "The applicable repository validation route has an exact existing command.",
          evidence,
        };
      }
      if (repositoryValidation.applicable) {
        return {
          status: "limited",
          level: "structural",
          reason: "Repository validation is applicable, but the repository does not expose a safe exact command.",
          evidence,
        };
      }
      if (evidence.length > 0) {
        return {
          status: "available",
          level: "structural",
          reason: "Repository test evidence is available as supporting validation alongside product QA.",
          evidence,
        };
      }
      return {
        status: "unavailable",
        level: "generic",
        reason: "No repository-authored validation contract was detected.",
        evidence: [],
      };
    },
  },
  {
    id: "automation-draft",
    evaluate: ({ automation }) => {
      if (!automation.applicable) {
        return {
          status: "not-applicable",
          level: "generic",
          reason: "This change routes to repository validation instead of product automation.",
          evidence: [],
        };
      }
      if (
        automation.compiled === 0 &&
        automation.partial === 0 &&
        automation.notCompiled === 0 &&
        automation.requiredGaps === 0
      ) {
        return {
          status: "unavailable",
          level: "generic",
          reason: "No selected QA scenario is available for deterministic automation mapping.",
          evidence: [],
        };
      }
      const mapped = automation.compiled + automation.partial;
      if (automation.compiled > 0 && automation.requiredGaps === 0 && automation.partial === 0 && automation.notCompiled === 0) {
        return {
          status: "available",
          level: "deep",
          reason: "All selected automation scenarios map to concrete steps and observable assertions.",
          evidence: [`${automation.compiled} scenarios fully mapped`, "0 required mapping gaps"],
        };
      }
      if (mapped > 0) {
        return {
          status: "limited",
          level: "structural",
          reason: "A draft can be prepared, but at least one selected scenario remains partially mapped.",
          evidence: [
            `${automation.compiled} scenarios fully mapped`,
            `${automation.partial} scenarios partially mapped`,
            `${automation.requiredGaps} required mapping gaps`,
          ],
        };
      }
      return {
        status: "limited",
        level: "generic",
        reason: "QA scenarios exist, but no deterministic automation path is mapped yet.",
        evidence: [
          `${automation.notCompiled} scenarios not mapped`,
          `${automation.requiredGaps} required mapping gaps`,
        ],
      };
    },
  },
];

export function validateQaCapabilityRegistry(
  definitions: readonly Pick<QaCapabilityDefinition, "id">[] = qaCapabilityRegistry,
): void {
  const counts = new Map<QaCapabilityId, number>();
  for (const definition of definitions) {
    counts.set(definition.id, (counts.get(definition.id) ?? 0) + 1);
  }
  const missing = qaCapabilityIds.filter((id) => !counts.has(id));
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (missing.length > 0) {
    throw new Error(`missing QA capability definitions: ${missing.join(",")}`);
  }
  if (duplicates.length > 0) {
    throw new Error(`duplicate QA capability definitions: ${duplicates.join(",")}`);
  }
}

validateQaCapabilityRegistry();

export function evaluateQaCapabilities(context: QaCapabilityContext): QaCapabilityResult[] {
  return qaCapabilityRegistry.map((definition) => ({
    id: definition.id,
    ...definition.evaluate(context),
  }));
}

export const qaActionIds = [
  "review-and-run-draft",
  "complete-draft-evidence",
  "run-repository-command",
  "define-repository-command",
] as const;

export type QaActionId = (typeof qaActionIds)[number];
export type QaActionRisk = "low" | "medium" | "high";
export type QaActionApproval = "none" | "policy-controlled" | "per-run";
export type QaActionEffect = "none" | "possible";
export type QaActionNetwork = "none" | "repository-controlled";

export interface QaActionContract {
  id: QaActionId;
  risk: QaActionRisk;
  approval: QaActionApproval;
  executesProjectCode: boolean;
  writesRepository: QaActionEffect;
  modifiesDependencies: QaActionEffect;
  networkAccess: QaActionNetwork;
  untrustedEvidenceCanEscalate: false;
  preconditions: string[];
}

const qaActionRegistry: readonly QaActionContract[] = [
  {
    id: "complete-draft-evidence",
    risk: "low",
    approval: "none",
    executesProjectCode: false,
    writesRepository: "none",
    modifiesDependencies: "none",
    networkAccess: "none",
    untrustedEvidenceCanEscalate: false,
    preconditions: ["Review the highest-priority missing evidence before preparing or running automation."],
  },
  {
    id: "define-repository-command",
    risk: "low",
    approval: "none",
    executesProjectCode: false,
    writesRepository: "none",
    modifiesDependencies: "none",
    networkAccess: "none",
    untrustedEvidenceCanEscalate: false,
    preconditions: ["A maintainer must define the repository validation contract; QAMap must not invent one."],
  },
  {
    id: "run-repository-command",
    risk: "high",
    approval: "policy-controlled",
    executesProjectCode: true,
    writesRepository: "possible",
    modifiesDependencies: "possible",
    networkAccess: "repository-controlled",
    untrustedEvidenceCanEscalate: false,
    preconditions: [
      "Use only the exact existing repository command selected by QAMap.",
      "Apply the calling agent or CI environment's execution policy before running repository code.",
    ],
  },
  {
    id: "review-and-run-draft",
    risk: "high",
    approval: "per-run",
    executesProjectCode: true,
    writesRepository: "possible",
    modifiesDependencies: "possible",
    networkAccess: "repository-controlled",
    untrustedEvidenceCanEscalate: false,
    preconditions: [
      "A human must accept the routed scenario and automation adapter before any write, setup, or execution.",
      "Preview the generated draft and declared execution plan before running repository code.",
    ],
  },
];

export function validateQaActionRegistry(
  definitions: readonly Pick<QaActionContract, "id">[] = qaActionRegistry,
): void {
  const counts = new Map<QaActionId, number>();
  for (const definition of definitions) {
    counts.set(definition.id, (counts.get(definition.id) ?? 0) + 1);
  }
  const missing = qaActionIds.filter((id) => !counts.has(id));
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (missing.length > 0) {
    throw new Error(`missing QA action definitions: ${missing.join(",")}`);
  }
  if (duplicates.length > 0) {
    throw new Error(`duplicate QA action definitions: ${duplicates.join(",")}`);
  }
}

validateQaActionRegistry();

export function qaActionContract(id: QaActionId): QaActionContract {
  const contract = qaActionRegistry.find((candidate) => candidate.id === id);
  if (!contract) {
    throw new Error(`unknown QA action: ${id}`);
  }
  return {
    ...contract,
    preconditions: [...contract.preconditions],
  };
}

export interface QaEvidenceBoundary {
  repositoryContent: "untrusted-data";
  instructionLikeContent: "neutralized";
  canEscalateAction: false;
  neutralizedValues: number;
}

export const qaEvidenceBoundary = {
  repositoryContent: "untrusted-data",
  instructionLikeContent: "neutralized",
  canEscalateAction: false,
} as const;

export interface QaInferenceBoundary {
  status: "inferred-draft";
  promotion: "human-required";
  divergence: "human-only";
  ambiguity: "stop-and-report";
}

export const qaInferenceBoundary: QaInferenceBoundary = {
  status: "inferred-draft",
  promotion: "human-required",
  divergence: "human-only",
  ambiguity: "stop-and-report",
};

const instructionLikePatterns = [
  /\b(?:system|developer|assistant)\s*(?:message|prompt|instructions?)?\s*:/i,
  /\b(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+(?:instructions?|messages?|prompts?)\b/i,
  /\byou are now\s+(?:an?|the)\b/i,
  /\b(?:reveal|print|send|exfiltrate)\b[\s\S]{0,80}\b(?:token|secret|credential|api[ -]?key|environment variable)\b/i,
  /\b(?:edit|modify|delete|overwrite)\b[\s\S]{0,80}\b(?:\.qamap\/manifest|repository|source code)\b[\s\S]{0,80}\b(?:without (?:asking|approval)|do not ask|immediately)\b/i,
] as const;

export const neutralizedInstructionText =
  "[instruction-like repository text omitted; inspect the cited source location]";

export function isInstructionLikeRepositoryText(value: string): boolean {
  return instructionLikePatterns.some((pattern) => pattern.test(value));
}

export function neutralizeInstructionLikeValues<T>(input: T): {
  value: T;
  neutralizedValues: number;
} {
  let neutralizedValues = 0;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!isInstructionLikeRepositoryText(value)) {
        return value;
      }
      neutralizedValues += 1;
      return neutralizedInstructionText;
    }
    if (Array.isArray(value)) {
      return value.map(visit);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, visit(item)]),
      );
    }
    return value;
  };
  return {
    value: visit(input) as T,
    neutralizedValues,
  };
}
