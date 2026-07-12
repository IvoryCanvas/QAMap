import { createHash } from "node:crypto";

export const behaviorGraphSchemaVersion = 1 as const;
export const behaviorGraphSchemaUrl =
  "https://raw.githubusercontent.com/IvoryCanvas/qamap/main/schema/qamap-behavior.schema.json";

export const behaviorSurfaceKinds = ["web", "mobile", "api", "cli", "artifact", "unknown"] as const;
export const behaviorNodeKinds = [
  "domain",
  "flow",
  "surface",
  "action",
  "state",
  "effect",
  "contract",
  "assertion",
  "fixture",
  "locator",
  "source",
] as const;
export const behaviorEdgeKinds = [
  "contains",
  "enters-at",
  "precedes",
  "expects",
  "uses-fixture",
  "located-by",
  "implemented-by",
  "impacts",
] as const;
export const behaviorEvidenceKinds = ["commit", "diff", "source", "manifest", "selector", "fixture", "test", "inference"] as const;

export type BehaviorConfidence = "low" | "medium" | "high";
export type BehaviorAdapterConfidence = "none" | BehaviorConfidence;
export type BehaviorSurfaceKind = (typeof behaviorSurfaceKinds)[number];
export type BehaviorNodeKind = (typeof behaviorNodeKinds)[number];
export type BehaviorEdgeKind = (typeof behaviorEdgeKinds)[number];
export type BehaviorEvidenceKind = (typeof behaviorEvidenceKinds)[number];
export type BehaviorImpactKind = "direct" | "propagated";
export type BehaviorDiagnosticSeverity = "info" | "warning";
export type BehaviorAttributeValue = string | number | boolean | string[];

export interface BehaviorEvidence {
  kind: BehaviorEvidenceKind;
  value: string;
  file?: string;
}

export interface BehaviorImpact {
  kind: BehaviorImpactKind;
  changedFiles: string[];
}

export interface BehaviorNode {
  id: string;
  kind: BehaviorNodeKind;
  label: string;
  confidence: BehaviorConfidence;
  evidence: BehaviorEvidence[];
  attributes?: Record<string, BehaviorAttributeValue>;
  impact?: BehaviorImpact;
}

export interface BehaviorEdge {
  id: string;
  kind: BehaviorEdgeKind;
  from: string;
  to: string;
  confidence: BehaviorConfidence;
  evidence: BehaviorEvidence[];
}

export interface BehaviorDiagnostic {
  severity: BehaviorDiagnosticSeverity;
  message: string;
  adapterId?: string;
}

export interface BehaviorAdapterDetection {
  confidence: BehaviorAdapterConfidence;
  reason: string;
  evidence: string[];
}

export interface BehaviorAdapterRun {
  id: string;
  version: string;
  status: "used" | "skipped" | "failed";
  detection: BehaviorAdapterDetection;
  nodeCount: number;
  edgeCount: number;
}

export interface BehaviorGraphSummary {
  nodes: number;
  edges: number;
  impactedNodes: number;
  byKind: Record<BehaviorNodeKind, number>;
}

export interface BehaviorGraph {
  $schema?: string;
  schemaVersion: typeof behaviorGraphSchemaVersion;
  root: string;
  workspaceRoot?: string;
  base: string;
  head: string;
  surface: BehaviorSurfaceKind;
  adapters: BehaviorAdapterRun[];
  nodes: BehaviorNode[];
  edges: BehaviorEdge[];
  diagnostics: BehaviorDiagnostic[];
  summary: BehaviorGraphSummary;
}

export interface BehaviorChangedFile {
  path: string;
  status: string;
  previousPath?: string;
}

export interface BehaviorAnalysisContext {
  root: string;
  workspaceRoot?: string;
  base: string;
  head: string;
  projectType: string;
  surface: BehaviorSurfaceKind;
  runner?: string;
  changedFiles: BehaviorChangedFile[];
}

export interface BehaviorGraphFragment {
  nodes: BehaviorNode[];
  edges: BehaviorEdge[];
  diagnostics?: BehaviorDiagnostic[];
}

export interface BehaviorAnalyzerAdapter {
  id: string;
  version: string;
  detect(context: BehaviorAnalysisContext): BehaviorAdapterDetection | Promise<BehaviorAdapterDetection>;
  analyze(context: BehaviorAnalysisContext): BehaviorGraphFragment | Promise<BehaviorGraphFragment>;
}

export interface InferredBehaviorEntrypoint {
  kind: "route" | "screen" | "command";
  value: string;
  file: string;
  confidence: BehaviorConfidence;
}

export interface InferredBehaviorSelector {
  kind: string;
  value: string;
  file: string;
  addedInDiff?: boolean;
}

export interface InferredBehaviorCoverage {
  title: string;
  priority: string;
  reason: string;
  checks: string[];
}

export interface InferredBehaviorFlow {
  kind: string;
  title: string;
  reason: string;
  files: string[];
  steps: string[];
  entrypoints: InferredBehaviorEntrypoint[];
  selectors: InferredBehaviorSelector[];
  coverage: InferredBehaviorCoverage[];
  fixtureStatus: string;
  fixtureFiles: string[];
}

export interface InferredFlowAdapterOptions {
  flows: InferredBehaviorFlow[];
}

const confidenceWeight: Record<BehaviorConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const assertionStepMatcher = /^\s*(?:assert|check|compare|confirm|ensure|expect|record|reject|verify)\b/i;

export async function analyzeBehaviorGraph(
  context: BehaviorAnalysisContext,
  adapters: BehaviorAnalyzerAdapter[],
): Promise<BehaviorGraph> {
  const adapterRuns: BehaviorAdapterRun[] = [];
  const fragments: BehaviorGraphFragment[] = [];
  const diagnostics: BehaviorDiagnostic[] = [];

  for (const adapter of [...adapters].sort((left, right) => left.id.localeCompare(right.id))) {
    let detection: BehaviorAdapterDetection;
    try {
      detection = normalizeDetection(await adapter.detect(context));
    } catch (error) {
      const message = errorMessage(error);
      diagnostics.push({ severity: "warning", adapterId: adapter.id, message: `Adapter detection failed: ${message}` });
      adapterRuns.push({
        id: adapter.id,
        version: adapter.version,
        status: "failed",
        detection: { confidence: "none", reason: message, evidence: [] },
        nodeCount: 0,
        edgeCount: 0,
      });
      continue;
    }

    if (detection.confidence === "none") {
      adapterRuns.push({
        id: adapter.id,
        version: adapter.version,
        status: "skipped",
        detection,
        nodeCount: 0,
        edgeCount: 0,
      });
      continue;
    }

    try {
      const fragment = await adapter.analyze(context);
      fragments.push({
        ...fragment,
        diagnostics: (fragment.diagnostics ?? []).map((item) => ({ ...item, adapterId: item.adapterId ?? adapter.id })),
      });
      adapterRuns.push({
        id: adapter.id,
        version: adapter.version,
        status: "used",
        detection,
        nodeCount: fragment.nodes.length,
        edgeCount: fragment.edges.length,
      });
    } catch (error) {
      const message = errorMessage(error);
      diagnostics.push({ severity: "warning", adapterId: adapter.id, message: `Adapter analysis failed: ${message}` });
      adapterRuns.push({
        id: adapter.id,
        version: adapter.version,
        status: "failed",
        detection,
        nodeCount: 0,
        edgeCount: 0,
      });
    }
  }

  const merged = mergeBehaviorGraphFragments(fragments);
  diagnostics.push(...(merged.diagnostics ?? []));
  return {
    $schema: behaviorGraphSchemaUrl,
    schemaVersion: behaviorGraphSchemaVersion,
    root: context.root,
    workspaceRoot: context.workspaceRoot,
    base: context.base,
    head: context.head,
    surface: context.surface,
    adapters: adapterRuns,
    nodes: merged.nodes,
    edges: merged.edges,
    diagnostics,
    summary: summarizeBehaviorGraph(merged.nodes, merged.edges),
  };
}

export function mergeBehaviorGraphFragments(fragments: BehaviorGraphFragment[]): BehaviorGraphFragment {
  const nodes = new Map<string, BehaviorNode>();
  const edges = new Map<string, BehaviorEdge>();
  const diagnostics: BehaviorDiagnostic[] = [];

  for (const fragment of fragments) {
    diagnostics.push(...(fragment.diagnostics ?? []));
    for (const node of fragment.nodes) {
      const existing = nodes.get(node.id);
      if (!existing) {
        nodes.set(node.id, normalizeNode(node));
        continue;
      }
      if (existing.kind !== node.kind) {
        diagnostics.push({
          severity: "warning",
          message: `Behavior node ${node.id} was emitted with both ${existing.kind} and ${node.kind}; keeping ${existing.kind}.`,
        });
        continue;
      }
      nodes.set(node.id, mergeNodes(existing, node));
    }
    for (const edge of fragment.edges) {
      const existing = edges.get(edge.id);
      edges.set(edge.id, existing ? mergeEdges(existing, edge) : normalizeEdge(edge));
    }
  }

  for (const [id, edge] of edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      continue;
    }
    edges.delete(id);
    diagnostics.push({
      severity: "warning",
      message: `Dropped behavior edge ${id} because one or both endpoint nodes were missing.`,
    });
  }

  return {
    nodes: [...nodes.values()].sort(compareById),
    edges: [...edges.values()].sort(compareById),
    diagnostics,
  };
}

export function createInferredFlowBehaviorAdapter(options: InferredFlowAdapterOptions): BehaviorAnalyzerAdapter {
  return {
    id: "qamap.inferred-flow-compat",
    version: "1",
    detect: () => ({
      confidence: options.flows.length > 0 ? "high" : "none",
      reason: options.flows.length > 0
        ? "QAMap produced deterministic flow observations that can be represented in the behavior graph."
        : "No inferred flow observations were available.",
      evidence: options.flows.slice(0, 8).map((flow) => flow.title),
    }),
    analyze: (context) => buildInferredFlowFragment(context, options.flows),
  };
}

export function createBehaviorNodeId(kind: BehaviorNodeKind, ...parts: string[]): string {
  const identity = parts.map((part) => part.trim()).join("\u0000");
  const readable = slugify(parts.find((part) => part.trim().length > 0) ?? kind).slice(0, 40) || kind;
  return `${kind}:${readable}:${shortHash(`${kind}\u0000${identity}`)}`;
}

export function createBehaviorEdge(
  kind: BehaviorEdgeKind,
  from: string,
  to: string,
  confidence: BehaviorConfidence,
  evidence: BehaviorEvidence[] = [],
): BehaviorEdge {
  return {
    id: `edge:${shortHash(`${kind}\u0000${from}\u0000${to}`)}`,
    kind,
    from,
    to,
    confidence,
    evidence: uniqueEvidence(evidence),
  };
}

function buildInferredFlowFragment(
  context: BehaviorAnalysisContext,
  flows: InferredBehaviorFlow[],
): BehaviorGraphFragment {
  const nodes: BehaviorNode[] = [];
  const edges: BehaviorEdge[] = [];
  const changedFiles = new Set(context.changedFiles.map((file) => file.path));

  for (const flow of flows) {
    const files = uniqueStrings(flow.files);
    const directlyChanged = files.filter((file) => changedFiles.has(file));
    const impactFiles = directlyChanged.length > 0
      ? directlyChanged
      : context.changedFiles.map((file) => file.path).slice(0, 12);
    const confidence = inferredFlowConfidence(flow);
    const flowId = createBehaviorNodeId("flow", flow.kind, flow.title, ...files.slice().sort());
    nodes.push({
      id: flowId,
      kind: "flow",
      label: flow.title,
      confidence,
      evidence: uniqueEvidence([
        { kind: "inference", value: flow.reason },
        ...files.slice(0, 12).map((file) => ({ kind: "source" as const, value: file, file })),
      ]),
      attributes: {
        flowKind: flow.kind,
        surface: surfaceForFlow(flow, context.surface),
        fixtureStatus: flow.fixtureStatus,
      },
      impact: impactFiles.length > 0
        ? { kind: directlyChanged.length > 0 ? "direct" : "propagated", changedFiles: uniqueStrings(impactFiles) }
        : undefined,
    });

    for (const file of files) {
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
          ? createBehaviorEdge("impacts", sourceId, flowId, "high", [{ kind: "diff", value: file, file }])
          : createBehaviorEdge("implemented-by", flowId, sourceId, "medium", [{ kind: "source", value: file, file }]),
      );
    }

    for (const entrypoint of flow.entrypoints) {
      const surfaceId = createBehaviorNodeId("surface", entrypoint.kind, entrypoint.value, entrypoint.file);
      nodes.push({
        id: surfaceId,
        kind: "surface",
        label: `${entrypoint.kind}: ${entrypoint.value}`,
        confidence: entrypoint.confidence,
        evidence: [{ kind: "source", value: entrypoint.value, file: entrypoint.file }],
        attributes: {
          entrypointKind: entrypoint.kind,
          value: entrypoint.value,
          surface: surfaceForEntrypoint(entrypoint.kind),
        },
      });
      edges.push(createBehaviorEdge("enters-at", flowId, surfaceId, entrypoint.confidence, [
        { kind: "source", value: entrypoint.value, file: entrypoint.file },
      ]));
    }

    let previousStepId: string | undefined;
    flow.steps.forEach((step, index) => {
      const kind: BehaviorNodeKind = assertionStepMatcher.test(step) ? "assertion" : "action";
      const stepId = createBehaviorNodeId(kind, flowId, String(index), step);
      nodes.push({
        id: stepId,
        kind,
        label: step,
        confidence,
        evidence: [{ kind: "inference", value: `flow-step:${index + 1}` }],
        attributes: { order: index + 1 },
      });
      edges.push(createBehaviorEdge(kind === "assertion" ? "expects" : "contains", flowId, stepId, confidence));
      if (previousStepId) {
        edges.push(createBehaviorEdge("precedes", previousStepId, stepId, confidence));
      }
      previousStepId = stepId;
    });

    flow.coverage.forEach((target, targetIndex) => {
      const checks = target.checks.length > 0 ? target.checks : [target.title];
      checks.forEach((check, checkIndex) => {
        const assertionId = createBehaviorNodeId("assertion", flowId, "coverage", String(targetIndex), String(checkIndex), check);
        nodes.push({
          id: assertionId,
          kind: "assertion",
          label: check,
          confidence: confidenceForPriority(target.priority),
          evidence: [{ kind: "inference", value: target.reason }],
          attributes: { coverageTarget: target.title, priority: target.priority },
        });
        edges.push(createBehaviorEdge("expects", flowId, assertionId, confidenceForPriority(target.priority)));
      });
    });

    for (const selector of flow.selectors) {
      const locatorId = createBehaviorNodeId("locator", selector.kind, selector.value, selector.file);
      nodes.push({
        id: locatorId,
        kind: "locator",
        label: `${selector.kind}: ${selector.value}`,
        confidence: selector.addedInDiff ? "high" : "medium",
        evidence: [{
          kind: selector.addedInDiff ? "diff" : "selector",
          value: selector.value,
          file: selector.file,
        }],
        attributes: { selectorKind: selector.kind, value: selector.value, addedInDiff: selector.addedInDiff ?? false },
      });
      edges.push(createBehaviorEdge("located-by", flowId, locatorId, selector.addedInDiff ? "high" : "medium"));
    }

    for (const fixtureFile of uniqueStrings(flow.fixtureFiles)) {
      const fixtureId = createBehaviorNodeId("fixture", fixtureFile);
      nodes.push({
        id: fixtureId,
        kind: "fixture",
        label: fixtureFile,
        confidence: "high",
        evidence: [{ kind: "fixture", value: fixtureFile, file: fixtureFile }],
        attributes: { path: fixtureFile },
      });
      edges.push(createBehaviorEdge("uses-fixture", flowId, fixtureId, "high"));
    }
  }

  return { nodes, edges };
}

function surfaceForFlow(flow: InferredBehaviorFlow, fallback: BehaviorSurfaceKind): BehaviorSurfaceKind {
  if (flow.kind === "api") {
    return "api";
  }
  if (flow.kind === "command") {
    return "cli";
  }
  if (flow.kind === "artifact" || flow.kind === "catalog" || flow.kind === "generated-artifact") {
    return "artifact";
  }
  return fallback;
}

function surfaceForEntrypoint(kind: InferredBehaviorEntrypoint["kind"]): BehaviorSurfaceKind {
  if (kind === "route") {
    return "web";
  }
  if (kind === "screen") {
    return "mobile";
  }
  return "cli";
}

function inferredFlowConfidence(flow: InferredBehaviorFlow): BehaviorConfidence {
  if (flow.entrypoints.some((entrypoint) => entrypoint.confidence === "high") || flow.selectors.some((selector) => selector.addedInDiff)) {
    return "high";
  }
  if (flow.entrypoints.length > 0 || flow.selectors.length > 0 || flow.files.length > 0) {
    return "medium";
  }
  return "low";
}

function confidenceForPriority(priority: string): BehaviorConfidence {
  if (priority === "critical") {
    return "high";
  }
  if (priority === "recommended") {
    return "medium";
  }
  return "low";
}

function normalizeDetection(detection: BehaviorAdapterDetection): BehaviorAdapterDetection {
  return {
    confidence: detection.confidence,
    reason: detection.reason.trim() || "No detection reason was provided.",
    evidence: uniqueStrings(detection.evidence),
  };
}

function mergeNodes(left: BehaviorNode, right: BehaviorNode): BehaviorNode {
  return {
    ...left,
    confidence: strongerConfidence(left.confidence, right.confidence),
    evidence: uniqueEvidence([...left.evidence, ...right.evidence]),
    attributes: left.attributes || right.attributes ? { ...(left.attributes ?? {}), ...(right.attributes ?? {}) } : undefined,
    impact: mergeImpact(left.impact, right.impact),
  };
}

function mergeEdges(left: BehaviorEdge, right: BehaviorEdge): BehaviorEdge {
  return {
    ...left,
    confidence: strongerConfidence(left.confidence, right.confidence),
    evidence: uniqueEvidence([...left.evidence, ...right.evidence]),
  };
}

function normalizeNode(node: BehaviorNode): BehaviorNode {
  return {
    ...node,
    evidence: uniqueEvidence(node.evidence),
    impact: node.impact ? { ...node.impact, changedFiles: uniqueStrings(node.impact.changedFiles) } : undefined,
  };
}

function normalizeEdge(edge: BehaviorEdge): BehaviorEdge {
  return { ...edge, evidence: uniqueEvidence(edge.evidence) };
}

function mergeImpact(left?: BehaviorImpact, right?: BehaviorImpact): BehaviorImpact | undefined {
  if (!left) {
    return right ? { ...right, changedFiles: uniqueStrings(right.changedFiles) } : undefined;
  }
  if (!right) {
    return { ...left, changedFiles: uniqueStrings(left.changedFiles) };
  }
  return {
    kind: left.kind === "direct" || right.kind === "direct" ? "direct" : "propagated",
    changedFiles: uniqueStrings([...left.changedFiles, ...right.changedFiles]),
  };
}

function summarizeBehaviorGraph(nodes: BehaviorNode[], edges: BehaviorEdge[]): BehaviorGraphSummary {
  const byKind = emptyNodeCounts();
  for (const node of nodes) {
    byKind[node.kind] += 1;
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    impactedNodes: nodes.filter((node) => node.impact && node.impact.changedFiles.length > 0).length,
    byKind,
  };
}

function emptyNodeCounts(): Record<BehaviorNodeKind, number> {
  return {
    domain: 0,
    flow: 0,
    surface: 0,
    action: 0,
    state: 0,
    effect: 0,
    contract: 0,
    assertion: 0,
    fixture: 0,
    locator: 0,
    source: 0,
  };
}

function strongerConfidence(left: BehaviorConfidence, right: BehaviorConfidence): BehaviorConfidence {
  return confidenceWeight[left] >= confidenceWeight[right] ? left : right;
}

function uniqueEvidence(items: BehaviorEvidence[]): BehaviorEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}\u0000${item.value}\u0000${item.file ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function compareById(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
