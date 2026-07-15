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
const maxSignals = 40;

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
  const intents = commitClusters.map((cluster, index) =>
    buildCommitIntent(
      cluster,
      index,
      commitClusters.length,
      changedFiles,
      options.addedDiffText ?? {},
      codeSignals,
      riskEvidence,
    ),
  );

  if (intents.length === 0) {
    const diffIntent = buildDiffOnlyIntent(changedFiles, codeSignals, options.includeWorkingTree ?? false);
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
    "--format=%H%x1f%s%x1f%b%x1e",
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
      .map(parseCommitRecord)
      .filter((commit) => !/^merge\b/i.test(commit.subject));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push(`Could not read commit intent evidence: ${message}`);
    return [];
  }
}

function parseCommitRecord(record: string): ChangeIntentCommit {
  const [sha = "", subject = "", body = ""] = record.split("\u001f");
  return {
    sha: sha.trim(),
    subject: subject.trim(),
    body: body.trim() || undefined,
    statement: subject.trim(),
  };
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
  if (left.scope && right.scope && normalizeToken(left.scope) === normalizeToken(right.scope)) {
    return true;
  }
  const rightKeywords = new Set(right.keywords);
  return left.keywords.some((keyword) => rightKeywords.has(keyword) && keyword.length >= 4);
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
  const files = selectIntentFiles(keywords, changedFiles, addedDiffText, clusterCount);
  const relevantSignals = rankCodeSignalsForIntent(
    codeSignals.filter((signal) => files.includes(signal.file)),
    keywords,
  );
  const relevantRiskEvidence = riskEvidence.filter((item) => item.file && files.includes(item.file));
  const lifecycle = buildLifecycle(commits, relevantSignals);
  const confidence = confidenceForIntent(commits, lifecycle, relevantSignals);
  const title = sentenceTitle(commits.find((commit) => commit.seed)?.statement ?? commits[0].statement);
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
    ...relevantRiskEvidence.slice(0, 8),
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
  includesWorkingTree: boolean,
): ChangeIntent | undefined {
  const lifecycle = lifecycleFromCodeSignals(codeSignals);
  const stageKinds = new Set(lifecycle.map((stage) => stage.kind));
  if (lifecycle.length < 3 || stageKinds.size < 3) {
    return undefined;
  }
  const files = uniqueStrings(codeSignals.map((signal) => signal.file)).slice(0, maxIntentFiles);
  const titleSubject = humanizeIdentifier(path.basename(files[0] ?? "working tree change").replace(/\.[^.]+$/, ""));
  const title = `${titleSubject} ${includesWorkingTree ? "working-tree" : "changed"} behavior`;
  const evidence = uniqueEvidence(codeSignals.slice(0, 12).map((signal) => signal.evidence));
  const id = stableId("intent", `${includesWorkingTree ? "working-tree" : "diff"}:${files.join(":")}`);
  const keywords = extractKeywords(codeSignals.map((signal) => `${signal.symbol} ${signal.label}`).join(" "));
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

function selectIntentFiles(
  keywords: string[],
  changedFiles: string[],
  addedDiffText: Record<string, string>,
  clusterCount: number,
): string[] {
  const behaviorFiles = changedFiles.filter(isBehaviorBearingFile);
  if (clusterCount === 1) {
    return behaviorFiles.slice(0, maxIntentFiles);
  }
  const matched = behaviorFiles.filter((file) => {
    const searchable = `${file} ${addedDiffText[file] ?? ""}`.toLowerCase();
    return keywords.some((keyword) => searchable.includes(keyword));
  });
  return (matched.length > 0 ? matched : behaviorFiles).slice(0, maxIntentFiles);
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

  const existingKinds = new Set(stages.map((stage) => stage.kind));
  for (const signal of signals) {
    if (stages.length >= maxLifecycleStages) {
      break;
    }
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
    existingKinds.add(signal.kind);
  }

  return orderLifecycleStages(uniqueLifecycleStages(stages)).slice(0, maxLifecycleStages);
}

function lifecycleFromCodeSignals(signals: CodeBehaviorSignal[]): BehaviorLifecycleStage[] {
  const stages = signals
    .filter((signal) => !isImplementationOnlyLifecycleStep(`${signal.label} ${signal.symbol}`))
    .map((signal) => createLifecycleStage(signal.kind, signal.label, "low", [signal.evidence], [signal.file]));
  return orderLifecycleStages(uniqueLifecycleStages(stages)).slice(0, maxLifecycleStages);
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
  if (destinationParameterEvidence.length > 0) {
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

  if (/schedul|reminder|calendar|\bdate\b|\btime\b|daily|tomorrow|timezone/.test(searchable)) {
    scenarios.push(makeScenario(intentId, "calendar-boundary", "boundary", "critical", "Scheduling, calendar, and duplicate boundary", [
      "Prepare records near day, month, and timezone boundaries.",
    ], [
      "Repeat the changed scheduling action after its source time or date changes.",
      "Repeat the action without changing source data to expose duplicate side effects.",
    ], [
      "Verify the calculated date and time remain correct across boundaries.",
      "Verify stale or duplicate schedules are replaced, preserved, or rejected intentionally.",
    ], ["Timezone change", "Day rollover", "Duplicate invocation"], scenarioEvidenceFor(lifecycle, evidence, /schedul|reminder|calendar|\bdate\b|\btime\b|daily|tomorrow|timezone/i)));
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

  return rankIntentQaScenarios(uniqueScenarios(scenarios)).slice(0, 5);
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
  const limits: Partial<Record<BehaviorLifecycleStageKind, number>> = {
    trigger: 1,
    action: 1,
    "state-change": 2,
    "side-effect": 2,
  };
  const counts = new Map<BehaviorLifecycleStageKind, number>();
  const steps: string[] = [];
  for (const stage of lifecycle) {
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
  return uniqueCodeSignals(signals).slice(0, maxSignals);
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
          if (routingMatch && !/navigation\.setoptions/i.test(line.text)) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              routingMatch[1],
              `${side === "base" ? "Removed" : "Changed"} line contains entry or routing evidence for ${routingMatch[1]}.`,
              side,
            ));
          }
          const guardMatch = line.text.match(
            /(guard\w*|validat\w*|permission\w*|authoriz\w*|authenticat\w*|isAllowed|isDenied|protected)/i,
          );
          if (side === "base" && guardMatch) {
            evidence.push(diffRiskEvidence(
              file,
              hunk,
              line.line,
              guardMatch[1],
              `Removed line contains guard or validation evidence for ${guardMatch[1]}.`,
              side,
            ));
          }
        }
      }
    }
  }
  return uniqueEvidence(evidence);
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
    const label = `Trigger ${humanizeIdentifier(symbol)}.`;
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
    const label = `Handle ${humanizeIdentifier(symbol)}.`;
    signals.push({
      kind: "trigger",
      label,
      file,
      symbol,
      evidence: codeSignalEvidence(label, file, symbol, hunk, line),
    });
  }
  for (const match of text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)\s*\(/g)) {
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
  if (/^(?:on|handle)(?:press|click|submit|change|complete|open|response|message|select|toggle)/.test(value)) {
    return "trigger";
  }
  if (/(?:navigate|redirect|router\.(?:push|replace)|openurl|openlink|show|display|preview|render)/.test(value)) {
    return "observable-outcome";
  }
  if (/(?:resync|sync|persist|store|save|update|set[A-Z_]|cache|write|delete|remove|cancel|invalidate)/i.test(identifier)) {
    return "state-change";
  }
  if (/(?:schedule|notify|notification|request|fetch|mutate|post|send|emit|track|publish|upload|download)/.test(value)) {
    return "side-effect";
  }
  if (
    /(?:permission|authorized|authenticated|enabled|disabled|validate|guard)/i.test(identifier) ||
    /^(?:is|has|can|should|show|hide)[A-Z_]/.test(identifier)
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
    /\.(?:md|mdx|snap|map)$/i.test(file)
  );
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
    .replaceAll(".", " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
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
