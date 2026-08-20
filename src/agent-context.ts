import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  VerificationManifest,
  VerificationManifestContext,
  VerificationManifestDomain,
  VerificationManifestFlow,
  VerificationManifestSource,
} from "./manifest.js";

export const agentContextSchemaVersion = 1 as const;

export type AgentContextBlockKind = "repository" | "manifest" | "validation" | "behavior";

export interface AgentContextBlock {
  kind: AgentContextBlockKind;
  id: string;
  bytes: number;
  data?: unknown;
}

export interface AgentContextContract {
  schema: { name: "qamap.context"; version: typeof agentContextSchemaVersion };
  stable: {
    id: string;
    bytes: number;
    blocks: AgentContextBlock[];
  };
  delta: {
    id: string;
    bytes: number;
    changedFiles: number;
    data?: unknown;
  };
  recovery?: {
    fullReport: string;
  };
}

export interface AgentContextReference {
  schema: { name: "qamap.context"; version: typeof agentContextSchemaVersion };
  stableId: string;
  deltaId: string;
  omittedBlockCount: number;
  recovery?: {
    fullReport: string;
  };
}

export interface AgentContextInput {
  repository: {
    id: string;
    project: string;
    runner: string;
    analysisScope: {
      mode: string;
      selectedPath?: string;
      packageName?: string;
      candidates: Array<{ path: string; packageName?: string; project: string; runner: string }>;
    };
    testSuite: { present: boolean; files: number };
  };
  manifest: VerificationManifest;
  validationCommands: string[];
  delta: {
    base: string;
    baseSource: string;
    head: string;
    includeWorkingTree: boolean;
    changedFiles: string[];
    intents: unknown[];
    traces: unknown[];
    flows: unknown[];
    execution: unknown;
  };
}

interface CanonicalDeltaData {
  base: string;
  baseSource: string;
  head: string;
  includeWorkingTree: boolean;
  changedFiles: string[];
  intents: unknown[];
  traces: unknown[];
  flows: unknown[];
  execution: unknown;
}

export function buildAgentContextContract(
  input: AgentContextInput,
  options: { includeDetails?: boolean } = {},
): AgentContextContract {
  const stableData = stableContextData(input);
  const blocks = (Object.entries(stableData) as Array<[AgentContextBlockKind, unknown]>).map(([kind, data]) => {
    const serialized = canonicalJson(data);
    return {
      kind,
      id: contextId(`stable:${kind}`, serialized),
      bytes: Buffer.byteLength(serialized),
      ...(options.includeDetails ? { data } : {}),
    };
  });
  const stableIdentity = blocks.map((block) => ({ kind: block.kind, id: block.id }));
  const stableSerialized = canonicalJson(stableIdentity);
  const deltaData = canonicalizeDelta(input.delta);
  const deltaSerialized = canonicalJson(deltaData);

  return {
    schema: { name: "qamap.context", version: agentContextSchemaVersion },
    stable: {
      id: contextId("stable", stableSerialized),
      bytes: blocks.reduce((total, block) => total + block.bytes, 0),
      blocks,
    },
    delta: {
      id: contextId("delta", deltaSerialized),
      bytes: Buffer.byteLength(deltaSerialized),
      changedFiles: deltaData.changedFiles.length,
      ...(options.includeDetails ? { data: deltaData } : {}),
    },
  };
}

export function compareAgentContextContracts(
  previous: AgentContextContract,
  current: AgentContextContract,
): {
  reused: AgentContextBlockKind[];
  invalidated: Array<{ kind: AgentContextBlockKind; previousId?: string; currentId?: string }>;
} {
  const previousByKind = new Map(previous.stable.blocks.map((block) => [block.kind, block]));
  const currentByKind = new Map(current.stable.blocks.map((block) => [block.kind, block]));
  const kinds: AgentContextBlockKind[] = ["repository", "manifest", "validation", "behavior"];
  const reused: AgentContextBlockKind[] = [];
  const invalidated: Array<{ kind: AgentContextBlockKind; previousId?: string; currentId?: string }> = [];

  for (const kind of kinds) {
    const prior = previousByKind.get(kind);
    const next = currentByKind.get(kind);
    if (prior?.id && prior.id === next?.id) {
      reused.push(kind);
    } else {
      invalidated.push({ kind, previousId: prior?.id, currentId: next?.id });
    }
  }
  return { reused, invalidated };
}

export async function collectRepositoryValidationFacts(
  root: string,
  manifest: VerificationManifest,
): Promise<string[]> {
  const facts = [...(manifest.context?.validationCommands ?? [])];
  try {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
      if (/(?:^|:)(?:bench|build|check|lint|smoke|test|typecheck|validate|verify)(?:$|:)/iu.test(name)) {
        facts.push(`package-script:${name}=${command}`);
      }
    }
  } catch {
    // Repositories without a readable package.json still retain reviewed
    // manifest commands and the other stable context blocks.
  }
  return uniqueSorted(facts);
}

function stableContextData(input: AgentContextInput): Record<AgentContextBlockKind, unknown> {
  const manifest = normalizeManifest(input.manifest);
  return {
    repository: {
      id: input.repository.id,
      project: input.repository.project,
      runner: input.repository.runner,
      analysisScope: {
        mode: input.repository.analysisScope.mode,
        selectedPath: input.repository.analysisScope.selectedPath,
        packageName: input.repository.analysisScope.packageName,
        candidates: [...input.repository.analysisScope.candidates].sort(compareByJson),
      },
      testSuite: input.repository.testSuite,
    },
    manifest: {
      present: manifest.domains.length > 0 || manifest.flows.length > 0 || Boolean(manifest.context),
      version: manifest.version,
      context: manifestContextPolicy(manifest.context),
      domains: manifest.domains.map((domain) => ({
        id: domain.id,
        criticality: domain.criticality,
        source: normalizeSource(domain.source),
      })).sort(compareByJson),
    },
    validation: uniqueSorted([
      ...(manifest.context?.validationCommands ?? []),
      ...input.validationCommands,
    ]),
    behavior: {
      domains: manifest.domains.map(normalizeDomain).sort(compareByJson),
      flows: manifest.flows.map(normalizeFlow).sort(compareByJson),
    },
  };
}

function canonicalizeDelta(input: AgentContextInput["delta"]): CanonicalDeltaData {
  return {
    base: input.base,
    baseSource: input.baseSource,
    head: input.head,
    includeWorkingTree: input.includeWorkingTree,
    changedFiles: uniqueSorted(input.changedFiles),
    intents: input.intents,
    traces: input.traces,
    flows: input.flows,
    execution: input.execution,
  };
}

function normalizeManifest(manifest: VerificationManifest): VerificationManifest {
  return {
    version: manifest.version,
    ...(manifest.context ? { context: manifest.context } : {}),
    domains: manifest.domains,
    flows: manifest.flows,
  };
}

function manifestContextPolicy(context: VerificationManifestContext | undefined): unknown {
  if (!context) {
    return undefined;
  }
  return {
    instructionFiles: context.instructionFiles.map((file) => ({
      path: file.path,
      kind: file.kind,
      confidence: file.confidence,
      roles: uniqueSorted(file.roles),
      signals: uniqueSorted(file.signals),
    })).sort(compareByJson),
    safetyRules: uniqueSorted(context.safetyRules),
    source: normalizeSource(context.source),
  };
}

function normalizeDomain(domain: VerificationManifestDomain): unknown {
  return {
    id: domain.id,
    name: domain.name,
    paths: uniqueSorted(domain.paths),
    criticality: domain.criticality,
    source: normalizeSource(domain.source),
  };
}

function normalizeFlow(flow: VerificationManifestFlow): unknown {
  return {
    id: flow.id,
    domain: flow.domain,
    name: flow.name,
    entry: flow.entry,
    runner: flow.runner,
    anchors: [...flow.anchors].sort(compareByJson),
    checks: flow.checks.map((check) => ({
      ...check,
      ...(check.steps ? { steps: [...check.steps] } : {}),
    })).sort(compareByJson),
    source: normalizeSource(flow.source),
  };
}

function normalizeSource(source: VerificationManifestSource): VerificationManifestSource {
  return {
    kind: source.kind,
    confidence: source.confidence,
    from: uniqueSorted(source.from),
  };
}

function contextId(prefix: string, serialized: string): string {
  return `${prefix}:sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareByJson(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}
