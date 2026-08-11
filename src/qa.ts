import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  formatDraftReadinessStage,
  generateE2eDraft,
  resolveE2eWorkspaceTargets,
} from "./e2e.js";
import type {
  E2eDraftActionItem,
  E2eDraftFile,
  E2eDraftOptions,
  E2eDraftReadinessSummary,
  E2eDraftResult,
  E2eFlowLanguageBrief,
  E2eProjectType,
  E2eRunnerName,
  E2eScenarioAutomationReceipt,
  E2eWorkspaceTarget,
} from "./e2e.js";
import type { ChangeIntentAnalysis, ChangeIntentEvidence, IntentQaScenario } from "./change-intent.js";
import { collectChangedFiles, readFileAtRef } from "./git-context.js";
import {
  evaluateQaCapabilities,
  neutralizeInstructionLikeValues,
  qaActionContract,
  qaEvidenceBoundary,
} from "./qa-contract.js";
import type {
  QaActionContract,
  QaActionId,
  QaCapabilityResult,
  QaEvidenceBoundary,
} from "./qa-contract.js";
import { buildQaReasoningTraces, summarizeQaTraceEvidence } from "./qa-trace.js";
import type {
  QaKnowledgeAuthority,
  QaReasoningTrace,
  QaTestClass,
  QaTraceEvidenceSummary,
} from "./qa-trace.js";
import { routeQaScenario } from "./scenario-routing.js";
import { collectChangedTestContracts } from "./test-evidence.js";
import type { ChangedTestContract } from "./test-evidence.js";
import {
  buildWorkspaceScriptCommand,
  collectAddedDiffEvidence,
  generateTestPlan,
} from "./test-plan.js";
import type { AddedDiffEvidence } from "./test-plan.js";
import { TOOL_NAME, VERSION } from "./version.js";

export interface QaDraftOptions extends Omit<E2eDraftOptions, "dryRun" | "output"> {
  automaticWorkspaceScope?: boolean;
}

export interface QaDraftResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  generatedAt: string;
  base: string;
  baseResolution: E2eDraftResult["plan"]["baseResolution"];
  head: string;
  includeWorkingTree: boolean;
  project: E2eProjectType;
  runner: E2eRunnerName;
  manifestPath?: string;
  noCloud: true;
  noLlmToken: true;
  analysisScope: QaAnalysisScope;
  execution: QaExecutionReceipt;
  testSuite: E2eDraftResult["plan"]["testSuite"];
  changedTestContracts: ChangedTestContract[];
  currentDelta?: QaCurrentDelta;
  bootstrap: E2eDraftResult["plan"]["bootstrap"];
  runnerSetup: E2eDraftResult["plan"]["runnerSetup"];
  changeAnalysis: E2eDraftResult["plan"]["changeAnalysis"];
  traces: QaReasoningTrace[];
  evidenceSummary: QaTraceEvidenceSummary;
  capabilities: QaCapabilityResult[];
  route: QaRouteDecision;
  action: QaActionContract;
  evidenceBoundary: QaEvidenceBoundary;
  readiness: QaReadinessSummary;
  flows: QaDraftFlow[];
  missingEvidence: QaDraftMissingEvidence[];
  prChecklist: string[];
  agentHandoff: string[];
  suggestedCommands: string[];
}

export type QaReadinessBasis = "optional-automation" | "repository-validation";
export type QaVerificationStatus = "ready-to-run" | "command-needed";
export type QaRouteStatus =
  | "draft-ready"
  | "draft-near-runnable"
  | "draft-needs-work"
  | "draft-blocked"
  | "verification-ready-to-run"
  | "verification-command-needed";
export type QaRouteNextAction =
  QaActionId;

export interface QaRouteDecision {
  basis: QaReadinessBasis;
  status: QaRouteStatus;
  nextAction: QaRouteNextAction;
  command?: string;
}

export interface QaReadinessSummary extends E2eDraftReadinessSummary {
  basis: QaReadinessBasis;
  automationApplicable: boolean;
  verificationStatus?: QaVerificationStatus;
}

export interface QaStaticExecutionReceipt {
  status: "not-run";
  performed: false;
  scope: "static-analysis-and-draft-mapping";
}

export interface QaBlockedExecutionReceipt {
  status: "blocked";
  performed: false;
  scope: "repository-validation";
  reason: string;
  command?: string;
}

export interface QaCompletedExecutionReceipt {
  status: "passed" | "failed";
  performed: true;
  scope: "repository-validation";
  command: string;
  cwd: ".";
  exitCode?: number;
  signal?: string;
  durationMs: number;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  gitState: QaGitStateReceipt;
}

export interface QaObservedGitStateReceipt {
  observed: true;
  changed: boolean;
  changedPathCount: number;
  changedPaths: string[];
  truncated: boolean;
  headChanged: boolean;
  branchChanged: boolean;
  beforeSha256: string;
  afterSha256: string;
}

export interface QaUnavailableGitStateReceipt {
  observed: false;
  changed: null;
  reason: string;
}

export type QaGitStateReceipt =
  | QaObservedGitStateReceipt
  | QaUnavailableGitStateReceipt;

export type QaExecutionReceipt =
  | QaStaticExecutionReceipt
  | QaBlockedExecutionReceipt
  | QaCompletedExecutionReceipt;

export type QaAnalysisScopeMode = "repository-root" | "automatic-package" | "explicit-package";
export type QaCommandWorkingDirectory = "workspace-root" | "selected-package";

export interface QaAnalysisScopeCandidate {
  path: string;
  packageName?: string;
  project: E2eProjectType;
  runner: E2eRunnerName;
  changedFiles: number;
}

export interface QaAnalysisScope {
  mode: QaAnalysisScopeMode;
  workspaceRoot: string;
  commandCwd?: QaCommandWorkingDirectory;
  selectedPath?: string;
  packageName?: string;
  candidates: QaAnalysisScopeCandidate[];
  reason: string;
}

export interface QaDraftFlow {
  title: string;
  source: string;
  draftPath: string;
  runnableStatus?: E2eDraftFile["runnableStatus"];
  promotionStatus?: E2eDraftFile["promotionStatus"];
  changedFiles: string[];
  userJourney?: E2eFlowLanguageBrief;
  draftSteps: string[];
  coverageTargets: string[];
  entrypointHints: string[];
  selectorHints: string[];
  existingEvidencePaths: string[];
  verificationMode?: QaVerificationMode;
  setupHints: string[];
  manifestUpdatePath?: string;
  scenarioAutomation: E2eScenarioAutomationReceipt[];
  why: string[];
  authority: QaKnowledgeAuthority;
  approvalRequired: boolean;
  testClass: QaTestClass;
}

export interface QaCurrentDelta {
  scope: "working-tree-only";
  files: string[];
  repositoryContracts: ChangedTestContract[];
}

type QaVerificationMode =
  | "command-contract"
  | "analysis-rule"
  | "schema-graph"
  | "transformation-contract"
  | "existing-test-evidence"
  | "configuration"
  | "documentation"
  | "generated-artifact";

export interface QaDraftMissingEvidence {
  flowTitle: string;
  priority: "required" | "recommended";
  kind: string;
  title: string;
  detail: string;
}

interface QaRuntimePrerequisiteTestGap {
  testFile: string;
  routeFile: string;
  consumerFile: string;
  wrapperFile?: string;
}

export async function generateQaDraft(rootInput: string, options: QaDraftOptions = {}): Promise<QaDraftResult> {
  const root = path.resolve(rootInput);
  const {
    automaticWorkspaceScope = true,
    ...e2eOptions
  } = options;
  let detectedScope: QaAnalysisScope | undefined;

  if (automaticWorkspaceScope && !e2eOptions.workspaceRoot) {
    const preflight = await generateTestPlan(root, e2eOptions);
    const workspaceTargets = await resolveE2eWorkspaceTargets(root, preflight);
    const candidates = workspaceTargets.map(qaScopeCandidate);
    const selected = selectAutomaticWorkspaceTarget(workspaceTargets, preflight.changedFiles.map((file) => file.path));
    if (selected) {
      const scoped = await generateQaDraft(path.join(root, selected.path), {
        ...e2eOptions,
        base: preflight.base,
        head: preflight.head,
        workspaceRoot: root,
        automaticWorkspaceScope: false,
      });
      const qualified = qualifyAutomaticPackageCommands(scoped, selected.path);
      return {
        ...qualified,
        analysisScope: {
          mode: "automatic-package",
          workspaceRoot: root,
          commandCwd: "workspace-root",
          selectedPath: selected.path,
          packageName: selected.packageName,
          candidates,
          reason: `${selected.changedFileCount} changed file${selected.changedFileCount === 1 ? "" : "s"} belong to one changed package, so QAMap used that package's routes, scripts, fixtures, and runner settings.`,
        },
      };
    }
    detectedScope = {
      mode: "repository-root",
      workspaceRoot: root,
      commandCwd: "workspace-root",
      candidates,
      reason: workspaceRootScopeReason(workspaceTargets, preflight.changedFiles.map((file) => file.path)),
    };
  }

  const draft = await generateE2eDraft(root, {
    ...e2eOptions,
    dryRun: true,
  });
  const addedDiffEvidence = await collectAddedDiffEvidence(root, {
    base: draft.plan.base,
    head: draft.plan.head,
    workspaceRoot: e2eOptions.workspaceRoot,
    includeWorkingTree: draft.plan.includeWorkingTree,
  });
  const currentDelta = await collectCurrentDelta(root, draft, e2eOptions.workspaceRoot);
  const latestCommitContracts = await collectLatestCommitContracts(
    root,
    draft.plan.head,
    e2eOptions.workspaceRoot,
  );
  const changedTestContracts = uniqueChangedTestContracts([
    ...(currentDelta?.repositoryContracts ?? []),
    ...latestCommitContracts,
    ...collectChangedTestContracts(addedDiffEvidence),
  ]);
  const runtimePrerequisiteTestGaps = await collectRuntimePrerequisiteTestGaps(
    root,
    draft.plan.changeAnalysis,
    changedTestContracts,
    addedDiffEvidence,
    {
      head: draft.plan.head,
      includeWorkingTree: draft.plan.includeWorkingTree,
      workspaceRoot: e2eOptions.workspaceRoot,
    },
  );
  const runtimeGapTestFiles = new Set(runtimePrerequisiteTestGaps.map((gap) => gap.testFile));
  const trustworthyChangedTestContracts = changedTestContracts.filter(
    (contract) => !runtimeGapTestFiles.has(contract.file),
  );
  const qaFiles = draft.plan.changedFiles.length > 0 ? draft.files : [];
  const inferredFlows = preferChangedTestEvidence(
    qaFiles.map((file) => qaFlowFromDraftFile(file)),
    trustworthyChangedTestContracts,
    runtimeGapTestFiles,
  );
  const flows = inferredFlows.length > 0
    ? inferredFlows
    : trustworthyChangedTestContracts.length > 0
      ? [qaFlowFromChangedTestContracts(trustworthyChangedTestContracts)]
      : [];
  const changedFiles = draft.plan.changedFiles.map((file) => file.path);
  const preferredVerificationCommands = await buildChangedTestVerificationCommands(
    root,
    flows,
    changedFiles,
    draft.plan.suggestedCommands,
  );
  const currentDeltaCommands = currentDelta
    ? await buildTestVerificationCommands(
        root,
        currentDelta.repositoryContracts
          .filter((contract) => !runtimeGapTestFiles.has(contract.file))
          .map((contract) => contract.file),
        draft.plan.suggestedCommands,
      )
    : [];
  const latestCommitCommands = await buildTestVerificationCommands(
    root,
    latestCommitContracts
      .filter((contract) =>
        !runtimeGapTestFiles.has(contract.file) &&
        flows[0] &&
        changedTestContractScore(flows[0], contract) > 0
      )
      .map((contract) => contract.file),
    draft.plan.suggestedCommands,
  );
  const candidateCommands = currentDelta
    ? uniqueStrings([
        ...currentDeltaCommands,
        ...latestCommitCommands,
        ...draft.plan.suggestedCommands.filter((command) => !isFocusedValidationCommand(command)),
        ...preferredVerificationCommands,
        ...draft.plan.suggestedCommands,
      ])
    : uniqueStrings([
        ...latestCommitCommands,
        ...preferredVerificationCommands,
        ...draft.plan.suggestedCommands,
      ]);
  const candidateCommandsWithoutInsufficientTests = candidateCommands.filter((command) =>
    ![...runtimeGapTestFiles].some((testFile) => focusedCommandTargetsFile(command, testFile))
  );
  const routedCandidateCommands = flows.some((flow) => flow.verificationMode === "schema-graph")
    ? candidateCommandsWithoutInsufficientTests.filter(isMigrationGraphValidationCommand)
    : candidateCommandsWithoutInsufficientTests;
  const suggestedCommands = await preferLocallyRunnableValidationCommands(root, routedCandidateCommands);
  const missingEvidence = uniqueMissingEvidence([
    ...runtimePrerequisiteTestGaps.map(runtimePrerequisiteMissingEvidence),
    ...buildMissingEvidence(qaFiles),
  ]).slice(0, 12);
  const traces = buildQaReasoningTraces(
    draft.plan.changeAnalysis.intents,
    flows.flatMap((flow) => flow.scenarioAutomation.map((receipt) => ({
      scenarioId: receipt.scenarioId,
      flowTitle: flow.title,
      draftPath: flow.draftPath,
      status: receipt.status,
      mappedSteps: receipt.mappedSteps,
      totalSteps: receipt.totalSteps,
      mappedAssertions: receipt.mappedAssertions,
      totalAssertions: receipt.totalAssertions,
      manifestUpdatePath: flow.manifestUpdatePath,
    }))),
    flows
      .filter((flow): flow is QaDraftFlow & { manifestUpdatePath: string } => Boolean(flow.manifestUpdatePath))
      .map((flow) => ({
        flowTitle: flow.title,
        changedFiles: flow.changedFiles,
        manifestUpdatePath: flow.manifestUpdatePath,
      })),
  );
  const evidenceSummary = summarizeQaTraceEvidence(traces);
  const readiness = buildQaReadiness(draft.readinessSummary, flows, suggestedCommands, changedFiles);
  const route = buildQaRouteDecision(readiness, suggestedCommands);
  const capabilities = evaluateQaCapabilities({
    intents: {
      total: draft.plan.changeAnalysis.intents.length,
      evidenceBacked: draft.plan.changeAnalysis.intents.filter((intent) =>
        intent.evidence.some((item) =>
          item.kind === "diff" &&
          Boolean(item.file) &&
          item.startLine !== undefined &&
          item.relation !== "contextual"
        )
      ).length,
    },
    traces: {
      total: traces.length,
      confirmed: evidenceSummary.confirmed,
    },
    scenarios: {
      total: traces.length,
      routed: traces.filter((trace) => trace.scenario.decision !== "review-only").length,
      reviewOnly: traces.filter((trace) => trace.scenario.decision === "review-only").length,
    },
    repositoryValidation: {
      applicable: readiness.basis === "repository-validation",
      commandAvailable: Boolean(route.command),
      contractCount: trustworthyChangedTestContracts.length,
      testSuitePresent: draft.plan.testSuite.hasTestSuite,
    },
    automation: {
      applicable: readiness.automationApplicable,
      compiled: readiness.compiledScenarios,
      partial: readiness.partialScenarios,
      notCompiled: readiness.notCompiledScenarios,
      requiredGaps: readiness.requiredScenarioGaps,
    },
  });

  const result: QaDraftResult = {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    generatedAt: new Date().toISOString(),
    base: draft.plan.base,
    baseResolution: draft.plan.baseResolution,
    head: draft.plan.head,
    includeWorkingTree: draft.plan.includeWorkingTree,
    project: draft.plan.project.type,
    runner: draft.runner,
    manifestPath: draft.plan.verificationManifestPath,
    noCloud: true,
    noLlmToken: true,
    analysisScope: detectedScope ?? explicitOrRootAnalysisScope(root, e2eOptions.workspaceRoot),
    execution: {
      status: "not-run",
      performed: false,
      scope: "static-analysis-and-draft-mapping",
    },
    testSuite: draft.plan.testSuite,
    changedTestContracts,
    currentDelta,
    bootstrap: draft.plan.bootstrap,
    runnerSetup: draft.plan.runnerSetup,
    changeAnalysis: draft.plan.changeAnalysis,
    traces,
    evidenceSummary,
    capabilities,
    route,
    action: qaActionContract(route.nextAction),
    evidenceBoundary: {
      ...qaEvidenceBoundary,
      neutralizedValues: 0,
    },
    readiness,
    flows,
    missingEvidence,
    prChecklist: buildPrChecklist(
      draft,
      flows,
      trustworthyChangedTestContracts,
      suggestedCommands,
      runtimePrerequisiteTestGaps,
    ),
    agentHandoff: buildAgentHandoff(
      draft,
      flows,
      trustworthyChangedTestContracts,
      missingEvidence,
      suggestedCommands,
    ),
    suggestedCommands,
  };
  const protectedResult = neutralizeInstructionLikeValues(result);
  return {
    ...protectedResult.value,
    evidenceBoundary: {
      ...qaEvidenceBoundary,
      neutralizedValues: protectedResult.neutralizedValues,
    },
  };
}

async function collectCurrentDelta(
  root: string,
  draft: E2eDraftResult,
  workspaceRoot: string | undefined,
): Promise<QaCurrentDelta | undefined> {
  if (!draft.plan.includeWorkingTree) {
    return undefined;
  }
  const evidence = await collectAddedDiffEvidence(root, {
    base: draft.plan.head,
    head: draft.plan.head,
    workspaceRoot,
    includeWorkingTree: true,
  });
  const gitRoot = workspaceRoot ? path.resolve(workspaceRoot) : root;
  const relativeRoot = workspaceRoot
    ? toPosixPath(path.relative(gitRoot, root)).replace(/^\.\/+|\/+$/g, "")
    : "";
  const changedFiles = await collectChangedFiles(gitRoot, {
    base: draft.plan.head,
    head: draft.plan.head,
    includeWorkingTree: true,
  });
  const files = uniqueStrings(
    changedFiles
      .map((file) => {
        const normalized = toPosixPath(file.path);
        if (!relativeRoot) {
          return normalized;
        }
        const prefix = `${relativeRoot}/`;
        return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
      })
      .filter((file): file is string => Boolean(file)),
  ).sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    return undefined;
  }
  return {
    scope: "working-tree-only",
    files,
    repositoryContracts: collectChangedTestContracts(evidence),
  };
}

async function collectLatestCommitContracts(
  root: string,
  head: string,
  workspaceRoot: string | undefined,
): Promise<ChangedTestContract[]> {
  const evidence = await collectAddedDiffEvidence(root, {
    base: `${head}^`,
    head,
    workspaceRoot,
  });
  return collectChangedTestContracts(evidence);
}

function uniqueChangedTestContracts(contracts: ChangedTestContract[]): ChangedTestContract[] {
  const seen = new Set<string>();
  return contracts.filter((contract) => {
    const key = `${contract.file}:${contract.line}:${contract.title}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function collectRuntimePrerequisiteTestGaps(
  root: string,
  analysis: ChangeIntentAnalysis,
  contracts: ChangedTestContract[],
  evidence: AddedDiffEvidence,
  options: {
    head: string;
    includeWorkingTree: boolean;
    workspaceRoot?: string;
  },
): Promise<QaRuntimePrerequisiteTestGap[]> {
  const runtimeIntents = analysis.intents.filter((intent) =>
    intent.keywords.includes("runtime-prerequisite")
  );
  if (runtimeIntents.length === 0 || contracts.length === 0) {
    return [];
  }
  const testFiles = uniqueStrings(contracts.map((contract) => contract.file));
  const testSources = new Map<string, string>();
  await Promise.all(testFiles.map(async (testFile) => {
    const source = await readQaSourceAtEvidenceBoundary(root, testFile, options);
    const changedText = (evidence[testFile] ?? [])
      .flatMap((hunk) => hunk.lines.map((line) => line.text))
      .join("\n");
    testSources.set(testFile, source ?? changedText);
  }));
  const gaps: QaRuntimePrerequisiteTestGap[] = [];
  for (const intent of runtimeIntents) {
    const routeFile = intent.evidence.find((item) =>
      item.kind === "diff" && item.relation === "direct" && item.file
    )?.file;
    const condition = intent.lifecycle.find((stage) => stage.kind === "condition");
    const action = intent.lifecycle.find((stage) => stage.kind === "action");
    const consumerFile = condition?.files[0];
    if (!routeFile || !consumerFile) {
      continue;
    }
    const consumerName = path.posix.basename(consumerFile).replace(/\.[^.]+$/, "");
    for (const testFile of testFiles) {
      const testSource = testSources.get(testFile) ?? "";
      if (
        !/(?:\bvi|\bjest)\.mock\s*\(/.test(testSource) ||
        !testSource.includes(consumerName)
      ) {
        continue;
      }
      gaps.push({
        testFile,
        routeFile,
        consumerFile,
        wrapperFile: action?.files[0],
      });
    }
  }
  return uniqueRuntimePrerequisiteTestGaps(gaps);
}

async function readQaSourceAtEvidenceBoundary(
  root: string,
  file: string,
  options: {
    head: string;
    includeWorkingTree: boolean;
    workspaceRoot?: string;
  },
): Promise<string | undefined> {
  const normalized = toPosixPath(file);
  if (options.includeWorkingTree) {
    try {
      return await readFile(path.join(root, normalized), "utf8");
    } catch {
      return undefined;
    }
  }
  const gitRoot = path.resolve(options.workspaceRoot ?? root);
  const scopePrefix = options.workspaceRoot
    ? toPosixPath(path.relative(gitRoot, root)).replace(/^\.\/+|\/+$/g, "")
    : "";
  const gitPath = scopePrefix ? `${scopePrefix}/${normalized}` : normalized;
  return readFileAtRef(gitRoot, options.head, gitPath);
}

function uniqueRuntimePrerequisiteTestGaps(
  gaps: QaRuntimePrerequisiteTestGap[],
): QaRuntimePrerequisiteTestGap[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => {
    const key = `${gap.testFile}:${gap.routeFile}:${gap.consumerFile}:${gap.wrapperFile ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function qualifyAutomaticPackageCommands(
  result: QaDraftResult,
  packagePath: string,
): QaDraftResult {
  const replacements = new Map(
    result.suggestedCommands.map((command) => [
      command,
      qualifyPackageCommand(command, packagePath),
    ]),
  );
  const replaceCommandsInText = (value: string): string => {
    let updated = value;
    for (const [command, qualified] of replacements) {
      if (command !== qualified) {
        updated = updated.replaceAll(command, qualified);
      }
    }
    return updated;
  };
  return {
    ...result,
    route: {
      ...result.route,
      command: result.route.command
        ? replacements.get(result.route.command) ?? qualifyPackageCommand(result.route.command, packagePath)
        : undefined,
    },
    prChecklist: result.prChecklist.map(replaceCommandsInText),
    agentHandoff: result.agentHandoff.map(replaceCommandsInText),
    suggestedCommands: result.suggestedCommands.map((command) =>
      replacements.get(command) ?? command
    ),
  };
}

function qualifyPackageCommand(command: string, packagePath: string): string {
  if (
    /(?:^|\s)(?:--dir|--cwd|--prefix|--filter|--workspace)(?:\s|=)/.test(command) ||
    /\byarn\s+workspace\s/.test(command)
  ) {
    return command;
  }
  const target = shellCommandArgument(packagePath);
  if (/^pnpm\s/.test(command)) {
    return command.replace(/^pnpm\s/, `pnpm --dir ${target} `);
  }
  if (/^yarn\s/.test(command)) {
    return command.replace(/^yarn\s/, `yarn --cwd ${target} `);
  }
  if (/^bun\s/.test(command)) {
    return command.replace(/^bun\s/, `bun --cwd ${target} `);
  }
  if (/^npm\s/.test(command)) {
    return command.replace(/^npm\s/, `npm --prefix ${target} `);
  }
  return `cd ${target} && ${command}`;
}

function qaScopeCandidate(target: E2eWorkspaceTarget): QaAnalysisScopeCandidate {
  return {
    path: target.path,
    packageName: target.packageName,
    project: target.project.type,
    runner: target.recommendedRunner.name,
    changedFiles: target.changedFileCount,
  };
}

function selectAutomaticWorkspaceTarget(
  targets: E2eWorkspaceTarget[],
  changedFiles: string[],
): E2eWorkspaceTarget | undefined {
  if (targets.length !== 1 || changedFiles.length === 0) {
    return undefined;
  }
  const target = targets[0];
  if (target.project.type === "unknown") {
    return undefined;
  }
  return changedFiles.every((file) => workspaceTargetOwnsFile(target, file)) ? target : undefined;
}

function workspaceRootScopeReason(targets: E2eWorkspaceTarget[], changedFiles: string[]): string {
  if (targets.length === 0) {
    return "No changed file mapped to a nested package, so QAMap analyzed the repository root.";
  }
  if (targets.length > 1) {
    return `${targets.length} packages changed, so QAMap kept the repository-wide scope instead of silently selecting one package.`;
  }
  const outsideTarget = changedFiles.filter((file) => !workspaceTargetOwnsFile(targets[0], file));
  if (outsideTarget.length > 0) {
    return `Changes span ${targets[0].path} and ${outsideTarget.length} file${outsideTarget.length === 1 ? "" : "s"} outside that package, so QAMap kept the repository-wide scope.`;
  }
  return `${targets[0].path} lacks enough project evidence for a safe automatic package selection.`;
}

function workspaceTargetOwnsFile(target: E2eWorkspaceTarget, file: string): boolean {
  const normalizedFile = toPosixPath(file).replace(/^\.\/+/, "");
  const normalizedPackage = toPosixPath(target.path).replace(/\/+$/, "");
  return normalizedFile === `${normalizedPackage}/package.json` ||
    normalizedFile.startsWith(`${normalizedPackage}/`);
}

function explicitOrRootAnalysisScope(root: string, workspaceRootInput: string | undefined): QaAnalysisScope {
  const workspaceRoot = workspaceRootInput ? path.resolve(workspaceRootInput) : root;
  const selectedPath = workspaceRootInput
    ? toPosixPath(path.relative(workspaceRoot, root))
    : undefined;
  if (selectedPath && selectedPath !== "." && !selectedPath.startsWith("..")) {
    return {
      mode: "explicit-package",
      workspaceRoot,
      commandCwd: "selected-package",
      selectedPath,
      candidates: [],
      reason: "The caller explicitly selected this package.",
    };
  }
  return {
    mode: "repository-root",
    workspaceRoot,
    commandCwd: "workspace-root",
    candidates: [],
    reason: "QAMap analyzed the requested repository root.",
  };
}

function formatAnalysisScope(scope: QaAnalysisScope): string {
  if (scope.mode === "automatic-package" && scope.selectedPath) {
    const packageLabel = scope.packageName ? ` (${scope.packageName})` : "";
    return `automatically selected package ${scope.selectedPath}${packageLabel}. ${scope.reason}`;
  }
  if (scope.mode === "explicit-package" && scope.selectedPath) {
    return `explicit package ${scope.selectedPath}. ${scope.reason}`;
  }
  const candidates = scope.candidates.length > 0
    ? ` Changed package candidates: ${scope.candidates.map((candidate) => candidate.path).join(", ")}.`
    : "";
  return `repository root. ${scope.reason}${candidates}`;
}

function e2eDraftCommand(result: QaDraftResult): string {
  const selectedPath = result.analysisScope.selectedPath;
  const args = [
    "qamap",
    "e2e",
    "draft",
    selectedPath ?? ".",
  ];
  if (selectedPath) {
    args.push("--workspace-root", ".");
  }
  args.push("--base", result.base, "--head", result.head);
  return args.map(shellCommandArgument).join(" ");
}

function shellCommandArgument(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function buildQaRouteDecision(
  readiness: QaReadinessSummary,
  suggestedCommands: string[],
): QaRouteDecision {
  if (readiness.basis === "repository-validation") {
    const command = suggestedCommands[0];
    return command
      ? {
          basis: "repository-validation",
          status: "verification-ready-to-run",
          nextAction: "run-repository-command",
          command,
        }
      : {
          basis: "repository-validation",
          status: "verification-command-needed",
          nextAction: "define-repository-command",
        };
  }

  return {
    basis: "optional-automation",
    status: `draft-${readiness.level}`,
    nextAction: readiness.level === "ready" ? "review-and-run-draft" : "complete-draft-evidence",
  };
}

function buildQaReadiness(
  readiness: E2eDraftReadinessSummary,
  flows: QaDraftFlow[],
  suggestedCommands: string[],
  changedFiles: string[],
): QaReadinessSummary {
  const repositoryValidation = flows.length > 0 && (
    flows.every((flow) => Boolean(flow.verificationMode)) ||
    shouldRunChangedTestEvidence(flows, changedFiles)
  );
  if (!repositoryValidation) {
    return {
      ...readiness,
      basis: "optional-automation",
      automationApplicable: true,
    };
  }
  const commandAvailable = suggestedCommands.length > 0;
  return {
    ...readiness,
    score: commandAvailable ? 100 : 50,
    level: commandAvailable ? "ready" : "needs-work",
    recommendation: commandAvailable
      ? `Run the selected repository validation command: ${suggestedCommands[0]}.`
      : "Define a repository-owned validation command for this change before merge.",
    requiredScenarioGaps: 0,
    topBlockers: commandAvailable ? [] : ["A repository-owned validation command is not declared."],
    basis: "repository-validation",
    automationApplicable: false,
    verificationStatus: commandAvailable ? "ready-to-run" : "command-needed",
  };
}

function shouldRunChangedTestEvidence(flows: QaDraftFlow[], changedFiles: string[]): boolean {
  const changed = new Set(changedFiles);
  const hasChangedRelatedTest = flows.some((flow) =>
    flow.existingEvidencePaths.some((file) => changed.has(file))
  );
  const scenarioReceipts = flows.flatMap((flow) => flow.scenarioAutomation);
  return hasChangedRelatedTest &&
    scenarioReceipts.length > 0 &&
    scenarioReceipts.every((receipt) => receipt.decision === "review-only");
}

async function buildChangedTestVerificationCommands(
  root: string,
  flows: QaDraftFlow[],
  changedFiles: string[],
  suggestedCommands: string[],
): Promise<string[]> {
  const changed = new Set(changedFiles);
  const changedEvidence = uniqueStrings(
    flows.flatMap((flow) => flow.existingEvidencePaths).filter((file) => changed.has(file)),
  );
  if (changedEvidence.length === 0) {
    return [];
  }
  return buildTestVerificationCommands(root, changedEvidence, suggestedCommands);
}

async function preferLocallyRunnableValidationCommands(
  root: string,
  commands: string[],
): Promise<string[]> {
  const preferred: string[] = [];
  for (const command of commands) {
    const pythonCommand = await locallyRunnablePythonValidationCommand(root, command);
    if (pythonCommand === null) {
      continue;
    }
    preferred.push(pythonCommand ?? command);
  }
  return uniqueStrings(preferred);
}

async function locallyRunnablePythonValidationCommand(
  root: string,
  command: string,
): Promise<string | null | undefined> {
  const match = command.match(
    /^(?:(uv|poetry)\s+run\s+)?(pytest|tox|ruff|mypy)(\s.*)?$/i,
  );
  if (!match) {
    return undefined;
  }
  const wrapper = match[1]?.toLowerCase();
  const moduleName = match[2].toLowerCase();
  const argumentsSuffix = match[3] ?? "";
  if (!wrapper) {
    return undefined;
  }
  if (wrapper && await executableOnPath(wrapper)) {
    return command;
  }

  for (const python of ["python3", "python"]) {
    if (
      await executableOnPath(python) &&
      await repositoryDeclaresPythonModule(root, moduleName)
    ) {
      return `${python} -m ${moduleName}${argumentsSuffix}`;
    }
  }
  return null;
}

async function executableOnPath(command: string): Promise<boolean> {
  const directories = (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      try {
        await access(
          path.join(directory, `${command}${extension}`),
          process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return true;
      } catch {
        // Continue through the local PATH without invoking a shell.
      }
    }
  }
  return false;
}

async function repositoryDeclaresPythonModule(root: string, moduleName: string): Promise<boolean> {
  const markerFiles = [
    "pyproject.toml",
    "requirements.txt",
    "requirements-dev.txt",
    "setup.cfg",
    "tox.ini",
    "Pipfile",
  ];
  const escapedModule = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dependencyPattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapedModule}(?:[^A-Za-z0-9_-]|$)`, "i");
  for (const markerFile of markerFiles) {
    try {
      if (dependencyPattern.test(await readFile(path.join(root, markerFile), "utf8"))) {
        return true;
      }
    } catch {
      // Missing or unreadable project metadata is not dependency evidence.
    }
  }
  if (moduleName === "pytest") {
    return pathExists(path.join(root, "pytest.ini"));
  }
  if (moduleName === "ruff") {
    return pathExists(path.join(root, "ruff.toml")) ||
      pathExists(path.join(root, ".ruff.toml"));
  }
  if (moduleName === "mypy") {
    return pathExists(path.join(root, "mypy.ini")) ||
      pathExists(path.join(root, ".mypy.ini"));
  }
  return moduleName === "tox" && pathExists(path.join(root, "tox.ini"));
}

async function buildTestVerificationCommands(
  root: string,
  testFiles: string[],
  suggestedCommands: string[],
): Promise<string[]> {
  const changedEvidence = uniqueStrings(testFiles);
  if (changedEvidence.length === 0) {
    return [];
  }
  const pytest = suggestedCommands.find((command) => /^pytest(?:\s|$)/i.test(command));
  const pythonTests = changedEvidence.filter((file) => /(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/i.test(file));
  if (pytest && pythonTests.length > 0) {
    return [`pytest ${pythonTests.slice(0, 4).map(shellCommandArgument).join(" ")}`];
  }
  const packageTest = suggestedCommands.find((command) => /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test(?:\s|$)/i.test(command));
  if (packageTest && pythonTests.length > 0) {
    return [`${packageTest} -- ${pythonTests.slice(0, 4).map(shellCommandArgument).join(" ")}`];
  }
  const directPackageTest = suggestedCommands.find((command) =>
    /^(?:npm|pnpm|yarn)(?:\s+run)?\s+test$/i.test(command)
  );
  const javascriptTests = changedEvidence.filter(isJavaScriptTestEvidence);
  if (javascriptTests.length === 0) {
    return [];
  }
  if (directPackageTest) {
    const testScript = await readPackageTestScript(root);
    if (!testScript) {
      return [];
    }
    const focused = buildFocusedJavaScriptTestCommand(
      directPackageTest,
      testScript,
      javascriptTests.slice(0, 4),
    );
    return focused ? [focused] : [];
  }

  return buildFocusedWorkspaceJavaScriptTestCommands(
    root,
    suggestedCommands,
    javascriptTests,
  );
}

function isFocusedValidationCommand(command: string): boolean {
  return /--runTestsByPath\b|(?:^|\s)[^\s]+(?:test|spec)\.(?:[cm]?[jt]sx?|py)(?:\s|$)/i.test(command);
}

interface ChangedWorkspaceTestGroup {
  packagePath: string;
  packageName?: string;
  testScript: string;
  testFiles: string[];
}

async function buildFocusedWorkspaceJavaScriptTestCommands(
  root: string,
  suggestedCommands: string[],
  testFiles: string[],
): Promise<string[]> {
  const groups = await groupChangedTestsByPackage(root, testFiles);
  const focused: string[] = [];
  for (const group of groups) {
    const target = group.packageName ?? `./${group.packagePath}`;
    const packageTestCommand = findWorkspacePackageTestCommand(suggestedCommands, target);
    if (!packageTestCommand) {
      const standaloneCommand = await standalonePackageTestCommand(root, group.packagePath);
      if (standaloneCommand) {
        focused.push(standaloneCommand);
      }
      continue;
    }
    const command = buildFocusedJavaScriptTestCommand(
      packageTestCommand,
      group.testScript,
      group.testFiles,
    );
    if (command?.startsWith(`${packageTestCommand} `)) {
      focused.push(command);
    }
  }
  return focused;
}

async function standalonePackageTestCommand(
  root: string,
  packagePath: string,
): Promise<string | undefined> {
  const packageDirectory = path.join(root, packagePath);
  const target = shellCommandArgument(packagePath);
  if (await pathExists(path.join(packageDirectory, "pnpm-lock.yaml"))) {
    return `pnpm --dir ${target} test`;
  }
  if (await pathExists(path.join(packageDirectory, "yarn.lock"))) {
    return `yarn --cwd ${target} test`;
  }
  if (
    await pathExists(path.join(packageDirectory, "bun.lock")) ||
    await pathExists(path.join(packageDirectory, "bun.lockb"))
  ) {
    return `bun --cwd ${target} test`;
  }
  if (await pathExists(path.join(packageDirectory, "package-lock.json"))) {
    return `npm --prefix ${target} test`;
  }
  return undefined;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function groupChangedTestsByPackage(
  root: string,
  testFiles: string[],
): Promise<ChangedWorkspaceTestGroup[]> {
  const groups = new Map<string, ChangedWorkspaceTestGroup>();
  const packageCache = new Map<string, { name?: string; testScript?: string } | undefined>();
  for (const testFile of testFiles) {
    const normalized = toPosixPath(testFile);
    if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
      continue;
    }
    let directory = path.posix.dirname(normalized);
    while (directory !== "." && directory !== "/") {
      let packageInfo = packageCache.get(directory);
      if (!packageCache.has(directory)) {
        packageInfo = await readPackageTestConfiguration(path.join(root, directory));
        packageCache.set(directory, packageInfo);
      }
      if (packageInfo) {
        if (packageInfo.testScript) {
          const existing = groups.get(directory);
          const relativeTestFile = path.posix.relative(directory, normalized);
          if (existing) {
            existing.testFiles.push(relativeTestFile);
          } else {
            groups.set(directory, {
              packagePath: directory,
              packageName: packageInfo.name,
              testScript: packageInfo.testScript,
              testFiles: [relativeTestFile],
            });
          }
        }
        break;
      }
      const parent = path.posix.dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      testFiles: uniqueStrings(group.testFiles).slice(0, 4),
    }))
    .sort((left, right) => left.packagePath.localeCompare(right.packagePath));
}

async function readPackageTestConfiguration(
  root: string,
): Promise<{ name?: string; testScript?: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
    };
    return {
      name: typeof parsed.name === "string" && parsed.name.trim().length > 0
        ? parsed.name.trim()
        : undefined,
      testScript: typeof parsed.scripts?.test === "string" && parsed.scripts.test.trim().length > 0
        ? parsed.scripts.test.trim()
        : undefined,
    };
  } catch {
    return undefined;
  }
}

function findWorkspacePackageTestCommand(
  suggestedCommands: string[],
  target: string,
): string | undefined {
  return ["pnpm", "yarn", "npm"]
    .map((packageManager) => buildWorkspaceScriptCommand(packageManager, target, "test"))
    .map((command) => suggestedCommands.find((candidate) => candidate === command))
    .find((command): command is string => Boolean(command));
}

function isJavaScriptTestEvidence(file: string): boolean {
  return /\.[cm]?[jt]sx?$/i.test(file) && (
    /(?:^|\/)(?:__tests__|tests?|e2e)(?:\/|$)/i.test(file) ||
    /(?:^|\/)[^/]+\.(?:test|spec|e2e|cy)\.[cm]?[jt]sx?$/i.test(file)
  );
}

async function readPackageTestScript(root: string): Promise<string | undefined> {
  return (await readPackageTestConfiguration(root))?.testScript;
}

function buildFocusedJavaScriptTestCommand(
  packageTestCommand: string,
  testScript: string,
  testFiles: string[],
): string | undefined {
  const chain = splitSafeTestScriptChain(testScript);
  if (!chain) {
    return undefined;
  }
  const runner = chain.at(-1);
  if (!runner) {
    return undefined;
  }
  const fileArguments = testFiles.map(shellCommandArgument).join(" ");
  if (runner === "node --test") {
    return appendPackageTestArguments(packageTestCommand, fileArguments);
  }

  const nodeWithTargets = /^node\s+--test\s+(.+)$/.exec(runner);
  if (nodeWithTargets && isSimpleTestTargetList(nodeWithTargets[1])) {
    return [
      ...chain.slice(0, -1),
      `node --test ${fileArguments}`,
    ].join(" && ");
  }
  if (/^vitest(?:\s+(?:run|--run))?$/i.test(runner)) {
    return appendPackageTestArguments(packageTestCommand, fileArguments);
  }
  if (/^jest(?:\s+--(?:ci|runInBand|detectOpenHandles|forceExit))*$/i.test(runner)) {
    return appendPackageTestArguments(
      packageTestCommand,
      `--runTestsByPath ${fileArguments}`,
    );
  }
  if (/^playwright\s+test(?:\s+--pass-with-no-tests)?$/i.test(runner)) {
    return appendPackageTestArguments(packageTestCommand, fileArguments);
  }
  return undefined;
}

function splitSafeTestScriptChain(script: string): string[] | undefined {
  if (/[\n\r;|><`$]/.test(script) || /(^|[^&])&([^&]|$)|&&&/.test(script)) {
    return undefined;
  }
  const chain = script.split(/\s*&&\s*/).map((segment) => segment.trim());
  if (chain.length === 0 || chain.some((segment) => segment.length === 0)) {
    return undefined;
  }
  const prefixes = chain.slice(0, -1);
  if (!prefixes.every((segment) =>
    /^(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+[A-Za-z0-9:_-]+$/i.test(segment)
  )) {
    return undefined;
  }
  return chain;
}

function isSimpleTestTargetList(value: string): boolean {
  const tokens = value.match(/(?:'[^']*'|"[^"]*"|[^\s]+)/g);
  if (!tokens || tokens.join(" ").length !== value.trim().length) {
    return false;
  }
  return tokens.every((token) => {
    const unquoted = (
      (token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith("\"") && token.endsWith("\""))
    )
      ? token.slice(1, -1)
      : token;
    return unquoted.length > 0 &&
      !unquoted.startsWith("-") &&
      /^[A-Za-z0-9_./:@*?[\]{}=-]+$/.test(unquoted);
  });
}

function appendPackageTestArguments(command: string, args: string): string {
  return /^yarn(?:\s|$)/i.test(command)
    ? `${command} ${args}`
    : `${command} -- ${args}`;
}

const agentListLimit = 6;
const agentPayloadByteLimit = 4 * 1024 - 1;

function truncateForAgent(value: string, maxLength = 140): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

// Identifier values — repository paths, commands, selectors, and route hints —
// must stay whole: a partially emitted path cannot be opened or executed by the
// consuming agent. Oversized payloads recover bytes by dropping whole optional
// values, disclosed through omitted counts, never by emitting partial
// identifiers. Caller-supplied refs (base, head, manifest) keep this generous
// whole-value bound and fall back to prose truncation only for pathological
// inputs the caller already knows in full.
const agentRefWholeValueLimit = 256;

function agentRefValue(value: string, fallbackCap: number): string {
  return value.length <= agentRefWholeValueLimit ? value : truncateForAgent(value, fallbackCap);
}

interface AgentFlowFocus {
  action: string;
  assertion: string;
}

function buildAgentFlowFocus(
  flow: QaDraftFlow,
  scenariosById: Map<string, IntentQaScenario>,
): AgentFlowFocus | undefined {
  const scenario = findFullyCompiledFocusScenario(flow, scenariosById);
  if (!scenario) {
    return undefined;
  }
  const action = findEvidenceMatchedAgentStep(
    flow.draftSteps.filter((step) => !isAgentAssertionStep(step)),
    [flow.userJourney?.trigger, flow.title, ...scenario.steps],
  );
  const assertion =
    findEvidenceMatchedAgentStep(
      flow.draftSteps.filter(isAgentAssertionStep),
      [flow.userJourney?.successSignal, ...scenario.assertions],
    ) ?? scenario.assertions.slice(0, 2).join(" ");
  if (!action || !assertion || isGenericAgentFocusAssertion(assertion)) {
    return undefined;
  }
  return {
    action: truncateForAgent(action, 120),
    assertion: truncateForAgent(assertion, 120),
  };
}

function findFullyCompiledFocusScenario(
  flow: QaDraftFlow,
  scenariosById: Map<string, IntentQaScenario>,
): IntentQaScenario | undefined {
  for (const receipt of flow.scenarioAutomation) {
    if (
      receipt.status !== "compiled" ||
      receipt.totalSteps === 0 ||
      receipt.mappedSteps !== receipt.totalSteps ||
      receipt.totalAssertions === 0 ||
      receipt.mappedAssertions !== receipt.totalAssertions
    ) {
      continue;
    }
    const scenario = scenariosById.get(receipt.scenarioId);
    if (
      !scenario ||
      !agentFocusPhrasesMatch(flow.title, scenario.title) ||
      scenario.assertions.length === 0
    ) {
      continue;
    }
    return scenario;
  }
  return undefined;
}

function isGenericAgentFocusAssertion(assertion: string): boolean {
  const normalized = normalizeAgentFocusPhrase(assertion);
  return normalized === "the externally observable result matches the commit intent" ||
    /^no diff-anchored observable outcome was extracted/i.test(assertion.trim());
}

function findEvidenceMatchedAgentStep(
  steps: string[],
  hints: Array<string | undefined>,
): string | undefined {
  const normalizedHints = hints
    .map((hint) => normalizeAgentFocusPhrase(hint))
    .filter((hint): hint is string => Boolean(hint));
  return steps.find((step) => {
    const normalizedStep = normalizeAgentFocusPhrase(step);
    return normalizedStep !== undefined &&
      normalizedHints.some((hint) => agentFocusPhrasesMatch(normalizedStep, hint));
  });
}

function agentFocusPhrasesMatch(left: string, right: string): boolean {
  const normalizedLeft = normalizeAgentFocusPhrase(left);
  const normalizedRight = normalizeAgentFocusPhrase(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    (
      normalizedLeft === normalizedRight ||
      ` ${normalizedLeft} `.includes(` ${normalizedRight} `) ||
      ` ${normalizedRight} `.includes(` ${normalizedLeft} `)
    )
  );
}

function normalizeAgentFocusPhrase(value: string | undefined): string | undefined {
  const normalized = value
    ?.normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/^(?:verify|assert|expect|confirm|check)\s+/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return normalized || undefined;
}

function isAgentAssertionStep(step: string): boolean {
  return /^(?:verify|assert|expect|confirm|check)\b/i.test(step.trim());
}

function compactAgentFlowFocus(focus: AgentFlowFocus | undefined, maxLength: number): AgentFlowFocus | undefined {
  if (!focus) {
    return undefined;
  }
  return {
    action: truncateForAgent(focus.action, maxLength),
    assertion: truncateForAgent(focus.assertion, maxLength),
  };
}

export interface AgentFormatOptions {
  // Absolute path of a locally written full report. When provided and the
  // payload had to compact, the emitted compaction object discloses it as
  // `fullReport` so a consuming agent can recover omitted traces, scenarios,
  // and flows without re-running the analysis.
  fullReportPath?: string;
}

export function formatAgentQaDraft(result: QaDraftResult, options?: AgentFormatOptions): string {
  return `${serializeAgentSummary(buildAgentQaSummary(result), options)}\n`;
}

// The agent summary before byte-budget compaction, as a single JSON line.
// This is what `compaction.fullReport` points at.
export function formatAgentQaFullReport(result: QaDraftResult): string {
  return `${JSON.stringify(buildAgentQaSummary(result))}\n`;
}

function buildAgentQaSummary(result: QaDraftResult): AgentSummaryShape {
  const scenarioAutomationById = aggregateScenarioAutomationById(result.flows);
  const traceByScenarioId = new Map(result.traces.map((trace) => [trace.scenario.id, trace]));
  const scenariosById = new Map(
    result.changeAnalysis.intents.flatMap((intent) => intent.scenarios).map((scenario) => [scenario.id, scenario]),
  );
  const requiredEvidence = result.missingEvidence
    .filter((item) => item.priority === "required")
    .slice(0, 8)
    .map((item) => ({ flow: truncateForAgent(item.flowTitle, 80), kind: item.kind, title: truncateForAgent(item.title) }));
  const requiredBootstrap = result.bootstrap.steps
    .filter((step) => step.status === "required" && step.category !== "runner")
    .slice(0, 3)
    .map((step) => ({ title: truncateForAgent(step.title, 80), action: truncateForAgent(step.action) }));
  const firstCorrection = result.traces.find(
    (trace) => trace.evidenceAssessment.disposition !== "confirmed",
  )?.manifestCorrection;
  const summary = {
    schema: { name: "qamap.qa", version: 1 },
    base: result.base,
    baseSource: result.baseResolution.source,
    head: result.head,
    project: result.project,
    runner: result.runner,
    manifest: result.manifestPath ?? null,
    currentDelta: result.currentDelta
      ? {
          scope: result.currentDelta.scope,
          files: result.currentDelta.files.slice(0, 6),
          repositoryContracts: result.currentDelta.repositoryContracts.slice(0, 3).map(formatAgentRepositoryContract),
        }
      : undefined,
    analysisScope: {
      mode: result.analysisScope.mode,
      commandCwd: result.analysisScope.commandCwd,
      selectedPath: result.analysisScope.selectedPath,
      packageName: result.analysisScope.packageName,
      candidates: result.analysisScope.candidates.slice(0, 4),
      reason: truncateForAgent(result.analysisScope.reason, 180),
    },
    execution: result.execution,
    route: result.route,
    capabilities: compactAgentCapabilities(result.capabilities),
    action: compactAgentAction(result.action),
    evidenceBoundary: result.evidenceBoundary,
    readiness: {
      score: result.readiness.score,
      level: result.readiness.level,
      basis: result.readiness.basis,
      automationApplicable: result.readiness.automationApplicable,
      verificationStatus: result.readiness.verificationStatus,
    },
    scenarioCoverage: {
      automationApplicable: result.readiness.automationApplicable,
      required: result.readiness.requiredScenarios,
      recommended: result.readiness.recommendedScenarios,
      reviewOnly: result.readiness.reviewOnlyScenarios,
      compiled: result.readiness.compiledScenarios,
      partial: result.readiness.partialScenarios,
      notCompiled: result.readiness.notCompiledScenarios,
      requiredGaps: result.readiness.requiredScenarioGaps,
    },
    evidenceSummary: result.evidenceSummary,
    manifestCorrection: firstCorrection
      ? {
          target: truncateForAgent(firstCorrection.target, 120),
          requiresHumanApproval: true,
        }
      : undefined,
    traceCount: result.traces.length,
    omittedTraceCount: Math.max(0, result.traces.length - 2),
    traces: result.traces.slice(0, 2).map((trace) => ({
      id: trace.id,
      status: trace.status,
      source: trace.sources[0] ? formatAgentEvidenceSource(trace.sources[0]) : undefined,
      behavior: trace.behavior[0]
        ? {
            id: trace.behavior[0].stageId,
            phase: trace.behavior[0].phase,
            label: truncateForAgent(trace.behavior[0].label, 100),
            relation: trace.behavior[0].relation,
          }
        : undefined,
      risk: {
        kind: trace.risk.kind,
        statement: truncateForAgent(trace.risk.statement, 140),
      },
      scenario: {
        id: trace.scenario.id,
        decision: trace.scenario.decision,
        title: truncateForAgent(trace.scenario.title, 100),
        authority: trace.scenario.authority,
        approvalRequired: trace.scenario.approvalRequired,
        testClass: trace.scenario.testClass,
      },
      artifact: !verificationModeForScenario(result.flows, trace.scenario.id) && trace.artifact
        ? {
            draft: trace.artifact.draftPath,
            status: trace.artifact.status,
            flowCoverage: trace.artifact.flowCount > 1
              ? `${trace.artifact.compiledFlowCount}/${trace.artifact.flowCount}`
              : undefined,
          }
        : undefined,
      execution: trace.execution,
    })),
    testSuite: { present: result.testSuite.hasTestSuite, files: result.testSuite.testFileCount },
    testContracts: {
      declared: result.changedTestContracts.length,
      execution: "not-run",
      items: result.changedTestContracts.slice(0, 3).map((contract) => ({
        ...formatAgentRepositoryContract(contract),
      })),
    },
    intentCount: result.changeAnalysis.intents.length,
    omittedIntentCount: Math.max(0, result.changeAnalysis.intents.length - 3),
    intents: result.changeAnalysis.intents.slice(0, 3).map((intent) => ({
      title: truncateForAgent(intent.title, 100),
      confidence: intent.confidence,
      reviewRequired: intent.reviewRequired,
      evidence: intent.evidence.slice(0, 1).map((item) => truncateForAgent(item.value, 100)),
      sources: strongestEvidence(intent.evidence, 1).map(formatAgentEvidenceSource),
      lifecycle: selectAgentLifecycleStages(intent.lifecycle.map((stage) => ({
        phase: stage.kind,
        label: truncateForAgent(stage.label, 120),
      })), 6),
      scenarioCount: intent.scenarios.length,
      omittedScenarioCount: Math.max(0, intent.scenarios.length - 2),
      scenarios: intent.scenarios.slice(0, 2).map((scenario) => {
        const routing = routeQaScenario(scenario);
        const automation = scenarioAutomationById.get(scenario.id);
        const verificationMode = verificationModeForScenario(result.flows, scenario.id);
        const trace = traceByScenarioId.get(scenario.id);
        return {
          id: scenario.id,
          priority: scenario.priority,
          kind: scenario.kind,
          title: truncateForAgent(scenario.title, 100),
          confidence: scenario.confidence ?? "low",
          reviewRequired: scenario.reviewRequired ?? true,
          authority: trace?.scenario.authority ?? "qamap-inference",
          approvalRequired: trace?.scenario.approvalRequired ?? true,
          testClass: trace?.scenario.testClass ?? (scenario.kind === "primary" ? "regression" : "edge"),
          sources: strongestEvidence(scenario.evidence, 1).map(formatAgentEvidenceSource),
          assertions: scenario.assertions.slice(0, 2).map((assertion) => truncateForAgent(assertion, 120)),
          routing: {
            decision: routing.decision,
            reason: truncateForAgent(routing.reason, 160),
            requiredSources: routing.requiredEvidence.length,
            referenceSources: routing.referenceEvidence.length,
          },
          automation: !verificationMode && automation
            ? {
                status: automation.receipt.status,
                flowCoverage: automation.flowCount > 1
                  ? `${automation.compiledFlowCount}/${automation.flowCount}`
                  : undefined,
                mappedSteps: automation.receipt.mappedSteps,
                totalSteps: automation.receipt.totalSteps,
                mappedAssertions: automation.receipt.mappedAssertions,
                totalAssertions: automation.receipt.totalAssertions,
                blocker: automation.receipt.blockers[0]
                  ? truncateForAgent(automation.receipt.blockers[0], 160)
                  : undefined,
              }
            : undefined,
        };
      }),
    })),
    automation: needsGeneratedDraft(result)
      ? {
          optIn: true,
          adapter: result.runner,
          setupStatus: result.runnerSetup.status,
          draftCommand: e2eDraftCommand(result),
          setupCommand: result.runnerSetup.status === "proposed" ? result.runnerSetup.setupCommand : undefined,
        }
      : undefined,
    flowCount: result.flows.length,
    omittedFlowCount: Math.max(0, result.flows.length - agentListLimit),
    flows: result.flows.slice(0, agentListLimit).map((flow) => {
      const focus = buildAgentFlowFocus(flow, scenariosById);
      return {
        title: truncateForAgent(flow.title, 80),
        source: truncateForAgent(flow.source, 60),
        authority: flow.authority,
        approvalRequired: flow.approvalRequired,
        testClass: flow.testClass,
        draft: flow.draftPath,
        runnable: flow.runnableStatus,
        verificationMode: flow.verificationMode,
        entry: flow.entrypointHints[0] || undefined,
        changedFiles: flow.changedFiles.slice(0, 4),
        reviewQuestion: flow.userJourney?.reviewQuestion
          ? truncateForAgent(flow.userJourney.reviewQuestion, 180)
          : undefined,
        successSignal: flow.userJourney?.successSignal
          ? truncateForAgent(flow.userJourney.successSignal)
          : undefined,
        focus,
        steps: flow.draftSteps.slice(0, agentListLimit).map((step) => truncateForAgent(step)),
        selectors: flow.selectorHints.slice(0, 5),
        existingEvidence: flow.existingEvidencePaths.length > 0
          ? flow.existingEvidencePaths.slice(0, 4)
          : undefined,
        scenarioAutomation: flow.verificationMode
          ? []
          : flow.scenarioAutomation.slice(0, 4).map((receipt) => ({
              id: receipt.scenarioId,
              decision: receipt.decision,
              status: receipt.status,
            })),
        evidence: flow.why.slice(0, 2).map((reason) => truncateForAgent(reason)),
      };
    }),
    requiredEvidence,
    recommendedEvidenceCount: result.missingEvidence.filter((item) => item.priority === "recommended").length,
    requiredBootstrap,
    prChecklist: result.prChecklist.slice(0, agentListLimit).map((item) => truncateForAgent(item)),
    commands: result.suggestedCommands.slice(0, 4),
  };
  return summary;
}

type AgentCapabilityShape = Pick<QaCapabilityResult, "id" | "status" | "level">;
type AgentActionShape = Pick<
  QaActionContract,
  | "id"
  | "risk"
  | "approval"
  | "executesProjectCode"
  | "writesRepository"
  | "untrustedEvidenceCanEscalate"
>;

interface AgentSummaryShape {
  [key: string]: unknown;
  capabilities: AgentCapabilityShape[];
  action: AgentActionShape;
  evidenceBoundary: QaEvidenceBoundary;
  currentDelta?: {
    scope?: unknown;
    files: string[];
    repositoryContracts: Array<Record<string, unknown>>;
  };
  traces: Array<{
    id?: unknown;
    status?: unknown;
    source?: Record<string, string | number>;
    behavior?: { id?: unknown; phase?: unknown; label?: string; relation?: unknown };
    risk?: { kind?: unknown; statement?: string };
    scenario?: {
      id?: unknown;
      decision?: unknown;
      title?: string;
      authority?: unknown;
      approvalRequired?: unknown;
      testClass?: unknown;
    };
    artifact?: { draft?: string; status?: unknown; flowCoverage?: string };
    execution?: unknown;
  }>;
  intents: Array<{
    title?: unknown;
    confidence?: unknown;
    reviewRequired?: unknown;
    evidence?: string[];
    sources?: unknown[];
    lifecycle: unknown[];
    scenarioCount?: number;
    omittedScenarioCount?: number;
    scenarios: Array<{
      id?: unknown;
      priority?: unknown;
      kind?: unknown;
      title?: unknown;
      confidence?: unknown;
      authority?: unknown;
      approvalRequired?: unknown;
      testClass?: unknown;
      sources?: unknown[];
      assertions: string[];
      routing?: {
        decision?: unknown;
        reason?: string;
        requiredSources?: unknown;
        referenceSources?: unknown;
      };
      automation?: {
        status?: unknown;
        flowCoverage?: string;
        mappedSteps?: unknown;
        totalSteps?: unknown;
        mappedAssertions?: unknown;
        totalAssertions?: unknown;
        blocker?: string;
      };
    }>;
  }>;
  flows: Array<{
    title?: unknown;
    source?: unknown;
    authority?: unknown;
    approvalRequired?: unknown;
    testClass?: unknown;
    draft?: unknown;
    runnable?: unknown;
    verificationMode?: unknown;
    entry?: unknown;
    reviewQuestion?: unknown;
    successSignal?: unknown;
    focus?: AgentFlowFocus;
    changedFiles: string[];
    steps: string[];
    selectors: string[];
    existingEvidence?: string[];
    scenarioAutomation?: unknown[];
    evidence: string[];
  }>;
  requiredEvidence: unknown[];
  requiredBootstrap: unknown[];
  prChecklist: string[];
  commands: string[];
}

type CompactAgentFlowShape = Omit<AgentSummaryShape["flows"][number], "evidence"> & {
  evidence?: string[];
};

function serializeAgentSummary(summary: AgentSummaryShape, options?: AgentFormatOptions): string {
  const payload = JSON.stringify(summary);
  if (Buffer.byteLength(payload) <= agentPayloadByteLimit) {
    return payload;
  }
  const compactionDisclosure = (extra: Record<string, unknown>): Record<string, unknown> => ({
    maxBytes: agentPayloadByteLimit,
    originalBytes: Buffer.byteLength(payload),
    ...(options?.fullReportPath ? { fullReport: options.fullReportPath } : {}),
    ...extra,
  });
  const preserveScopeCandidates = shouldPreserveAgentScopeCandidates(summary.analysisScope);

  const compact = {
    ...summary,
    analysisScope: compactAgentAnalysisScope(summary.analysisScope, true),
    traces: summary.traces.slice(0, 2),
    intents: summary.intents.slice(0, 2).map((intent) => ({
      ...intent,
      lifecycle: selectAgentLifecycleStages(intent.lifecycle, 4),
      scenarios: intent.scenarios.slice(0, 2).map((scenario) => ({
        ...scenario,
        assertions: scenario.assertions.slice(0, 1),
      })),
    })),
    flows: summary.flows.slice(0, 3).map((flow) => ({
      ...flow,
      changedFiles: flow.changedFiles.slice(0, 2),
      steps: flow.steps.slice(0, 3),
      selectors: flow.selectors.slice(0, 2),
      existingEvidence: flow.existingEvidence?.slice(0, 2),
      evidence: flow.evidence.slice(0, 1),
    })),
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - Math.min(2, summary.intents.length)),
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - Math.min(3, summary.flows.length)),
    requiredEvidence: summary.requiredEvidence.slice(0, 5),
    requiredBootstrap: summary.requiredBootstrap.slice(0, 2),
    prChecklist: summary.prChecklist.slice(0, 4),
    commands: summary.commands.slice(0, 3),
    compaction: compactionDisclosure({}),
  };
  const compactPayload = JSON.stringify(compact);
  if (Buffer.byteLength(compactPayload) <= agentPayloadByteLimit) {
    return compactPayload;
  }

  const minimalIntents = compact.intents.slice(0, 1).map((intent) => ({
    ...intent,
    lifecycle: selectAgentLifecycleStages(intent.lifecycle, 3),
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 1),
    scenarios: intent.scenarios.slice(0, 1),
  }));
  const minimalFlows = compact.flows.slice(0, 2).map((flow, index) => index === 0
    ? {
        ...flow,
        steps: flow.steps.slice(0, 2),
        selectors: flow.selectors.slice(0, 1),
        existingEvidence: flow.existingEvidence?.slice(0, 1),
      }
    : secondaryAgentFlow(flow));
  const minimalPayload = JSON.stringify({
    ...compact,
    omittedTraceCount: Math.max(0, numericCount(summary.traceCount) - Math.min(1, compact.traces.length)),
    traces: compact.traces.slice(0, 1),
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - minimalIntents.length),
    intents: minimalIntents,
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - minimalFlows.length),
    flows: minimalFlows,
    requiredEvidence: compact.requiredEvidence.slice(0, 3),
    requiredBootstrap: compact.requiredBootstrap.slice(0, 1),
    prChecklist: compact.prChecklist.slice(0, 2),
    commands: compact.commands.slice(0, 2),
  });
  if (Buffer.byteLength(minimalPayload) <= agentPayloadByteLimit) {
    return minimalPayload;
  }

  const leanIntents = compact.intents.slice(0, 1).map((intent) => ({
    title: intent.title,
    confidence: intent.confidence,
    reviewRequired: intent.reviewRequired,
    evidence: [],
    lifecycle: selectAgentLifecycleStages(intent.lifecycle, 3).map(emergencyAgentLifecycleStage),
    scenarioCount: intent.scenarioCount,
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 2),
    scenarios: intent.scenarios.slice(0, 2).map((scenario) => ({
      id: scenario.id,
      priority: scenario.priority,
      kind: scenario.kind,
      title: scenario.title,
      confidence: scenario.confidence,
      sources: scenario.sources?.slice(0, 1).map(compactAgentEvidenceSource),
      assertions: scenario.assertions.slice(0, 1).map((assertion) => truncateForAgent(assertion, 80)),
      routing: scenario.routing
        ? {
            decision: scenario.routing.decision,
            reason: `Evidence-backed ${String(scenario.routing.decision ?? "review-only")} routing.`,
            requiredSources: scenario.routing.requiredSources,
            referenceSources: scenario.routing.referenceSources,
          }
        : undefined,
      automation: scenario.automation
        ? {
            status: scenario.automation.status,
            mappedSteps: scenario.automation.mappedSteps,
            totalSteps: scenario.automation.totalSteps,
            mappedAssertions: scenario.automation.mappedAssertions,
            totalAssertions: scenario.automation.totalAssertions,
          }
        : undefined,
    })),
  }));
  const leanTraces = compact.traces.slice(0, 1).map((trace) => ({
    id: trace.id,
    status: trace.status,
    source: trace.source
      ? {
          kind: trace.source.kind,
          reason: "Located diff evidence.",
          file: trace.source.file,
          relation: trace.source.relation,
          side: trace.source.side,
          startLine: trace.source.startLine,
        }
      : undefined,
    behavior: trace.behavior
      ? {
          id: trace.behavior.id,
          phase: trace.behavior.phase,
          label: truncateForAgent(String(trace.behavior.label ?? ""), 45),
          relation: trace.behavior.relation,
        }
      : undefined,
    risk: trace.risk
      ? {
          kind: trace.risk.kind,
          statement: truncateForAgent(
            String(trace.risk.statement ?? compactAgentRiskStatement(trace.risk.kind)),
            90,
          ),
        }
      : undefined,
    scenario: trace.scenario
      ? {
          id: trace.scenario.id,
          decision: trace.scenario.decision,
          title: truncateForAgent(String(trace.scenario.title ?? ""), 55),
        }
      : undefined,
    artifact: trace.artifact
      ? {
          draft: String(trace.artifact.draft ?? ""),
          status: trace.artifact.status,
          flowCoverage: trace.artifact.flowCoverage,
        }
      : undefined,
    execution: trace.execution,
  }));
  const leanFlows = compact.flows.slice(0, 3).map((flow, index) => index === 0
    ? {
        title: flow.title,
        source: truncateForAgent(String(flow.source ?? ""), 40),
        authority: flow.authority,
        approvalRequired: flow.approvalRequired,
        testClass: flow.testClass,
        draft: flow.draft,
        verificationMode: flow.verificationMode,
        entry: flow.entry,
        changedFiles: flow.changedFiles.slice(0, 1),
        reviewQuestion: flow.reviewQuestion
          ? truncateForAgent(String(flow.reviewQuestion), 100)
          : undefined,
        successSignal: flow.successSignal
          ? truncateForAgent(String(flow.successSignal), 100)
          : undefined,
        focus: compactAgentFlowFocus(flow.focus, 80),
        steps: flow.steps.slice(0, 1).map((step) => truncateForAgent(step, 80)),
        selectors: flow.selectors.slice(0, 1),
        existingEvidence: flow.existingEvidence?.slice(0, 1),
      }
    : secondaryAgentFlow(flow));
  const leanPayload = JSON.stringify({
    schema: summary.schema,
    base: agentRefValue(String(summary.base ?? ""), 120),
    head: agentRefValue(String(summary.head ?? ""), 120),
    project: summary.project,
    runner: summary.runner,
    manifest: summary.manifest ? agentRefValue(String(summary.manifest), 120) : null,
    currentDelta: compactAgentCurrentDelta(summary.currentDelta, 2),
    analysisScope: compactAgentAnalysisScope(summary.analysisScope, preserveScopeCandidates),
    execution: summary.execution,
    route: summary.route,
    ...(preserveScopeCandidates
      ? {}
      : { capabilities: compactAgentCapabilities(summary.capabilities) }),
    action: compactAgentAction(summary.action),
    evidenceBoundary: summary.evidenceBoundary,
    readiness: summary.readiness,
    scenarioCoverage: summary.scenarioCoverage,
    evidenceSummary: summary.evidenceSummary,
    manifestCorrection: summary.manifestCorrection,
    traceCount: summary.traceCount,
    omittedTraceCount: Math.max(0, numericCount(summary.traceCount) - leanTraces.length),
    traces: leanTraces,
    testSuite: summary.testSuite,
    intentCount: summary.intentCount,
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - leanIntents.length),
    intents: leanIntents,
    flowCount: summary.flowCount,
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - leanFlows.length),
    flows: leanFlows,
    requiredEvidence: compact.requiredEvidence.slice(0, 1),
    recommendedEvidenceCount: summary.recommendedEvidenceCount,
    requiredBootstrap: [],
    prChecklist: compact.prChecklist.slice(0, 1),
    commands: compact.commands.slice(0, 1),
    compaction: compactionDisclosure({ lean: true }),
  });
  if (Buffer.byteLength(leanPayload) <= agentPayloadByteLimit) {
    return leanPayload;
  }

  const emergencyIntents = summary.intents.slice(0, 1).map((intent) => ({
    title: truncateForAgent(String(intent.title ?? ""), 60),
    confidence: intent.confidence,
    reviewRequired: intent.reviewRequired,
    evidence: [],
    lifecycle: selectAgentLifecycleStages(intent.lifecycle, 3).map(compactAgentLifecycleStage),
    scenarioCount: intent.scenarioCount,
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 2),
    scenarios: intent.scenarios.slice(0, 2).map((scenario) => ({
      id: scenario.id,
      priority: scenario.priority,
      kind: scenario.kind,
      title: truncateForAgent(String(scenario.title ?? ""), 60),
      confidence: scenario.confidence,
      sources: scenario.sources?.slice(0, 1).map(emergencyAgentEvidenceSource),
      assertions: [],
      routing: scenario.routing
        ? {
            decision: scenario.routing.decision,
            reason: "Evidence-backed route.",
            requiredSources: scenario.routing.requiredSources,
            referenceSources: scenario.routing.referenceSources,
          }
        : undefined,
      automation: scenario.automation
        ? {
            status: scenario.automation.status,
            mappedSteps: scenario.automation.mappedSteps,
            totalSteps: scenario.automation.totalSteps,
            mappedAssertions: scenario.automation.mappedAssertions,
            totalAssertions: scenario.automation.totalAssertions,
          }
        : undefined,
    })),
  }));
  const emergencyFlows = summary.flows.slice(0, 3).map((flow, index) => index === 0
    ? {
        title: truncateForAgent(String(flow.title ?? ""), 60),
        source: truncateForAgent(String(flow.source ?? ""), 30),
        authority: flow.authority,
        approvalRequired: flow.approvalRequired,
        testClass: flow.testClass,
        draft: String(flow.draft ?? ""),
        verificationMode: flow.verificationMode,
        entry: flow.entry ? String(flow.entry) : undefined,
        changedFiles: flow.changedFiles.slice(0, 1),
        reviewQuestion: flow.reviewQuestion
          ? truncateForAgent(String(flow.reviewQuestion), 100)
          : undefined,
        successSignal: flow.successSignal
          ? truncateForAgent(String(flow.successSignal), 100)
          : undefined,
        focus: compactAgentFlowFocus(flow.focus, 70),
        steps: flow.steps.slice(0, 1).map((step) => truncateForAgent(step, 60)),
        selectors: flow.selectors.slice(0, 1),
        existingEvidence: flow.existingEvidence?.slice(0, 1),
      }
    : secondaryAgentFlow(flow, { title: 55, source: 24, draft: 60, file: 60, question: 80, success: 80 }));
  const emergencyTraces = leanTraces.slice(0, 1);
  const emergencySummary = {
    schema: summary.schema,
    base: agentRefValue(String(summary.base ?? ""), 180),
    head: agentRefValue(String(summary.head ?? ""), 180),
    project: summary.project,
    runner: summary.runner,
    manifest: summary.manifest ? agentRefValue(String(summary.manifest), 180) : null,
    currentDelta: compactAgentCurrentDelta(summary.currentDelta, 2),
    analysisScope: compactAgentAnalysisScope(summary.analysisScope, preserveScopeCandidates),
    execution: summary.execution,
    route: summary.route,
    evidenceBoundary: summary.evidenceBoundary,
    readiness: summary.readiness,
    scenarioCoverage: summary.scenarioCoverage,
    evidenceSummary: summary.evidenceSummary,
    manifestCorrection: summary.manifestCorrection,
    traceCount: summary.traceCount,
    omittedTraceCount: Math.max(0, numericCount(summary.traceCount) - emergencyTraces.length),
    traces: emergencyTraces,
    testSuite: summary.testSuite,
    intentCount: summary.intentCount,
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - emergencyIntents.length),
    intents: emergencyIntents,
    flowCount: summary.flowCount,
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - emergencyFlows.length),
    flows: emergencyFlows,
    requiredEvidence: summary.requiredEvidence.slice(0, 1),
    recommendedEvidenceCount: summary.recommendedEvidenceCount,
    requiredBootstrap: [],
    prChecklist: summary.prChecklist.slice(0, 1).map((item) => truncateForAgent(item, 100)),
    commands: summary.commands.slice(0, 1),
    compaction: compactionDisclosure({ emergency: true }),
  };
  const emergencyPayload = JSON.stringify(emergencySummary);
  if (Buffer.byteLength(emergencyPayload) <= agentPayloadByteLimit) {
    return emergencyPayload;
  }

  const floorIntents = emergencyIntents.slice(0, 1).map((intent) => ({
    ...intent,
    title: truncateForAgent(String(intent.title ?? ""), 45),
    lifecycle: selectAgentLifecycleStages(intent.lifecycle, 2),
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 2),
    scenarios: intent.scenarios.slice(0, 2).map((scenario) => ({
      ...scenario,
      title: truncateForAgent(String(scenario.title ?? ""), 45),
      sources: scenario.sources?.slice(0, 1),
      assertions: [],
    })),
  }));
  const floorFlows = emergencyFlows.slice(0, 2).map((flow, index) => index === 0
    ? {
        ...flow,
        title: truncateForAgent(String(flow.title ?? ""), 45),
        draft: String(flow.draft ?? ""),
        entry: flow.entry ? String(flow.entry) : undefined,
        changedFiles: flow.changedFiles.slice(0, 1),
        reviewQuestion: flow.reviewQuestion
          ? truncateForAgent(String(flow.reviewQuestion), 75)
          : undefined,
        successSignal: flow.successSignal
          ? truncateForAgent(String(flow.successSignal), 75)
          : undefined,
        focus: compactAgentFlowFocus(flow.focus, 45),
        steps: flow.steps.slice(0, 1).map((step) => truncateForAgent(step, 45)),
        selectors: flow.selectors.slice(0, 1),
        existingEvidence: flow.existingEvidence?.slice(0, 1),
      }
    : secondaryAgentFlow(flow, { title: 45, source: 18, draft: 45, file: 45, question: 60, success: 60 }));
  const floorSummary = {
    schema: summary.schema,
    base: agentRefValue(String(summary.base ?? ""), 80),
    head: agentRefValue(String(summary.head ?? ""), 80),
    project: summary.project,
    runner: summary.runner,
    manifest: summary.manifest ? agentRefValue(String(summary.manifest), 80) : null,
    currentDelta: compactAgentCurrentDelta(summary.currentDelta, 2),
    analysisScope: compactAgentAnalysisScope(summary.analysisScope, preserveScopeCandidates),
    execution: summary.execution,
    route: summary.route,
    readiness: summary.readiness,
    scenarioCoverage: summary.scenarioCoverage,
    evidenceSummary: summary.evidenceSummary,
    manifestCorrection: summary.manifestCorrection,
    traceCount: summary.traceCount,
    omittedTraceCount: Math.max(0, numericCount(summary.traceCount) - emergencyTraces.length),
    traces: emergencyTraces,
    testSuite: summary.testSuite,
    intentCount: summary.intentCount,
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - floorIntents.length),
    intents: floorIntents,
    flowCount: summary.flowCount,
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - floorFlows.length),
    flows: floorFlows,
    requiredEvidence: [],
    recommendedEvidenceCount: summary.recommendedEvidenceCount,
    requiredBootstrap: [],
    prChecklist: [],
    commands: summary.commands.slice(0, 1),
    compaction: compactionDisclosure({ emergency: true, floor: true }),
  };
  const floorPayload = JSON.stringify(floorSummary);
  if (Buffer.byteLength(floorPayload) <= agentPayloadByteLimit) {
    return floorPayload;
  }

  const boundedIntents = floorIntents.map((intent) => ({
    ...intent,
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 1),
    scenarios: intent.scenarios.slice(0, 1),
  }));
  const boundedSummary = {
    ...floorSummary,
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - boundedIntents.length),
    intents: boundedIntents,
  };
  const boundedPayload = JSON.stringify(boundedSummary);
  if (Buffer.byteLength(boundedPayload) <= agentPayloadByteLimit) {
    return boundedPayload;
  }

  const hardLimitTraces = emergencyTraces.slice(0, 1).map((trace) => ({
    id: trace.id,
    status: trace.status,
    source: trace.source
      ? {
          kind: trace.source.kind,
          reason: "Located evidence.",
          file: trace.source.file ? String(trace.source.file) : undefined,
        }
      : undefined,
    risk: trace.risk
      ? {
          kind: trace.risk.kind,
          statement: truncateForAgent(String(trace.risk.statement ?? ""), 120),
        }
      : undefined,
    scenario: trace.scenario
      ? {
          id: trace.scenario.id,
          decision: trace.scenario.decision,
          title: truncateForAgent(String(trace.scenario.title ?? ""), 45),
        }
      : undefined,
    execution: trace.execution,
  }));
  const hardLimitIntents = boundedIntents.slice(0, 1).map((intent) => ({
    title: truncateForAgent(String(intent.title ?? ""), 45),
    confidence: intent.confidence,
    reviewRequired: intent.reviewRequired,
    evidence: [],
    lifecycle: selectAgentLifecycleStages(intent.lifecycle, 2),
    scenarioCount: intent.scenarioCount,
    omittedScenarioCount: Math.max(0, (intent.scenarioCount ?? intent.scenarios.length) - 1),
    scenarios: intent.scenarios.slice(0, 1).map((scenario) => ({
      id: scenario.id,
      priority: scenario.priority,
      kind: scenario.kind,
      title: truncateForAgent(String(scenario.title ?? ""), 45),
      confidence: scenario.confidence,
      sources: scenario.sources?.slice(0, 1).map((source) => {
        if (!source || typeof source !== "object") return source;
        const value = source as Record<string, unknown>;
        return {
          kind: value.kind,
          reason: "Located evidence.",
          file: value.file ? String(value.file) : undefined,
        };
      }),
      assertions: [],
    })),
  }));
  const hardLimitFlows = floorFlows.slice(0, 2).map((flow, index) => ({
    title: truncateForAgent(String(flow.title ?? ""), 45),
    source: truncateForAgent(String(flow.source ?? ""), 24),
    authority: flow.authority,
    approvalRequired: flow.approvalRequired,
    testClass: flow.testClass,
    draft: String(flow.draft ?? ""),
    verificationMode: flow.verificationMode,
    changedFiles: flow.changedFiles.slice(0, 1),
    reviewQuestion: flow.reviewQuestion
      ? truncateForAgent(String(flow.reviewQuestion), 70)
      : undefined,
    successSignal: flow.successSignal
      ? truncateForAgent(String(flow.successSignal), 70)
      : undefined,
    steps: index === 0
      ? flow.steps.slice(0, 1).map((step) => truncateForAgent(step, 45))
      : [],
    selectors: [],
    existingEvidence: flow.existingEvidence?.slice(0, 1),
  }));
  const hardLimitSummary = {
    schema: summary.schema,
    base: agentRefValue(String(summary.base ?? ""), 48),
    head: agentRefValue(String(summary.head ?? ""), 48),
    project: summary.project,
    runner: summary.runner,
    manifest: summary.manifest ? agentRefValue(String(summary.manifest), 48) : null,
    currentDelta: compactAgentCurrentDelta(summary.currentDelta, 2),
    execution: summary.execution,
    route: summary.route,
    readiness: summary.readiness,
    scenarioCoverage: summary.scenarioCoverage,
    evidenceSummary: summary.evidenceSummary,
    manifestCorrection: summary.manifestCorrection,
    traceCount: summary.traceCount,
    omittedTraceCount: Math.max(0, numericCount(summary.traceCount) - hardLimitTraces.length),
    traces: hardLimitTraces as unknown[],
    testSuite: summary.testSuite,
    intentCount: summary.intentCount,
    omittedIntentCount: Math.max(0, numericCount(summary.intentCount) - hardLimitIntents.length),
    intents: hardLimitIntents as Array<Record<string, unknown>>,
    flowCount: summary.flowCount,
    omittedFlowCount: Math.max(0, numericCount(summary.flowCount) - hardLimitFlows.length),
    flows: hardLimitFlows as Array<Record<string, unknown>>,
    requiredEvidence: [],
    recommendedEvidenceCount: summary.recommendedEvidenceCount,
    requiredBootstrap: [],
    prChecklist: [],
    commands: summary.commands.slice(0, 1),
    compaction: compactionDisclosure({ emergency: true, hardLimit: true }),
  };
  let hardLimitPayload = JSON.stringify(hardLimitSummary);
  if (Buffer.byteLength(hardLimitPayload) <= agentPayloadByteLimit) {
    return hardLimitPayload;
  }

  // Identifier-preserving overflow relief: identifier values are never emitted
  // as partial strings, so a payload that still exceeds the budget sheds whole
  // optional values instead — each drop stays disclosed through the omitted
  // counts that already accompany the lists.
  const reliefSteps: Array<() => void> = [
    () => {
      for (const flow of hardLimitSummary.flows) delete flow.existingEvidence;
    },
    () => {
      for (const flow of hardLimitSummary.flows) delete flow.changedFiles;
    },
    () => {
      hardLimitSummary.omittedFlowCount += Math.max(0, hardLimitSummary.flows.length - 1);
      hardLimitSummary.flows = hardLimitSummary.flows.slice(0, 1);
    },
    () => {
      hardLimitSummary.omittedTraceCount += hardLimitSummary.traces.length;
      hardLimitSummary.traces = [];
    },
    () => {
      for (const intent of hardLimitSummary.intents) {
        for (const scenario of (intent.scenarios as Array<Record<string, unknown>> | undefined) ?? []) {
          delete scenario.sources;
        }
      }
    },
    () => {
      hardLimitSummary.commands = [];
    },
    () => {
      for (const flow of hardLimitSummary.flows) {
        flow.steps = [];
        delete flow.reviewQuestion;
        delete flow.successSignal;
        delete flow.focus;
        delete flow.entry;
      }
    },
  ];
  for (const relieve of reliefSteps) {
    relieve();
    hardLimitPayload = JSON.stringify(hardLimitSummary);
    if (Buffer.byteLength(hardLimitPayload) <= agentPayloadByteLimit) {
      return hardLimitPayload;
    }
  }
  return hardLimitPayload;
}

function compactAgentCurrentDelta(
  value: AgentSummaryShape["currentDelta"],
  limit: number,
): AgentSummaryShape["currentDelta"] | undefined {
  if (!value) {
    return undefined;
  }
  return {
    scope: value.scope,
    files: value.files.slice(0, Math.max(1, limit)),
    repositoryContracts: value.repositoryContracts.slice(0, Math.max(1, limit)).map((contract) => ({
      title: truncateForAgent(String(contract.title ?? ""), 80),
      file: String(contract.file ?? ""),
      line: contract.line,
      framework: contract.framework,
      authority: contract.authority,
      approvalRequired: contract.approvalRequired,
      testClass: contract.testClass,
    })),
  };
}

function compactAgentCapabilities(
  capabilities: readonly QaCapabilityResult[] | AgentSummaryShape["capabilities"],
): AgentSummaryShape["capabilities"] {
  return capabilities.map(({ id, status, level }) => ({ id, status, level }));
}

function compactAgentAction(
  action: QaActionContract | AgentActionShape,
): AgentActionShape {
  return {
    id: action.id,
    risk: action.risk,
    approval: action.approval,
    executesProjectCode: action.executesProjectCode,
    writesRepository: action.writesRepository,
    untrustedEvidenceCanEscalate: action.untrustedEvidenceCanEscalate,
  };
}

function numericCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function compactAgentAnalysisScope(value: unknown, includeCandidates: boolean): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const scope = value as Record<string, unknown>;
  const mode = typeof scope.mode === "string" ? scope.mode : "repository-root";
  const commandCwd = scope.commandCwd === "selected-package"
    ? "selected-package"
    : "workspace-root";
  const rawCandidates = Array.isArray(scope.candidates) ? scope.candidates : [];
  if (mode === "repository-root" && !scope.selectedPath && rawCandidates.length === 0) {
    return undefined;
  }
  const candidates = includeCandidates
    ? rawCandidates
        .filter((candidate): candidate is Record<string, unknown> =>
          Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate)
        )
        .slice(0, 2)
        .map((candidate) => ({
          path: truncateForAgent(String(candidate.path ?? ""), 70),
          packageName: candidate.packageName
            ? truncateForAgent(String(candidate.packageName), 50)
            : undefined,
          project: String(candidate.project ?? "unknown"),
          runner: String(candidate.runner ?? "manual"),
          changedFiles: numericCount(candidate.changedFiles),
        }))
    : [];
  const defaultReason = mode === "automatic-package"
    ? "One supported package owns every changed file."
    : mode === "explicit-package"
      ? "The caller selected this package."
      : "Repository scope was retained.";
  return {
    mode,
    commandCwd,
    selectedPath: scope.selectedPath
      ? truncateForAgent(String(scope.selectedPath), 70)
      : undefined,
    packageName: scope.packageName
      ? truncateForAgent(String(scope.packageName), 50)
      : undefined,
    candidates,
    reason: includeCandidates && scope.reason
      ? truncateForAgent(String(scope.reason), 90)
      : defaultReason,
  };
}

function shouldPreserveAgentScopeCandidates(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const scope = value as Record<string, unknown>;
  return scope.mode === "repository-root" &&
    Array.isArray(scope.candidates) &&
    scope.candidates.length > 0;
}

function secondaryAgentFlow(
  flow: CompactAgentFlowShape,
  limits: {
    title?: number;
    source?: number;
    draft?: number;
    file?: number;
    question?: number;
    success?: number;
  } = {},
): AgentSummaryShape["flows"][number] {
  return {
    title: truncateForAgent(String(flow.title ?? ""), limits.title ?? 60),
    source: truncateForAgent(String(flow.source ?? ""), limits.source ?? 30),
    authority: flow.authority,
    approvalRequired: flow.approvalRequired,
    testClass: flow.testClass,
    draft: String(flow.draft ?? ""),
    verificationMode: flow.verificationMode,
    changedFiles: flow.changedFiles.slice(0, 1),
    reviewQuestion: flow.reviewQuestion
      ? truncateForAgent(String(flow.reviewQuestion), limits.question ?? 90)
      : undefined,
    successSignal: flow.successSignal
      ? truncateForAgent(String(flow.successSignal), limits.success ?? 90)
      : undefined,
    focus: compactAgentFlowFocus(flow.focus, Math.min(limits.question ?? 90, limits.success ?? 90)),
    steps: [],
    selectors: [],
    existingEvidence: flow.existingEvidence?.slice(0, 1),
    evidence: [],
  };
}

function selectAgentLifecycleStages<T>(stages: T[], limit: number): T[] {
  if (stages.length <= limit) return stages;
  const phasePriority = ["trigger", "state-change", "observable-outcome", "side-effect", "action", "condition"];
  const selectedIndexes: number[] = [];
  for (const phase of phasePriority) {
    const index = stages.findIndex((stage, candidateIndex) =>
      !selectedIndexes.includes(candidateIndex) && lifecycleStagePhase(stage) === phase
    );
    if (index !== -1) selectedIndexes.push(index);
    if (selectedIndexes.length >= limit) break;
  }
  for (let index = 0; index < stages.length && selectedIndexes.length < limit; index += 1) {
    if (!selectedIndexes.includes(index)) selectedIndexes.push(index);
  }
  return selectedIndexes.sort((left, right) => left - right).map((index) => stages[index]);
}

function lifecycleStagePhase(stage: unknown): string | undefined {
  if (!stage || typeof stage !== "object") return undefined;
  const value = stage as Record<string, unknown>;
  return typeof value.phase === "string" ? value.phase : typeof value.kind === "string" ? value.kind : undefined;
}

function compactAgentEvidenceSource(source: unknown): unknown {
  if (!source || typeof source !== "object") return source;
  const value = source as Record<string, unknown>;
  return {
    kind: value.kind,
    reason: "Located evidence.",
    sourceRole: value.sourceRole,
    commit: value.commit,
    file: value.file,
    previousFile: value.previousFile,
    symbol: value.symbol,
    relation: value.relation,
    side: value.side,
    startLine: value.startLine,
    endLine: value.endLine,
    hunk: typeof value.hunk === "string" ? truncateForAgent(value.hunk, 70) : value.hunk,
  };
}

function emergencyAgentEvidenceSource(source: unknown): unknown {
  if (!source || typeof source !== "object") return source;
  const value = source as Record<string, unknown>;
  return {
    kind: value.kind,
    reason: "Located evidence.",
    sourceRole: value.sourceRole,
    commit: value.commit,
    file: value.file,
    symbol: value.symbol,
    relation: value.relation,
    side: value.side,
    startLine: value.startLine,
  };
}

function compactAgentLifecycleStage(stage: unknown): unknown {
  if (!stage || typeof stage !== "object") return stage;
  const value = stage as Record<string, unknown>;
  return {
    phase: value.phase,
    label: truncateForAgent(String(value.label ?? ""), 45),
  };
}

function emergencyAgentLifecycleStage(stage: unknown): unknown {
  if (!stage || typeof stage !== "object") return stage;
  const value = stage as Record<string, unknown>;
  return {
    phase: value.phase,
    label: truncateForAgent(String(value.label ?? ""), 35),
  };
}

function compactAgentRiskStatement(kind: unknown): string {
  const statements: Record<string, string> = {
    primary: "The expected outcome may regress.",
    failure: "Failure handling may regress.",
    boundary: "Boundary behavior may regress.",
    "state-transition": "State transitions may regress.",
  };
  return statements[String(kind)] ?? "The changed behavior may regress.";
}

function formatAgentEvidenceSource(evidence: ChangeIntentEvidence): Record<string, string | number> {
  const source: Record<string, string | number> = {
    kind: evidence.kind,
    reason: truncateForAgent(evidence.value, 90),
  };
  if (evidence.sourceRole && evidence.sourceRole !== "product") source.sourceRole = evidence.sourceRole;
  if (evidence.commit) source.commit = evidence.commit.slice(0, 12);
  if (evidence.file) source.file = evidence.file;
  if (evidence.previousFile) source.previousFile = evidence.previousFile;
  if (evidence.symbol) source.symbol = evidence.symbol;
  if (evidence.relation) source.relation = evidence.relation;
  if (evidence.side) source.side = evidence.side;
  if (evidence.startLine !== undefined) source.startLine = evidence.startLine;
  if (evidence.endLine !== undefined) source.endLine = evidence.endLine;
  if (evidence.hunkHeader) source.hunk = truncateForAgent(evidence.hunkHeader, 80);
  return source;
}

function formatAgentRepositoryContract(
  contract: ChangedTestContract,
): Record<string, string | number | boolean> {
  return {
    title: truncateForAgent(contract.title, 100),
    file: contract.file,
    line: contract.line,
    framework: contract.framework,
    authority: "repository-contract",
    approvalRequired: true,
    testClass: "regression",
  };
}

function strongestEvidence(evidence: ChangeIntentEvidence[], limit: number): ChangeIntentEvidence[] {
  return evidence
    .map((item, index) => ({ item, index }))
    .sort((left, right) => evidenceStrength(right.item) - evidenceStrength(left.item) || left.index - right.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

function evidenceStrength(evidence: ChangeIntentEvidence): number {
  const relationScore = evidence.relation === "direct" ? 2 : evidence.relation === "supporting" ? 1 : 0;
  if (evidence.kind === "diff" && evidence.file && evidence.startLine !== undefined) return 4 + relationScore;
  if (evidence.kind === "diff" && evidence.file) return 2 + relationScore;
  if (evidence.commit) return 1;
  return 0;
}

function formatQaCapabilityName(id: QaCapabilityResult["id"]): string {
  return id.replaceAll("-", " ");
}

function formatQaActionName(id: QaActionId): string {
  return id.replaceAll("-", " ");
}

function qaExecutionAtAGlance(execution: QaExecutionReceipt): string {
  if (execution.status === "not-run") {
    return "Product QA execution: not run; this command performed static analysis and draft mapping only.";
  }
  if (execution.status === "blocked") {
    return `Repository validation execution: blocked; ${execution.reason}`;
  }
  const exitCode = execution.exitCode === undefined ? "not available" : String(execution.exitCode);
  return `Repository validation execution: ${execution.status}; exit code ${exitCode}, ${execution.durationMs} ms.`;
}

function repositoryContractExecutionLine(execution: QaExecutionReceipt): string {
  if (execution.status === "not-run") {
    return "Execution status: not run by QAMap; use the selected repository validation command and record its result.";
  }
  if (execution.status === "blocked") {
    return `Execution status: blocked; ${execution.reason}`;
  }
  return `Execution status: ${execution.status}; QAMap ran the selected repository command with exit code ${execution.exitCode ?? "not available"}.`;
}

export function formatTextQaDraft(result: QaDraftResult): string {
  const lines: string[] = [];
  const primaryIntent = result.changeAnalysis.intents[0];
  const primaryFlow = result.flows[0];
  const routing = summarizeTraceRouting(result.traces);
  const automation = summarizeTraceAutomation(result.traces);

  lines.push("QAMap QA");
  lines.push("Local static analysis. No cloud or LLM token. Product QA was not run.");
  lines.push("");
  lines.push("Change");
  if (primaryIntent) {
    const review = primaryIntent.reviewRequired ? "; review required" : "";
    lines.push(`  ${plainText(primaryIntent.title)} (${primaryIntent.confidence} confidence${review})`);
    const lifecycle = summarizeIntentLifecycle(primaryIntent.lifecycle);
    if (lifecycle) {
      lines.push("  Flow:");
      for (const [index, stage] of lifecycle.split(" -> ").entries()) {
        lines.push(`    ${index === 0 ? "" : "-> "}${plainText(stage)}`);
      }
    }
  } else {
    lines.push("  No change intent was inferred; suggestions remain review-only.");
  }
  if (primaryFlow) {
    lines.push(`  Affected behavior: ${plainText(primaryFlow.title)}`);
  } else {
    lines.push("  Affected behavior: no changed flow candidate was found.");
  }

  lines.push("");
  lines.push("Verify before merge");
  if (result.traces.length === 0) {
    if (primaryFlow) {
      const reviewQuestion = primaryFlow.userJourney?.reviewQuestion ?? `Does ${primaryFlow.title} behave as intended?`;
      lines.push(`  REVIEW  ${plainText(reviewQuestion)}`);
      if (primaryFlow.userJourney?.successSignal && !primaryFlow.userJourney.successSignalUnresolved) {
        lines.push(`    Proof: ${plainText(primaryFlow.userJourney.successSignal)}`);
      }
      if (primaryFlow.changedFiles[0]) {
        lines.push(`    Evidence: ${plainText(primaryFlow.changedFiles[0])}`);
      }
    } else {
      lines.push("  No diff-backed QA scenario was produced.");
    }
  } else {
    const seenScenarioTitles = new Set<string>();
    const displayedTraces = result.traces
      .filter((trace) => {
        const key = trace.scenario.title.trim().toLowerCase();
        if (seenScenarioTitles.has(key)) {
          return false;
        }
        seenScenarioTitles.add(key);
        return true;
      })
      .slice(0, 4);
    for (const trace of displayedTraces) {
      lines.push(`  ${trace.scenario.decision.toUpperCase()}  ${plainText(trace.scenario.title)}`);
      if (trace.scenario.assertions[0]) {
        lines.push(`    Proof: ${plainText(trace.scenario.assertions[0])}`);
      }
      const source = trace.sources.find((item) => item.file) ?? trace.sources[0];
      if (source) {
        lines.push(`    Evidence: ${formatPlainEvidenceReference(source)}`);
      }
    }
    if (result.traces.length > displayedTraces.length) {
      lines.push(`  ${result.traces.length - displayedTraces.length} more scenario(s) are available in the full report.`);
    }
  }

  lines.push("");
  lines.push("Evidence");
  if (result.evidenceSummary.totalTraces === 0) {
    lines.push("  No diff-backed reasoning trace; the inferred flow remains review-only.");
  } else {
    lines.push(
      `  ${result.evidenceSummary.confirmed}/${result.evidenceSummary.totalTraces} scenarios connect to ` +
        `${result.evidenceSummary.uniqueSources} unique diff source(s).`,
    );
  }
  if (result.traces.length > 0) {
    lines.push(
      `  Routing: ${routing.required} required, ${routing.recommended} recommended, ${routing.reviewOnly} review-only.`,
    );
  } else if (primaryFlow) {
    lines.push("  Routing: fallback flow for review; no scenario policy was inferred.");
  }
  if (result.readiness.basis === "repository-validation") {
    const verificationModes = uniqueStrings(
      result.flows
        .map((flow) => flow.verificationMode)
        .filter((mode): mode is QaVerificationMode => Boolean(mode))
        .map(formatVerificationMode),
    );
    lines.push(
      `  Repository verification: ${verificationModes.length > 0 ? verificationModes.join(", ") : "existing repository evidence"}; ` +
        "no product E2E draft proposed.",
    );
  } else {
    lines.push(
      `  Optional E2E mapping: ${automation.compiled} mapped, ${automation.partial} partial, ` +
        `${automation.notCompiled} unmapped; not executed.`,
    );
  }
  const validationCommand = nextStepCommand(result);
  const supplementalCommand = supplementalValidationCommand(result);
  if (validationCommand) {
    const commandLocation = result.analysisScope.commandCwd === "selected-package" &&
        result.analysisScope.selectedPath
      ? `selected package ${result.analysisScope.selectedPath}`
      : "workspace root";
    lines.push(
      `  Existing validation (${plainText(commandLocation)}): ${plainText(validationCommand)} (selected, not run)`,
    );
  } else if (supplementalCommand) {
    lines.push(
      `  Supplemental validation: ${plainText(supplementalCommand)} (available, not selected for this QA route)`,
    );
  }

  lines.push("");
  lines.push("Next");
  if (validationCommand) {
    lines.push("  Run selected repository validation: qamap qa run");
  } else {
    lines.push("  Review the selected scenarios before choosing an execution step.");
  }
  if (needsGeneratedDraft(result)) {
    lines.push("  Preview an optional automation or checklist draft: qamap e2e draft . --dry-run");
  }
  lines.push("  Open the full reasoning trace: qamap qa --format markdown");
  return `${lines.join("\n")}\n`;
}

export function formatMarkdownQaDraft(result: QaDraftResult): string {
  const lines: string[] = [];
  lines.push("# QAMap QA Draft");
  lines.push("");
  lines.push("> Local-first PR QA skill output. No cloud. No LLM token. Manifest is optional, not required for first use.");
  lines.push("");
  lines.push("## At a Glance");
  lines.push("");
  lines.push(`- ${qaExecutionAtAGlance(result.execution)}`);
  lines.push(`- Analysis scope: ${escapeMarkdownInline(formatAnalysisScope(result.analysisScope))}`);
  const primaryIntent = result.changeAnalysis.intents[0];
  if (primaryIntent) {
    lines.push(`- Change intent: ${escapeMarkdownInline(primaryIntent.title)} [${primaryIntent.confidence}]`);
    const lifecycle = summarizeIntentLifecycle(primaryIntent.lifecycle);
    if (lifecycle) {
      lines.push(`- Behavior lifecycle: ${escapeMarkdownInline(lifecycle)}`);
    }
    if (primaryIntent.reviewRequired) {
      lines.push("- Intent confidence: human review is required before treating generated scenarios as regression policy.");
    }
  } else {
    lines.push("- Change intent: not inferred; heuristic flow suggestions remain review-only.");
  }
  if (result.flows.length === 0) {
    lines.push("- Affected behavior: no changed flow candidate was generated from this diff.");
  } else {
    const flowTitles = result.flows.slice(0, 3).map((flow) => escapeMarkdownInline(flow.title)).join(", ");
    const moreFlows = result.flows.length > 3 ? ` and ${result.flows.length - 3} more` : "";
    lines.push(`- Affected behavior: ${flowTitles}${moreFlows}`);
    const primaryFlow = result.flows[0];
    if (primaryFlow.userJourney?.reviewQuestion) {
      lines.push(`- Verify before merge: ${escapeMarkdownInline(primaryFlow.userJourney.reviewQuestion)}`);
    }
    const evidence = atAGlanceEvidence(primaryFlow);
    if (evidence.length > 0) {
      lines.push(`- Evidence found: ${evidence.map(escapeMarkdownInline).join("; ")}`);
    }
    if (primaryFlow.existingEvidencePaths.length > 0) {
      lines.push(
        `- Existing test evidence: ${primaryFlow.existingEvidencePaths.slice(0, 3).map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`,
      );
    } else if (primaryFlow.verificationMode) {
      lines.push(`- Verification mode: ${formatVerificationMode(primaryFlow.verificationMode)}; no new product-journey E2E draft is proposed.`);
    } else {
      lines.push(
        `- QA proposal: ${primaryFlow.draftSteps.length || fallbackDraftSteps(primaryFlow).length} review steps; executable automation remains optional.`,
      );
    }
  }
  if (result.changedTestContracts.length > 0) {
    const contractTitles = result.changedTestContracts.slice(0, 3).map((contract) => contract.title);
    const moreContracts = result.changedTestContracts.length > contractTitles.length
      ? `; and ${result.changedTestContracts.length - contractTitles.length} more`
      : "";
    lines.push(
      `- Repository-authored behavior: ${contractTitles.map(escapeMarkdownInline).join("; ")}${moreContracts}. Execution not run by QAMap.`,
    );
  }
  if (result.currentDelta) {
    lines.push(
      `- Current local delta: ${result.currentDelta.files.length} file${result.currentDelta.files.length === 1 ? "" : "s"} isolated from committed branch history.`,
    );
  }
  lines.push(
    `- Analysis capabilities: ${result.capabilities.map((capability) =>
      `${formatQaCapabilityName(capability.id)} ${capability.status}/${capability.level}`
    ).join("; ")}.`,
  );
  lines.push(
    `- Selected action: ${formatQaActionName(result.action.id)}; risk ${result.action.risk}, ` +
      `approval ${result.action.approval}, project code ${result.action.executesProjectCode ? "may run" : "will not run"}, ` +
      `repository writes ${result.action.writesRepository}.`,
  );
  if (result.evidenceBoundary.neutralizedValues > 0) {
    lines.push(
      `- Safety boundary: ${result.evidenceBoundary.neutralizedValues} instruction-like repository value` +
        `${result.evidenceBoundary.neutralizedValues === 1 ? " was" : "s were"} neutralized; ` +
        "repository text cannot escalate the selected action.",
    );
  }
  const nextCommand = nextStepCommand(result);
  const supplementalCommand = supplementalValidationCommand(result);
  if (nextCommand) {
    const commandLocation = result.analysisScope.commandCwd === "selected-package" &&
        result.analysisScope.selectedPath
      ? ` from selected package \`${escapeMarkdownInline(result.analysisScope.selectedPath)}\``
      : " from the workspace root";
    lines.push(`- Repository validation${commandLocation}: \`${escapeMarkdownInline(nextCommand)}\``);
  } else if (supplementalCommand) {
    const commandLocation = result.analysisScope.commandCwd === "selected-package" &&
        result.analysisScope.selectedPath
      ? ` from selected package \`${escapeMarkdownInline(result.analysisScope.selectedPath)}\``
      : " from the workspace root";
    lines.push(
      `- Supplemental repository validation${commandLocation}: ` +
        `\`${escapeMarkdownInline(supplementalCommand)}\` is available but was not selected for this QA route.`,
    );
  }
  const verificationOnly = result.readiness.basis === "repository-validation";
  const blocking = result.missingEvidence.filter((item) => item.priority === "required").slice(0, 2);
  if (verificationOnly) {
    lines.push("- Optional automation: not applicable; this diff routes to existing repository validation.");
  } else if (blocking.length === 0) {
    lines.push("- Optional automation: no required draft-mapping gap detected; review the scenario sources and run repository validation.");
  } else {
    for (const [index, item] of blocking.entries()) {
      lines.push(
        `- Optional automation gap${blocking.length > 1 ? ` ${index + 1}` : ""}: ${escapeMarkdownInline(item.title)}: ${escapeMarkdownInline(item.detail)}`,
      );
    }
  }
  const hasTraces = result.traces.length > 0;
  const traceRouting = hasTraces
    ? summarizeTraceRouting(result.traces)
    : {
        required: result.readiness.requiredScenarios,
        recommended: result.readiness.recommendedScenarios,
        reviewOnly: result.readiness.reviewOnlyScenarios,
      };
  const routedScenarios = hasTraces
    ? result.traces.length
    : result.readiness.requiredScenarios +
      result.readiness.recommendedScenarios +
      result.readiness.reviewOnlyScenarios;
  lines.push(
    routedScenarios > 0
      ? `- QA analysis: completed independently of runner setup; ${routedScenarios} diff-backed scenario${routedScenarios === 1 ? "" : "s"} routed for review.`
      : `- QA analysis: completed independently of runner setup; ${result.flows.length} affected flow${result.flows.length === 1 ? "" : "s"} mapped for review.`,
  );
  if (routedScenarios > 0) {
    lines.push(
      `- Scenario routing: ${traceRouting.required} required, ` +
        `${traceRouting.recommended} recommended, ${traceRouting.reviewOnly} review-only.`,
    );
    if (verificationOnly) {
      const modes = uniqueStrings(
        result.flows
          .map((flow) => flow.verificationMode)
          .filter((mode): mode is QaVerificationMode => Boolean(mode))
          .map(formatVerificationMode),
      );
      lines.push(
        `- Repository verification mapping: ${routedScenarios} routed scenario${routedScenarios === 1 ? "" : "s"}` +
          `${modes.length > 0 ? ` ${routedScenarios === 1 ? "uses" : "use"} ${modes.join(", ")}` : ` ${routedScenarios === 1 ? "uses" : "use"} existing repository evidence`}; ` +
          "no product E2E draft mapping is expected.",
      );
    } else {
      const traceAutomation = hasTraces
        ? summarizeTraceAutomation(result.traces)
        : {
            compiled: result.readiness.compiledScenarios,
            partial: result.readiness.partialScenarios,
            notCompiled: result.readiness.notCompiledScenarios,
            reviewOnly: result.readiness.reviewOnlyScenarios,
          };
      lines.push(
        `- E2E draft mapping: ${traceAutomation.compiled} fully mapped, ` +
          `${traceAutomation.partial} partially mapped, ${traceAutomation.notCompiled} not mapped, ` +
          `${traceAutomation.reviewOnly} review-only; no tests executed.`,
      );
    }
    if (hasTraces) {
      const traceable = result.traces.filter((trace) => trace.status === "traceable").length;
      lines.push(
        `- Reasoning trace: ${result.traces.length}/${routedScenarios} scenario${routedScenarios === 1 ? "" : "s"} traced; ` +
          `${traceable} ${traceable === 1 ? "fully connects" : "fully connect"} diff evidence to affected behavior, risk, and QA routing.`,
      );
      lines.push(
        `- Evidence status: ${result.evidenceSummary.confirmed} confirmed, ` +
          `${result.evidenceSummary.sourceGaps} source gap${result.evidenceSummary.sourceGaps === 1 ? "" : "s"}, ` +
          `${result.evidenceSummary.mappingGaps} mapping gap${result.evidenceSummary.mappingGaps === 1 ? "" : "s"} ` +
          `across ${result.evidenceSummary.uniqueSources} unique source${result.evidenceSummary.uniqueSources === 1 ? "" : "s"}.`,
      );
    }
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  if (result.analysisScope.workspaceRoot !== result.root) {
    lines.push(`- Workspace root: \`${escapeMarkdownInline(result.analysisScope.workspaceRoot)}\``);
  }
  lines.push(`- Analysis scope: ${escapeMarkdownInline(formatAnalysisScope(result.analysisScope))}`);
  lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
  lines.push(`- Base selection: ${escapeMarkdownInline(result.baseResolution.reason)}`);
  lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
  lines.push(`- Change scope: ${result.includeWorkingTree ? "committed and uncommitted working-tree changes" : "committed branch changes only"}`);
  lines.push(`- Project: ${formatProjectType(result.project)}`);
  lines.push(`- Manifest: ${result.manifestPath ? `\`${escapeMarkdownInline(result.manifestPath)}\`` : "not found; using repo signals and PR diff only"}`);
  lines.push(
    `- Repository evidence boundary: ${result.evidenceBoundary.repositoryContent}; ` +
      `instruction-like content is ${result.evidenceBoundary.instructionLikeContent} and cannot change action authority.`,
  );
  if (verificationOnly) {
    lines.push(`- Repository verification stage: ${formatRepositoryVerificationStage(result, nextCommand)}`);
    lines.push("- Optional automation readiness: not applicable to this verification-only diff.");
  } else {
    lines.push(`- Automation stage: ${formatDraftReadinessStage(result.readiness)}`);
  }
  lines.push("- QA analysis and scenario routing do not require the optional automation runner to be installed.");
  lines.push(`- Draft flows: ${result.flows.length}`);
  lines.push("");

  if (result.currentDelta) {
    lines.push("## Current Local Delta");
    lines.push("");
    lines.push(
      "This working-tree-only capsule is separate from committed branch history so the newest local change is not buried by older feature work.",
    );
    lines.push("");
    for (const file of result.currentDelta.files.slice(0, 12)) {
      lines.push(`- Changed now: \`${escapeMarkdownInline(file)}\``);
    }
    for (const contract of result.currentDelta.repositoryContracts.slice(0, 6)) {
      lines.push(
        `- Repository contract awaiting review: ${escapeMarkdownInline(contract.title)} — ` +
          `\`${escapeMarkdownInline(contract.file)}:${contract.line}\``,
      );
    }
    if (result.currentDelta.repositoryContracts.length === 0) {
      lines.push("- No changed test contract was declared in the current local delta.");
    }
    lines.push("");
  }

  if (result.changedTestContracts.length > 0) {
    lines.push("## Repository-backed QA Contracts");
    lines.push("");
    lines.push(
      `QAMap found ${result.changedTestContracts.length} test contract${result.changedTestContracts.length === 1 ? "" : "s"} declared in changed test code. Authority: repository contract. These expectations still require PR approval and are not proof that the tests passed.`,
    );
    lines.push("");
    for (const contract of result.changedTestContracts.slice(0, 12)) {
      lines.push(
        `- ${escapeMarkdownInline(contract.title)} — \`${escapeMarkdownInline(contract.file)}:${contract.line}\` (${contract.framework})`,
      );
    }
    if (result.changedTestContracts.length > 12) {
      lines.push(`- ... ${result.changedTestContracts.length - 12} more contracts are available in \`--format json\`.`);
    }
    lines.push(`- ${repositoryContractExecutionLine(result.execution)}`);
    lines.push("");
  }

  appendQaDecisionLayers(lines, result, nextCommand);

  appendQaReasoningTraceMarkdown(lines, result);

  appendQaChangeIntentMarkdown(lines, result);

  lines.push("## PR Comment Draft");
  lines.push("");
  lines.push("### Affected Flow");
  lines.push("");
  if (result.flows.length === 0) {
    lines.push("- No changed flow candidate was generated. Run from a branch with changed files or include working tree changes.");
  } else {
    for (const flow of result.flows) {
      lines.push(`- ${escapeMarkdownInline(flow.title)} (${flow.source})`);
      if (flow.userJourney) {
        lines.push(`  - User journey: ${escapeMarkdownInline(flow.userJourney.actor)} -> ${escapeMarkdownInline(flow.userJourney.trigger)} -> ${escapeMarkdownInline(flow.userJourney.goal)}`);
        lines.push(`  - Success signal: ${escapeMarkdownInline(flow.userJourney.successSignal)}`);
        lines.push(`  - Reviewer question: ${escapeMarkdownInline(flow.userJourney.reviewQuestion)}`);
      }
      if (flow.changedFiles.length > 0) {
        lines.push(`  - Changed files: ${flow.changedFiles.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`);
      }
      for (const reason of flow.why.slice(0, 3)) {
        lines.push(`  - Why: ${escapeMarkdownInline(reason)}`);
      }
    }
  }
  lines.push("");

  lines.push("### Suggested QA Scenarios");
  lines.push("");
  for (const flow of result.flows) {
    if (flow.existingEvidencePaths.length > 0) {
      lines.push(
        `- Run existing test evidence: ${flow.existingEvidencePaths.slice(0, 4).map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`,
      );
    } else if (flow.verificationMode) {
      lines.push(
        result.suggestedCommands[0]
          ? `- Run ${formatVerificationMode(flow.verificationMode)} with \`${escapeMarkdownInline(result.suggestedCommands[0])}\`; no new product-journey E2E draft is proposed.`
          : `- Define a repository-owned command for ${formatVerificationMode(flow.verificationMode)}; QAMap will not invent a command or a product-journey E2E draft.`,
      );
    } else {
      lines.push(`- ${escapeMarkdownInline(flow.title)}`);
    }
    const routeHint = flow.entrypointHints.find((hint) => hint.startsWith("route:"));
    if (routeHint) {
      lines.push(`  - Entrypoint: ${escapeMarkdownInline(routeHint)}`);
    }
    const steps = flow.draftSteps.length > 0 ? flow.draftSteps : fallbackDraftSteps(flow);
    for (const step of steps.slice(0, 5)) {
      lines.push(`  - ${escapeMarkdownInline(step)}`);
    }
    if (flow.selectorHints.length > 0) {
      lines.push(`  - Selector evidence: ${flow.selectorHints.slice(0, 3).map(escapeMarkdownInline).join("; ")}`);
    }
    if (flow.manifestUpdatePath) {
      lines.push(`  - If wrong: update \`${escapeMarkdownInline(flow.manifestUpdatePath)}\``);
    }
  }
  lines.push("");

  lines.push("### Draft Mapping And Context Gaps");
  lines.push("");
  if (result.missingEvidence.length === 0) {
    if (result.readiness.basis === "repository-validation" && result.readiness.verificationStatus === "command-needed") {
      lines.push("- Repository verification target found, but no trusted command is declared. Add or pass the repository-owned validation command before merge; QAMap will not invent or execute one.");
    } else if (result.readiness.basis === "repository-validation") {
      lines.push("- Product automation mapping is not applicable. Review the QA reasoning and run the selected repository validation command before merge.");
    } else {
      lines.push("- No required automation or context gap was detected. Still review the QA reasoning and run the project validation command before merge.");
    }
  } else {
    for (const item of result.missingEvidence.slice(0, 6)) {
      lines.push(`- [${item.priority}] ${item.kind}: ${escapeMarkdownInline(item.title)} - ${escapeMarkdownInline(item.detail)} (${escapeMarkdownInline(item.flowTitle)})`);
    }
    if (result.missingEvidence.length > 6) {
      lines.push(`- ... ${result.missingEvidence.length - 6} more lower-priority items (see \`--format json\` for the full list)`);
    }
  }
  lines.push("");

  lines.push("### PR Checklist");
  lines.push("");
  for (const item of result.prChecklist) {
    lines.push(`- [ ] ${escapeMarkdownInline(item)}`);
  }
  lines.push("");

  lines.push("## Agent Handoff");
  lines.push("");
  for (const item of result.agentHandoff) {
    lines.push(`- ${escapeMarkdownInline(item)}`);
  }
  lines.push("");

  if (needsGeneratedDraft(result)) {
    lines.push("## Optional Automation");
    lines.push("");
    lines.push(
      "The QA judgment above does not require adopting this adapter. Use this section only when the team wants to turn an accepted scenario into executable coverage.",
    );
    lines.push("");
    lines.push(`- Adapter candidate: ${formatRunnerName(result.runner)}`);
    lines.push(`- Draft target: \`${escapeMarkdownInline(result.flows[0]?.draftPath ?? "generated E2E file")}\` (${formatRunnableStatus(result.flows[0]?.runnableStatus)})`);
    lines.push(`- Preview or create a draft: \`qamap e2e draft . --base ${escapeMarkdownInline(result.base)} --head ${escapeMarkdownInline(result.head)}\``);
    if (result.runnerSetup.status === "proposed" && result.runnerSetup.setupCommand) {
      lines.push(`- If the team accepts this adapter, inspect its setup proposal: \`${escapeMarkdownInline(result.runnerSetup.setupCommand)}\``);
    }
    const primaryStatus = result.flows[0]?.runnableStatus;
    lines.push(
      primaryStatus === "runnable-candidate"
        ? "- Static checks passed for this candidate, but QAMap did not run the target application. Run the repository command before claiming the scenario passed."
        : "- Keep generated code review-only until its scenario sources, assertions, fixtures, and selectors are confirmed.",
    );
    lines.push("");
  }

  return lines.join("\n");
}

function appendQaDecisionLayers(
  lines: string[],
  result: QaDraftResult,
  nextCommand: string | undefined,
): void {
  const scenarios = result.changeAnalysis.intents.flatMap((intent) => intent.scenarios);
  const automationByScenario = aggregateScenarioAutomationById(result.flows);
  const staticRunnableFlows = result.flows.filter((flow) => flow.runnableStatus === "runnable-candidate");
  const contractScenarios = scenarios.filter((scenario) => {
    const automation = automationByScenario.get(scenario.id)?.receipt;
    return !automation || automation.status !== "compiled";
  });

  lines.push("## QA Decision Layers");
  lines.push("");
  lines.push("### 1. Important QA And Risk Map");
  lines.push("");
  lines.push(
    scenarios.length > 0
      ? `- ${scenarios.length} diff-backed scenario${scenarios.length === 1 ? " remains" : "s remain"} in the review scope regardless of current automation readiness.`
      : "- No diff-backed scenario was inferred; heuristic suggestions remain review-only.",
  );
  lines.push(
    "- Scenario authority is explicit: team policy is reviewed knowledge, repository contracts are declared but unexecuted, and QAMap inference requires human approval.",
  );
  lines.push("- Runner, selector, fixture, or environment gaps do not remove an important risk from this layer.");
  lines.push("");

  lines.push("### 2. Executable Evidence Available Now");
  lines.push("");
  if (nextCommand) {
    lines.push(`- Repository command: \`${escapeMarkdownInline(nextCommand)}\` (selected but not run by QAMap).`);
  }
  for (const flow of staticRunnableFlows.slice(0, 4)) {
    lines.push(
      `- Static-runnable draft: \`${escapeMarkdownInline(flow.draftPath)}\` for ${escapeMarkdownInline(flow.title)}; self-checks passed, target application not executed.`,
    );
  }
  if (!nextCommand && staticRunnableFlows.length === 0) {
    lines.push("- None yet. QAMap is not claiming executable coverage for this change.");
  }
  lines.push("");

  lines.push("### 3. Manual Or Agent QA Contracts");
  lines.push("");
  if (contractScenarios.length === 0) {
    lines.push("- No unmapped scenario contract remains.");
  } else {
    for (const scenario of contractScenarios.slice(0, 6)) {
      const automation = automationByScenario.get(scenario.id)?.receipt;
      const verificationMode = verificationModeForScenario(result.flows, scenario.id);
      const trace = result.traces.find((item) => item.scenario.id === scenario.id);
      const testClass = trace?.scenario.testClass ?? (scenario.kind === "primary" ? "regression" : "edge");
      const authority = trace?.scenario.authority ?? "qamap-inference";
      lines.push(
        `- [${scenario.priority}] [${testClass}] ${escapeMarkdownInline(scenario.title)} ` +
          `(authority: ${authority}; approval required)`,
      );
      if (scenario.setup[0]) {
        lines.push(`  - Setup: ${escapeMarkdownInline(scenario.setup[0])}`);
      }
      if (scenario.steps[0]) {
        lines.push(`  - Action: ${escapeMarkdownInline(scenario.steps[0])}`);
      }
      if (scenario.assertions[0]) {
        lines.push(`  - Proof: ${escapeMarkdownInline(scenario.assertions[0])}`);
      }
      if (!verificationMode && automation?.blockers[0]) {
        lines.push(`  - Automation gap: ${escapeMarkdownInline(automation.blockers[0])}`);
      }
    }
  }
  lines.push("");
}

function summarizeTraceRouting(traces: QaReasoningTrace[]): {
  required: number;
  recommended: number;
  reviewOnly: number;
} {
  return traces.reduce((summary, trace) => {
    if (trace.scenario.decision === "required") summary.required += 1;
    else if (trace.scenario.decision === "recommended") summary.recommended += 1;
    else summary.reviewOnly += 1;
    return summary;
  }, { required: 0, recommended: 0, reviewOnly: 0 });
}

function summarizeTraceAutomation(traces: QaReasoningTrace[]): {
  compiled: number;
  partial: number;
  notCompiled: number;
  reviewOnly: number;
} {
  return traces.reduce((summary, trace) => {
    const status = trace.artifact?.status;
    if (status === "compiled") summary.compiled += 1;
    else if (status === "partial") summary.partial += 1;
    else if (status === "review-only") summary.reviewOnly += 1;
    else summary.notCompiled += 1;
    return summary;
  }, { compiled: 0, partial: 0, notCompiled: 0, reviewOnly: 0 });
}

function appendQaReasoningTraceMarkdown(lines: string[], result: QaDraftResult): void {
  lines.push("## QA Reasoning Trace");
  lines.push("");
  lines.push(
    "> Each trace is a deterministic explanation of why a QA scenario exists. Traceable reasoning is not proof that the target application passed QA.",
  );
  lines.push("");
  if (result.traces.length === 0) {
    lines.push("No diff-backed QA reasoning trace was produced for this change.");
    lines.push("");
    return;
  }

  for (const trace of result.traces.slice(0, 6)) {
    const verificationMode = verificationModeForScenario(result.flows, trace.scenario.id);
    lines.push(`### \`${escapeMarkdownInline(trace.id)}\` [${trace.status}]`);
    lines.push("");
    lines.push(
      `- Evidence status: \`${trace.evidenceAssessment.disposition}\` - ` +
        `${escapeMarkdownInline(trace.evidenceAssessment.reason)} ` +
        `(${trace.evidenceAssessment.uniqueSourceCount} unique source${trace.evidenceAssessment.uniqueSourceCount === 1 ? "" : "s"})`,
    );
    if (trace.sources.length > 0) {
      lines.push(
        `1. Diff evidence: ${trace.sources.slice(0, 2).map((source) => `${formatEvidenceReference(source)} - ${escapeMarkdownInline(source.value)}`).join("; ")}`,
      );
    } else {
      lines.push("1. Diff evidence: no concrete source location was found.");
    }
    if (trace.behavior.length > 0) {
      lines.push(
        `2. Affected behavior: ${trace.behavior.slice(0, 2).map((stage) => `${stage.phase}: ${escapeMarkdownInline(stage.label)} [${stage.relation}]`).join(" -> ")}`,
      );
    } else {
      lines.push("2. Affected behavior: no lifecycle stage was linked.");
    }
    lines.push(`3. Risk: ${escapeMarkdownInline(trace.risk.statement)}`);
    lines.push(
      `4. QA scenario: [${trace.scenario.decision}] [${trace.scenario.testClass}] ` +
        `${escapeMarkdownInline(trace.scenario.title)} ` +
        `(authority: ${trace.scenario.authority}; approval ${trace.scenario.approvalRequired ? "required" : "recorded"})`,
    );
    if (trace.scenario.assertions[0]) {
      lines.push(`5. Expected proof: ${escapeMarkdownInline(trace.scenario.assertions[0])}`);
    } else {
      lines.push("5. Expected proof: no observable assertion was inferred.");
    }
    if (verificationMode) {
      lines.push(
        `6. Repository verification: ${formatVerificationMode(verificationMode)}; no product E2E artifact is expected.`,
      );
    } else if (trace.artifact) {
      const flowCoverage = trace.artifact.flowCount > 1
        ? `flow coverage ${trace.artifact.compiledFlowCount}/${trace.artifact.flowCount}; `
        : "";
      lines.push(
        `6. Optional artifact: \`${escapeMarkdownInline(trace.artifact.draftPath)}\` - ` +
          `${formatScenarioAutomationStatus(trace.artifact.status)} ` +
          `(${flowCoverage}steps ${trace.artifact.mappedSteps}/${trace.artifact.totalSteps}; ` +
          `assertions ${trace.artifact.mappedAssertions}/${trace.artifact.totalAssertions})`,
      );
    } else {
      lines.push("6. Optional artifact: no deterministic draft mapping was produced.");
    }
    lines.push("7. Execution: not run.");
    const relevantGaps = verificationMode
      ? trace.gaps.filter((gap) => !/automation artifact|flow artifacts|draft mapping/i.test(gap))
      : trace.gaps;
    for (const gap of relevantGaps.slice(0, 2)) {
      lines.push(`- Trace gap: ${escapeMarkdownInline(gap)}`);
    }
    lines.push(
      `- If this trace is wrong: review \`${escapeMarkdownInline(trace.manifestCorrection.target)}\`. ` +
        `${escapeMarkdownInline(trace.manifestCorrection.action)} Human approval is required before repo-local QA memory changes.`,
    );
    lines.push("");
  }
  if (result.traces.length > 6) {
    lines.push(`... ${result.traces.length - 6} more trace${result.traces.length - 6 === 1 ? "" : "s"} are available with \`--format json\`.`);
    lines.push("");
  }
}

function appendQaChangeIntentMarkdown(lines: string[], result: QaDraftResult): void {
  lines.push("## Change Intent Evidence");
  lines.push("");
  if (result.changeAnalysis.symbolAnnotations) {
    const annotations = result.changeAnalysis.symbolAnnotations;
    lines.push(
      `- Symbol QA context: ${annotations.applied} changed exported symbol` +
        `${annotations.applied === 1 ? "" : "s"} applied; ` +
        `${annotations.diagnostics} annotation diagnostic${annotations.diagnostics === 1 ? "" : "s"}.`,
    );
    if (annotations.flows.length > 0) {
      lines.push(
        `- Declared flow context: ${annotations.flows.slice(0, 6).map((flow) => `\`${escapeMarkdownInline(flow)}\``).join(", ")}`,
      );
    }
    for (
      const diagnostic of result.changeAnalysis.diagnostics
        .filter((item) => item.includes("[symbol-annotation/"))
        .slice(0, 3)
    ) {
      lines.push(`- Annotation diagnostic: ${escapeMarkdownInline(diagnostic)}`);
    }
    lines.push("");
  }
  if (result.changeAnalysis.intents.length === 0) {
    lines.push("No behavior-bearing commit intent was found. QAMap did not promote inferred names into trusted QA scenarios.");
    for (const diagnostic of result.changeAnalysis.diagnostics.slice(0, 3)) {
      lines.push(`- ${escapeMarkdownInline(diagnostic)}`);
    }
    lines.push("");
    return;
  }
  for (const intent of result.changeAnalysis.intents.slice(0, 3)) {
    lines.push(`### ${escapeMarkdownInline(intent.title)}`);
    lines.push("");
    lines.push(`- Confidence: ${intent.confidence}${intent.reviewRequired ? "; review required" : ""}`);
    for (const commit of intent.commits.slice(0, 5)) {
      lines.push(`- Evidence: \`${commit.sha.slice(0, 12)}\` ${escapeMarkdownInline(commit.subject)}`);
    }
    lines.push("- Lifecycle:");
    for (const stage of intent.lifecycle.slice(0, 10)) {
      const source = stage.evidence.find((item) => item.file || item.commit);
      const sourceSuffix = source ? ` (${formatEvidenceReference(source)})` : "";
      lines.push(`  - ${stage.kind}: ${escapeMarkdownInline(stage.label)}${sourceSuffix}`);
    }
    lines.push("- QA scenarios:");
    if (intent.scenarios.length === 0) {
      lines.push("  - No standalone QA scenario; retained as commit provenance only.");
    } else {
      for (const scenario of intent.scenarios.slice(0, 4)) {
        const confidence = scenario.confidence ?? "low";
        const reviewRequired = scenario.reviewRequired ?? true;
        const routing = routeQaScenario(scenario);
        const automation = findScenarioAutomation(result, scenario.id);
        const verificationMode = verificationModeForScenario(result.flows, scenario.id);
        lines.push(
          `  - [${scenario.priority}] ${escapeMarkdownInline(scenario.title)} ` +
          `(confidence: ${confidence}${reviewRequired ? "; review required" : ""})`,
        );
        const trace = result.traces.find((item) => item.scenario.id === scenario.id);
        if (trace) {
          lines.push(`    - Trace: \`${escapeMarkdownInline(trace.id)}\``);
        }
        lines.push(`    - Routing: ${routing.decision} - ${escapeMarkdownInline(routing.reason)}`);
        lines.push(
          `    - Evidence role: ${routing.requiredEvidence.length} required diff source${routing.requiredEvidence.length === 1 ? "" : "s"}; ` +
            `${routing.referenceEvidence.length} reference source${routing.referenceEvidence.length === 1 ? "" : "s"}`,
        );
        if (automation) {
          if (verificationMode) {
            lines.push(
              `    - Repository verification: ${formatVerificationMode(verificationMode)}; product E2E mapping is not applicable.`,
            );
          } else {
            lines.push(
              `    - E2E draft mapping: ${formatScenarioAutomationStatus(automation.status)} ` +
                `(steps ${automation.mappedSteps}/${automation.totalSteps}; assertions ${automation.mappedAssertions}/${automation.totalAssertions})`,
            );
            for (const blocker of automation.blockers.slice(0, 2)) {
              lines.push(`      - Blocker: ${escapeMarkdownInline(blocker)}`);
            }
          }
        }
        for (const source of strongestEvidence(scenario.evidence, 3)) {
          lines.push(
            `    - Source: ${formatEvidenceReference(source)}: ${escapeMarkdownInline(source.value)}`,
          );
        }
        for (const assertion of scenario.assertions.slice(0, 2)) {
          lines.push(`    - Assert: ${escapeMarkdownInline(assertion)}`);
        }
      }
    }
    lines.push("");
  }
}

function formatScenarioAutomationStatus(status: E2eScenarioAutomationReceipt["status"]): string {
  if (status === "compiled") return "fully mapped (not executed)";
  if (status === "partial") return "partially mapped (not executed)";
  if (status === "not-compiled") return "not mapped";
  return "review only";
}

function findScenarioAutomation(
  result: QaDraftResult,
  scenarioId: string,
): E2eScenarioAutomationReceipt | undefined {
  return aggregateScenarioAutomationById(result.flows).get(scenarioId)?.receipt;
}

function verificationModeForScenario(
  flows: QaDraftFlow[],
  scenarioId: string,
): QaVerificationMode | undefined {
  const matched = flows.find((flow) =>
    flow.verificationMode && flow.scenarioAutomation.some((receipt) => receipt.scenarioId === scenarioId)
  );
  if (matched?.verificationMode) {
    return matched.verificationMode;
  }
  return flows.length === 1 ? flows[0]?.verificationMode : undefined;
}

interface QaScenarioAutomationAggregate {
  receipt: E2eScenarioAutomationReceipt;
  flowCount: number;
  compiledFlowCount: number;
}

function aggregateScenarioAutomationById(
  flows: QaDraftFlow[],
): Map<string, QaScenarioAutomationAggregate> {
  const grouped = new Map<string, E2eScenarioAutomationReceipt[]>();
  for (const flow of flows) {
    for (const receipt of flow.scenarioAutomation) {
      const current = grouped.get(receipt.scenarioId) ?? [];
      current.push(receipt);
      grouped.set(receipt.scenarioId, current);
    }
  }

  return new Map([...grouped.entries()].map(([scenarioId, receipts]) => {
    const first = receipts[0];
    const compiledFlowCount = receipts.filter((receipt) => receipt.status === "compiled").length;
    const mappedSteps = receipts.reduce((sum, receipt) => sum + receipt.mappedSteps, 0);
    const mappedAssertions = receipts.reduce((sum, receipt) => sum + receipt.mappedAssertions, 0);
    const status: E2eScenarioAutomationReceipt["status"] = compiledFlowCount === receipts.length
      ? "compiled"
      : receipts.every((receipt) => receipt.status === "review-only")
        ? "review-only"
        : mappedSteps > 0 || mappedAssertions > 0
          ? "partial"
          : "not-compiled";
    const decision = receipts.some((receipt) => receipt.decision === "required")
      ? "required"
      : receipts.some((receipt) => receipt.decision === "recommended")
        ? "recommended"
        : "review-only";
    const flowGap = compiledFlowCount < receipts.length
      ? `${compiledFlowCount} of ${receipts.length} affected flow drafts fully map this scenario.`
      : undefined;
    const receipt: E2eScenarioAutomationReceipt = {
      ...first,
      scenarioId,
      decision,
      status,
      requiredSourceCount: receipts.reduce((sum, item) => sum + item.requiredSourceCount, 0),
      referenceSourceCount: receipts.reduce((sum, item) => sum + item.referenceSourceCount, 0),
      totalSteps: receipts.reduce((sum, item) => sum + item.totalSteps, 0),
      totalAssertions: receipts.reduce((sum, item) => sum + item.totalAssertions, 0),
      mappedSteps,
      mappedAssertions,
      blockers: uniqueStrings([
        ...(flowGap ? [flowGap] : []),
        ...receipts.flatMap((item) => item.blockers),
      ]),
    };
    return [scenarioId, { receipt, flowCount: receipts.length, compiledFlowCount }];
  }));
}

function formatEvidenceReference(evidence: ChangeIntentEvidence): string {
  if (evidence.commit) {
    return `commit \`${evidence.commit.slice(0, 12)}\``;
  }
  const lineRange = evidence.startLine === undefined
    ? ""
    : evidence.endLine !== undefined && evidence.endLine !== evidence.startLine
      ? `:${evidence.startLine}-${evidence.endLine}`
      : `:${evidence.startLine}`;
  const location = evidence.file ? `\`${escapeMarkdownInline(evidence.file)}${lineRange}\`` : evidence.kind;
  const symbol = evidence.symbol ? ` symbol \`${escapeMarkdownInline(evidence.symbol)}\`` : "";
  const qualifiers = [evidence.sourceRole, evidence.relation, evidence.side].filter(Boolean).join(", ");
  return `${location}${symbol}${qualifiers ? ` [${qualifiers}]` : ""}`;
}

function formatPlainEvidenceReference(evidence: ChangeIntentEvidence): string {
  if (evidence.commit) {
    return `commit ${evidence.commit.slice(0, 12)}`;
  }
  const lineRange = evidence.startLine === undefined
    ? ""
    : evidence.endLine !== undefined && evidence.endLine !== evidence.startLine
      ? `:${evidence.startLine}-${evidence.endLine}`
      : `:${evidence.startLine}`;
  const location = evidence.file ? `${plainText(evidence.file)}${lineRange}` : evidence.kind;
  const symbol = evidence.symbol ? ` (${plainText(evidence.symbol)})` : "";
  return `${location}${symbol}`;
}

function summarizeIntentLifecycle(lifecycle: QaDraftResult["changeAnalysis"]["intents"][number]["lifecycle"]): string {
  const start = lifecycle.find((stage) => stage.kind === "trigger")
    ?? lifecycle.find((stage) => stage.kind === "action");
  const selected = [
    start,
    ...["condition", "state-change", "side-effect", "observable-outcome"]
      .map((phase) => lifecycle.find((stage) => stage.kind === phase)),
  ]
    .filter((stage): stage is NonNullable<typeof stage> => Boolean(stage));
  const fallback = selected.length > 0 ? selected : lifecycle.slice(0, 5);
  return fallback.map((stage) => `${stage.kind}: ${stage.label}`).join(" -> ");
}

function nextStepCommand(result: QaDraftResult): string | undefined {
  return result.route.command;
}

function supplementalValidationCommand(result: QaDraftResult): string | undefined {
  if (result.route.command) {
    return undefined;
  }
  return result.suggestedCommands[0];
}

function formatRepositoryVerificationStage(result: QaDraftResult, command?: string): string {
  if (result.readiness.verificationStatus === "ready-to-run" && command) {
    return `ready to run \`${escapeMarkdownInline(command)}\`; QAMap has not executed it`;
  }
  return "validation command needed; QAMap found the verification target but no repository command";
}

function atAGlanceEvidence(flow: QaDraftFlow): string[] {
  const stableSelector = flow.selectorHints.find((selector) =>
    /^(?:web-test-id|test-id|input-web-test-id|input-test-id|accessibility-label|role-button):/i.test(selector)
  ) ?? flow.selectorHints[0];
  const evidence = [
    flow.changedFiles[0] ? `changed file ${flow.changedFiles[0]}` : undefined,
    flow.entrypointHints[0],
    stableSelector,
  ].filter((value): value is string => Boolean(value));
  return uniqueStrings(evidence).slice(0, 3);
}

function qaFlowFromDraftFile(file: E2eDraftFile): QaDraftFlow {
  const verificationMode = verificationModeForDraftFile(file);
  const knowledge = qaFlowKnowledge(file, verificationMode);
  return {
    title: file.flowTitle,
    source: formatDraftSource(file.source),
    draftPath: file.path,
    runnableStatus: file.runnableStatus,
    promotionStatus: file.promotionStatus,
    changedFiles: file.changedFiles ?? [],
    userJourney: file.languageBrief,
    draftSteps: file.draftSteps ?? [],
    coverageTargets: file.coverageTargets ?? [],
    entrypointHints: file.entrypointHints ?? [],
    selectorHints: file.selectorHints ?? [],
    existingEvidencePaths: isChangedTestEvidenceTitle(file.flowTitle)
      ? (file.changedFiles ?? [])
      : (file.coverageEvidencePaths ?? []),
    verificationMode,
    setupHints: file.setupHints ?? [],
    manifestUpdatePath: file.manifestUpdatePath,
    scenarioAutomation: file.scenarioAutomation ?? [],
    why: buildFlowReasons(file),
    ...knowledge,
  };
}

function qaFlowFromChangedTestContracts(
  contracts: ChangedTestContract[],
): QaDraftFlow {
  const files = uniqueStrings(contracts.map((contract) => contract.file));
  const primaryContract = contracts[0];
  return {
    title: "Changed repository test contracts",
    source: "repository test contracts",
    draftPath: primaryContract?.file ?? "repository test suite",
    changedFiles: files,
    userJourney: {
      actor: "Maintainer or test author",
      trigger: "Run the tests changed by this branch.",
      goal: "Verify the repository-authored behavior contracts before merge.",
      successSignal: "Every changed test contract completes through the repository's own test command.",
      reviewQuestion: "Do the changed repository tests describe and protect the intended behavior?",
      edgeCases: [],
    },
    draftSteps: files.map((file) => `Run ${file}.`),
    coverageTargets: contracts.slice(0, 8).map((contract) => contract.title),
    entrypointHints: [],
    selectorHints: [],
    existingEvidencePaths: files,
    verificationMode: "existing-test-evidence",
    setupHints: [],
    scenarioAutomation: [],
    why: [
      "Changed tests declare repository behavior, but QAMap found no trustworthy product journey to invent.",
    ],
    authority: "repository-contract",
    approvalRequired: true,
    testClass: "regression",
  };
}

function qaFlowKnowledge(
  file: E2eDraftFile,
  verificationMode: QaVerificationMode | undefined,
): Pick<QaDraftFlow, "authority" | "approvalRequired" | "testClass"> {
  if (file.source === "verification-manifest" || file.source === "core-flow") {
    return {
      authority: "team-policy",
      approvalRequired: false,
      testClass: "golden",
    };
  }
  if (verificationMode === "existing-test-evidence") {
    return {
      authority: "repository-contract",
      approvalRequired: true,
      testClass: "regression",
    };
  }
  return {
    authority: "qamap-inference",
    approvalRequired: true,
    testClass: "regression",
  };
}

function preferChangedTestEvidence(
  flows: QaDraftFlow[],
  changedTestContracts: ChangedTestContract[],
  excludedTestFiles: ReadonlySet<string> = new Set(),
): QaDraftFlow[] {
  if (changedTestContracts.length === 0 && excludedTestFiles.size === 0) {
    return flows;
  }
  const changedContractFiles = new Set(changedTestContracts.map((contract) => contract.file));

  return flows.map((flow) => {
    if (flow.verificationMode === "existing-test-evidence") {
      return flow;
    }
    const scored = changedTestContracts
      .map((contract) => ({
        contract,
        score: changedTestContractScore(flow, contract),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) =>
        right.score - left.score ||
        left.contract.file.localeCompare(right.contract.file) ||
        left.contract.line - right.contract.line
      );
    const strongestScore = scored[0]?.score ?? 0;
    const evidencePaths = uniqueStrings(
      scored
        .filter((candidate) => candidate.score >= Math.max(3, strongestScore - 2))
        .map((candidate) => candidate.contract.file),
    );
    const unchangedEvidencePaths = flow.existingEvidencePaths.filter(
      (file) => !changedContractFiles.has(file) && !excludedTestFiles.has(file),
    );
    return {
      ...flow,
      // A changed repository-authored contract is stronger evidence than a broad filename or keyword match.
      existingEvidencePaths: evidencePaths.length > 0
        ? evidencePaths
        : unchangedEvidencePaths,
    };
  });
}

function focusedCommandTargetsFile(command: string, file: string): boolean {
  if (!command.includes(file)) {
    return false;
  }
  return /--runTestsByPath\b|(?:^|\s)[^\s]+(?:test|spec)\.[cm]?[jt]sx?(?:\s|$)/i.test(command);
}

function changedTestContractScore(flow: QaDraftFlow, contract: ChangedTestContract): number {
  const flowOwners = qaFeatureOwners(flow.changedFiles.slice(0, 3));
  const contractOwners = qaFeatureOwners([contract.file]);
  if (
    flowOwners.length > 0 &&
    contractOwners.length > 0 &&
    !flowOwners.some((owner) => contractOwners.includes(owner))
  ) {
    return 0;
  }
  const flowTitleTokens = qaEvidenceTokens(flow.title);
  const flowFileTokens = qaEvidenceTokens(flow.changedFiles.slice(0, 3).join("\n"));
  const flowTokens = new Set([...flowTitleTokens, ...flowFileTokens]);
  const contractTitleTokens = qaEvidenceTokens(contract.title);
  const contractFileTokens = qaEvidenceTokens(contract.file);
  const contractTokens = new Set([...contractTitleTokens, ...contractFileTokens]);
  const shared = [...flowTokens].filter((token) => contractTokens.has(token));
  if (shared.length === 0) {
    return 0;
  }

  const titleOverlap = flowTitleTokens.filter((token) => contractTitleTokens.includes(token)).length;
  const fileOverlap = flowFileTokens.filter((token) => contractTokens.has(token)).length;
  return shared.length * 3 + titleOverlap * 2 + fileOverlap * 2;
}

function qaFeatureOwners(files: string[]): string[] {
  return uniqueStrings(
    files.flatMap((file) =>
      [...file.matchAll(/(?:^|\/)(?:features?|domains?|modules?)\/([^/]+)/gi)]
        .map((match) => normalizeQaFeatureOwner(match[1]))
        .filter((owner): owner is string => Boolean(owner))
    ),
  );
}

function normalizeQaFeatureOwner(owner: string | undefined): string | undefined {
  if (!owner) {
    return undefined;
  }
  return owner
    .toLowerCase()
    .replace(/\.(?:test|spec|e2e|cy)\.[cm]?[jt]sx?$/i, "")
    .replace(/\.[cm]?[jt]sx?$/i, "")
    .replace(/\.(?:vue|svelte|py)$/i, "");
}

function qaEvidenceTokens(value: string): string[] {
  const ignored = new Set([
    "assert",
    "assertion",
    "app",
    "behavior",
    "changed",
    "check",
    "checklist",
    "cli",
    "command",
    "component",
    "components",
    "contract",
    "draft",
    "evidence",
    "existing",
    "expected",
    "feature",
    "features",
    "file",
    "flow",
    "input",
    "invalid",
    "javascript",
    "jsx",
    "json",
    "keeps",
    "manifest",
    "native",
    "output",
    "page",
    "pages",
    "path",
    "primary",
    "qamap",
    "related",
    "repository",
    "result",
    "route",
    "routes",
    "run",
    "screen",
    "screens",
    "shared",
    "spec",
    "specs",
    "src",
    "success",
    "test",
    "tests",
    "tsx",
    "typescript",
    "valid",
    "verification",
    "yaml",
  ]);
  return uniqueStrings(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-zA-Z0-9]+/)
      .map((part) => part.toLowerCase())
      .map((part) => part.length > 4 && part.endsWith("s") ? part.slice(0, -1) : part)
      .filter((part) => (part.length > 2 || part === "qa" || part === "e2e") && !ignored.has(part)),
  );
}

function buildFlowReasons(file: E2eDraftFile): string[] {
  const verificationMode = verificationModeForDraftFile(file);
  if (verificationMode === "command-contract") {
    return ["CLI behavior changed; verify arguments, output, side effects, and exit codes instead of inventing a product journey."];
  }
  if (verificationMode === "analysis-rule") {
    return ["Analyzer rules changed; verify positive, negative, and neighboring-rule controls instead of inventing a product journey."];
  }
  if (verificationMode === "schema-graph") {
    return ["The changed migration dependency diverges from the target branch graph; restore one leaf and validate the deployment order instead of inventing a product journey."];
  }
  if (verificationMode === "existing-test-evidence") {
    return ["Changed test files are existing QA evidence; run them instead of generating a duplicate draft."];
  }
  if (verificationMode === "configuration") {
    return ["Only build or runtime configuration changed; verify affected variants instead of inventing a product journey."];
  }
  if (verificationMode === "documentation") {
    return ["Documentation changed without a runtime product surface; validate the documented contract against repository behavior."];
  }
  if (verificationMode === "generated-artifact") {
    return ["Generated output changed; reproduce and validate the artifact instead of inventing a product journey."];
  }
  return [
    file.promotionReason,
    file.primaryEntrypoint ? `Primary entrypoint inferred as ${file.primaryEntrypoint}.` : undefined,
    file.coverageTargetCount ? `${file.coverageTargetCount} coverage target${file.coverageTargetCount === 1 ? "" : "s"} were selected for this flow.` : undefined,
    file.inferredSelectorCount ? `${file.inferredSelectorCount} selector hint${file.inferredSelectorCount === 1 ? "" : "s"} were detected.` : undefined,
  ].filter((value): value is string => Boolean(value));
}

function buildMissingEvidence(files: E2eDraftFile[]): QaDraftMissingEvidence[] {
  const evidence: QaDraftMissingEvidence[] = [];
  for (const file of files) {
    for (const item of file.actionItems ?? []) {
      if (item.kind === "runner" || item.kind === "validation") {
        continue;
      }
      evidence.push(missingEvidenceFromAction(file, item));
    }
  }
  const unique = uniqueMissingEvidence(evidence);
  const required = unique.filter((item) => item.priority === "required");
  const recommended = unique.filter((item) => item.priority !== "required");
  return [...required, ...recommended].slice(0, 12);
}

function runtimePrerequisiteMissingEvidence(
  gap: QaRuntimePrerequisiteTestGap,
): QaDraftMissingEvidence {
  const wrapper = gap.wrapperFile ? ` through ${gap.wrapperFile}` : " through the production wrapper";
  return {
    flowTitle: `${gap.routeFile} runtime prerequisite`,
    priority: "required",
    kind: "validation",
    title: "Exercise the real runtime prerequisite",
    detail:
      `${gap.testFile} mocks ${gap.consumerFile}, so it cannot prove the route receives its required context. ` +
      `Render ${gap.routeFile}${wrapper} with the real consumer before merge.`,
  };
}

function missingEvidenceFromAction(file: E2eDraftFile, item: E2eDraftActionItem): QaDraftMissingEvidence {
  return {
    flowTitle: file.flowTitle,
    priority: item.priority,
    kind: item.kind,
    title: item.title,
    detail: item.detail,
  };
}

function uniqueMissingEvidence(items: QaDraftMissingEvidence[]): QaDraftMissingEvidence[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.flowTitle}:${item.priority}:${item.kind}:${item.title}:${item.detail}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildPrChecklist(
  draft: E2eDraftResult,
  flows: QaDraftFlow[],
  changedTestContracts: ChangedTestContract[],
  suggestedCommands: string[],
  runtimePrerequisiteTestGaps: QaRuntimePrerequisiteTestGap[] = [],
): string[] {
  const changedEvidencePaths = uniqueStrings(changedTestContracts.map((contract) => contract.file));
  const testEvidencePaths = changedEvidencePaths.length > 0
    ? changedEvidencePaths
    : flows[0]?.existingEvidencePaths ?? [];
  const testEvidenceLabel = changedEvidencePaths.length > 0 || flows[0]?.verificationMode === "existing-test-evidence"
    ? "changed test evidence"
    : "related test evidence";
  const evidenceChecklist = testEvidencePaths.length
      ? `Run the ${testEvidenceLabel}: ${testEvidencePaths.slice(0, 4).join(", ")}.`
      : flows[0]?.verificationMode
        ? suggestedCommands[0]
          ? `Run ${formatVerificationMode(flows[0].verificationMode)} with ${suggestedCommands[0]}.`
          : `Define a repository-owned command for ${formatVerificationMode(flows[0].verificationMode)} before merge.`
      : draft.plan.changeAnalysis.intents[0]
        ? `Review the proposed QA scenarios and their sources for: ${draft.plan.changeAnalysis.intents[0].title}.`
      : flows.length > 0
        ? `Review the affected-flow evidence for: ${flows.map((flow) => flow.title).slice(0, 3).join(", ")}.`
      : "Run QAMap again after adding branch or working tree changes.";
  const runtimePrerequisiteChecklist = runtimePrerequisiteTestGaps.map((gap) =>
    `Render ${gap.routeFile} through ${gap.wrapperFile ?? "the production wrapper"} with ` +
    `${gap.consumerFile} unmocked; ${gap.testFile} does not exercise that provider path.`
  );
  const checklist = [
    ...runtimePrerequisiteChecklist,
    changedTestContracts.length > 0
      ? `Confirm the changed repository test contracts: ${changedTestContracts.slice(0, 3).map((contract) => contract.title).join("; ")}.`
      : evidenceChecklist,
    changedTestContracts.length > 0 ? evidenceChecklist : undefined,
    flows[0]?.userJourney?.reviewQuestion
      ? `Answer the reviewer question: ${flows[0].userJourney.reviewQuestion}`
      : "Name the user-visible behavior or contract this PR can break.",
  ].filter((item): item is string => Boolean(item));

  const validationCommand = suggestedCommands.find((command) => /\b(?:e2e|test|playwright|maestro)\b/i.test(command))
    ?? suggestedCommands[0];
  if (validationCommand) {
    checklist.push(`Run local validation: ${validationCommand}`);
  }
  if (!draft.plan.verificationManifestPath && flows.some((flow) => !flow.verificationMode)) {
    checklist.push("If this recommendation is useful, run `qamap manifest init .` later and review the generated manifest as team QA memory.");
  }

  return uniqueStrings(checklist).slice(0, 8);
}

function buildAgentHandoff(
  draft: E2eDraftResult,
  flows: QaDraftFlow[],
  changedTestContracts: ChangedTestContract[],
  missingEvidence: QaDraftMissingEvidence[],
  suggestedCommands: string[],
): string[] {
  const changedEvidencePaths = uniqueStrings(changedTestContracts.map((contract) => contract.file));
  const testEvidencePaths = changedEvidencePaths.length > 0
    ? changedEvidencePaths
    : flows[0]?.existingEvidencePaths ?? [];
  const testEvidenceLabel = changedEvidencePaths.length > 0 || flows[0]?.verificationMode === "existing-test-evidence"
    ? "changed test evidence"
    : "related test evidence";
  const handoff = [
    "Use this as a local PR QA skill result, not as proof that browser or device QA already passed.",
    draft.dryRun ? "No files were written because this command previews QA work only." : undefined,
    testEvidencePaths.length
      ? `Run the ${testEvidenceLabel} (${testEvidencePaths.slice(0, 3).join(", ")}) and record the result before handoff.`
      : flows[0]?.verificationMode
        ? suggestedCommands[0]
          ? `Run ${formatVerificationMode(flows[0].verificationMode)} with ${suggestedCommands[0]} and record the result before handoff; do not invent a product-journey E2E for this diff alone.`
          : `Define a repository-owned command for ${formatVerificationMode(flows[0].verificationMode)} before handoff; do not invent a command or product-journey E2E for this diff alone.`
      : draft.plan.changeAnalysis.intents[0]
        ? `Review each proposed scenario and its diff sources for ${draft.plan.changeAnalysis.intents[0].title} before using it as PR policy.`
      : flows.length > 0
        ? `Review the affected-flow evidence for ${flows[0].title} before using it as PR policy.`
        : undefined,
    missingEvidence.length > 0
      ? "Treat selector, fixture, runner, and draft-mapping gaps as optional automation work; they do not replace review of the QA reasoning."
      : undefined,
    changedTestContracts.length > 0
      ? `Preserve these repository-authored QA contracts when editing or generating tests: ${changedTestContracts.slice(0, 3).map((contract) => contract.title).join("; ")}.`
      : undefined,
    flows.some((flow) => !flow.verificationMode)
      ? "A wrong flow recommendation should become a manifest correction, so future PRs improve without another prompt."
      : undefined,
  ].filter((value): value is string => Boolean(value));
  return uniqueStrings(handoff);
}

function isChangedTestEvidenceTitle(title: string): boolean {
  return /^Changed test evidence verification checklist$/i.test(title.trim());
}

function verificationModeForTitle(title: string): QaVerificationMode | undefined {
  if (/\bCLI command verification checklist$/i.test(title.trim())) {
    return "command-contract";
  }
  if (/^Static analysis rule\b/i.test(title.trim())) {
    return "analysis-rule";
  }
  if (/\btransformation contract\b/i.test(title.trim())) {
    return "transformation-contract";
  }
  if (isChangedTestEvidenceTitle(title)) {
    return "existing-test-evidence";
  }
  if (/\bconfiguration verification\b/i.test(title)) {
    return "configuration";
  }
  if (/\bdocumentation verification\b/i.test(title)) {
    return "documentation";
  }
  if (/\bgenerated artifact verification\b/i.test(title)) {
    return "generated-artifact";
  }
  return undefined;
}

function verificationModeForDraftFile(file: E2eDraftFile): QaVerificationMode | undefined {
  if (file.flowKind === "schema") {
    return "schema-graph";
  }
  if (file.flowKind === "transformation") {
    return "transformation-contract";
  }
  const scenarioSourceRoles = (file.qaScenarios ?? [])
    .flatMap((scenario) => scenario.evidence)
    .map((source) => source.sourceRole)
    .filter((role): role is NonNullable<typeof role> => Boolean(role));
  if (scenarioSourceRoles.length > 0 && scenarioSourceRoles.every((role) => role === "command")) {
    return "command-contract";
  }
  if (file.qaScenarios?.some((scenario) => /analysis rule positive and negative controls/i.test(scenario.title))) {
    return "analysis-rule";
  }
  return verificationModeForTitle(file.flowTitle);
}

function needsGeneratedDraft(result: QaDraftResult): boolean {
  return result.readiness.basis !== "repository-validation" &&
    result.readiness.automationApplicable !== false &&
    result.flows.some((flow) => !flow.verificationMode);
}

function formatVerificationMode(mode: QaVerificationMode): string {
  if (mode === "command-contract") {
    return "CLI command contract verification";
  }
  if (mode === "analysis-rule") {
    return "analyzer rule boundary verification";
  }
  if (mode === "schema-graph") {
    return "migration graph and deployment-order verification";
  }
  if (mode === "transformation-contract") {
    return "input-to-output transformation contract verification";
  }
  if (mode === "existing-test-evidence") {
    return "the changed test evidence";
  }
  if (mode === "configuration") {
    return "build and configuration verification";
  }
  if (mode === "documentation") {
    return "documentation contract verification";
  }
  return "generated artifact verification";
}

function isMigrationGraphValidationCommand(command: string): boolean {
  return /\bmanage\.py\s+(?:makemigrations\b[^\n]*(?:--check|--dry-run)|showmigrations\b[^\n]*--plan|migrate\b[^\n]*--plan)/i.test(command) ||
    /\b(?:migration|migrations)(?::|[-_])(?:check|plan|validate)\b/i.test(command) ||
    /\b(?:check|validate)(?::|[-_])(?:migration|migrations)\b/i.test(command);
}

function fallbackDraftSteps(flow: QaDraftFlow): string[] {
  if (!flow.userJourney) {
    return ["Review the changed files and create the smallest QA path that proves the changed behavior."];
  }
  return [
    flow.userJourney.trigger,
    flow.userJourney.goal,
    // An unresolved success signal is a statement about missing evidence, not
    // an assertable outcome — asking to assert it would recreate the tautology.
    flow.userJourney.successSignalUnresolved
      ? "Define the observable success signal for this flow, then assert it."
      : `Assert ${flow.userJourney.successSignal}.`,
  ];
}

function formatDraftSource(source: E2eDraftFile["source"]): string {
  if (source === "verification-manifest") {
    return "manifest-backed";
  }
  if (source === "domain-language") {
    return "domain-language";
  }
  if (source === "change-intent") {
    return "commit-and-diff-intent";
  }
  if (source === "core-flow") {
    return "core-flow";
  }
  return "repo-signals";
}

function formatRunnableStatus(status: E2eDraftFile["runnableStatus"]): string {
  if (status === "runnable-candidate") {
    return "static-runnable candidate; not executed";
  }
  if (status === "near-runnable") {
    return "partially mapped; not executed";
  }
  return "review only";
}

function formatProjectType(type: E2eProjectType): string {
  if (type === "expo-react-native") {
    return "Expo / React Native";
  }
  if (type === "react-native") {
    return "React Native";
  }
  if (type === "web") {
    return "Web";
  }
  if (type === "api-service") {
    return "API / service";
  }
  if (type === "design-tokens") {
    return "Design tokens";
  }
  if (type === "data-catalog") {
    return "Data catalog";
  }
  if (type === "cli") {
    return "CLI";
  }
  return "Unknown";
}

function formatRunnerName(runner: E2eRunnerName): string {
  if (runner === "maestro") {
    return "Maestro";
  }
  if (runner === "playwright") {
    return "Playwright";
  }
  return "Manual";
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}

function plainText(value: string): string {
  return value.replaceAll("`", "'").replace(/\s+/g, " ").trim();
}
