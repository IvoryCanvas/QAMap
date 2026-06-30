import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { buildDomainLanguageSummary } from "./domain-language.js";
import { defaultDomainManifestPath, loadDomainManifest, matchDomains } from "./domains.js";
import { collectProjectFiles } from "./fs.js";
import { loadCoreFlowManifest, matchCoreFlows } from "./flows.js";
import {
  collectTestSuiteInventory,
  evaluateFlowCoverageEvidence,
  summarizeTestSuiteInventory,
} from "./test-evidence.js";
import { generateTestPlan } from "./test-plan.js";
import type { TestPlanChangedFile, TestPlanOptions, TestPlanResult } from "./test-plan.js";
import type { DomainLanguageSummary, DomainScenarioSuggestion } from "./domain-language.js";
import type { MatchedDomain } from "./domains.js";
import type { MatchedCoreFlow } from "./flows.js";
import type { LocalHistoryReference } from "./history.js";
import type { CoverageEvidence, TestSuiteInventory, TestSuiteSummary } from "./test-evidence.js";
import { TOOL_NAME, VERSION } from "./version.js";

export type E2eProjectType = "expo-react-native" | "react-native" | "web" | "api-service" | "unknown";
export type E2eRunnerName = "maestro" | "playwright" | "manual";
export type E2eEntrypointKind = "route" | "screen" | "command";
export type E2eEntrypointConfidence = "high" | "medium" | "low";
export type E2eSetupHintKind = "auth" | "network" | "fixture" | "environment" | "payment" | "state";
export type E2eSetupHintConfidence = "high" | "medium" | "low";
export type E2eExecutionProfileConfidence = "high" | "medium" | "low";
export type E2eFixtureReadinessStatus = "ready" | "partial" | "missing" | "not-needed";
export type E2eValidationMatrixStatus = "ready" | "partial" | "missing";
export type E2eValidationMatrixCategory = "core-flow" | "coverage" | "fixture" | "testability" | "setup";
export type E2eBootstrapStepStatus = "required" | "recommended" | "ready";
export type E2eBootstrapStepCategory =
  | "runner"
  | "draft"
  | "workspace"
  | "domain-language"
  | "core-flow"
  | "fixture"
  | "testability"
  | "validation"
  | "history";
export type E2eSelectorKind =
  | "test-id"
  | "accessibility-label"
  | "visible-text"
  | "web-test-id"
  | "aria-label"
  | "placeholder"
  | "role-button"
  | "role-link";

export interface E2ePlanOptions extends TestPlanOptions {
  runner?: E2eRunnerName;
}

export interface E2eDraftOptions extends E2ePlanOptions {
  output?: string;
  force?: boolean;
}

export interface E2eProjectProfile {
  type: E2eProjectType;
  evidence: string[];
}

export interface E2eRunnerRecommendation {
  name: E2eRunnerName;
  reason: string;
}

export interface E2eExecutionProfile {
  runner: E2eRunnerName;
  confidence: E2eExecutionProfileConfidence;
  startCommand?: string;
  testCommand?: string;
  baseUrl?: string;
  appId?: string;
  configFiles: string[];
  envFiles: string[];
  evidence: string[];
  blockers: string[];
}

export interface E2eWorkspaceTarget {
  path: string;
  packageName?: string;
  project: E2eProjectProfile;
  recommendedRunner: E2eRunnerRecommendation;
  changedFiles: string[];
  reason: string;
  suggestedCommand: string;
}

export type E2eCoveragePriority = "critical" | "recommended" | "optional";

export interface E2eCoverageTarget {
  title: string;
  priority: E2eCoveragePriority;
  reason: string;
  checks: string[];
}

export interface E2eFlowLanguageBrief {
  actor: string;
  trigger: string;
  goal: string;
  successSignal: string;
  reviewQuestion: string;
  edgeCases: string[];
}

export interface E2eFlow {
  title: string;
  reason: string;
  files: string[];
  steps: string[];
  languageBrief: E2eFlowLanguageBrief;
  coverage: E2eCoverageTarget[];
  coverageEvidence: CoverageEvidence[];
  entrypoints: E2eEntrypoint[];
  setupHints: E2eSetupHint[];
  fixtureReadiness: E2eFixtureReadiness;
  selectors: E2eSelector[];
  missingTestability: string[];
}

export interface E2eEntrypoint {
  kind: E2eEntrypointKind;
  value: string;
  file: string;
  confidence: E2eEntrypointConfidence;
}

export interface E2eSetupHint {
  kind: E2eSetupHintKind;
  title: string;
  detail: string;
  files: string[];
  confidence: E2eSetupHintConfidence;
}

export interface E2eSelector {
  kind: E2eSelectorKind;
  value: string;
  file: string;
}

export interface E2eFixtureReadiness {
  status: E2eFixtureReadinessStatus;
  reason: string;
  apiSignals: string[];
  backendSignals: string[];
  mockSignals: string[];
  nextActions: string[];
}

export interface E2eValidationMatrixRow {
  area: string;
  category: E2eValidationMatrixCategory;
  requiredEvidence: string;
  currentEvidence: string;
  status: E2eValidationMatrixStatus;
  nextAction: string;
  flowTitle?: string;
  files: string[];
}

export interface E2eValidationMatrix {
  rows: E2eValidationMatrixRow[];
  summary: {
    ready: number;
    partial: number;
    missing: number;
  };
}

export interface E2eBootstrapStep {
  category: E2eBootstrapStepCategory;
  status: E2eBootstrapStepStatus;
  title: string;
  reason: string;
  action: string;
  commands: string[];
  files: string[];
}

export interface E2eBootstrapPlan {
  summary: string;
  steps: E2eBootstrapStep[];
  counts: {
    required: number;
    recommended: number;
    ready: number;
  };
}

export interface E2ePlanResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  workspaceRoot?: string;
  generatedAt: string;
  base: string;
  head: string;
  includeWorkingTree: boolean;
  project: E2eProjectProfile;
  recommendedRunner: E2eRunnerRecommendation;
  executionProfile: E2eExecutionProfile;
  testSuite: TestSuiteSummary;
  coreFlowManifestPath?: string;
  coreFlows: MatchedCoreFlow[];
  domainManifestPath?: string;
  domains: MatchedDomain[];
  domainLanguage: DomainLanguageSummary;
  changedFiles: TestPlanChangedFile[];
  suggestedCommands: string[];
  localHistory?: LocalHistoryReference;
  workspaceTargets: E2eWorkspaceTarget[];
  flows: E2eFlow[];
  validationMatrix: E2eValidationMatrix;
  bootstrap: E2eBootstrapPlan;
  missingTestability: string[];
  setupNotes: string[];
}

export interface E2eDraftFile {
  path: string;
  flowTitle: string;
  runner: E2eRunnerName;
  status: "created" | "skipped";
  source?: "domain-language" | "core-flow" | "heuristic";
  languageBrief?: E2eFlowLanguageBrief;
  actionItems?: E2eDraftActionItem[];
  promotionStatus?: E2eDraftPromotionStatus;
  promotionReason?: string;
  promotionAction?: string;
  stability?: "ready" | "needs-selector" | "needs-setup" | "needs-selector-and-setup";
  runnableStatus?: "runnable-candidate" | "near-runnable" | "review-only";
  executionBlockers?: string[];
  selfCheck?: E2eDraftSelfCheck;
  todoCount?: number;
  entrypointCount?: number;
  primaryEntrypoint?: string;
  setupHintCount?: number;
  fixtureReadinessStatus?: E2eFixtureReadinessStatus;
  inferredSelectorCount?: number;
  coverageTargetCount?: number;
  validationStatus?: E2eValidationMatrixStatus;
  validationGapCount?: number;
  blockingValidationGapCount?: number;
  reason?: string;
}

export type E2eDraftActionKind = "assertion" | "fixture" | "manifest" | "runner" | "selector" | "setup" | "validation";
export type E2eDraftActionPriority = "required" | "recommended";

export type E2eDraftSelfCheckStatus = "pass" | "warning" | "fail";

export interface E2eDraftSelfCheckItem {
  name: string;
  status: E2eDraftSelfCheckStatus;
  detail: string;
}

export interface E2eDraftSelfCheck {
  status: E2eDraftSelfCheckStatus;
  summary: string;
  command?: string;
  checks: E2eDraftSelfCheckItem[];
  blockers: string[];
}

export interface E2eDraftActionItem {
  kind: E2eDraftActionKind;
  priority: E2eDraftActionPriority;
  title: string;
  detail: string;
}

export interface E2eDraftActionKindSummary {
  kind: E2eDraftActionKind;
  required: number;
  recommended: number;
  total: number;
}

export interface E2eDraftActionSummary {
  required: number;
  recommended: number;
  readyFiles: number;
  filesWithRequiredActions: number;
  filesWithRecommendedActions: number;
  byKind: E2eDraftActionKindSummary[];
}

export type E2eDraftPromotionStatus = "commit-candidate" | "needs-review" | "low-signal";

export interface E2eDraftResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  generatedAt: string;
  runner: E2eRunnerName;
  outputDirectory: string;
  plan: E2ePlanResult;
  files: E2eDraftFile[];
  actionSummary: E2eDraftActionSummary;
  nextSteps: string[];
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const maxFilesPerFlow = 8;
const workspacePackageSearchLimit = 200;
const workspacePackageIgnoredDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "vendor",
]);

export async function generateE2ePlan(rootInput: string, options: E2ePlanOptions = {}): Promise<E2ePlanResult> {
  const root = path.resolve(rootInput);
  const testPlan = await generateTestPlan(root, options);
  const project = await detectProjectProfile(root);
  const recommendedRunner = options.runner ? overrideRunner(project, options.runner) : recommendRunner(project);
  const executionProfile = await buildExecutionProfile(root, testPlan.workspaceRoot, project, recommendedRunner.name);
  const testSuiteInventory = await collectTestSuiteInventory(root);
  const coreFlowRoot = testPlan.workspaceRoot ?? root;
  const coreFlowManifest = await loadCoreFlowManifest(coreFlowRoot);
  const coreFlowChangedFiles = toCoreFlowChangedFiles(testPlan.changedFiles, root, coreFlowRoot);
  const coreFlows = matchCoreFlows(coreFlowManifest, coreFlowChangedFiles);
  const domainManifest = await loadDomainManifest(coreFlowRoot);
  const domains = matchDomains(domainManifest, coreFlowChangedFiles);
  const domainLanguage = await buildDomainLanguageSummary(root, testPlan.changedFiles, coreFlows, domains);
  const workspaceTargets = await buildWorkspaceTargets(root, testPlan);
  const flows = await buildFlows(
    root,
    testPlan.changedFiles,
    recommendedRunner.name,
    project.type,
    testSuiteInventory,
    domainLanguage,
  );
  const testSuite = summarizeTestSuiteInventory(testSuiteInventory);
  const missingTestability = uniqueStrings([
    ...flows.flatMap((flow) => flow.missingTestability),
    ...(await buildGlobalTestabilityGaps(root, recommendedRunner.name)),
  ]);
  const validationMatrix = buildE2eValidationMatrix(flows, coreFlows);
  const setupNotes = await buildSetupNotes(root, recommendedRunner.name, project);
  const bootstrap = buildE2eBootstrapPlan({
    base: testPlan.base,
    head: testPlan.head,
    projectType: project.type,
    recommendedRunner,
    executionProfile,
    testSuite,
    coreFlowManifestPath: coreFlowManifest.path,
    domainManifestPath: domainManifest.path,
    coreFlows,
    domains,
    domainLanguage,
    workspaceTargets,
    flows,
    validationMatrix,
    missingTestability,
    suggestedCommands: testPlan.suggestedCommands,
  });

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root: testPlan.root,
    workspaceRoot: testPlan.workspaceRoot,
    generatedAt: new Date().toISOString(),
    base: testPlan.base,
    head: testPlan.head,
    includeWorkingTree: testPlan.includeWorkingTree,
    project,
    recommendedRunner,
    executionProfile,
    testSuite,
    coreFlowManifestPath: coreFlowManifest.path,
    coreFlows,
    domainManifestPath: domainManifest.path,
    domains,
    domainLanguage,
    changedFiles: testPlan.changedFiles,
    suggestedCommands: testPlan.suggestedCommands,
    workspaceTargets,
    flows,
    validationMatrix,
    bootstrap,
    missingTestability,
    setupNotes,
  };
}

export async function generateE2eDraft(rootInput: string, options: E2eDraftOptions = {}): Promise<E2eDraftResult> {
  const root = path.resolve(rootInput);
  const plan = await generateE2ePlan(root, options);
  const runner = plan.recommendedRunner.name;
  const outputDirectory = path.resolve(root, options.output ?? defaultDraftOutputDirectory(runner));
  const flows = await buildDraftFlows(plan);

  await fs.mkdir(outputDirectory, { recursive: true });

  const files: E2eDraftFile[] = [];
  for (const flow of flows) {
    const filePath = path.join(outputDirectory, `${slugify(flow.title)}${draftExtension(runner)}`);
    const displayPath = toDisplayPath(root, filePath);
    const validationSummary = summarizeDraftValidation(flow);
    const promotionGuidance = buildDraftPromotionGuidance(flow);
    const shouldSkip = (await exists(filePath)) && !options.force;
    const content = shouldSkip ? ((await readTextIfExists(filePath)) ?? "") : draftContentForFlow(plan, flow, runner);
    const todoCount = countTodos(content);
    const selfCheck = evaluateDraftSelfCheck(plan, flow, runner, content, todoCount);
    const actionItems = buildDraftActionItems(plan, flow, runner, validationSummary, promotionGuidance, selfCheck);
    const executionBlockers = draftExecutionBlockers(plan, flow, runner, validationSummary, selfCheck);
    const runnableStatus = draftRunnableStatus(plan, flow, runner, validationSummary, executionBlockers, selfCheck);
    if (shouldSkip) {
      files.push({
        path: displayPath,
        flowTitle: flow.title,
        runner,
        status: "skipped",
        source: draftFlowSource(flow),
        languageBrief: flow.languageBrief,
        actionItems,
        promotionStatus: promotionGuidance.status,
        promotionReason: promotionGuidance.reason,
        promotionAction: promotionGuidance.action,
        stability: draftStability(plan, flow),
        runnableStatus,
        executionBlockers,
        selfCheck,
        todoCount,
        entrypointCount: flow.entrypoints.length,
        primaryEntrypoint: primaryEntrypointLabel(flow),
        setupHintCount: flow.setupHints.length,
        fixtureReadinessStatus: flow.fixtureReadiness.status,
        coverageTargetCount: flow.coverage.length,
        validationStatus: validationSummary.status,
        validationGapCount: validationSummary.gapCount,
        blockingValidationGapCount: validationSummary.blockingGapCount,
        reason: "File already exists. Pass --force to overwrite it.",
      });
      continue;
    }
    await fs.writeFile(filePath, content, "utf8");
    files.push({
      path: displayPath,
      flowTitle: flow.title,
      runner,
      status: "created",
      source: draftFlowSource(flow),
      languageBrief: flow.languageBrief,
      actionItems,
      promotionStatus: promotionGuidance.status,
      promotionReason: promotionGuidance.reason,
      promotionAction: promotionGuidance.action,
      stability: draftStability(plan, flow),
      runnableStatus,
      executionBlockers,
      selfCheck,
      todoCount,
      entrypointCount: flow.entrypoints.length,
      primaryEntrypoint: primaryEntrypointLabel(flow),
      setupHintCount: flow.setupHints.length,
      fixtureReadinessStatus: flow.fixtureReadiness.status,
      inferredSelectorCount: flow.selectors.length,
      coverageTargetCount: flow.coverage.length,
      validationStatus: validationSummary.status,
      validationGapCount: validationSummary.gapCount,
      blockingValidationGapCount: validationSummary.blockingGapCount,
    });
  }

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    generatedAt: new Date().toISOString(),
    runner,
    outputDirectory: toDisplayPath(root, outputDirectory),
    plan,
    files,
    actionSummary: summarizeDraftActionItems(files),
    nextSteps: buildDraftNextSteps(plan, runner),
  };
}

function buildCoverageTargets(kind: E2eFlowKind, files: string[], runner: E2eRunnerName): E2eCoverageTarget[] {
  const targets: E2eCoverageTarget[] = [
    coverageTarget(
      "Primary success path",
      "critical",
      "Every generated flow should prove that the changed behavior works for a realistic successful case.",
      [
        "Use production-like input or fixture data.",
        "Verify the final visible UI, response, event, navigation, or persisted result.",
      ],
    ),
  ];

  if (kind === "ui" || files.some(isUserFacingFile)) {
    targets.push(
      coverageTarget(
        "Loading, empty, error, and success states",
        "critical",
        "UI changes often regress non-happy-path states even when the primary action still works.",
        [
          "Open the affected surface while data is loading.",
          "Verify empty and error states use actionable copy and do not break layout.",
          "Verify the success state after the primary action completes.",
        ],
      ),
      coverageTarget(
        "Navigation and re-entry",
        "recommended",
        "Changed screens should remain stable after back navigation, deep link entry, refresh, or app resume.",
        [
          "Leave and re-enter the changed surface.",
          "Verify the selected tab, route, modal, drawer, or scroll position is intentional after re-entry.",
        ],
      ),
    );
  }

  if (kind === "api" || files.some(isApiLikeFile)) {
    targets.push(
      coverageTarget(
        "API contract compatibility",
        "critical",
        "API-related changes need more than UI smoke coverage because request and response contracts can break existing callers.",
        [
          "Verify required request parameters and headers.",
          "Verify response status, shape, parsing, and fallback handling.",
          "Check that existing callers remain backward compatible.",
        ],
      ),
      coverageTarget(
        "Network and server failure handling",
        "critical",
        "Timeouts, 4xx, and 5xx paths are common production failures that generated E2E drafts should make visible.",
        [
          "Simulate or force timeout, unauthorized, validation, and server-error responses.",
          "Verify retry, toast, inline error, logging, or recovery behavior.",
        ],
      ),
    );
  }

  if (kind === "state" || files.some(isStateLikeFile)) {
    targets.push(
      coverageTarget(
        "State transition boundaries",
        "critical",
        "State changes need coverage before, during, and after mutation so stale UI and cache bugs are caught.",
        [
          "Verify the initial state before the changed action.",
          "Verify the optimistic, pending, or intermediate state if one exists.",
          "Verify the final state after refresh, app restart, or re-entry.",
        ],
      ),
      coverageTarget(
        "Authorization and permission states",
        "recommended",
        "State, session, and provider changes frequently affect unauthorized or permission-denied behavior.",
        [
          "Check anonymous, expired-session, and permission-denied paths when reachable.",
          "Verify protected actions fail closed and recover cleanly after sign-in or permission grant.",
        ],
      ),
    );
  }

  if (kind === "content" || files.some(isContentOrStyleFile)) {
    targets.push(
      coverageTarget(
        "Viewport and visual variants",
        "recommended",
        "Copy, theme, and style changes can pass functionally while still breaking layout or readability.",
        [
          "Check the smallest supported viewport and the primary desktop or tablet viewport.",
          "Verify long copy, translated copy, focus state, disabled state, and high-contrast or dark mode when supported.",
        ],
      ),
      coverageTarget(
        "Locale and theme variants",
        "recommended",
        "Locale and theme changes should cover the variant switch, not only the default rendering path.",
        [
          "Run the changed surface with the default locale and at least one alternate locale when available.",
          "Run default theme and alternate theme when the project exposes theme switching.",
        ],
      ),
    );
  }

  if (kind === "config" || files.some(isConfigLikeFile)) {
    targets.push(
      coverageTarget(
        "Configuration variants",
        "critical",
        "Build, dependency, feature-flag, and environment changes should prove both enabled and fallback behavior.",
        [
          "Verify the changed flag, dependency, or environment value enabled.",
          "Verify fallback behavior when the value is absent, disabled, unknown, or using the previous default.",
        ],
      ),
      coverageTarget(
        "Clean install and runtime startup",
        "recommended",
        "Configuration changes often fail only from a clean checkout or clean process start.",
        [
          "Run install or dependency validation from a clean checkout when feasible.",
          "Start the app or service with the documented local command and verify no runtime config error appears.",
        ],
      ),
    );
  }

  if (kind === "domain" || kind === "changed-file") {
    targets.push(
      coverageTarget(
        "Invalid, blocked, or boundary input",
        "recommended",
        "Generic domain changes should still cover one realistic boundary case instead of only the happy path.",
        [
          "Exercise missing, invalid, duplicated, or unsupported input.",
          "Verify the user-visible or caller-visible failure is intentional.",
        ],
      ),
    );
  }

  if (runner === "playwright") {
    targets.push(
      coverageTarget(
        "Browser viewport regression",
        "optional",
        "Browser E2E drafts get more value when they cover at least one compact and one primary viewport.",
        ["Run the generated spec at the smallest supported viewport and the primary desktop viewport."],
      ),
    );
  }

  return uniqueCoverageTargets(targets).slice(0, 7);
}

function coverageTarget(
  title: string,
  priority: E2eCoveragePriority,
  reason: string,
  checks: string[],
): E2eCoverageTarget {
  return { title, priority, reason, checks };
}

function buildE2eValidationMatrix(
  flows: E2eFlow[],
  coreFlows: MatchedCoreFlow[],
): E2eValidationMatrix {
  const rows: E2eValidationMatrixRow[] = [];

  for (const coreFlow of coreFlows) {
    rows.push({
      area: coreFlow.name,
      category: "core-flow",
      requiredEvidence: coreFlow.checks.length > 0
        ? `Core flow checks: ${formatHumanList(coreFlow.checks.slice(0, 3))}.`
        : "Core flow should cover the primary success path and one realistic blocked or failure path.",
      currentEvidence: `Matched ${coreFlow.matchedFiles.length} changed file${coreFlow.matchedFiles.length === 1 ? "" : "s"}${coreFlow.routes.length > 0 ? ` and ${coreFlow.routes.length} declared route${coreFlow.routes.length === 1 ? "" : "s"}` : ""}.`,
      status: "partial",
      nextAction: "Make the matched core flow checks required validation evidence for this PR.",
      files: coreFlow.matchedFiles,
    });
  }

  for (const flow of flows) {
    for (const evidence of flow.coverageEvidence) {
      rows.push({
        area: `${flow.title}: ${evidence.targetTitle}`,
        category: "coverage",
        requiredEvidence: coverageTargetRequirement(flow, evidence.targetTitle),
        currentEvidence: coverageEvidenceSummary(evidence),
        status: validationStatusFromCoverageEvidence(evidence.status),
        nextAction: nextActionForCoverageEvidence(evidence),
        flowTitle: flow.title,
        files: evidence.files.length > 0 ? evidence.files : flow.files,
      });
    }

    if (flow.fixtureReadiness.status !== "not-needed") {
      rows.push({
        area: `${flow.title}: fixture/mock readiness`,
        category: "fixture",
        requiredEvidence: "Deterministic success, empty, unauthorized, timeout, or server-error responses for API-dependent UI flow.",
        currentEvidence: fixtureReadinessEvidenceSummary(flow.fixtureReadiness),
        status: validationStatusFromFixtureReadiness(flow.fixtureReadiness.status),
        nextAction: flow.fixtureReadiness.nextActions[0] ?? "Keep fixture evidence aligned with the changed flow.",
        flowTitle: flow.title,
        files: uniqueStrings([
          ...flow.fixtureReadiness.apiSignals,
          ...flow.fixtureReadiness.backendSignals,
          ...flow.fixtureReadiness.mockSignals,
          ...flow.files,
        ]).slice(0, maxFilesPerFlow),
      });
    }

    if (flow.setupHints.length > 0) {
      rows.push({
        area: `${flow.title}: setup readiness`,
        category: "setup",
        requiredEvidence: `Document and prepare ${formatHumanList(flow.setupHints.map((hint) => hint.title).slice(0, 3))}.`,
        currentEvidence: `${flow.setupHints.length} setup hint${flow.setupHints.length === 1 ? "" : "s"} detected.`,
        status: "partial",
        nextAction: "Turn setup hints into reusable fixtures, seed steps, env flags, or test identities before making the draft required.",
        flowTitle: flow.title,
        files: uniqueStrings(flow.setupHints.flatMap((hint) => hint.files)).slice(0, maxFilesPerFlow),
      });
    }

    rows.push({
      area: `${flow.title}: testability`,
      category: "testability",
      requiredEvidence: "Stable selectors, entrypoint hints, and no unresolved testability gaps.",
      currentEvidence: testabilityEvidenceSummary(flow),
      status: validationStatusFromTestability(flow),
      nextAction: nextActionForTestability(flow),
      flowTitle: flow.title,
      files: flow.missingTestability.length > 0 ? flow.files : flow.selectors.map((selector) => selector.file).slice(0, maxFilesPerFlow),
    });
  }

  const sortedRows = rows.sort(compareValidationMatrixRows);
  return {
    rows: sortedRows,
    summary: {
      ready: sortedRows.filter((row) => row.status === "ready").length,
      partial: sortedRows.filter((row) => row.status === "partial").length,
      missing: sortedRows.filter((row) => row.status === "missing").length,
    },
  };
}

interface E2eBootstrapPlanInput {
  base: string;
  head: string;
  projectType: E2eProjectType;
  recommendedRunner: E2eRunnerRecommendation;
  executionProfile: E2eExecutionProfile;
  testSuite: TestSuiteSummary;
  coreFlowManifestPath?: string;
  domainManifestPath?: string;
  coreFlows: MatchedCoreFlow[];
  domains: MatchedDomain[];
  domainLanguage: DomainLanguageSummary;
  workspaceTargets: E2eWorkspaceTarget[];
  flows: E2eFlow[];
  validationMatrix: E2eValidationMatrix;
  missingTestability: string[];
  suggestedCommands: string[];
}

function buildE2eBootstrapPlan(input: E2eBootstrapPlanInput): E2eBootstrapPlan {
  const steps: E2eBootstrapStep[] = [];
  const runnerGap = input.missingTestability.find((gap) => /No \.maestro|No Playwright config/i.test(gap));
  const draftCommand = `codeward e2e draft . --base ${input.base} --head ${input.head}`;
  const planHistoryCommand = `codeward e2e plan . --base ${input.base} --head ${input.head} --record-history`;
  const domainsSuggestCommand = `codeward domains suggest . --base ${input.base} --head ${input.head}`;
  const flowsSuggestCommand = `codeward flows suggest . --base ${input.base} --head ${input.head}`;
  const executionProfileBlockers = remainingExecutionProfileBlockers(input.executionProfile.blockers, runnerGap);

  if (input.workspaceTargets.length > 0) {
    const concreteTargets = input.workspaceTargets.filter((target) => target.project.type !== "unknown");
    steps.push(
      bootstrapStep(
        "workspace",
        concreteTargets.length > 0 ? "recommended" : "required",
        "Run package-scoped E2E plans for changed targets",
        concreteTargets.length > 0
          ? `${concreteTargets.length} changed workspace target${concreteTargets.length === 1 ? "" : "s"} have clearer app or service signals than the workspace root.`
          : "Changed files map to workspace packages, but their app surface still needs a package-scoped review.",
        "Run the suggested package-scoped plan commands, then generate drafts from the package whose changed flow is user-facing.",
        input.workspaceTargets.map((target) => target.suggestedCommand).slice(0, 4),
        input.workspaceTargets.flatMap((target) => target.changedFiles).slice(0, maxFilesPerFlow),
      ),
    );
  }

  if (input.recommendedRunner.name === "manual") {
    steps.push(
      bootstrapStep(
        "runner",
        "required",
        input.projectType === "api-service"
          ? "Start with API contract validation"
          : "Choose the first runnable E2E runner",
        input.projectType === "api-service"
          ? "CodeWard detected an API or backend service, so generated output should start as a contract checklist before assuming a browser or device runner."
          : "CodeWard could not detect a web, Expo, React Native, or API service surface, so generated output should start as a manual checklist.",
        input.projectType === "api-service"
          ? "Document the local service start command, base URL, auth fixture, and request examples before making API contract checks required in CI."
          : "Document the app entrypoint and pick Playwright, Maestro, or a project-specific runner before requiring generated drafts in CI.",
        [],
        [],
      ),
    );
  } else if (runnerGap) {
    steps.push(
      bootstrapStep(
        "runner",
        "required",
        `Configure ${formatRunnerName(input.recommendedRunner.name)} before making drafts required`,
        runnerGap,
        input.recommendedRunner.name === "playwright"
          ? "Add a Playwright config, baseURL, and app serve command, then run the generated spec locally."
          : "Add a .maestro directory or documented Maestro setup, app id, and simulator launch command.",
        [],
        [],
      ),
    );
  } else {
    steps.push(
      bootstrapStep(
        "runner",
        "ready",
        `${formatRunnerName(input.recommendedRunner.name)} setup signal detected`,
        "CodeWard found enough runner setup evidence to generate runnable drafts.",
        "Keep runner setup documented and linked from PR validation notes.",
        [],
        [],
      ),
    );
  }

  if (input.recommendedRunner.name !== "manual" && executionProfileBlockers.length > 0) {
    steps.push(
      bootstrapStep(
        "runner",
        "required",
        "Complete the E2E execution profile",
        executionProfileBlockers.slice(0, 3).join(" "),
        "Document or configure the missing command, URL, app id, or runner file before treating generated drafts as runnable regression coverage.",
        uniqueStrings([input.executionProfile.startCommand, input.executionProfile.testCommand].filter(Boolean) as string[]),
        input.executionProfile.configFiles,
      ),
    );
  }

  if (!input.testSuite.hasTestSuite) {
    steps.push(
      bootstrapStep(
        "draft",
        "required",
        "Create the first changed-flow E2E draft",
        "No existing test files were detected, so this branch needs a concrete first draft before CodeWard can compare coverage evidence.",
        "Generate the first draft, replace TODO selectors and setup values, then decide which paths should become required regression coverage.",
        [draftCommand],
        input.flows.flatMap((flow) => flow.files).slice(0, maxFilesPerFlow),
      ),
    );
  } else {
    steps.push(
      bootstrapStep(
        "draft",
        "ready",
        "Existing test suite detected",
        `${input.testSuite.testFileCount} test file${input.testSuite.testFileCount === 1 ? "" : "s"} can be used as coverage evidence.`,
        "Use the validation matrix to expand existing tests or generated drafts only where evidence is weak.",
        [],
        [],
      ),
    );
  }

  if (!input.domainManifestPath && input.domainLanguage.terms.length > 0) {
    steps.push(
      bootstrapStep(
        "domain-language",
        "recommended",
        "Promote repeated product words into a domain manifest",
        `CodeWard inferred ${input.domainLanguage.terms.length} domain term${input.domainLanguage.terms.length === 1 ? "" : "s"} from changed files, but no shared domain manifest was found.`,
        "Generate a suggested domain manifest from this branch, review names and routes with the team, then commit only the terms that match team language.",
        [domainsSuggestCommand, `${domainsSuggestCommand} --write .codeward/domains.yml`],
        input.domainLanguage.terms.flatMap((term) => term.files).slice(0, maxFilesPerFlow),
      ),
    );
  } else if (input.domainManifestPath || input.domains.length > 0) {
    steps.push(
      bootstrapStep(
        "domain-language",
        "ready",
        "Domain language has shared policy evidence",
        input.domainManifestPath
          ? `Domain manifest found at ${input.domainManifestPath}.`
          : "Matched domain definitions were found.",
        "Keep committed domain language aligned with the names used in generated E2E drafts.",
        [],
        [],
      ),
    );
  }

  if (!input.coreFlowManifestPath) {
    steps.push(
      bootstrapStep(
        "core-flow",
        input.flows.length > 0 ? "recommended" : "required",
        "Capture the first durable core flows",
        "No .codeward/flows.yml manifest was found, so CodeWard can infer changed-flow candidates but cannot distinguish team-critical journeys yet.",
        "Generate suggested flow entries from this branch, keep only the journeys humans agree are durable, then commit them as team policy.",
        [flowsSuggestCommand, `${flowsSuggestCommand} --write .codeward/flows.yml`],
        input.flows.flatMap((flow) => flow.files).slice(0, maxFilesPerFlow),
      ),
    );
  } else {
    steps.push(
      bootstrapStep(
        "core-flow",
        input.coreFlows.length > 0 ? "ready" : "recommended",
        input.coreFlows.length > 0 ? "Core flow manifest matched this change" : "Review core flow manifest coverage",
        input.coreFlows.length > 0
          ? `${input.coreFlows.length} declared core flow${input.coreFlows.length === 1 ? "" : "s"} matched the changed files.`
          : `Core flow manifest found at ${input.coreFlowManifestPath}, but this change did not match a declared flow.`,
        input.coreFlows.length > 0
          ? "Keep the matched flow checks as explicit PR validation evidence."
          : "Add or adjust flow file patterns, routes, domains, or tags if this change touches a critical journey.",
        [],
        input.coreFlows.flatMap((flow) => flow.matchedFiles).slice(0, maxFilesPerFlow),
      ),
    );
  }

  const fixtureRows = input.validationMatrix.rows.filter((row) => row.category === "fixture");
  const missingFixtureRows = fixtureRows.filter((row) => row.status === "missing");
  const partialFixtureRows = fixtureRows.filter((row) => row.status === "partial");
  if (missingFixtureRows.length > 0 || partialFixtureRows.length > 0) {
    steps.push(
      bootstrapStep(
        "fixture",
        missingFixtureRows.length > 0 ? "required" : "recommended",
        "Add deterministic fixture or mock responses",
        missingFixtureRows.length > 0
          ? `${missingFixtureRows.length} API-dependent flow${missingFixtureRows.length === 1 ? "" : "s"} lack fixture evidence.`
          : `${partialFixtureRows.length} API-dependent flow${partialFixtureRows.length === 1 ? "" : "s"} have only partial fixture evidence.`,
        "Cover success plus one empty, unauthorized, timeout, rejected, or server-error response before requiring the generated draft.",
        [],
        uniqueStrings([...missingFixtureRows, ...partialFixtureRows].flatMap((row) => row.files)).slice(0, maxFilesPerFlow),
      ),
    );
  }

  const nonRunnerTestabilityGaps = input.missingTestability.filter((gap) => !/No \.maestro|No Playwright config/i.test(gap));
  if (nonRunnerTestabilityGaps.length > 0) {
    steps.push(
      bootstrapStep(
        "testability",
        "required",
        "Add stable selectors for changed user actions",
        `${nonRunnerTestabilityGaps.length} selector or interaction gap${nonRunnerTestabilityGaps.length === 1 ? "" : "s"} were detected.`,
        "Add stable test ids, accessibility labels, roles, or durable visible copy for the controls the draft must tap, type into, or assert.",
        [],
        input.flows.flatMap((flow) => flow.files).slice(0, maxFilesPerFlow),
      ),
    );
  } else if (input.flows.some((flow) => flow.selectors.length > 0 || flow.entrypoints.length > 0)) {
    steps.push(
      bootstrapStep(
        "testability",
        "ready",
        "Entrypoint or selector evidence detected",
        "Generated drafts can reuse detected routes, screens, selectors, labels, or visible copy.",
        "Review the generated locators and replace weak TODO placeholders before promoting the draft.",
        [],
        input.flows.flatMap((flow) => flow.selectors.map((selector) => selector.file)).slice(0, maxFilesPerFlow),
      ),
    );
  }

  if (input.validationMatrix.summary.missing > 0) {
    steps.push(
      bootstrapStep(
        "validation",
        "required",
        "Close missing validation matrix rows",
        `${input.validationMatrix.summary.missing} validation row${input.validationMatrix.summary.missing === 1 ? "" : "s"} are missing evidence.`,
        "Resolve missing coverage, fixture, setup, and testability rows before calling generated E2E coverage sufficient.",
        [],
        input.validationMatrix.rows.filter((row) => row.status === "missing").flatMap((row) => row.files).slice(0, maxFilesPerFlow),
      ),
    );
  } else if (input.validationMatrix.summary.partial > 0) {
    steps.push(
      bootstrapStep(
        "validation",
        "recommended",
        "Strengthen partial validation evidence",
        `${input.validationMatrix.summary.partial} validation row${input.validationMatrix.summary.partial === 1 ? "" : "s"} are only partial.`,
        "Expand the generated draft or existing tests until the critical rows have concrete evidence.",
        [],
        input.validationMatrix.rows.filter((row) => row.status === "partial").flatMap((row) => row.files).slice(0, maxFilesPerFlow),
      ),
    );
  } else if (input.validationMatrix.rows.length > 0) {
    steps.push(
      bootstrapStep(
        "validation",
        "ready",
        "Validation matrix is ready",
        "All validation matrix rows currently have ready evidence.",
        "Keep the matrix linked in PR evidence when the generated draft is promoted.",
        [],
        [],
      ),
    );
  }

  steps.push(
    bootstrapStep(
      "history",
      "recommended",
      "Record local plan history while iterating",
      "Local run history lets the team compare how domain language, core flows, fixtures, and validation gaps evolve without spending more agent tokens.",
      "Run the plan with --record-history after important draft or manifest changes.",
      [planHistoryCommand],
      [],
    ),
  );

  if (input.suggestedCommands.length === 0) {
    steps.push(
      bootstrapStep(
        "validation",
        "recommended",
        "Expose at least one validation command",
        "No test, typecheck, lint, build, or E2E command was discovered for this project.",
        "Add a project script or CodeWard validation command so PR evidence can include repeatable checks.",
        [],
        [],
      ),
    );
  }

  const sortedSteps = dedupeBootstrapSteps(steps).sort(compareBootstrapSteps).slice(0, 12);
  const counts = {
    required: sortedSteps.filter((step) => step.status === "required").length,
    recommended: sortedSteps.filter((step) => step.status === "recommended").length,
    ready: sortedSteps.filter((step) => step.status === "ready").length,
  };
  return {
    summary: bootstrapSummary(counts, sortedSteps),
    steps: sortedSteps,
    counts,
  };
}

function bootstrapStep(
  category: E2eBootstrapStepCategory,
  status: E2eBootstrapStepStatus,
  title: string,
  reason: string,
  action: string,
  commands: string[],
  files: string[],
): E2eBootstrapStep {
  return {
    category,
    status,
    title,
    reason,
    action,
    commands,
    files: uniqueStrings(files).slice(0, maxFilesPerFlow),
  };
}

function dedupeBootstrapSteps(steps: E2eBootstrapStep[]): E2eBootstrapStep[] {
  const seen = new Set<string>();
  const deduped: E2eBootstrapStep[] = [];
  for (const step of steps) {
    const key = `${step.category}:${step.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(step);
  }
  return deduped;
}

function compareBootstrapSteps(left: E2eBootstrapStep, right: E2eBootstrapStep): number {
  const statusDiff = bootstrapStatusRank(left.status) - bootstrapStatusRank(right.status);
  if (statusDiff !== 0) {
    return statusDiff;
  }
  return bootstrapCategoryRank(left.category) - bootstrapCategoryRank(right.category);
}

function bootstrapStatusRank(status: E2eBootstrapStepStatus): number {
  if (status === "required") {
    return 0;
  }
  if (status === "recommended") {
    return 1;
  }
  return 2;
}

function bootstrapCategoryRank(category: E2eBootstrapStepCategory): number {
  const order: E2eBootstrapStepCategory[] = [
    "runner",
    "workspace",
    "draft",
    "testability",
    "fixture",
    "validation",
    "domain-language",
    "core-flow",
    "history",
  ];
  return order.indexOf(category);
}

function bootstrapSummary(
  counts: E2eBootstrapPlan["counts"],
  steps: E2eBootstrapStep[],
): string {
  const firstRequired = steps.find((step) => step.status === "required");
  if (firstRequired) {
    return `${counts.required} required bootstrap step${counts.required === 1 ? "" : "s"} must be resolved before generated E2E drafts should be treated as regression coverage. Start with: ${firstRequired.title}.`;
  }
  const firstRecommended = steps.find((step) => step.status === "recommended");
  if (firstRecommended) {
    return `${counts.recommended} recommended bootstrap step${counts.recommended === 1 ? "" : "s"} remain before the E2E workflow feels durable. Start with: ${firstRecommended.title}.`;
  }
  return "The detected E2E bootstrap signals look ready for this change.";
}

function coverageTargetRequirement(flow: E2eFlow, targetTitle: string): string {
  const target = flow.coverage.find((item) => item.title === targetTitle);
  if (!target) {
    return `Evidence for ${targetTitle}.`;
  }
  const checks = target.checks.slice(0, 2);
  return checks.length > 0 ? `${target.reason} Checks: ${formatHumanList(checks)}.` : target.reason;
}

function coverageEvidenceSummary(evidence: CoverageEvidence): string {
  const files = evidence.files.length > 0 ? ` Files: ${evidence.files.slice(0, 3).join(", ")}.` : "";
  const signals = evidence.signals.length > 0 ? ` Signals: ${evidence.signals.slice(0, 3).join(", ")}.` : "";
  return `${evidence.reason}${files}${signals}`;
}

function validationStatusFromCoverageEvidence(status: CoverageEvidence["status"]): E2eValidationMatrixStatus {
  if (status === "covered") {
    return "ready";
  }
  if (status === "partial") {
    return "partial";
  }
  return "missing";
}

function nextActionForCoverageEvidence(evidence: CoverageEvidence): string {
  if (evidence.status === "covered") {
    return "Keep the related test evidence linked in the PR validation notes.";
  }
  if (evidence.status === "partial") {
    return "Expand existing tests or generated drafts to cover the missing checks for this target.";
  }
  return "Add E2E, integration, or manual validation evidence for this target.";
}

function fixtureReadinessEvidenceSummary(readiness: E2eFixtureReadiness): string {
  const parts = [
    readiness.apiSignals.length > 0 ? `${readiness.apiSignals.length} API signal${readiness.apiSignals.length === 1 ? "" : "s"}` : "",
    readiness.backendSignals.length > 0 ? `${readiness.backendSignals.length} backend signal${readiness.backendSignals.length === 1 ? "" : "s"}` : "",
    readiness.mockSignals.length > 0 ? `${readiness.mockSignals.length} mock/fixture signal${readiness.mockSignals.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return `${readiness.reason}${parts.length > 0 ? ` Evidence: ${parts.join(", ")}.` : ""}`;
}

function validationStatusFromFixtureReadiness(status: E2eFixtureReadinessStatus): E2eValidationMatrixStatus {
  if (status === "ready") {
    return "ready";
  }
  if (status === "partial") {
    return "partial";
  }
  return "missing";
}

function testabilityEvidenceSummary(flow: E2eFlow): string {
  if (flow.missingTestability.length > 0) {
    return `${flow.missingTestability.length} testability gap${flow.missingTestability.length === 1 ? "" : "s"} detected.`;
  }
  const signals = [
    flow.selectors.length > 0 ? `${flow.selectors.length} selector${flow.selectors.length === 1 ? "" : "s"}` : "",
    flow.entrypoints.length > 0 ? `${flow.entrypoints.length} entrypoint hint${flow.entrypoints.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return signals.length > 0 ? `${signals.join(", ")} detected.` : "No stable selector or entrypoint evidence detected.";
}

function validationStatusFromTestability(flow: E2eFlow): E2eValidationMatrixStatus {
  if (flow.missingTestability.length > 0) {
    return "missing";
  }
  if (flow.selectors.length > 0 || flow.entrypoints.length > 0) {
    return "ready";
  }
  return "partial";
}

function nextActionForTestability(flow: E2eFlow): string {
  if (flow.missingTestability.length > 0) {
    return "Add stable test ids, accessibility labels, roles, route hints, or visible copy before making this draft required.";
  }
  if (flow.selectors.length > 0 || flow.entrypoints.length > 0) {
    return "Use the detected selectors and entrypoints in the generated draft.";
  }
  return "Identify a stable entrypoint and selector strategy for this flow.";
}

function compareValidationMatrixRows(left: E2eValidationMatrixRow, right: E2eValidationMatrixRow): number {
  const statusDiff = validationStatusRank(left.status) - validationStatusRank(right.status);
  if (statusDiff !== 0) {
    return statusDiff;
  }
  const categoryDiff = validationCategoryRank(left.category) - validationCategoryRank(right.category);
  if (categoryDiff !== 0) {
    return categoryDiff;
  }
  return left.area.localeCompare(right.area);
}

function validationStatusRank(status: E2eValidationMatrixStatus): number {
  if (status === "missing") {
    return 0;
  }
  if (status === "partial") {
    return 1;
  }
  return 2;
}

function validationCategoryRank(category: E2eValidationMatrixCategory): number {
  switch (category) {
    case "core-flow":
      return 0;
    case "fixture":
      return 1;
    case "coverage":
      return 2;
    case "testability":
      return 3;
    case "setup":
      return 4;
  }
}

function validationRowsForDraftFlow(flow: E2eFlow): E2eValidationMatrixRow[] {
  const coreFlow = coreFlowForDraftFlow(flow);
  return buildE2eValidationMatrix([flow], coreFlow ? [coreFlow] : []).rows;
}

function summarizeDraftValidation(flow: E2eFlow): {
  status: E2eValidationMatrixStatus;
  gapCount: number;
  blockingGapCount: number;
} {
  const rows = validationRowsForDraftFlow(flow);
  const blockingGapCount = rows.filter((row) => row.status === "missing").length;
  const gapCount = rows.filter((row) => row.status !== "ready").length;
  let status: E2eValidationMatrixStatus = "ready";
  if (blockingGapCount > 0) {
    status = "missing";
  } else if (gapCount > 0) {
    status = "partial";
  }
  return { status, gapCount, blockingGapCount };
}

interface E2eDraftPromotionGuidance {
  status: E2eDraftPromotionStatus;
  reason: string;
  action: string;
}

function buildDraftPromotionGuidance(flow: E2eFlow): E2eDraftPromotionGuidance {
  const coreFlow = coreFlowForDraftFlow(flow);
  const scenario = domainScenarioForFlow(flow);
  const hasEntrypoint = flow.entrypoints.length > 0;
  const hasChecks = flow.steps.length > 0 || (scenario?.checks.length ?? 0) > 0 || (coreFlow?.checks.length ?? 0) > 0;

  if (coreFlow) {
    if (hasEntrypoint && hasChecks) {
      return {
        status: "commit-candidate",
        reason: "Team-approved core flow already exists and matched the changed files.",
        action: "Wire the manifest checks to runnable assertions, then use the draft as PR evidence.",
      };
    }
    return {
      status: "needs-review",
      reason: "Team-approved core flow matched the change, but the runnable entrypoint or required evidence is incomplete.",
      action: "Confirm the route, fixture, and selectors before making this draft required.",
    };
  }

  if (scenario?.source === "domain-manifest") {
    if (hasEntrypoint && hasChecks) {
      return {
        status: "commit-candidate",
        reason: "Committed domain scenario matched the changed files with checks and an entrypoint.",
        action: "Promote the scenario into a durable E2E flow once fixture data and assertions are confirmed.",
      };
    }
    return {
      status: "needs-review",
      reason: "Committed domain language matched the change, but the testable route or checks still need confirmation.",
      action: "Fill in checks, fixture data, and route ownership before promoting it to a core flow.",
    };
  }

  if (scenario) {
    if (hasEntrypoint && hasChecks && flow.files.length > 0) {
      return {
        status: "needs-review",
        reason: "The scenario came from changed code or UI copy, so a human should confirm the product wording.",
        action: "Review the scenario name with the team, then commit it to `.codeward/domains.yml` or `.codeward/flows.yml` if it is durable.",
      };
    }
    return {
      status: "low-signal",
      reason: "The scenario is heuristic and lacks enough route or check evidence.",
      action: "Add domain or flow manifests before treating this draft as stable regression coverage.",
    };
  }

  if (hasEntrypoint && flow.files.length > 0) {
    return {
      status: "needs-review",
      reason: "The draft has changed files and an entrypoint, but no team-owned domain or flow language yet.",
      action: "Name the user journey and promote it into manifests before making it required.",
    };
  }

  return {
    status: "low-signal",
    reason: "The draft is a fallback smoke path without enough domain, route, or check evidence.",
    action: "Create a domain or flow manifest after the first real user journey is identified.",
  };
}

function buildDraftActionItems(
  plan: E2ePlanResult,
  flow: E2eFlow,
  runner: E2eRunnerName,
  validationSummary: ReturnType<typeof summarizeDraftValidation>,
  promotionGuidance: E2eDraftPromotionGuidance,
  selfCheck?: E2eDraftSelfCheck,
): E2eDraftActionItem[] {
  const items: E2eDraftActionItem[] = [];
  const runnerGap = runnerSetupGap(plan, runner);
  if (runnerGap) {
    items.push(draftActionItem(
      "runner",
      "required",
      `Configure ${formatRunnerName(runner)} execution`,
      runnerGap,
    ));
  }
  const executionBlockers = remainingExecutionProfileBlockers(plan.executionProfile.blockers, runnerGap);
  if (runner !== "manual" && executionBlockers.length > 0) {
    items.push(draftActionItem(
      "runner",
      "required",
      "Complete execution profile",
      executionBlockers.slice(0, 3).join(" "),
    ));
  }

  const route = primaryRouteEntrypoint(flow);
  if (runner === "playwright" && route) {
    const routeDraft = buildPlaywrightRouteDraft(route.value);
    if (routeDraft.params.length > 0) {
      items.push(draftActionItem(
        "fixture",
        "required",
        "Replace dynamic route parameters",
        `Provide real fixture values for ${routeDraft.params.map((param) => param.name).join(", ")} before running ${route.value}.`,
      ));
    }
  }

  if (flow.fixtureReadiness.status === "missing") {
    items.push(draftActionItem(
      "fixture",
      "required",
      "Add deterministic fixture or mock data",
      flow.fixtureReadiness.nextActions[0] ?? flow.fixtureReadiness.reason,
    ));
  } else if (flow.fixtureReadiness.status === "partial") {
    items.push(draftActionItem(
      "fixture",
      "recommended",
      "Confirm fixture coverage",
      flow.fixtureReadiness.nextActions[0] ?? flow.fixtureReadiness.reason,
    ));
  }

  if (flow.missingTestability.length > 0) {
    items.push(draftActionItem(
      "selector",
      "required",
      "Replace weak or missing selectors",
      flow.missingTestability[0],
    ));
  } else if (flow.selectors.length === 0 && runner !== "manual") {
    items.push(draftActionItem(
      "selector",
      "recommended",
      "Confirm stable selectors",
      "No stable selector hints were inferred, so review the generated locators before making this draft required.",
    ));
  }

  if (flow.steps.length > 0 && draftNeedsAssertionWork(selfCheck)) {
    items.push(draftActionItem(
      "assertion",
      "required",
      "Turn generated TODOs into runnable assertions",
      `Preserve the success signal "${flow.languageBrief.successSignal}" while replacing placeholder interactions and expects.`,
    ));
  }

  if (selfCheck?.status === "fail") {
    items.push(draftActionItem(
      "validation",
      "required",
      "Resolve generated draft self-check",
      selfCheck.blockers[0] ?? selfCheck.summary,
    ));
  } else if (selfCheck?.status === "warning") {
    items.push(draftActionItem(
      "validation",
      "recommended",
      "Review generated draft self-check",
      selfCheck.summary,
    ));
  }

  if (validationSummary.blockingGapCount > 0) {
    items.push(draftActionItem(
      "validation",
      "required",
      "Resolve missing validation evidence",
      `${validationSummary.blockingGapCount} blocking validation gap${validationSummary.blockingGapCount === 1 ? "" : "s"} must be closed before using this draft as PR evidence.`,
    ));
  } else if (validationSummary.gapCount > 0) {
    items.push(draftActionItem(
      "validation",
      "recommended",
      "Close partial validation evidence",
      `${validationSummary.gapCount} validation gap${validationSummary.gapCount === 1 ? "" : "s"} remain before this draft is stable regression coverage.`,
    ));
  }

  if (promotionGuidance.status !== "commit-candidate") {
    items.push(draftActionItem(
      "manifest",
      "recommended",
      "Promote durable product language",
      promotionGuidance.action,
    ));
  }

  return uniqueDraftActionItems(items).slice(0, 8);
}

function draftNeedsAssertionWork(selfCheck?: E2eDraftSelfCheck): boolean {
  if (!selfCheck) {
    return true;
  }
  return selfCheck.checks.some(
    (check) =>
      (check.name === "Unresolved placeholders" && check.status !== "pass") ||
      (check.name === "TODO comments" && check.status !== "pass"),
  );
}

function runnerSetupGap(plan: E2ePlanResult, runner: E2eRunnerName): string | undefined {
  if (runner === "playwright") {
    return plan.missingTestability.find((gap) => /No Playwright config/i.test(gap));
  }
  if (runner === "maestro") {
    return plan.missingTestability.find((gap) => /No \.maestro/i.test(gap));
  }
  return undefined;
}

function remainingExecutionProfileBlockers(blockers: string[], runnerGap?: string): string[] {
  return blockers.filter((blocker) => {
    if (/No runnable E2E runner/i.test(blocker)) {
      return false;
    }
    if (!runnerGap) {
      return true;
    }
    if (blocker === runnerGap) {
      return false;
    }
    if (/No Playwright config/i.test(runnerGap) && /Playwright config/i.test(blocker)) {
      return false;
    }
    if (/No \.maestro/i.test(runnerGap) && /(\.maestro|Maestro.*(config|flow))/i.test(blocker)) {
      return false;
    }
    return true;
  });
}

function draftActionItem(
  kind: E2eDraftActionKind,
  priority: E2eDraftActionPriority,
  title: string,
  detail: string,
): E2eDraftActionItem {
  return { kind, priority, title, detail };
}

function uniqueDraftActionItems(items: E2eDraftActionItem[]): E2eDraftActionItem[] {
  const seen = new Set<string>();
  const uniqueItems: E2eDraftActionItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.priority}:${item.title}:${item.detail}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    uniqueItems.push(item);
  }
  return uniqueItems;
}

function summarizeDraftActionItems(files: E2eDraftFile[]): E2eDraftActionSummary {
  const byKind = new Map<E2eDraftActionKind, E2eDraftActionKindSummary>();
  let required = 0;
  let recommended = 0;
  let readyFiles = 0;
  let filesWithRequiredActions = 0;
  let filesWithRecommendedActions = 0;

  for (const file of files) {
    const actionItems = file.actionItems ?? [];
    const fileHasRequired = actionItems.some((item) => item.priority === "required");
    const fileHasRecommended = actionItems.some((item) => item.priority === "recommended");
    if (actionItems.length === 0) {
      readyFiles += 1;
    }
    if (fileHasRequired) {
      filesWithRequiredActions += 1;
    }
    if (fileHasRecommended) {
      filesWithRecommendedActions += 1;
    }
    for (const item of actionItems) {
      if (item.priority === "required") {
        required += 1;
      } else {
        recommended += 1;
      }
      const existing = byKind.get(item.kind) ?? {
        kind: item.kind,
        required: 0,
        recommended: 0,
        total: 0,
      };
      existing.total += 1;
      if (item.priority === "required") {
        existing.required += 1;
      } else {
        existing.recommended += 1;
      }
      byKind.set(item.kind, existing);
    }
  }

  return {
    required,
    recommended,
    readyFiles,
    filesWithRequiredActions,
    filesWithRecommendedActions,
    byKind: [...byKind.values()].sort(compareDraftActionKindSummary),
  };
}

function compareDraftActionKindSummary(left: E2eDraftActionKindSummary, right: E2eDraftActionKindSummary): number {
  return right.total - left.total || right.required - left.required || left.kind.localeCompare(right.kind);
}

function buildFlowLanguageBrief(flow: Omit<E2eFlow, "languageBrief">): E2eFlowLanguageBrief {
  const actor = inferFlowActor(flow);
  const trigger = inferFlowTrigger(flow);
  const goal = inferFlowGoal(flow);
  const successSignal = inferFlowSuccessSignal(flow);
  return {
    actor,
    trigger,
    goal,
    successSignal,
    reviewQuestion: inferFlowReviewQuestion(flow, successSignal),
    edgeCases: inferFlowEdgeCases(flow),
  };
}

function inferFlowActor(flow: Omit<E2eFlow, "languageBrief">): string {
  const haystack = `${flow.title} ${flow.reason} ${flow.files.join(" ")}`.toLowerCase();
  if (isApiContractFocusedFlow(flow)) {
    return "API consumer or upstream service";
  }
  if (/\b(configuration|dependency|build|runtime|environment|feature[- ]?flag|package\.json|tsconfig|docker|serverless|deploy)\b/.test(haystack)) {
    return "Maintainer or release operator";
  }
  if (/\b(admin|dashboard|console|operator|settings|settlement|manage|moderation)\b/.test(haystack)) {
    return "Operator";
  }
  if (/\b(auth|login|logout|session|account|profile|permission)\b/.test(haystack)) {
    return "Signed-in user or guest";
  }
  if (/\b(checkout|purchase|payment|order|cart|offer|subscription|membership|billing)\b/.test(haystack)) {
    return "Customer";
  }
  if (hasUserFacingEntrypointOrFile(flow)) {
    return "User";
  }
  if (/\b(api|service|webhook|endpoint|controller|mutation|query)\b/.test(haystack)) {
    return "API consumer or upstream service";
  }
  return "User";
}

function hasUserFacingEntrypointOrFile(flow: Omit<E2eFlow, "languageBrief">): boolean {
  if (flow.entrypoints.some((entrypoint) => entrypoint.kind === "route" || entrypoint.kind === "screen")) {
    return true;
  }
  return flow.files.some((file) =>
    /(?:^|\/)(?:app|pages?|screens?|routes?|components?|features?)\//i.test(file) &&
    /\.(?:tsx|jsx|vue|svelte)$/i.test(file),
  );
}

function inferFlowTrigger(flow: Omit<E2eFlow, "languageBrief">): string {
  const route = flow.entrypoints.find((entrypoint) => entrypoint.kind === "route");
  if (route) {
    return `Open route ${route.value}.`;
  }
  const screen = flow.entrypoints.find((entrypoint) => entrypoint.kind === "screen");
  if (screen) {
    return `Open the ${titleCase(screen.value)} screen.`;
  }
  const command = flow.entrypoints.find((entrypoint) => entrypoint.kind === "command");
  if (command) {
    return `Run ${command.value}.`;
  }
  if (flow.files.length > 0) {
    if (isApiContractFocusedFlow(flow)) {
      return `Call the endpoint, handler, or service path affected by ${flow.files[0]}.`;
    }
    if (/\bconfiguration verification\b/i.test(flow.title)) {
      return `Run the build, startup, or release path affected by ${flow.files[0]}.`;
    }
    return `Start from the product surface that owns ${flow.files[0]}.`;
  }
  return "Launch the app and wait for the first stable screen.";
}

function inferFlowGoal(flow: Omit<E2eFlow, "languageBrief">): string {
  if (isApiContractFocusedFlow(flow)) {
    return `Protect ${flow.title} by verifying the changed request, response, auth, and failure contract.`;
  }
  if (/\bconfiguration verification\b/i.test(flow.title)) {
    return `Protect ${flow.title} by verifying clean install, startup, and fallback configuration variants.`;
  }
  const primaryStep = flow.steps.find((step) => !/^record\b|^run or open\b/i.test(step)) ?? flow.steps[0];
  if (primaryStep) {
    return `Protect ${flow.title} by ${lowercaseFirst(stripTerminalPunctuation(primaryStep))}.`;
  }
  return `Protect ${flow.title} for the changed behavior.`;
}

function inferFlowSuccessSignal(flow: Omit<E2eFlow, "languageBrief">): string {
  if (isApiContractFocusedFlow(flow)) {
    return "the changed contract returns the expected status, response shape, auth behavior, and failure handling";
  }
  if (/\bconfiguration verification\b/i.test(flow.title)) {
    return "the affected build or runtime variant starts cleanly and handles fallback values";
  }
  const verificationStep = flow.steps.find((step) => isVerificationStep(step) && !isInteractionStep(step));
  if (verificationStep) {
    return stripTerminalPunctuation(verificationStep);
  }
  const coverageCheck = flow.coverage.flatMap((target) => target.checks).find((check) => isVerificationStep(check));
  if (coverageCheck) {
    return stripTerminalPunctuation(coverageCheck);
  }
  return "the changed journey reaches a visible, stable success state";
}

function inferFlowReviewQuestion(flow: Omit<E2eFlow, "languageBrief">, successSignal: string): string {
  if (isApiContractFocusedFlow(flow)) {
    return `Can a reviewer confirm that the changed endpoint, handler, or service contract is exercised and that "${successSignal}" is asserted?`;
  }
  if (/\bconfiguration verification\b/i.test(flow.title)) {
    return `Can a reviewer confirm that the affected build, startup, or release variant is exercised and that "${successSignal}" is asserted?`;
  }
  return `Can a reviewer confirm that ${flow.title} still works from this entrypoint and that "${successSignal}" is asserted?`;
}

function isApiContractFocusedFlow(flow: Omit<E2eFlow, "languageBrief">): boolean {
  return (
    /\bapi contract\b/i.test(flow.title) ||
    (flow.coverage.some((target) => target.title === "API contract compatibility") &&
      !hasUserFacingEntrypointOrFile(flow))
  );
}

function inferFlowEdgeCases(flow: Omit<E2eFlow, "languageBrief">): string[] {
  const edgeCases: string[] = [];
  for (const target of flow.coverage) {
    if (target.priority !== "optional" && target.title !== "Primary success path") {
      edgeCases.push(target.title);
    }
  }
  for (const hint of flow.setupHints) {
    if (hint.kind === "auth") {
      edgeCases.push("Anonymous, expired-session, and permission-denied states");
    } else if (hint.kind === "network" || hint.kind === "payment" || hint.kind === "fixture") {
      edgeCases.push("Success, empty, declined, timeout, and server-error fixture variants");
    } else if (hint.kind === "state") {
      edgeCases.push("Persisted state, cache, and retry behavior");
    }
  }
  if (flow.fixtureReadiness.status !== "not-needed") {
    edgeCases.push("Fixture or mock data needed before the journey is reliable");
  }
  if (flow.missingTestability.length > 0) {
    edgeCases.push("Stable selector, accessibility label, or test id coverage");
  }
  return uniqueStrings(edgeCases).slice(0, 5);
}

function lowercaseFirst(value: string): string {
  if (!value) {
    return value;
  }
  return value[0].toLowerCase() + value.slice(1);
}

export function formatMarkdownE2ePlan(result: E2ePlanResult): string {
  const lines: string[] = [];
  lines.push("# CodeWard E2E Plan");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  if (result.workspaceRoot) {
    lines.push(`- Workspace root: \`${escapeMarkdownInline(result.workspaceRoot)}\``);
  }
  lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
  lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
  if (result.includeWorkingTree) {
    lines.push("- Includes working tree changes: yes");
  }
  lines.push(`- Project: ${formatProjectType(result.project.type)}`);
  lines.push(`- Recommended runner: ${formatRunnerName(result.recommendedRunner.name)}`);
  lines.push(
    `- Test suite: ${result.testSuite.hasTestSuite ? `${result.testSuite.testFileCount} test file${result.testSuite.testFileCount === 1 ? "" : "s"}` : "not detected"}`,
  );
  if (result.testSuite.frameworkSignals.length > 0) {
    lines.push(`- Test frameworks: ${result.testSuite.frameworkSignals.join(", ")}`);
  }
  if (result.coreFlowManifestPath) {
    lines.push(`- Core flow manifest: \`${escapeMarkdownInline(result.coreFlowManifestPath)}\``);
  }
  if (result.domainManifestPath) {
    lines.push(`- Domain manifest: \`${escapeMarkdownInline(result.domainManifestPath)}\``);
  }
  lines.push(`- Matched core flows: ${result.coreFlows.length}`);
  lines.push(`- Matched domains: ${result.domains.length}`);
  if (result.workspaceTargets.length > 0) {
    lines.push(`- Changed app/package targets: ${result.workspaceTargets.length}`);
  }
  lines.push(`- Changed files considered: ${result.changedFiles.length}`);
  if (result.localHistory) {
    lines.push(`- Local history: \`${escapeMarkdownInline(result.localHistory.path)}\``);
  }
  lines.push("");

  lines.push("## Recommendation");
  lines.push("");
  lines.push(result.recommendedRunner.reason);
  if (result.project.evidence.length > 0) {
    lines.push("");
    lines.push("Evidence:");
    for (const evidence of result.project.evidence) {
      lines.push(`- ${escapeMarkdownInline(evidence)}`);
    }
  }
  lines.push("");

  appendExecutionProfileMarkdown(lines, result.executionProfile);

  if (result.workspaceTargets.length > 0) {
    lines.push("## Changed App/Package Targets");
    lines.push("");
    lines.push(
      "These targets were inferred from changed files under child packages. Run the scoped command for the target before treating the root-level E2E plan as final.",
    );
    lines.push("");
    lines.push("| Target | Package | Project | Runner | Changed Files | Scoped Command |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const target of result.workspaceTargets) {
      lines.push(
        `| \`${escapeMarkdownTableCell(target.path)}\` | ${escapeMarkdownTableCell(target.packageName ?? "")} | ${formatProjectType(target.project.type)} | ${formatRunnerName(target.recommendedRunner.name)} | ${target.changedFiles.length} | \`${escapeMarkdownTableCell(target.suggestedCommand)}\` |`,
      );
    }
    lines.push("");
  }

  if (result.bootstrap.steps.length > 0) {
    lines.push("## Bootstrap Plan");
    lines.push("");
    lines.push(result.bootstrap.summary);
    lines.push("");
    lines.push(
      `Summary: ${result.bootstrap.counts.required} required, ${result.bootstrap.counts.recommended} recommended, ${result.bootstrap.counts.ready} ready.`,
    );
    lines.push("");
    lines.push("| Status | Area | Reason | Action | Commands |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const step of result.bootstrap.steps) {
      lines.push(
        `| ${step.status} | ${escapeMarkdownTableCell(step.title)} | ${escapeMarkdownTableCell(step.reason)} | ${escapeMarkdownTableCell(step.action)} | ${escapeMarkdownTableCell(step.commands.length > 0 ? step.commands.join("<br>") : "")} |`,
      );
    }
    lines.push("");
  }

  if (result.domainLanguage.terms.length > 0 || result.domainLanguage.scenarios.length > 0) {
    lines.push("## Domain Language");
    lines.push("");
    if (result.domainLanguage.terms.length > 0) {
      lines.push("Suggested terms:");
      for (const term of result.domainLanguage.terms.slice(0, 10)) {
        const files = term.files.length > 0 ? ` (${term.files.slice(0, 3).join(", ")})` : "";
        lines.push(`- ${escapeMarkdownInline(term.term)} [${term.confidence}, ${term.source}]${files}`);
      }
      lines.push("");
    }
    if (result.domainLanguage.scenarios.length > 0) {
      lines.push("Suggested user scenarios:");
      for (const scenario of result.domainLanguage.scenarios.slice(0, 6)) {
        lines.push(`- ${escapeMarkdownInline(scenario.title)}: ${escapeMarkdownInline(scenario.intent)}`);
      }
      lines.push("");
    }
    if (result.domainLanguage.guidance.length > 0) {
      lines.push("Naming guidance:");
      for (const guidance of result.domainLanguage.guidance) {
        lines.push(`- ${escapeMarkdownInline(guidance)}`);
      }
      lines.push("");
    }
  }

  if (result.coreFlows.length > 0) {
    lines.push("## Matched Core Flows");
    lines.push("");
    for (const flow of result.coreFlows) {
      lines.push(`### ${escapeMarkdownInline(flow.name)} \`${escapeMarkdownInline(flow.id)}\``);
      lines.push("");
      lines.push(`Priority: ${flow.priority}`);
      lines.push("");
      lines.push(flow.reason);
      lines.push("");
      lines.push("Matched files:");
      for (const file of flow.matchedFiles.slice(0, maxFilesPerFlow)) {
        lines.push(`- \`${escapeMarkdownInline(file)}\``);
      }
      if (flow.matchedFiles.length > maxFilesPerFlow) {
        lines.push(`- ... ${flow.matchedFiles.length - maxFilesPerFlow} more`);
      }
      if (flow.checks.length > 0) {
        lines.push("");
        lines.push("Human-approved checks:");
        for (const check of flow.checks) {
          lines.push(`- ${escapeMarkdownInline(check)}`);
        }
      }
      if (flow.routes.length > 0) {
        lines.push("");
        lines.push("Declared routes:");
        for (const route of flow.routes) {
          lines.push(`- \`${escapeMarkdownInline(route)}\``);
        }
      }
      lines.push("");
    }
  }

  if (result.domains.length > 0) {
    lines.push("## Matched Domains");
    lines.push("");
    for (const domain of result.domains) {
      lines.push(`### ${escapeMarkdownInline(domain.name)} \`${escapeMarkdownInline(domain.id)}\``);
      lines.push("");
      lines.push(domain.reason);
      lines.push("");
      lines.push("Matched files:");
      for (const file of domain.matchedFiles.slice(0, maxFilesPerFlow)) {
        lines.push(`- \`${escapeMarkdownInline(file)}\``);
      }
      if (domain.routes.length > 0) {
        lines.push("");
        lines.push("Declared routes:");
        for (const route of domain.routes) {
          lines.push(`- \`${escapeMarkdownInline(route)}\``);
        }
      }
      if (domain.scenarios.length > 0) {
        lines.push("");
        lines.push("Suggested scenarios:");
        for (const scenario of domain.scenarios) {
          lines.push(`- ${escapeMarkdownInline(scenario.title)}`);
        }
      }
      lines.push("");
    }
  }

  if (result.validationMatrix.rows.length > 0) {
    lines.push("## E2E Validation Matrix");
    lines.push("");
    lines.push(
      `Summary: ${result.validationMatrix.summary.ready} ready, ${result.validationMatrix.summary.partial} partial, ${result.validationMatrix.summary.missing} missing.`,
    );
    lines.push("");
    lines.push("| Area | Required Evidence | Current Evidence | Status | Next Action |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const row of result.validationMatrix.rows.slice(0, 12)) {
      lines.push(
        `| ${escapeMarkdownTableCell(row.area)} | ${escapeMarkdownTableCell(row.requiredEvidence)} | ${escapeMarkdownTableCell(row.currentEvidence)} | ${row.status} | ${escapeMarkdownTableCell(row.nextAction)} |`,
      );
    }
    if (result.validationMatrix.rows.length > 12) {
      lines.push(
        `| ... ${result.validationMatrix.rows.length - 12} more | See JSON output for the full validation matrix. |  | partial | Review the remaining matrix rows before merging. |`,
      );
    }
    lines.push("");
  }

  lines.push("## Candidate E2E Flows");
  lines.push("");
  if (result.flows.length === 0) {
    lines.push("No user-facing changed files were detected. Add a flow manually if this branch changes behavior indirectly.");
    lines.push("");
  } else {
    for (const [index, flow] of result.flows.entries()) {
      lines.push(`### ${index + 1}. ${escapeMarkdownInline(flow.title)}`);
      lines.push("");
      lines.push(flow.reason);
      lines.push("");
      appendFlowLanguageBriefMarkdown(lines, flow.languageBrief);
      lines.push("");
      lines.push("Files:");
      for (const file of flow.files.slice(0, maxFilesPerFlow)) {
        lines.push(`- \`${escapeMarkdownInline(file)}\``);
      }
      if (flow.files.length > maxFilesPerFlow) {
        lines.push(`- ... ${flow.files.length - maxFilesPerFlow} more`);
      }
      lines.push("");
      lines.push("Draft steps:");
      for (const step of flow.steps) {
        lines.push(`- ${escapeMarkdownInline(step)}`);
      }
      if (flow.entrypoints.length > 0) {
        lines.push("");
        lines.push("Entrypoint hints:");
        for (const entrypoint of flow.entrypoints.slice(0, maxFilesPerFlow)) {
          lines.push(`- ${formatEntrypoint(entrypoint)}`);
        }
      }
      if (flow.setupHints.length > 0) {
        lines.push("");
        lines.push("Setup hints:");
        for (const hint of flow.setupHints.slice(0, maxFilesPerFlow)) {
          lines.push(`- ${formatSetupHint(hint)}`);
        }
      }
      if (flow.fixtureReadiness.status !== "not-needed") {
        lines.push("");
        lines.push("Fixture/mock readiness:");
        lines.push(`- ${formatFixtureReadiness(flow.fixtureReadiness)}`);
        for (const action of flow.fixtureReadiness.nextActions.slice(0, 3)) {
          lines.push(`- Next: ${escapeMarkdownInline(action)}`);
        }
      }
      if (flow.coverage.length > 0) {
        lines.push("");
        lines.push("Coverage targets:");
        for (const target of flow.coverage) {
          lines.push(`- ${formatCoveragePriority(target.priority)} ${escapeMarkdownInline(target.title)}: ${escapeMarkdownInline(target.reason)}`);
        }
      }
      if (flow.coverageEvidence.length > 0) {
        lines.push("");
        lines.push("Existing test evidence:");
        for (const evidence of flow.coverageEvidence) {
          const files = evidence.files.length > 0 ? ` (${evidence.files.slice(0, 3).join(", ")})` : "";
          const signals = evidence.signals.length > 0 ? ` signals: ${evidence.signals.join(", ")}` : "";
          lines.push(
            `- ${evidence.status} ${escapeMarkdownInline(evidence.targetTitle)} [${evidence.confidence} confidence]${files}${signals}`,
          );
        }
      }
      if (flow.missingTestability.length > 0) {
        lines.push("");
        lines.push("Missing testability:");
        for (const gap of flow.missingTestability) {
          lines.push(`- ${escapeMarkdownInline(gap)}`);
        }
      }
      lines.push("");
    }
  }

  if (result.missingTestability.length > 0) {
    lines.push("## Testability Gaps");
    lines.push("");
    for (const gap of result.missingTestability) {
      lines.push(`- ${escapeMarkdownInline(gap)}`);
    }
    lines.push("");
  }

  if (result.suggestedCommands.length > 0) {
    lines.push("## Existing Validation Commands");
    lines.push("");
    for (const command of result.suggestedCommands) {
      lines.push(`- \`${escapeMarkdownInline(command)}\``);
    }
    lines.push("");
  }

  if (result.setupNotes.length > 0) {
    lines.push("## Setup Notes");
    lines.push("");
    for (const note of result.setupNotes) {
      lines.push(`- ${escapeMarkdownInline(note)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatMarkdownE2eDraft(result: E2eDraftResult): string {
  const lines: string[] = [];
  lines.push("# CodeWard E2E Draft");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  lines.push(`- Runner: ${formatRunnerName(result.runner)}`);
  lines.push(`- Output directory: \`${escapeMarkdownInline(result.outputDirectory)}\``);
  lines.push(`- Files: ${result.files.filter((file) => file.status === "created").length} created, ${result.files.filter((file) => file.status === "skipped").length} skipped`);
  lines.push("");

  lines.push("## Draft Readiness Summary");
  lines.push("");
  lines.push(
    `Summary: ${result.actionSummary.required} required action${result.actionSummary.required === 1 ? "" : "s"}, ${result.actionSummary.recommended} recommended action${result.actionSummary.recommended === 1 ? "" : "s"}.`,
  );
  lines.push(`- Ready files: ${result.actionSummary.readyFiles}`);
  lines.push(`- Files with required actions: ${result.actionSummary.filesWithRequiredActions}`);
  lines.push(`- Files with recommended actions: ${result.actionSummary.filesWithRecommendedActions}`);
  if (result.actionSummary.byKind.length > 0) {
    lines.push(`- Action categories: ${formatDraftActionKindSummary(result.actionSummary.byKind)}`);
  }
  lines.push("");

  lines.push("## Files");
  lines.push("");
  for (const file of result.files) {
    const quality = formatDraftFileQuality(file);
    const suffix = file.reason ? ` - ${file.reason}` : quality ? ` - ${quality}` : "";
    lines.push(`- ${file.status}: \`${escapeMarkdownInline(file.path)}\` (${escapeMarkdownInline(file.flowTitle)})${suffix}`);
  }
  lines.push("");

  const filesWithSelfChecks = result.files.filter((file) => file.selfCheck !== undefined);
  if (filesWithSelfChecks.length > 0) {
    lines.push("## Draft Self Checks");
    lines.push("");
    for (const file of filesWithSelfChecks) {
      const selfCheck = file.selfCheck;
      if (!selfCheck) {
        continue;
      }
      lines.push(`- \`${escapeMarkdownInline(file.flowTitle)}\` (${escapeMarkdownInline(file.path)}): ${selfCheck.status} - ${escapeMarkdownInline(selfCheck.summary)}`);
      if (selfCheck.command) {
        lines.push(`  - Command: \`${escapeMarkdownInline(selfCheck.command)}\``);
      }
      for (const check of selfCheck.checks.filter((item) => item.status !== "pass").slice(0, 4)) {
        lines.push(`  - [${check.status}] ${escapeMarkdownInline(check.name)}: ${escapeMarkdownInline(check.detail)}`);
      }
    }
    lines.push("");
  }

  const filesWithActionItems = result.files.filter((file) => (file.actionItems?.length ?? 0) > 0);
  if (filesWithActionItems.length > 0) {
    lines.push("## Draft Action Items");
    lines.push("");
    for (const file of filesWithActionItems) {
      lines.push(`- \`${escapeMarkdownInline(file.flowTitle)}\` (${escapeMarkdownInline(file.path)})`);
      for (const item of file.actionItems ?? []) {
        lines.push(
          `  - [${item.priority}] ${item.kind}: ${escapeMarkdownInline(item.title)} - ${escapeMarkdownInline(item.detail)}`,
        );
      }
    }
    lines.push("");
  }

  if (result.plan.missingTestability.length > 0) {
    lines.push("## Testability Gaps");
    lines.push("");
    for (const gap of result.plan.missingTestability) {
      lines.push(`- ${escapeMarkdownInline(gap)}`);
    }
    lines.push("");
  }

  const promotedFiles = result.files.filter((file) => file.promotionStatus !== undefined);
  if (promotedFiles.length > 0) {
    lines.push("## Manifest Promotion Guidance");
    lines.push("");
    for (const file of promotedFiles) {
      const reason = file.promotionReason ? ` - ${file.promotionReason}` : "";
      lines.push(`- ${file.promotionStatus}: \`${escapeMarkdownInline(file.flowTitle)}\`${reason}`);
      if (file.promotionAction) {
        lines.push(`  Next: ${escapeMarkdownInline(file.promotionAction)}`);
      }
    }
    lines.push("");
  }

  if (result.nextSteps.length > 0) {
    lines.push("## Next Steps");
    lines.push("");
    for (const step of result.nextSteps) {
      lines.push(`- ${escapeMarkdownInline(step)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function detectProjectProfile(root: string): Promise<E2eProjectProfile> {
  const packageJson = await readPackageJson(root);
  const dependencies = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  const evidence: string[] = [];

  const hasExpoDependency = "expo" in dependencies;
  const hasReactNativeDependency = "react-native" in dependencies;
  const hasPlaywrightDependency = "@playwright/test" in dependencies || "playwright" in dependencies;
  const webDependencies = [
    "@angular/core",
    "@remix-run/react",
    "@storybook/react",
    "@storybook/react-vite",
    "@storybook/vue",
    "@storybook/vue3",
    "astro",
    "next",
    "nuxt",
    "react-dom",
    "svelte",
    "vue",
    "vite",
  ];
  const webDependency = webDependencies.find((dependency) => dependency in dependencies);
  const hasWebDependency = Boolean(webDependency) || hasPlaywrightDependency;
  const apiServiceDependencies = [
    "@apollo/server",
    "@nestjs/core",
    "@trpc/server",
    "apollo-server",
    "express",
    "fastify",
    "graphql-yoga",
    "hapi",
    "hono",
    "koa",
    "serverless",
    "serverless-http",
  ];
  const apiServiceDependency = apiServiceDependencies.find((dependency) => dependency in dependencies);
  const hasExpoConfig = await hasAnyFile(root, ["app.json", "app.config.js", "app.config.ts"]);
  const hasNativeDirs = (await exists(path.join(root, "ios"))) || (await exists(path.join(root, "android")));
  const hasWebConfig = await hasAnyFile(root, [
    "angular.json",
    "astro.config.js",
    "astro.config.mjs",
    "astro.config.ts",
    "next.config.js",
    "next.config.mjs",
    "nuxt.config.js",
    "nuxt.config.ts",
    "svelte.config.js",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.ts",
    "vue.config.js",
  ]);
  const hasApiServiceConfig = await hasAnyFile(root, [
    "serverless.yml",
    "serverless.yaml",
    "openapi.yml",
    "openapi.yaml",
    "swagger.yml",
    "swagger.yaml",
  ]);

  if (hasExpoDependency) {
    evidence.push("package.json dependency: expo");
  }
  if (hasReactNativeDependency) {
    evidence.push("package.json dependency: react-native");
  }
  if (hasPlaywrightDependency) {
    evidence.push("package.json dependency: Playwright");
  }
  if (webDependency) {
    evidence.push(`package.json dependency: ${webDependency}`);
  }
  if (hasWebConfig) {
    evidence.push("Web app or component configuration file found");
  }
  if (hasExpoConfig) {
    evidence.push("Expo app configuration file found");
  }
  if (hasNativeDirs) {
    evidence.push("ios/ or android/ directory found");
  }
  if (apiServiceDependency) {
    evidence.push(`package.json dependency: ${apiServiceDependency}`);
  }
  if (hasApiServiceConfig) {
    evidence.push("API or serverless service configuration found");
  }

  if (hasExpoDependency || (hasExpoConfig && hasReactNativeDependency)) {
    return { type: "expo-react-native", evidence };
  }
  if (hasReactNativeDependency || hasNativeDirs) {
    return { type: "react-native", evidence };
  }
  if (hasWebDependency || hasWebConfig) {
    return { type: "web", evidence };
  }
  if (apiServiceDependency || hasApiServiceConfig) {
    return { type: "api-service", evidence };
  }
  return {
    type: "unknown",
    evidence,
  };
}

function recommendRunner(project: E2eProjectProfile): E2eRunnerRecommendation {
  if (project.type === "expo-react-native" || project.type === "react-native") {
    return {
      name: "maestro",
      reason:
        "Use Maestro for the first E2E draft because this looks like a native mobile app and Maestro flows are lightweight YAML files that can drive simulator or device UI.",
    };
  }
  if (project.type === "web") {
    return {
      name: "playwright",
      reason:
        "Use Playwright for the first E2E draft because this looks like a web app and Playwright can generate stable browser automation tests.",
    };
  }
  if (project.type === "api-service") {
    return {
      name: "manual",
      reason:
        "Use a manual API contract checklist first because this looks like a backend service without a browser or device surface.",
    };
  }
  return {
    name: "manual",
    reason:
      "No clear app platform was detected, so start with a manual smoke checklist before choosing a runnable E2E framework.",
  };
}

function overrideRunner(project: E2eProjectProfile, runner: E2eRunnerName): E2eRunnerRecommendation {
  if (runner === "maestro") {
    return {
      name: runner,
      reason:
        "Use Maestro because it was explicitly requested for this E2E draft. This is usually best for Expo and React Native apps.",
    };
  }
  if (runner === "playwright") {
    return {
      name: runner,
      reason:
        "Use Playwright because it was explicitly requested for this E2E draft. This is usually best for browser-based web apps.",
    };
  }
  return {
    name: runner,
    reason: `Use a manual checklist because no runnable E2E runner was selected for this ${formatProjectType(project.type)} project.`,
  };
}

async function buildExecutionProfile(
  root: string,
  workspaceRoot: string | undefined,
  project: E2eProjectProfile,
  runner: E2eRunnerName,
): Promise<E2eExecutionProfile> {
  const packageJson = await readPackageJson(root);
  const scripts = packageJson?.scripts ?? {};
  const packageManager = await detectPackageManager(root, packageJson?.packageManager, workspaceRoot);
  const configFiles = await existingFiles(root, executionConfigCandidates(runner));
  const envFiles = await existingFiles(root, [
    ".env.example",
    ".env.local.example",
    ".env.test",
    ".env.e2e",
    ".env.development",
  ]);
  const startScript = chooseScript(scripts, startScriptCandidates(runner, project.type));
  const testScript = chooseScript(scripts, testScriptCandidates(runner));
  const startCommand = startScript ? commandForScript(packageManager, startScript) : undefined;
  const testCommand = testScript ? commandForScript(packageManager, testScript) : defaultRunnerCommand(runner);
  const baseUrl = runner === "playwright" ? await detectPlaywrightBaseUrl(root, configFiles, envFiles) : undefined;
  const appId = runner === "maestro" ? await detectMobileAppId(root) : undefined;
  const evidence = executionProfileEvidence({
    runner,
    startCommand,
    testCommand,
    baseUrl,
    appId,
    configFiles,
    envFiles,
  });
  const blockers = executionProfileBlockers({
    runner,
    startCommand,
    testCommand,
    baseUrl,
    appId,
    configFiles,
    projectType: project.type,
  });

  return {
    runner,
    confidence: executionProfileConfidence(runner, evidence, blockers),
    startCommand,
    testCommand,
    baseUrl,
    appId,
    configFiles,
    envFiles,
    evidence,
    blockers,
  };
}

function executionConfigCandidates(runner: E2eRunnerName): string[] {
  if (runner === "playwright") {
    return [
      "playwright.config.ts",
      "playwright.config.js",
      "playwright.config.mjs",
      "playwright.config.cjs",
    ];
  }
  if (runner === "maestro") {
    return [".maestro", "maestro.yaml", "maestro.yml"];
  }
  return ["openapi.yml", "openapi.yaml", "swagger.yml", "swagger.yaml", "serverless.yml", "serverless.yaml"];
}

function startScriptCandidates(runner: E2eRunnerName, projectType: E2eProjectType): string[] {
  if (runner === "maestro") {
    return ["ios", "android", "start", "dev"];
  }
  if (runner === "playwright") {
    return ["dev", "start", "preview", "serve"];
  }
  if (projectType === "api-service") {
    return ["dev", "start", "serve", "local"];
  }
  return ["dev", "start"];
}

function testScriptCandidates(runner: E2eRunnerName): string[] {
  if (runner === "playwright") {
    return ["test:e2e", "e2e", "playwright", "test"];
  }
  if (runner === "maestro") {
    return ["test:e2e", "e2e", "maestro"];
  }
  return ["test:e2e", "e2e", "test"];
}

function chooseScript(scripts: Record<string, string>, candidates: string[]): string | undefined {
  return candidates.find((script) => isUsablePackageScript(scripts[script]));
}

function isUsablePackageScript(script: string | undefined): boolean {
  return Boolean(script && !/no test specified|exit\s+1/i.test(script));
}

function commandForScript(packageManager: string, script: string): string {
  if (script === "start" || script === "test") {
    return `${packageManager} ${script}`;
  }
  return `${packageManager} run ${script}`;
}

function defaultRunnerCommand(runner: E2eRunnerName): string | undefined {
  if (runner === "playwright") {
    return "npx playwright test";
  }
  if (runner === "maestro") {
    return "maestro test .maestro";
  }
  return undefined;
}

async function detectPackageManager(
  root: string,
  packageManager: string | undefined,
  workspaceRoot: string | undefined,
): Promise<string> {
  const workspacePackageManager =
    workspaceRoot && workspaceRoot !== root ? (await readPackageJson(workspaceRoot))?.packageManager : undefined;
  const declaredPackageManager = packageManager ?? workspacePackageManager;
  if (declaredPackageManager?.startsWith("pnpm@")) {
    return "pnpm";
  }
  if (declaredPackageManager?.startsWith("yarn@")) {
    return "yarn";
  }
  if (declaredPackageManager?.startsWith("bun@")) {
    return "bun";
  }
  if (await existsInRoots("pnpm-lock.yaml", root, workspaceRoot)) {
    return "pnpm";
  }
  if (await existsInRoots("yarn.lock", root, workspaceRoot)) {
    return "yarn";
  }
  if (await existsInRoots("bun.lockb", root, workspaceRoot)) {
    return "bun";
  }
  return "npm";
}

async function existsInRoots(fileName: string, root: string, workspaceRoot: string | undefined): Promise<boolean> {
  if (await exists(path.join(root, fileName))) {
    return true;
  }
  return Boolean(workspaceRoot && workspaceRoot !== root && (await exists(path.join(workspaceRoot, fileName))));
}

async function existingFiles(root: string, candidates: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const candidate of candidates) {
    if (await exists(path.join(root, candidate))) {
      files.push(candidate);
    }
  }
  return files;
}

async function detectPlaywrightBaseUrl(root: string, configFiles: string[], envFiles: string[]): Promise<string | undefined> {
  for (const configFile of configFiles) {
    const text = await readTextIfExists(path.join(root, configFile));
    const baseUrl = text?.match(/\bbaseURL\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
    if (baseUrl) {
      return baseUrl;
    }
  }

  for (const envFile of envFiles) {
    const text = await readTextIfExists(path.join(root, envFile));
    const baseUrl = text?.match(/^(?:PLAYWRIGHT_BASE_URL|BASE_URL|E2E_BASE_URL|NEXT_PUBLIC_SITE_URL)=(.+)$/m)?.[1]?.trim();
    if (baseUrl && !/\$\{|<|TODO/i.test(baseUrl)) {
      return baseUrl.replace(/^["']|["']$/g, "");
    }
  }

  return undefined;
}

async function detectMobileAppId(root: string): Promise<string | undefined> {
  const appJson = await readTextIfExists(path.join(root, "app.json"));
  if (!appJson) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(appJson) as {
      expo?: {
        android?: { package?: string };
        ios?: { bundleIdentifier?: string };
        slug?: string;
        name?: string;
      };
    };
    return parsed.expo?.android?.package ?? parsed.expo?.ios?.bundleIdentifier ?? parsed.expo?.slug ?? parsed.expo?.name;
  } catch {
    return undefined;
  }
}

function executionProfileEvidence(input: {
  runner: E2eRunnerName;
  startCommand?: string;
  testCommand?: string;
  baseUrl?: string;
  appId?: string;
  configFiles: string[];
  envFiles: string[];
}): string[] {
  const evidence: string[] = [];
  if (input.startCommand) {
    evidence.push(`start command: ${input.startCommand}`);
  }
  if (input.testCommand) {
    evidence.push(`test command: ${input.testCommand}`);
  }
  if (input.baseUrl) {
    evidence.push(`base URL: ${input.baseUrl}`);
  }
  if (input.appId) {
    evidence.push(`app id: ${input.appId}`);
  }
  for (const file of input.configFiles) {
    evidence.push(`config file: ${file}`);
  }
  for (const file of input.envFiles) {
    evidence.push(`env fixture file: ${file}`);
  }
  if (input.runner === "manual" && evidence.length === 0) {
    evidence.push("manual checklist profile");
  }
  return uniqueStrings(evidence);
}

function executionProfileBlockers(input: {
  runner: E2eRunnerName;
  startCommand?: string;
  testCommand?: string;
  baseUrl?: string;
  appId?: string;
  configFiles: string[];
  projectType: E2eProjectType;
}): string[] {
  const blockers: string[] = [];
  if (input.runner === "manual") {
    if (input.projectType !== "api-service") {
      blockers.push("No runnable E2E runner was selected for this project surface.");
    }
    if (input.projectType === "api-service" && !input.startCommand) {
      blockers.push("No local API/service start command was detected.");
    }
    return blockers;
  }

  if (input.configFiles.length === 0) {
    blockers.push(
      input.runner === "playwright"
        ? "No Playwright config file was detected."
        : "No Maestro flow directory or config file was detected.",
    );
  }
  if (!input.startCommand) {
    blockers.push("No local app start or launch command was detected.");
  }
  if (input.runner === "playwright" && !input.baseUrl) {
    blockers.push("No Playwright baseURL or E2E base URL was detected.");
  }
  if (input.runner === "maestro" && !input.appId) {
    blockers.push("No mobile app id was detected from app.json.");
  }
  if (!input.testCommand) {
    blockers.push(`No ${formatRunnerName(input.runner)} test command was detected.`);
  }
  return blockers;
}

function executionProfileConfidence(
  runner: E2eRunnerName,
  evidence: string[],
  blockers: string[],
): E2eExecutionProfileConfidence {
  if (runner === "manual") {
    return blockers.length === 0 && evidence.length > 0 ? "medium" : "low";
  }
  if (blockers.length === 0) {
    return "high";
  }
  return evidence.length >= 3 ? "medium" : "low";
}

async function buildWorkspaceTargets(root: string, testPlan: TestPlanResult): Promise<E2eWorkspaceTarget[]> {
  const workspaceRoot = testPlan.workspaceRoot ?? root;
  if (path.resolve(root) !== path.resolve(workspaceRoot) || testPlan.changedFiles.length === 0) {
    return [];
  }

  const packageDirectories = await discoverWorkspacePackageDirectories(root);
  if (packageDirectories.length === 0) {
    return [];
  }

  const changedFilesByPackage = new Map<string, string[]>();
  for (const changedFile of testPlan.changedFiles) {
    const packagePath = nearestPackageDirectory(changedFile.path, packageDirectories);
    if (!packagePath) {
      continue;
    }
    const files = changedFilesByPackage.get(packagePath) ?? [];
    files.push(changedFile.path);
    changedFilesByPackage.set(packagePath, files);
  }

  const targets: E2eWorkspaceTarget[] = [];
  for (const [packagePath, changedFiles] of [...changedFilesByPackage.entries()].sort(compareWorkspaceTargetEntries)) {
    const packageRoot = path.join(root, packagePath);
    const packageJson = await readPackageJson(packageRoot);
    const project = await detectProjectProfile(packageRoot);
    const recommendedRunner = recommendRunner(project);
    targets.push({
      path: packagePath,
      packageName: packageJson?.name,
      project,
      recommendedRunner,
      changedFiles: uniqueStrings(changedFiles).slice(0, 20),
      reason: workspaceTargetReason(packagePath, project, changedFiles.length),
      suggestedCommand: workspaceTargetCommand(packagePath, testPlan),
    });
  }

  return targets.slice(0, 8);
}

async function discoverWorkspacePackageDirectories(root: string): Promise<string[]> {
  const directories: string[] = [];

  async function walk(directory: string): Promise<void> {
    if (directories.length >= workspacePackageSearchLimit) {
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    if (directory !== root && entries.some((entry) => entry.isFile() && entry.name === "package.json")) {
      directories.push(toPosixPath(path.relative(root, directory)));
      if (directories.length >= workspacePackageSearchLimit) {
        return;
      }
    }

    for (const entry of entries) {
      if (directories.length >= workspacePackageSearchLimit) {
        return;
      }
      if (!entry.isDirectory() || workspacePackageIgnoredDirectories.has(entry.name)) {
        continue;
      }
      await walk(path.join(directory, entry.name));
    }
  }

  await walk(root);
  return directories.sort((left, right) => right.length - left.length);
}

function nearestPackageDirectory(filePath: string, packageDirectories: string[]): string | undefined {
  const normalizedPath = toPosixPath(filePath).replace(/^\.\/+/, "");
  return packageDirectories.find(
    (directory) => normalizedPath === `${directory}/package.json` || normalizedPath.startsWith(`${directory}/`),
  );
}

function compareWorkspaceTargetEntries(left: [string, string[]], right: [string, string[]]): number {
  const countDiff = right[1].length - left[1].length;
  if (countDiff !== 0) {
    return countDiff;
  }
  return left[0].localeCompare(right[0]);
}

function workspaceTargetReason(packagePath: string, project: E2eProjectProfile, changedFileCount: number): string {
  const fileCount = `${changedFileCount} changed file${changedFileCount === 1 ? "" : "s"}`;
  if (project.type === "unknown") {
    return `${fileCount} map to ${packagePath}, but the package needs a scoped plan before choosing a runner.`;
  }
  return `${fileCount} map to ${packagePath}, which looks like a ${formatProjectType(project.type)} target.`;
}

function workspaceTargetCommand(packagePath: string, testPlan: TestPlanResult): string {
  const args = [
    "codeward",
    "e2e",
    "plan",
    packagePath,
    "--workspace-root",
    ".",
    "--base",
    testPlan.base,
    "--head",
    testPlan.head,
  ];
  if (testPlan.includeWorkingTree) {
    args.push("--include-working-tree");
  }
  return args.map(shellArg).join(" ");
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toCoreFlowChangedFiles(
  changedFiles: TestPlanChangedFile[],
  scopedRoot: string,
  coreFlowRoot: string,
): TestPlanChangedFile[] {
  const relativeRoot = toPosixPath(path.relative(coreFlowRoot, scopedRoot));
  if (!relativeRoot || relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
    return changedFiles;
  }
  return changedFiles.map((file) => ({
    ...file,
    path: toPosixPath(path.join(relativeRoot, file.path)),
    previousPath: file.previousPath ? toPosixPath(path.join(relativeRoot, file.previousPath)) : undefined,
  }));
}

type E2eFlowKind = "ui" | "api" | "state" | "content" | "config" | "domain" | "changed-file";
type FlowCandidate = Omit<
  E2eFlow,
  | "languageBrief"
  | "coverage"
  | "coverageEvidence"
  | "entrypoints"
  | "setupHints"
  | "fixtureReadiness"
  | "selectors"
  | "missingTestability"
> & {
  kind: E2eFlowKind;
};
type DraftFlowSource = "domain-language" | "core-flow" | "heuristic";
type DraftE2eFlow = E2eFlow & {
  draftSource?: DraftFlowSource;
  domainScenario?: DomainScenarioSuggestion;
  coreFlow?: MatchedCoreFlow;
};

async function buildFlows(
  root: string,
  changedFiles: TestPlanChangedFile[],
  runner: E2eRunnerName,
  projectType: E2eProjectType,
  testSuiteInventory: TestSuiteInventory,
  domainLanguage: DomainLanguageSummary,
): Promise<E2eFlow[]> {
  const files = changedFiles.map((file) => file.path);
  const fixtureContext = await collectFixtureReadinessContext(root, files);
  const flowResults = await Promise.all(
    buildFlowCandidates(files, runner, projectType, domainLanguage).map((candidate) =>
      buildFlow(root, runner, candidate, testSuiteInventory, fixtureContext),
    ),
  );
  const flows = flowResults.filter((flow): flow is E2eFlow => Boolean(flow));

  return dedupeFlows(flows).slice(0, 4);
}

function buildFlowCandidates(
  files: string[],
  runner: E2eRunnerName,
  projectType: E2eProjectType,
  domainLanguage: DomainLanguageSummary,
): FlowCandidate[] {
  const behaviorFiles = files.filter((file) => !isTestLikeFile(file));
  const candidateFiles = behaviorFiles.length > 0 ? behaviorFiles : files;
  const uiFiles = candidateFiles.filter(isUserFacingFile);
  const apiFiles = candidateFiles.filter(isApiLikeFile);
  const apiServiceSourceFiles =
    projectType === "api-service"
      ? candidateFiles.filter(
          (file) => !apiFiles.includes(file) && !isConfigLikeFile(file) && isServiceSourceFile(file),
        )
      : [];
  const contractFiles = uniqueStrings([...apiFiles, ...apiServiceSourceFiles]);
  const stateFiles = candidateFiles.filter(isStateLikeFile);
  const contentFiles = candidateFiles.filter(isContentOrStyleFile);
  const configFiles = candidateFiles.filter(isConfigLikeFile);
  const domainFiles = candidateFiles.filter(isDomainOwnedFile);
  const candidates: FlowCandidate[] = [];

  if (uiFiles.length > 0) {
    const subject = summarizeFlowSubject(uiFiles, "Changed", domainLanguage);
    candidates.push({
      kind: "ui",
      title: `${subject} UI smoke flow`,
      reason: "User-facing route, screen, navigation, or component files changed, so the draft should open the touched surface and cover the primary visible action.",
      files: uiFiles,
      steps: [
        "Launch the app.",
        "Navigate to the changed screen or component surface.",
        "Exercise the primary visible action.",
        "Verify loading, empty, error, and success states when they are reachable.",
      ],
    });
  }

  if (contractFiles.length > 0) {
    const subject = summarizeFlowSubject(contractFiles, "Changed", domainLanguage);
    candidates.push({
      kind: "api",
      title: `${subject} API contract smoke ${runner === "manual" ? "checklist" : "flow"}`,
      reason:
        projectType === "api-service"
          ? "Backend service source, endpoint, request, or response files changed, so the generated draft should verify externally observable contract shape and failure handling."
          : "API client, schema, endpoint, request, or response files changed, so the generated draft should verify contract shape and failure handling before relying on UI-only coverage.",
      files: contractFiles,
      steps:
        runner === "manual"
          ? [
              "Call the changed endpoint, client, command, or handler with a valid request.",
              "Verify the response shape, status, and parsed data match the public contract.",
              "Verify invalid input, authorization failure, timeout, and server-error handling.",
              "Check backward compatibility for existing callers.",
            ]
          : [
              "Launch the app.",
              "Trigger the user path that calls the changed API or client.",
              "Verify the successful response is rendered or persisted correctly.",
              "Verify the reachable error or empty state for a failed response.",
            ],
    });
  }

  if (stateFiles.length > 0) {
    const subject = summarizeFlowSubject(stateFiles, "Changed", domainLanguage);
    candidates.push({
      kind: "state",
      title: `${subject} state transition flow`,
      reason: "State, cache, auth, permission, or provider files changed, so the draft should verify transitions before and after the affected action.",
      files: stateFiles,
      steps: [
        "Launch the app in a clean state.",
        "Reach the screen or command path that reads the changed state.",
        "Exercise the action that mutates or invalidates that state.",
        "Verify the state-dependent UI, navigation, or output before and after refresh or re-entry.",
      ],
    });
  }

  if (contentFiles.length > 0) {
    const subject = summarizeFlowSubject(contentFiles, "Changed", domainLanguage);
    candidates.push({
      kind: "content",
      title: `${subject} content and theme smoke flow`,
      reason: "Copy, locale, theme, or style files changed, so the draft should include a quick text, visual-state, and viewport smoke pass.",
      files: contentFiles,
      steps: [
        "Launch the app with the default locale and theme.",
        "Open the changed screen or component surface.",
        "Verify primary text, controls, and visual states are present.",
        "Switch locale, theme, or viewport when the project exposes that variant, then repeat the changed surface smoke path.",
      ],
    });
  }

  if (configFiles.length > 0) {
    const subject = summarizeFlowSubject(configFiles, "Changed", domainLanguage);
    candidates.push({
      kind: "config",
      title: `${subject} configuration verification ${runner === "manual" ? "checklist" : "flow"}`,
      reason: "Dependency, build, runtime, feature-flag, or environment configuration changed, so the draft should verify the affected variant in a clean run.",
      files: configFiles,
      steps: [
        "Start from a clean install or clean app launch for the affected package.",
        "Enable the changed configuration, flag, environment, or dependency path.",
        "Verify the primary user or maintainer workflow still completes.",
        "Verify fallback behavior when the changed configuration is absent, disabled, or unknown.",
      ],
    });
  }

  const remainingDomainFiles = domainFiles.filter((file) => !isUserFacingFile(file) && !isApiLikeFile(file));
  if (remainingDomainFiles.length > 0) {
    const subject = summarizeFlowSubject(remainingDomainFiles, "Changed domain", domainLanguage);
    candidates.push({
      kind: "domain",
      title: `${subject} workflow smoke ${runner === "manual" || projectType === "unknown" ? "checklist" : "flow"}`,
      reason: "Feature or domain-owned files changed, so the draft should verify the affected business path without assuming project-specific terminology.",
      files: remainingDomainFiles,
      steps: [
        "Identify the public entry point, command, route, or screen that imports the changed domain code.",
        "Run the primary successful path with realistic data.",
        "Verify the result, emitted event, navigation, or persisted state owned by the changed code.",
        "Exercise one invalid, blocked, or empty path when reachable.",
      ],
    });
  }

  if (candidates.length === 0 && candidateFiles.length > 0) {
    candidates.push({
      kind: "changed-file",
      title: `${summarizeFlowSubject(candidateFiles, "Changed-file", domainLanguage)} smoke ${runner === "manual" ? "checklist" : "flow"}`,
      reason: "Changed files did not match a specialized E2E pattern, so CodeWard generated a conservative smoke path tied only to the changed files.",
      files: candidateFiles,
      steps: [
        "Run or open the nearest workflow that imports the changed files.",
        "Verify the default successful behavior still works.",
        "Verify the most likely error, empty, or unsupported-input state.",
        "Record any project-specific setup needed to make this smoke path runnable.",
      ],
    });
  }

  return candidates;
}

async function buildFlow(
  root: string,
  runner: E2eRunnerName,
  candidate: FlowCandidate,
  testSuiteInventory: TestSuiteInventory,
  fixtureContext: FixtureReadinessContext,
): Promise<E2eFlow | undefined> {
  const files = uniqueStrings(candidate.files).slice(0, 20);
  if (files.length === 0) {
    return undefined;
  }
  const coverage = buildCoverageTargets(candidate.kind, files, runner);
  const setupHints = await inferFlowSetupHints(root, files, candidate.kind);
  const flow: Omit<E2eFlow, "languageBrief"> = {
    title: candidate.title,
    reason: candidate.reason,
    files,
    steps: candidate.steps,
    coverage,
    coverageEvidence: evaluateFlowCoverageEvidence({ title: candidate.title, files, coverage }, testSuiteInventory),
    entrypoints: await inferFlowEntrypoints(root, files, runner),
    setupHints,
    fixtureReadiness: await inferFlowFixtureReadiness(root, files, candidate.kind, setupHints, fixtureContext),
    selectors: await inferFlowSelectors(root, files, runner),
    missingTestability: await findFlowTestabilityGaps(root, files, runner),
  };
  return {
    ...flow,
    languageBrief: buildFlowLanguageBrief(flow),
  };
}

async function inferFlowEntrypoints(root: string, files: string[], runner: E2eRunnerName): Promise<E2eEntrypoint[]> {
  const entrypoints: E2eEntrypoint[] = [];
  for (const file of files.slice(0, 10)) {
    entrypoints.push(...entrypointsFromPath(file, runner));
    const text = await readTextIfExists(path.join(root, file));
    if (text) {
      entrypoints.push(...entrypointsFromText(file, text, runner));
    }
  }
  return uniqueEntrypoints(entrypoints).slice(0, 6);
}

async function inferFlowSetupHints(root: string, files: string[], kind: E2eFlowKind): Promise<E2eSetupHint[]> {
  const hints: E2eSetupHint[] = [];
  const fileTexts: Array<{ file: string; text: string }> = [];
  for (const file of files.slice(0, 12)) {
    const text = await readTextIfExists(path.join(root, file));
    if (text) {
      fileTexts.push({ file, text });
    }
  }

  const filesText = files.join("\n");
  const combinedText = `${filesText}\n${fileTexts.map((item) => item.text).join("\n")}`;
  const matchingFiles = (pattern: RegExp) =>
    uniqueStrings([
      ...files.filter((file) => pattern.test(file)),
      ...fileTexts.filter((item) => pattern.test(item.text)).map((item) => item.file),
    ]).slice(0, maxFilesPerFlow);

  if (/(?:^|\/|[-_])(auth|session|login|logout|permission|permissions|guard|guards|token|jwt)(?:\/|[-_.]|$)/i.test(combinedText)) {
    const authFiles = matchingFiles(/auth|session|login|logout|permission|guard|token|jwt/i);
    hints.push(
      setupHint(
        "auth",
        "Authenticated session setup",
        "Prepare logged-in, anonymous, expired-session, and permission-denied states before making this draft required.",
        authFiles,
        "high",
      ),
    );
  }

  if (kind === "api" || /(?:fetch|axios|graphql|trpc|rpc|client|endpoint|request|response|msw|nock|mock|\/api\/)/i.test(combinedText)) {
    const networkFiles = matchingFiles(/api|client|endpoint|request|response|graphql|trpc|rpc|fetch|axios|msw|nock|mock/i);
    hints.push(
      setupHint(
        "network",
        "Network response setup",
        "Seed or mock success, empty, unauthorized, timeout, and server-error responses that the changed path can surface.",
        networkFiles,
        kind === "api" ? "high" : "medium",
      ),
    );
  }

  if (/(?:fixture|fixtures|factory|factories|seed|seeds|mock|mocks|faker|test-data|testData)/i.test(combinedText)) {
    const fixtureFiles = matchingFiles(/fixture|factory|seed|mock|faker|test-data|testData/i);
    hints.push(
      setupHint(
        "fixture",
        "Fixture data setup",
        "Reuse or create deterministic fixture data for the primary success case and one blocked or empty case.",
        fixtureFiles,
        "medium",
      ),
    );
  }

  if (/(?:\.env|environment|process\.env|feature-?flag|experiments?|remoteConfig|config|eas\.json|app\.config)/i.test(combinedText)) {
    const environmentFiles = matchingFiles(/\.env|environment|process\.env|feature-?flag|experiment|remoteConfig|config|eas\.json|app\.config/i);
    hints.push(
      setupHint(
        "environment",
        "Environment and flag setup",
        "Document the env vars, feature flags, build variant, or dependency mode needed before running this flow.",
        environmentFiles,
        kind === "config" ? "high" : "medium",
      ),
    );
  }

  if (/(?:payment|billing|checkout|purchase|subscription|invoice|settlement|stripe|iap|in-app-purchase|storekit|revenuecat)/i.test(combinedText)) {
    const paymentFiles = matchingFiles(/payment|billing|checkout|purchase|subscription|invoice|settlement|stripe|iap|in-app-purchase|storekit|revenuecat/i);
    hints.push(
      setupHint(
        "payment",
        "Payment sandbox setup",
        "Use sandbox credentials or simulated purchase responses, and verify cancellation, declined, and already-owned cases without live transactions.",
        paymentFiles,
        "high",
      ),
    );
  }

  if (kind === "state" || /(?:store|state|cache|provider|context|atom|selector|reducer|storage|localStorage|AsyncStorage)/i.test(combinedText)) {
    const stateFiles = matchingFiles(/store|state|cache|provider|context|atom|selector|reducer|storage|localStorage|AsyncStorage/i);
    hints.push(
      setupHint(
        "state",
        "State reset setup",
        "Reset persisted storage, cache, and provider state before running the flow, then verify refresh or re-entry behavior.",
        stateFiles,
        kind === "state" ? "high" : "medium",
      ),
    );
  }

  return uniqueSetupHints(hints).slice(0, 6);
}

function setupHint(
  kind: E2eSetupHintKind,
  title: string,
  detail: string,
  files: string[],
  confidence: E2eSetupHintConfidence,
): E2eSetupHint {
  return {
    kind,
    title,
    detail,
    files: uniqueStrings(files).slice(0, maxFilesPerFlow),
    confidence,
  };
}

interface FixtureReadinessContext {
  changedBackendFiles: string[];
  changedMockFiles: string[];
  projectMockFiles: string[];
}

async function collectFixtureReadinessContext(root: string, changedFiles: string[]): Promise<FixtureReadinessContext> {
  const projectFiles = await collectProjectFiles(root, 12000);
  return {
    changedBackendFiles: changedFiles.filter(isBackendImplementationFile).slice(0, maxFilesPerFlow),
    changedMockFiles: changedFiles.filter(isMockOrFixtureFile).slice(0, maxFilesPerFlow),
    projectMockFiles: projectFiles.map((file) => file.path).filter(isMockOrFixtureFile).slice(0, maxFilesPerFlow),
  };
}

async function inferFlowFixtureReadiness(
  root: string,
  files: string[],
  kind: E2eFlowKind,
  setupHints: E2eSetupHint[],
  context: FixtureReadinessContext,
): Promise<E2eFixtureReadiness> {
  const apiSignals = await findApiDependencySignals(root, files, kind, setupHints);
  const requiresMock = apiSignals.length > 0 || setupHints.some((hint) => hint.kind === "network" || hint.kind === "payment");
  if (!requiresMock) {
    return {
      status: "not-needed",
      reason: "No API, network, payment, or external-response dependency was detected for this flow.",
      apiSignals: [],
      backendSignals: [],
      mockSignals: [],
      nextActions: [],
    };
  }

  const changedMockSignals = context.changedMockFiles.filter((file) => isRelatedEvidenceFile(file, files));
  const projectMockSignals = context.projectMockFiles.filter((file) => isRelatedEvidenceFile(file, files));
  const backendSignals = context.changedBackendFiles.filter((file) => isRelatedEvidenceFile(file, files));
  const fallbackProjectMockSignals = projectMockSignals.length > 0 ? projectMockSignals : context.projectMockFiles;
  const mockSignals = uniqueStrings([...changedMockSignals, ...fallbackProjectMockSignals]).slice(0, maxFilesPerFlow);

  if (changedMockSignals.length > 0) {
    return {
      status: "ready",
      reason: "This branch includes mock or fixture evidence for an API-dependent flow.",
      apiSignals,
      backendSignals,
      mockSignals,
      nextActions: [
        "Keep deterministic success, empty, unauthorized, and failure fixture cases aligned with the changed flow.",
      ],
    };
  }

  if (context.projectMockFiles.length > 0) {
    return {
      status: "partial",
      reason: "Mock or fixture infrastructure exists, but this branch does not add flow-specific fixture evidence.",
      apiSignals,
      backendSignals,
      mockSignals,
      nextActions: [
        "Add or update the fixture/mock response for this changed flow before making the draft required.",
        "Cover the primary success response and one empty, rejected, or server-error response.",
      ],
    };
  }

  if (backendSignals.length > 0) {
    return {
      status: "partial",
      reason: "Backend or API contract changes exist, but deterministic fixture evidence was not detected.",
      apiSignals,
      backendSignals,
      mockSignals,
      nextActions: [
        "Confirm the test environment can serve the changed API path, or add a mock response for local E2E runs.",
        "Seed realistic response data for success and failure paths.",
      ],
    };
  }

  return {
    status: "missing",
    reason: "This flow appears to depend on API or external response data, but no changed backend, mock, or fixture evidence was detected.",
    apiSignals,
    backendSignals,
    mockSignals,
    nextActions: [
      "Add a deterministic mock or fixture response, such as MSW handlers, Playwright route fulfillment, mock data, or seeded test data.",
      "Include success plus one empty, unauthorized, rejected, timeout, or server-error response.",
    ],
  };
}

async function findApiDependencySignals(
  root: string,
  files: string[],
  kind: E2eFlowKind,
  setupHints: E2eSetupHint[],
): Promise<string[]> {
  const signals = new Set<string>();
  if (kind === "api") {
    for (const file of files.slice(0, maxFilesPerFlow)) {
      signals.add(file);
    }
  }
  for (const hint of setupHints) {
    if (hint.kind === "network" || hint.kind === "payment") {
      for (const file of hint.files) {
        signals.add(file);
      }
    }
  }
  for (const file of files.slice(0, 12)) {
    if (isApiDependencyPath(file)) {
      signals.add(file);
      continue;
    }
    const text = await readTextIfExists(path.join(root, file));
    if (text && hasApiDependencyText(text)) {
      signals.add(file);
    }
  }
  return [...signals].slice(0, maxFilesPerFlow);
}

function isApiDependencyPath(file: string): boolean {
  return /(?:^|\/)(?:api|apis|clients?|endpoints?|queries|mutations|graphql|trpc|services?)\//i.test(file) ||
    /(?:api|client|endpoint|query|mutation|graphql|trpc|request|response)\.[cm]?[jt]sx?$/i.test(file);
}

function hasApiDependencyText(text: string): boolean {
  return /(?:fetch\(|axios\.|graphql|gql`|trpc\.|useQuery|useMutation|queryKey|apiClient|client\.(?:get|post|put|patch|delete)|\/api\/|endpoint|request|response)/i.test(text);
}

function isBackendImplementationFile(file: string): boolean {
  return /(?:^|\/)(?:server|servers|backend|api|apis|routes|controllers?|handlers?|resolvers?|endpoints?)\//i.test(file) ||
    /(?:openapi|swagger|schema|controller|handler|resolver|route)\.(?:json|ya?ml|[cm]?[jt]sx?|py|go|rs|kt|java|rb|php)$/i.test(file);
}

function isMockOrFixtureFile(file: string): boolean {
  return /(?:^|\/)(?:__mocks__|mocks?|fixtures?|factories|seeds?|test-data|testData|msw|mirage)\//i.test(file) ||
    /(?:mock|fixture|factory|seed|handler|msw)\.[cm]?[jt]sx?$/i.test(file);
}

function isRelatedEvidenceFile(evidenceFile: string, flowFiles: string[]): boolean {
  if (flowFiles.length === 0) {
    return true;
  }
  const evidenceTokens = domainTokensForEvidence(evidenceFile);
  const flowTokens = new Set(flowFiles.flatMap(domainTokensForEvidence));
  if (evidenceTokens.some((token) => flowTokens.has(token))) {
    return true;
  }
  return flowFiles.some((file) => sameOrNestedPath(evidenceFile, file));
}

function domainTokensForEvidence(file: string): string[] {
  return file
    .replace(/\.[^.\/]+$/g, "")
    .split("/")
    .flatMap((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^a-zA-Z0-9]+/))
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 2 && !fixtureEvidenceIgnoredTokens.has(part));
}

const fixtureEvidenceIgnoredTokens = new Set([
  "src",
  "app",
  "apps",
  "api",
  "apis",
  "client",
  "clients",
  "component",
  "components",
  "feature",
  "features",
  "fixture",
  "fixtures",
  "handler",
  "handlers",
  "mock",
  "mocks",
  "page",
  "pages",
  "route",
  "routes",
  "screen",
  "screens",
  "service",
  "services",
  "test",
  "tests",
]);

async function inferFlowSelectors(root: string, files: string[], runner: E2eRunnerName): Promise<E2eSelector[]> {
  const selectors: E2eSelector[] = [];
  for (const file of files.slice(0, 8)) {
    if (!isUiImplementationFile(file)) {
      continue;
    }
    const text = await readTextIfExists(path.join(root, file));
    if (!text) {
      continue;
    }
    selectors.push(...extractSelectorsFromText(file, text, runner));
  }
  return uniqueSelectors(selectors).slice(0, 12);
}

function entrypointsFromPath(file: string, runner: E2eRunnerName): E2eEntrypoint[] {
  const entrypoints: E2eEntrypoint[] = [];
  const route = routeEntrypointFromPath(file);
  if (route && runner !== "maestro") {
    entrypoints.push({
      kind: "route",
      value: route.value,
      file,
      confidence: route.confidence,
    });
  }

  const screen = screenEntrypointFromPath(file);
  if (screen && runner !== "playwright") {
    entrypoints.push({
      kind: "screen",
      value: screen.value,
      file,
      confidence: screen.confidence,
    });
  }
  return entrypoints;
}

function entrypointsFromText(file: string, text: string, runner: E2eRunnerName): E2eEntrypoint[] {
  const entrypoints: E2eEntrypoint[] = [];
  if (runner !== "maestro") {
    const routeMatcher =
      /(?:href|to)\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*["']([^"']+)["']\s*\})|(?:router\.(?:push|replace)|navigate)\(\s*["']([^"']+)["']/g;
    for (const match of text.matchAll(routeMatcher)) {
      const route = normalizeEntrypointRoute(match[1] ?? match[2] ?? match[3] ?? match[4]);
      if (route) {
        entrypoints.push({ kind: "route", value: route, file, confidence: "medium" });
      }
    }
  }

  if (runner !== "playwright") {
    const screenMatcher = /(?:navigation\.)?navigate\(\s*["']([^"'/]{2,80})["']|name\s*=\s*["']([^"'/]{2,80})["']/g;
    for (const match of text.matchAll(screenMatcher)) {
      const screen = normalizeScreenName(match[1] ?? match[2]);
      if (screen) {
        entrypoints.push({ kind: "screen", value: screen, file, confidence: "medium" });
      }
    }
  }
  return entrypoints;
}

function routeEntrypointFromPath(
  file: string,
): { value: string; confidence: E2eEntrypointConfidence } | undefined {
  if (!isPotentialRouteEntrypointFile(file)) {
    return undefined;
  }
  const segments = file.split("/");
  const appIndex = lastIndexOfAny(segments, ["app"]);
  const pageIndex = lastIndexOfAny(segments, ["pages", "routes"]);
  const routeRootIndex = appIndex >= 0 ? appIndex : pageIndex;
  if (routeRootIndex < 0) {
    return undefined;
  }

  const rawRouteSegments = segments.slice(routeRootIndex + 1);
  const routeSegments = normalizeRouteSegments(rawRouteSegments);
  const value = formatRoutePath(routeSegments);
  if (!value) {
    return undefined;
  }

  return { value, confidence: "high" };
}

function screenEntrypointFromPath(
  file: string,
): { value: string; confidence: E2eEntrypointConfidence } | undefined {
  if (!isPotentialScreenEntrypointFile(file)) {
    return undefined;
  }
  const basename = stripKnownExtension(path.basename(file));
  if (!basename || /^use[A-Z]/.test(basename) || /^(?:index|_layout|layout|page|route)$/i.test(basename)) {
    return undefined;
  }
  const stripped = basename.replace(/(?:Route)?Screen$/i, "").replace(/Page$/i, "");
  const screen = normalizeScreenName(stripped);
  if (!screen) {
    return undefined;
  }
  const confidence = /(?:Route)?Screen$|Page$/i.test(basename) || /(?:^|\/)(?:screens?|navigations?)\//i.test(file)
    ? "high"
    : "medium";
  return { value: screen, confidence };
}

function isPotentialRouteEntrypointFile(file: string): boolean {
  return isUiImplementationFile(file) || /(?:^|\/)(?:app|pages|routes)\/.*(?:page|route)\.[cm]?[jt]sx?$/i.test(file);
}

function isPotentialScreenEntrypointFile(file: string): boolean {
  return isUiImplementationFile(file) || /(?:^|\/)(?:screens?|navigations?)\//i.test(file);
}

function normalizeRouteSegments(rawSegments: string[]): string[] {
  const routeSegments: string[] = [];
  for (const [index, segment] of rawSegments.entries()) {
    const normalized = normalizeRouteSegment(segment);
    if (!normalized) {
      continue;
    }
    const isLeaf = index === rawSegments.length - 1;
    const parent = routeSegments.at(-1);
    if (isLeaf && shouldDropRouteLeaf(normalized, parent)) {
      continue;
    }
    routeSegments.push(normalized);
  }
  return routeSegments;
}

function normalizeRouteSegment(segment: string): string | undefined {
  const stem = stripKnownExtension(segment);
  if (!stem || /^\([^)]*\)$/.test(stem) || stem.startsWith("_")) {
    return undefined;
  }
  if (/^(?:index|page|route|layout|template|loading|error|not-found|404|500)$/i.test(stem)) {
    return undefined;
  }
  const dynamic = dynamicRouteSegmentName(stem);
  if (dynamic) {
    return `:${normalizeRouteParamName(dynamic)}`;
  }
  return slugify(stem.replace(/Page$/i, ""));
}

function dynamicRouteSegmentName(segment: string): string | undefined {
  const catchAll = segment.match(/^\[{1,2}\.\.\.([^[\]]+)\]{1,2}$/);
  if (catchAll?.[1]) {
    return catchAll[1];
  }
  const simple = segment.match(/^\[([^[\].]+)\]$/);
  return simple?.[1];
}

function normalizeRouteParamName(value: string): string {
  const parts = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean);
  const normalized = parts
    .map((part, index) => {
      const lower = part.charAt(0).toLowerCase() + part.slice(1);
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join("")
    .replace(/^[^A-Za-z_$]+/, "");
  return normalized || "param";
}

function shouldDropRouteLeaf(leaf: string, parent: string | undefined): boolean {
  return Boolean(parent && leaf === parent);
}

function normalizeEntrypointRoute(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || /^\/\//.test(value) || /[{}]/.test(value)) {
    return undefined;
  }
  const withoutQuery = value.split(/[?#]/)[0];
  return withoutQuery.length > 0 && withoutQuery.length <= 120 ? withoutQuery : undefined;
}

function normalizeScreenName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim();
  if (!normalized || normalized.length > 80 || /[{}()[\]=>/]/.test(normalized)) {
    return undefined;
  }
  return titleCase(normalized);
}

function formatRoutePath(routeSegments: string[]): string | undefined {
  if (routeSegments.length === 0) {
    return "/";
  }
  return `/${routeSegments.join("/")}`;
}

function lastIndexOfAny(values: string[], candidates: string[]): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (candidates.includes(values[index])) {
      return index;
    }
  }
  return -1;
}

function stripKnownExtension(file: string): string {
  return file.replace(/\.(?:d\.)?(?:[cm]?[jt]sx?|vue|svelte|mdx?)$/i, "");
}

async function findFlowTestabilityGaps(root: string, files: string[], runner: E2eRunnerName): Promise<string[]> {
  const gaps: string[] = [];
  for (const file of files.slice(0, 8)) {
    if (!isUiImplementationFile(file)) {
      continue;
    }
    const text = await readTextIfExists(path.join(root, file));
    if (!text) {
      continue;
    }
    if (hasInteractiveUi(text) && !hasStableSelector(text, runner)) {
      gaps.push(`Add stable ${selectorName(runner)} selectors in ${file} for the controls this flow taps or types into.`);
    }
  }
  return uniqueStrings(gaps);
}

async function buildGlobalTestabilityGaps(root: string, runner: E2eRunnerName): Promise<string[]> {
  if (runner === "maestro") {
    const hasMaestro = (await exists(path.join(root, ".maestro"))) || (await exists(path.join(root, "maestro.yaml")));
    return hasMaestro ? [] : ["No .maestro directory was found for runnable mobile flow drafts."];
  }
  if (runner === "playwright") {
    const hasPlaywrightConfig = await hasAnyFile(root, [
      "playwright.config.ts",
      "playwright.config.js",
      "playwright.config.mjs",
    ]);
    return hasPlaywrightConfig ? [] : ["No Playwright config was found for runnable browser specs."];
  }
  return [];
}

async function buildSetupNotes(
  root: string,
  runner: E2eRunnerName,
  project: E2eProjectProfile,
): Promise<string[]> {
  if (runner === "maestro") {
    const packageJson = await readPackageJson(root);
    const scripts = packageJson?.scripts ?? {};
    const launchCommands = ["ios", "android", "start"].filter((script) => scripts[script]).map((script) => `pnpm ${script}`);
    return [
      "Generated Maestro drafts should prefer visible text plus testID selectors for controls that text cannot identify.",
      launchCommands.length > 0
        ? `Likely app launch commands before running a flow: ${launchCommands.join(", ")}.`
        : "Add a documented simulator or device launch command before making the E2E draft required.",
    ];
  }
  if (runner === "playwright") {
    return [
      "Generated Playwright drafts should prefer role-based locators, then data-testid selectors for custom controls.",
      project.evidence.some((item) => /Playwright/.test(item))
        ? "Playwright is already present in package.json."
        : "Add @playwright/test before making generated browser specs required in CI.",
    ];
  }
  return ["Choose an E2E runner after documenting the primary user-facing entry point for this project."];
}

function isUserFacingFile(file: string): boolean {
  if (isApiRouteFile(file)) {
    return false;
  }
  return (
    /(?:^|\/)(app|pages|routes|screens|components|ui|navigation)\//i.test(file) ||
    /\.(?:tsx|jsx|vue|svelte)$/i.test(file)
  );
}

function isApiRouteFile(file: string): boolean {
  return /(?:^|\/)(?:app|pages|routes)\/api\//i.test(file);
}

function isDomainOwnedFile(file: string): boolean {
  return /(?:^|\/)(?:features|domains|modules|services|entities|packages|apps)\/[^/]+/i.test(file);
}

function isApiLikeFile(file: string): boolean {
  const tokens = pathWordTokens(file);
  const strongApiTokens = new Set([
    "api",
    "apis",
    "client",
    "clients",
    "queries",
    "query",
    "mutations",
    "mutation",
    "graphql",
    "trpc",
    "rpc",
    "proto",
    "openapi",
    "swagger",
    "endpoint",
    "endpoints",
  ]);
  return (
    isApiRouteFile(file) ||
    /(?:^|\/)(?:api|apis|endpoints?|controllers?|handlers?)\//i.test(file) ||
    tokens.some((token) => strongApiTokens.has(token)) ||
    (!isUiImplementationFile(file) && tokens.some((token) => token === "request" || token === "response"))
  );
}

function isStateLikeFile(file: string): boolean {
  return (
    /(?:^|\/)(?:stores?|states?|reducers?|atoms?|selectors?|contexts?|providers?|cache|session|auth|permissions?|guards?)\//i.test(
      file,
    ) || /(?:^|\/)[^/]*(?:auth|permission|session|cache|guard|state|store|context|provider)[^/]*\.[cm]?[jt]sx?$/i.test(file)
  );
}

function isContentOrStyleFile(file: string): boolean {
  return /(?:theme|themes|i18n|locale|locales|translation|translations|copy|styles?|tokens?|\.css|\.scss|\.sass|\.less)/i.test(
    file,
  );
}

function isConfigLikeFile(file: string): boolean {
  return /(?:(?:^|\/)(?:\.agents?|\.claude|\.cursor|\.dev|\.gemini|\.github|docs?)\/|(?:^|\/)(?:AGENTS|CLAUDE|CODEX|DECISIONS|GEMINI|PLAN|README|SKILL)\.md$|\.gitignore|package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb|pyproject\.toml|requirements\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|gradle\.properties|vite|webpack|babel|tsconfig|next\.config|app\.config|eas\.json|release-please|docker|env|feature-?flags?|experiments?)/i.test(
    file,
  );
}

function isTestLikeFile(file: string): boolean {
  return (
    /(?:^|\/)(?:__tests__|tests?|specs?|e2e)\//i.test(file) ||
    /(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/i.test(file) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(file) ||
    /(?:^|\/)[^/]+_test\.(?:py|go)$/i.test(file) ||
    /(?:^|\/)[^/]+(?:Test|Tests|Spec)\.(?:java|kt|cs|swift)$/i.test(file) ||
    /(?:^|\/)[^/]+_(?:test|spec)\.rs$/i.test(file)
  );
}

function isUiImplementationFile(file: string): boolean {
  return /\.(?:tsx|jsx|vue|svelte)$/i.test(file);
}

function isServiceSourceFile(file: string): boolean {
  return /(?:^|\/)src\/.+\.(?:[cm]?[jt]s|py|go|rs|java|kt|cs)$/i.test(file);
}

function summarizeFlowSubject(files: string[], fallback: string, domainLanguage?: DomainLanguageSummary): string {
  const languageSubject = summarizeFlowSubjectFromDomainLanguage(files, domainLanguage);
  if (languageSubject) {
    return languageSubject;
  }

  const labelCounts = countLabels(files.flatMap(labelCandidatesFromPath));
  if (labelCounts.length === 0) {
    return fallback;
  }
  const total = labelCounts.reduce((sum, label) => sum + label.count, 0);
  if (labelCounts.length > 4 && labelCounts[0].count / total < 0.4) {
    return fallback;
  }

  const representativeLabels = labelCounts
    .filter((label) => labelCounts.length <= 2 || label.count > 1 || label.count / total >= 0.25)
    .slice(0, 2);
  if (representativeLabels.length === 0) {
    return fallback;
  }
  return representativeLabels.map((label) => titleCase(label.value)).join(" / ");
}

function summarizeFlowSubjectFromDomainLanguage(
  files: string[],
  domainLanguage: DomainLanguageSummary | undefined,
): string | undefined {
  if (!domainLanguage) {
    return undefined;
  }
  const scenario = domainLanguage.scenarios
    .filter((item) => item.source === "core-flow" || item.source === "domain-manifest")
    .filter((item) => filesOverlap(files, item.files))
    .sort(compareDomainScenariosForSubject)[0];
  if (scenario) {
    return scenario.title;
  }

  const term = domainLanguage.terms
    .filter((item) => filesOverlap(files, item.files))
    .sort(compareDomainTermsForSubject)[0];
  return term?.term;
}

function compareDomainScenariosForSubject(
  left: DomainScenarioSuggestion,
  right: DomainScenarioSuggestion,
): number {
  const leftRank = left.source === "core-flow" ? 2 : 1;
  const rightRank = right.source === "core-flow" ? 2 : 1;
  return rightRank - leftRank || left.title.localeCompare(right.title);
}

function compareDomainTermsForSubject(
  left: DomainLanguageSummary["terms"][number],
  right: DomainLanguageSummary["terms"][number],
): number {
  return domainTermRank(right) - domainTermRank(left) || left.term.localeCompare(right.term);
}

function domainTermRank(term: DomainLanguageSummary["terms"][number]): number {
  const sourceRank =
    term.source === "core-flow" ? 30 : term.source === "domain-manifest" ? 20 : term.source === "changed-file" ? 10 : 0;
  const confidenceRank = term.confidence === "high" ? 3 : term.confidence === "medium" ? 2 : 1;
  return sourceRank + confidenceRank;
}

function filesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftFile) => right.some((rightFile) => sameOrNestedFileReference(leftFile, rightFile)));
}

function sameOrNestedFileReference(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparisonPath(left);
  const normalizedRight = normalizeComparisonPath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

function normalizeComparisonPath(file: string): string {
  return toPosixPath(file).replace(/^\.\/+/, "").replace(/\/+$/g, "");
}

function countLabels(labels: string[]): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count);
}

function pathWordTokens(file: string): string[] {
  return uniqueStrings(
    file
      .replace(/\.[^.\/]+$/g, "")
      .split("/")
      .flatMap((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^a-zA-Z0-9]+/))
      .map((part) => part.toLowerCase())
      .filter(Boolean),
  );
}

function labelCandidatesFromPath(file: string): string[] {
  const domain = domainFromPath(file);
  if (domain) {
    return [domain];
  }

  const surface = surfaceFromPath(file);
  if (surface) {
    return [surface];
  }

  const serviceDomain = serviceDomainFromPath(file);
  if (serviceDomain) {
    return [serviceDomain];
  }

  const stem = normalizePathSegment(path.basename(file));
  return stem ? [stem] : [];
}

function domainFromPath(file: string): string | undefined {
  const segments = file.split("/");
  for (const key of ["features", "domains", "modules", "services", "entities", "packages", "apps"]) {
    const index = segments.indexOf(key);
    const candidate = index >= 0 ? normalizePathSegment(segments[index + 1]) : undefined;
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function surfaceFromPath(file: string): string | undefined {
  const segments = file.split("/");
  for (const key of ["app", "pages", "routes", "screens"]) {
    const index = segments.indexOf(key);
    if (index < 0) {
      continue;
    }
    for (const segment of segments.slice(index + 1)) {
      const candidate = normalizePathSegment(segment);
      if (candidate) {
        return candidate;
      }
    }
  }
  return undefined;
}

function serviceDomainFromPath(file: string): string | undefined {
  const segments = file.split("/");
  const srcIndex = segments.indexOf("src");
  if (srcIndex < 0) {
    return undefined;
  }
  for (const segment of segments.slice(srcIndex + 1)) {
    const candidate = normalizePathSegment(segment);
    if (!candidate || isVersionSegment(candidate) || isBackendStructuralLabel(candidate)) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

function normalizePathSegment(segment: string | undefined): string | undefined {
  if (!segment) {
    return undefined;
  }
  if (/^\([^)]*\)$/.test(segment) || /^\[[^]]+\]$/.test(segment)) {
    return undefined;
  }
  const normalized = segment
    .replace(/\.(?:d\.)?(?:[cm]?[jt]sx?|vue|svelte|css|scss|sass|less|json|ya?ml|md|py|go|rs|kt|java|swift|cs)$/i, "")
    .replace(/^_+|_+$/g, "")
    .trim();
  return isMeaningfulLabel(normalized) ? normalized : undefined;
}

function isVersionSegment(value: string): boolean {
  return /^v?\d+(?:\.\d+)?$/i.test(value);
}

function isBackendStructuralLabel(value: string): boolean {
  return new Set([
    "common",
    "commons",
    "controller",
    "controllers",
    "core",
    "handler",
    "handlers",
    "helper",
    "helpers",
    "interface",
    "interfaces",
    "lib",
    "libs",
    "middleware",
    "middlewares",
    "model",
    "models",
    "schema",
    "schemas",
    "shared",
  ]).has(value.toLowerCase());
}

function isMeaningfulLabel(value: string): boolean {
  const normalized = value.toLowerCase();
  const ignored = new Set([
    "api",
    "apis",
    "agent",
    "agents",
    "app",
    "apps",
    "client",
    "changelog",
    "claude",
    "component",
    "components",
    "config",
    "configs",
    "constant",
    "constants",
    "context",
    "contexts",
    "default",
    "development",
    "decisions",
    "env",
    "gemini",
    "gitignore",
    "hook",
    "hooks",
    "index",
    "init",
    "layout",
    "main",
    "module",
    "modules",
    "navigation",
    "navigations",
    "page",
    "pages",
    "package",
    "plan",
    "production",
    "provider",
    "providers",
    "readme",
    "release",
    "route",
    "routes",
    "screen",
    "screens",
    "server",
    "service",
    "services",
    "skill",
    "src",
    "staging",
    "state",
    "store",
    "style",
    "styles",
    "test",
    "tests",
    "type",
    "types",
    "ui",
    "util",
    "utils",
  ]);
  return normalized.length > 1 && !ignored.has(normalized);
}

function titleCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      if (/^[A-Z0-9]+$/.test(part)) {
        return part;
      }
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function hasInteractiveUi(text: string): boolean {
  return /\b(?:Pressable|Touchable\w*|Button|TextInput|Switch|Slider|Gesture|Canvas|Svg)\b|on(?:Press|Click|Change|Submit|Touch)/.test(
    text,
  );
}

function hasStableSelector(text: string, runner: E2eRunnerName): boolean {
  if (runner === "playwright") {
    return /\b(?:data-testid|data-test|aria-label|role)=/.test(text);
  }
  if (runner === "manual") {
    return /\b(?:data-testid|data-test|aria-label|role|testID|accessibilityLabel)=/.test(text);
  }
  return /\b(?:testID|accessibilityLabel)=/.test(text);
}

function selectorName(runner: E2eRunnerName): string {
  if (runner === "playwright") {
    return "data-testid or accessible role";
  }
  if (runner === "manual") {
    return "data-testid, testID, or accessible label";
  }
  return "testID or accessibilityLabel";
}

function dedupeFlows(flows: E2eFlow[]): E2eFlow[] {
  const seenFiles = new Set<string>();
  const deduped: E2eFlow[] = [];
  for (const flow of flows) {
    const newFiles = flow.files.filter((file) => !seenFiles.has(file));
    if (newFiles.length === 0) {
      continue;
    }
    for (const file of newFiles) {
      seenFiles.add(file);
    }
    deduped.push({
      ...flow,
      files: newFiles,
    });
  }
  return deduped;
}

async function buildDraftFlows(plan: E2ePlanResult): Promise<DraftE2eFlow[]> {
  const baseFlows = plan.flows.length > 0 ? plan.flows : [buildFallbackFlow(plan)];
  const scenarioFlows = await Promise.all(
    plan.domainLanguage.scenarios
      .filter((scenario) => scenario.files.length > 0 || scenario.source === "core-flow")
      .slice(0, 4)
      .map((scenario) => buildDomainScenarioDraftFlow(plan, scenario, baseFlows)),
  );

  if (scenarioFlows.length === 0) {
    return baseFlows.map((flow) => ({
      ...flow,
      draftSource: "heuristic",
    }));
  }

  const combined = dedupeFlows([...scenarioFlows, ...baseFlows]).slice(0, 4);
  return combined.map((flow) => ({
    ...flow,
    draftSource: draftFlowSource(flow),
  }));
}

async function buildDomainScenarioDraftFlow(
  plan: E2ePlanResult,
  scenario: DomainScenarioSuggestion,
  baseFlows: E2eFlow[],
): Promise<DraftE2eFlow> {
  const coreFlow = matchedCoreFlowForScenario(plan, scenario);
  const baseFlow = bestBaseFlowForScenario(scenario, baseFlows);
  const apiContractScenario = isApiContractDomainScenario(scenario, baseFlow);
  const title = domainScenarioDraftTitle(scenario, apiContractScenario);
  const reason = domainScenarioDraftIntent(scenario, apiContractScenario);
  const steps = domainScenarioDraftSteps(scenario, baseFlow, apiContractScenario);
  const draftScenario = apiContractScenario
    ? {
        ...scenario,
        title,
        intent: reason,
        checks: steps,
      }
    : scenario;
  const scenarioFiles = normalizeScenarioFilesForRoot(plan, scenario.files);
  const files = uniqueStrings(scenarioFiles.length > 0 ? scenarioFiles : (baseFlow?.files ?? [])).slice(0, 20);
  const coverage = baseFlow?.coverage ?? buildCoverageTargets("domain", files, plan.recommendedRunner.name);
  const runner = plan.recommendedRunner.name;
  const entrypoints = uniqueEntrypoints([
    ...domainScenarioEntrypoints(plan, scenario, runner),
    ...coreFlowEntrypoints(plan, coreFlow, runner),
    ...filterEntrypointsForFiles(baseFlows.flatMap((flow) => flow.entrypoints), files),
    ...(await inferFlowEntrypoints(plan.root, files, runner)),
  ]);
  const selectors = uniqueSelectors([
    ...filterSelectorsForFiles(baseFlows.flatMap((flow) => flow.selectors), files),
    ...(await inferFlowSelectors(plan.root, files, runner)),
  ]);
  const setupHints = uniqueSetupHints([
    ...filterSetupHintsForFiles(baseFlows.flatMap((flow) => flow.setupHints), files),
    ...(await inferFlowSetupHints(plan.root, files, "domain")),
  ]);
  const flow: Omit<DraftE2eFlow, "languageBrief"> = {
    title,
    reason,
    files,
    steps,
    coverage,
    coverageEvidence: baseFlow?.coverageEvidence ?? [],
    entrypoints,
    setupHints,
    fixtureReadiness: scenarioFixtureReadiness(baseFlow, setupHints),
    selectors,
    missingTestability: await findFlowTestabilityGaps(plan.root, files, runner),
    draftSource: scenario.source === "core-flow" ? "core-flow" : "domain-language",
    domainScenario: draftScenario,
    coreFlow,
  };
  return {
    ...flow,
    languageBrief: buildFlowLanguageBrief(flow),
  };
}

function isApiContractDomainScenario(scenario: DomainScenarioSuggestion, baseFlow: E2eFlow | undefined): boolean {
  return scenario.source === "changed-file" && Boolean(baseFlow && isApiContractFocusedFlow(baseFlow));
}

function domainScenarioDraftTitle(scenario: DomainScenarioSuggestion, apiContractScenario: boolean): string {
  if (!apiContractScenario) {
    return scenario.title;
  }
  return `${scenario.title.replace(/\s+primary journey$/i, "")} API contract`;
}

function domainScenarioDraftIntent(scenario: DomainScenarioSuggestion, apiContractScenario: boolean): string {
  if (!apiContractScenario) {
    return scenario.intent;
  }
  return `Verify "${scenario.title.replace(/\s+primary journey$/i, "")}" through the changed API or service contract instead of assuming a browser or device journey.`;
}

function domainScenarioDraftSteps(
  scenario: DomainScenarioSuggestion,
  baseFlow: E2eFlow | undefined,
  apiContractScenario: boolean,
): string[] {
  if (apiContractScenario && baseFlow) {
    return baseFlow.steps;
  }
  return scenario.checks.length > 0 ? scenario.checks : (baseFlow?.steps ?? []);
}

function matchedCoreFlowForScenario(
  plan: E2ePlanResult,
  scenario: DomainScenarioSuggestion,
): MatchedCoreFlow | undefined {
  if (scenario.source !== "core-flow") {
    return undefined;
  }
  return plan.coreFlows.find((flow) => flow.name === scenario.title);
}

function scenarioFixtureReadiness(
  baseFlow: E2eFlow | undefined,
  setupHints: E2eSetupHint[],
): E2eFixtureReadiness {
  if (baseFlow) {
    return baseFlow.fixtureReadiness;
  }
  const needsResponseSetup = setupHints.some((hint) => hint.kind === "network" || hint.kind === "payment" || hint.kind === "fixture");
  if (!needsResponseSetup) {
    return {
      status: "not-needed",
      reason: "No API, network, payment, or external-response dependency was detected for this scenario.",
      apiSignals: [],
      backendSignals: [],
      mockSignals: [],
      nextActions: [],
    };
  }
  return {
    status: "missing",
    reason: "This scenario has response or fixture setup hints, but no base flow fixture evidence was available.",
    apiSignals: setupHints.flatMap((hint) => hint.files).slice(0, maxFilesPerFlow),
    backendSignals: [],
    mockSignals: [],
    nextActions: [
      "Add a deterministic mock or fixture response before making this generated scenario required.",
      "Cover the primary success response and one empty, rejected, or server-error response.",
    ],
  };
}

function normalizeScenarioFilesForRoot(plan: E2ePlanResult, files: string[]): string[] {
  if (!plan.workspaceRoot) {
    return files;
  }
  const packagePathFromWorkspace = toPosixPath(path.relative(plan.workspaceRoot, plan.root));
  if (!packagePathFromWorkspace || packagePathFromWorkspace.startsWith("..") || path.isAbsolute(packagePathFromWorkspace)) {
    return files;
  }
  return files.map((file) =>
    file === packagePathFromWorkspace || file.startsWith(`${packagePathFromWorkspace}/`)
      ? file.slice(packagePathFromWorkspace.length).replace(/^\/+/, "")
      : file,
  );
}

function domainScenarioEntrypoints(
  plan: E2ePlanResult,
  scenario: DomainScenarioSuggestion,
  runner: E2eRunnerName,
): E2eEntrypoint[] {
  if (runner === "maestro" || scenario.source !== "domain-manifest" || !scenario.routes || scenario.routes.length === 0) {
    return [];
  }
  const manifestPath = plan.domainManifestPath ?? defaultDomainManifestPath;
  return scenario.routes
    .map((route) => normalizeEntrypointRoute(route))
    .filter((route): route is string => Boolean(route))
    .map((route) => ({
      kind: "route",
      value: route,
      file: manifestPath,
      confidence: "high",
    }));
}

function coreFlowEntrypoints(
  plan: E2ePlanResult,
  coreFlow: MatchedCoreFlow | undefined,
  runner: E2eRunnerName,
): E2eEntrypoint[] {
  if (!coreFlow || runner === "maestro") {
    return [];
  }
  const manifestPath = plan.coreFlowManifestPath ?? ".codeward/flows.yml";
  return coreFlow.routes
    .map((route) => normalizeEntrypointRoute(route))
    .filter((route): route is string => Boolean(route))
    .map((route) => ({
      kind: "route",
      value: route,
      file: manifestPath,
      confidence: "high",
    }));
}

function filterEntrypointsForFiles(entrypoints: E2eEntrypoint[], files: string[]): E2eEntrypoint[] {
  return entrypoints.filter((entrypoint) => files.some((file) => sameOrNestedPath(entrypoint.file, file)));
}

function filterSelectorsForFiles(selectors: E2eSelector[], files: string[]): E2eSelector[] {
  return selectors.filter((selector) => files.some((file) => sameOrNestedPath(selector.file, file)));
}

function filterSetupHintsForFiles(setupHints: E2eSetupHint[], files: string[]): E2eSetupHint[] {
  return setupHints
    .map((hint) => ({
      ...hint,
      files: hint.files.filter((file) => files.some((targetFile) => sameOrNestedPath(file, targetFile))),
    }))
    .filter((hint) => hint.files.length > 0);
}

function sameOrNestedPath(left: string, right: string): boolean {
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function bestBaseFlowForScenario(
  scenario: DomainScenarioSuggestion,
  baseFlows: E2eFlow[],
): E2eFlow | undefined {
  let best: { flow: E2eFlow; score: number } | undefined;
  for (const flow of baseFlows) {
    const score = fileOverlapScore(scenario.files, flow.files);
    if (!best || score > best.score) {
      best = { flow, score };
    }
  }
  return best && best.score > 0 ? best.flow : baseFlows[0];
}

function fileOverlapScore(leftFiles: string[], rightFiles: string[]): number {
  let score = 0;
  for (const left of leftFiles) {
    for (const right of rightFiles) {
      if (left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)) {
        score += 3;
      } else if (path.dirname(left) === path.dirname(right)) {
        score += 1;
      }
    }
  }
  return score;
}

function draftFlowSource(flow: E2eFlow): DraftFlowSource {
  const draftFlow = flow as DraftE2eFlow;
  return draftFlow.draftSource ?? "heuristic";
}

function domainScenarioForFlow(flow: E2eFlow): DomainScenarioSuggestion | undefined {
  return (flow as DraftE2eFlow).domainScenario;
}

function draftStability(
  plan: E2ePlanResult,
  flow: E2eFlow,
): "ready" | "needs-selector" | "needs-setup" | "needs-selector-and-setup" {
  const needsSelector = flow.missingTestability.length > 0;
  const needsSetup = plan.missingTestability.some((gap) => /No \.maestro|No Playwright config/i.test(gap));
  if (needsSelector && needsSetup) {
    return "needs-selector-and-setup";
  }
  if (needsSelector) {
    return "needs-selector";
  }
  if (needsSetup) {
    return "needs-setup";
  }
  return "ready";
}

function draftExecutionBlockers(
  plan: E2ePlanResult,
  flow: E2eFlow,
  runner: E2eRunnerName,
  validationSummary: ReturnType<typeof summarizeDraftValidation>,
  selfCheck?: E2eDraftSelfCheck,
): string[] {
  const blockers = [...plan.executionProfile.blockers];
  if (runner !== "manual" && flow.entrypoints.length === 0) {
    blockers.push("No runnable route, screen, or command entrypoint was inferred for this flow.");
  }
  if (flow.missingTestability.length > 0) {
    blockers.push(flow.missingTestability[0]);
  }
  if (flow.fixtureReadiness.status === "missing") {
    blockers.push(flow.fixtureReadiness.nextActions[0] ?? flow.fixtureReadiness.reason);
  }
  if (validationSummary.blockingGapCount > 0) {
    blockers.push(`${validationSummary.blockingGapCount} blocking validation gap${validationSummary.blockingGapCount === 1 ? "" : "s"} remain.`);
  }
  if (selfCheck?.status === "fail") {
    blockers.push(...selfCheck.blockers);
  }
  return uniqueStrings(blockers).slice(0, 8);
}

function draftRunnableStatus(
  plan: E2ePlanResult,
  flow: E2eFlow,
  runner: E2eRunnerName,
  validationSummary: ReturnType<typeof summarizeDraftValidation>,
  executionBlockers: string[],
  selfCheck?: E2eDraftSelfCheck,
): "runnable-candidate" | "near-runnable" | "review-only" {
  if (runner === "manual") {
    return "review-only";
  }
  if (selfCheck?.status === "fail") {
    return "review-only";
  }
  if (
    executionBlockers.length === 0 &&
    validationSummary.blockingGapCount === 0 &&
    flow.missingTestability.length === 0 &&
    (flow.fixtureReadiness.status === "ready" || flow.fixtureReadiness.status === "not-needed") &&
    selfCheck?.status === "pass"
  ) {
    return "runnable-candidate";
  }
  if (plan.executionProfile.confidence !== "low" && flow.entrypoints.length > 0) {
    return "near-runnable";
  }
  return "review-only";
}

function evaluateDraftSelfCheck(
  plan: E2ePlanResult,
  flow: E2eFlow,
  runner: E2eRunnerName,
  content: string,
  todoCount: number,
): E2eDraftSelfCheck {
  if (runner === "playwright") {
    return evaluatePlaywrightDraftSelfCheck(plan, flow, content, todoCount);
  }
  if (runner === "maestro") {
    return evaluateMaestroDraftSelfCheck(plan, content, todoCount);
  }
  return buildDraftSelfCheck(
    "warning",
    "Manual checklist output cannot be runner-checked automatically.",
    undefined,
    [
      draftSelfCheckItem(
        "Manual runner",
        "warning",
        "Manual E2E drafts are review evidence until the project declares a runnable runner.",
      ),
    ],
  );
}

function evaluatePlaywrightDraftSelfCheck(
  plan: E2ePlanResult,
  flow: E2eFlow,
  content: string,
  todoCount: number,
): E2eDraftSelfCheck {
  const checks: E2eDraftSelfCheckItem[] = [];
  checks.push(draftSelfCheckItem(
    "Playwright import",
    content.includes('from "@playwright/test"') ? "pass" : "fail",
    content.includes('from "@playwright/test"')
      ? "The draft imports Playwright test APIs."
      : "The draft does not import Playwright test APIs.",
  ));
  checks.push(draftSelfCheckItem(
    "Test case",
    /\btest\(\s*["'`][^"'`]+["'`]\s*,\s*async\s*\(\s*\{\s*page\s*\}\s*\)/.test(content) ? "pass" : "fail",
    "The draft should expose one Playwright test that receives a page fixture.",
  ));
  const needsEntrypoint = flow.entrypoints.some((entrypoint) => entrypoint.kind === "route");
  const hasRunnableGoto = /page\.goto\(\s*(?:"(?!TODO)[^"]+"|'(?!TODO)[^']+'|`(?!.*TODO)[^`]+`)\s*\)/.test(content);
  checks.push(draftSelfCheckItem(
    "Runnable entrypoint",
    !needsEntrypoint || hasRunnableGoto ? "pass" : "fail",
    needsEntrypoint
      ? "The draft should navigate to an inferred route without placeholder route values."
      : "No route entrypoint was required for this flow.",
  ));
  const unresolvedPlaceholder =
    /getBy(?:Text|Label|Placeholder|TestId)\(\s*["'`]TODO["'`]\s*\)|getByRole\([^)]*name:\s*["'`]TODO["'`][^)]*\)|TODO-[A-Za-z0-9-]+|Replace routeParams/i.test(content);
  checks.push(draftSelfCheckItem(
    "Unresolved placeholders",
    unresolvedPlaceholder ? "fail" : "pass",
    unresolvedPlaceholder
      ? "The draft still contains placeholder locators or route parameters."
      : "No placeholder locators or route parameters were detected.",
  ));
  checks.push(draftSelfCheckItem(
    "TODO comments",
    todoCount === 0 ? "pass" : "warning",
    todoCount === 0
      ? "No TODO comments remain in the generated draft."
      : `${todoCount} TODO marker${todoCount === 1 ? "" : "s"} remain for reviewer follow-up.`,
  ));
  checks.push(draftSelfCheckItem(
    "Execution profile",
    plan.executionProfile.confidence === "low" || plan.executionProfile.blockers.length > 0 ? "warning" : "pass",
    plan.executionProfile.confidence === "low" || plan.executionProfile.blockers.length > 0
      ? "Runner setup, base URL, launch command, or config evidence is incomplete."
      : "Runner setup evidence is strong enough for a local execution attempt.",
  ));
  return buildDraftSelfCheck(
    draftSelfCheckStatus(checks),
    draftSelfCheckSummary(checks, "Playwright"),
    plan.executionProfile.testCommand ?? "npx playwright test",
    checks,
  );
}

function evaluateMaestroDraftSelfCheck(
  plan: E2ePlanResult,
  content: string,
  todoCount: number,
): E2eDraftSelfCheck {
  const hasAppId = /^appId:\s*(?!\$\{APP_ID\})\S+/m.test(content);
  const checks = [
    draftSelfCheckItem(
      "Maestro app id",
      hasAppId || plan.executionProfile.appId ? "pass" : "warning",
      hasAppId || plan.executionProfile.appId
        ? "The draft has an app id signal."
        : "The draft still depends on APP_ID being supplied by the runner environment.",
    ),
    draftSelfCheckItem(
      "Launch app",
      /-\s*launchApp\b/.test(content) ? "pass" : "fail",
      "The draft should launch the app before interactions.",
    ),
    draftSelfCheckItem(
      "TODO comments",
      todoCount === 0 ? "pass" : "warning",
      todoCount === 0
        ? "No TODO comments remain in the generated draft."
        : `${todoCount} TODO marker${todoCount === 1 ? "" : "s"} remain for reviewer follow-up.`,
    ),
  ];
  return buildDraftSelfCheck(
    draftSelfCheckStatus(checks),
    draftSelfCheckSummary(checks, "Maestro"),
    plan.executionProfile.testCommand ?? "maestro test .maestro",
    checks,
  );
}

function buildDraftSelfCheck(
  status: E2eDraftSelfCheckStatus,
  summary: string,
  command: string | undefined,
  checks: E2eDraftSelfCheckItem[],
): E2eDraftSelfCheck {
  return {
    status,
    summary,
    command,
    checks,
    blockers: checks.filter((check) => check.status === "fail").map((check) => `${check.name}: ${check.detail}`),
  };
}

function draftSelfCheckItem(
  name: string,
  status: E2eDraftSelfCheckStatus,
  detail: string,
): E2eDraftSelfCheckItem {
  return { name, status, detail };
}

function draftSelfCheckStatus(checks: E2eDraftSelfCheckItem[]): E2eDraftSelfCheckStatus {
  if (checks.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (checks.some((check) => check.status === "warning")) {
    return "warning";
  }
  return "pass";
}

function draftSelfCheckSummary(checks: E2eDraftSelfCheckItem[], runnerName: string): string {
  const status = draftSelfCheckStatus(checks);
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  if (status === "pass") {
    return `${runnerName} draft passed static runner checks.`;
  }
  if (status === "fail") {
    return `${runnerName} draft failed ${failures} static runner check${failures === 1 ? "" : "s"}.`;
  }
  return `${runnerName} draft passed required static checks with ${warnings} warning${warnings === 1 ? "" : "s"}.`;
}

function buildFallbackFlow(plan: E2ePlanResult): E2eFlow {
  const coverage = buildCoverageTargets("changed-file", [], plan.recommendedRunner.name);
  const flow: Omit<E2eFlow, "languageBrief"> = {
    title: "App launch smoke flow",
    reason:
      "No changed user-facing files were detected, so CodeWard generated a minimal smoke draft for the detected app surface.",
    files: [],
    steps: [
      "Launch the app.",
      "Verify the first screen renders.",
      "Exercise the primary visible action if one is present.",
      "Verify the app remains usable after the action.",
    ],
    coverage,
    coverageEvidence: evaluateFlowCoverageEvidence(
      { title: "App launch smoke flow", files: [], coverage },
      {
        ...plan.testSuite,
        files: [],
      },
    ),
    entrypoints: [],
    setupHints: [],
    fixtureReadiness: {
      status: "not-needed",
      reason: "No API, network, payment, or external-response dependency was detected for this fallback flow.",
      apiSignals: [],
      backendSignals: [],
      mockSignals: [],
      nextActions: [],
    },
    selectors: [],
    missingTestability: plan.missingTestability,
  };
  return {
    ...flow,
    languageBrief: buildFlowLanguageBrief(flow),
  };
}

function defaultDraftOutputDirectory(runner: E2eRunnerName): string {
  if (runner === "maestro") {
    return ".maestro";
  }
  if (runner === "playwright") {
    return "tests/e2e";
  }
  return "docs/e2e";
}

function draftExtension(runner: E2eRunnerName): string {
  if (runner === "maestro") {
    return ".yaml";
  }
  if (runner === "playwright") {
    return ".spec.ts";
  }
  return ".md";
}

function draftContentForFlow(plan: E2ePlanResult, flow: E2eFlow, runner: E2eRunnerName): string {
  if (runner === "maestro") {
    return buildMaestroDraft(plan, flow);
  }
  if (runner === "playwright") {
    return buildPlaywrightDraft(plan, flow);
  }
  return buildManualDraft(plan, flow);
}

function buildMaestroDraft(plan: E2ePlanResult, flow: E2eFlow): string {
  const lines: string[] = [];
  const selectorQueue = [...flow.selectors];
  const scenario = domainScenarioForFlow(flow);
  lines.push(`# Generated by CodeWard ${VERSION}`);
  lines.push(`# Flow: ${flow.title}`);
  if (scenario) {
    lines.push(`# Domain scenario: ${scenario.title}`);
    lines.push(`# Intent: ${scenario.intent}`);
  }
  lines.push(`# Base: ${plan.base}`);
  lines.push(`# Head: ${plan.head}`);
  appendDraftBriefComments(lines, flow, "maestro", "#");
  appendExecutionProfileComments(lines, plan.executionProfile, "#");
  lines.push("# Replace ${APP_ID} with the app id or export APP_ID before running Maestro.");
  lines.push("");
  lines.push("appId: ${APP_ID}");
  lines.push("---");
  lines.push("- launchApp");
  appendEntrypointHints(lines, flow, "#");
  appendSetupHints(lines, flow, "#");
  appendFixtureReadinessHints(lines, flow, "#");
  appendValidationGapComments(lines, flow, "#");
  appendFlowLanguageBriefComments(lines, flow.languageBrief, "#");
  appendDraftPromotionComments(lines, flow, "#");
  for (const step of flow.steps) {
    const command = maestroCommandForStep(step, selectorQueue);
    lines.push(...formatMaestroCommand(command));
  }
  appendDomainScenarioComments(lines, flow, "#");
  appendMaestroCoverageComments(lines, flow);
  if (flow.missingTestability.length > 0) {
    lines.push("");
    lines.push("# Testability gaps to address before this flow is stable:");
    for (const gap of flow.missingTestability) {
      lines.push(`# - ${gap}`);
    }
  }
  if (flow.files.length > 0) {
    lines.push("");
    lines.push("# Related changed files:");
    for (const file of flow.files.slice(0, maxFilesPerFlow)) {
      lines.push(`# - ${file}`);
    }
  }
  if (flow.selectors.length > 0) {
    lines.push("");
    lines.push("# Inferred selectors:");
    for (const selector of flow.selectors.slice(0, maxFilesPerFlow)) {
      lines.push(`# - ${selector.kind}: ${selector.value} (${selector.file})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function maestroCommandForStep(
  step: string,
  selectors: E2eSelector[],
): { kind: "tapOn" | "assertVisible" | "swipe"; value: string } {
  if (isGestureStep(step)) {
    return {
      kind: "swipe",
      value: "{ start: \"35%, 55%\", end: \"65%, 55%\" }",
    };
  }
  const selector = takeSelectorForStep(selectors, step);
  if (isVerificationStep(step) && !isInteractionStep(step)) {
    return {
      kind: "assertVisible",
      value: selector ? maestroSelectorValue(selector) : quoteYaml(`TODO: ${step}`),
    };
  }
  return {
    kind: "tapOn",
    value: selector ? maestroSelectorValue(selector) : quoteYaml(`TODO: ${step}`),
  };
}

function buildPlaywrightDraft(plan: E2ePlanResult, flow: E2eFlow): string {
  const testName = flow.title.replaceAll('"', "'");
  const selectorQueue = [...flow.selectors];
  const scenario = domainScenarioForFlow(flow);
  const lines: string[] = [];
  lines.push(`// Generated by CodeWard ${VERSION}`);
  lines.push(`// Base: ${plan.base}`);
  lines.push(`// Head: ${plan.head}`);
  lines.push(`// Flow: ${flow.title}`);
  if (scenario) {
    lines.push(`// Domain scenario: ${scenario.title}`);
    lines.push(`// Intent: ${scenario.intent}`);
  }
  appendDraftBriefComments(lines, flow, "playwright", "//");
  appendExecutionProfileComments(lines, plan.executionProfile, "//");
  lines.push("");
  lines.push('import { expect, test } from "@playwright/test";');
  lines.push("");
  lines.push(`test("${testName}", async ({ page }) => {`);
  appendEntrypointHints(lines, flow, "  //");
  appendSetupHints(lines, flow, "  //");
  appendFixtureReadinessHints(lines, flow, "  //");
  appendValidationGapComments(lines, flow, "  //");
  appendFlowLanguageBriefComments(lines, flow.languageBrief, "  //");
  appendDraftPromotionComments(lines, flow, "  //");
  const routeEntrypoint = primaryRouteEntrypoint(flow);
  const routeDraft = buildPlaywrightRouteDraft(routeEntrypoint?.value ?? "/");
  if (routeDraft.params.length > 0) {
    lines.push("");
    lines.push("  const routeParams = {");
    for (const param of routeDraft.params) {
      lines.push(`    ${playwrightRouteParamKey(param.name)}: "${quoteJs(routeParamPlaceholder(param.name))}",`);
    }
    lines.push("  };");
    lines.push("  // TODO: Replace routeParams with fixture ids, tabs, or slugs from the target environment.");
  }
  appendPlaywrightTestStep(lines, flow.languageBrief.trigger, [
    `await page.goto(${routeDraft.expression});`,
  ]);
  for (const step of flow.steps) {
    const selector = takeSelectorForStep(selectorQueue, step);
    const locator = selector ? playwrightLocator(selector) : 'page.getByText("TODO")';
    const body = selector
      ? playwrightActionForStep(selector, locator, step)
      : [`// TODO: ${step}`, `await expect(${locator}).toBeVisible();`];
    appendPlaywrightTestStep(lines, step, body);
  }
  appendDomainScenarioComments(lines, flow, "  //");
  appendPlaywrightCoverageComments(lines, flow);
  lines.push("});");
  if (flow.missingTestability.length > 0) {
    lines.push("");
    lines.push("// Testability gaps to address before this spec is stable:");
    for (const gap of flow.missingTestability) {
      lines.push(`// - ${gap}`);
    }
  }
  if (flow.files.length > 0) {
    lines.push("");
    lines.push("// Related changed files:");
    for (const file of flow.files.slice(0, maxFilesPerFlow)) {
      lines.push(`// - ${file}`);
    }
  }
  if (flow.selectors.length > 0) {
    lines.push("");
    lines.push("// Inferred selectors:");
    for (const selector of flow.selectors.slice(0, maxFilesPerFlow)) {
      lines.push(`// - ${selector.kind}: ${selector.value} (${selector.file})`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function buildManualDraft(plan: E2ePlanResult, flow: E2eFlow): string {
  const scenario = domainScenarioForFlow(flow);
  const lines: string[] = [];
  lines.push(`# ${flow.title}`);
  lines.push("");
  lines.push(`Generated by CodeWard ${VERSION}.`);
  if (scenario) {
    lines.push("");
    lines.push(`Domain scenario: ${scenario.title}`);
    lines.push("");
    lines.push(scenario.intent);
  }
  lines.push("");
  lines.push(`- Base: \`${plan.base}\``);
  lines.push(`- Head: \`${plan.head}\``);
  lines.push("");
  appendManualDraftBrief(lines, flow, "manual");
  appendManualExecutionProfile(lines, plan.executionProfile);
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  for (const step of flow.steps) {
    lines.push(`- [ ] ${step}`);
  }
  if (flow.entrypoints.length > 0) {
    lines.push("");
    lines.push("## Entrypoint Hints");
    lines.push("");
    for (const entrypoint of flow.entrypoints.slice(0, maxFilesPerFlow)) {
      lines.push(`- ${formatEntrypoint(entrypoint)}`);
    }
  }
  if (flow.setupHints.length > 0) {
    lines.push("");
    lines.push("## Setup Hints");
    lines.push("");
    for (const hint of flow.setupHints.slice(0, maxFilesPerFlow)) {
      lines.push(`- ${formatSetupHint(hint)}`);
    }
  }
  if (flow.fixtureReadiness.status !== "not-needed") {
    lines.push("");
    lines.push("## Fixture / Mock Readiness");
    lines.push("");
    lines.push(`- ${formatFixtureReadiness(flow.fixtureReadiness)}`);
    for (const action of flow.fixtureReadiness.nextActions) {
      lines.push(`- [ ] ${action}`);
    }
  }
  appendManualValidationGaps(lines, flow);
  appendManualFlowLanguageBrief(lines, flow.languageBrief);
  appendManualDraftPromotion(lines, flow);
  if (scenario) {
    lines.push("");
    lines.push("## Scenario Checks");
    lines.push("");
    if (sameStringList(scenario.checks, flow.steps)) {
      lines.push("The scenario checks are already used as the draft steps above.");
    } else {
      for (const check of scenario.checks) {
        lines.push(`- [ ] ${check}`);
      }
    }
  }
  if (flow.coverage.length > 0) {
    lines.push("");
    lines.push("## Coverage Matrix");
    lines.push("");
    for (const target of flow.coverage) {
      lines.push(`- [ ] ${formatCoveragePriority(target.priority)} ${target.title} - ${target.reason}`);
      for (const check of target.checks) {
        lines.push(`  - [ ] ${check}`);
      }
    }
  }
  if (flow.missingTestability.length > 0) {
    lines.push("");
    lines.push("## Testability Gaps");
    lines.push("");
    for (const gap of flow.missingTestability) {
      lines.push(`- ${gap}`);
    }
  }
  if (flow.files.length > 0) {
    lines.push("");
    lines.push("## Related Changed Files");
    lines.push("");
    for (const file of flow.files.slice(0, maxFilesPerFlow)) {
      lines.push(`- \`${file}\``);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function appendMaestroCoverageComments(lines: string[], flow: E2eFlow): void {
  if (flow.coverage.length === 0) {
    return;
  }
  lines.push("");
  lines.push("# Coverage matrix to expand before making this flow required:");
  for (const target of flow.coverage) {
    lines.push(`# - [ ] ${formatCoveragePriority(target.priority)} ${target.title}: ${target.reason}`);
    for (const check of target.checks) {
      lines.push(`#   - [ ] ${check}`);
    }
  }
}

function appendFlowLanguageBriefMarkdown(lines: string[], brief: E2eFlowLanguageBrief): void {
  lines.push("Flow language brief:");
  lines.push(`- Actor: ${escapeMarkdownInline(brief.actor)}`);
  lines.push(`- Trigger: ${escapeMarkdownInline(brief.trigger)}`);
  lines.push(`- Goal: ${escapeMarkdownInline(brief.goal)}`);
  lines.push(`- Success signal: ${escapeMarkdownInline(brief.successSignal)}`);
  lines.push(`- Review question: ${escapeMarkdownInline(brief.reviewQuestion)}`);
  if (brief.edgeCases.length > 0) {
    lines.push(`- Edge cases: ${escapeMarkdownInline(brief.edgeCases.join("; "))}`);
  }
}

function appendExecutionProfileMarkdown(lines: string[], profile: E2eExecutionProfile): void {
  lines.push("## Execution Profile");
  lines.push("");
  lines.push(`- Runner: ${formatRunnerName(profile.runner)}`);
  lines.push(`- Confidence: ${profile.confidence}`);
  if (profile.startCommand) {
    lines.push(`- Start command: \`${escapeMarkdownInline(profile.startCommand)}\``);
  }
  if (profile.testCommand) {
    lines.push(`- Test command: \`${escapeMarkdownInline(profile.testCommand)}\``);
  }
  if (profile.baseUrl) {
    lines.push(`- Base URL: \`${escapeMarkdownInline(profile.baseUrl)}\``);
  }
  if (profile.appId) {
    lines.push(`- App id: \`${escapeMarkdownInline(profile.appId)}\``);
  }
  if (profile.configFiles.length > 0) {
    lines.push(`- Config files: ${profile.configFiles.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`);
  }
  if (profile.envFiles.length > 0) {
    lines.push(`- Env fixture files: ${profile.envFiles.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`);
  }
  if (profile.blockers.length > 0) {
    lines.push("");
    lines.push("Execution blockers:");
    for (const blocker of profile.blockers) {
      lines.push(`- ${escapeMarkdownInline(blocker)}`);
    }
  }
  lines.push("");
}

function appendFlowLanguageBriefComments(
  lines: string[],
  brief: E2eFlowLanguageBrief,
  commentPrefix: string,
): void {
  lines.push("");
  lines.push(`${commentPrefix} Flow language brief:`);
  lines.push(`${commentPrefix} - Actor: ${brief.actor}`);
  lines.push(`${commentPrefix} - Trigger: ${brief.trigger}`);
  lines.push(`${commentPrefix} - Goal: ${brief.goal}`);
  lines.push(`${commentPrefix} - Success signal: ${brief.successSignal}`);
  lines.push(`${commentPrefix} - Review question: ${brief.reviewQuestion}`);
  if (brief.edgeCases.length > 0) {
    lines.push(`${commentPrefix} - Edge cases: ${brief.edgeCases.join("; ")}`);
  }
}

function appendManualFlowLanguageBrief(lines: string[], brief: E2eFlowLanguageBrief): void {
  lines.push("");
  lines.push("## Flow Language Brief");
  lines.push("");
  lines.push(`- Actor: ${brief.actor}`);
  lines.push(`- Trigger: ${brief.trigger}`);
  lines.push(`- Goal: ${brief.goal}`);
  lines.push(`- Success signal: ${brief.successSignal}`);
  lines.push(`- Review question: ${brief.reviewQuestion}`);
  if (brief.edgeCases.length > 0) {
    lines.push(`- Edge cases: ${brief.edgeCases.join("; ")}`);
  }
}

function appendEntrypointHints(lines: string[], flow: E2eFlow, commentPrefix: string): void {
  if (flow.entrypoints.length === 0) {
    return;
  }
  lines.push("");
  lines.push(`${commentPrefix} Entrypoint hints:`);
  for (const entrypoint of flow.entrypoints.slice(0, maxFilesPerFlow)) {
    lines.push(`${commentPrefix} - ${formatEntrypoint(entrypoint)}`);
  }
}

function appendSetupHints(lines: string[], flow: E2eFlow, commentPrefix: string): void {
  if (flow.setupHints.length === 0) {
    return;
  }
  lines.push("");
  lines.push(`${commentPrefix} Setup hints:`);
  for (const hint of flow.setupHints.slice(0, maxFilesPerFlow)) {
    lines.push(`${commentPrefix} - ${formatSetupHint(hint)}`);
  }
}

function appendFixtureReadinessHints(lines: string[], flow: E2eFlow, commentPrefix: string): void {
  if (flow.fixtureReadiness.status === "not-needed") {
    return;
  }
  lines.push("");
  lines.push(`${commentPrefix} Fixture/mock readiness:`);
  lines.push(`${commentPrefix} - ${formatFixtureReadiness(flow.fixtureReadiness)}`);
  for (const action of flow.fixtureReadiness.nextActions.slice(0, 3)) {
    lines.push(`${commentPrefix} - Next: ${action}`);
  }
}

function appendValidationGapComments(lines: string[], flow: E2eFlow, commentPrefix: string): void {
  const rows = validationRowsForDraftFlow(flow).filter((row) => row.status !== "ready");
  if (rows.length === 0) {
    return;
  }
  lines.push("");
  lines.push(`${commentPrefix} Validation gaps before this draft can be required:`);
  for (const row of rows.slice(0, maxFilesPerFlow)) {
    lines.push(`${commentPrefix} - [${row.status}] ${row.area}: ${row.nextAction}`);
  }
}

function appendDraftPromotionComments(lines: string[], flow: E2eFlow, commentPrefix: string): void {
  const guidance = buildDraftPromotionGuidance(flow);
  lines.push("");
  lines.push(`${commentPrefix} Manifest promotion guidance:`);
  lines.push(`${commentPrefix} - Status: ${guidance.status}`);
  lines.push(`${commentPrefix} - Why: ${guidance.reason}`);
  lines.push(`${commentPrefix} - Next: ${guidance.action}`);
}

function appendManualValidationGaps(lines: string[], flow: E2eFlow): void {
  const rows = validationRowsForDraftFlow(flow).filter((row) => row.status !== "ready");
  if (rows.length === 0) {
    return;
  }
  lines.push("");
  lines.push("## Validation Gaps");
  lines.push("");
  for (const row of rows.slice(0, maxFilesPerFlow)) {
    lines.push(`- [ ] [${row.status}] ${row.area} - ${row.nextAction}`);
  }
}

function appendManualDraftPromotion(lines: string[], flow: E2eFlow): void {
  const guidance = buildDraftPromotionGuidance(flow);
  lines.push("");
  lines.push("## Manifest Promotion Guidance");
  lines.push("");
  lines.push(`- Status: ${guidance.status}`);
  lines.push(`- Why: ${guidance.reason}`);
  lines.push(`- Next: ${guidance.action}`);
}

interface DraftBrief {
  changedBehavior: string;
  whyThisFlowMatters: string;
  humanFixtureInputs: string[];
}

function appendDraftBriefComments(
  lines: string[],
  flow: E2eFlow,
  runner: E2eRunnerName,
  commentPrefix: string,
): void {
  const brief = buildDraftBrief(flow, runner);
  lines.push(`${commentPrefix} Draft brief:`);
  lines.push(`${commentPrefix} - Changed behavior: ${brief.changedBehavior}`);
  lines.push(`${commentPrefix} - Why this flow matters: ${brief.whyThisFlowMatters}`);
  lines.push(`${commentPrefix} - Human fixture inputs:`);
  for (const input of brief.humanFixtureInputs) {
    lines.push(`${commentPrefix}   - ${input}`);
  }
}

function appendExecutionProfileComments(
  lines: string[],
  profile: E2eExecutionProfile,
  commentPrefix: string,
): void {
  lines.push("");
  lines.push(`${commentPrefix} Execution profile:`);
  lines.push(`${commentPrefix} - Confidence: ${profile.confidence}`);
  if (profile.startCommand) {
    lines.push(`${commentPrefix} - Start command: ${profile.startCommand}`);
  }
  if (profile.testCommand) {
    lines.push(`${commentPrefix} - Test command: ${profile.testCommand}`);
  }
  if (profile.baseUrl) {
    lines.push(`${commentPrefix} - Base URL: ${profile.baseUrl}`);
  }
  if (profile.appId) {
    lines.push(`${commentPrefix} - App id: ${profile.appId}`);
  }
  for (const blocker of profile.blockers.slice(0, 4)) {
    lines.push(`${commentPrefix} - Blocker: ${blocker}`);
  }
}

function appendManualDraftBrief(lines: string[], flow: E2eFlow, runner: E2eRunnerName): void {
  const brief = buildDraftBrief(flow, runner);
  lines.push("## Draft Brief");
  lines.push("");
  lines.push(`- Changed behavior: ${brief.changedBehavior}`);
  lines.push(`- Why this flow matters: ${brief.whyThisFlowMatters}`);
  lines.push("- Human fixture inputs:");
  for (const input of brief.humanFixtureInputs) {
    lines.push(`  - ${input}`);
  }
}

function appendManualExecutionProfile(lines: string[], profile: E2eExecutionProfile): void {
  lines.push("");
  lines.push("## Execution Profile");
  lines.push("");
  lines.push(`- Runner: ${formatRunnerName(profile.runner)}`);
  lines.push(`- Confidence: ${profile.confidence}`);
  if (profile.startCommand) {
    lines.push(`- Start command: \`${profile.startCommand}\``);
  }
  if (profile.testCommand) {
    lines.push(`- Test command: \`${profile.testCommand}\``);
  }
  if (profile.baseUrl) {
    lines.push(`- Base URL: \`${profile.baseUrl}\``);
  }
  if (profile.appId) {
    lines.push(`- App id: \`${profile.appId}\``);
  }
  if (profile.blockers.length > 0) {
    lines.push("- Blockers:");
    for (const blocker of profile.blockers.slice(0, 4)) {
      lines.push(`  - ${blocker}`);
    }
  }
}

function buildDraftBrief(flow: E2eFlow, runner: E2eRunnerName): DraftBrief {
  const scenario = domainScenarioForFlow(flow);
  const coreFlow = coreFlowForDraftFlow(flow);
  const changedBehavior = flow.files.length > 0
    ? `${flow.reason} Changed files include ${formatFileSummary(flow.files)}.`
    : flow.reason;
  const criticalCoverage = flow.coverage.filter((target) => target.priority === "critical").map((target) => target.title);
  let whyThisFlowMatters: string;
  if (coreFlow) {
    whyThisFlowMatters =
      `Core flow: ${coreFlow.id} [${coreFlow.priority}]. It protects the team-approved "${coreFlow.name}" flow and ${formatHumanList(criticalCoverage)}.`;
  } else if (scenario) {
    whyThisFlowMatters =
      `It uses "${scenario.title}" as the team-facing behavior name and protects ${formatHumanList(criticalCoverage)}.`;
  } else {
    whyThisFlowMatters = `It protects ${formatHumanList(criticalCoverage)} for the changed surface.`;
  }

  return {
    changedBehavior,
    whyThisFlowMatters,
    humanFixtureInputs: buildHumanFixtureInputs(flow, runner),
  };
}

function buildHumanFixtureInputs(flow: E2eFlow, runner: E2eRunnerName): string[] {
  const inputs: string[] = [];
  const coreFlow = coreFlowForDraftFlow(flow);
  if (coreFlow?.checks.length) {
    inputs.push(`Keep manifest checks required: ${formatHumanList(coreFlow.checks.slice(0, 3))}.`);
  }
  if (runner === "maestro") {
    inputs.push("Set APP_ID to the target app id or export it before running the flow.");
  }
  if (runner === "playwright") {
    const route = primaryRouteEntrypoint(flow)?.value;
    const routeDraft = route ? buildPlaywrightRouteDraft(route) : undefined;
    for (const param of routeDraft?.params ?? []) {
      inputs.push(`Replace route param ${param.name} with a real fixture value for ${route}.`);
    }
  }
  for (const hint of flow.setupHints) {
    inputs.push(humanFixtureInputForSetupHint(hint));
  }
  for (const action of flow.fixtureReadiness.nextActions) {
    inputs.push(action);
  }
  if (flow.missingTestability.length > 0) {
    inputs.push("Replace placeholder selectors with stable test ids, accessibility labels, roles, or visible copy from the app.");
  }
  if (inputs.length === 0) {
    inputs.push("Use realistic data for the primary success path and one blocked, empty, or failed path.");
  }
  return uniqueStrings(inputs).slice(0, 6);
}

function coreFlowForDraftFlow(flow: E2eFlow): MatchedCoreFlow | undefined {
  return (flow as DraftE2eFlow).coreFlow;
}

function humanFixtureInputForSetupHint(hint: E2eSetupHint): string {
  switch (hint.kind) {
    case "auth":
      return "Prepare logged-in, anonymous, expired-session, and permission-denied identities.";
    case "network":
      return "Seed or mock success, empty, unauthorized, timeout, and server-error responses.";
    case "fixture":
      return "Prepare deterministic success data plus one blocked or empty fixture.";
    case "environment":
      return "Set required env vars, feature flags, build variant, or dependency mode.";
    case "payment":
      return "Use sandbox or simulated payment responses for success, cancellation, declined, and already-owned cases.";
    case "state":
      return "Reset persisted storage, cache, and provider state before each run.";
  }
}

function formatFileSummary(files: string[]): string {
  const visibleFiles = files.slice(0, 3);
  const suffix = files.length > visibleFiles.length ? ` and ${files.length - visibleFiles.length} more` : "";
  return `${visibleFiles.join(", ")}${suffix}`;
}

function formatHumanList(values: string[]): string {
  const visibleValues = values.length > 0
    ? values.slice(0, 3).map(stripTerminalPunctuation)
    : ["the primary success path"];
  if (values.length > visibleValues.length) {
    visibleValues.push(`${values.length - visibleValues.length} more coverage target${values.length - visibleValues.length === 1 ? "" : "s"}`);
  }
  if (visibleValues.length === 1) {
    return visibleValues[0];
  }
  if (visibleValues.length === 2) {
    return `${visibleValues[0]} and ${visibleValues[1]}`;
  }
  return `${visibleValues.slice(0, -1).join(", ")}, and ${visibleValues.at(-1)}`;
}

function stripTerminalPunctuation(value: string): string {
  return value.replace(/[.!?]+$/g, "");
}

function appendDomainScenarioComments(lines: string[], flow: E2eFlow, commentPrefix: string): void {
  const scenario = domainScenarioForFlow(flow);
  if (!scenario || scenario.checks.length === 0) {
    return;
  }
  lines.push("");
  lines.push(`${commentPrefix} Domain scenario checks:`);
  for (const check of scenario.checks) {
    lines.push(`${commentPrefix} - [ ] ${check}`);
  }
}

function appendPlaywrightCoverageComments(lines: string[], flow: E2eFlow): void {
  if (flow.coverage.length === 0) {
    return;
  }
  lines.push("");
  lines.push("  // Coverage matrix to expand before making this spec required:");
  for (const target of flow.coverage) {
    lines.push(`  // - [ ] ${formatCoveragePriority(target.priority)} ${target.title}: ${target.reason}`);
    for (const check of target.checks) {
      lines.push(`  //   - [ ] ${check}`);
    }
  }
}

function appendPlaywrightTestStep(lines: string[], title: string, body: string[]): void {
  lines.push("");
  lines.push(`  await test.step("${quoteJs(playwrightStepTitle(title))}", async () => {`);
  for (const line of body) {
    lines.push(`    ${line}`);
  }
  lines.push("  });");
}

function playwrightStepTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "Run generated flow step";
  }
  return normalized.length > 96 ? `${normalized.slice(0, 93).trim()}...` : normalized;
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function primaryRouteEntrypoint(flow: E2eFlow): E2eEntrypoint | undefined {
  return flow.entrypoints.find((entrypoint) => entrypoint.kind === "route");
}

function primaryEntrypointLabel(flow: E2eFlow): string | undefined {
  const entrypoint = flow.entrypoints[0];
  return entrypoint ? formatEntrypoint(entrypoint) : undefined;
}

interface PlaywrightRouteDraft {
  expression: string;
  params: Array<{ name: string }>;
}

function buildPlaywrightRouteDraft(route: string): PlaywrightRouteDraft {
  const normalizedRoute = route || "/";
  const params: Array<{ name: string }> = [];
  const seenParams = new Set<string>();
  const dynamicSegmentMatcher = /:([A-Za-z_$][A-Za-z0-9_$-]*)/g;
  let cursor = 0;
  let template = "";

  for (const match of normalizedRoute.matchAll(dynamicSegmentMatcher)) {
    const [token, name] = match;
    if (!name) {
      continue;
    }
    if (!seenParams.has(name)) {
      seenParams.add(name);
      params.push({ name });
    }
    template += quoteTemplateLiteralPart(normalizedRoute.slice(cursor, match.index));
    template += `\${${playwrightRouteParamAccess(name)}}`;
    cursor = (match.index ?? 0) + token.length;
  }

  if (params.length === 0) {
    return { expression: `"${quoteJs(normalizedRoute)}"`, params: [] };
  }

  template += quoteTemplateLiteralPart(normalizedRoute.slice(cursor));
  return { expression: `\`${template}\``, params };
}

function playwrightRouteParamKey(name: string): string {
  return isJsIdentifier(name) ? name : `"${quoteJs(name)}"`;
}

function playwrightRouteParamAccess(name: string): string {
  return isJsIdentifier(name) ? `routeParams.${name}` : `routeParams["${quoteJs(name)}"]`;
}

function routeParamPlaceholder(name: string): string {
  const readableName = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `TODO-${readableName || "param"}`;
}

function quoteTemplateLiteralPart(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

function isJsIdentifier(value: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value);
}

function formatEntrypoint(entrypoint: E2eEntrypoint): string {
  return `${entrypoint.kind} ${entrypoint.value} [${entrypoint.confidence}] (${entrypoint.file})`;
}

function formatSetupHint(hint: E2eSetupHint): string {
  const files = hint.files.length > 0 ? ` (${hint.files.slice(0, 3).join(", ")})` : "";
  return `[${hint.kind}, ${hint.confidence}] ${hint.title}: ${hint.detail}${files}`;
}

function formatFixtureReadiness(readiness: E2eFixtureReadiness): string {
  const evidence: string[] = [];
  if (readiness.apiSignals.length > 0) {
    evidence.push(`${readiness.apiSignals.length} API signal${readiness.apiSignals.length === 1 ? "" : "s"}`);
  }
  if (readiness.backendSignals.length > 0) {
    evidence.push(`${readiness.backendSignals.length} backend signal${readiness.backendSignals.length === 1 ? "" : "s"}`);
  }
  if (readiness.mockSignals.length > 0) {
    evidence.push(`${readiness.mockSignals.length} mock/fixture signal${readiness.mockSignals.length === 1 ? "" : "s"}`);
  }
  const suffix = evidence.length > 0 ? ` Evidence: ${evidence.join(", ")}.` : "";
  return `[${readiness.status}] ${readiness.reason}${suffix}`;
}

function formatDraftActionKindSummary(summary: E2eDraftActionKindSummary[]): string {
  return summary
    .slice(0, 5)
    .map((item) => `${item.kind} ${item.total} (${item.required} required, ${item.recommended} recommended)`)
    .join(", ");
}

function buildDraftNextSteps(plan: E2ePlanResult, runner: E2eRunnerName): string[] {
  const steps: string[] = [];
  if (runner === "maestro") {
    steps.push(plan.executionProfile.appId
      ? `Use app id ${plan.executionProfile.appId} or export APP_ID before running Maestro.`
      : "Replace ${APP_ID} or export APP_ID before running Maestro.");
    steps.push("Replace TODO text selectors with visible copy, testID, or accessibilityLabel selectors.");
    steps.push(plan.executionProfile.startCommand
      ? `Launch the app with \`${plan.executionProfile.startCommand}\`, then run \`${plan.executionProfile.testCommand ?? "maestro test .maestro"}\`.`
      : `Run the app with the launch command that matches your simulator or device, then run \`${plan.executionProfile.testCommand ?? "maestro test .maestro"}\`.`);
  } else if (runner === "playwright") {
    steps.push("Replace TODO locators with role, text, or data-testid locators from the app.");
    if (plan.executionProfile.baseUrl) {
      steps.push(`Confirm Playwright baseURL \`${plan.executionProfile.baseUrl}\` points at the target environment.`);
    } else {
      steps.push("Configure baseURL in Playwright before making the specs required in CI.");
    }
    steps.push(plan.executionProfile.startCommand
      ? `Serve the app with \`${plan.executionProfile.startCommand}\`, then run \`${plan.executionProfile.testCommand ?? "npx playwright test"}\`.`
      : `Run \`${plan.executionProfile.testCommand ?? "npx playwright test"}\` after the app can be served locally.`);
  } else {
    steps.push("Choose a runnable E2E framework once the primary app surface is documented.");
  }
  if (plan.bootstrap.counts.required > 0) {
    const requiredTitles = plan.bootstrap.steps
      .filter((step) => step.status === "required")
      .map((step) => step.title)
      .slice(0, 3);
    steps.push(`Resolve required bootstrap steps before treating drafts as regression coverage: ${formatHumanList(requiredTitles)}.`);
  }
  if (plan.missingTestability.length > 0) {
    steps.push("Address the listed testability gaps before treating the generated drafts as stable regression tests.");
  }
  if (plan.validationMatrix.summary.missing > 0) {
    steps.push("Resolve missing validation matrix rows before promoting generated drafts to required PR evidence.");
  }
  return steps;
}

function formatDraftFileQuality(file: E2eDraftFile): string | undefined {
  const details: string[] = [];
  if (file.source !== undefined) {
    details.push(file.source);
  }
  if (file.promotionStatus !== undefined) {
    details.push(`${file.promotionStatus} promotion`);
  }
  if (file.actionItems !== undefined && file.actionItems.length > 0) {
    details.push(`${file.actionItems.length} action item${file.actionItems.length === 1 ? "" : "s"}`);
  }
  if (file.runnableStatus !== undefined) {
    details.push(file.runnableStatus);
  }
  if (file.executionBlockers !== undefined && file.executionBlockers.length > 0) {
    details.push(`${file.executionBlockers.length} execution blocker${file.executionBlockers.length === 1 ? "" : "s"}`);
  }
  if (file.selfCheck !== undefined) {
    details.push(`self-check ${file.selfCheck.status}`);
  }
  if (file.stability !== undefined) {
    details.push(file.stability);
  }
  if (file.todoCount !== undefined) {
    details.push(`${file.todoCount} TODO${file.todoCount === 1 ? "" : "s"}`);
  }
  if (file.entrypointCount !== undefined && file.entrypointCount > 0) {
    const suffix = file.primaryEntrypoint ? `: ${file.primaryEntrypoint}` : "";
    details.push(`${file.entrypointCount} entrypoint hint${file.entrypointCount === 1 ? "" : "s"}${suffix}`);
  }
  if (file.setupHintCount !== undefined && file.setupHintCount > 0) {
    details.push(`${file.setupHintCount} setup hint${file.setupHintCount === 1 ? "" : "s"}`);
  }
  if (file.inferredSelectorCount !== undefined) {
    details.push(
      `${file.inferredSelectorCount} inferred selector${file.inferredSelectorCount === 1 ? "" : "s"}`,
    );
  }
  if (file.coverageTargetCount !== undefined) {
    details.push(
      `${file.coverageTargetCount} coverage target${file.coverageTargetCount === 1 ? "" : "s"}`,
    );
  }
  if (file.validationStatus !== undefined) {
    details.push(`${file.validationStatus} validation`);
  }
  if (file.validationGapCount !== undefined) {
    details.push(`${file.validationGapCount} validation gap${file.validationGapCount === 1 ? "" : "s"}`);
  }
  if (file.blockingValidationGapCount !== undefined && file.blockingValidationGapCount > 0) {
    details.push(
      `${file.blockingValidationGapCount} missing validation gap${file.blockingValidationGapCount === 1 ? "" : "s"}`,
    );
  }
  return details.length > 0 ? details.join(", ") : undefined;
}

function countTodos(content: string): number {
  return [...content.matchAll(/\bTODO\b/g)].length;
}

function formatMaestroCommand(command: { kind: "tapOn" | "assertVisible" | "swipe"; value: string }): string[] {
  return [`- ${command.kind}: ${command.value}`];
}

function takeSelectorForStep(selectors: E2eSelector[], step: string): E2eSelector | undefined {
  if (/^launch\b/i.test(step)) {
    return undefined;
  }
  const index = selectors.findIndex((selector) => selectorMatchesStep(selector, step));
  if (index >= 0) {
    const [selector] = selectors.splice(index, 1);
    return selector;
  }
  if (canUsePrimarySelector(step)) {
    const fallbackIndex = selectors.findIndex((selector) => selectorCanDriveInteraction(selector));
    if (fallbackIndex >= 0) {
      const [selector] = selectors.splice(fallbackIndex, 1);
      return selector;
    }
  }
  return undefined;
}

function selectorMatchesStep(selector: E2eSelector, step: string): boolean {
  const selectorText = selector.value.toLowerCase();
  return keywordsForStep(step).some((keyword) => selectorText.includes(keyword));
}

function canUsePrimarySelector(step: string): boolean {
  return /\b(?:primary|action|submit|continue)\b/i.test(step) && !/^launch\b/i.test(step);
}

function selectorCanDriveInteraction(selector: E2eSelector): boolean {
  if (selector.kind === "visible-text" || selector.kind === "placeholder") {
    return false;
  }
  return !isPassiveControlLabel(selector.value);
}

function isPassiveControlLabel(value: string): boolean {
  return /^(?:close|cancel|dismiss|back|previous|닫기|취소|뒤로)$/i.test(value.trim());
}

function keywordsForStep(step: string): string[] {
  const stopWords = new Set([
    "the",
    "and",
    "app",
    "flow",
    "screen",
    "entry",
    "visible",
    "required",
    "least",
    "once",
    "primary",
    "changed",
    "state",
    "states",
    "with",
    "from",
    "into",
    "next",
    "after",
  ]);
  return step
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 3 && !stopWords.has(part));
}

function maestroSelectorValue(selector: E2eSelector): string {
  if (selector.kind === "test-id" || selector.kind === "web-test-id") {
    return `{ id: ${quoteYaml(selector.value)} }`;
  }
  return quoteYaml(selector.value);
}

function playwrightLocator(selector: E2eSelector): string {
  const value = quoteJs(selector.value);
  if (selector.kind === "test-id" || selector.kind === "web-test-id") {
    return `page.getByTestId("${value}")`;
  }
  if (selector.kind === "role-button") {
    return `page.getByRole("button", { name: "${value}" })`;
  }
  if (selector.kind === "role-link") {
    return `page.getByRole("link", { name: "${value}" })`;
  }
  if (selector.kind === "placeholder") {
    return `page.getByPlaceholder("${value}")`;
  }
  if (selector.kind === "accessibility-label" || selector.kind === "aria-label") {
    return `page.getByLabel("${value}")`;
  }
  return `page.getByText("${value}")`;
}

function playwrightActionForStep(selector: E2eSelector, locator: string, step: string): string[] {
  const body = [`// Step intent: ${step}`];
  if (isVerificationStep(step) && !isInteractionStep(step)) {
    body.push(`await expect(${locator}).toBeVisible();`);
    return body;
  }
  if (selector.kind === "placeholder") {
    body.push(`await ${locator}.fill("${quoteJs(playwrightSampleInput(selector.value))}");`);
    return body;
  }
  body.push(`await ${locator}.click();`);
  return body;
}

function playwrightSampleInput(label: string): string {
  if (/\b(?:email|e-mail|메일)\b/i.test(label)) {
    return "codeward@example.com";
  }
  if (/\b(?:url|link|링크|주소)\b/i.test(label)) {
    return "https://example.com/codeward";
  }
  if (/\b(?:code|otp|pin|코드|인증)\b/i.test(label)) {
    return "123456";
  }
  if (/\b(?:name|이름)\b/i.test(label)) {
    return "CodeWard Test";
  }
  return "CodeWard sample value";
}

function isGestureStep(step: string): boolean {
  return /\b(?:draw|stroke|swipe)\b/i.test(step);
}

function isInteractionStep(step: string): boolean {
  return /^(?:choose|select|open|tap|click|create|save|return|switch|exercise)\b/i.test(step);
}

function isVerificationStep(step: string): boolean {
  return /\b(?:verify|assert|visible|appears|renders|available|usable|remains|survive)\b/i.test(step);
}

function extractSelectorsFromText(file: string, text: string, runner: E2eRunnerName): E2eSelector[] {
  const selectors: E2eSelector[] = [];
  const canUseWebSelectors = runner === "playwright" || runner === "manual";

  selectors.push(
    ...extractAttributeSelectors(file, text, ["testID"], "test-id"),
    ...extractAttributeSelectors(file, text, ["accessibilityLabel"], "accessibility-label"),
    ...extractAttributeSelectors(file, text, ["placeholder"], "placeholder"),
  );

  if (canUseWebSelectors) {
    selectors.push(
      ...extractAttributeSelectors(file, text, ["data-testid", "data-test"], "web-test-id"),
      ...extractAttributeSelectors(file, text, ["aria-label"], "aria-label"),
      ...extractRoleSelectorsFromText(file, text),
    );
  }

  selectors.push(...extractTextNodeSelectors(file, text));
  return selectors.filter((selector) => isUsefulSelector(selector.value));
}

function extractAttributeSelectors(
  file: string,
  text: string,
  attributes: string[],
  kind: E2eSelectorKind,
): E2eSelector[] {
  const selectors: E2eSelector[] = [];
  for (const attribute of attributes) {
    const matcher = new RegExp(
      `${escapeRegExp(attribute)}\\s*=\\s*(?:"([^"]+)"|'([^']+)'|\\{\\s*["'\`]([^"'\`{}]+)["'\`]\\s*\\})`,
      "g",
    );
    for (const match of text.matchAll(matcher)) {
      const value = normalizeSelectorValue(match[1] ?? match[2] ?? match[3]);
      if (value) {
        selectors.push({ kind, value, file });
      }
    }
  }
  return selectors;
}

function extractTextNodeSelectors(file: string, text: string): E2eSelector[] {
  const selectors: E2eSelector[] = [];
  const textNodeMatcher = /<Text(?:\s[^>]*)?>([^<>{}\n][^<>{}]*)<\/Text>/g;
  for (const match of text.matchAll(textNodeMatcher)) {
    const value = normalizeSelectorValue(match[1]);
    if (value) {
      selectors.push({ kind: "visible-text", value, file });
    }
  }

  for (const selector of extractAttributeSelectors(file, text, ["title"], "visible-text")) {
    selectors.push(selector);
  }

  return selectors;
}

function extractRoleSelectorsFromText(file: string, text: string): E2eSelector[] {
  const selectors: E2eSelector[] = [];
  const roleMatchers: Array<{ matcher: RegExp; kind: E2eSelectorKind }> = [
    {
      matcher: /<(?:button|Button|[^<>\s]*Button)\b[^>]*>([^<>{}\n][^<>{}]*)<\/(?:button|Button|[^<>\s]*Button)>/g,
      kind: "role-button",
    },
    {
      matcher: /<(?:a|Link|NavLink)\b[^>]*>([^<>{}\n][^<>{}]*)<\/(?:a|Link|NavLink)>/g,
      kind: "role-link",
    },
  ];
  for (const { matcher, kind } of roleMatchers) {
    for (const match of text.matchAll(matcher)) {
      const value = normalizeSelectorValue(match[1]);
      if (value) {
        selectors.push({ kind, value, file });
      }
    }
  }
  return selectors;
}

function normalizeSelectorValue(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function isUsefulSelector(value: string): boolean {
  return value.length >= 2 && value.length <= 80 && !/[{}()[\]=>]/.test(value);
}

async function readPackageJson(root: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function hasAnyFile(root: string, fileNames: string[]): Promise<boolean> {
  for (const fileName of fileNames) {
    if (await exists(path.join(root, fileName))) {
      return true;
    }
  }
  return false;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function uniqueEntrypoints(entrypoints: E2eEntrypoint[]): E2eEntrypoint[] {
  const seen = new Set<string>();
  const ordered = [...entrypoints].sort((left, right) => entrypointRank(left) - entrypointRank(right));
  return ordered.filter((entrypoint) => {
    const key = `${entrypoint.kind}\0${entrypoint.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function entrypointRank(entrypoint: E2eEntrypoint): number {
  const confidenceRankValue = entrypointConfidenceRank(entrypoint.confidence);
  const kindRank = entrypoint.kind === "route" ? 0 : entrypoint.kind === "screen" ? 1 : 2;
  return confidenceRankValue * 10 + kindRank;
}

function entrypointConfidenceRank(confidence: E2eEntrypointConfidence): number {
  if (confidence === "high") {
    return 0;
  }
  if (confidence === "medium") {
    return 1;
  }
  return 2;
}

function uniqueSetupHints(setupHints: E2eSetupHint[]): E2eSetupHint[] {
  const hintsByKind = new Map<E2eSetupHintKind, E2eSetupHint>();
  for (const hint of setupHints) {
    const existing = hintsByKind.get(hint.kind);
    if (!existing) {
      hintsByKind.set(hint.kind, { ...hint, files: uniqueStrings(hint.files).slice(0, maxFilesPerFlow) });
      continue;
    }
    existing.files = uniqueStrings([...existing.files, ...hint.files]).slice(0, maxFilesPerFlow);
    if (setupHintConfidenceRank(hint.confidence) < setupHintConfidenceRank(existing.confidence)) {
      existing.confidence = hint.confidence;
      existing.title = hint.title;
      existing.detail = hint.detail;
    }
  }
  return [...hintsByKind.values()].sort((left, right) => {
    const confidenceDiff = setupHintConfidenceRank(left.confidence) - setupHintConfidenceRank(right.confidence);
    if (confidenceDiff !== 0) {
      return confidenceDiff;
    }
    return setupHintKindRank(left.kind) - setupHintKindRank(right.kind);
  });
}

function setupHintConfidenceRank(confidence: E2eSetupHintConfidence): number {
  if (confidence === "high") {
    return 0;
  }
  if (confidence === "medium") {
    return 1;
  }
  return 2;
}

function setupHintKindRank(kind: E2eSetupHintKind): number {
  const ranks: Record<E2eSetupHintKind, number> = {
    auth: 0,
    payment: 1,
    network: 2,
    fixture: 3,
    state: 4,
    environment: 5,
  };
  return ranks[kind];
}

function uniqueCoverageTargets(targets: E2eCoverageTarget[]): E2eCoverageTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.title)) {
      return false;
    }
    seen.add(target.title);
    return true;
  });
}

function uniqueSelectors(selectors: E2eSelector[]): E2eSelector[] {
  const seen = new Set<string>();
  const ordered = [...selectors].sort((left, right) => selectorRank(left.kind) - selectorRank(right.kind));
  return ordered.filter((selector) => {
    const key = `${selector.kind}\0${selector.value}\0${selector.file}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function selectorRank(kind: E2eSelectorKind): number {
  if (kind === "test-id" || kind === "web-test-id") {
    return 0;
  }
  if (kind === "accessibility-label" || kind === "aria-label") {
    return 1;
  }
  if (kind === "placeholder") {
    return 2;
  }
  if (kind === "role-button" || kind === "role-link") {
    return 3;
  }
  return 4;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function quoteJs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toDisplayPath(root: string, filePath: string): string {
  const relativePath = path.relative(root, filePath);
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return toPosixPath(relativePath) || ".";
  }
  return filePath;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
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

function formatCoveragePriority(priority: E2eCoveragePriority): string {
  if (priority === "critical") {
    return "[critical]";
  }
  if (priority === "recommended") {
    return "[recommended]";
  }
  return "[optional]";
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}

function escapeMarkdownTableCell(value: string): string {
  return escapeMarkdownInline(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}
