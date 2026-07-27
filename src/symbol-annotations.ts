import { promises as fs } from "node:fs";
import path from "node:path";
import { readFileAtRef } from "./git-context.js";
import type { AddedDiffEvidence, AddedDiffHunk, TestPlanChangedFile } from "./test-plan.js";

export const qaSymbolAnnotationTags = [
  "@qamapFlow",
  "@qamapStage",
  "@qamapOutcome",
  "@qamapRisk",
] as const;

export const qaSymbolStageKinds = [
  "trigger",
  "condition",
  "action",
  "state-change",
  "side-effect",
  "observable-outcome",
] as const;

export type QaSymbolAnnotationTag = (typeof qaSymbolAnnotationTags)[number];
export type QaSymbolStageKind = (typeof qaSymbolStageKinds)[number];
export type QaSymbolDeclarationKind =
  | "class"
  | "const"
  | "enum"
  | "function"
  | "interface"
  | "let"
  | "type"
  | "var";
export type QaSymbolAnnotationDiagnosticSeverity = "info" | "warning";
export type QaSymbolAnnotationDiagnosticCode =
  | "invalid-flow"
  | "invalid-stage"
  | "missing-value"
  | "source-too-large"
  | "unattached"
  | "unknown-tag";

export interface QaSymbolAnnotationValue {
  value: string;
  line: number;
}

export interface QaSymbolStageAnnotation extends QaSymbolAnnotationValue {
  kind: QaSymbolStageKind;
  label?: string;
}

export interface QaSymbolAnnotation {
  file: string;
  symbol: string;
  declarationKind: QaSymbolDeclarationKind;
  declarationStartLine: number;
  declarationEndLine: number;
  commentStartLine: number;
  commentEndLine: number;
  flows: QaSymbolAnnotationValue[];
  stages: QaSymbolStageAnnotation[];
  outcomes: QaSymbolAnnotationValue[];
  risks: QaSymbolAnnotationValue[];
}

export interface ChangedQaSymbolAnnotation extends QaSymbolAnnotation {
  changedLine: number;
  previousFile?: string;
  hunkHeader?: string;
}

export interface QaSymbolAnnotationDiagnostic {
  severity: QaSymbolAnnotationDiagnosticSeverity;
  code: QaSymbolAnnotationDiagnosticCode;
  file: string;
  line: number;
  message: string;
}

export interface QaSymbolAnnotationParseResult {
  annotations: QaSymbolAnnotation[];
  diagnostics: QaSymbolAnnotationDiagnostic[];
}

export interface ChangedQaSymbolAnnotationResult {
  annotations: ChangedQaSymbolAnnotation[];
  diagnostics: QaSymbolAnnotationDiagnostic[];
}

export interface CollectChangedQaSymbolAnnotationsOptions {
  head: string;
  workspaceRoot?: string;
  includeWorkingTree?: boolean;
  changedFiles: TestPlanChangedFile[];
  addedDiffEvidence: AddedDiffEvidence;
}

interface ParsedTag {
  name: string;
  value: string;
  line: number;
}

interface AttachedDeclaration {
  kind: QaSymbolDeclarationKind;
  symbol: string;
  start: number;
  end: number;
}

const supportedExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const knownTags = new Set<string>(qaSymbolAnnotationTags);
const maxSourceBytes = 500_000;
const maxDeclarationScanBytes = 100_000;
const flowIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const declarationMatcher =
  /^export\s+(?:default\s+)?(?:(?:declare|abstract)\s+)*(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;
const stageAliases: Record<string, QaSymbolStageKind | undefined> = {
  action: "action",
  condition: "condition",
  effect: "side-effect",
  outcome: "observable-outcome",
  "observable-outcome": "observable-outcome",
  sideeffect: "side-effect",
  "side-effect": "side-effect",
  state: "state-change",
  "state-change": "state-change",
  transition: "state-change",
  trigger: "trigger",
};

export async function collectChangedQaSymbolAnnotations(
  rootInput: string,
  options: CollectChangedQaSymbolAnnotationsOptions,
): Promise<ChangedQaSymbolAnnotationResult> {
  const root = path.resolve(rootInput);
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  const gitRoot = workspaceRoot ?? root;
  const relativeRoot = workspaceRoot ? toPosixPath(path.relative(workspaceRoot, root)) : "";
  if (workspaceRoot && (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot))) {
    throw new Error(`QAMap symbol annotation path must be inside workspace root: ${root}`);
  }

  const annotations: ChangedQaSymbolAnnotation[] = [];
  const diagnostics: QaSymbolAnnotationDiagnostic[] = [];
  for (const changedFile of options.changedFiles) {
    const file = toPosixPath(changedFile.path);
    if (changedFile.status === "D" || !supportedExtensions.has(path.posix.extname(file))) {
      continue;
    }
    const text = await readHeadSource(root, gitRoot, relativeRoot, file, options);
    if (text === undefined) {
      continue;
    }
    if (Buffer.byteLength(text, "utf8") > maxSourceBytes) {
      diagnostics.push({
        severity: "info",
        code: "source-too-large",
        file,
        line: 1,
        message: `Skipped QAMap symbol annotations because the source exceeds ${maxSourceBytes} bytes.`,
      });
      continue;
    }

    const parsed = parseQaSymbolAnnotations(file, text);
    diagnostics.push(...parsed.diagnostics);
    const hunks = options.addedDiffEvidence[file] ?? [];
    for (const annotation of parsed.annotations) {
      const changed = locateChangedDeclaration(annotation, hunks);
      if (!changed) {
        continue;
      }
      annotations.push({
        ...annotation,
        changedLine: changed.line,
        previousFile: changed.hunk.previousFile,
        hunkHeader: changed.hunk.hunkHeader,
      });
    }
  }

  return {
    annotations,
    diagnostics: uniqueDiagnostics(diagnostics),
  };
}

export function parseQaSymbolAnnotations(
  fileInput: string,
  text: string,
): QaSymbolAnnotationParseResult {
  const file = toPosixPath(fileInput);
  const annotations: QaSymbolAnnotation[] = [];
  const diagnostics: QaSymbolAnnotationDiagnostic[] = [];
  const lineStarts = collectLineStarts(text);
  const matcher = /\/\*\*[\s\S]*?\*\//g;

  for (const comment of text.matchAll(matcher)) {
    const commentText = comment[0];
    const commentStart = comment.index ?? 0;
    const commentEnd = commentStart + commentText.length;
    const commentStartLine = lineNumberAt(lineStarts, commentStart);
    const commentEndLine = lineNumberAt(lineStarts, Math.max(commentStart, commentEnd - 1));
    const tags = parseTags(commentText, commentStartLine);
    const qamapTags = tags.filter((tag) => tag.name.startsWith("@qamap"));
    if (qamapTags.length === 0) {
      continue;
    }

    const declaration = findAttachedDeclaration(text, commentEnd);
    for (const tag of qamapTags.filter((tag) => !knownTags.has(tag.name))) {
      diagnostics.push({
        severity: "warning",
        code: "unknown-tag",
        file,
        line: tag.line,
        message: `Unknown QAMap symbol annotation ${tag.name}; supported tags are ${qaSymbolAnnotationTags.join(", ")}.`,
      });
    }
    if (!declaration) {
      diagnostics.push({
        severity: "warning",
        code: "unattached",
        file,
        line: commentStartLine,
        message: "QAMap symbol annotations must be immediately followed by a named exported declaration.",
      });
      continue;
    }

    const flows: QaSymbolAnnotationValue[] = [];
    const stages: QaSymbolStageAnnotation[] = [];
    const outcomes: QaSymbolAnnotationValue[] = [];
    const risks: QaSymbolAnnotationValue[] = [];
    for (const tag of qamapTags.filter((candidate) => knownTags.has(candidate.name))) {
      if (!tag.value) {
        diagnostics.push({
          severity: "warning",
          code: "missing-value",
          file,
          line: tag.line,
          message: `${tag.name} requires a value.`,
        });
        continue;
      }
      if (tag.name === "@qamapFlow") {
        if (!flowIdPattern.test(tag.value)) {
          diagnostics.push({
            severity: "warning",
            code: "invalid-flow",
            file,
            line: tag.line,
            message: "@qamapFlow must use a stable ID containing only letters, numbers, dots, colons, slashes, underscores, or hyphens.",
          });
          continue;
        }
        flows.push({ value: tag.value, line: tag.line });
        continue;
      }
      if (tag.name === "@qamapStage") {
        const [rawKind = "", ...labelParts] = tag.value.split(/\s+/);
        const kind = stageAliases[rawKind.toLowerCase()];
        if (!kind) {
          diagnostics.push({
            severity: "warning",
            code: "invalid-stage",
            file,
            line: tag.line,
            message: `@qamapStage must begin with ${qaSymbolStageKinds.join(", ")}.`,
          });
          continue;
        }
        const label = labelParts.join(" ").trim();
        stages.push({
          kind,
          value: tag.value,
          label: label || undefined,
          line: tag.line,
        });
        continue;
      }
      if (tag.name === "@qamapOutcome") {
        outcomes.push({ value: tag.value, line: tag.line });
        continue;
      }
      risks.push({ value: tag.value, line: tag.line });
    }

    if (flows.length + stages.length + outcomes.length + risks.length === 0) {
      continue;
    }
    annotations.push({
      file,
      symbol: declaration.symbol,
      declarationKind: declaration.kind,
      declarationStartLine: lineNumberAt(lineStarts, declaration.start),
      declarationEndLine: lineNumberAt(lineStarts, Math.max(declaration.start, declaration.end - 1)),
      commentStartLine,
      commentEndLine,
      flows: uniqueValues(flows),
      stages: uniqueStages(stages),
      outcomes: uniqueValues(outcomes),
      risks: uniqueValues(risks),
    });
  }

  return {
    annotations,
    diagnostics: uniqueDiagnostics(diagnostics),
  };
}

export function formatQaSymbolAnnotationDiagnostic(
  diagnostic: QaSymbolAnnotationDiagnostic,
): string {
  return `${diagnostic.file}:${diagnostic.line} [symbol-annotation/${diagnostic.code}] ${diagnostic.message}`;
}

async function readHeadSource(
  root: string,
  gitRoot: string,
  relativeRoot: string,
  file: string,
  options: CollectChangedQaSymbolAnnotationsOptions,
): Promise<string | undefined> {
  if (options.includeWorkingTree) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    try {
      return await fs.readFile(absolute, "utf8");
    } catch {
      return undefined;
    }
  }
  const gitPath = relativeRoot ? path.posix.join(relativeRoot, file) : file;
  return readFileAtRef(gitRoot, options.head, gitPath);
}

function parseTags(commentText: string, commentStartLine: number): ParsedTag[] {
  const body = commentText.slice(3, -2);
  const lines = body.split(/\r?\n/);
  const tags: ParsedTag[] = [];
  let current: ParsedTag | undefined;

  const flush = (): void => {
    if (!current) return;
    tags.push({ ...current, value: current.value.replace(/\s+/g, " ").trim() });
    current = undefined;
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.replace(/^\s*\*\s?/, "").trimEnd();
    const tagMatch = line.match(/^(@[A-Za-z][A-Za-z0-9]*)(?:\s+([\s\S]*))?$/);
    if (tagMatch) {
      flush();
      current = {
        name: tagMatch[1],
        value: tagMatch[2]?.trim() ?? "",
        line: commentStartLine + index,
      };
      return;
    }
    if (current && line.trim()) {
      current.value = `${current.value} ${line.trim()}`.trim();
    }
  });
  flush();
  return tags;
}

function findAttachedDeclaration(text: string, commentEnd: number): AttachedDeclaration | undefined {
  const declarationStart = skipWhitespaceAndDecorators(text, commentEnd);
  const match = text.slice(declarationStart, declarationStart + 500).match(declarationMatcher);
  if (!match) {
    return undefined;
  }
  const kind = match[1] as QaSymbolDeclarationKind;
  const symbol = match[2];
  const end = findDeclarationEnd(text, declarationStart, declarationStart + match[0].length, kind);
  return {
    kind,
    symbol,
    start: declarationStart,
    end,
  };
}

function skipWhitespaceAndDecorators(text: string, start: number): number {
  let cursor = skipWhitespace(text, start);
  while (text[cursor] === "@") {
    let parenthesisDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let quote: "'" | "\"" | "`" | undefined;
    let escaped = false;
    for (; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = undefined;
        }
        continue;
      }
      if (char === "'" || char === "\"" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") parenthesisDepth += 1;
      if (char === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      if (char === "[") bracketDepth += 1;
      if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      if (char === "{") braceDepth += 1;
      if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
      if ((char === "\n" || char === "\r") && parenthesisDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        cursor += 1;
        break;
      }
    }
    cursor = skipWhitespace(text, cursor);
  }
  return cursor;
}

function findDeclarationEnd(
  text: string,
  declarationStart: number,
  scanStart: number,
  kind: QaSymbolDeclarationKind,
): number {
  const scanLimit = Math.min(text.length, declarationStart + maxDeclarationScanBytes);
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let bodyDepth: number | undefined;
  let quote: "'" | "\"" | "`" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const bodyDeclaration = kind === "function" || kind === "class" || kind === "interface" || kind === "enum";

  for (let index = scanStart; index < scanLimit; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n" || char === "\r") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") parenthesisDepth += 1;
    if (char === ")") parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (char === "{") {
      braceDepth += 1;
      if (bodyDeclaration && bodyDepth === undefined && parenthesisDepth === 0 && bracketDepth === 0) {
        bodyDepth = braceDepth;
      }
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      if (bodyDepth !== undefined && braceDepth < bodyDepth) {
        const nextToken = skipWhitespace(text, index + 1);
        if (kind === "function" && text[nextToken] === "{") {
          bodyDepth = undefined;
          continue;
        }
        return index + 1;
      }
      continue;
    }
    if (
      char === ";" &&
      parenthesisDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      return index + 1;
    }
  }
  return scanLimit;
}

function locateChangedDeclaration(
  annotation: QaSymbolAnnotation,
  hunks: AddedDiffHunk[],
): { line: number; hunk: AddedDiffHunk } | undefined {
  for (const hunk of hunks) {
    const changedLine = hunk.lines.find((line) =>
      line.line >= annotation.declarationStartLine && line.line <= annotation.declarationEndLine
    );
    if (changedLine) {
      return { line: changedLine.line, hunk };
    }
    if (
      hunk.lines.length === 0 &&
      hunk.startLine >= annotation.declarationStartLine &&
      hunk.startLine <= annotation.declarationEndLine
    ) {
      return { line: hunk.startLine, hunk };
    }
  }
  return undefined;
}

function collectLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineNumberAt(starts: number[], index: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return Math.max(1, low);
}

function skipWhitespace(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function uniqueValues(values: QaSymbolAnnotationValue[]): QaSymbolAnnotationValue[] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = item.value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStages(values: QaSymbolStageAnnotation[]): QaSymbolStageAnnotation[] {
  const seen = new Set<string>();
  return values.filter((item) => {
    const key = `${item.kind}:${item.label?.toLowerCase() ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueDiagnostics(
  diagnostics: QaSymbolAnnotationDiagnostic[],
): QaSymbolAnnotationDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.file}:${diagnostic.line}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
