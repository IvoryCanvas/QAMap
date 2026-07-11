import path from "node:path";
import {
  createBehaviorEdge,
  createBehaviorNodeId,
  type BehaviorAnalysisContext,
  type BehaviorAnalyzerAdapter,
  type BehaviorAttributeValue,
  type BehaviorConfidence,
  type BehaviorEvidence,
  type BehaviorGraphFragment,
  type BehaviorImpact,
  type BehaviorNode,
  type BehaviorNodeKind,
} from "./behavior.js";
import type { VerificationManifestMatch } from "./manifest.js";

export interface ManifestBehaviorAdapterOptions {
  matches: VerificationManifestMatch[];
}

export function createManifestBehaviorAdapter(options: ManifestBehaviorAdapterOptions): BehaviorAnalyzerAdapter {
  return {
    id: "qamap.verification-manifest",
    version: "1",
    detect: () => ({
      confidence: manifestDetectionConfidence(options.matches),
      reason: options.matches.length > 0
        ? "The repository verification manifest matched this branch and can supply reviewed behavior evidence."
        : "No verification manifest entries matched this branch.",
      evidence: uniqueStrings(options.matches.map((match) => match.manifestPath)).slice(0, 12),
    }),
    analyze: (context) => buildManifestBehaviorFragment(context, options.matches),
  };
}

function buildManifestBehaviorFragment(
  context: BehaviorAnalysisContext,
  matches: VerificationManifestMatch[],
): BehaviorGraphFragment {
  const nodes: BehaviorNode[] = [];
  const edges = [];
  const changedFiles = new Set(context.changedFiles.map((file) => file.path));
  const flowMatches = new Map(matches.filter((match) => match.kind === "flow").map((match) => [match.id, match]));
  const domainNodes: Array<{ match: VerificationManifestMatch; nodeId: string; files: string[] }> = [];
  const flowNodes: Array<{ match: VerificationManifestMatch; nodeId: string; files: string[] }> = [];

  for (const match of [...matches].sort(compareManifestMatches)) {
    const files = manifestFilesForContext(context, match.matchedFiles);
    const nodeKind = nodeKindForMatch(match);
    const nodeId = manifestNodeId(nodeKind, match.id);
    const impact = manifestImpact(context, files, changedFiles);
    const evidence = manifestEvidence(match, files);
    nodes.push({
      id: nodeId,
      kind: nodeKind,
      label: match.name,
      confidence: match.confidence,
      evidence,
      attributes: manifestAttributes(match),
      impact,
    });

    if (match.kind === "domain") {
      domainNodes.push({ match, nodeId, files });
    } else if (match.kind === "flow") {
      flowNodes.push({ match, nodeId, files });
    }

    for (const file of files) {
      const sourceId = createBehaviorNodeId("source", file);
      const direct = changedFiles.has(file);
      nodes.push({
        id: sourceId,
        kind: "source",
        label: file,
        confidence: "high",
        evidence: [
          { kind: direct ? "diff" : "source", value: file, file },
          { kind: "manifest", value: match.manifestPath, file },
        ],
        attributes: { path: file },
        impact: direct ? { kind: "direct", changedFiles: [file] } : undefined,
      });
      edges.push(
        direct
          ? createBehaviorEdge("impacts", sourceId, nodeId, "high", [{ kind: "manifest", value: match.manifestPath, file }])
          : createBehaviorEdge("implemented-by", nodeId, sourceId, match.confidence, [
              { kind: "manifest", value: match.manifestPath, file },
            ]),
      );
    }

    if (match.kind === "flow" && match.entryRoute) {
      const surfaceId = createBehaviorNodeId("surface", "manifest-route", match.entryRoute, match.id);
      nodes.push({
        id: surfaceId,
        kind: "surface",
        label: `route: ${match.entryRoute}`,
        confidence: match.confidence,
        evidence: [{ kind: "manifest", value: match.manifestPath }],
        attributes: { entrypointKind: "route", value: match.entryRoute, surface: "web", source: "manifest" },
      });
      edges.push(createBehaviorEdge("enters-at", nodeId, surfaceId, match.confidence, evidence));
    }

    if (match.kind === "check") {
      const flowId = parentFlowId(match.id);
      const parentMatch = flowMatches.get(flowId);
      const parentNodeId = manifestNodeId("flow", flowId);
      if (!parentMatch) {
        nodes.push({
          id: parentNodeId,
          kind: "flow",
          label: flowId,
          confidence: match.confidence,
          evidence,
          attributes: { manifestId: flowId, source: "manifest" },
          impact,
        });
      }
      edges.push(createBehaviorEdge("expects", parentNodeId, nodeId, match.confidence, evidence));

      if (match.checkSelector) {
        const locatorId = createBehaviorNodeId("locator", "manifest", match.checkSelector, match.id);
        nodes.push({
          id: locatorId,
          kind: "locator",
          label: `manifest selector: ${match.checkSelector}`,
          confidence: match.confidence,
          evidence: [{ kind: "manifest", value: match.manifestPath }],
          attributes: { value: match.checkSelector, source: "manifest" },
        });
        edges.push(createBehaviorEdge("located-by", nodeId, locatorId, match.confidence, evidence));
      }
    }
  }

  for (const domain of domainNodes) {
    for (const flow of flowNodes) {
      if (!filesOverlap(domain.files, flow.files)) {
        continue;
      }
      edges.push(createBehaviorEdge("contains", domain.nodeId, flow.nodeId, weakerConfidence(domain.match.confidence, flow.match.confidence), [
        { kind: "manifest", value: domain.match.manifestPath },
        { kind: "manifest", value: flow.match.manifestPath },
      ]));
    }
  }

  return { nodes, edges };
}

function manifestNodeId(kind: BehaviorNodeKind, id: string): string {
  return createBehaviorNodeId(kind, "manifest", id);
}

function nodeKindForMatch(match: VerificationManifestMatch): BehaviorNodeKind {
  if (match.kind === "domain") {
    return "domain";
  }
  if (match.kind === "flow") {
    return "flow";
  }
  return "assertion";
}

function manifestDetectionConfidence(matches: VerificationManifestMatch[]): BehaviorConfidence | "none" {
  if (matches.some((match) => match.kind === "flow" || match.kind === "check")) {
    return "high";
  }
  return matches.length > 0 ? "medium" : "none";
}

function manifestImpact(
  context: BehaviorAnalysisContext,
  matchedFiles: string[],
  changedFiles: Set<string>,
): BehaviorImpact | undefined {
  const directFiles = uniqueStrings(matchedFiles).filter((file) => changedFiles.has(file));
  if (directFiles.length > 0) {
    return { kind: "direct", changedFiles: directFiles };
  }
  const propagatedFiles = context.changedFiles.map((file) => file.path).slice(0, 12);
  return propagatedFiles.length > 0 ? { kind: "propagated", changedFiles: propagatedFiles } : undefined;
}

function manifestEvidence(match: VerificationManifestMatch, files: string[]): BehaviorEvidence[] {
  return [
    { kind: "manifest", value: match.manifestPath },
    ...match.evidenceSources.map((source) => ({ kind: "manifest" as const, value: source })),
    ...files.slice(0, 12).map((file) => ({ kind: "source" as const, value: file, file })),
  ];
}

function manifestFilesForContext(context: BehaviorAnalysisContext, matchedFiles: string[]): string[] {
  const workspaceRoot = context.workspaceRoot ? path.resolve(context.workspaceRoot) : undefined;
  const root = path.resolve(context.root);
  if (!workspaceRoot || workspaceRoot === root) {
    return uniqueStrings(matchedFiles.map(toPosixPath));
  }
  const packagePrefix = toPosixPath(path.relative(workspaceRoot, root)).replace(/^\.\/+|\/+$/g, "");
  if (!packagePrefix || packagePrefix.startsWith("..")) {
    return uniqueStrings(matchedFiles.map(toPosixPath));
  }
  return uniqueStrings(
    matchedFiles.map((file) => {
      const normalized = toPosixPath(file).replace(/^\.\/+/, "");
      return normalized.startsWith(`${packagePrefix}/`) ? normalized.slice(packagePrefix.length + 1) : normalized;
    }),
  );
}

function manifestAttributes(match: VerificationManifestMatch): Record<string, BehaviorAttributeValue> {
  const attributes: Record<string, BehaviorAttributeValue> = {
    manifestId: match.id,
    matchKind: match.kind,
    source: "manifest",
    updatePath: match.updatePath,
  };
  if (match.criticality) {
    attributes.criticality = match.criticality;
  }
  if (match.runner) {
    attributes.runner = match.runner;
  }
  if (match.entryRoute) {
    attributes.entryRoute = match.entryRoute;
  }
  if (match.checkType) {
    attributes.checkType = match.checkType;
  }
  if (match.checkSelector) {
    attributes.checkSelector = match.checkSelector;
  }
  if (match.checkValue) {
    attributes.checkValue = match.checkValue;
  }
  if (match.checkSteps && match.checkSteps.length > 0) {
    attributes.checkSteps = match.checkSteps;
  }
  return attributes;
}

function parentFlowId(checkId: string): string {
  const parts = checkId.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : checkId;
}

function filesOverlap(left: string[], right: string[]): boolean {
  const leftFiles = new Set(left);
  return right.some((file) => leftFiles.has(file));
}

function weakerConfidence(left: BehaviorConfidence, right: BehaviorConfidence): BehaviorConfidence {
  const rank: Record<BehaviorConfidence, number> = { low: 1, medium: 2, high: 3 };
  return rank[left] <= rank[right] ? left : right;
}

function compareManifestMatches(left: VerificationManifestMatch, right: VerificationManifestMatch): number {
  const kindRank = { domain: 0, flow: 1, check: 2 };
  return kindRank[left.kind] - kindRank[right.kind] || left.id.localeCompare(right.id);
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
