import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
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

export interface ChangeIntentEvidence {
  kind: ChangeIntentEvidenceKind;
  value: string;
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
  diagnostics: string[];
}

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
  const codeSignals = collectCodeBehaviorSignals(options.addedDiffText ?? {}, options.addedDiffEvidence ?? {});
  const riskEvidence = collectDiffRiskEvidence(options.addedDiffEvidence ?? {});
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
        : "Commit evidence was available, but it did not contain a behavior-bearing feat, fix, hotfix, or performance intent.",
    );
  }

  return {
    base: options.base,
    head: options.head,
    source: changeIntentSource(intents, commits, codeSignals),
    commits,
    intents,
    diagnostics: uniqueStrings(diagnostics),
  };
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

function parseCommit(commit: ChangeIntentCommit): ParsedCommit {
  const match = commit.subject.match(/^([a-z][a-z0-9-]*)(?:\(([^)]+)\))?!?:\s*(.+)$/i);
  const conventionalType = match?.[1]?.toLowerCase();
  const scope = match?.[2]?.trim();
  const statement = (match?.[3] ?? commit.subject).trim();
  const actionSignals = lifecycleKeywordCount(`${statement} ${commit.body ?? ""}`);
  const seed = conventionalType
    ? behavioralCommitTypes.has(conventionalType)
    : actionSignals >= 2 && !isLowSignalCommitStatement(statement);
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
  };
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
    .filter((group) => group.some((commit) => commit.seed))
    .sort((left, right) => commits.indexOf(left[0]) - commits.indexOf(right[0]));
}

function commitsShareIntent(left: ParsedCommit, right: ParsedCommit): boolean {
  const rightKeywords = new Set(right.keywords);
  const scopeTokens = new Set(
    [left.scope, right.scope]
      .filter((scope): scope is string => Boolean(scope))
      .map(normalizeToken),
  );
  const sharedKeywords = left.keywords.filter((keyword) =>
    rightKeywords.has(keyword) && keyword.length >= 4 && !scopeTokens.has(keyword)
  );
  if (sharedKeywords.length > 0) {
    return true;
  }

  // Conventional scopes often name an entire package (for example `web` or
  // `app`), not one user intent. Scope equality must not merge unrelated
  // feature commits by itself.
  return false;
}

function buildCommitIntent(
  commits: ParsedCommit[],
  index: number,
  clusterCount: number,
  changedFiles: string[],
  addedDiffText: Record<string, string>,
  codeSignals: CodeBehaviorSignal[],
  riskEvidence: ChangeIntentEvidence[],
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
  );
  const relevantRiskEvidence = riskEvidence.filter((item) => item.file && files.includes(item.file));
  const lifecycle = buildLifecycle(commits, relevantSignals);
  const confidence = confidenceForIntent(commits, lifecycle, relevantSignals);
  const titleCommit = commits.find((commit) => commit.conventionalType === "feat" || commit.conventionalType === "feature") ??
    commits.find((commit) => commit.seed) ??
    commits[0];
  const title = sentenceTitle(titleCommit.statement);
  const evidence = uniqueEvidence([
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
  ]);
  const id = stableId("intent", `${index}:${commits.map((commit) => commit.sha).join(":")}:${title}`);
  const summary = commits
    .map((commit) => stripTerminalPunctuation(commit.statement))
    .filter(Boolean)
    .slice(0, 4)
    .join("; ");
  const scenarios = buildIntentQaScenarios(id, title, lifecycle, keywords, evidence, confidence);
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

function buildDiffOnlyIntent(
  changedFiles: string[],
  codeSignals: CodeBehaviorSignal[],
  riskEvidence: ChangeIntentEvidence[],
  includesWorkingTree: boolean,
): ChangeIntent | undefined {
  const lifecycle = lifecycleFromCodeSignals(codeSignals);
  const stageKinds = new Set(lifecycle.map((stage) => stage.kind));
  if (lifecycle.length < 3 || stageKinds.size < 3) {
    return undefined;
  }
  const files = uniqueStrings(codeSignals.map((signal) => signal.file)).slice(0, maxIntentFiles);
  const titleSubject = diffIntentSubject(files[0]);
  const title = `${titleSubject} ${includesWorkingTree ? "working-tree" : "changed"} behavior`;
  const evidence = uniqueEvidence([
    ...codeSignals.slice(0, 16).map((signal) => signal.evidence),
    ...selectRiskEvidence(riskEvidence, 24),
  ]);
  const id = stableId("intent", `${includesWorkingTree ? "working-tree" : "diff"}:${files.join(":")}`);
  const keywords = extractKeywords([
    ...codeSignals.map((signal) => `${signal.symbol} ${signal.label}`),
    ...riskEvidence.map((item) => `${item.symbol ?? ""} ${item.value}`),
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

function diffIntentSubject(file: string | undefined): string {
  if (!file) return "Working tree";
  const extensionless = path.basename(file).replace(/\.[^.]+$/, "");
  const subject = /^(?:index|page|route)$/i.test(extensionless)
    ? path.basename(path.dirname(file))
    : extensionless;
  return humanizeIdentifier(subject || "changed behavior");
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
  if (commitChangedFiles.length > 0) {
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

function buildLifecycle(commits: ParsedCommit[], signals: CodeBehaviorSignal[]): BehaviorLifecycleStage[] {
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
    const alreadyRepresented = stages.some((stage) =>
      stage.label.toLowerCase().includes(signal.symbol.toLowerCase()) ||
      (stage.kind === signal.kind && lifecycleLabelsOverlap(stage.label, signal.label)),
    );
    if (alreadyRepresented) {
      continue;
    }
    stages.push(createLifecycleStage(signal.kind, signal.label, "medium", [signal.evidence], [signal.file]));
  }

  return limitLifecycleStages(stages);
}

function lifecycleFromCodeSignals(signals: CodeBehaviorSignal[]): BehaviorLifecycleStage[] {
  const stages = signals
    .filter((signal) => !isImplementationOnlyLifecycleStep(`${signal.label} ${signal.symbol}`))
    .map((signal) => createLifecycleStage(signal.kind, signal.label, "low", [signal.evidence], [signal.file]));
  return limitLifecycleStages(stages);
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
): BehaviorLifecycleStage {
  const normalizedLabel = sentenceLabel(label);
  return {
    id: stableId("stage", `${kind}:${normalizedLabel}:${evidence.map((item) => item.commit ?? item.file ?? item.value).join(":")}`),
    kind,
    label: normalizedLabel,
    confidence,
    evidence: uniqueEvidence(evidence),
    files: uniqueStrings(files),
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
  const actions = selectPrimaryLifecycleSteps(lifecycle);
  const outcomeStages = lifecycle.filter((stage) => stage.kind === "observable-outcome");
  const locatedOutcomeStages = outcomeStages.filter((stage) => hasActionableLocatedDiffEvidence(stage.evidence));
  const outcomes = (locatedOutcomeStages.length > 0 ? locatedOutcomeStages : outcomeStages)
    .map((stage) => assertionForStage(stage));
  const sideEffects = lifecycle.filter((stage) => stage.kind === "side-effect").map((stage) => assertionForStage(stage));
  const primaryEvidence = lifecycleEvidence(lifecycle, evidence);
  const primaryHasActionableEvidence = hasActionableLocatedDiffEvidence(primaryEvidence);
  const primary: IntentQaScenario = {
    id: stableId("scenario", `${intentId}:primary`),
    kind: "primary",
    priority: primaryHasActionableEvidence && confidence !== "low" ? "critical" : "recommended",
    title,
    rationale: "Commit and diff evidence describe this changed behavior lifecycle; verify the complete observable path before merge.",
    setup: conditions.length > 0 ? conditions : ["Prepare representative pre-change and changed-branch state."],
    steps: actions.length > 0 ? actions : lifecycle.map((stage) => stage.label),
    assertions: outcomes.length > 0 ? outcomes : sideEffects.slice(0, 2),
    edgeCases: [],
    evidence: primaryEvidence.slice(0, 8),
    confidence,
    reviewRequired: confidence !== "high" || !primaryHasActionableEvidence,
  };
  if (primary.assertions.length === 0) {
    primary.assertions.push("Verify the externally observable result matches the commit intent.");
  }

  const scenarios = [primary];
  const searchable = `${title} ${keywords.join(" ")} ${lifecycle.map((stage) => stage.label).join(" ")}`.toLowerCase();

  const removedGuardEvidence = evidence.filter((item) =>
    item.kind === "diff" &&
    item.side === "base" &&
    item.relation === "direct" &&
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

  const changedConditionEvidence = scenarioEvidenceFor(
    lifecycle,
    evidence,
    /\b(?:is|has|can|should|show|hide)[A-Z_\w]*|eligible|available|loaded|loading|empty|ready|selected/i,
    /color|theme|style|class|layout|size|width|height|dark|light/i,
  );
  if (changedConditionEvidence.length > 0 && !/toggle|enable|disable|permission|authoriz|auth|guard/.test(searchable)) {
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

  const destinationParameterEvidence = evidence.filter((item) =>
    item.kind === "diff" &&
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

  const calendarEvidence = scenarioEvidenceFor(
    lifecycle,
    evidence,
    /schedul|reminder|calendar|daily|tomorrow|timezone/i,
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

  if (/toggle|enable|disable|permission|authoriz|auth|guard/.test(searchable)) {
    scenarios.push(makeScenario(intentId, "guard-state", "state-transition", "critical", "Disabled, denied, and re-enabled state", [
      "Prepare allowed, disabled, and denied states for the changed condition.",
    ], [
      "Run the behavior while the condition is disabled or denied.",
      "Enable or restore the condition and repeat the behavior.",
    ], [
      "Verify no protected side effect occurs while blocked.",
      "Verify re-enabling produces one correct side effect without stale state.",
    ], ["Permission denied", "Feature disabled", "State restored"], scenarioEvidenceFor(lifecycle, evidence, /toggle|enable|disable|permission|authoriz|auth|guard/i)));
  }

  const entryRoutingSearchable = searchable.replaceAll("navigation.setoptions", "");
  const explicitOpenDestination = /\bopen\b[^.;]{0,80}\b(?:linked|destination|route|screen|page|detail|summary)\b/.test(
    entryRoutingSearchable,
  );
  if (/navigat|redirect|route|deep.?link|payload|destination/.test(entryRoutingSearchable) || explicitOpenDestination) {
    const routingEvidencePattern = explicitOpenDestination
      ? /open|navigat|redirect|route|deep.?link|payload|destination/i
      : /navigat|redirect|route|deep.?link|payload|destination/i;
    scenarios.push(makeScenario(intentId, "entry-routing", "failure", "critical", "Entry payload and destination routing", [
      "Prepare valid, missing, and stale entry payloads.",
    ], [
      "Enter through the changed external or internal trigger.",
      "Repeat with missing or invalid destination context.",
    ], [
      "Verify a valid payload opens the matching destination and state.",
      "Verify invalid context fails safely without opening unrelated data.",
    ], ["Missing payload", "Stale identifier", "Repeated entry"], scenarioEvidenceFor(
      lifecycle,
      evidence,
      routingEvidencePattern,
      /navigation\.setoptions/i,
    )));
  }

  if (/fetch|request|network|endpoint|api|mutation|response|timeout/.test(searchable)) {
    scenarios.push(makeScenario(intentId, "network-failure", "failure", "recommended", "Failure, timeout, and retry handling", [
      "Prepare success, empty, unauthorized, timeout, and server-error responses.",
    ], [
      "Run the changed behavior for each reachable response.",
      "Retry after a transient failure when the product supports retry.",
    ], [
      "Verify each response produces the intended visible or persisted state.",
      "Verify retries do not duplicate requests or side effects.",
    ], ["Unauthorized", "Timeout", "Server error", "Duplicate retry"], scenarioEvidenceFor(lifecycle, evidence, /fetch|request|network|endpoint|api|mutation|response|timeout/i)));
  }

  const shareEvidence = scenarioEvidenceFor(
    lifecycle,
    evidence,
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
    lifecycle,
    evidence,
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
    lifecycle,
    evidence,
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

  if (/sync|persist|storage|cache|reload|re.?entry|save|store/.test(searchable)) {
    scenarios.push(makeScenario(intentId, "state-reentry", "state-transition", "recommended", "Re-entry and stale state recovery", [
      "Prepare current and stale persisted state.",
    ], [
      "Run the changed mutation and leave the affected surface.",
      "Reload or re-enter through the normal entry point.",
    ], [
      "Verify the latest state survives or is invalidated intentionally.",
      "Verify stale state cannot overwrite the changed result.",
    ], ["Stale cache", "App restart", "Repeated synchronization"], scenarioEvidenceFor(lifecycle, evidence, /sync|persist|storage|cache|reload|re.?entry|save|store/i)));
  }

  return rankIntentQaScenarios(uniqueScenarios(scenarios)).slice(0, maxQaScenariosPerIntent);
}

function lifecycleEvidence(
  lifecycle: BehaviorLifecycleStage[],
  fallback: ChangeIntentEvidence[],
): ChangeIntentEvidence[] {
  const evidence = uniqueEvidence(lifecycle.flatMap((stage) => stage.evidence));
  return evidence.length > 0 ? evidence : fallback;
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

function selectPrimaryLifecycleSteps(lifecycle: BehaviorLifecycleStage[]): string[] {
  const hasCommitBackedAction = lifecycle.some((stage) =>
    stage.kind === "action" && stage.evidence.some((item) => item.kind === "commit"),
  );
  const hasUserAction = lifecycle.some((stage) => stage.kind === "action");
  const limits: Partial<Record<BehaviorLifecycleStageKind, number>> = {
    trigger: 1,
    action: 1,
    "state-change": 2,
    "side-effect": 2,
  };
  const counts = new Map<BehaviorLifecycleStageKind, number>();
  const steps: string[] = [];
  for (const stage of lifecycle) {
    if (hasCommitBackedAction && isImplementationShapedTriggerStage(stage)) {
      continue;
    }
    if (hasUserAction && isImplementationShapedStateChangeStage(stage)) {
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

function isImplementationShapedTriggerStage(stage: BehaviorLifecycleStage): boolean {
  if (stage.kind !== "trigger" || stage.evidence.some((item) => item.kind === "commit")) {
    return false;
  }
  return /^Trigger\s+(?:set|handle|use|update|dispatch|emit|mutate|invoke|call)\b/i.test(stage.label);
}

function isImplementationShapedStateChangeStage(stage: BehaviorLifecycleStage): boolean {
  if (stage.kind !== "state-change" || stage.evidence.some((item) => item.kind === "commit")) {
    return false;
  }
  return /^Update state through (?:set|update|dispatch|emit|mutate|use)[A-Z0-9_]/.test(stage.label);
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

function collectCodeBehaviorSignals(
  addedDiffText: Record<string, string>,
  addedDiffEvidence: AddedDiffEvidence,
): CodeBehaviorSignal[] {
  const signals: CodeBehaviorSignal[] = [];
  const locatedFiles = new Set<string>();
  for (const [file, hunks] of Object.entries(addedDiffEvidence)) {
    if (!isBehaviorBearingFile(file)) {
      continue;
    }
    locatedFiles.add(file);
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        collectCodeBehaviorSignalsFromText(signals, file, line.text, hunk, line.line);
      }
    }
  }
  for (const [file, text] of Object.entries(addedDiffText)) {
    if (!isBehaviorBearingFile(file) || locatedFiles.has(file)) {
      continue;
    }
    collectCodeBehaviorSignalsFromText(signals, file, text);
  }
  return selectCodeSignals(signals);
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

function collectDiffRiskEvidence(addedDiffEvidence: AddedDiffEvidence): ChangeIntentEvidence[] {
  const evidence: ChangeIntentEvidence[] = [];
  for (const [file, hunks] of Object.entries(addedDiffEvidence)) {
    if (!isBehaviorBearingFile(file)) {
      continue;
    }
    for (const hunk of hunks) {
      for (const [side, lines] of [["head", hunk.lines], ["base", hunk.removedLines ?? []]] as const) {
        for (const line of lines) {
          const calendarMatch = line.text.match(
            /(timezone|scheduledAt|\bschedule\w*\b|\breminder\w*\b|\bcalendar\b|\btomorrow\b|\bdaily\b)/i,
          );
          if (calendarMatch) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              calendarMatch[1],
              `${side === "base" ? "Removed" : "Changed"} line contains calendar or scheduling evidence for ${calendarMatch[1]}.`,
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
): ChangeIntentEvidence {
  return {
    kind: "diff",
    value,
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

function collectCodeBehaviorSignalsFromText(
  signals: CodeBehaviorSignal[],
  file: string,
  text: string,
  hunk?: AddedDiffHunk,
  line?: number,
): void {
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
    /\b(?:onClick|onPress|onSubmit|onChange|onEnded)\s*=\s*\{\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*(?:\{[^}\n]*?)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g,
  )) {
    const symbol = match[1];
    const label = `Trigger ${humanizeEventHandler(symbol.split(".").at(-1) ?? symbol)}.`;
    signals.push({
      kind: "trigger",
      label,
      file,
      symbol,
      evidence: codeSignalEvidence(label, file, symbol, hunk, line),
    });
  }
  const conditionExpressions = [
    ...[...text.matchAll(/v-(?:if|else-if)\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]),
    ...[...text.matchAll(/\bif\s*\(([^)]{1,240})\)/g)].map((match) => match[1]),
    ...[...text.matchAll(/\{\s*((?:is|has|can|should|show|hide)[A-Z_][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+)?)\s*(?:&&|\?)/g)]
      .map((match) => match[1]),
  ];
  for (const expression of conditionExpressions) {
    const identifiers = expression.match(/\b(?:is|has|can|should|show|hide)[A-Z_][A-Za-z0-9_$]*/g) ?? [];
    for (const symbol of identifiers) {
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

function codeSignalLabel(kind: BehaviorLifecycleStageKind, symbol: string): string {
  if (kind === "trigger") {
    return `Trigger ${humanizeIdentifier(symbol)}.`;
  }
  if (kind === "condition") {
    return `Check ${humanizeIdentifier(symbol)}.`;
  }
  if (kind === "state-change") {
    return `Update state through ${symbol}.`;
  }
  if (kind === "side-effect") {
    return `Invoke ${symbol}.`;
  }
  if (kind === "observable-outcome") {
    return `Observe the result of ${symbol}.`;
  }
  return `Run ${symbol}.`;
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
  const clauses = stripped
    .split(/\s+(?:and then|then|and)\s+/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length >= 4);
  return clauses.length > 0 ? clauses : [stripped];
}

function classifyLifecycleClause(clause: string): BehaviorLifecycleStageKind {
  const value = clause.toLowerCase();
  if (/^(?:show|display|render|preview|tease|open|navigate|redirect|surface|return)\b/.test(value)) {
    return "observable-outcome";
  }
  if (/^(?:save|persist|store|update|sync|resync|cache|set|cancel|remove|delete|invalidate|toggle)\b/.test(value)) {
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
  if (/\b(?:save|persist|store|update|sync|resync|cache|set|cancel|remove|delete|invalidate|toggle)\b/.test(value)) {
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
  return !(
    /(?:^|\/)(?:docs?|test|tests|__tests__|fixtures?|snapshots?|coverage|dist|build)\//i.test(file) ||
    /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG\.md|README\.md)$/i.test(file) ||
    /\.(?:md|mdx|snap|map)$/i.test(file) ||
    /\.(?:avif|bmp|gif|ico|jpe?g|png|webp|svg|mp3|m4a|ogg|wav|woff2?|ttf|otf|eot|pdf|zip|gz|br)$/i.test(file)
  );
}

function isStructuredDataFile(file: string): boolean {
  return /\.(?:csv|json|json5|toml|ya?ml)$/i.test(file);
}

function stripParsedCommitFields(commit: ParsedCommit): ChangeIntentCommit {
  const { seed: _seed, supporting: _supporting, keywords: _keywords, ...result } = commit;
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
    const key = `${item.kind}:${item.relation ?? ""}:${item.side ?? ""}:${item.commit ?? ""}:${item.file ?? ""}:${item.startLine ?? ""}:${item.endLine ?? ""}:${item.symbol ?? ""}:${item.value}`;
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
  return `Verify ${lowercaseFirst(stripTerminalPunctuation(stage.label))}.`;
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
