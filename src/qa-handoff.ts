import { createHash } from "node:crypto";
import type { QaDraftResult } from "./qa.js";
import type { LocalQaReportReceipt } from "./qa-report.js";
import type { ImpactStep } from "./repository-impact.js";
import { createRepositoryTextReader, type DiscoveryGap } from "./repository-discovery.js";
import { isInstructionLikeRepositoryText } from "./qa-contract.js";
import { safeModule, safeSymbol } from "./source-structure.js";

const limits = { paths: 2, excerptLines: 7, excerptBytes: 1200, evidenceBytes: 3072, responseBytes: 8192 } as const;
type EvidenceGap = { file: string; reason: string; line?: number; symbol?: string; module?: string; target?: string; pointer?: string };
interface SourceExcerpt {
  file: string;
  line: number;
  lines?: Array<{ line: number; text: string }>;
  sourceHash?: string;
  truncated?: boolean;
}
export interface ReviewEvidence {
  pathBase: "workspace-root";
  basis: "indexed-working-tree";
  authority: "inferred-draft";
  complete: false;
  pathCount: number;
  omittedPathCount: number;
  paths: Array<{ pointer: string; sourceKind: "source" | "test" | "unknown";
    source: SourceExcerpt; contract: SourceExcerpt; endpoint: string }>;
  gaps: EvidenceGap[];
  omittedGapCount: number;
  limits: typeof limits;
}
export interface LocalQaHandoffReceipt extends Omit<LocalQaReportReceipt, "schema"> {
  schema: { name: "qamap.qa.handoff"; version: 1 };
  usage: { analysisLlmCalls: 0; callerTokens: "not-measured" };
  summary: Record<string, unknown>;
  reviewEvidence: ReviewEvidence;
  recovery: Record<string, string[]>;
}

export async function collectReviewEvidence(result: QaDraftResult): Promise<ReviewEvidence> {
  const allPaths = result.repositoryImpact?.paths ?? [];
  const blocks = new Map(result.repositoryIndex?.blocks.map(block => [block.file, block]));
  const priority = (entry: typeof allPaths[number]): number => entry.endpoint === "test-reference"
    ? blocks.get(entry.evidence[0]?.file ?? "")?.kind === "source" ? 2 : 1
    : 0;
  const paths = allPaths.map((entry, index) => ({ entry, index }))
    .sort((a, b) => priority(b.entry) - priority(a.entry));
  const skipped: DiscoveryGap[] = [];
  const read = createRepositoryTextReader(result.analysisScope.workspaceRoot, skipped, 300_000);
  const texts = new Map<string, string | undefined>();
  const moduleLocations = new Set<string>();
  const gapRank = (reason: string): number => reason === "node-builtin-outside-repository" ? 3
    : reason === "compiled-output-not-verified" ? 2 : reason === "index-excluded-module" ? 1 : 0;
  const gaps: EvidenceGap[] = (result.repositoryImpact?.boundaries ?? []).map((gap, index) => ({ gap, index }))
    .sort((a, b) => gapRank(a.gap.reason) - gapRank(b.gap.reason)
      || Number(blocks.get(b.gap.file)?.kind === "source") - Number(blocks.get(a.gap.file)?.kind === "source"))
    .filter(({ gap }) => {
      if (!gap.module || !Number.isSafeInteger(gap.line) || gap.line! < 1) return true;
      const key = JSON.stringify([gap.file, gap.line, gap.module, gap.reason, gap.target]);
      if (moduleLocations.has(key)) return false;
      moduleLocations.add(key);
      return true;
    })
    .slice(0, 8)
    .map(({ gap, index }) => ({ file: safeFile(gap.file) ? gap.file : "<unsupported-path>", reason: gap.reason,
      ...(Number.isSafeInteger(gap.line) && gap.line! > 0 ? { line: gap.line } : {}),
      ...(gap.symbol && safeSymbol(gap.symbol) ? { symbol: gap.symbol } : {}),
      ...(gap.module && safeModule(gap.module) ? { module: gap.module } : {}),
      ...(gap.target && safeFile(gap.target) ? { target: gap.target } : {}),
      pointer: `/repositoryImpact/boundaries/${index}` }));
  const evidence: ReviewEvidence = {
    pathBase: "workspace-root", basis: "indexed-working-tree", authority: "inferred-draft", complete: false,
    pathCount: allPaths.length, omittedPathCount: allPaths.length + (result.repositoryImpact?.omittedPaths ?? 0),
    paths: [], gaps, omittedGapCount: Math.max(0, (result.repositoryImpact?.boundaries.length ?? 0) - gaps.length), limits,
  };
  const gap = (file: string, reason: string): void => {
    if (gaps.length < 8) gaps.push({ file: safeFile(file) ? file : "<unsupported-path>", reason });
    else evidence.omittedGapCount++;
  };
  const excerpt = async (step: ImpactStep): Promise<SourceExcerpt> => {
    const ref: SourceExcerpt = { file: safeFile(step.file) ? step.file : "<unsupported-path>", line: step.line };
    const block = blocks.get(step.file);
    if (!safeFile(step.file) || !Number.isSafeInteger(step.line) || step.line < 1
      || !block || !["source", "test"].includes(block.kind)) {
      gap(step.file, "unsupported-source-reference"); return ref;
    }
    if (!texts.has(step.file)) {
      const prior = skipped.length;
      const text = await read(step.file);
      if (text === undefined) gap(step.file, skipped[prior]?.reason ?? "unreadable");
      else if (createHash("sha256").update(text).digest("hex") !== block.hash) {
        gap(step.file, "source-changed"); texts.set(step.file, undefined); return ref;
      }
      texts.set(step.file, text);
    }
    const text = texts.get(step.file);
    if (text === undefined) return ref;
    const lines = text.split(/\r?\n/);
    if (step.line > lines.length) { gap(step.file, "source-line-unavailable"); return ref; }
    const start = Math.max(0, step.line - 2);
    const selected = lines.slice(start, start + limits.excerptLines);
    if (isInstructionLikeRepositoryText(selected.join("\n"))) {
      gap(step.file, "instruction-like-source"); return ref;
    }
    const numbered = selected.map((line, index) => ({ line: start + index + 1, text: line }));
    if (Buffer.byteLength(JSON.stringify(numbered)) > limits.excerptBytes) {
      gap(step.file, "excerpt-byte-limit"); return { ...ref, truncated: true };
    }
    return { ...ref, sourceHash: block.hash, lines: numbered,
      truncated: start > 0 || start + selected.length < lines.length };
  };
  const selectedPairs = new Set<string>();
  for (const { entry, index } of paths) {
    if (evidence.paths.length >= limits.paths) break;
    const source = entry.evidence[0];
    const contract = entry.evidence.at(-1);
    if (!source || !contract) { gap(entry.changedFile, "missing-path-endpoint"); continue; }
    const pair = JSON.stringify([entry.changedFile, entry.changedSymbol, entry.endpoint,
      source.file, source.line, source.symbol, source.relation, contract.file, contract.line, contract.symbol, contract.relation]);
    if (selectedPairs.has(pair)) continue;
    selectedPairs.add(pair);
    const kind = blocks.get(source.file)?.kind;
    evidence.paths.push({ pointer: `/repositoryImpact/paths/${index}`, endpoint: entry.endpoint,
      sourceKind: kind === "source" || kind === "test" ? kind : "unknown",
      source: await excerpt(source), contract: await excerpt(contract) });
    evidence.omittedPathCount--;
  }
  // Keep complete endpoint pairs together; truncation must never silently become no impact.
  trimEvidence(evidence, () => Buffer.byteLength(JSON.stringify(evidence)) > limits.evidenceBytes);
  return evidence;
}

export async function buildLocalQaHandoff(
  result: QaDraftResult,
  receipt: LocalQaReportReceipt,
  summary: Record<string, unknown>,
): Promise<LocalQaHandoffReceipt> {
  const handoff: LocalQaHandoffReceipt = {
    ...receipt,
    schema: { name: "qamap.qa.handoff", version: 1 },
    usage: { analysisLlmCalls: 0, callerTokens: "not-measured" },
    summary,
    reviewEvidence: await collectReviewEvidence(result),
    recovery: {
      repository: ["/repositoryIndex", "/repositoryImpact"],
      testContracts: ["/testContracts/items"],
      traces: ["/evidence/traces"],
      action: ["/action"],
      scope: ["/evidence/base", "/evidence/head", "/evidence/includeWorkingTree", "/analysisScope"],
    },
  };
  const oversized = (): boolean => Buffer.byteLength(JSON.stringify(handoff)) + 1 > limits.responseBytes;
  trimEvidence(handoff.reviewEvidence, oversized);
  if (oversized()) throw new Error("QA handoff exceeds its output limit; use a shorter report output path.");
  return handoff;
}

function trimEvidence(evidence: ReviewEvidence, oversized: () => boolean): void {
  // Keep the strongest pair when it fits alone; omitted diagnostics remain recoverable.
  while (oversized() && evidence.paths.length > 1) { evidence.paths.pop(); evidence.omittedPathCount++; }
  while (oversized() && evidence.gaps.length) { evidence.gaps.pop(); evidence.omittedGapCount++; }
  while (oversized() && evidence.paths.length) { evidence.paths.pop(); evidence.omittedPathCount++; }
}

function safeFile(file: string): boolean {
  return file.length > 0 && Buffer.byteLength(file) <= 512 && !/[\\\x00-\x1f\x7f-\x9f]/.test(file)
    && !file.split("/").some(part => !part || part === "." || part === "..");
}
