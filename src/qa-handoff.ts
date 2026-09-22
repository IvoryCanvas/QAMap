import { createHash } from "node:crypto";
import ts from "typescript";
import type { QaDraftResult } from "./qa.js";
import type { LocalQaReportReceipt } from "./qa-report.js";
import type { ImpactStep } from "./repository-impact.js";
import { createRepositoryTextReader, type DiscoveryGap } from "./repository-discovery.js";
import { isInstructionLikeRepositoryText } from "./qa-contract.js";
import { safeModule, safeSymbol } from "./source-structure.js";
import { createTestExpectationReader } from "./test-expectation-evidence.js";
import type { PackedReviewText } from "./qa-evidence-pack.js";

const limits = { paths: 32, excerptLines: 14, excerptBytes: 1200, evidenceBytes: 15360, responseBytes: 16384 } as const;
const inlineResponseBytes = 32768;
type EvidenceGap = { file: string; reason: string; line?: number; symbol?: string; module?: string; target?: string; pointer?: string };
interface SourceExcerpt {
  file: string;
  line: number;
  changedLine?: number;
  changedLines?: number[];
  deletionLines?: number[];
  anchorLines?: number[];
  contextLines?: number[];
  omittedChangedLineCount?: number;
  excerptRef?: string;
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
    source: SourceExcerpt; contract: SourceExcerpt; via?: SourceExcerpt[]; endpoint: string }>;
  gaps: EvidenceGap[];
  omittedGapCount: number;
  sourceDigest?: { algorithm: "sha256"; fileCount: number; value: string };
  limits: { paths: number; excerptLines: number; excerptBytes: number; evidenceBytes: number; responseBytes: number };
}
export interface EvidenceArchive {
  file: string;
  sha256: string;
  bytes: number;
  pathCount: number;
  omittedPathCount: number;
  required: boolean;
  review?: { file: string; sha256: string; bytes: number };
}
export interface LocalQaHandoffReceipt extends Omit<LocalQaReportReceipt, "schema"> {
  schema: { name: "qamap.qa.handoff"; version: 1 };
  usage: { analysisLlmCalls: 0; callerTokens: "not-measured" };
  summary: Record<string, unknown>;
  reviewEvidence: ReviewEvidence;
  recovery: Record<string, string[]>;
  evidenceArchive?: EvidenceArchive;
  inlineReview?: PackedReviewText;
}

export async function collectReviewEvidence(result: QaDraftResult, options: { archive?: boolean } = {}): Promise<ReviewEvidence> {
  const evidenceLimits = options.archive
    ? { ...limits, paths: 9216, excerptLines: 2048, excerptBytes: 300_000, evidenceBytes: 64 * 1024 * 1024 } : limits;
  const mainPaths = result.repositoryImpact?.paths ?? [];
  const allPaths = [...mainPaths, ...(options.archive ? result.repositoryImpact?.overflowPaths ?? [] : [])];
  const blocks = new Map(result.repositoryIndex?.blocks.map(block => [block.file, block]));
  const priority = (entry: typeof allPaths[number]): number => entry.endpoint === "test-reference"
    ? blocks.get(entry.evidence[0]?.file ?? "")?.kind === "source" ? 2 : 1
    : 0;
  const groupCounts = new Map<string, number>();
  const pairKeys = new Set<string>();
  const paths = allPaths.flatMap((entry, index) => {
    const key = JSON.stringify([entry.changedFile, entry.changedSymbol, entry.endpoint,
      entry.evidence.filter((step, i) => i === 0 || i === entry.evidence.length - 1 || step.relation === "reference")]);
    if (!options.archive && pairKeys.has(key)) return [];
    pairKeys.add(key);
    const group = JSON.stringify([entry.changedFile, entry.changedSymbol, priority(entry)]);
    const round = groupCounts.get(group) ?? 0;
    groupCounts.set(group, round + 1);
    return [{ entry, index, round }];
  }).sort((a, b) => priority(b.entry) - priority(a.entry) || a.round - b.round);
  const skipped: DiscoveryGap[] = [];
  const read = createRepositoryTextReader(result.analysisScope.workspaceRoot, skipped, 300_000);
  const texts = new Map<string, string | undefined>();
  const expectations = new Map<string, ReturnType<typeof createTestExpectationReader>>();
  const statements = new Map<string, ts.SourceFile>();
  const moduleLocations = new Set<string>();
  const gapRank = (reason: string): number => reason === "node-builtin-outside-repository" ? 3
    : reason === "compiled-output-not-verified" ? 2 : reason === "index-excluded-module" ? 1 : 0;
  const gaps: EvidenceGap[] = (result.repositoryImpact?.boundaries ?? []).map((gap, index) => ({ gap, index }))
    .sort((a, b) => gapRank(a.gap.reason) - gapRank(b.gap.reason)
      || Number(blocks.get(b.gap.file)?.kind === "source") - Number(blocks.get(a.gap.file)?.kind === "source"))
    .filter(({ gap }) => {
      if (options.archive) return true;
      if (!gap.module || !Number.isSafeInteger(gap.line) || gap.line! < 1) return true;
      const key = JSON.stringify([gap.file, gap.line, gap.module, gap.reason, gap.target]);
      if (moduleLocations.has(key)) return false;
      moduleLocations.add(key);
      return true;
    })
    .slice(0, options.archive ? undefined : 8)
    .map(({ gap, index }) => ({ file: safeFile(gap.file) ? gap.file : "<unsupported-path>", reason: gap.reason,
      ...(Number.isSafeInteger(gap.line) && gap.line! > 0 ? { line: gap.line } : {}),
      ...(gap.symbol && safeSymbol(gap.symbol) ? { symbol: gap.symbol } : {}),
      ...(gap.module && safeModule(gap.module) ? { module: gap.module } : {}),
      ...(gap.target && safeFile(gap.target) ? { target: gap.target } : {}),
      pointer: `/repositoryImpact/boundaries/${index}` }));
  const evidence: ReviewEvidence = {
    pathBase: "workspace-root", basis: "indexed-working-tree", authority: "inferred-draft", complete: false,
    pathCount: allPaths.length, omittedPathCount: allPaths.length
      + (options.archive ? result.repositoryImpact?.discardedPaths ?? result.repositoryImpact?.omittedPaths ?? 0 : result.repositoryImpact?.omittedPaths ?? 0),
    paths: [], gaps, omittedGapCount: Math.max(0, (result.repositoryImpact?.boundaries.length ?? 0) - gaps.length), limits: evidenceLimits,
  };
  const gap = (file: string, reason: string): void => {
    if (options.archive || gaps.length < 8) gaps.push({ file: safeFile(file) ? file : "<unsupported-path>", reason });
    else evidence.omittedGapCount++;
  };
  const excerpt = async (step: ImpactStep, window = 7, bindings: ImpactStep[] = []): Promise<SourceExcerpt> => {
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
    let anchors = [step.line];
    if (step.changedLine !== undefined || step.changedLines !== undefined) {
      const declaration = block.declarations.find(entry => entry.name === step.symbol && entry.line === step.line);
      const candidates = step.changedLines ?? [step.changedLine!];
      if (step.relation === "changed-declaration" && candidates.length > 0 && declaration
        && candidates[0] === step.changedLine
        && candidates.every(line => Number.isSafeInteger(line) && line >= declaration.line
          && line <= declaration.endLine && line <= lines.length)) {
        const unique = [...new Set(candidates)].sort((a, b) => a - b);
        anchors = unique.slice(0, evidenceLimits.excerptLines);
        ref.changedLine = anchors[0];
        if (anchors.length > 1) ref.changedLines = anchors;
        if (unique.length > anchors.length) {
          ref.omittedChangedLineCount = unique.length - anchors.length;
          gap(step.file, "changed-line-limit");
        }
      } else gap(step.file, "invalid-changed-line");
    }
    if (step.deletionLines !== undefined) {
      const declaration = block.declarations.find(entry => entry.name === step.symbol && entry.line === step.line);
      if (step.relation === "changed-declaration" && declaration && step.deletionLines.length
        && step.deletionLines.every(line => Number.isSafeInteger(line) && line > declaration.line && line <= declaration.endLine && line <= lines.length)) {
        ref.deletionLines = [...new Set(step.deletionLines)].sort((a, b) => a - b);
        anchors = step.changedLine === undefined ? ref.deletionLines : [...new Set([...anchors, ...ref.deletionLines])];
      } else gap(step.file, "invalid-deletion-line");
    }
    if (step.relation === "test-reference" && block.kind === "test") {
      if (!expectations.has(step.file)) expectations.set(step.file, createTestExpectationReader(step.file, text));
      const assertions = expectations.get(step.file)!(step.line, step.symbol);
      if (assertions.length) anchors = [...new Set([...anchors, ...assertions])].sort((a, b) => a - b);
      else gap(step.file, "test-expectation-not-linked");
    }
    if (anchors.length > evidenceLimits.excerptLines) gap(step.file, "required-line-limit");
    anchors = anchors.slice(0, evidenceLimits.excerptLines);
    if (step.deletionLines || (step.relation === "test-reference" && (anchors.length > 1 || anchors[0] !== step.line))) ref.anchorLines = anchors;
    // Preserve an interpretable unit, not just a changed return or an assertion.
    const context = new Set<number>();
    const declaration = block.declarations.find(entry => entry.name === step.symbol
      && entry.line <= step.line && entry.endLine >= step.line);
    if (declaration && ["changed-declaration", "reference", "export", "runtime-module-candidate"].includes(step.relation)) {
      context.add(declaration.line);
      if (declaration.endLine - declaration.line < evidenceLimits.excerptLines) {
        for (let line = declaration.line; line <= declaration.endLine; line++) context.add(line);
      } else gap(step.file, "declaration-context-partial");
    }
    if (bindings.length) {
      if (!statements.has(step.file)) statements.set(step.file, ts.createSourceFile(step.file, text, ts.ScriptTarget.Latest, true));
      const syntax = statements.get(step.file)!;
      for (const binding of bindings) {
        const statement = syntax.statements.find(item => syntax.getLineAndCharacterOfPosition(item.getStart(syntax)).line + 1 === binding.line);
        if (!statement) { gap(step.file, "binding-context-unavailable"); continue; }
        const end = ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
          ? syntax.getLineAndCharacterOfPosition(statement.end).line + 1 : binding.line;
        for (let line = binding.line; line <= end; line++) context.add(line);
      }
    }
    if (context.size) ref.contextLines = [...context].sort((a, b) => a - b);
    let required = [...new Set([...anchors, ...context])];
    if (required.length > evidenceLimits.excerptLines) {
      gap(step.file, "review-context-line-limit");
      required = required.slice(0, evidenceLimits.excerptLines);
      ref.contextLines = ref.contextLines?.filter(line => required.includes(line));
    }
    // Reserve every changed region before filling nearby context in round-robin order.
    const selected = new Set(required);
    for (let offset = -1; offset < window - 1; offset++) for (const anchor of anchors) {
      const line = anchor + offset;
      if (line > 0 && line <= lines.length && selected.size < evidenceLimits.excerptLines) selected.add(line);
    }
    let numbered = [...selected].sort((a, b) => a - b).map(line => ({ line, text: lines[line - 1] }));
    if (isInstructionLikeRepositoryText(numbered.map(item => item.text).join("\n"))) {
      gap(step.file, "instruction-like-source"); return ref;
    }
    if (Buffer.byteLength(JSON.stringify(numbered)) > evidenceLimits.excerptBytes) {
      numbered = numbered.filter(item => required.includes(item.line));
    }
    if (Buffer.byteLength(JSON.stringify(numbered)) > evidenceLimits.excerptBytes) {
      numbered = numbered.filter(item => anchors.includes(item.line));
      delete ref.contextLines;
      if (Buffer.byteLength(JSON.stringify(numbered)) > evidenceLimits.excerptBytes) {
        gap(step.file, "excerpt-byte-limit"); return { ...ref, truncated: true };
      }
      gap(step.file, "review-context-byte-limit");
    }
    return { ...ref, sourceHash: block.hash, lines: numbered,
      truncated: numbered.length < lines.length };
  };
  for (const { entry, index } of paths) {
    if (evidence.paths.length >= evidenceLimits.paths) break;
    const source = entry.evidence[0];
    const contract = entry.evidence.at(-1);
    if (!source || !contract) { gap(entry.changedFile, "missing-path-endpoint"); continue; }
    const kind = blocks.get(source.file)?.kind;
    const via: SourceExcerpt[] = [];
    const bindings = entry.evidence.filter(step => ["import", "reexport", "export"].includes(step.relation));
    const forFile = (file: string): ImpactStep[] => bindings.filter(step => step.file === file);
    const coveredFiles = new Set([source.file, contract.file, ...entry.evidence.filter(step => step.relation === "reference").map(step => step.file)]);
    const locations = new Set([JSON.stringify([source.file, source.line]), JSON.stringify([contract.file, contract.line])]);
    for (const step of entry.evidence.slice(1, -1)) {
      const location = JSON.stringify([step.file, step.line]);
      if (locations.has(location) || step.relation !== "reference" && step.relation !== "runtime-module-candidate"
        && (!bindings.includes(step) || coveredFiles.has(step.file))) continue;
      locations.add(location);
      via.push(await excerpt(step, 3, forFile(step.file)));
      coveredFiles.add(step.file);
    }
    evidence.paths.push({ pointer: index < mainPaths.length ? `/repositoryImpact/paths/${index}`
      : `/repositoryImpact/overflowPaths/${index - mainPaths.length}`, endpoint: entry.endpoint,
      sourceKind: kind === "source" || kind === "test" ? kind : "unknown",
      source: await excerpt(source, 7, forFile(source.file)), contract: await excerpt(contract, 7, forFile(contract.file)), ...(via.length ? { via } : {}) });
    evidence.omittedPathCount--;
  }
  deduplicateExcerpts(evidence);
  // Keep complete endpoint pairs together; truncation must never silently become no impact.
  if (!options.archive) trimEvidence(evidence, () => Buffer.byteLength(JSON.stringify(evidence)) > limits.evidenceBytes);
  else if (Buffer.byteLength(JSON.stringify(evidence)) > evidenceLimits.evidenceBytes) {
    throw new Error("Review evidence archive exceeds 64 MiB; analyze a smaller change range.");
  }
  return evidence;
}

export async function buildLocalQaHandoff(
  result: QaDraftResult,
  receipt: LocalQaReportReceipt,
  summary: Record<string, unknown>,
  evidenceArchive?: EvidenceArchive,
  inlineReview?: PackedReviewText,
): Promise<LocalQaHandoffReceipt> {
  const handoff: LocalQaHandoffReceipt = {
    ...receipt,
    schema: { name: "qamap.qa.handoff", version: 1 },
    usage: { analysisLlmCalls: 0, callerTokens: "not-measured" },
    summary,
    reviewEvidence: await collectReviewEvidence(result),
    ...(evidenceArchive ? { evidenceArchive: { ...evidenceArchive } } : {}),
    recovery: {
      repository: ["/repositoryIndex", "/repositoryImpact"],
      testContracts: ["/testContracts/items"],
      traces: ["/evidence/traces"],
      action: ["/action"],
      scope: ["/evidence/base", "/evidence/head", "/evidence/includeWorkingTree", "/analysisScope"],
    },
  };
  const oversized = (): boolean => Buffer.byteLength(JSON.stringify(handoff)) + 1 > limits.responseBytes;
  if (oversized()) {
    const omitted = new Set(["project", "runner", "manifest", "context", "capabilities", "readiness", "scenarioCoverage",
      "evidenceSummary", "traceCount", "omittedTraceCount", "traces", "testSuite", "testContracts", "intentCount", "omittedIntentCount",
      "intents", "automation", "flowCount", "omittedFlowCount", "flows", "requiredEvidence", "recommendedEvidenceCount",
      "requiredBootstrap", "prChecklist", "commands", "repository", "compaction", "manifestCorrection"]);
    const compact = { ...Object.fromEntries(Object.entries(summary).filter(([key]) => !omitted.has(key))),
      compaction: { mode: "review-evidence-first", omittedFieldCount: Object.keys(summary).filter(key => omitted.has(key)).length,
        fullReport: receipt.files.full } };
    if (Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(summary))) handoff.summary = compact;
  }
  trimEvidence(handoff.reviewEvidence, oversized, new Map(result.repositoryIndex?.blocks.map(block => [block.file, block.hash])));
  if (handoff.evidenceArchive) handoff.evidenceArchive.required = handoff.reviewEvidence.omittedPathCount > 0
    || handoff.reviewEvidence.omittedGapCount > 0 || handoff.reviewEvidence.gaps.some(gap =>
      /(?:limit|partial|unavailable|source-changed|unreadable|instruction-like)/.test(gap.reason));
  if (handoff.evidenceArchive?.required && handoff.evidenceArchive.pathCount > limits.paths && inlineReview) {
    // The complete text view replaces the insufficient preview, not its evidence.
    const inline = { ...handoff, inlineReview,
      reviewEvidence: { ...handoff.reviewEvidence, paths: [], gaps: [],
        omittedPathCount: handoff.reviewEvidence.omittedPathCount + handoff.reviewEvidence.paths.length,
        omittedGapCount: handoff.reviewEvidence.omittedGapCount + handoff.reviewEvidence.gaps.length },
      evidenceArchive: { ...handoff.evidenceArchive, required: false } };
    delete inline.reviewEvidence.sourceDigest;
    if (Buffer.byteLength(JSON.stringify(inline)) + 1 <= limits.responseBytes) return inline;
    // A complete inline view can cost less than the preview plus multiple reads.
    // Do not expand the ordinary preview or paged-reader limits with it.
    inline.reviewEvidence.limits = { ...inline.reviewEvidence.limits, responseBytes: inlineResponseBytes };
    if (Buffer.byteLength(JSON.stringify(inline)) + 1 <= inlineResponseBytes) return inline;
  }
  if (oversized()) throw new Error("QA handoff exceeds its output limit; use a shorter report output path.");
  return handoff;
}

function trimEvidence(evidence: ReviewEvidence, oversized: () => boolean, hashes = new Map<string, string>()): void {
  const excerpts = (): SourceExcerpt[] => evidence.paths.flatMap(entry => [entry.source, entry.contract, ...(entry.via ?? [])]);
  for (const excerpt of excerpts()) if (excerpt.sourceHash) hashes.set(excerpt.file, excerpt.sourceHash);
  const digest = (): void => {
    const files = [...new Set(excerpts().filter(excerpt => excerpt.lines).map(excerpt => excerpt.file))].sort();
    if (!files.length) { delete evidence.sourceDigest; return; }
    if (files.some(file => !hashes.has(file))) return;
    const value = createHash("sha256").update(JSON.stringify(files.map(file => [file, hashes.get(file)]))).digest("hex");
    evidence.sourceDigest = { algorithm: "sha256", fileCount: files.length, value };
    for (const excerpt of excerpts()) delete excerpt.sourceHash;
  };
  if (excerpts().filter(excerpt => excerpt.sourceHash).length > 8) digest();
  // Remove context, not changed lines or call sites, before discarding an entire path.
  const context = evidence.paths.flatMap(entry => [entry.source, entry.contract, ...(entry.via ?? [])])
    .flatMap(excerpt => {
      const anchors = [...(excerpt.anchorLines ?? excerpt.changedLines ?? [excerpt.changedLine ?? excerpt.line]), ...(excerpt.contextLines ?? [])];
      return (excerpt.lines ?? []).filter(item => !anchors.includes(item.line)).map(item => ({ excerpt, item,
        distance: Math.min(...anchors.map(line => Math.abs(line - item.line))),
        empty: /^[\s{}();]*$/.test(item.text) }));
    }).sort((a, b) => Number(b.empty) - Number(a.empty) || b.distance - a.distance);
  for (const { excerpt, item } of context) {
    if (!oversized()) break;
    excerpt.lines = excerpt.lines!.filter(line => line !== item);
    excerpt.truncated = true;
  }
  // One digest binds the same full-file identities without repeating opaque hashes.
  if (oversized() && excerpts().filter(excerpt => excerpt.sourceHash).length > 1) digest();
  // Preserve one concrete uncertainty alongside the leading path when both fit.
  while (oversized() && evidence.gaps.length > 1) { evidence.gaps.pop(); evidence.omittedGapCount++; }
  const removePath = (): void => {
    evidence.paths.pop(); evidence.omittedPathCount++;
    if (evidence.sourceDigest) digest();
  };
  while (oversized() && evidence.paths.length > 1) removePath();
  while (oversized() && evidence.gaps.length) { evidence.gaps.pop(); evidence.omittedGapCount++; }
  while (oversized() && evidence.paths.length) removePath();
}

function deduplicateExcerpts(evidence: ReviewEvidence): void {
  const seen = new Map<string, string>();
  evidence.paths.forEach((entry, index) => {
    const items: Array<[string, SourceExcerpt]> = [["source", entry.source], ["contract", entry.contract],
      ...(entry.via ?? []).map((excerpt, i): [string, SourceExcerpt] => [`via/${i}`, excerpt])];
    for (const [field, excerpt] of items) {
      if (!excerpt.lines) continue;
      const key = JSON.stringify(excerpt);
      const previous = seen.get(key);
      if (!previous) { seen.set(key, `/reviewEvidence/paths/${index}/${field}`); continue; }
      // References only point backward. Removing trailing paths cannot orphan them.
      delete excerpt.lines;
      delete excerpt.sourceHash;
      delete excerpt.truncated;
      excerpt.excerptRef = previous;
    }
  });
}

function safeFile(file: string): boolean {
  return file.length > 0 && Buffer.byteLength(file) <= 512 && !/[\\\x00-\x1f\x7f-\x9f]/.test(file)
    && !file.split("/").some(part => !part || part === "." || part === "..");
}
