import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  classifyChangedSourceRoles,
  classifyChangeSourceRole,
  isTransformationSourcePath,
} from "./source-role.js";
import type { ChangeSourceRole } from "./source-role.js";
import {
  collectChangedQaSymbolAnnotations,
  formatQaSymbolAnnotationDiagnostic,
} from "./symbol-annotations.js";
import { isInstructionLikeRepositoryText } from "./qa-contract.js";
import type {
  ChangedQaSymbolAnnotation,
} from "./symbol-annotations.js";
import type { AddedDiffEvidence, AddedDiffHunk, TestPlanChangedFile } from "./test-plan.js";

const execFileAsync = promisify(execFile);

export type ChangeIntentConfidence = "low" | "medium" | "high";
export type ChangeIntentEvidenceKind = "commit" | "diff" | "source";
export type ChangeIntentEvidenceRelation = "direct" | "supporting" | "contextual";
export type BehaviorLifecycleStageKind =
  | "trigger"
  | "condition"
  | "action"
  | "state-change"
  | "side-effect"
  | "observable-outcome";
export type IntentQaScenarioKind = "primary" | "failure" | "boundary" | "state-transition";
export type IntentQaScenarioPriority = "critical" | "recommended";
type AsyncLifecycleRole = "dispatch" | "state" | "completion" | "consistency";

export interface ChangeIntentEvidence {
  kind: ChangeIntentEvidenceKind;
  value: string;
  sourceRole?: ChangeSourceRole;
  commit?: string;
  file?: string;
  previousFile?: string;
  symbol?: string;
  relation?: ChangeIntentEvidenceRelation;
  side?: "base" | "head";
  startLine?: number;
  endLine?: number;
  hunkHeader?: string;
}

export interface ChangeIntentCommit {
  sha: string;
  subject: string;
  body?: string;
  files?: string[];
  conventionalType?: string;
  scope?: string;
  statement: string;
}

export interface BehaviorLifecycleStage {
  id: string;
  kind: BehaviorLifecycleStageKind;
  label: string;
  confidence: ChangeIntentConfidence;
  evidence: ChangeIntentEvidence[];
  files: string[];
  // Raw code identifier when the stage was derived from a code signal, so
  // classification never depends on the reader-facing label phrasing.
  symbol?: string;
}

export interface IntentQaScenario {
  id: string;
  kind: IntentQaScenarioKind;
  priority: IntentQaScenarioPriority;
  title: string;
  rationale: string;
  setup: string[];
  steps: string[];
  assertions: string[];
  edgeCases: string[];
  evidence: ChangeIntentEvidence[];
  confidence?: ChangeIntentConfidence;
  reviewRequired?: boolean;
}

export interface ChangeIntent {
  id: string;
  title: string;
  summary: string;
  confidence: ChangeIntentConfidence;
  commits: ChangeIntentCommit[];
  files: string[];
  keywords: string[];
  evidence: ChangeIntentEvidence[];
  lifecycle: BehaviorLifecycleStage[];
  scenarios: IntentQaScenario[];
  reviewRequired: boolean;
}

export interface ChangeIntentAnalysis {
  base: string;
  head: string;
  source: "commits-and-diff" | "commits" | "diff-only" | "none";
  commits: ChangeIntentCommit[];
  intents: ChangeIntent[];
  symbolAnnotations?: ChangeIntentSymbolAnnotationSummary;
  diagnostics: string[];
}

export interface ChangeIntentSymbolAnnotationSummary {
  applied: number;
  files: string[];
  symbols: string[];
  flows: string[];
  diagnostics: number;
}

export const unresolvedPrimaryScenarioAssertion =
  "Record the expected externally observable result; no changed-file evidence proves an externally observable result yet.";

export interface ChangeIntentAnalysisOptions {
  base: string;
  head: string;
  workspaceRoot?: string;
  includeWorkingTree?: boolean;
  changedFiles: TestPlanChangedFile[];
  addedDiffText?: Record<string, string>;
  addedDiffEvidence?: AddedDiffEvidence;
}

interface ParsedCommit extends ChangeIntentCommit {
  seed: boolean;
  supporting: boolean;
  keywords: string[];
  tickets: string[];
}

interface CodeBehaviorSignal {
  kind: BehaviorLifecycleStageKind;
  label: string;
  file: string;
  symbol: string;
  evidence: ChangeIntentEvidence;
}

const behavioralCommitTypes = new Set(["feat", "feature", "fix", "hotfix", "perf"]);
const supportingCommitTypes = new Set(["refactor"]);
const ignoredCommitTypes = new Set(["build", "chore", "ci", "docs", "release", "style", "test"]);
const nonConventionalBehaviorVerbPattern =
  /^(?:add\s+support\s+for|allow|enable|fix|handle|implement|persist|prevent|remove|restore|surface|support)\b/i;
const maxCommits = 50;
const maxIntentFiles = 20;
const maxLifecycleStages = 12;
const maxQaScenariosPerIntent = 10;
const maxSignals = 96;

const stopWords = new Set([
  "a",
  "an",
  "and",
  "app",
  "behavior",
  "change",
  "create",
  "export",
  "for",
  "from",
  "implement",
  "improve",
  "in",
  "into",
  "its",
  "of",
  "on",
  "page",
  "screen",
  "service",
  "support",
  "the",
  "to",
  "update",
  "user",
  "using",
  "with",
]);

const ignoredCallNames = new Set([
  "async",
  "catch",
  "describe",
  "expect",
  "filter",
  "forEach",
  "if",
  "it",
  "map",
  "reduce",
  "return",
  "switch",
  "test",
  "while",
]);
const implementationSchedulingCalls = new Set([
  "cancelanimationframe",
  "cancelidlecallback",
  "clearimmediate",
  "clearinterval",
  "cleartimeout",
  "queuemicrotask",
  "requestanimationframe",
  "requestidlecallback",
  "setimmediate",
  "setinterval",
  "settimeout",
]);
const implementationPredicateCalls = new Set([
  "array.isarray",
  "arraybuffer.isview",
  "number.isfinite",
  "number.isinteger",
  "number.isnan",
  "number.issafeinteger",
  "object.hasown",
]);

export async function analyzeChangeIntents(
  rootInput: string,
  options: ChangeIntentAnalysisOptions,
): Promise<ChangeIntentAnalysis> {
  const root = path.resolve(rootInput);
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  const gitRoot = workspaceRoot ?? root;
  const relativeRoot = workspaceRoot ? toPosixPath(path.relative(workspaceRoot, root)) : "";
  if (workspaceRoot && (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot))) {
    throw new Error(`Change intent path must be inside workspace root: ${root}`);
  }

  const diagnostics: string[] = [];
  const commits = await collectCommitEvidence(gitRoot, options.base, options.head, relativeRoot, diagnostics);
  const parsedCommits = commits.map(parseCommit);
  const changedSourceRoles = classifyChangedSourceRoles(
    await collectChangedSourceRoleText(root, gitRoot, options),
  );
  const annotationAnalysis = await collectChangedQaSymbolAnnotations(root, {
    head: options.head,
    workspaceRoot: options.workspaceRoot,
    includeWorkingTree: options.includeWorkingTree,
    changedFiles: options.changedFiles,
    addedDiffEvidence: options.addedDiffEvidence ?? {},
  });
  diagnostics.push(...annotationAnalysis.diagnostics.map(formatQaSymbolAnnotationDiagnostic));
  const productAnnotations = annotationAnalysis.annotations.filter((annotation) =>
    (changedSourceRoles[annotation.file]?.role ?? classifyChangeSourceRole(
      annotation.file,
      annotation.symbol,
    ).role) === "product"
  );
  const annotationSignals = collectQaSymbolAnnotationSignals(productAnnotations);
  const annotationEvidence = collectQaSymbolAnnotationEvidence(productAnnotations);
  const codeSignals = selectCodeSignals([
    ...annotationSignals,
    ...collectCodeBehaviorSignals(
      options.addedDiffText ?? {},
      options.addedDiffEvidence ?? {},
      changedSourceRoles,
    ),
  ]);
  const deliveryIntegrityEvidence = await collectDeliveryIntegrityEvidence(
    root,
    gitRoot,
    options,
    changedSourceRoles,
  );
  const riskEvidence = uniqueEvidence([
    ...deliveryIntegrityEvidence,
    ...collectDiffRiskEvidence(options.addedDiffEvidence ?? {}, changedSourceRoles),
    ...collectRemovalContractEvidence(
      options.changedFiles,
      options.addedDiffEvidence ?? {},
      changedSourceRoles,
    ),
    ...collectQaSymbolAnnotationRiskEvidence(productAnnotations),
  ]);
  const diffAnchors = collectChangedDiffAnchors(
    options.addedDiffEvidence ?? {},
    changedSourceRoles,
  );
  const changedFiles = options.changedFiles.map((file) => file.path);
  const commitClusters = clusterBehaviorCommits(parsedCommits);
  const intents = commitClusters
    .map((cluster, index) =>
      buildCommitIntent(
        cluster,
        index,
        commitClusters.length,
        changedFiles,
        options.addedDiffText ?? {},
        codeSignals,
        riskEvidence,
        annotationEvidence,
        diffAnchors,
      )
    )
    .filter((intent) => intent.files.length > 0);

  const coveredFiles = new Set(intents.flatMap((intent) => intent.files));
  const residualFiles = changedFiles.filter((file) => isBehaviorBearingFile(file) && !coveredFiles.has(file));
  if (residualFiles.length > 0) {
    const residualFileSet = new Set(residualFiles);
    const diffIntent = buildDiffOnlyIntent(
      residualFiles,
      codeSignals.filter((signal) => residualFileSet.has(signal.file)),
      riskEvidence.filter((evidence) => {
        const file = evidence.file ?? evidence.previousFile;
        return file !== undefined && residualFileSet.has(file);
      }),
      annotationEvidence.filter((evidence) => evidence.file && residualFileSet.has(evidence.file)),
      options.includeWorkingTree ?? false,
    );
    if (diffIntent) {
      intents.push(diffIntent);
    }
  }

  if (intents.length === 0) {
    diagnostics.push(
      commits.length === 0
        ? "No behavior-bearing commit or sufficiently connected working-tree signals were found."
        : "Commit evidence was available, but it did not contain a behavior-bearing intent.",
    );
  }
  const rankedIntents = rankChangeIntentsForReview(intents, commits);

  return {
    base: options.base,
    head: options.head,
    source: changeIntentSource(rankedIntents, commits, codeSignals),
    commits,
    intents: rankedIntents,
    symbolAnnotations: productAnnotations.length > 0 || annotationAnalysis.diagnostics.length > 0
      ? summarizeQaSymbolAnnotations(productAnnotations, annotationAnalysis.diagnostics.length)
      : undefined,
    diagnostics: uniqueStrings(diagnostics),
  };
}

async function collectChangedSourceRoleText(
  root: string,
  gitRoot: string,
  options: ChangeIntentAnalysisOptions,
): Promise<Record<string, string>> {
  const headIsCurrent = await refsResolveToSameCommit(gitRoot, options.head, "HEAD");
  const dirtyFiles = headIsCurrent && !options.includeWorkingTree
    ? await collectDirtyRepositoryFiles(gitRoot)
    : new Set<string>();
  const relativeRoot = toPosixPath(path.relative(gitRoot, root)).replace(/^\.\/+|\/+$/g, "");
  const entries = new Array<readonly [string, string]>(options.changedFiles.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(8, options.changedFiles.length) },
    async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= options.changedFiles.length) {
          return;
        }
        const changedFile = options.changedFiles[index];
        const file = changedFile.path;
        const locatedText = options.addedDiffEvidence?.[file]
          ? diffTextForRoleClassification(options.addedDiffEvidence[file])
          : options.addedDiffText?.[file] ?? "";
        const repositoryFile = relativeRoot ? `${relativeRoot}/${file}` : file;
        try {
          const currentText = options.includeWorkingTree || (headIsCurrent && !dirtyFiles.has(repositoryFile))
            ? await readFile(path.join(root, file), "utf8")
            : (await execFileAsync(
                "git",
                ["show", `${options.head}:${repositoryFile}`],
                { cwd: gitRoot, maxBuffer: 512 * 1024 },
              )).stdout;
          entries[index] = [file, `${locatedText}\n${currentText.slice(0, 256 * 1024)}`];
        } catch {
          entries[index] = [file, locatedText];
        }
      }
    },
  );
  await Promise.all(workers);
  return Object.fromEntries(entries);
}

async function collectDirtyRepositoryFiles(root: string): Promise<Set<string>> {
  try {
    const results = await Promise.all([
      execFileAsync("git", ["diff", "--name-only", "-z"], { cwd: root }),
      execFileAsync("git", ["diff", "--cached", "--name-only", "-z"], { cwd: root }),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root }),
    ]);
    return new Set(
      results.flatMap(({ stdout }) => stdout.split("\0").map(toPosixPath).filter(Boolean)),
    );
  } catch {
    return new Set();
  }
}

async function refsResolveToSameCommit(
  root: string,
  left: string,
  right: string,
): Promise<boolean> {
  try {
    const [{ stdout: leftSha }, { stdout: rightSha }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "--verify", `${left}^{commit}`], { cwd: root }),
      execFileAsync("git", ["rev-parse", "--verify", `${right}^{commit}`], { cwd: root }),
    ]);
    return leftSha.trim() === rightSha.trim();
  } catch {
    return false;
  }
}

function rankChangeIntentsForReview(
  intents: ChangeIntent[],
  commits: ChangeIntentCommit[],
): ChangeIntent[] {
  const commitOrder = new Map(commits.map((commit, index) => [commit.sha, index]));
  return intents
    .map((intent, index) => ({
      intent,
      index,
      cleanupOnly: isCleanupOnlyIntent(intent) ? 1 : 0,
      featureBearing: intent.commits.some((commit) =>
        commit.conventionalType === "feat" || commit.conventionalType === "feature"
      ) ? 0 : 1,
      latestCommit: intent.commits.length === 0
        ? -1
        : Math.max(...intent.commits.map((commit) => commitOrder.get(commit.sha) ?? -1)),
      locatedEvidence: intent.evidence.filter((evidence) =>
        hasActionableLocatedDiffEvidence([evidence])
      ).length,
    }))
    .sort((left, right) =>
      left.cleanupOnly - right.cleanupOnly ||
      left.featureBearing - right.featureBearing ||
      right.latestCommit - left.latestCommit ||
      right.locatedEvidence - left.locatedEvidence ||
      left.index - right.index
    )
    .map(({ intent }) => intent);
}

// Public PR branches routinely end with review-feedback commits ("fix: minor
// refactor", "fix: tidy up and add tests"). Their behavioral conventional type
// lets them seed an intent, but the subject describes housekeeping, not the
// branch's substantive behavior change, so recency alone would headline them.
// Demote intents whose every commit is cleanup-shaped below substantive
// intents; demotion only reorders and never drops an intent. Kept separate
// from isLowSignalCommitStatement so seed/supporting classification and the
// working-tree current-delta focus are unchanged.
const cleanupCommitStatementPattern =
  /^(?:minor\s+)?(?:refactor(?:ing|s)?|clean\s?-?ups?|tidy(?:ing)?(?:\s+up)?|polish(?:ing)?|nits?|typos?|reformat(?:ting)?|lint(?:ing)?|whitespace|merge)\b/i;
const reviewFeedbackStatementPattern =
  /^(?:address(?:es|ed|ing)?\s+(?:review|pr\s+)?(?:comments?|feedback)|apply(?:ing)?\s+review\b)/i;

function isCleanupCommitStatement(statement: string): boolean {
  const trimmed = statement.trim();
  return cleanupCommitStatementPattern.test(trimmed) || reviewFeedbackStatementPattern.test(trimmed);
}

function isCleanupOnlyIntent(intent: ChangeIntent): boolean {
  if (intent.commits.length === 0) {
    return false;
  }
  return intent.commits.every((commit) => isCleanupCommitStatement(commit.statement));
}

async function collectCommitEvidence(
  root: string,
  base: string,
  head: string,
  relativeRoot: string,
  diagnostics: string[],
): Promise<ChangeIntentCommit[]> {
  const args = [
    "log",
    "--reverse",
    "--no-merges",
    `--max-count=${maxCommits}`,
    "--name-only",
    "--format=%x1e%H%x1f%s%x1f%b%x1f",
    `${base}..${head}`,
  ];
  if (relativeRoot) {
    args.push("--", relativeRoot);
  }
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    return stdout
      .split("\u001e")
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => parseCommitRecord(record, relativeRoot))
      .filter((commit) => !/^merge\b/i.test(commit.subject));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(`Could not read commit intent evidence: ${message}`);
    return [];
  }
}

function parseCommitRecord(record: string, relativeRoot: string): ChangeIntentCommit {
  const [sha = "", subject = "", body = "", fileBlock = ""] = record.split("\u001f");
  const files = uniqueStrings(
    fileBlock
      .split(/\r?\n/)
      .map((file) => scopeCommitFile(toPosixPath(file.trim()), relativeRoot))
      .filter((file): file is string => Boolean(file)),
  );
  return {
    sha: sha.trim(),
    subject: subject.trim(),
    body: body.trim() || undefined,
    files,
    statement: subject.trim(),
  };
}

function scopeCommitFile(file: string, relativeRoot: string): string | undefined {
  if (!file) return undefined;
  if (!relativeRoot) return file;
  const prefix = `${relativeRoot}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : undefined;
}

// Issue-tracker tags such as "[ABC-123]" or "(ABC-123)" carry provenance, not
// behavior. Strip them before parsing so every derived sentence (lifecycle
// labels, assertions, success signals) reads clean; the intent title
// re-attaches one tag so the reference survives exactly once. Stripping the
// leading form first also lets "[ABC-123] fix: ..." subjects parse as
// conventional commits instead of falling back to raw-subject heuristics.
function extractTicketTags(value: string): { statement: string; tickets: string[] } {
  const tickets: string[] = [];
  let statement = value.trim();
  for (;;) {
    const leading = statement.match(/^(?:\[([A-Z][A-Z0-9]*-\d+)\]|\(([A-Z][A-Z0-9]*-\d+)\))[\s:–—-]*/);
    if (!leading) break;
    tickets.push((leading[1] ?? leading[2]) as string);
    statement = statement.slice(leading[0].length).trim();
  }
  for (;;) {
    const trailing = statement.match(/\s*(?:\[([A-Z][A-Z0-9]*-\d+)\]|\(([A-Z][A-Z0-9]*-\d+)\))$/);
    if (!trailing) break;
    tickets.push((trailing[1] ?? trailing[2]) as string);
    statement = statement.slice(0, statement.length - trailing[0].length).trim();
  }
  return { statement, tickets };
}

function parseCommit(commit: ChangeIntentCommit): ParsedCommit {
  const { statement: cleanSubject, tickets } = extractTicketTags(commit.subject);
  const match = cleanSubject.match(/^([a-z][a-z0-9-]*)(?:\(([^)]+)\))?!?:\s*(.+)$/i);
  const conventionalType = match?.[1]?.toLowerCase();
  const scope = match?.[2]?.trim();
  const statement = (match?.[3] ?? cleanSubject).trim();
  const actionSignals = lifecycleKeywordCount(`${statement} ${commit.body ?? ""}`);
  const nonConventionalBehavior =
    !conventionalType &&
    nonConventionalBehaviorVerbPattern.test(statement) &&
    (commit.files ?? []).some(isBehaviorBearingFile) &&
    !isLowSignalCommitStatement(statement);
  const behaviorDescribingRefactor =
    conventionalType === "refactor" && isBehaviorDescribingRefactorStatement(statement);
  const seed = conventionalType
    ? behavioralCommitTypes.has(conventionalType) || behaviorDescribingRefactor
    : (actionSignals >= 2 || nonConventionalBehavior) && !isLowSignalCommitStatement(statement);
  const supporting = conventionalType
    ? supportingCommitTypes.has(conventionalType)
    : actionSignals >= 1 && !isLowSignalCommitStatement(statement);
  return {
    ...commit,
    conventionalType,
    scope,
    statement,
    seed,
    supporting: supporting && !seed,
    keywords: extractKeywords(`${scope ?? ""} ${statement} ${commit.body ?? ""}`),
    tickets,
  };
}

function isBehaviorDescribingRefactorStatement(statement: string): boolean {
  if (isImplementationOnlyLifecycleStep(statement)) {
    return false;
  }
  return /^(?:allow|enable|handle|persist|preserve|prevent|restore|show|surface|validate)\b/i.test(statement) ||
    /^(?:remove|replace)\b.+\b(?:after|before|when|while|without)\b/i.test(statement);
}

function clusterBehaviorCommits(commits: ParsedCommit[]): ParsedCommit[][] {
  const candidates = commits.filter((commit) => {
    if (commit.conventionalType && ignoredCommitTypes.has(commit.conventionalType)) {
      return false;
    }
    return commit.seed || commit.supporting;
  });
  const seedIndexes = candidates
    .map((commit, index) => (commit.seed ? index : -1))
    .filter((index) => index >= 0);
  if (seedIndexes.length === 0) {
    return [];
  }

  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    if (parent[index] !== index) {
      parent[index] = find(parent[index]);
    }
    return parent[index];
  };
  const join = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      if (commitsShareIntent(candidates[left], candidates[right])) {
        join(left, right);
      }
    }
  }

  const components = new Map<number, ParsedCommit[]>();
  candidates.forEach((commit, index) => {
    const root = find(index);
    const group = components.get(root) ?? [];
    group.push(commit);
    components.set(root, group);
  });

  return [...components.values()]
    .flatMap(splitTransitiveIntentComponent)
    .filter((group) => group.some((commit) => commit.seed))
    .sort((left, right) => commits.indexOf(left[0]) - commits.indexOf(right[0]));
}

function splitTransitiveIntentComponent(component: ParsedCommit[]): ParsedCommit[][] {
  const groups: ParsedCommit[][] = [];
  let remaining = [...component];
  while (remaining.some((commit) => commit.seed)) {
    const anchor = selectIntentTitleCommit(remaining);
    const group = remaining.filter((commit) =>
      commit === anchor || commitsShareIntent(anchor, commit)
    );
    groups.push(group);
    const selected = new Set(group);
    remaining = remaining.filter((commit) => !selected.has(commit));
  }
  return groups;
}

function commitsShareIntent(left: ParsedCommit, right: ParsedCommit): boolean {
  if (isCleanupCommitStatement(left.statement) !== isCleanupCommitStatement(right.statement)) {
    return false;
  }
  const sharedTicket = left.tickets.find((ticket) => right.tickets.includes(ticket));
  if (sharedTicket) {
    return true;
  }
  if (
    left.tickets.length > 0 &&
    right.tickets.length > 0 &&
    !left.tickets.some((ticket) => right.tickets.includes(ticket))
  ) {
    return false;
  }
  const rightFiles = new Set((right.files ?? []).filter(isBehaviorBearingFile));
  const sharesBehaviorFile = (left.files ?? []).some(
    (file) => isBehaviorBearingFile(file) && rightFiles.has(file),
  );
  if (sharesBehaviorFile) {
    return true;
  }

  // Conventional scopes and repeated structural vocabulary often describe a
  // package or release theme, not one behavior lifecycle. Keep cross-file
  // commits separate unless an explicit ticket connects them; exact file
  // overlap remains the bounded structural relationship available here.
  return false;
}

function selectIntentTitleCommit(commits: ParsedCommit[]): ParsedCommit {
  return commits.find((commit) =>
    commit.conventionalType === "feat" || commit.conventionalType === "feature"
  ) ?? commits.find((commit) => commit.seed) ?? commits[0];
}

function buildCommitIntent(
  commits: ParsedCommit[],
  index: number,
  clusterCount: number,
  changedFiles: string[],
  addedDiffText: Record<string, string>,
  codeSignals: CodeBehaviorSignal[],
  riskEvidence: ChangeIntentEvidence[],
  annotationEvidence: ChangeIntentEvidence[],
  diffAnchors: ChangeIntentEvidence[],
): ChangeIntent {
  const keywords = uniqueStrings(commits.flatMap((commit) => commit.keywords));
  const files = selectIntentFiles(
    keywords,
    changedFiles,
    addedDiffText,
    clusterCount,
    uniqueStrings(commits.flatMap((commit) => commit.files ?? [])),
  );
  const relevantSignals = rankCodeSignalsForIntent(
    codeSignals.filter((signal) => files.includes(signal.file)),
    keywords,
  ).filter((signal) => !isUnalignedGenericCallbackSignal(signal, keywords));
  const relevantRiskEvidence = riskEvidence.filter((item) => item.file && files.includes(item.file));
  const relevantAnnotationEvidence = annotationEvidence.filter((item) => item.file && files.includes(item.file));
  const relevantDiffAnchors = diffAnchors.filter((item) => item.file && files.includes(item.file));
  const lifecycle = buildLifecycle(commits, relevantSignals, relevantRiskEvidence);
  const confidence = confidenceForIntent(commits, lifecycle, relevantSignals);
  const titleCommit = selectIntentTitleCommit(commits);
  const titleTicket = titleCommit.tickets[0] ?? commits.flatMap((commit) => commit.tickets)[0];
  const title = titleTicket
    ? `${sentenceTitle(titleCommit.statement)} [${titleTicket}]`
    : sentenceTitle(titleCommit.statement);
  const scenarioEvidence = uniqueEvidence([
    ...commits.map((commit) => ({
      kind: "commit" as const,
      value: commit.subject,
      commit: commit.sha,
      relation: "contextual" as const,
    })),
    ...relevantSignals.slice(0, 12).map((signal) => ({
      ...signal.evidence,
    })),
    ...selectRiskEvidence(relevantRiskEvidence, 12),
    ...relevantAnnotationEvidence,
  ]);
  const fallbackDiffAnchors = hasActionableLocatedDiffEvidence(scenarioEvidence)
    ? []
    : selectIntentFallbackDiffAnchor(relevantDiffAnchors, keywords).map((anchor) => ({
        ...anchor,
        relation: files.length === 1 ? "direct" as const : "contextual" as const,
      }));
  const evidence = uniqueEvidence([
    ...scenarioEvidence,
    ...fallbackDiffAnchors,
  ]);
  const id = stableId("intent", `${index}:${commits.map((commit) => commit.sha).join(":")}:${title}`);
  const summary = commits
    .map((commit) => stripTerminalPunctuation(commit.statement))
    .filter(Boolean)
    .slice(0, 4)
    .join("; ");
  const housekeepingOnly = commits.every((commit) => isCleanupCommitStatement(commit.statement));
  const scenarios = housekeepingOnly
    ? []
    : buildIntentQaScenarios(id, title, lifecycle, keywords, scenarioEvidence, confidence);
  return {
    id,
    title,
    summary,
    confidence,
    commits: commits.map(stripParsedCommitFields),
    files,
    keywords,
    evidence,
    lifecycle,
    scenarios,
    reviewRequired: confidence !== "high" || lifecycle.some((stage) => stage.confidence === "low"),
  };
}

function selectIntentFallbackDiffAnchor(
  anchors: ChangeIntentEvidence[],
  intentKeywords: string[],
): ChangeIntentEvidence[] {
  const keywordSet = new Set(intentKeywords);
  return anchors
    .map((anchor, index) => {
      const fileKeywords = extractKeywords(anchor.file ?? "");
      return {
        anchor,
        index,
        score: fileKeywords.filter((keyword) => keywordSet.has(keyword)).length,
      };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 1)
    .map(({ anchor }) => anchor);
}

function buildDiffOnlyIntent(
  changedFiles: string[],
  codeSignals: CodeBehaviorSignal[],
  riskEvidence: ChangeIntentEvidence[],
  annotationEvidence: ChangeIntentEvidence[],
  includesWorkingTree: boolean,
): ChangeIntent | undefined {
  const roleEvidence = riskEvidence.filter((item) =>
    item.sourceRole === "analysis-rule" || item.sourceRole === "command"
  );
  const deliveryIntegrityEvidence = riskEvidence.filter(isDeliveryIntegrityEvidence);
  const lifecycle = limitLifecycleStages([
    ...lifecycleFromCodeSignals(codeSignals),
    ...lifecycleFromSourceRoles(roleEvidence),
    ...lifecycleFromDeliveryIntegrityEvidence(deliveryIntegrityEvidence),
  ]);
  const stageKinds = new Set(lifecycle.map((stage) => stage.kind));
  const hasRecognizedSourceRole = roleEvidence.length > 0 || deliveryIntegrityEvidence.length > 0;
  const hasSymbolAnnotation = annotationEvidence.length > 0;
  if (
    (!hasRecognizedSourceRole && !hasSymbolAnnotation && (lifecycle.length < 3 || stageKinds.size < 3)) ||
    lifecycle.length < 2
  ) {
    return undefined;
  }
  const files = uniqueStrings([
    ...codeSignals.map((signal) => signal.file),
    ...roleEvidence.map((item) => item.file ?? "").filter(Boolean),
    ...deliveryIntegrityEvidence.map((item) => item.file ?? "").filter(Boolean),
  ]).slice(0, maxIntentFiles);
  const annotatedFlow = firstQaAnnotationFlow(annotationEvidence);
  const titleSubject = deliveryIntegrityEvidence.length > 0
    ? "Delivery integrity"
    : annotatedFlow
    ? humanizeIdentifier(annotatedFlow)
    : diffIntentSubject(files[0], roleEvidence[0]?.sourceRole, roleEvidence);
  const analysisRuleChange = roleEvidence.some((item) => item.sourceRole === "analysis-rule");
  const title = analysisRuleChange
    ? `${titleSubject} ${includesWorkingTree ? "working-tree change" : "change"}`
    : `${titleSubject} ${includesWorkingTree ? "working-tree" : "changed"} behavior`;
  const evidence = uniqueEvidence([
    ...codeSignals.slice(0, 16).map((signal) => signal.evidence),
    ...selectRiskEvidence(riskEvidence, 24),
    ...annotationEvidence,
  ]);
  const id = stableId("intent", `${includesWorkingTree ? "working-tree" : "diff"}:${files.join(":")}`);
  const keywords = extractKeywords([
    ...codeSignals.map((signal) => `${signal.symbol} ${signal.label}`),
    ...riskEvidence.map((item) => `${item.symbol ?? ""} ${item.value}`),
    ...annotationEvidence.map((item) => `${item.symbol ?? ""} ${item.value}`),
  ].join(" "));
  return {
    id,
    title,
    summary: includesWorkingTree
      ? "Inferred only from connected working-tree behavior signals; no commit intent was available."
      : "Inferred from connected changed-code behavior signals because commit text did not express a usable intent.",
    confidence: "low",
    commits: [],
    files: files.length > 0 ? files : changedFiles.slice(0, maxIntentFiles),
    keywords,
    evidence,
    lifecycle,
    scenarios: buildIntentQaScenarios(id, title, lifecycle, keywords, evidence, "low"),
    reviewRequired: true,
  };
}

function diffIntentSubject(
  file: string | undefined,
  sourceRole?: ChangeSourceRole,
  roleEvidence: ChangeIntentEvidence[] = [],
): string {
  if (sourceRole === "analysis-rule" || roleEvidence.some((item) => item.sourceRole === "analysis-rule")) {
    const specificRuleFile = roleEvidence
      .filter((item) => item.sourceRole === "analysis-rule" && item.file)
      .map((item) => item.file as string)
      .find(isSpecificAnalysisRulePath);
    if (specificRuleFile) {
      return `${humanizeIdentifier(path.basename(specificRuleFile).replace(/\.[^.]+$/, ""))} analysis rule`;
    }
    const specificSymbol = roleEvidence
      .filter((item) => item.sourceRole === "analysis-rule")
      .map((item) => item.symbol ?? "")
      .find((symbol) => !/^(?:analysis|analyzer|classifier|engine|matcher|qa|rule|scanner)$/i.test(symbol));
    return specificSymbol
      ? `${humanizeIdentifier(specificSymbol)} analysis rule`
      : "Static analysis rule";
  }
  if (sourceRole === "command") return "CLI command";
  if (!file) return "Working tree";
  const extensionless = path.basename(file).replace(/\.[^.]+$/, "");
  const subject = /^(?:index|page|route)$/i.test(extensionless)
    ? path.basename(path.dirname(file))
    : extensionless;
  return humanizeIdentifier(subject || "changed behavior");
}

function isSpecificAnalysisRulePath(file: string): boolean {
  const normalized = toPosixPath(file);
  const basename = path.posix.basename(normalized).replace(/\.[^.]+$/, "");
  return /(?:^|\/)(?:analyzers?|classifiers?|heuristics?|linters?|matchers?|policies|rules?|scanner)(?:\/|$)/i.test(
    normalized,
  ) && !/^(?:analysis|analyzer|classifier|engine|index|matcher|policy|qa|rule|rule-engine|scanner)$/i.test(basename);
}

function selectIntentFiles(
  keywords: string[],
  changedFiles: string[],
  addedDiffText: Record<string, string>,
  clusterCount: number,
  commitFiles: string[],
): string[] {
  const behaviorFiles = changedFiles.filter(isBehaviorBearingFile);
  const changedSet = new Set(behaviorFiles);
  const commitChangedFiles = commitFiles.filter((file) => changedSet.has(file));
  if (commitFiles.length > 0) {
    return commitChangedFiles.slice(0, maxIntentFiles);
  }
  if (clusterCount === 1) {
    return behaviorFiles.slice(0, maxIntentFiles);
  }
  const matched = behaviorFiles.filter((file) => {
    const searchable = `${file} ${addedDiffText[file] ?? ""}`.toLowerCase();
    return keywords.some((keyword) => searchable.includes(keyword));
  });
  return matched.slice(0, maxIntentFiles);
}

function buildLifecycle(
  commits: ParsedCommit[],
  signals: CodeBehaviorSignal[],
  roleEvidence: ChangeIntentEvidence[],
): BehaviorLifecycleStage[] {
  const stages: BehaviorLifecycleStage[] = [];
  for (const commit of commits) {
    const evidence: ChangeIntentEvidence[] = [{
      kind: "commit",
      value: commit.subject,
      commit: commit.sha,
      relation: "contextual",
    }];
    for (const trigger of extractTriggerPhrases(commit.statement)) {
      stages.push(createLifecycleStage("trigger", trigger, commit.seed ? "high" : "medium", evidence, []));
    }
    for (const clause of splitIntentClauses(commit.statement)) {
      const label = sentenceLabel(clause);
      if (isImplementationOnlyLifecycleStep(label)) {
        continue;
      }
      stages.push(
        createLifecycleStage(
          classifyLifecycleClause(clause),
          label,
          commit.seed ? "high" : "medium",
          evidence,
          [],
        ),
      );
    }
  }

  for (const signal of signals) {
    if (isImplementationOnlyLifecycleStep(`${signal.label} ${signal.symbol}`)) {
      continue;
    }
    const representedIndex = stages.findIndex((stage) =>
      (signal.kind !== "condition" && stage.label.toLowerCase().includes(signal.symbol.toLowerCase())) ||
      (stage.kind === signal.kind && lifecycleLabelsOverlap(stage.label, signal.label)),
    );
    if (representedIndex >= 0) {
      const represented = stages[representedIndex];
      stages[representedIndex] = {
        ...represented,
        evidence: uniqueEvidence([...represented.evidence, signal.evidence]),
        files: uniqueStrings([...represented.files, signal.file]),
      };
      continue;
    }
    stages.push(createLifecycleStage(signal.kind, signal.label, "medium", [signal.evidence], [signal.file], signal.symbol));
  }

  stages.push(...lifecycleFromDetectedRiskEvidence(roleEvidence));
  stages.push(...lifecycleFromSourceRoles(roleEvidence));
  stages.push(...lifecycleFromDeliveryIntegrityEvidence(roleEvidence.filter(isDeliveryIntegrityEvidence)));

  return limitLifecycleStages(removeRedundantOutcomeTimingTriggers(stages));
}

function removeRedundantOutcomeTimingTriggers(
  stages: BehaviorLifecycleStage[],
): BehaviorLifecycleStage[] {
  const outcomeLabels = stages
    .filter((stage) => stage.kind === "observable-outcome")
    .map((stage) => stripTerminalPunctuation(stage.label).toLowerCase());
  return stages.filter((stage) => {
    if (!isCommitOnlyCausalTrigger(stage)) {
      return true;
    }
    if (isVerificationTimingTrigger(stage.label)) {
      return false;
    }
    if (/\b(?:clicked|pressed|selected|submitted|tapped)\b/i.test(stage.label)) {
      return true;
    }
    const timingPhrase = stripTerminalPunctuation(stage.label).toLowerCase();
    return !outcomeLabels.some((outcome) => outcome.includes(timingPhrase));
  });
}

function isVerificationTimingTrigger(label: string): boolean {
  return /^(?:after|once|upon|when)\s+(?:an?\s+)?(?:app\s+)?(?:back navigation|re-?entry|refresh|reload|restart|resume)\b/i.test(
    stripTerminalPunctuation(label),
  );
}

function lifecycleFromCodeSignals(signals: CodeBehaviorSignal[]): BehaviorLifecycleStage[] {
  const stages = signals
    .filter((signal) => !isImplementationOnlyLifecycleStep(`${signal.label} ${signal.symbol}`))
    .map((signal) => createLifecycleStage(signal.kind, signal.label, "low", [signal.evidence], [signal.file]));
  return limitLifecycleStages(stages);
}

function lifecycleFromDetectedRiskEvidence(
  evidence: ChangeIntentEvidence[],
): BehaviorLifecycleStage[] {
  const validationTimingEvidence = evidence.filter((item) =>
    item.sourceRole === "product" && item.symbol === "form-validation-mode"
  );
  if (validationTimingEvidence.length === 0) {
    return [];
  }
  const files = uniqueStrings(validationTimingEvidence.map((item) => item.file ?? "").filter(Boolean));
  return [
    createLifecycleStage(
      "condition",
      "Apply the changed form validation timing boundary.",
      "medium",
      validationTimingEvidence,
      files,
    ),
  ];
}

function lifecycleFromSourceRoles(evidence: ChangeIntentEvidence[]): BehaviorLifecycleStage[] {
  const stages: BehaviorLifecycleStage[] = [];
  const analysisEvidence = evidence.filter((item) => item.sourceRole === "analysis-rule");
  if (analysisEvidence.length > 0) {
    const files = uniqueStrings(analysisEvidence.map((item) => item.file ?? "").filter(Boolean));
    stages.push(
      createLifecycleStage(
        "condition",
        "Compare intended source evidence with unrelated rule vocabulary.",
        "medium",
        analysisEvidence,
        files,
      ),
      createLifecycleStage(
        "action",
        "Evaluate the changed static-analysis rule against positive and negative controls.",
        "medium",
        analysisEvidence,
        files,
      ),
      createLifecycleStage(
        "observable-outcome",
        "Observe intended findings without unrelated false positives.",
        "medium",
        analysisEvidence,
        files,
      ),
    );
  }

  const commandEvidence = evidence.filter((item) => item.sourceRole === "command");
  if (commandEvidence.length > 0) {
    const files = uniqueStrings(commandEvidence.map((item) => item.file ?? "").filter(Boolean));
    stages.push(
      createLifecycleStage(
        "trigger",
        "Run the changed CLI command and options.",
        "medium",
        commandEvidence,
        files,
      ),
      createLifecycleStage(
        "condition",
        "Check valid, missing, and invalid command arguments.",
        "medium",
        commandEvidence,
        files,
      ),
      createLifecycleStage(
        "observable-outcome",
        "Observe stdout, stderr, exit status, and generated files.",
        "medium",
        commandEvidence,
        files,
      ),
    );
  }
  return stages;
}

function limitLifecycleStages(stages: BehaviorLifecycleStage[]): BehaviorLifecycleStage[] {
  const unique = uniqueLifecycleStages(stages);
  const selected: BehaviorLifecycleStage[] = [];
  const selectedIds = new Set<string>();
  const orderedKinds: BehaviorLifecycleStageKind[] = [
    "trigger",
    "condition",
    "action",
    "state-change",
    "side-effect",
    "observable-outcome",
  ];

  // Large UI files can expose dozens of click handlers before a later service
  // contributes the state change or observable outcome. Preserve lifecycle
  // diversity before filling the remaining budget in source order.
  for (const kind of orderedKinds) {
    for (const stage of unique.filter((candidate) => candidate.kind === kind).slice(0, 2)) {
      selected.push(stage);
      selectedIds.add(stage.id);
    }
  }
  for (const stage of unique) {
    if (selected.length >= maxLifecycleStages) break;
    if (selectedIds.has(stage.id)) continue;
    selected.push(stage);
  }

  return orderLifecycleStages(selected).slice(0, maxLifecycleStages);
}

function createLifecycleStage(
  kind: BehaviorLifecycleStageKind,
  label: string,
  confidence: ChangeIntentConfidence,
  evidence: ChangeIntentEvidence[],
  files: string[],
  symbol?: string,
): BehaviorLifecycleStage {
  const normalizedLabel = sentenceLabel(label);
  return {
    id: stableId("stage", `${kind}:${normalizedLabel}:${evidence.map((item) => item.commit ?? item.file ?? item.value).join(":")}`),
    kind,
    label: normalizedLabel,
    confidence,
    evidence: uniqueEvidence(evidence),
    files: uniqueStrings(files),
    ...(symbol ? { symbol } : {}),
  };
}

function buildIntentQaScenarios(
  intentId: string,
  title: string,
  lifecycle: BehaviorLifecycleStage[],
  keywords: string[],
  evidence: ChangeIntentEvidence[],
  confidence: ChangeIntentConfidence,
): IntentQaScenario[] {
  const conditions = lifecycle.filter((stage) => stage.kind === "condition").map((stage) => stage.label);
  const actions = selectPrimaryLifecycleSteps(lifecycle, keywords);
  const outcomeStages = lifecycle
    .filter((stage) => stage.kind === "observable-outcome")
    .filter((stage) => hasActionableLocatedDiffEvidence(stage.evidence))
    .filter(isMateriallyObservableOutcomeStage);
  const outcomes = outcomeStages
    .map((stage) => assertionForStage(stage));
  const hasLocatedPersistenceEvidence = lifecycle.some((stage) =>
    hasActionableLocatedDiffEvidence(stage.evidence) &&
    stage.evidence.some((item) =>
      /\b(?:asyncstorage|cache|localstorage|persist|sessionstorage|storage|store)\b/i.test(
        `${item.symbol ?? ""} ${item.value}`,
      )
    )
  );
  const stateChanges = lifecycle
    .filter(isDurableStateChangeRequirement)
    .filter((stage) =>
      hasActionableLocatedDiffEvidence(stage.evidence) || hasLocatedPersistenceEvidence
    )
    .map((stage) => assertionForStage(stage));
  const primaryEvidence = lifecycleEvidence(lifecycle, evidence);
  const primaryHasActionableEvidence = hasActionableLocatedDiffEvidence(primaryEvidence);
  const primary: IntentQaScenario = {
    id: stableId("scenario", `${intentId}:primary`),
    kind: "primary",
    priority: primaryHasActionableEvidence && confidence !== "low" ? "critical" : "recommended",
    title,
    rationale: "Commit and diff evidence describe this changed behavior lifecycle; verify the complete observable path before merge.",
    setup: conditions.length > 0 ? conditions : ["Prepare representative pre-change and changed-branch state."],
    steps: actions,
    assertions: uniqueStrings([
      ...outcomes,
      ...stateChanges,
    ]).slice(0, 4),
    edgeCases: [],
    evidence: primaryEvidence.slice(0, 8),
    confidence,
    reviewRequired: confidence !== "high" || !primaryHasActionableEvidence,
  };
  if (primary.assertions.length === 0) {
    primary.assertions.push(unresolvedPrimaryScenarioAssertion);
  }

  const scenarios = [primary];
  for (const annotatedRisk of qaAnnotationRiskScenarios(evidence).slice(0, 3)) {
    const riskScenario = makeScenario(
      intentId,
      `annotated-risk:${annotatedRisk.symbol}:${annotatedRisk.risk}`,
      qaAnnotationRiskKind(annotatedRisk.risk),
      "recommended",
      sentenceTitle(annotatedRisk.risk),
      [
        `Prepare the affected flow and the state that can expose ${stripTerminalPunctuation(annotatedRisk.risk).toLowerCase()}.`,
      ],
      [
        `Exercise ${humanizeIdentifier(annotatedRisk.symbol)} through its normal entry point.`,
        "Repeat the changed behavior under the declared risk condition.",
      ],
      uniqueStrings([
        `Verify ${stripTerminalPunctuation(annotatedRisk.risk).toLowerCase()} is prevented or handled explicitly.`,
        ...annotatedRisk.outcomes.map((outcome) => `Verify ${stripTerminalPunctuation(outcome)}.`),
      ]),
      [annotatedRisk.risk],
      annotatedRisk.evidence,
    );
    riskScenario.rationale =
      "A repo-authored QAMap symbol annotation links this risk to a changed exported symbol; review the declaration and diff before accepting it as policy.";
    scenarios.push(riskScenario);
  }
  const hasExplicitProductDiffEvidence = evidence.some((item) =>
    item.kind === "diff" && (item.sourceRole === undefined || item.sourceRole === "product")
  );
  const hasSpecializedDiffEvidence = evidence.some((item) =>
    item.kind === "diff" && (item.sourceRole === "analysis-rule" || item.sourceRole === "command")
  );
  const hasProductDiffEvidence = hasExplicitProductDiffEvidence || !hasSpecializedDiffEvidence;
  const productEvidence = evidence.filter((item) =>
    item.kind === "commit"
      ? hasProductDiffEvidence
      : item.sourceRole === undefined || item.sourceRole === "product"
  );
  const productLifecycle = lifecycle.filter((stage) =>
    stage.evidence.some((item) =>
      item.kind === "commit"
        ? hasProductDiffEvidence
        : item.sourceRole === undefined || item.sourceRole === "product"
    )
  );
  const searchable = `${hasProductDiffEvidence ? title : ""} ${productLifecycle.map((stage) => stage.label).join(" ")}`
    .toLowerCase();

  const deliveryIntegrityEvidence = evidence.filter(isDeliveryIntegrityEvidence);
  if (deliveryIntegrityEvidence.length > 0) {
    const missingAssetEvidence = deliveryIntegrityEvidence.filter((item) =>
      item.symbol === "delivery-integrity:missing-asset" ||
      item.symbol === "delivery-integrity:uncommitted-asset"
    );
    const historyRewriteEvidence = deliveryIntegrityEvidence.filter((item) =>
      item.symbol === "delivery-integrity:history-rewrite"
    );
    const deliveryIntegrity = makeScenario(
      intentId,
      "delivery-integrity",
      "failure",
      "critical",
      "Committed artifacts and validation history remain intact",
      uniqueStrings([
        missingAssetEvidence.length > 0
          ? "Prepare a clean checkout of the changed commit without untracked workspace files."
          : "Inspect the changed validation or release workflow from a clean branch checkout.",
        historyRewriteEvidence.length > 0
          ? "Preserve the branch tip and commit graph before evaluating the changed workflow."
          : "Use the repository's normal build, bundle, or export contract.",
      ]),
      uniqueStrings([
        missingAssetEvidence.length > 0
          ? "Resolve every changed literal local asset reference against the committed head, then run the repository build, bundle, or export command."
          : "Run the repository-owned validation path without allowing it to replace branch commits.",
        historyRewriteEvidence.length > 0
          ? "Inspect the exact workflow commands that reset, commit, restore, or force-push the checked-out branch."
          : "Inspect the produced artifact from a clean checkout rather than the current workspace alone.",
      ]),
      uniqueStrings([
        missingAssetEvidence.length > 0
          ? "Verify every referenced local asset exists in the committed head and is included in the produced artifact."
          : "Verify the produced artifact contains every changed runtime dependency.",
        historyRewriteEvidence.length > 0
          ? "Verify validation and release jobs leave the pull request branch tip and commit history unchanged."
          : "Verify the clean-checkout artifact matches the branch being reviewed.",
      ]),
      uniqueStrings([
        missingAssetEvidence.some((item) => item.symbol === "delivery-integrity:uncommitted-asset")
          ? "Asset present only in the local workspace"
          : "Asset absent from a clean checkout",
        historyRewriteEvidence.length > 0 ? "Validation job rewrites branch history" : "Bundle omits a referenced asset",
      ]),
      deliveryIntegrityEvidence,
    );
    deliveryIntegrity.rationale =
      "The changed source or workflow can produce a branch that works locally but cannot be reproduced safely from the committed review evidence; resolve this delivery blocker before optional product automation.";
    scenarios.push(deliveryIntegrity);
  }

  const retiredSurfaceEvidence = productEvidence.filter((item) =>
    item.kind === "diff" &&
    item.side === "base" &&
    item.relation === "direct" &&
    /removed user-facing surface/i.test(item.value)
  );
  if (retiredSurfaceEvidence.length > 0) {
    const replacementOutcomeStages = productLifecycle
      .filter((stage) => stage.kind === "observable-outcome")
      .filter((stage) => hasActionableLocatedDiffEvidence(stage.evidence))
      .filter(isMateriallyObservableOutcomeStage);
    const replacementEvidence = replacementOutcomeStages.flatMap((stage) => stage.evidence);
    const retirement = makeScenario(
      intentId,
      "retired-surface-contract",
      "boundary",
      "critical",
      "Retired behavior remains absent while replacement stays available",
      [
        "Prepare the retired direct entry and the supported replacement entry.",
      ],
      [
        "Attempt to open the retired entry through a direct path and any remaining navigation reference.",
        "Enter the supported replacement through its normal user-facing path.",
      ],
      uniqueStrings([
        "Verify the obsolete entry or surface remains unavailable and no stale navigation exposes it.",
        ...replacementOutcomeStages.map(assertionForStage),
      ]),
      ["Direct access to the retired entry", "Stale bookmark or navigation reference", "Supported replacement entry"],
      uniqueEvidence([...retiredSurfaceEvidence, ...replacementEvidence]),
    );
    retirement.rationale =
      "The diff removes a user-facing surface and exposes replacement UI evidence, so QA should prove intentional absence without resurrecting the deleted route as a regression target.";
    scenarios.push(retirement);
  }

  const analysisRuleEvidence = evidence.filter((item) => item.sourceRole === "analysis-rule");
  if (analysisRuleEvidence.length > 0) {
    scenarios.push(makeScenario(
      intentId,
      "analysis-rule-controls",
      "boundary",
      "recommended",
      "Changed analysis rule positive and negative controls",
      [
        "Prepare one minimal fixture that should match the changed rule and one unrelated fixture that repeats only its vocabulary.",
        "Preserve an existing fixture for a neighboring rule as a regression control.",
      ],
      [
        "Run the repository's analyzer or benchmark against all three fixtures.",
        "Inspect the exact finding or QA scenario emitted for each fixture.",
      ],
      [
        "Verify the intended source shape emits the expected finding or scenario with located evidence.",
        "Verify vocabulary inside rule definitions, strings, comments, and unrelated source does not become product behavior.",
        "Verify the neighboring rule keeps its previous result.",
      ],
      ["Rule vocabulary without behavior", "Adjacent rule regression", "Removed rule evidence"],
      analysisRuleEvidence,
    ));
  }

  const commandEvidence = evidence.filter((item) => item.sourceRole === "command");
  if (commandEvidence.length > 0) {
    const commandTargets = uniqueStrings(commandEvidence.map((item) => item.symbol ?? "").filter(Boolean)).slice(0, 4);
    scenarios.push(makeScenario(
      intentId,
      "cli-command-contract",
      "failure",
      "recommended",
      "Changed CLI arguments, output, and exit behavior",
      [
        `Prepare valid, missing, and invalid inputs for ${commandTargets.length > 0 ? commandTargets.join(", ") : "the changed command surface"}.`,
        "Prepare a temporary output location so command side effects can be inspected without modifying the repository.",
      ],
      [
        "Run the changed command with valid arguments and every changed option.",
        "Repeat with missing or invalid arguments and an unwritable or conflicting output target when applicable.",
      ],
      [
        "Verify valid input produces the documented stdout or file output and exits successfully.",
        "Verify invalid input produces actionable stderr, exits non-zero, and leaves no partial output.",
      ],
      ["Missing argument", "Unknown option", "Conflicting output", "Repeated invocation"],
      commandEvidence,
    ));
  }

  const removedGuardEvidence = evidence.filter((item) =>
    item.kind === "diff" &&
    item.side === "base" &&
    item.relation === "direct" &&
    (item.sourceRole === undefined || item.sourceRole === "product" || item.sourceRole === "configuration") &&
    /guard|validat|permission|authoriz|authent|allowed|denied|protected/i.test(`${item.symbol ?? ""} ${item.value}`)
  );
  const removedConfigurationGuardEvidence = removedGuardEvidence.filter(isConfigurationGuardEvidence);
  const removedAccessGuardEvidence = removedGuardEvidence.filter((item) => !isConfigurationGuardEvidence(item));
  if (removedConfigurationGuardEvidence.length > 0) {
    scenarios.push(makeScenario(intentId, "changed-configuration-guard", "failure", "critical", "Changed configuration or release guard", [
      "Prepare the supported local, development, QA, and production configuration variants.",
      "Prepare invalid release values that the previous guard rejected.",
    ], [
      "Build or evaluate each supported environment through the changed configuration path.",
      "Repeat with production endpoints, channels, or identifiers in a non-production build and with invalid production values.",
    ], [
      "Verify every supported environment resolves to its intended endpoints, channel, and application identity.",
      "Verify invalid or unsafe release configuration remains rejected by an intentional replacement guard.",
    ], ["QA using production services", "Wrong update channel", "Missing environment value"], removedConfigurationGuardEvidence));
  }
  if (removedAccessGuardEvidence.length > 0) {
    scenarios.push(makeScenario(intentId, "removed-guard", "failure", "critical", "Removed guard or validation behavior", [
      "Prepare valid, invalid, unauthorized, and previously rejected inputs or identities.",
    ], [
      "Repeat the changed behavior for each state that the removed guard previously handled.",
      "Attempt the same operation through every affected entry point.",
    ], [
      "Verify invalid or unauthorized behavior remains blocked by an intentional replacement.",
      "Verify valid behavior still succeeds without bypassing required validation.",
    ], ["Removed validation", "Unauthorized access", "Alternative entry point"], removedAccessGuardEvidence));
  }

  const changedAccessEvidence = evidence.filter((item) =>
    item.kind === "diff" &&
    item.side === "head" &&
    item.relation === "direct" &&
    (item.sourceRole === undefined || item.sourceRole === "product") &&
    /public access|protected access|unauthenticated|authentication boundary/i.test(item.value)
  );
  if (changedAccessEvidence.length > 0) {
    scenarios.push(makeScenario(intentId, "access-boundary", "failure", "recommended", "Public and protected entry access", [
      "Prepare authenticated and unauthenticated sessions for every changed entry path.",
    ], [
      "Open each changed public path without a session and repeat with an authenticated session.",
      "Open the matching protected path without a session.",
    ], [
      "Verify public pages and their required assets remain available without authentication.",
      "Verify protected pages still require the intended authentication boundary.",
    ], ["Public asset request", "Expired session", "Direct protected deep link"], changedAccessEvidence));
  }

  const productConditionLifecycle = productLifecycle.filter((stage) => stage.kind === "condition");
  const presentationConditionPattern = /color|theme|style|class|layout|size|width|height|dark|light/i;
  const matchedConditionEvidence = uniqueEvidence(
    productConditionLifecycle
      .filter((stage) => hasActionableLocatedDiffEvidence(stage.evidence))
      .filter((stage) => {
        const searchable = `${stage.label} ${stage.evidence.map((item) => item.symbol ?? item.value).join(" ")}`;
        return !presentationConditionPattern.test(searchable);
      })
      .flatMap((stage) => stage.evidence),
  ).slice(0, 6);
  const changedConditionFiles = new Set(
    matchedConditionEvidence.map((item) => item.file).filter((file): file is string => Boolean(file)),
  );
  const changedConditionEvidence = uniqueEvidence([
    ...matchedConditionEvidence,
    ...productLifecycle
      .filter((stage) => stage.kind === "observable-outcome")
      .flatMap((stage) => stage.evidence)
      .filter((item) => Boolean(item.file && changedConditionFiles.has(item.file))),
  ]);
  const hasUiProductEvidence = productEvidence.some(isUiBehaviorEvidence);
  if (matchedConditionEvidence.length > 0 && hasUiProductEvidence &&
    !/toggle|enable|disable|permission|authoriz|auth|guard/.test(searchable)) {
    scenarios.push(makeScenario(intentId, "conditional-fallback", "state-transition", "recommended", "Changed conditional state and fallback", [
      "Prepare the changed condition as true and false, including loading, unknown, or empty state when the diff exposes one.",
    ], [
      "Enter the affected surface for each changed condition branch.",
      "Change the condition and re-enter the surface to expose stale branch state.",
    ], [
      "Verify each condition shows only its intended action and observable copy.",
      "Verify the fallback branch does not leak the changed action or duplicate its side effects.",
    ], ["Condition false", "Loading or unknown state", "Empty collection", "Re-entry"], changedConditionEvidence));
  }

  const validationTimingEvidence = evidence.filter((item) =>
    item.kind === "diff" &&
    item.side === "head" &&
    item.relation === "direct" &&
    (item.sourceRole === undefined || item.sourceRole === "product") &&
    /changed form validation timing from/i.test(item.value)
  );
  if (validationTimingEvidence.length > 0) {
    scenarios.push(makeScenario(
      intentId,
      "validation-timing",
      "state-transition",
      "critical",
      "Validation timing across edit, blur, correction, and submit",
      [
        "Prepare an initially untouched field with one invalid value and one valid correction.",
        "Keep the normal form submission path available as a final validation boundary.",
      ],
      [
        "Type an incomplete value before the configured validation trigger, then leave the field.",
        "Correct the value after the first validation result and submit the form.",
      ],
      [
        "Verify validation feedback stays hidden before its configured trigger and appears after the invalid field crosses that boundary.",
        "Verify correcting the value clears stale feedback and form submission still validates every required field.",
      ],
      ["Initial typing", "First blur", "Correction after error", "Direct submission"],
      validationTimingEvidence,
    ));
  }

  const destinationParameterEvidence = evidence.filter((item) =>
    item.kind === "diff" &&
    (item.sourceRole === undefined || item.sourceRole === "product") &&
    item.file &&
    item.startLine !== undefined &&
    /urlsearchparams|searchparams|query|location\.href|window\.location|destination|redirect/i.test(`${item.symbol ?? ""} ${item.value}`)
  );
  const queryEvidenceByKey = new Map<string, ChangeIntentEvidence[]>();
  for (const item of destinationParameterEvidence) {
    if (item.side && item.side !== "head") continue;
    const key = item.value.match(/query parameter "([^"]+)"/i)?.[1];
    if (!key) continue;
    const items = queryEvidenceByKey.get(key) ?? [];
    items.push(item);
    queryEvidenceByKey.set(key, items);
  }
  const synchronizedQueryKeys = [...queryEvidenceByKey.entries()]
    .filter(([, items]) =>
      items.some((item) => /\breads query parameter\b/i.test(item.value)) &&
      items.some((item) => /\b(?:writes|removes) query parameter\b/i.test(item.value))
    )
    .map(([key]) => key);
  if (synchronizedQueryKeys.length > 0) {
    const synchronizedFiles = new Set(synchronizedQueryKeys.flatMap((key) =>
      (queryEvidenceByKey.get(key) ?? []).map((item) => item.file).filter((file): file is string => Boolean(file))
    ));
    const urlStateEvidence = uniqueEvidence([
      ...synchronizedQueryKeys.flatMap((key) => queryEvidenceByKey.get(key) ?? []),
      ...evidence.filter((item) =>
        item.side === "head" &&
        Boolean(item.file && synchronizedFiles.has(item.file)) &&
        /allowed UI state values/i.test(item.value)
      ),
    ]);
    scenarios.push(makeScenario(intentId, "url-backed-state", "state-transition", "recommended", "URL-backed state restoration and fallback", [
      `Prepare valid, missing, and invalid values for ${synchronizedQueryKeys.map((key) => `"${key}"`).join(", ")}.`,
    ], [
      "Open the affected surface directly with each valid URL-backed state and reload it.",
      "Change the state through the UI, return to the default state, and then open an invalid value.",
    ], [
      "Verify direct entry and reload restore the selected state while UI changes update the URL.",
      "Verify the default state removes optional URL state and invalid values fall back safely.",
    ], ["Missing parameter", "Invalid value", "Reload", "Back and forward navigation"], urlStateEvidence));
  }
  if (destinationParameterEvidence.length > 0 && synchronizedQueryKeys.length === 0) {
    scenarios.push(makeScenario(intentId, "destination-parameters", "boundary", "recommended", "Destination path and query parameters", [
      "Prepare representative identifiers and conditionally included destination parameters.",
    ], [
      "Trigger the changed navigation for the primary state and each parameter branch supported by the diff.",
      "Repeat the navigation with missing optional data and encoded values.",
    ], [
      "Verify the destination path and required query parameters match the changed source values.",
      "Verify optional parameters appear only for their intended state and remain correctly encoded.",
    ], ["Missing optional parameter", "Encoded value", "Repeated navigation"], destinationParameterEvidence));
  }

  const instrumentationEvidence = scenarioEvidenceFor(
    productLifecycle,
    productEvidence,
    /instrumentation event/i,
  );
  if (instrumentationEvidence.length > 0) {
    scenarios.push(makeScenario(intentId, "instrumentation-contract", "failure", "critical", "Instrumentation event timing, payload, and duplication", [
      "Prepare the qualifying success state and the nearest failure, cancellation, or denied state.",
      "Record the emitted event name and payload without sending production analytics.",
    ], [
      "Complete the changed behavior once in the qualifying state.",
      "Repeat the render, callback, or retry path, then exercise the non-qualifying state.",
    ], [
      "Verify the intended event is emitted once at the changed behavior boundary with the expected payload.",
      "Verify retries or re-renders do not duplicate it and non-qualifying states do not emit it.",
    ], ["Duplicate callback", "Retry or re-render", "Failure before completion", "Missing optional payload"], instrumentationEvidence));
  }

  const calendarEvidence = scenarioEvidenceFor(
    productLifecycle,
    productEvidence,
    /schedul|reminder|tomorrow|timezone|recurr|cron|deadline|dueat|duedate|starts?at|ends?at/i,
  );
  if (calendarEvidence.length > 0) {
    scenarios.push(makeScenario(intentId, "calendar-boundary", "boundary", "critical", "Scheduling, calendar, and duplicate boundary", [
      "Prepare records near day, month, and timezone boundaries.",
    ], [
      "Repeat the changed scheduling action after its source time or date changes.",
      "Repeat the action without changing source data to expose duplicate side effects.",
    ], [
      "Verify the calculated date and time remain correct across boundaries.",
      "Verify stale or duplicate schedules are replaced, preserved, or rejected intentionally.",
    ], ["Timezone change", "Day rollover", "Duplicate invocation"], calendarEvidence));
  }

  const asyncLifecycleGroups = groupAsyncLifecycleEvidence(productEvidence);
  const asyncLifecycleRoles = new Set(asyncLifecycleGroups.keys());
  const hasDispatch = asyncLifecycleRoles.has("dispatch");
  const hasState = asyncLifecycleRoles.has("state");
  const hasCompletion = asyncLifecycleRoles.has("completion");
  const hasConsistency = asyncLifecycleRoles.has("consistency");
  const hasAsyncLifecycleContract = (
    hasCompletion && (hasDispatch || hasState || hasConsistency)
  ) || (
    hasConsistency && (hasDispatch || hasState)
  );
  if (hasAsyncLifecycleContract) {
    const asyncEvidence = uniqueEvidence(
      [...asyncLifecycleGroups.values()].flatMap((items) => items.slice(0, 2)),
    );
    const symbolsFor = (role: AsyncLifecycleRole): string[] =>
      (asyncLifecycleGroups.get(role) ?? [])
        .map((item) => item.symbol?.toLowerCase())
        .filter((symbol): symbol is string => Boolean(symbol));
    const stateSymbols = symbolsFor("state");
    const completionSymbols = symbolsFor("completion");
    const consistencySymbols = symbolsFor("consistency");
    const hasIntermediateState = stateSymbols.some((symbol) =>
      /pending|queued|processing|in[_-]?progress/.test(symbol)
    );
    const hasTerminalState = stateSymbols.some((symbol) =>
      /completed|succeeded|failed|cancelled|canceled/.test(symbol)
    );
    const hasFailureState = stateSymbols.some((symbol) =>
      /failed|cancelled|canceled/.test(symbol)
    ) || completionSymbols.some((symbol) => /nack|failure|retry/.test(symbol));
    const hasAcknowledgement = completionSymbols.some((symbol) =>
      /ack|acknowledge|nack/.test(symbol)
    );
    const hasDuplicateProtection = consistencySymbols.some((symbol) =>
      /idempot|deduplicat|duplicate/.test(symbol)
    );
    const hasStaleProtection = consistencySymbols.some((symbol) =>
      /stale|version|revision|compareandset/.test(symbol)
    );
    const hasOrderingPath = hasDispatch && hasState && hasCompletion;
    const asyncScenario = makeScenario(
      intentId,
      "async-lifecycle-ordering",
      "state-transition",
      "critical",
      "Asynchronous lifecycle ordering and result delivery",
      uniqueStrings([
        "Prepare one identifiable work item represented by the changed code.",
        hasState ? "Prepare the asynchronous states represented by the changed code." : undefined,
        hasCompletion
          ? "Prepare the result or callback delivery represented by the changed code."
          : undefined,
        hasFailureState ? "Prepare the changed terminal failure outcome." : undefined,
        hasDuplicateProtection ? "Prepare repeated delivery with the same work identity." : undefined,
        hasStaleProtection ? "Prepare older and newer result versions for the same work item." : undefined,
      ].filter((item): item is string => Boolean(item))),
      uniqueStrings([
        hasDispatch
          ? "Trigger the changed dispatch once and capture its work identity."
          : "Enter the changed asynchronous lifecycle through its normal repository entry point.",
        hasState ? "Move the work item through the states represented by the changed code." : undefined,
        hasCompletion ? "Deliver the changed result, callback, or acknowledgement." : undefined,
        hasOrderingPath && hasIntermediateState
          ? "Deliver the result before and after the intermediate state is persisted."
          : undefined,
        hasDuplicateProtection
          ? "Replay the same result or delivery without changing its identity."
          : undefined,
        hasStaleProtection ? "Deliver the older result after the newer result." : undefined,
      ].filter((item): item is string => Boolean(item))),
      uniqueStrings([
        hasState && hasTerminalState
          ? "Verify accepted work reaches the supported terminal state and cannot regress to an earlier state."
          : undefined,
        hasState && !hasTerminalState
          ? "Verify the changed asynchronous state remains observable."
          : undefined,
        hasOrderingPath && hasIntermediateState
          ? "Verify an early or delayed result is not lost."
          : undefined,
        hasFailureState
          ? "Verify the changed failed or cancelled result remains observable."
          : undefined,
        hasAcknowledgement
          ? "Verify acknowledgement occurs only after the changed result handling reaches its durable outcome."
          : undefined,
        hasDuplicateProtection
          ? "Verify repeated delivery creates one durable effect."
          : undefined,
        hasStaleProtection
          ? "Verify an older result cannot overwrite the newer persisted state."
          : undefined,
      ].filter((item): item is string => Boolean(item))),
      uniqueStrings([
        hasOrderingPath && hasIntermediateState ? "Result before pending persistence" : undefined,
        hasAcknowledgement ? "Ambiguous acknowledgement" : undefined,
        hasDuplicateProtection ? "Repeated delivery" : undefined,
        hasStaleProtection ? "Stale result" : undefined,
        hasFailureState ? "Terminal failure" : undefined,
      ].filter((item): item is string => Boolean(item))),
      asyncEvidence,
    );
    asyncScenario.rationale =
      "Located diff evidence connects multiple asynchronous lifecycle roles, so the selected ordering and delivery risks are change-backed rather than keyword guesses.";
    scenarios.push(asyncScenario);
  }

  if (/toggle|enable|disable|permission|authoriz|auth|guard/.test(searchable)) {
    scenarios.push(makeScenario(intentId, "guard-state", "state-transition", "critical", "Disabled, denied, and re-enabled state", [
      "Prepare allowed, disabled, and denied states for the changed condition.",
    ], [
      "Run the behavior while the condition is disabled or denied.",
      "Enable or restore the condition and repeat the behavior.",
    ], [
      "Verify no protected side effect occurs while blocked.",
      "Verify re-enabling produces one correct side effect without stale state.",
    ], ["Permission denied", "Feature disabled", "State restored"], scenarioEvidenceFor(productLifecycle, productEvidence, /toggle|enable|disable|permission|authoriz|auth|guard/i)));
  }

  // navigation.setOptions configures the current screen's header, it does not
  // route anywhere — exclude both its raw form and its behavioral label.
  const entryRoutingSearchable = searchable
    .replaceAll("navigation.setoptions", "")
    .replaceAll("update the navigation options state", "");
  const explicitOpenDestination = /\bopen\b[^.;]{0,80}\b(?:linked|destination|route|screen|page|detail|summary)\b/.test(
    entryRoutingSearchable,
  );
  if (/navigat|redirect|route|deep.?link|payload|destination/.test(entryRoutingSearchable) || explicitOpenDestination) {
    const routingEvidencePattern = explicitOpenDestination
      ? /open|navigat|redirect|route|deep.?link|payload|destination/i
      : /navigat|redirect|route|deep.?link|payload|destination/i;
    const routingEvidence = scenarioEvidenceFor(
      productLifecycle,
      productEvidence,
      routingEvidencePattern,
      /navigation\.setoptions/i,
    );
    scenarios.push(makeScenario(intentId, "entry-routing", "failure", "critical", "Entry payload and destination routing", [
      "Prepare valid, missing, and stale entry payloads.",
    ], [
      "Enter through the changed external or internal trigger.",
      "Repeat with missing or invalid destination context.",
    ], [
      "Verify a valid payload opens the matching destination and state.",
      "Verify invalid context fails safely without opening unrelated data.",
    ], ["Missing payload", "Stale identifier", "Repeated entry"], routingEvidence));
  }

  const networkSearchable = searchable.replace(/\b(?:export|package|public)\s+(?:root\s+)?api\b/gi, "");
  const networkEvidence = scenarioEvidenceFor(
    productLifecycle,
    productEvidence,
    /fetch|request|network|endpoint|api|mutation|response|timeout/i,
  );
  if (/fetch|request|network|endpoint|api|mutation|response|timeout/.test(networkSearchable)) {
    scenarios.push(makeScenario(intentId, "network-failure", "failure", "recommended", "Failure, timeout, and retry handling", [
      "Prepare success, empty, unauthorized, timeout, and server-error responses.",
    ], [
      "Run the changed behavior for each reachable response.",
      "Retry after a transient failure when the product supports retry.",
    ], [
      "Verify each response produces the intended visible or persisted state.",
      "Verify retries do not duplicate requests or side effects.",
    ], ["Unauthorized", "Timeout", "Server error", "Duplicate retry"], networkEvidence));
  }

  const shareEvidence = scenarioEvidenceFor(
    productLifecycle,
    productEvidence,
    /navigator\.share|navigator\.clipboard|\bclipboard\b|\baborterror\b|(?:^|[\s.])(?:share|copy)(?:\s|\(|\.|$)/i,
  );
  if (hasActionableLocatedDiffEvidence(shareEvidence)) {
    scenarios.push(makeScenario(intentId, "share-fallback", "failure", "recommended", "Share completion, cancellation, and fallback", [
      "Prepare a device with native sharing, a cancelled share, and an environment without native sharing.",
    ], [
      "Trigger the changed share action in each capability state.",
      "Inspect the exact destination passed to native sharing or the fallback clipboard action.",
    ], [
      "Verify completion feedback appears only after a completed share or successful fallback.",
      "Verify cancellation stays silent and fallback copies the intended canonical destination without leaking unrelated context.",
    ], ["User cancels the share sheet", "Native sharing unavailable", "Clipboard write fails", "Unrelated query context"], shareEvidence));
  }

  const mediaEvidence = scenarioEvidenceFor(
    productLifecycle,
    productEvidence,
    /<audio\b|<video\b|\bhtmlmediaelement\b|(?:^|[\s.])(?:audio|video|media|play|pause|ended|currenttime)(?:\s|\(|\.|$)/i,
  );
  if (hasActionableLocatedDiffEvidence(mediaEvidence)) {
    scenarios.push(makeScenario(intentId, "media-state", "state-transition", "recommended", "Media start, stop, completion, and restart state", [
      "Prepare a loadable media source and a blocked or failed playback state.",
    ], [
      "Start playback, stop it, start again, and let it reach completion.",
      "Repeat when playback is rejected or the media cannot load.",
    ], [
      "Verify visible controls reflect the real playback state after every transition.",
      "Verify completion and failure leave the control in a recoverable state without duplicate playback.",
    ], ["Playback permission rejected", "Media load failure", "Repeated start", "Natural completion"], mediaEvidence));
  }

  const availabilityEvidence = evidence.filter((item) =>
    item.kind === "diff" &&
    item.side === "head" &&
    item.relation === "direct" &&
    (item.sourceRole === undefined || item.sourceRole === "product") &&
    /availability window|exposure window|expiry boundary/i.test(item.value)
  );
  if (availabilityEvidence.length > 0) {
    scenarios.push(makeScenario(intentId, "availability-window", "boundary", "recommended", "Availability window boundaries", [
      "Prepare times immediately before, at, during, and immediately after the changed availability window.",
    ], [
      "Enter the affected surface at each boundary time.",
      "Repeat through direct navigation and the normal product entry point.",
    ], [
      "Verify the feature is unavailable before the start and after the end.",
      "Verify the feature is available at the documented inclusive boundaries without timezone drift.",
    ], ["One second before start", "Exact start", "Exact end", "One second after end", "Timezone offset"], availabilityEvidence));
  }

  const scopedStorageEvidence = scenarioEvidenceFor(
    productLifecycle,
    productEvidence,
    /sessionstorage|localstorage|\.setitem|\.removeitem|persisted context/i,
  );
  if (scopedStorageEvidence.length > 0) {
    scenarios.push(makeScenario(intentId, "scoped-storage", "state-transition", "recommended", "Scoped persisted context isolation and cleanup", [
      "Prepare two distinct entity or user contexts plus invalid and stale stored data.",
    ], [
      "Capture context for the first identity, then enter and complete the second identity flow.",
      "Complete the matching first flow and re-enter it afterward.",
    ], [
      "Verify stored context is consumed only by its matching identity and malformed data is ignored safely.",
      "Verify successful completion clears only the matching context and stale context cannot leak into a later flow.",
    ], ["Mismatched identity", "Malformed storage", "Repeated completion", "Second tab or re-entry"], scopedStorageEvidence));
  }

  const stateReentryEvidence = scenarioEvidenceFor(
    productLifecycle,
    productEvidence,
    /sync|persist|storage|cache|reload|re.?entry|save|store/i,
  );
  if (/sync|persist|storage|cache|reload|re.?entry|save|store/.test(searchable)) {
    scenarios.push(makeScenario(intentId, "state-reentry", "state-transition", "recommended", "Re-entry and stale state recovery", [
      "Prepare current and stale persisted state.",
    ], [
      "Run the changed mutation and leave the affected surface.",
      "Reload or re-enter through the normal entry point.",
    ], [
      "Verify the latest state survives or is invalidated intentionally.",
      "Verify stale state cannot overwrite the changed result.",
    ], ["Stale cache", "App restart", "Repeated synchronization"], stateReentryEvidence));
  }

  return rankIntentQaScenarios(uniqueScenarios(scenarios)).slice(0, maxQaScenariosPerIntent);
}

function isMateriallyObservableOutcomeStage(stage: BehaviorLifecycleStage): boolean {
  const label = stripTerminalPunctuation(stage.label);
  if (/^Show\s+.+/i.test(label)) {
    return true;
  }
  if (/^Expose accessibility label\s+.+/i.test(label)) {
    return true;
  }
  if (/^Observe\s+(?!the result of\b).+/i.test(label)) {
    return true;
  }
  return stage.symbol !== undefined &&
    /(?:navigate|redirect|router\.(?:push|replace)|openurl|openlink)/i.test(stage.symbol);
}

function lifecycleEvidence(
  lifecycle: BehaviorLifecycleStage[],
  fallback: ChangeIntentEvidence[],
): ChangeIntentEvidence[] {
  const evidence = uniqueEvidence(lifecycle.flatMap((stage) => stage.evidence));
  return uniqueEvidence([...evidence, ...fallback]);
}

function scenarioEvidenceFor(
  lifecycle: BehaviorLifecycleStage[],
  fallback: ChangeIntentEvidence[],
  pattern: RegExp,
  excludePattern?: RegExp,
): ChangeIntentEvidence[] {
  const matching = lifecycle
    .filter((stage) => {
      const searchable = `${stage.label} ${stage.evidence.map((item) => item.symbol ?? item.value).join(" ")}`;
      return pattern.test(searchable) && !excludePattern?.test(searchable);
    })
    .flatMap((stage) => stage.evidence);
  const matchingDiff = fallback.filter(
    (item) => {
      const searchable = `${item.symbol ?? ""} ${item.value}`;
      return item.kind === "diff" && pattern.test(searchable) && !excludePattern?.test(searchable);
    },
  );
  return uniqueEvidence([...matching, ...matchingDiff]).slice(0, 6);
}

function hasActionableLocatedDiffEvidence(evidence: ChangeIntentEvidence[]): boolean {
  return evidence.some((item) =>
    item.kind === "diff" &&
    item.file &&
    item.startLine !== undefined &&
    item.relation !== "contextual"
  );
}

function isConfigurationGuardEvidence(evidence: ChangeIntentEvidence): boolean {
  return /(?:^|\/)(?:app|build|release|env|eas|expo|vite|webpack|rollup)?[.-]?config\.[^/]+$/i.test(evidence.file ?? "") ||
    /release|build|environment|\benv\b|config/i.test(`${evidence.symbol ?? ""} ${evidence.value}`);
}

function selectPrimaryLifecycleSteps(
  lifecycle: BehaviorLifecycleStage[],
  intentKeywords: string[],
): string[] {
  const hasCommitBackedAction = lifecycle.some((stage) =>
    stage.kind === "action" && stage.evidence.some((item) => item.kind === "commit"),
  );
  const limits: Partial<Record<BehaviorLifecycleStageKind, number>> = {
    trigger: 1,
    action: 1,
  };
  const counts = new Map<BehaviorLifecycleStageKind, number>();
  const steps: string[] = [];
  for (const stage of lifecycle) {
    if (
      !hasActionableLocatedDiffEvidence(stage.evidence) &&
      stage.evidence.every((item) => item.kind === "commit") &&
      (isContextOnlyCommitLifecycleStep(stage.label) || isCommitOnlyCausalTrigger(stage))
    ) {
      continue;
    }
    if (hasCommitBackedAction && isImplementationShapedTriggerStage(stage, intentKeywords)) {
      continue;
    }
    const limit = limits[stage.kind] ?? 0;
    const count = counts.get(stage.kind) ?? 0;
    if (limit === 0 || count >= limit || isImplementationOnlyLifecycleStep(stage.label)) {
      continue;
    }
    if (steps.some((step) => lifecycleStepsDescribeSameAction(step, stage.label))) {
      continue;
    }
    counts.set(stage.kind, count + 1);
    steps.push(stage.label);
  }
  return steps;
}

function isContextOnlyCommitLifecycleStep(label: string): boolean {
  return /\b(?:affected|changed|intended|related)\s+(?:product\s+)?(?:behavior|flow|result|state|surface|view)\b/i.test(label);
}

function isCommitOnlyCausalTrigger(stage: BehaviorLifecycleStage): boolean {
  return stage.kind === "trigger" &&
    stage.evidence.length > 0 &&
    stage.evidence.every((item) => item.kind === "commit") &&
    /^(?:after|before|if|once|when|while)\b/i.test(stage.label);
}

function isImplementationShapedTriggerStage(
  stage: BehaviorLifecycleStage,
  intentKeywords: string[],
): boolean {
  if (stage.kind !== "trigger" || stage.evidence.some((item) => item.kind === "commit")) {
    return false;
  }
  if (/^Trigger\s+(?:set|handle|use|update|dispatch|emit|mutate|invoke|call)\b/i.test(stage.label)) {
    return true;
  }
  const callbackShaped = /^Handle\b/i.test(stage.label) ||
    stage.evidence.some((item) => item.kind === "diff" && /^on[A-Z]/.test(item.symbol ?? ""));
  return callbackShaped && !callbackTriggerMatchesIntent(stage, intentKeywords);
}

function callbackTriggerMatchesIntent(
  stage: BehaviorLifecycleStage,
  intentKeywords: string[],
): boolean {
  return callbackWordsMatchIntent(
    stage.label,
    stage.evidence.map((item) => item.symbol ?? ""),
    intentKeywords,
  );
}

function isUnalignedGenericCallbackSignal(
  signal: CodeBehaviorSignal,
  intentKeywords: string[],
): boolean {
  if (signal.kind !== "trigger") {
    return false;
  }
  const callbackShaped = /^Handle\b/i.test(signal.label) || /^on[A-Z]/.test(signal.symbol);
  return callbackShaped && !callbackWordsMatchIntent(signal.label, [signal.symbol], intentKeywords);
}

function callbackWordsMatchIntent(
  label: string,
  symbols: string[],
  intentKeywords: string[],
): boolean {
  const genericWords = new Set(["handle", "trigger"]);
  const triggerTokens = new Set(
    [...normalizedWords(label), ...symbols.flatMap(normalizedWords)]
      .map(normalizeLifecycleAlignmentToken)
      .filter((word) => word.length >= 3 && !genericWords.has(word)),
  );
  const intentTokens = new Set(intentKeywords.map(normalizeLifecycleAlignmentToken));
  return [...triggerTokens].some((word) => intentTokens.has(word));
}

function normalizeLifecycleAlignmentToken(value: string): string {
  const token = normalizeToken(value);
  if (/^(?:close|dismiss|hide)$/.test(token)) return "close";
  if (/^(?:display|open|preview|render|reveal|show|view)$/.test(token)) return "view";
  if (/^(?:choose|pick|select)$/.test(token)) return "select";
  return token;
}

function isImplementationShapedStateChangeStage(stage: BehaviorLifecycleStage): boolean {
  if (stage.kind !== "state-change") {
    return false;
  }
  // Prefer the structural symbol over label text so behavioral phrasing of
  // the label cannot silently change this classification. The whole symbol
  // must start with a setter verb — "navigation.setOptions" is a member call
  // on a product object, not a bare state setter, and keeps its old standing.
  if (stage.symbol) {
    return /^(?:set|update|dispatch|emit|mutate|use)[A-Z0-9_]/.test(stage.symbol);
  }
  return /^Update state through `?(?:set|update|dispatch|emit|mutate|use)[A-Z0-9_]/.test(stage.label);
}

function isDurableStateChangeRequirement(stage: BehaviorLifecycleStage): boolean {
  return stage.kind === "state-change" &&
    !isImplementationShapedStateChangeStage(stage) &&
    /\b(?:cache|persist|re-?entry|reload|resync|retain|store|survive|sync)\b/i.test(stage.label);
}

function lifecycleStepsDescribeSameAction(left: string, right: string): boolean {
  const leftWords = meaningfulLifecycleWords(left);
  const rightWords = new Set(meaningfulLifecycleWords(right));
  return leftWords.some((word) => rightWords.has(word));
}

function lifecycleLabelsOverlap(left: string, right: string): boolean {
  const leftWords = meaningfulLifecycleWords(left);
  const rightWords = new Set(meaningfulLifecycleWords(right));
  const overlap = leftWords.filter((word) => rightWords.has(word));
  return overlap.length >= 2 || (leftWords.length === 1 && rightWords.size === 1 && overlap.length === 1);
}

function meaningfulLifecycleWords(value: string): string[] {
  const ignored = new Set([
    "activate", "action", "check", "complete", "execute", "handle", "invoke", "observe", "result", "run",
    "show", "start", "state", "trigger", "verify",
  ]);
  return normalizedWords(value).filter((word) => word.length >= 4 && !ignored.has(word));
}

function isImplementationOnlyLifecycleStep(label: string): boolean {
  const implementationNoun = "(?:helpers?|interfaces?|lookups?|modules?|types?|utilities)";
  return new RegExp(`^(?:add|extract|move|refactor|rename)\\b.*\\b${implementationNoun}\\b`, "i").test(label) ||
    new RegExp(`^(?:an?|the)\\b.*\\b${implementationNoun}\\.?$`, "i").test(label);
}

function makeScenario(
  intentId: string,
  key: string,
  kind: IntentQaScenarioKind,
  priority: IntentQaScenarioPriority,
  title: string,
  setup: string[],
  steps: string[],
  assertions: string[],
  edgeCases: string[],
  evidence: ChangeIntentEvidence[],
): IntentQaScenario {
  const preciseEvidence = hasActionableLocatedDiffEvidence(evidence);
  return {
    id: stableId("scenario", `${intentId}:${key}`),
    kind,
    priority: preciseEvidence ? priority : "recommended",
    title,
    rationale: "Deterministic lifecycle patterns indicate this failure or boundary axis is easy to miss in review.",
    setup,
    steps,
    assertions,
    edgeCases,
    evidence: evidence.slice(0, 6),
    confidence: preciseEvidence ? "medium" : "low",
    reviewRequired: true,
  };
}

interface QaAnnotationRiskScenario {
  symbol: string;
  risk: string;
  outcomes: string[];
  evidence: ChangeIntentEvidence[];
}

function collectQaSymbolAnnotationSignals(
  annotations: ChangedQaSymbolAnnotation[],
): CodeBehaviorSignal[] {
  const signals: CodeBehaviorSignal[] = [];
  for (const annotation of annotations) {
    for (const stage of annotation.stages) {
      const label = sentenceLabel(stage.label ?? codeSignalLabel(stage.kind, annotation.symbol));
      signals.push({
        kind: stage.kind,
        label,
        file: annotation.file,
        symbol: annotation.symbol,
        evidence: qaAnnotationDiffEvidence(
          annotation,
          `QAMap @qamapStage maps ${annotation.symbol} to ${stage.kind}${stage.label ? `: ${stage.label}` : ""}.`,
        ),
      });
    }
    for (const outcome of annotation.outcomes) {
      signals.push({
        kind: "observable-outcome",
        label: sentenceLabel(outcome.value),
        file: annotation.file,
        symbol: annotation.symbol,
        evidence: qaAnnotationDiffEvidence(
          annotation,
          `QAMap @qamapOutcome declares "${outcome.value}" for ${annotation.symbol}.`,
        ),
      });
    }
  }
  return signals;
}

function collectQaSymbolAnnotationEvidence(
  annotations: ChangedQaSymbolAnnotation[],
): ChangeIntentEvidence[] {
  const evidence: ChangeIntentEvidence[] = [];
  for (const annotation of annotations) {
    for (const flow of annotation.flows) {
      evidence.push(
        qaAnnotationDiffEvidence(
          annotation,
          `QAMap @qamapFlow links ${annotation.symbol} to flow "${flow.value}".`,
        ),
        qaAnnotationSourceEvidence(annotation, "@qamapFlow", flow.value, flow.line),
      );
    }
    for (const stage of annotation.stages) {
      evidence.push(qaAnnotationSourceEvidence(annotation, "@qamapStage", stage.value, stage.line));
    }
    for (const outcome of annotation.outcomes) {
      evidence.push(qaAnnotationSourceEvidence(annotation, "@qamapOutcome", outcome.value, outcome.line));
    }
    for (const risk of annotation.risks) {
      evidence.push(qaAnnotationSourceEvidence(annotation, "@qamapRisk", risk.value, risk.line));
    }
  }
  return uniqueEvidence(evidence);
}

function collectQaSymbolAnnotationRiskEvidence(
  annotations: ChangedQaSymbolAnnotation[],
): ChangeIntentEvidence[] {
  const evidence: ChangeIntentEvidence[] = [];
  for (const annotation of annotations) {
    for (const risk of annotation.risks) {
      evidence.push(
        qaAnnotationDiffEvidence(
          annotation,
          `QAMap @qamapRisk declares "${risk.value}" for changed symbol ${annotation.symbol}.`,
        ),
        qaAnnotationSourceEvidence(annotation, "@qamapRisk", risk.value, risk.line),
      );
    }
  }
  return uniqueEvidence(evidence);
}

function qaAnnotationDiffEvidence(
  annotation: ChangedQaSymbolAnnotation,
  value: string,
): ChangeIntentEvidence {
  return {
    kind: "diff",
    value,
    sourceRole: "product",
    file: annotation.file,
    previousFile: annotation.previousFile,
    symbol: annotation.symbol,
    relation: "direct",
    side: "head",
    startLine: annotation.changedLine,
    endLine: annotation.changedLine,
    hunkHeader: annotation.hunkHeader,
  };
}

function qaAnnotationSourceEvidence(
  annotation: ChangedQaSymbolAnnotation,
  tag: "@qamapFlow" | "@qamapStage" | "@qamapOutcome" | "@qamapRisk",
  value: string,
  line: number,
): ChangeIntentEvidence {
  return {
    kind: "source",
    value: `${tag} ${value}`,
    sourceRole: "product",
    file: annotation.file,
    symbol: annotation.symbol,
    relation: "contextual",
    side: "head",
    startLine: line,
    endLine: line,
  };
}

function qaAnnotationRiskScenarios(evidence: ChangeIntentEvidence[]): QaAnnotationRiskScenario[] {
  const risks = evidence.filter((item) => item.kind === "source" && item.value.startsWith("@qamapRisk "));
  return risks.map((source) => {
    const risk = source.value.slice("@qamapRisk ".length).trim();
    const related = evidence.filter((item) =>
      item.file === source.file &&
      item.symbol === source.symbol &&
      (
        item.value === source.value ||
        (item.kind === "diff" && item.value.includes("@qamapRisk") && item.value.includes(`"${risk}"`))
      )
    );
    const outcomes = evidence
      .filter((item) =>
        item.kind === "source" &&
        item.file === source.file &&
        item.symbol === source.symbol &&
        item.value.startsWith("@qamapOutcome ")
      )
      .map((item) => item.value.slice("@qamapOutcome ".length).trim());
    return {
      symbol: source.symbol ?? "changed symbol",
      risk,
      outcomes: uniqueStrings(outcomes),
      evidence: uniqueEvidence(related),
    };
  });
}

function qaAnnotationRiskKind(risk: string): IntentQaScenarioKind {
  if (/pending|re-?entry|recover|stale|state|transition/i.test(risk)) {
    return "state-transition";
  }
  if (/denied|error|fail|invalid|reject|unauthor/i.test(risk)) {
    return "failure";
  }
  return "boundary";
}

function firstQaAnnotationFlow(evidence: ChangeIntentEvidence[]): string | undefined {
  const prefix = "@qamapFlow ";
  const source = evidence.find((item) => item.kind === "source" && item.value.startsWith(prefix));
  return source?.value.slice(prefix.length).trim() || undefined;
}

function summarizeQaSymbolAnnotations(
  annotations: ChangedQaSymbolAnnotation[],
  diagnosticCount: number,
): ChangeIntentSymbolAnnotationSummary {
  return {
    applied: annotations.length,
    files: uniqueStrings(annotations.map((annotation) => annotation.file)),
    symbols: uniqueStrings(annotations.map((annotation) => annotation.symbol)),
    flows: uniqueStrings(annotations.flatMap((annotation) => annotation.flows.map((flow) => flow.value))),
    diagnostics: diagnosticCount,
  };
}

function collectCodeBehaviorSignals(
  addedDiffText: Record<string, string>,
  addedDiffEvidence: AddedDiffEvidence,
  changedSourceRoles: ReturnType<typeof classifyChangedSourceRoles>,
): CodeBehaviorSignal[] {
  const signals: CodeBehaviorSignal[] = [];
  const locatedFiles = new Set<string>();
  for (const [file, hunks] of Object.entries(addedDiffEvidence)) {
    const sourceRole = changedSourceRoles[file]?.role ??
      classifyChangeSourceRole(file, diffTextForRoleClassification(hunks)).role;
    if (sourceRole !== "product") {
      continue;
    }
    locatedFiles.add(file);
    for (const hunk of hunks) {
      if (isFormattingOnlyHunk(hunk)) {
        continue;
      }
      collectTransformationContractSignals(signals, file, hunk);
      for (const line of hunk.lines) {
        collectCodeBehaviorSignalsFromText(signals, file, line.text, hunk, line.line);
      }
      collectRenderedMetadataSignals(signals, file, hunk);
    }
  }
  for (const [file, text] of Object.entries(addedDiffText)) {
    const sourceRole = changedSourceRoles[file]?.role ?? classifyChangeSourceRole(file, text).role;
    if (sourceRole !== "product" || locatedFiles.has(file)) {
      continue;
    }
    collectCodeBehaviorSignalsFromText(signals, file, text);
  }
  return selectCodeSignals(signals);
}

function collectTransformationContractSignals(
  signals: CodeBehaviorSignal[],
  file: string,
  hunk: AddedDiffHunk,
): void {
  if (!isTransformationSourcePath(file)) {
    return;
  }
  const declaration = hunk.lines
    .map((line) => ({
      line,
      match: line.text.match(
        /\b(?:function\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*(?:transform|parse|serializ|deserializ|format|map|convert|normaliz|encode|decode)[A-Za-z0-9_$]*|(?:transform|parse|serializ|deserializ|format|map|convert|normaliz|encode|decode)[A-Za-z0-9_$]*)\b/i,
      ),
    }))
    .find((candidate) => candidate.match);
  const symbol = declaration?.match?.[1];
  if (!declaration || !symbol) {
    return;
  }

  const actionLabel = `Transform representative input through \`${symbol}\`.`;
  signals.push({
    kind: "action",
    label: actionLabel,
    file,
    symbol,
    evidence: {
      ...codeSignalEvidence(actionLabel, file, symbol, hunk, declaration.line.line),
      relation: "direct",
    },
  });

  const returnIndex = hunk.lines.findIndex(
    (line, index) => index >= hunk.lines.indexOf(declaration.line) && /\breturn\s*\{/.test(line.text),
  );
  if (returnIndex < 0) {
    return;
  }
  const outputFields = uniqueStrings(
    hunk.lines
      .slice(returnIndex, returnIndex + 30)
      .map((line) => line.text.match(/^\s+([A-Za-z_$][\w$]*)\s*(?::|,)/)?.[1])
      .filter((field): field is string => Boolean(field) && field !== "type"),
  ).slice(0, 5);
  if (outputFields.length === 0) {
    return;
  }
  const outputLine = hunk.lines
    .slice(returnIndex, returnIndex + 30)
    .find((line) => outputFields.some((field) => line.text.includes(`${field}:`))) ?? declaration.line;
  const outcomeLabel =
    `Observe the transformed output from \`${symbol}\` with fields ${outputFields.map((field) => `\`${field}\``).join(", ")}.`;
  signals.push({
    kind: "observable-outcome",
    label: outcomeLabel,
    file,
    symbol: `${symbol}:output`,
    evidence: {
      ...codeSignalEvidence(outcomeLabel, file, `${symbol}:output`, hunk, outputLine.line),
      relation: "direct",
    },
  });
}

function collectRenderedMetadataSignals(
  signals: CodeBehaviorSignal[],
  file: string,
  hunk: AddedDiffHunk,
): void {
  const text = hunk.lines.map((line) => line.text).join("\n");
  const matcher =
    /\b(?:const|let|var)\s+(robots)\s*=\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(===|!==)\s*(true|false)\s*\?\s*["'`]([^"'`]+)["'`]/g;
  for (const match of text.matchAll(matcher)) {
    const metadataName = match[1];
    const subject = match[2];
    const operator = match[3] === "===" ? "equals" : "does not equal";
    const comparedValue = match[4];
    const metadataValue = match[5];
    const conditionLine = hunk.lines.find((candidate) =>
      candidate.text.includes(subject) && candidate.text.includes(comparedValue)
    )?.line ?? hunk.startLine;
    const outcomeLine = hunk.lines.find((candidate) => candidate.text.includes(metadataValue))?.line ?? conditionLine;
    const conditionLabel = `Check whether ${humanizeIdentifier(subject)} ${operator} ${comparedValue}.`;
    const outcomeLabel = `Observe ${humanizeIdentifier(metadataName)} metadata value ${metadataValue}.`;
    signals.push(
      {
        kind: "condition",
        label: conditionLabel,
        file,
        symbol: subject,
        evidence: {
          ...codeSignalEvidence(conditionLabel, file, subject, hunk, conditionLine),
          relation: "direct",
        },
      },
      {
        kind: "observable-outcome",
        label: outcomeLabel,
        file,
        symbol: `${metadataName}:${metadataValue}`,
        evidence: {
          ...codeSignalEvidence(outcomeLabel, file, metadataName, hunk, outcomeLine),
          relation: "direct",
        },
      },
    );
  }
}

function selectCodeSignals(signals: CodeBehaviorSignal[]): CodeBehaviorSignal[] {
  const unique = uniqueCodeSignals(signals);
  const selected: CodeBehaviorSignal[] = [];
  const selectedKeys = new Set<string>();
  const files = uniqueStrings(unique.map((signal) => signal.file));
  const kinds: BehaviorLifecycleStageKind[] = [
    "trigger",
    "condition",
    "state-change",
    "side-effect",
    "observable-outcome",
    "action",
  ];

  // Give every changed behavior file a chance to contribute each lifecycle
  // kind before a single large component consumes the global signal budget.
  for (const file of files) {
    for (const kind of kinds) {
      const signal = unique.find((candidate) => candidate.file === file && candidate.kind === kind);
      if (!signal) continue;
      const key = `${signal.kind}:${signal.file}:${signal.symbol}`;
      selected.push(signal);
      selectedKeys.add(key);
      if (selected.length >= maxSignals) return selected;
    }
  }
  for (const signal of unique) {
    const key = `${signal.kind}:${signal.file}:${signal.symbol}`;
    if (selectedKeys.has(key)) continue;
    selected.push(signal);
    if (selected.length >= maxSignals) break;
  }
  return selected;
}

function collectDiffRiskEvidence(
  addedDiffEvidence: AddedDiffEvidence,
  changedSourceRoles: ReturnType<typeof classifyChangedSourceRoles>,
): ChangeIntentEvidence[] {
  const evidence: ChangeIntentEvidence[] = [];
  for (const [file, hunks] of Object.entries(addedDiffEvidence)) {
    const sourceRole = changedSourceRoles[file]?.role ??
      classifyChangeSourceRole(file, diffTextForRoleClassification(hunks)).role;
    if (sourceRole === "test" || sourceRole === "documentation" || sourceRole === "generated") {
      continue;
    }
    if (sourceRole === "analysis-rule") {
      evidence.push(...collectAnalysisRuleDiffEvidence(file, hunks));
      continue;
    }
    if (sourceRole === "command") {
      evidence.push(...collectCommandDiffEvidence(file, hunks));
      continue;
    }
    for (const hunk of hunks) {
      if (isFormattingOnlyHunk(hunk)) {
        continue;
      }
      const validationTimingChange = detectFormValidationTimingChange(file, hunk);
      if (validationTimingChange) {
        evidence.push(diffRiskEvidence(
          file,
          hunk,
          validationTimingChange.line,
          "form-validation-mode",
          `Changed form validation timing from ${validationTimingChange.before} to ${validationTimingChange.after}.`,
          "head",
        ));
      }
      for (const [side, lines] of [["head", hunk.lines], ["base", hunk.removedLines ?? []]] as const) {
        for (const line of lines) {
          if (isStaticVocabularyOrMetadataLine(line.text)) {
            continue;
          }
          const calendarMatch = sourceOutsideStringLiterals(line.text).match(
            /(timezone|scheduledAt|\bschedule\w*\b|\breminder\w*\b|\btomorrow\b|\brecurr\w*\b|\bcron\w*\b|\bdeadline\w*\b|\bdueAt\b|\bdueDate\b|\bstarts?At\b|\bends?At\b)/i,
          );
          const recordsCurrentTimestamp = /^timezone$/i.test(calendarMatch?.[1] ?? "") &&
            /\btimezone\.now\s*\(/i.test(line.text);
          const schedulerInfrastructure = isBackgroundDispatchSchedulingLine(
            line.text,
            calendarMatch?.[1],
          );
          const unchangedRewrappedCalendarSignal = calendarMatch &&
            isUnchangedRewrappedSymbol(hunk, calendarMatch[1]);
          if (
            calendarMatch &&
            !recordsCurrentTimestamp &&
            !schedulerInfrastructure &&
            !unchangedRewrappedCalendarSignal
          ) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              calendarMatch[1],
              `${side === "base" ? "Removed" : "Changed"} line contains calendar or scheduling evidence for ${calendarMatch[1]}.`,
              side,
            ));
          }
          for (const signal of asyncLifecycleSignals(line.text)) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              signal.symbol,
              `${side === "base" ? "Removed" : "Changed"} line contains asynchronous lifecycle ${signal.role} evidence for ${signal.symbol}.`,
              side,
            ));
          }
          const instrumentationMatch = line.text.match(
            /\b([A-Za-z_$][\w$]*(?:analytics|telemetry|metrics|events?|tracking|instrumentation|client)[\w$]*)\.(track|capture|identify|logEvent)\s*\(/i,
          ) ?? line.text.match(/\b(logEvent)\s*\(/i);
          if (instrumentationMatch) {
            const target = instrumentationMatch[2]
              ? `${instrumentationMatch[1]}.${instrumentationMatch[2]}`
              : instrumentationMatch[1];
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              target,
              `${side === "base" ? "Removed" : "Changed"} line emits an instrumentation event through ${target}.`,
              side,
            ));
          }
          const routingMatch = line.text.match(
            /(payload|deep.?link|destination|redirect|router\.push|navigate\w*|URLSearchParams|searchParams|location\.href|window\.location)/i,
          );
          const queryOperation = line.text.match(
            /\b((?:params|queryParams|searchParams)|[A-Za-z_$][\w$]*\.searchParams)\.(get|set|delete)\(\s*["'`]([^"'`]+)["'`]/i,
          );
          const metadataOnlyRoutingMatch = routingMatch &&
            /^(?:payload|destination)$/i.test(routingMatch[1]) &&
            isStructuredDataFile(file);
          if ((queryOperation || (routingMatch && !metadataOnlyRoutingMatch)) && !/navigation\.setoptions/i.test(line.text)) {
            const queryDescription = queryOperation
              ? `${side === "base" ? "Removed" : "Changed"} line ${queryOperation[2] === "get" ? "reads" : queryOperation[2] === "set" ? "writes" : "removes"} query parameter "${queryOperation[3]}".`
              : `${side === "base" ? "Removed" : "Changed"} line contains entry or routing evidence for ${routingMatch![1]}.`;
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              queryOperation ? `${queryOperation[1]}.${queryOperation[2]}(${queryOperation[3]})` : routingMatch![1],
              queryDescription,
              side,
            ));
          }
          const allowedStateMatch = line.text.match(
            /\b(?:const|function)\s+([A-Za-z_$][\w$]*)[^=]*=(?:[^=]|=(?!=))*?\b([A-Za-z_$][\w$]*)\s*===\s*["'`]([^"'`]+)["'`](?:\s*\|\|\s*\2\s*===\s*["'`]([^"'`]+)["'`])+/,
          );
          if (allowedStateMatch) {
            const values = uniqueStrings([...line.text.matchAll(/===\s*["'`]([^"'`]+)["'`]/g)].map((match) => match[1]));
            if (values.length > 1) {
              evidence.push(diffRiskEvidence(
                file,
                hunk,
                line.line,
                allowedStateMatch[1],
                `${side === "base" ? "Removed" : "Changed"} line declares allowed UI state values: ${values.join(", ")}.`,
                side,
              ));
            }
          }
          const guardMatch = line.text.match(
            /(guard\w*|validat\w*|permission\w*|authoriz\w*|authenticat\w*|isAllowed|isDenied|protected)/i,
          );
          if (guardMatch) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              guardMatch[1],
              `${side === "base" ? "Removed" : "Changed"} line contains guard or validation evidence for ${guardMatch[1]}.`,
              side,
            ));
          }
          const accessMatch = line.text.match(
            /(PUBLIC_[A-Z0-9_]*(?:PATH|ROUTE|ASSET)|(?:unauthenticated|public|protected)[A-Za-z0-9_]*(?:Path|Route|Asset)|NextResponse\.next|login redirect)/,
          );
          if (accessMatch) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              accessMatch[1],
              `${side === "base" ? "Removed" : "Changed"} line contains ${/public|nextresponse\.next/i.test(accessMatch[1]) ? "public access" : "protected access"} boundary evidence for ${accessMatch[1]}.`,
              side,
            ));
          }
          const availabilityMatch = line.text.match(
            /\b(startAt|endAt|startsAt|endsAt|availableFrom|availableUntil|expiresAt|exposureWindow|availabilityWindow)\b/i,
          );
          if (availabilityMatch) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              availabilityMatch[1],
              `${side === "base" ? "Removed" : "Changed"} line contains availability window or expiry boundary evidence for ${availabilityMatch[1]}.`,
              side,
            ));
          }
          const storageMatch = line.text.match(
            /(sessionStorage|localStorage|AsyncStorage|\.setItem\b|\.removeItem\b)/i,
          );
          if (storageMatch) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              storageMatch[1],
              `${side === "base" ? "Removed" : "Changed"} line contains persisted context lifecycle evidence for ${storageMatch[1]}.`,
              side,
            ));
          }
          const shareSymbol = sharingCapabilitySymbol(line.text);
          if (shareSymbol) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              shareSymbol,
              `${side === "base" ? "Removed" : "Changed"} line contains sharing capability or fallback evidence for ${shareSymbol}.`,
              side,
            ));
          }
          const mediaMatch = line.text.match(
            /(<audio\b|<video\b|\.play\b|\.pause\b|\bended\b|currentTime)/i,
          );
          if (mediaMatch) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              mediaMatch[1],
              `${side === "base" ? "Removed" : "Changed"} line contains media state transition evidence for ${mediaMatch[1]}.`,
              side,
            ));
          }
        }
      }
    }
  }
  return uniqueEvidence(evidence);
}

async function collectDeliveryIntegrityEvidence(
  root: string,
  gitRoot: string,
  options: ChangeIntentAnalysisOptions,
  changedSourceRoles: ReturnType<typeof classifyChangedSourceRoles>,
): Promise<ChangeIntentEvidence[]> {
  const relativeRoot = toPosixPath(path.relative(gitRoot, root)).replace(/^\.\/+|\/+$/g, "");
  const evidence: ChangeIntentEvidence[] = [];
  const assetChecks: Array<Promise<ChangeIntentEvidence | undefined>> = [];

  for (const [file, hunks] of Object.entries(options.addedDiffEvidence ?? {})) {
    const sourceRole = changedSourceRoles[file]?.role ??
      classifyChangeSourceRole(file, diffTextForRoleClassification(hunks)).role;
    if (sourceRole === "product" || sourceRole === "configuration") {
      for (const hunk of hunks) {
        for (const line of hunk.lines) {
          for (const reference of literalLocalAssetReferences(line.text)) {
            const resolved = resolveLocalAssetReference(file, reference);
            if (!resolved) continue;
            const repositoryPath = relativeRoot ? `${relativeRoot}/${resolved}` : resolved;
            assetChecks.push((async () => {
              if (await gitPathExistsAtRef(gitRoot, options.head, repositoryPath)) {
                return undefined;
              }
              if (await hasDeclaredGeneratedAssetContract(root, gitRoot, repositoryPath)) {
                return undefined;
              }
              const presentInWorkspace = await filePathExists(path.join(root, resolved));
              return diffRiskEvidence(
                file,
                hunk,
                line.line,
                presentInWorkspace
                  ? "delivery-integrity:uncommitted-asset"
                  : "delivery-integrity:missing-asset",
                presentInWorkspace
                  ? `Changed local asset reference ${reference} resolves in the workspace but is absent from the committed head at ${resolved}.`
                  : `Changed local asset reference ${reference} is absent from both the committed head and workspace at ${resolved}.`,
                "head",
                sourceRole,
              );
            })());
          }
        }
      }
    }
    if (isCiValidationWorkflowPath(file)) {
      evidence.push(...collectDestructiveWorkflowEvidence(file, hunks));
    }
  }

  evidence.push(...(await Promise.all(assetChecks)).filter(
    (item): item is ChangeIntentEvidence => Boolean(item),
  ));
  return uniqueEvidence(evidence);
}

function literalLocalAssetReferences(text: string): string[] {
  const trimmed = text.trim();
  if (/^(?:\/\/|#|\*|<!--)/.test(trimmed)) {
    return [];
  }
  const references: string[] = [];
  const quotedPatterns = [
    /\b(?:from|import)\s*["'`]([^"'`]+)["'`]/gi,
    /\b(?:require|url|URL)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\b(?:src|href|poster)\s*=\s*(?:\{\s*)?["'`]([^"'`]+)["'`]/gi,
  ];
  for (const pattern of quotedPatterns) {
    for (const match of text.matchAll(pattern)) {
      references.push(match[1]);
    }
  }
  for (const match of text.matchAll(/\burl\(\s*([^"'`\s)][^)]*?)\s*\)/gi)) {
    references.push(match[1]);
  }
  return uniqueStrings(references.filter(isLiteralLocalAssetReference));
}

function isLiteralLocalAssetReference(value: string): boolean {
  const reference = value.trim();
  if (
    !reference ||
    reference.includes("${") ||
    /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference) ||
    !(reference.startsWith("./") || reference.startsWith("../") || reference.startsWith("/"))
  ) {
    return false;
  }
  return /\.(?:avif|bmp|gif|ico|jpe?g|png|webp|svg|mp3|m4a|ogg|wav|mp4|webm|woff2?|ttf|otf|eot)(?:[?#].*)?$/i.test(
    reference,
  );
}

function resolveLocalAssetReference(sourceFile: string, referenceInput: string): string | undefined {
  const reference = referenceInput.trim().replace(/[?#].*$/, "");
  const resolved = reference.startsWith("/")
    ? path.posix.join("public", reference.slice(1))
    : path.posix.normalize(path.posix.join(path.posix.dirname(toPosixPath(sourceFile)), reference));
  if (!resolved || resolved === ".." || resolved.startsWith("../") || path.posix.isAbsolute(resolved)) {
    return undefined;
  }
  return resolved;
}

async function gitPathExistsAtRef(root: string, ref: string, file: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${ref}:${file}`], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

async function hasDeclaredGeneratedAssetContract(
  root: string,
  gitRoot: string,
  repositoryPath: string,
): Promise<boolean> {
  try {
    await execFileAsync("git", ["check-ignore", "-q", "--", repositoryPath], { cwd: gitRoot });
  } catch {
    return false;
  }
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return Object.entries(parsed.scripts ?? {}).some(([name, command]) =>
      typeof command === "string" &&
      /^(?:generate|codegen|prepare|prebuild|postinstall)(?::|$)/i.test(name) &&
      /\b(?:asset|codegen|copy|generate|public|static)\b/i.test(command)
    );
  } catch {
    return false;
  }
}

function isCiValidationWorkflowPath(fileInput: string): boolean {
  const file = toPosixPath(fileInput);
  return /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(file) ||
    /(?:^|\/)\.circleci\/config\.ya?ml$/i.test(file) ||
    /(?:^|\/)(?:\.gitlab-ci|bitbucket-pipelines|azure-pipelines)\.ya?ml$/i.test(file);
}

function collectDestructiveWorkflowEvidence(
  file: string,
  hunks: AddedDiffHunk[],
): ChangeIntentEvidence[] {
  const candidates = hunks.flatMap((hunk) => hunk.lines.flatMap((line) => {
    const description = destructiveWorkflowCommandDescription(line.text);
    return description ? [{ hunk, line, description }] : [];
  }));
  if (!candidates.some((candidate) => candidate.description.startsWith("force-pushes"))) {
    return [];
  }
  return candidates.map(({ hunk, line, description }) => diffRiskEvidence(
    file,
    hunk,
    line.line,
    "delivery-integrity:history-rewrite",
    `Changed validation workflow ${description}.`,
    "head",
    "configuration",
  ));
}

function destructiveWorkflowCommandDescription(text: string): string | undefined {
  const trimmed = text.trim();
  if (/^(?:#|\/\/)/.test(trimmed) || /\b(?:echo|printf)\b[^\n]*\bgit\s+/i.test(trimmed)) {
    return undefined;
  }
  if (/\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|(?:^|\s)-f(?:\s|$))/i.test(trimmed)) {
    return "force-pushes Git history";
  }
  if (/\bgit\s+reset\s+--hard\b/i.test(trimmed)) {
    return "hard-resets the checked-out branch before a force-push";
  }
  if (/\bgit\s+checkout\b[^\n]*(?:--force|\s--\s+\.?\/?\*?|\s--\s+\.)/i.test(trimmed)) {
    return "replaces checked-out files before a force-push";
  }
  if (/\bgit\s+restore\b[^\n]*--source(?:=|\s)/i.test(trimmed)) {
    return "restores files from another revision before a force-push";
  }
  if (/\bgit\s+commit\b/i.test(trimmed)) {
    return "creates a commit before a force-push";
  }
  return undefined;
}

function isDeliveryIntegrityEvidence(evidence: ChangeIntentEvidence): boolean {
  return evidence.symbol?.startsWith("delivery-integrity:") ?? false;
}

function lifecycleFromDeliveryIntegrityEvidence(
  evidence: ChangeIntentEvidence[],
): BehaviorLifecycleStage[] {
  if (evidence.length === 0) {
    return [];
  }
  const files = uniqueStrings(evidence.map((item) => item.file ?? "").filter(Boolean));
  return [
    createLifecycleStage(
      "condition",
      "A changed delivery path depends on committed artifacts and preserved branch history.",
      "high",
      evidence,
      files,
      "delivery-integrity:precondition",
    ),
    createLifecycleStage(
      "action",
      "Validate the clean-checkout artifact and workflow history.",
      "high",
      evidence,
      files,
      "delivery-integrity:validation",
    ),
    createLifecycleStage(
      "observable-outcome",
      "Observe a reproducible artifact without rewriting the review branch.",
      "high",
      evidence,
      files,
      "delivery-integrity:result",
    ),
  ];
}

async function filePathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function collectRemovalContractEvidence(
  changedFiles: TestPlanChangedFile[],
  addedDiffEvidence: AddedDiffEvidence,
  changedSourceRoles: ReturnType<typeof classifyChangedSourceRoles>,
): ChangeIntentEvidence[] {
  const evidence: ChangeIntentEvidence[] = [];
  for (const changedFile of changedFiles) {
    if (changedFile.status !== "D" || !isUserFacingSurfacePath(changedFile.path)) {
      continue;
    }
    const hunks = addedDiffEvidence[changedFile.path] ?? [];
    const sourceRole = changedSourceRoles[changedFile.path]?.role ??
      classifyChangeSourceRole(changedFile.path, diffTextForRoleClassification(hunks)).role;
    if (sourceRole !== "product") {
      continue;
    }
    const hunk = hunks.find((candidate) => (candidate.removedLines?.length ?? 0) > 0);
    const removedLine = hunk?.removedLines?.find((line) => meaningfulChangedLine(line.text)) ??
      hunk?.removedLines?.[0];
    if (!hunk || !removedLine) {
      continue;
    }
    evidence.push({
      kind: "diff",
      value: `Removed user-facing surface ${changedFile.path}; verify the retired entry remains unavailable.`,
      sourceRole: "product",
      file: changedFile.path,
      previousFile: hunk.previousFile,
      symbol: `retired-surface:${changedFile.path}`,
      relation: "direct",
      side: "base",
      startLine: removedLine.line,
      endLine: removedLine.line,
      hunkHeader: hunk.hunkHeader,
    });
  }
  return uniqueEvidence(evidence);
}

function collectChangedDiffAnchors(
  addedDiffEvidence: AddedDiffEvidence,
  changedSourceRoles: ReturnType<typeof classifyChangedSourceRoles>,
): ChangeIntentEvidence[] {
  const anchors: ChangeIntentEvidence[] = [];
  for (const [file, hunks] of Object.entries(addedDiffEvidence)) {
    const sourceRole = changedSourceRoles[file]?.role ??
      classifyChangeSourceRole(file, diffTextForRoleClassification(hunks)).role;
    if (sourceRole === "test" || sourceRole === "documentation" || sourceRole === "generated") {
      continue;
    }
    for (const hunk of hunks) {
      const addedLine = hunk.lines.find((line) => meaningfulChangedLine(line.text)) ?? hunk.lines[0];
      const removedLine = hunk.removedLines?.find((line) => meaningfulChangedLine(line.text)) ??
        hunk.removedLines?.[0];
      const selected = addedLine ?? removedLine;
      if (!selected) continue;
      anchors.push({
        kind: "diff",
        value: `Changed source hunk in ${file}.`,
        sourceRole,
        file,
        previousFile: hunk.previousFile,
        relation: "contextual",
        side: addedLine ? "head" : "base",
        startLine: selected.line,
        endLine: selected.line,
        hunkHeader: hunk.hunkHeader,
      });
      break;
    }
  }
  return uniqueEvidence(anchors);
}

function detectFormValidationTimingChange(
  file: string,
  hunk: AddedDiffHunk,
): { before: string; after: string; line: number } | undefined {
  const context = [
    file,
    hunk.hunkHeader ?? "",
    ...(hunk.removedLines ?? []).map((line) => line.text),
    ...hunk.lines.map((line) => line.text),
  ].join(" ").replace(/([a-z])([A-Z])/g, "$1 $2");
  if (!/\b(?:form|field|signup|register|validation|schema)\b/i.test(context)) {
    return undefined;
  }
  const modePattern = /\bmode\s*:\s*["'`](onChange|onBlur|onTouched|onSubmit|all)["'`]/i;
  const before = (hunk.removedLines ?? [])
    .map((line) => ({ line: line.line, mode: line.text.match(modePattern)?.[1] }))
    .find((item) => item.mode);
  const after = hunk.lines
    .map((line) => ({ line: line.line, mode: line.text.match(modePattern)?.[1] }))
    .find((item) => item.mode);
  if (!before?.mode || !after?.mode || before.mode.toLowerCase() === after.mode.toLowerCase()) {
    return undefined;
  }
  return { before: before.mode, after: after.mode, line: after.line };
}

function isStaticVocabularyOrMetadataLine(text: string): boolean {
  const trimmed = text.trim();
  if (/^["'`][A-Z][A-Z0-9_]+["'`],?$/.test(trimmed)) {
    return true;
  }
  return /\/(?:\\.|[^/\n]){3,}\/[dgimsuvy]*\.test\s*\(/i.test(trimmed) ||
    /\b(?:vocabulary|pattern|matcher|regex)\w*\s*=\s*\/(?:\\.|[^/\n]){3,}\/[dgimsuvy]*/i.test(trimmed);
}

function isFormattingOnlyHunk(hunk: AddedDiffHunk): boolean {
  const removed = hunk.removedLines ?? [];
  if (hunk.lines.length === 0 || removed.length === 0) {
    return false;
  }
  const before = normalizeFormattingComparableSource(removed.map((line) => line.text));
  const after = normalizeFormattingComparableSource(hunk.lines.map((line) => line.text));
  return before.length > 0 && before === after;
}

function normalizeFormattingComparableSource(lines: string[]): string {
  const source = lines.join("\n");
  let normalized = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      normalized += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      normalized += character;
      continue;
    }
    if (/\s/.test(character)) {
      continue;
    }
    if (character === ",") {
      const next = source.slice(index + 1).match(/\S/)?.[0];
      if (next && /[\])}]/.test(next)) {
        continue;
      }
    }
    normalized += character;
  }
  return normalized;
}

function sourceOutsideStringLiterals(text: string): string {
  let result = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  for (const character of text) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      result += " ";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      result += " ";
      continue;
    }
    result += character;
  }
  return result;
}

function isUnchangedRewrappedSymbol(hunk: AddedDiffHunk, symbol: string): boolean {
  const before = statementContainingSymbol(hunk.removedLines ?? [], symbol);
  const after = statementContainingSymbol(hunk.lines, symbol);
  return before !== undefined && after !== undefined && before === after;
}

function statementContainingSymbol(
  lines: Array<{ text: string }>,
  symbol: string,
): string | undefined {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escapedSymbol}\\b`, "i");
  const start = lines.findIndex((line) => pattern.test(sourceOutsideStringLiterals(line.text)));
  if (start < 0) {
    return undefined;
  }
  const statement: string[] = [];
  for (const line of lines.slice(start, start + 12)) {
    statement.push(line.text);
    if (/;\s*$/.test(sourceOutsideStringLiterals(line.text))) {
      break;
    }
  }
  return normalizeFormattingComparableSource(statement);
}

function isUserFacingSurfacePath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return /\.(?:tsx|jsx|vue|svelte)$/i.test(normalized) &&
    /(?:^|\/)(?:app|pages?|routes?|screens?|views?)(?:\/|$)/i.test(normalized);
}

function isBackgroundDispatchSchedulingLine(text: string, calendarSymbol: string | undefined): boolean {
  if (!calendarSymbol || !/^schedul/i.test(calendarSymbol)) {
    return /^scheduler$/i.test(calendarSymbol ?? "");
  }
  const hasBackgroundWork = /\b(?:job|task|worker|queue|dispatch|enqueue|consumer|scheduler)\b/i.test(
    text.replace(/([a-z])([A-Z])/g, "$1 $2"),
  );
  const hasTemporalBoundary =
    /\b(?:at|date|time|delay|cron|reminder|deadline|due|start|end|timezone|tomorrow)\b/i.test(
      text.replace(/([a-z])([A-Z])/g, "$1 $2"),
    );
  return hasBackgroundWork && !hasTemporalBoundary;
}

function asyncLifecycleSignals(
  text: string,
): Array<{ role: AsyncLifecycleRole; symbol: string }> {
  const trimmed = text.trim();
  if (/^(?:\/\/|\/\*|\*|#)/.test(trimmed) || /^\s*import\b/.test(text)) {
    return [];
  }
  const signals: Array<{ role: AsyncLifecycleRole; symbol: string }> = [];
  const dispatch = text.match(
    /\b((?:enqueue|dispatch|publish|produce|queue|schedule|sendTask|send_task|apply_async|delay)[A-Za-z0-9_]*)\s*\(/i,
  );
  if (dispatch) {
    signals.push({ role: "dispatch", symbol: dispatch[1] });
  }

  if (/\b(?:status|state)\b\s*[:=]/i.test(text)) {
    for (const state of text.matchAll(
      /\b(pending|queued|processing|in[_-]?progress|completed|succeeded|failed|cancelled|canceled)\b/gi,
    )) {
      signals.push({ role: "state", symbol: state[1] });
    }
  } else {
    const stateMethod = text.match(
      /\b((?:mark|set|update|transitionTo)[A-Za-z0-9_]*(?:Pending|Queued|Processing|Completed|Succeeded|Failed|Cancelled|Canceled)[A-Za-z0-9_]*)\s*\(/,
    );
    if (stateMethod) {
      signals.push({ role: "state", symbol: stateMethod[1] });
    }
  }

  const completion = text.match(
    /\b((?:ack|nack|acknowledge|consume|consumer|worker|callback|webhook|handleResult|processResult|receiveResult|onComplete|onFailure|retry)[A-Za-z0-9_]*)\s*\(/i,
  );
  if (completion) {
    signals.push({ role: "completion", symbol: completion[1] });
  }

  const consistency = text.match(
    /\b([A-Za-z_$][\w$]*(?:idempotenc|deduplicat|duplicate)[A-Za-z0-9_$]*)\s*\(/i,
  ) ?? text.match(
    /\b(idempotenc[A-Za-z0-9_]*|deduplicat[A-Za-z0-9_]*|duplicate[A-Za-z0-9_]*|compareAndSet[A-Za-z0-9_]*|selectForUpdate[A-Za-z0-9_]*|lockForUpdate[A-Za-z0-9_]*|advisoryLock[A-Za-z0-9_]*|stale[A-Za-z0-9_]*)\b/i,
  ) ?? text.match(/\b((?:version|revision))\b\s*(?:[<>]=?|={1,3}|!={1,2})/i);
  if (consistency) {
    signals.push({ role: "consistency", symbol: consistency[1] });
  }

  return signals.filter((signal, index) =>
    signals.findIndex((candidate) =>
      candidate.role === signal.role && candidate.symbol.toLowerCase() === signal.symbol.toLowerCase()
    ) === index
  );
}

function groupAsyncLifecycleEvidence(
  evidence: ChangeIntentEvidence[],
): Map<AsyncLifecycleRole, ChangeIntentEvidence[]> {
  const groups = new Map<AsyncLifecycleRole, ChangeIntentEvidence[]>();
  for (const item of evidence) {
    if (
      item.kind !== "diff" ||
      item.relation !== "direct" ||
      (item.sourceRole !== undefined && item.sourceRole !== "product")
    ) {
      continue;
    }
    const match = item.value.match(/asynchronous lifecycle (dispatch|state|completion|consistency) evidence/i);
    const role = match?.[1]?.toLowerCase() as AsyncLifecycleRole | undefined;
    if (!role) {
      continue;
    }
    const items = groups.get(role) ?? [];
    items.push(item);
    groups.set(role, items);
  }
  return groups;
}

function isUiBehaviorEvidence(evidence: ChangeIntentEvidence): boolean {
  const file = evidence.file?.replaceAll("\\", "/");
  if (!file) {
    return false;
  }
  return /\.(?:tsx|jsx|vue|svelte)$/i.test(file) ||
    /(?:^|\/)(?:components?|pages?|screens?|views?|ui)(?:\/|$)/i.test(file) ||
    /\.component\.ts$/i.test(file);
}

function sharingCapabilitySymbol(text: string): string | undefined {
  if (/^\s*import\b/.test(text)) {
    return undefined;
  }
  const match = text.match(
    /(navigator\.share|navigator\.clipboard|clipboard\.writeText|document\.execCommand\s*\(\s*["']copy["']|AbortError|(?:^|[.\s])(share|copy)\s*\()/i,
  );
  return match?.[1]?.trim().replace(/^\./, "") || match?.[2];
}

function selectRiskEvidence(evidence: ChangeIntentEvidence[], limit: number): ChangeIntentEvidence[] {
  const unique = uniqueEvidence(evidence);
  const selected: ChangeIntentEvidence[] = [];
  const selectedKeys = new Set<string>();
  const files = uniqueStrings(unique.map((item) => item.file ?? "").filter(Boolean));

  for (const file of files) {
    const item = unique.find((candidate) => candidate.file === file);
    if (!item) continue;
    selected.push(item);
    selectedKeys.add(evidenceSelectionKey(item));
    if (selected.length >= limit) return selected;
  }
  for (const role of ["dispatch", "state", "completion", "consistency"] as const) {
    const item = unique.find((candidate) =>
      candidate.value.includes(`asynchronous lifecycle ${role} evidence`)
    );
    if (!item) continue;
    const key = evidenceSelectionKey(item);
    if (selectedKeys.has(key)) continue;
    selected.push(item);
    selectedKeys.add(key);
    if (selected.length >= limit) return selected;
  }
  for (const item of unique) {
    const key = evidenceSelectionKey(item);
    if (selectedKeys.has(key)) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function evidenceSelectionKey(evidence: ChangeIntentEvidence): string {
  return `${evidence.file ?? ""}:${evidence.side ?? ""}:${evidence.startLine ?? ""}:${evidence.symbol ?? ""}:${evidence.value}`;
}

function diffRiskEvidence(
  file: string,
  hunk: AddedDiffHunk,
  line: number,
  symbol: string,
  value: string,
  side: "base" | "head",
  sourceRole: ChangeSourceRole = classifyChangeSourceRole(file).role,
): ChangeIntentEvidence {
  return {
    kind: "diff",
    value,
    sourceRole,
    file,
    previousFile: hunk.previousFile,
    symbol,
    relation: "direct",
    side,
    startLine: line,
    endLine: line,
    hunkHeader: hunk.hunkHeader,
  };
}

function collectAnalysisRuleDiffEvidence(
  file: string,
  hunks: AddedDiffHunk[],
): ChangeIntentEvidence[] {
  const evidence: ChangeIntentEvidence[] = [];
  for (const hunk of hunks) {
    for (const [side, lines] of [["head", hunk.lines], ["base", hunk.removedLines ?? []]] as const) {
      const line = lines.find((candidate) => meaningfulChangedLine(candidate.text));
      if (!line) continue;
      const symbol = declaredOrCalledSymbol(line.text) ?? path.basename(file).replace(/\.[^.]+$/, "");
      evidence.push(diffRiskEvidence(
        file,
        hunk,
        line.line,
        symbol,
        `${side === "base" ? "Removed" : "Changed"} static-analysis rule definition near ${symbol}.`,
        side,
        "analysis-rule",
      ));
    }
  }
  return uniqueEvidence(evidence);
}

function collectCommandDiffEvidence(
  file: string,
  hunks: AddedDiffHunk[],
): ChangeIntentEvidence[] {
  const evidence: ChangeIntentEvidence[] = [];
  for (const hunk of hunks) {
    for (const [side, lines] of [["head", hunk.lines], ["base", hunk.removedLines ?? []]] as const) {
      let hunkMatched = false;
      for (const line of lines) {
        const signal = commandLineSignal(line.text);
        if (!signal) continue;
        hunkMatched = true;
        evidence.push(diffRiskEvidence(
          file,
          hunk,
          line.line,
          signal.symbol,
          `${side === "base" ? "Removed" : "Changed"} ${signal.description}.`,
          side,
          "command",
        ));
      }
      if (!hunkMatched) {
        const line = lines.find((candidate) => meaningfulChangedLine(candidate.text));
        if (!line) continue;
        const symbol = declaredOrCalledSymbol(line.text) ?? path.basename(file).replace(/\.[^.]+$/, "");
        evidence.push(diffRiskEvidence(
          file,
          hunk,
          line.line,
          symbol,
          `${side === "base" ? "Removed" : "Changed"} CLI command implementation near ${symbol}.`,
          side,
          "command",
        ));
      }
    }
  }
  return uniqueEvidence(evidence).slice(0, 16);
}

function commandLineSignal(text: string): { symbol: string; description: string } | undefined {
  const command = text.match(/\.(?:command|commandDir)\s*\(\s*["'`]([^"'`]+)/i) ??
    text.match(/\bcase\s+["'`]([^"'`]+)["'`]\s*:/i);
  if (command) {
    return { symbol: command[1], description: `CLI command declaration for "${command[1]}"` };
  }
  const option = text.match(/\.(?:option|requiredOption)\s*\(\s*["'`]([^"'`]+)/i) ??
    text.match(/["'`](--[a-z0-9][a-z0-9-]*)["'`]/i);
  if (option) {
    return { symbol: option[1], description: `CLI option contract for "${option[1]}"` };
  }
  if (/\bprocess\.(?:exit|exitCode)\b|\bsetExitCode\s*\(/i.test(text)) {
    return { symbol: "exit-status", description: "CLI exit status behavior" };
  }
  if (/\b(?:process\.)?(?:stdout|stderr)\b|\bconsole\.(?:log|error|warn)\s*\(/i.test(text)) {
    const stream = /stderr|console\.(?:error|warn)/i.test(text) ? "stderr" : "stdout";
    return { symbol: stream, description: `CLI ${stream} output behavior` };
  }
  if (/\bprocess\.argv\b|\bparseArgs\s*\(/i.test(text)) {
    return { symbol: "arguments", description: "CLI argument parsing behavior" };
  }
  return undefined;
}

function meaningfulChangedLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !/^(?:[{}()[\],;]|\/\/[\s-]*)+$/.test(trimmed);
}

function declaredOrCalledSymbol(text: string): string | undefined {
  return text.match(/\b(?:const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/)?.[1] ??
    text.match(/\b([A-Za-z_$][\w$]*)\s*\(/)?.[1];
}

function diffTextForRoleClassification(hunks: AddedDiffHunk[]): string {
  return hunks.flatMap((hunk) => [
    ...hunk.lines.map((line) => line.text),
    ...(hunk.removedLines ?? []).map((line) => line.text),
  ]).join("\n");
}

function collectCodeBehaviorSignalsFromText(
  signals: CodeBehaviorSignal[],
  file: string,
  text: string,
  hunk?: AddedDiffHunk,
  line?: number,
): void {
  collectStaticUiOutcomeSignals(signals, file, text, hunk, line);
  for (const match of text.matchAll(/(?:@click(?:\.\w+)*|v-on:click(?:\.\w+)*|onClick)\s*=\s*(?:["']|\{)\s*(?:this\.)?([A-Za-z_$][\w$]*)/g)) {
    const symbol = match[1];
    const label = `Trigger ${humanizeEventHandler(symbol)}.`;
    signals.push({
      kind: "trigger",
      label,
      file,
      symbol,
      evidence: codeSignalEvidence(label, file, symbol, hunk, line),
    });
  }
  for (const match of text.matchAll(
    /\b(onClick|onPress|onSubmit|onChange|onEnded)\s*=\s*\{\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*(?:\{[^}\n]*?)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g,
  )) {
    const eventName = match[1];
    const symbol = match[2];
    if (eventName === "onChange" && /^(?:set|update)[A-Z_]/.test(symbol.split(".").at(-1) ?? symbol)) {
      continue;
    }
    const label = `Trigger ${humanizeEventHandler(symbol.split(".").at(-1) ?? symbol)}.`;
    signals.push({
      kind: "trigger",
      label,
      file,
      symbol,
      evidence: codeSignalEvidence(label, file, symbol, hunk, line),
    });
  }
  const vueConditionExpressions = [
    ...text.matchAll(/v-(?:if|else-if)\s*=\s*["']([^"']+)["']/g),
  ].map((match) => match[1]);
  const reactUiConditionExpressions = [
    ...text.matchAll(/\{\s*(!?\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:&&|\?)\s*</g),
  ].map((match) => match[1]);
  const conditionExpressions = [
    ...vueConditionExpressions,
    ...reactUiConditionExpressions,
    ...[...text.matchAll(/\bif\s*\(([^)]{1,240})\)/g)].map((match) => match[1]),
    ...[...text.matchAll(/\{\s*((?:is|has|can|should|show|hide)[A-Z_][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)?)\s*(?:&&|\?)/g)]
      .map((match) => match[1]),
  ];
  for (const expression of conditionExpressions) {
    const identifiers = expression.match(/\b(?:is|has|can|should|show|hide)[A-Z_][A-Za-z0-9_$]*/g) ?? [];
    for (const symbol of identifiers) {
      if (isImplementationPredicateCall(symbol, expression)) {
        continue;
      }
      const label = `Check ${humanizeIdentifier(symbol)}.`;
      signals.push({
        kind: "condition",
        label,
        file,
        symbol,
        evidence: codeSignalEvidence(label, file, symbol, hunk, line),
      });
    }
  }
  for (const expression of [...vueConditionExpressions, ...reactUiConditionExpressions]) {
    const symbol = expression.match(/^\s*!?\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/)?.[1];
    if (!symbol || /^(?:is|has|can|should|show|hide)[A-Z_]/.test(symbol)) {
      continue;
    }
    const label = `Check ${humanizeIdentifier(symbol)}.`;
    signals.push({
      kind: "condition",
      label,
      file,
      symbol,
      evidence: codeSignalEvidence(label, file, symbol, hunk, line),
    });
  }
  const conditionalCopyMatches = [
    ...text.matchAll(/v-(?:if|show)\s*=\s*["'][^"']+["'][^>]*>\s*([^<>{}\n]{2,120})\s*</g),
    ...text.matchAll(/\{\s*(?:is|has|can|should|show|hide)[A-Z_][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)?\s*&&\s*<[^>]+>\s*([^<>{}\n]{2,120})\s*</g),
  ];
  for (const match of conditionalCopyMatches) {
    const visibleText = match[1].replace(/\s+/g, " ").trim();
    const label = `Show ${visibleText}.`;
    signals.push({
      kind: "observable-outcome",
      label,
      file,
      symbol: visibleText,
      evidence: codeSignalEvidence(label, file, visibleText, hunk, line),
    });
  }
  for (const match of text.matchAll(/\b(on[A-Z][A-Za-z0-9_]*)\b/g)) {
    const symbol = match[1];
    if (/^on(?:Click|Press|Submit|Change)$/.test(symbol)) {
      continue;
    }
    const label = `Handle ${humanizeEventHandler(symbol)}.`;
    signals.push({
      kind: "trigger",
      label,
      file,
      symbol,
      evidence: codeSignalEvidence(label, file, symbol, hunk, line),
    });
  }
  for (const match of text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g)) {
    const symbol = match[1];
    if (isInsideRegexLiteral(text, match.index ?? 0)) {
      continue;
    }
    const prefix = text.slice(0, match.index ?? 0);
    if (/\b(?:function|class)\s+$/.test(prefix)) {
      continue;
    }
    const leaf = symbol.split(".").at(-1) ?? symbol;
    if (ignoredCallNames.has(leaf) || leaf.length < 3) {
      continue;
    }
    const kind = lifecycleKindForIdentifier(symbol);
    if (!kind) {
      continue;
    }
    const label = codeSignalLabel(kind, symbol);
    signals.push({
      kind,
      label,
      file,
      symbol,
      evidence: codeSignalEvidence(label, file, symbol, hunk, line),
    });
  }
}

function collectStaticUiOutcomeSignals(
  signals: CodeBehaviorSignal[],
  file: string,
  text: string,
  hunk?: AddedDiffHunk,
  line?: number,
): void {
  if (!isUserFacingUiSourcePath(file) || !hunk) {
    return;
  }
  const removedText = (hunk.removedLines ?? []).map((candidate) => candidate.text).join("\n");
  const removedAccessibilityLabels = new Set(
    [...removedText.matchAll(/\b(?:aria-label|accessibilityLabel)\s*=\s*(?:\{\s*)?["'`]([^"'`{}\n]{2,120})["'`](?:\s*\})?/g)]
      .map((match) => match[1].replace(/\s+/g, " ").trim()),
  );
  for (const match of text.matchAll(/\b(?:aria-label|accessibilityLabel)\s*=\s*(?:\{\s*)?["'`]([^"'`{}\n]{2,120})["'`](?:\s*\})?/g)) {
    const accessibleLabel = match[1].replace(/\s+/g, " ").trim();
    if (
      removedAccessibilityLabels.size === 0 ||
      removedAccessibilityLabels.has(accessibleLabel) ||
      isInstructionLikeRepositoryText(accessibleLabel)
    ) {
      continue;
    }
    const label = `Expose accessibility label "${accessibleLabel}".`;
    signals.push({
      kind: "observable-outcome",
      label,
      file,
      symbol: `accessibility-label:${accessibleLabel}`,
      evidence: {
        ...codeSignalEvidence(label, file, `accessibility-label:${accessibleLabel}`, hunk, line),
        relation: "direct",
      },
    });
  }
  const visibleTextMatcher =
    /<(h[1-6]|p|span|label|button|a|output|strong|em|li|option|legend|caption|td|th)\b([^>]*)>\s*([^<>{}\n]{2,120})\s*<\//g;
  const removedVisibleTextByTag = new Map<string, Set<string>>();
  for (const match of removedText.matchAll(visibleTextMatcher)) {
    const values = removedVisibleTextByTag.get(match[1].toLowerCase()) ?? new Set<string>();
    values.add(match[3].replace(/\s+/g, " ").trim());
    removedVisibleTextByTag.set(match[1].toLowerCase(), values);
  }
  for (const match of text.matchAll(visibleTextMatcher)) {
    const tag = match[1].toLowerCase();
    const attributes = match[2];
    const prefix = text.slice(0, match.index ?? 0);
    if (/\bv-(?:if|show)\b/.test(attributes) || /(?:&&|\?)\s*$/.test(prefix)) {
      continue;
    }
    const visibleText = match[3].replace(/\s+/g, " ").trim();
    const removedValues = removedVisibleTextByTag.get(tag);
    if (!removedValues || removedValues.has(visibleText) || isInstructionLikeRepositoryText(visibleText)) {
      continue;
    }
    const label = `Show "${visibleText}".`;
    signals.push({
      kind: "observable-outcome",
      label,
      file,
      symbol: `visible-copy:${visibleText}`,
      evidence: {
        ...codeSignalEvidence(label, file, `visible-copy:${visibleText}`, hunk, line),
        relation: "direct",
      },
    });
  }
}

function isUserFacingUiSourcePath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return /\.(?:tsx|jsx|vue|svelte)$/i.test(normalized) ||
    /(?:^|\/)(?:components?|pages?|screens?|views?|ui)(?:\/|$)/i.test(normalized) ||
    /\.component\.ts$/i.test(normalized);
}

function isInsideRegexLiteral(text: string, index: number): boolean {
  const prefix = text.slice(0, index);
  return /(?:^|\b(?:return|case)\s+|[=(:,!\[{};?&|]\s*)\/(?![/*])(?:\\.|[^/\\\n])*$/.test(prefix);
}

function codeSignalEvidence(
  value: string,
  file: string,
  symbol: string,
  hunk?: AddedDiffHunk,
  line?: number,
): ChangeIntentEvidence {
  return {
    kind: "diff",
    value,
    sourceRole: "product",
    file,
    previousFile: hunk?.previousFile,
    symbol,
    relation: "supporting",
    side: hunk ? "head" : undefined,
    startLine: line,
    endLine: line,
    hunkHeader: hunk?.hunkHeader,
  };
}

function lifecycleKindForIdentifier(identifier: string): BehaviorLifecycleStageKind | undefined {
  const value = identifier.toLowerCase();
  const leaf = identifier.split(".").at(-1) ?? identifier;
  const leafValue = leaf.toLowerCase();
  if (implementationSchedulingCalls.has(leafValue) || isImplementationPredicateCall(identifier)) {
    return undefined;
  }
  if (/^(?:on|handle)(?:press|click|submit|change|complete|open|response|message|select|toggle)/.test(leafValue)) {
    return "trigger";
  }
  if (/(?:navigate|redirect|router\.(?:push|replace)|openurl|openlink)/.test(value) || /(?:show|display|preview|render)/.test(leafValue)) {
    return "observable-outcome";
  }
  if (/(?:sessionstorage|localstorage|asyncstorage)/.test(value) ||
    /^(?:resync|sync|persist|store|save|update|set[A-Z_]|cache|write|delete|remove|clear|reset|cancel|invalidate|pause)/i.test(leaf)) {
    return "state-change";
  }
  if (/(?:clipboard)/.test(value) || /(?:schedule|notify|notification|request|fetch|mutate|post|send|emit|track|publish|upload|download|share|copy|play)/.test(leafValue)) {
    return "side-effect";
  }
  if (
    /(?:permission|authorized|authenticated|enabled|disabled|validate|guard)/i.test(leaf) ||
    /^(?:is|has|can|should|show|hide)[A-Z_]/.test(leaf)
  ) {
    return "condition";
  }
  return undefined;
}

function isImplementationPredicateCall(identifier: string, expression = identifier): boolean {
  const names = expression.match(/\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/g) ?? [
    identifier,
  ];
  return names.some((name) => implementationPredicateCalls.has(name.toLowerCase()));
}

// QA staff read lifecycle labels, so symbol-derived stages phrase behavior in
// prose where that is safe (setter targets) and mark the identifier as code
// with backticks where naive humanization would produce nonsense (predicates,
// method chains). Exact symbols always remain on the stage and its evidence.
const stateSetterVerbs = new Set(["set", "update", "dispatch", "emit", "mutate", "use", "toggle"]);

function humanizedStateTarget(symbol: string): string | undefined {
  const words = humanizeIdentifier(symbol).split(/\s+/).filter(Boolean);
  const verbIndex = words.findIndex((word) => stateSetterVerbs.has(word));
  if (verbIndex < 0) {
    return undefined;
  }
  const target = [...words.slice(0, verbIndex), ...words.slice(verbIndex + 1)].join(" ").trim();
  return target || undefined;
}

function codeSignalLabel(kind: BehaviorLifecycleStageKind, symbol: string): string {
  if (kind === "trigger") {
    return `Trigger ${humanizeIdentifier(symbol)}.`;
  }
  if (kind === "condition") {
    return `Check ${humanizeIdentifier(symbol)}.`;
  }
  if (kind === "state-change") {
    const target = humanizedStateTarget(symbol);
    return target ? `Update the ${target} state.` : `Update state through \`${symbol}\`.`;
  }
  if (kind === "side-effect") {
    return `Invoke \`${symbol}\`.`;
  }
  if (kind === "observable-outcome") {
    return `Observe the result of \`${symbol}\`.`;
  }
  return `Run \`${symbol}\`.`;
}

function extractTriggerPhrases(statement: string): string[] {
  const triggers: string[] = [];
  for (const match of statement.matchAll(/\b(after|when|once|upon|before)\s+([^,;.]+)/gi)) {
    const phrase = `${match[1]} ${match[2]}`.trim().split(/\s+/).slice(0, 10).join(" ");
    triggers.push(sentenceLabel(phrase));
  }
  const adjectiveTrigger = statement.match(/\b(?:the\s+)?(tapped|clicked|submitted|completed|received)\s+([a-z0-9-]+)\b/i);
  if (adjectiveTrigger) {
    triggers.push(sentenceLabel(`When the ${adjectiveTrigger[2]} is ${adjectiveTrigger[1]}`));
  } else {
    const passiveTrigger = statement.match(/\b(?:the\s+)?([a-z0-9-]+)\s+is\s+(tapped|clicked|submitted|completed|received)\b/i);
    if (passiveTrigger) {
      triggers.push(sentenceLabel(`When the ${passiveTrigger[1]} is ${passiveTrigger[2]}`));
    }
  }
  return uniqueStrings(triggers);
}

function splitIntentClauses(statement: string): string[] {
  const stripped = stripTerminalPunctuation(statement.trim());
  const lifecycleVerb =
    "(?:cache|cancel|clear|click|complete|delete|display|emit|fetch|fire|invalidate|navigate|notify|open|persist|post|publish|redirect|remove|render|request|resync|reset|restore|save|schedule|select|send|show|store|submit|surface|sync|tap|toggle|track|update|upload)";
  const clauses = stripped
    .split(new RegExp(`(?:,\\s*(?=${lifecycleVerb}\\b)|,?\\s+(?:and then|then|and)\\s+)`, "i"))
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 4);
  return clauses.length > 0 ? clauses : [stripped];
}

function classifyLifecycleClause(clause: string): BehaviorLifecycleStageKind {
  const value = clause.toLowerCase();
  if (/^(?:show|display|render|preview|tease|open|navigate|redirect|surface|return)\b/.test(value)) {
    return "observable-outcome";
  }
  if (/^(?:save|persist|restore|store|update|sync|resync|cache|set|cancel|remove|delete|invalidate|toggle)\b/.test(value)) {
    return "state-change";
  }
  if (/^(?:schedule|fire|send|notify|request|fetch|post|emit|track|publish|export|upload)\b/.test(value)) {
    return "side-effect";
  }
  if (/\b(?:if|only|enabled|disabled|permission|authorized|authenticated|valid|guard)\b/.test(value)) {
    return "condition";
  }
  if (/^(?:tap|click|submit|complete|receive|start|select|press)\b/.test(value)) {
    return "trigger";
  }
  if (/\b(?:show|display|render|preview|tease|open|navigate|redirect|surface|return)\b/.test(value)) {
    return "observable-outcome";
  }
  if (/\b(?:save|persist|restore|store|update|sync|resync|cache|set|cancel|remove|delete|invalidate|toggle)\b/.test(value)) {
    return "state-change";
  }
  if (/\b(?:schedule|fire|send|notify|request|fetch|post|emit|track|publish|export|upload)\b/.test(value)) {
    return "side-effect";
  }
  return "action";
}

function confidenceForIntent(
  commits: ParsedCommit[],
  lifecycle: BehaviorLifecycleStage[],
  signals: CodeBehaviorSignal[],
): ChangeIntentConfidence {
  const seedCount = commits.filter((commit) => commit.seed).length;
  const phaseCount = new Set(lifecycle.map((stage) => stage.kind)).size;
  if (
    phaseCount >= 3 &&
    signals.length >= 1 &&
    (seedCount >= 2 || (seedCount === 1 && phaseCount >= 4 && signals.length >= 2))
  ) {
    return "high";
  }
  if (seedCount >= 1 && lifecycle.length >= 2) {
    return "medium";
  }
  return "low";
}

function lifecycleKeywordCount(value: string): number {
  const matches = value.match(
    /\b(?:cancel|click|complete|display|emit|enable|fetch|fire|navigate|notify|open|persist|preview|record|redirect|request|resync|save|schedule|send|show|submit|sync|tap|toggle|track|update)\w*/gi,
  );
  return new Set((matches ?? []).map((match) => normalizeToken(match))).size;
}

function isLowSignalCommitStatement(statement: string): boolean {
  return /^(?:benchmark|prepare|release|version|dependency|format|lint|cleanup|metadata)\b/i.test(statement.trim());
}

function extractKeywords(value: string): string[] {
  const words = normalizedWords(value)
    .map(normalizeToken)
    .filter((word) => word.length >= 3 && !stopWords.has(word));
  return uniqueStrings(words).slice(0, 24);
}

function normalizedWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/)
    .filter(Boolean);
}

function rankCodeSignalsForIntent(signals: CodeBehaviorSignal[], keywords: string[]): CodeBehaviorSignal[] {
  const keywordSet = new Set(keywords.map(normalizeToken));
  const presentationOnly = /color|theme|style|class|layout|size|width|height|dark|light/i;
  return signals
    .map((signal, index) => {
      const words = normalizedWords(`${signal.symbol} ${signal.label} ${signal.file}`).map(normalizeToken);
      const overlap = words.filter((word) => keywordSet.has(word)).length;
      const behaviorWeight = signal.kind === "trigger" || signal.kind === "observable-outcome" ? 3 : 0;
      const presentationPenalty = presentationOnly.test(`${signal.symbol} ${signal.label}`) ? 4 : 0;
      return { signal, index, score: overlap * 4 + behaviorWeight - presentationPenalty };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ signal }) => signal);
}

function normalizeToken(value: string): string {
  let token = value.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
  if (/^schedul/.test(token)) return "schedule";
  if (/^(?:notify|notification)/.test(token)) return "notification";
  if (/^(?:resync|sync)/.test(token)) return "sync";
  if (/^(?:navigate|navigation|redirect|route)/.test(token)) return "navigation";
  if (/^(?:remind|reminder)/.test(token)) return "reminder";
  if (/^(?:persist|storage|store)/.test(token)) return "persistence";
  if (token.endsWith("ies") && token.length > 5) token = `${token.slice(0, -3)}y`;
  else if (token.endsWith("ing") && token.length > 6) token = token.slice(0, -3);
  else if (token.endsWith("ed") && token.length > 5) token = token.slice(0, -2);
  else if (token.endsWith("s") && !token.endsWith("ss") && token.length > 4) token = token.slice(0, -1);
  return token;
}

function isBehaviorBearingFile(file: string): boolean {
  const role = classifyChangeSourceRole(file).role;
  return role !== "test" && role !== "documentation" && role !== "generated";
}

function isStructuredDataFile(file: string): boolean {
  return /\.(?:csv|json|json5|toml|ya?ml)$/i.test(file);
}

function stripParsedCommitFields(commit: ParsedCommit): ChangeIntentCommit {
  const {
    seed: _seed,
    supporting: _supporting,
    keywords: _keywords,
    tickets: _tickets,
    ...result
  } = commit;
  return result;
}

function orderLifecycleStages(stages: BehaviorLifecycleStage[]): BehaviorLifecycleStage[] {
  const rank: Record<BehaviorLifecycleStageKind, number> = {
    trigger: 0,
    condition: 1,
    action: 2,
    "state-change": 3,
    "side-effect": 4,
    "observable-outcome": 5,
  };
  return stages
    .map((stage, index) => ({ stage, index }))
    .sort((left, right) => rank[left.stage.kind] - rank[right.stage.kind] || left.index - right.index)
    .map(({ stage }) => stage);
}

function uniqueLifecycleStages(stages: BehaviorLifecycleStage[]): BehaviorLifecycleStage[] {
  const seen = new Set<string>();
  return stages.filter((stage) => {
    const key = `${stage.kind}:${stripTerminalPunctuation(stage.label).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueCodeSignals(signals: CodeBehaviorSignal[]): CodeBehaviorSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.kind}:${signal.file}:${signal.symbol}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueScenarios(scenarios: IntentQaScenario[]): IntentQaScenario[] {
  const seen = new Set<string>();
  return scenarios.filter((scenario) => {
    const key = scenario.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rankIntentQaScenarios(scenarios: IntentQaScenario[]): IntentQaScenario[] {
  const kindRank: Record<IntentQaScenarioKind, number> = {
    primary: 0,
    failure: 1,
    boundary: 2,
    "state-transition": 3,
  };
  return scenarios
    .map((scenario, index) => ({ scenario, index }))
    .sort((left, right) => {
      if (left.scenario.kind === "primary" || right.scenario.kind === "primary") {
        if (left.scenario.kind === "primary" && right.scenario.kind === "primary") {
          return left.index - right.index;
        }
        return left.scenario.kind === "primary" ? -1 : 1;
      }
      const priorityDifference = Number(left.scenario.priority !== "critical") -
        Number(right.scenario.priority !== "critical");
      if (priorityDifference !== 0) {
        return priorityDifference;
      }
      const kindDifference = kindRank[left.scenario.kind] - kindRank[right.scenario.kind];
      if (kindDifference !== 0) {
        return kindDifference;
      }
      const leftDirectEvidence = left.scenario.evidence.filter((item) => item.relation === "direct").length;
      const rightDirectEvidence = right.scenario.evidence.filter((item) => item.relation === "direct").length;
      return rightDirectEvidence - leftDirectEvidence || left.index - right.index;
    })
    .map(({ scenario }) => scenario);
}

function uniqueEvidence(evidence: ChangeIntentEvidence[]): ChangeIntentEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.kind}:${item.sourceRole ?? ""}:${item.relation ?? ""}:${item.side ?? ""}:${item.commit ?? ""}:${item.file ?? ""}:${item.startLine ?? ""}:${item.endLine ?? ""}:${item.symbol ?? ""}:${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sentenceTitle(value: string): string {
  const stripped = stripTerminalPunctuation(value.trim());
  if (!stripped) return "Changed behavior";
  return stripped[0].toUpperCase() + stripped.slice(1);
}

function sentenceLabel(value: string): string {
  const title = sentenceTitle(value);
  return /[.!?]$/.test(title) ? title : `${title}.`;
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[.!?]+$/, "").trim();
}

function assertionForStage(stage: BehaviorLifecycleStage): string {
  const label = stripTerminalPunctuation(stage.label);
  const accessibleLabel = label.match(/^Expose accessibility label\s+"(.+)"$/i)?.[1];
  if (accessibleLabel) {
    return `Verify the accessibility label equals "${accessibleLabel}".`;
  }
  const visible = label.match(/^Show\s+(.+)$/i)?.[1];
  if (visible) {
    return `Verify ${lowercaseFirst(visible)} is visible.`;
  }
  const observed = label.match(/^Observe(?:\s+the result of)?\s+(.+)$/i)?.[1];
  if (observed) {
    if (/^stdout, stderr, exit status, and generated files$/i.test(observed)) {
      return "Verify the command produces the expected stdout, stderr, generated files, and exit status.";
    }
    return `Verify ${lowercaseFirst(observed)} is externally observable.`;
  }
  return `Verify ${lowercaseFirst(label)}.`;
}

function lowercaseFirst(value: string): string {
  return value ? value[0].toLowerCase() + value.slice(1) : value;
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/NaN/g, " Not a number")
    .replaceAll(".", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function humanizeEventHandler(value: string): string {
  const withoutEventPrefix = value.replace(/^on(?=[A-Z_])/, "");
  return humanizeIdentifier(withoutEventPrefix || value);
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function changeIntentSource(
  intents: ChangeIntent[],
  commits: ChangeIntentCommit[],
  signals: CodeBehaviorSignal[],
): ChangeIntentAnalysis["source"] {
  if (intents.length === 0) return "none";
  const usesCommitIntent = intents.some((intent) => intent.commits.length > 0);
  if (usesCommitIntent && commits.length > 0 && signals.length > 0) return "commits-and-diff";
  if (usesCommitIntent && commits.length > 0) return "commits";
  return "diff-only";
}
