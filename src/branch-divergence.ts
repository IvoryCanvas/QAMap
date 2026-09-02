import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ChangeIntent,
  ChangeIntentCommit,
  ChangeIntentEvidence,
  IntentQaScenario,
} from "./change-intent.js";
import { resolveMergeBase } from "./git-context.js";
import { classifyChangeSourceRole } from "./source-role.js";
import { collectAddedDiffEvidence } from "./test-plan.js";
import type { AddedDiffEvidence, AddedDiffHunk } from "./test-plan.js";

const execFileAsync = promisify(execFile);
const maxOverlappingFiles = 12;
const behaviorRoles = new Set(["product", "command", "analysis-rule"]);

interface BranchCommitRecord {
  sha: string;
  subject: string;
  files: string[];
}

export interface BranchDivergenceOptions {
  root: string;
  workspaceRoot?: string;
  base: string;
  head: string;
}

export interface BranchDivergenceAnalysis {
  mergeBase?: string;
  intents: ChangeIntent[];
  diagnostics: string[];
}

export async function analyzeBranchDivergence(
  options: BranchDivergenceOptions,
): Promise<BranchDivergenceAnalysis> {
  const root = path.resolve(options.root);
  const gitRoot = path.resolve(options.workspaceRoot ?? root);
  const scopePrefix = options.workspaceRoot
    ? toPosixPath(path.relative(gitRoot, root)).replace(/^\.\/+|\/+$/g, "")
    : "";

  try {
    const [baseSha, headSha, mergeBase] = await Promise.all([
      resolveCommit(gitRoot, options.base),
      resolveCommit(gitRoot, options.head),
      resolveMergeBase(gitRoot, options.base, options.head),
    ]);
    if (baseSha === headSha || baseSha === mergeBase || headSha === mergeBase) {
      return { mergeBase, intents: [], diagnostics: [] };
    }

    const targetOnlyShas = await collectNonEquivalentTargetCommits(
      gitRoot,
      options.head,
      options.base,
    );
    if (targetOnlyShas.size === 0) {
      return { mergeBase, intents: [], diagnostics: [] };
    }

    const [
      targetRecords,
      proposedRecords,
      endpointDifferences,
      targetDiffEvidence,
      proposedDiffEvidence,
    ] = await Promise.all([
      collectCommitRecords(gitRoot, `${mergeBase}..${baseSha}`, scopePrefix),
      collectCommitRecords(gitRoot, `${mergeBase}..${headSha}`, scopePrefix),
      collectChangedPaths(gitRoot, baseSha, headSha, scopePrefix),
      collectAddedDiffEvidence(root, {
        base: mergeBase,
        head: baseSha,
        workspaceRoot: options.workspaceRoot,
      }),
      collectAddedDiffEvidence(root, {
        base: mergeBase,
        head: headSha,
        workspaceRoot: options.workspaceRoot,
      }),
    ]);
    const targetOnlyRecords = targetRecords.filter((record) => targetOnlyShas.has(record.sha));
    if (targetOnlyRecords.length === 0 || proposedRecords.length === 0) {
      return { mergeBase, intents: [], diagnostics: [] };
    }

    const targetFiles = filesByCommit(targetOnlyRecords, scopePrefix);
    const proposedFiles = filesByCommit(proposedRecords, scopePrefix);
    const differingFiles = new Set(
      endpointDifferences
        .map((file) => toScopedPath(file, scopePrefix))
        .filter((file): file is string => Boolean(file)),
    );
    const overlappingFiles = [...targetFiles.keys()]
      .filter((file) => proposedFiles.has(file) && differingFiles.has(file))
      .filter((file) => behaviorRoles.has(classifyChangeSourceRole(file).role))
      .sort();
    const selectedFiles = overlappingFiles.slice(0, maxOverlappingFiles);
    const intents = selectedFiles.map((file) => buildDivergenceIntent(
      file,
      targetFiles.get(file) ?? [],
      proposedFiles.get(file) ?? [],
      mergeBase,
      targetDiffEvidence,
      proposedDiffEvidence,
    ));
    const diagnostics = intents.length === 0
      ? []
      : [
          `Detected ${intents.length} behavior-bearing file${intents.length === 1 ? "" : "s"} with non-equivalent target-only and proposed-branch changes after merge base ${shortSha(mergeBase)}.`,
          ...(overlappingFiles.length > selectedFiles.length
            ? [`Omitted ${overlappingFiles.length - selectedFiles.length} additional overlapping files from branch-divergence intents.`]
            : []),
        ];
    return { mergeBase, intents, diagnostics };
  } catch {
    return {
      intents: [],
      diagnostics: ["Branch divergence analysis was unavailable for the selected Git refs."],
    };
  }
}

function buildDivergenceIntent(
  file: string,
  targetRecords: BranchCommitRecord[],
  proposedRecords: BranchCommitRecord[],
  mergeBase: string,
  targetDiffEvidence: AddedDiffEvidence,
  proposedDiffEvidence: AddedDiffEvidence,
): ChangeIntent {
  const sourceRole = classifyChangeSourceRole(file).role;
  const targetLineEvidence = locatedBranchEvidence(
    file,
    targetDiffEvidence[file] ?? [],
    "base",
    targetRecords[0]?.sha,
    "Target-only",
    sourceRole,
  );
  const proposedLineEvidence = locatedBranchEvidence(
    file,
    proposedDiffEvidence[file] ?? [],
    "head",
    proposedRecords[0]?.sha,
    "Proposed-branch",
    sourceRole,
  );
  const targetEvidence = targetRecords.map((record): ChangeIntentEvidence => ({
    kind: "commit",
    value: `Target-only commit ${shortSha(record.sha)}: ${record.subject}`,
    sourceRole,
    commit: record.sha,
    file,
    relation: "direct",
    side: "base",
  }));
  const proposedEvidence = proposedRecords.map((record): ChangeIntentEvidence => ({
    kind: "commit",
    value: `Proposed-branch commit ${shortSha(record.sha)}: ${record.subject}`,
    sourceRole,
    commit: record.sha,
    file,
    relation: "direct",
    side: "head",
  }));
  const overlapEvidence: ChangeIntentEvidence = {
    kind: "source",
    value: `${file} differs between the target and proposed refs after merge base ${shortSha(mergeBase)}.`,
    sourceRole,
    file,
    relation: "direct",
  };
  const evidence = [
    ...(targetLineEvidence ? [targetLineEvidence] : []),
    ...(proposedLineEvidence ? [proposedLineEvidence] : []),
    ...targetEvidence,
    ...proposedEvidence,
    overlapEvidence,
  ];
  const id = stableId(
    "branch-divergence",
    mergeBase,
    file,
    ...targetRecords.map((record) => record.sha),
    ...proposedRecords.map((record) => record.sha),
  );
  const subject = humanizeFile(file);
  const scenario: IntentQaScenario = {
    id: stableId(id, "preservation"),
    kind: "state-transition",
    priority: "critical",
    title: `Integrated ${subject} preserves target-only and proposed behavior`,
    rationale:
      `${file} has a non-equivalent target-only patch and proposed-branch work after the same merge base. ` +
      "The diff alone cannot prove that the target-side behavior will survive integration.",
    setup: [
      `Compare ${file} at the merge base, current target ref, and proposed ref before integrating the branches.`,
    ],
    steps: [
      "Identify the intended behavior introduced by each target-only and proposed-branch commit listed in the evidence.",
      `Integrate the current target branch and resolve the final ${file} content intentionally.`,
      "Run the nearest repository-declared validation for the behavior controlled by the overlapping file.",
    ],
    assertions: [
      "Verify the integrated result retains the intended target-only behavior.",
      "Verify the proposed behavior still works after integration.",
      "Verify no non-equivalent target-only patch remains absent from the integrated result.",
    ],
    edgeCases: [
      "Non-overlapping edits in the same file still require a final integrated-state check.",
      "Patch-equivalent commits must not be reimplemented or reported as missing.",
    ],
    evidence,
    confidence: "high",
    reviewRequired: true,
  };

  return {
    id,
    title: `Preserve target-branch behavior in ${subject}`,
    summary:
      `${file} contains non-equivalent target-only and proposed-branch changes after merge base ${shortSha(mergeBase)}. ` +
      "Review the integrated result before promotion; this is a preservation risk, not a confirmed defect.",
    confidence: "high",
    commits: [
      ...targetRecords.map((record) => toIntentCommit(record, "target-only", file)),
      ...proposedRecords.map((record) => toIntentCommit(record, "proposed-branch", file)),
    ],
    files: [file],
    keywords: ["branch-divergence", "integration", "preservation", "target-change"],
    evidence,
    lifecycle: [
      {
        id: stableId(id, "trigger"),
        kind: "trigger",
        label: "Integrate the proposed branch with the current target branch",
        confidence: "high",
        evidence,
        files: [file],
      },
      {
        id: stableId(id, "condition"),
        kind: "condition",
        label: `${file} has non-equivalent changes on both sides of the merge base`,
        confidence: "high",
        evidence,
        files: [file],
      },
      {
        id: stableId(id, "outcome"),
        kind: "observable-outcome",
        label: "The integrated result preserves intended behavior from both branches",
        confidence: "high",
        evidence,
        files: [file],
      },
    ],
    scenarios: [scenario],
    reviewRequired: true,
  };
}

function locatedBranchEvidence(
  file: string,
  hunks: AddedDiffHunk[],
  side: "base" | "head",
  commit: string | undefined,
  label: string,
  sourceRole: ChangeIntentEvidence["sourceRole"],
): ChangeIntentEvidence | undefined {
  for (const hunk of hunks) {
    const line = hunk.lines[0] ?? hunk.removedLines?.[0];
    if (!line) continue;
    return {
      kind: "diff",
      value: `${label} changed line in ${file}.`,
      sourceRole,
      commit,
      file,
      relation: "direct",
      side,
      startLine: line.line,
      endLine: line.line,
      hunkHeader: hunk.hunkHeader,
    };
  }
  return undefined;
}

async function resolveCommit(root: string, ref: string): Promise<string> {
  return runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

async function collectNonEquivalentTargetCommits(
  root: string,
  head: string,
  base: string,
): Promise<Set<string>> {
  const output = await runGit(root, ["cherry", head, base]);
  return new Set(
    output
      .split(/\r?\n/)
      .map((line) => /^\+\s+([0-9a-f]{40})$/i.exec(line.trim())?.[1])
      .filter((sha): sha is string => Boolean(sha)),
  );
}

async function collectCommitRecords(
  root: string,
  range: string,
  scopePrefix: string,
): Promise<BranchCommitRecord[]> {
  const args = [
    "log",
    "--no-merges",
    "--no-renames",
    "--format=%x1e%H%x1f%s",
    "--name-only",
    range,
  ];
  if (scopePrefix) {
    args.push("--", scopePrefix);
  }
  const output = await runGit(root, args);
  return output
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [header = "", ...files] = chunk.split(/\r?\n/);
      const [sha = "", subject = ""] = header.split("\x1f");
      return {
        sha: sha.trim(),
        subject: subject.trim(),
        files: files.map((file) => toPosixPath(file.trim())).filter(Boolean),
      };
    })
    .filter((record) => /^[0-9a-f]{40}$/i.test(record.sha));
}

async function collectChangedPaths(
  root: string,
  base: string,
  head: string,
  scopePrefix: string,
): Promise<string[]> {
  const args = ["diff", "--no-renames", "--name-only", "-z", base, head];
  if (scopePrefix) {
    args.push("--", scopePrefix);
  }
  const output = await runGit(root, args);
  return output.split("\0").map(toPosixPath).filter(Boolean);
}

function filesByCommit(
  records: BranchCommitRecord[],
  scopePrefix: string,
): Map<string, BranchCommitRecord[]> {
  const result = new Map<string, BranchCommitRecord[]>();
  for (const record of records) {
    for (const gitPath of record.files) {
      const file = toScopedPath(gitPath, scopePrefix);
      if (!file) continue;
      const current = result.get(file) ?? [];
      current.push(record);
      result.set(file, current);
    }
  }
  return result;
}

function toScopedPath(fileInput: string, scopePrefix: string): string | undefined {
  const file = toPosixPath(fileInput).replace(/^\.\//, "");
  if (!scopePrefix) return file;
  if (!file.startsWith(`${scopePrefix}/`)) return undefined;
  return file.slice(scopePrefix.length + 1);
}

function toIntentCommit(
  record: BranchCommitRecord,
  side: "target-only" | "proposed-branch",
  file: string,
): ChangeIntentCommit {
  return {
    sha: record.sha,
    subject: record.subject,
    files: [file],
    statement: `${side === "target-only" ? "Target-only" : "Proposed-branch"} change: ${record.subject}`,
  };
}

function humanizeFile(file: string): string {
  const basename = path.posix.basename(file).replace(/\.(?:d\.)?[^.]+$/i, "");
  const words = basename
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return words.length > 0 ? words : "overlapping behavior";
}

function stableId(...parts: string[]): string {
  return `intent:${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}
