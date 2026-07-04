import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { buildDomainLanguageSummary } from "./domain-language.js";
import { defaultDomainManifestPath, loadDomainManifest, matchDomains } from "./domains.js";
import { collectProjectFiles } from "./fs.js";
import { buildReverseImportIndex, expandChangedFilesWithImporters, findImportingSurfaces } from "./import-graph.js";
import type { ImportImpact } from "./import-graph.js";
import { loadCoreFlowManifest, matchCoreFlows } from "./flows.js";
import { loadVerificationManifest, matchVerificationManifest } from "./manifest.js";
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
import type { VerificationManifestMatch } from "./manifest.js";
import type { LocalHistoryReference } from "./history.js";
import type { CoverageEvidence, TestSuiteInventory, TestSuiteSummary } from "./test-evidence.js";
import { TOOL_NAME, VERSION } from "./version.js";

export type E2eProjectType =
  | "expo-react-native"
  | "react-native"
  | "web"
  | "api-service"
  | "design-tokens"
  | "data-catalog"
  | "cli"
  | "unknown";
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
  | "input-test-id"
  | "accessibility-label"
  | "input-accessibility-label"
  | "visible-text"
  | "web-test-id"
  | "input-web-test-id"
  | "aria-label"
  | "input-aria-label"
  | "placeholder"
  | "role-button"
  | "role-link";

export interface E2ePlanOptions extends TestPlanOptions {
  runner?: E2eRunnerName;
  manifestPath?: string;
}

export interface E2eDraftOptions extends E2ePlanOptions {
  output?: string;
  force?: boolean;
  maxDrafts?: number;
  dryRun?: boolean;
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
  apiEndpoints: string[];
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
  runnerSetup: E2eRunnerSetupProposal;
  testSuite: TestSuiteSummary;
  coreFlowManifestPath?: string;
  coreFlows: MatchedCoreFlow[];
  domainManifestPath?: string;
  domains: MatchedDomain[];
  verificationManifestPath?: string;
  verificationManifestMatches: VerificationManifestMatch[];
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

export type E2eRunnerSetupStatus = "ready" | "proposed" | "not-applicable";

export interface E2eRunnerSetupProposal {
  runner: E2eRunnerName;
  status: E2eRunnerSetupStatus;
  title: string;
  reason: string;
  setupCommand?: string;
  installCommands: string[];
  filesToCreate: string[];
  filesToUpdate: string[];
  nextCommands: string[];
  notes: string[];
}

export interface E2eDraftFile {
  path: string;
  flowTitle: string;
  runner: E2eRunnerName;
  status: "created" | "skipped" | "preview";
  source?: "verification-manifest" | "domain-language" | "core-flow" | "heuristic";
  changedFiles?: string[];
  draftSteps?: string[];
  entrypointHints?: string[];
  selectorHints?: string[];
  setupHints?: string[];
  coverageTargets?: string[];
  manifestUpdatePath?: string;
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
export type E2eDraftReadinessLevel = "ready" | "near-runnable" | "needs-work" | "blocked";

export interface E2eDraftReadinessSummary {
  score: number;
  level: E2eDraftReadinessLevel;
  recommendation: string;
  runnableCandidates: number;
  nearRunnable: number;
  reviewOnly: number;
  selfCheckPass: number;
  selfCheckWarning: number;
  selfCheckFail: number;
  filesWithTodos: number;
  totalTodos: number;
  filesWithExecutionBlockers: number;
  totalExecutionBlockers: number;
  topBlockers: string[];
}

export interface E2eDraftResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  generatedAt: string;
  runner: E2eRunnerName;
  outputDirectory: string;
  dryRun: boolean;
  plan: E2ePlanResult;
  files: E2eDraftFile[];
  actionSummary: E2eDraftActionSummary;
  readinessSummary: E2eDraftReadinessSummary;
  nextSteps: string[];
}

export interface E2eSetupOptions extends E2ePlanOptions {
  force?: boolean;
}

export interface E2eSetupResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  runner: E2eRunnerName;
  proposal: E2eRunnerSetupProposal;
  createdFiles: string[];
  updatedFiles: string[];
  skippedFiles: string[];
  installCommands: string[];
  nextCommands: string[];
  draftOutputDirectory?: string;
  draftFiles: E2eDraftFile[];
  draftReadinessSummary?: E2eDraftReadinessSummary;
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  bin?: string | Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
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
  const project = await detectProjectProfile(root, testPlan.workspaceRoot);
  const recommendedRunner = options.runner ? overrideRunner(project, options.runner) : recommendRunner(project);
  const executionProfile = await buildExecutionProfile(root, testPlan.workspaceRoot, project, recommendedRunner.name);
  const testSuiteInventory = await collectTestSuiteInventory(root);
  const coreFlowRoot = testPlan.workspaceRoot ?? root;
  const coreFlowManifest = await loadCoreFlowManifest(coreFlowRoot);
  const coreFlowChangedFiles = toCoreFlowChangedFiles(testPlan.changedFiles, root, coreFlowRoot);
  const matchableChangedFiles = await expandChangedFilesForMatching(coreFlowRoot, coreFlowChangedFiles);
  const coreFlows = matchCoreFlows(coreFlowManifest, matchableChangedFiles);
  const domainManifest = await loadDomainManifest(coreFlowRoot);
  const domains = matchDomains(domainManifest, matchableChangedFiles);
  const verificationManifest = await loadVerificationManifest(coreFlowRoot, { manifestPath: options.manifestPath });
  const verificationManifestMatches = matchVerificationManifest(verificationManifest, matchableChangedFiles);
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
  const runnerSetup = await buildRunnerSetupProposal(
    root,
    testPlan.workspaceRoot,
    project,
    recommendedRunner.name,
    executionProfile,
    testPlan.base,
    testPlan.head,
  );
  const bootstrap = buildE2eBootstrapPlan({
    base: testPlan.base,
    head: testPlan.head,
    projectType: project.type,
    recommendedRunner,
    executionProfile,
    runnerSetup,
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
    runnerSetup,
    testSuite,
    coreFlowManifestPath: coreFlowManifest.path,
    coreFlows,
    domainManifestPath: domainManifest.path,
    domains,
    verificationManifestPath: verificationManifest.path,
    verificationManifestMatches,
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
  const draftLimit = options.maxDrafts && options.maxDrafts > 0 ? Math.floor(options.maxDrafts) : undefined;
  const flows = (await buildDraftFlows(plan)).slice(0, draftLimit);
  const dryRun = options.dryRun ?? false;

  if (!dryRun) {
    await fs.mkdir(outputDirectory, { recursive: true });
  }

  const files: E2eDraftFile[] = [];
  for (const flow of flows) {
    const filePath = path.join(outputDirectory, `${slugify(flow.title)}${draftExtension(runner)}`);
    const displayPath = toDisplayPath(root, filePath);
    const validationSummary = summarizeDraftValidation(flow);
    const promotionGuidance = buildDraftPromotionGuidance(flow);
    const fileAlreadyExists = await exists(filePath);
    const shouldSkip = fileAlreadyExists && !options.force && !dryRun;
    const content = shouldSkip ? ((await readTextIfExists(filePath)) ?? "") : draftContentForFlow(plan, flow, runner);
    const todoCount = countTodos(content);
    const selfCheck = evaluateDraftSelfCheck(plan, flow, runner, content, todoCount);
    const actionItems = buildDraftActionItems(plan, flow, runner, validationSummary, promotionGuidance, selfCheck);
    const executionBlockers = draftExecutionBlockers(plan, flow, runner, validationSummary, selfCheck);
    const runnableStatus = draftRunnableStatus(plan, flow, runner, validationSummary, executionBlockers, selfCheck);
    const fileDetails = draftFileDetails(flow);
    if (dryRun) {
      files.push({
        path: displayPath,
        flowTitle: flow.title,
        runner,
        status: "preview",
        source: draftFlowSource(flow),
        ...fileDetails,
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
        reason: dryRunPreviewReason(fileAlreadyExists, options.force ?? false),
      });
      continue;
    }
    if (shouldSkip) {
      files.push({
        path: displayPath,
        flowTitle: flow.title,
        runner,
        status: "skipped",
        source: draftFlowSource(flow),
        ...fileDetails,
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
      ...fileDetails,
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

  const actionSummary = summarizeDraftActionItems(files);
  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    generatedAt: new Date().toISOString(),
    runner,
    outputDirectory: toDisplayPath(root, outputDirectory),
    dryRun,
    plan,
    files,
    actionSummary,
    readinessSummary: summarizeDraftReadiness(files, actionSummary),
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

  const hasArtifactOrCatalogFiles = files.some((file) => isDesignTokenFile(file) || isCatalogDataFile(file));
  if (kind === "content" || (files.some(isContentOrStyleFile) && !hasArtifactOrCatalogFiles)) {
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

  if (kind === "artifact" || files.some(isDesignTokenFile)) {
    targets.push(
      coverageTarget(
        "Token schema and generated artifact compatibility",
        "critical",
        "Design token changes can break consumers even when no app screen changed.",
        [
          "Validate required token fields, references, aliases, and naming conventions.",
          "Regenerate published artifacts such as CSS variables, theme JSON, platform files, or package output.",
          "Verify removed or renamed tokens have an intentional migration path for consumers.",
        ],
      ),
      coverageTarget(
        "Downstream consumer visual fixture",
        "recommended",
        "A token diff is most valuable when at least one consumer sample proves the visual effect is intentional.",
        [
          "Render or inspect a representative component, theme sample, or screenshot fixture.",
          "Compare light, dark, semantic, or platform-specific variants when those tokens changed.",
        ],
      ),
    );
  }

  if (kind === "catalog" || files.some(isCatalogDataFile)) {
    targets.push(
      coverageTarget(
        "Catalog schema and generated output compatibility",
        "critical",
        "Taxonomy and catalog changes should preserve machine-readable contracts for downstream consumers.",
        [
          "Validate changed entries against the catalog schema, migration script, or build command.",
          "Regenerate the published site, JSON export, markdown table, or package artifact.",
          "Verify event, property, owner, and description fields remain backward compatible where required.",
        ],
      ),
      coverageTarget(
        "Consumer fixture and migration coverage",
        "recommended",
        "Catalog updates often need one representative consumer or migration fixture instead of a browser E2E.",
        [
          "Run one analytics, documentation, ingestion, or SDK fixture that reads the changed catalog.",
          "Check renamed, removed, deprecated, or newly-required fields with realistic sample data.",
        ],
      ),
    );
  }

  if (kind === "command") {
    targets.push(
      coverageTarget(
        "CLI command contract",
        "critical",
        "CLI changes should protect the command contract that users automate in scripts and CI.",
        [
          "Run the changed command with a valid argument set.",
          "Verify stdout, stderr, exit code, and any generated files.",
          "Keep command examples aligned with README or help output.",
        ],
      ),
      coverageTarget(
        "CLI failure and usage paths",
        "critical",
        "Command-line tools need explicit invalid input coverage because silent success or unclear errors break automation.",
        [
          "Run missing-argument, invalid-option, and unsupported-input cases when relevant.",
          "Verify the failure message, exit code, and absence of partial generated output.",
        ],
      ),
    );
  }

  if (kind === "test-evidence") {
    targets.push(
      coverageTarget(
        "Changed test evidence maps to behavior",
        "critical",
        "Test-only changes are valuable only when reviewers can see what behavior, bug, or regression risk the tests protect.",
        [
          "Run the changed test file or nearest package test command.",
          "Name the product behavior, bug, or risk protected by the changed test evidence.",
          "Confirm the evidence is not just a snapshot or assertion update without behavioral intent.",
        ],
      ),
      coverageTarget(
        "Failure and edge signal",
        "recommended",
        "A changed test suite should prove at least one meaningful failure, boundary, or previous-regression case when no product code changed.",
        [
          "Verify invalid, empty, failed-response, permission, or previous-regression behavior when relevant.",
          "Record why the changed test would fail if the protected behavior regressed.",
        ],
      ),
    );
  }

  if (kind === "documentation") {
    targets.push(
      coverageTarget(
        "Documentation-to-behavior consistency",
        "critical",
        "Documentation changes should be checked against the actual command, API, workflow, or policy they describe.",
        [
          "Compare changed docs with source, CLI output, examples, or existing tests.",
          "Run docs build, markdown, link, or example validation when available.",
        ],
      ),
      coverageTarget(
        "Documented behavior test gap",
        "recommended",
        "A doc update can reveal behavior that should be protected later even when this PR does not change runtime code.",
        [
          "Identify any documented workflow that lacks automated coverage.",
          "Record the missing product test as follow-up evidence instead of treating the doc change as E2E coverage.",
        ],
      ),
    );
  }

  if (kind === "generated-artifact" || files.some(isGeneratedOutputFile)) {
    targets.push(
      coverageTarget(
        "Source-of-truth regeneration",
        "critical",
        "Generated output should be reproducible from a committed schema, template, source file, or generator command.",
        [
          "Re-run the generator or build command that owns the changed output.",
          "Confirm the generated diff matches the committed source-of-truth input.",
        ],
      ),
      coverageTarget(
        "Generated artifact consumer compatibility",
        "recommended",
        "Generated artifacts can break consumers even when the generator succeeds.",
        [
          "Run a consumer build, typecheck, or test that imports the generated artifact.",
          "Check renamed, removed, or newly-required generated fields against representative consumers.",
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
      requiredEvidence: testabilityRequiredEvidence(flow),
      currentEvidence: testabilityEvidenceSummary(flow),
      status: validationStatusFromTestability(flow),
      nextAction: nextActionForTestability(flow),
      flowTitle: flow.title,
      files: testabilityEvidenceFiles(flow),
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
  runnerSetup: E2eRunnerSetupProposal;
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
  const draftCommand = `qamap e2e draft . --base ${input.base} --head ${input.head}`;
  const planHistoryCommand = `qamap e2e plan . --base ${input.base} --head ${input.head} --record-history`;
  const domainsSuggestCommand = `qamap domains suggest . --base ${input.base} --head ${input.head}`;
  const flowsSuggestCommand = `qamap flows suggest . --base ${input.base} --head ${input.head}`;
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
        manualBootstrapTitle(input.projectType),
        manualBootstrapReason(input.projectType),
        manualBootstrapAction(input.projectType),
        [],
        [],
      ),
    );
  } else if (runnerGap) {
    const setupCommands = uniqueStrings([
      ...input.runnerSetup.installCommands,
      ...(input.runnerSetup.setupCommand ? [input.runnerSetup.setupCommand] : []),
      ...input.runnerSetup.nextCommands,
    ]);
    steps.push(
      bootstrapStep(
        "runner",
        "required",
        `Configure ${formatRunnerName(input.recommendedRunner.name)} before making drafts required`,
        runnerGap,
        input.recommendedRunner.name === "playwright"
          ? `${playwrightConfigGuidance(input.executionProfile)} Review the setup proposal, then run \`${input.runnerSetup.setupCommand ?? "qamap e2e setup . --runner playwright"}\` if the team accepts Playwright for this repo.`
          : `Review the setup proposal, then run \`${input.runnerSetup.setupCommand ?? "qamap e2e setup . --runner maestro"}\` if the team accepts Maestro for this repo.`,
        setupCommands,
        [],
      ),
    );
  } else {
    steps.push(
      bootstrapStep(
        "runner",
        "ready",
        `${formatRunnerName(input.recommendedRunner.name)} setup signal detected`,
        "QAMap found enough runner setup evidence to generate runnable drafts.",
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
        "No existing test files were detected, so this branch needs a concrete first draft before QAMap can compare coverage evidence.",
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
        `QAMap inferred ${input.domainLanguage.terms.length} domain term${input.domainLanguage.terms.length === 1 ? "" : "s"} from changed files, but no shared domain manifest was found.`,
        "Generate a suggested domain manifest from this branch, review names and routes with the team, then commit only the terms that match team language.",
        [domainsSuggestCommand, `${domainsSuggestCommand} --write .qamap/domains.yml`],
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
        "No .qamap/flows.yml manifest was found, so QAMap can infer changed-flow candidates but cannot distinguish team-critical journeys yet.",
        "Generate suggested flow entries from this branch, keep only the journeys humans agree are durable, then commit them as team policy.",
        [flowsSuggestCommand, `${flowsSuggestCommand} --write .qamap/flows.yml`],
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
          ? missingFixtureRows.length === 1
            ? "1 API-dependent flow lacks fixture evidence."
            : `${missingFixtureRows.length} API-dependent flows lack fixture evidence.`
          : partialFixtureRows.length === 1
            ? "1 API-dependent flow has only partial fixture evidence."
            : `${partialFixtureRows.length} API-dependent flows have only partial fixture evidence.`,
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
        "Review the generated locators and replace weak starter assertions with domain-specific checks before promoting the draft.",
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
        input.validationMatrix.summary.missing === 1
          ? "1 validation row is missing evidence."
          : `${input.validationMatrix.summary.missing} validation rows are missing evidence.`,
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
        input.validationMatrix.summary.partial === 1
          ? "1 validation row is only partial."
          : `${input.validationMatrix.summary.partial} validation rows are only partial.`,
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
        "Add a project script or QAMap validation command so PR evidence can include repeatable checks.",
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

function manualBootstrapTitle(projectType: E2eProjectType): string {
  if (projectType === "api-service") {
    return "Start with API contract validation";
  }
  if (projectType === "design-tokens") {
    return "Start with design token artifact validation";
  }
  if (projectType === "data-catalog") {
    return "Start with catalog artifact validation";
  }
  if (projectType === "cli") {
    return "Start with CLI command validation";
  }
  return "Choose the first runnable E2E runner";
}

function manualBootstrapReason(projectType: E2eProjectType): string {
  if (projectType === "api-service") {
    return "QAMap detected an API or backend service, so generated output should start as a contract checklist before assuming a browser or device runner.";
  }
  if (projectType === "design-tokens") {
    return "QAMap detected design token artifacts, so generated output should verify schema, generated outputs, and consumer samples before assuming a browser journey.";
  }
  if (projectType === "data-catalog") {
    return "QAMap detected taxonomy or catalog artifacts, so generated output should verify schema, generated outputs, and downstream consumers before assuming a browser journey.";
  }
  if (projectType === "cli") {
    return "QAMap detected package executable commands, so generated output should verify command behavior, arguments, output, and exit codes before assuming a browser or device journey.";
  }
  return "QAMap could not detect a web, Expo, React Native, or API service surface, so generated output should start as a manual checklist.";
}

function manualBootstrapAction(projectType: E2eProjectType): string {
  if (projectType === "api-service") {
    return "Document the local service start command, base URL, auth fixture, and request examples before making API contract checks required in CI.";
  }
  if (projectType === "design-tokens") {
    return "Document the token validation command, artifact generation command, and one representative consumer or visual fixture before making the checklist required in CI.";
  }
  if (projectType === "data-catalog") {
    return "Document the catalog validation command, generation command, and one downstream consumer or migration fixture before making the checklist required in CI.";
  }
  if (projectType === "cli") {
    return "Document the changed command path, valid and invalid argument examples, expected stdout/stderr, exit codes, and fixture files before making the checklist required in CI.";
  }
  return "Document the app entrypoint and pick Playwright, Maestro, or a project-specific runner before requiring generated drafts in CI.";
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
    readiness.apiEndpoints.length > 0 ? `${readiness.apiEndpoints.length} endpoint hint${readiness.apiEndpoints.length === 1 ? "" : "s"}` : "",
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

function testabilityRequiredEvidence(flow: E2eFlow): string {
  if (isDesignTokenFocusedFlow(flow)) {
    return "Documented token validation command, generated artifact path, and downstream consumer or visual fixture.";
  }
  if (isCatalogFocusedFlow(flow)) {
    return "Documented catalog validation command, generated output path, and downstream consumer or migration fixture.";
  }
  if (isEvidenceVerificationFocusedFlow(flow)) {
    return "Documented validation command, result, and the behavior or source-of-truth evidence this change protects.";
  }
  return "Stable selectors, entrypoint hints, and no unresolved testability gaps.";
}

function testabilityEvidenceSummary(flow: E2eFlow): string {
  if (flow.missingTestability.length > 0) {
    return `${flow.missingTestability.length} testability gap${flow.missingTestability.length === 1 ? "" : "s"} detected.`;
  }
  if (isDesignTokenFocusedFlow(flow)) {
    return "Artifact verification flow uses token validation commands, generated artifacts, and a consumer fixture as stability evidence.";
  }
  if (isCatalogFocusedFlow(flow)) {
    return "Catalog verification flow uses catalog validation commands, generated outputs, and a consumer or migration fixture as stability evidence.";
  }
  if (isEvidenceVerificationFocusedFlow(flow)) {
    return "Evidence verification flow uses commands, generated output, docs checks, or changed tests instead of selector coverage.";
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
  if (isDesignTokenFocusedFlow(flow) || isCatalogFocusedFlow(flow)) {
    return "ready";
  }
  if (isEvidenceVerificationFocusedFlow(flow)) {
    return "ready";
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
  if (isDesignTokenFocusedFlow(flow)) {
    return "Use the artifact validation and consumer fixture checks in the generated checklist.";
  }
  if (isCatalogFocusedFlow(flow)) {
    return "Use the catalog generation and consumer fixture checks in the generated checklist.";
  }
  if (isEvidenceVerificationFocusedFlow(flow)) {
    return "Use the evidence validation command, result, and protected behavior in the generated checklist.";
  }
  if (flow.selectors.length > 0 || flow.entrypoints.length > 0) {
    return "Use the detected selectors and entrypoints in the generated draft.";
  }
  return "Identify a stable entrypoint and selector strategy for this flow.";
}

function testabilityEvidenceFiles(flow: E2eFlow): string[] {
  if (flow.missingTestability.length > 0 || isDesignTokenFocusedFlow(flow) || isCatalogFocusedFlow(flow)) {
    return flow.files.slice(0, maxFilesPerFlow);
  }
  return flow.selectors.map((selector) => selector.file).slice(0, maxFilesPerFlow);
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
  const manifestMatch = manifestMatchForDraftFlow(flow);
  const coreFlow = coreFlowForDraftFlow(flow);
  const scenario = domainScenarioForFlow(flow);
  const hasEntrypoint = flow.entrypoints.length > 0;
  const hasChecks =
    flow.steps.length > 0 ||
    (manifestMatch?.checks?.length ?? 0) > 0 ||
    (scenario?.checks.length ?? 0) > 0 ||
    (coreFlow?.checks.length ?? 0) > 0;

  if (manifestMatch) {
    if (hasEntrypoint && hasChecks) {
      return {
        status: "commit-candidate",
        reason: "Verification manifest matched the changed files with flow checks and an entrypoint.",
        action: "Keep the manifest checks as required PR evidence, then wire them to runnable assertions and fixtures.",
      };
    }
    return {
      status: "needs-review",
      reason: "Verification manifest matched the change, but runnable entrypoint, selectors, or checks still need confirmation.",
      action: "Refine `.qamap/manifest.yaml` anchors, route, and checks so the next draft is closer to runnable coverage.",
    };
  }

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
        action: "Review the scenario name with the team, then commit it to `.qamap/domains.yml` or `.qamap/flows.yml` if it is durable.",
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
    const setupCommand = plan.runnerSetup.setupCommand ? ` Run \`${plan.runnerSetup.setupCommand}\` after accepting this runner setup.` : "";
    const setupDetail =
      runner === "playwright"
        ? `${playwrightConfigGuidance(plan.executionProfile)}${setupCommand}`
        : `${runnerGap}${setupCommand}`;
    items.push(draftActionItem(
      "runner",
      "required",
      `Configure ${formatRunnerName(runner)} execution`,
      setupDetail,
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
    const routeDraft = buildPlaywrightRouteDraft(route.value, flow.entrypoints);
    const unresolvedParams = routeDraft.params.filter((param) => param.value === undefined);
    if (unresolvedParams.length > 0) {
      items.push(draftActionItem(
        "fixture",
        "required",
        "Replace dynamic route parameters",
        `Provide real fixture values for ${unresolvedParams.map((param) => param.name).join(", ")} before running ${route.value}.`,
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
      "Replace starter smoke assertions with domain assertions",
      `Preserve the success signal "${flow.languageBrief.successSignal}" while replacing weak fallback interactions and generic expects.`,
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

function draftFileDetails(flow: DraftE2eFlow): Pick<
  E2eDraftFile,
  | "changedFiles"
  | "draftSteps"
  | "entrypointHints"
  | "selectorHints"
  | "setupHints"
  | "coverageTargets"
  | "manifestUpdatePath"
> {
  return {
    changedFiles: flow.files.slice(0, maxFilesPerFlow),
    draftSteps: flow.steps.slice(0, 8),
    entrypointHints: flow.entrypoints.map(formatEntrypointHint).slice(0, 6),
    selectorHints: flow.selectors.map(formatSelectorHint).slice(0, 8),
    setupHints: flow.setupHints.map((hint) => `${hint.title}: ${hint.detail}`).slice(0, 6),
    coverageTargets: flow.coverage.map((target) => `${target.priority}: ${target.title}`).slice(0, 7),
    manifestUpdatePath: flow.manifestMatch?.updatePath,
  };
}

function formatEntrypointHint(entrypoint: E2eEntrypoint): string {
  return `${entrypoint.kind}: ${entrypoint.value} (${entrypoint.confidence})`;
}

function formatSelectorHint(selector: E2eSelector): string {
  return `${selector.kind}: ${selector.value} (${selector.file})`;
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

function summarizeDraftReadiness(
  files: E2eDraftFile[],
  actionSummary: E2eDraftActionSummary,
): E2eDraftReadinessSummary {
  const totalFiles = Math.max(files.length, 1);
  const runnableCandidates = files.filter((file) => file.runnableStatus === "runnable-candidate").length;
  const nearRunnable = files.filter((file) => file.runnableStatus === "near-runnable").length;
  const reviewOnly = files.filter((file) => file.runnableStatus === "review-only").length;
  const selfCheckPass = files.filter((file) => file.selfCheck?.status === "pass").length;
  const selfCheckWarning = files.filter((file) => file.selfCheck?.status === "warning").length;
  const selfCheckFail = files.filter((file) => file.selfCheck?.status === "fail").length;
  const filesWithTodos = files.filter((file) => (file.todoCount ?? 0) > 0).length;
  const totalTodos = files.reduce((sum, file) => sum + (file.todoCount ?? 0), 0);
  const filesWithExecutionBlockers = files.filter((file) => (file.executionBlockers?.length ?? 0) > 0).length;
  const totalExecutionBlockers = files.reduce((sum, file) => sum + (file.executionBlockers?.length ?? 0), 0);
  const topBlockers = topDraftReadinessBlockers(files);

  const statusScore =
    (runnableCandidates * 100 + nearRunnable * 75 + reviewOnly * 35) / totalFiles;
  const selfCheckPenalty = (selfCheckWarning * 10 + selfCheckFail * 25) / totalFiles;
  const requiredActionPenalty = Math.min(25, actionSummary.required * 3);
  const todoPenalty = Math.min(15, totalTodos);
  const blockerPenalty = Math.min(20, filesWithExecutionBlockers * 5);
  const score = clampReadinessScore(
    Math.round(statusScore - selfCheckPenalty - requiredActionPenalty - todoPenalty - blockerPenalty),
  );
  const level = draftReadinessLevel(score, actionSummary.required, selfCheckFail, reviewOnly);

  return {
    score,
    level,
    recommendation: draftReadinessRecommendation(level, topBlockers),
    runnableCandidates,
    nearRunnable,
    reviewOnly,
    selfCheckPass,
    selfCheckWarning,
    selfCheckFail,
    filesWithTodos,
    totalTodos,
    filesWithExecutionBlockers,
    totalExecutionBlockers,
    topBlockers,
  };
}

function topDraftReadinessBlockers(files: E2eDraftFile[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const blockers = [...(file.executionBlockers ?? []), ...(file.selfCheck?.blockers ?? [])];
    for (const blocker of uniqueStrings(blockers)) {
      counts.set(blocker, (counts.get(blocker) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([blocker, count]) => count > 1 ? `${blocker} (${count} files)` : blocker);
}

function clampReadinessScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function draftReadinessLevel(
  score: number,
  requiredActions: number,
  selfCheckFail: number,
  reviewOnly: number,
): E2eDraftReadinessLevel {
  if (score >= 85 && requiredActions === 0 && selfCheckFail === 0 && reviewOnly === 0) {
    return "ready";
  }
  if (score >= 70 && selfCheckFail === 0) {
    return "near-runnable";
  }
  if (score >= 45) {
    return "needs-work";
  }
  return "blocked";
}

function draftReadinessRecommendation(level: E2eDraftReadinessLevel, blockers: string[]): string {
  if (level === "ready") {
    return "Generated drafts are ready to try as local regression evidence.";
  }
  if (level === "near-runnable") {
    return "Run the suggested command locally, then close the remaining recommended review items.";
  }
  const blocker = blockers[0];
  if (level === "needs-work") {
    return blocker
      ? `Resolve the highest-impact blocker first: ${withTerminalPeriod(blocker)}`
      : "Close required action items before treating the drafts as regression evidence.";
  }
  return blocker
    ? `Do not treat these drafts as runnable yet. Start with: ${withTerminalPeriod(blocker)}`
    : "Do not treat these drafts as runnable until required setup and validation gaps are closed.";
}

function withTerminalPeriod(value: string): string {
  return /[.!?)]$/.test(value.trim()) ? value.trim() : `${value.trim()}.`;
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
  if (isDesignTokenFocusedFlow(flow)) {
    return "Design system consumer or maintainer";
  }
  if (isCatalogFocusedFlow(flow)) {
    return "Data catalog consumer or maintainer";
  }
  if (isTestEvidenceFocusedFlow(flow)) {
    return "Maintainer or test author";
  }
  if (isDocumentationFocusedFlow(flow)) {
    return "Maintainer or documentation reviewer";
  }
  if (isGeneratedArtifactFocusedFlow(flow)) {
    return "Maintainer or build owner";
  }
  if (isCliCommandFocusedFlow(flow)) {
    return "CLI user or maintainer";
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
  if (/\b(checkout|purchase|payment|order|cart|offer|listing|subscription|membership|billing)\b/.test(haystack)) {
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
    if (isDesignTokenFocusedFlow(flow)) {
      return `Regenerate or inspect the token artifact affected by ${flow.files[0]}.`;
    }
    if (isCatalogFocusedFlow(flow)) {
      return `Regenerate or validate the catalog artifact affected by ${flow.files[0]}.`;
    }
    if (isTestEvidenceFocusedFlow(flow)) {
      return `Run the changed test evidence affected by ${flow.files[0]}.`;
    }
    if (isDocumentationFocusedFlow(flow)) {
      return `Review the documented behavior affected by ${flow.files[0]}.`;
    }
    if (isGeneratedArtifactFocusedFlow(flow)) {
      return `Regenerate the artifact affected by ${flow.files[0]}.`;
    }
    if (isCliCommandFocusedFlow(flow)) {
      return `Run the CLI command path affected by ${flow.files[0]}.`;
    }
    if (/\bconfiguration verification\b/i.test(flow.title)) {
      return `Run the build, startup, or release path affected by ${flow.files[0]}.`;
    }
    return `Start from the product surface that owns ${flow.files[0]}.`;
  }
  if (isApiContractFocusedFlow(flow)) {
    return "Call one representative health, auth, or changed-domain endpoint.";
  }
  if (isCliCommandFocusedFlow(flow)) {
    return "Run the representative changed CLI command path.";
  }
  if (isDesignTokenFocusedFlow(flow)) {
    return "Run the token validation or artifact generation command.";
  }
  if (isCatalogFocusedFlow(flow)) {
    return "Run the catalog validation or generation command.";
  }
  return "Launch the app and wait for the first stable screen.";
}

function inferFlowGoal(flow: Omit<E2eFlow, "languageBrief">): string {
  if (isApiContractFocusedFlow(flow)) {
    return `Protect ${flow.title} by verifying the changed request, response, auth, and failure contract.`;
  }
  if (isDesignTokenFocusedFlow(flow)) {
    return `Protect ${flow.title} by verifying token schema, generated artifacts, and at least one consumer sample.`;
  }
  if (isCatalogFocusedFlow(flow)) {
    return `Protect ${flow.title} by verifying catalog schema, generated output, and downstream consumer compatibility.`;
  }
  if (isTestEvidenceFocusedFlow(flow)) {
    return `Protect ${flow.title} by proving the changed test evidence maps to a real behavior, bug, or regression risk.`;
  }
  if (isDocumentationFocusedFlow(flow)) {
    return `Protect ${flow.title} by checking that changed documentation still matches actual repository behavior.`;
  }
  if (isGeneratedArtifactFocusedFlow(flow)) {
    return `Protect ${flow.title} by proving generated output is reproducible and accepted by consumers.`;
  }
  if (isCliCommandFocusedFlow(flow)) {
    return `Protect ${flow.title} by verifying command invocation, output, generated files, exit codes, and invalid input behavior.`;
  }
  if (/\bconfiguration verification\b/i.test(flow.title)) {
    return `Protect ${flow.title} by verifying clean install, startup, and fallback configuration variants.`;
  }
  const primaryStep = flow.steps.find(isFlowGoalCandidateStep) ?? flow.steps[0];
  if (primaryStep) {
    return `Protect ${flow.title} by ${lowercaseFirst(stripTerminalPunctuation(primaryStep))}.`;
  }
  return `Protect ${flow.title} for the changed behavior.`;
}

function isFlowGoalCandidateStep(step: string): boolean {
  return !isEntrypointPreparationStep(step) && !/^record\b|^run or open\b/i.test(step);
}

function inferFlowSuccessSignal(flow: Omit<E2eFlow, "languageBrief">): string {
  if (isApiContractFocusedFlow(flow)) {
    return "the changed contract returns the expected status, response shape, auth behavior, and failure handling";
  }
  if (isDesignTokenFocusedFlow(flow)) {
    return "the token schema, generated artifacts, semantic aliases, and consumer sample all reflect the intended change";
  }
  if (isCatalogFocusedFlow(flow)) {
    return "the catalog schema, generated output, and representative consumer fixture all accept the changed entries";
  }
  if (isTestEvidenceFocusedFlow(flow)) {
    return "the changed test evidence runs and clearly names the behavior, bug, or regression risk it protects";
  }
  if (isDocumentationFocusedFlow(flow)) {
    return "the changed documentation matches current commands, examples, source behavior, or existing tests";
  }
  if (isGeneratedArtifactFocusedFlow(flow)) {
    return "the generated output can be reproduced from source-of-truth inputs and accepted by consumers";
  }
  if (isCliCommandFocusedFlow(flow)) {
    return "the command returns the expected stdout, stderr, generated files, and exit code for valid and invalid inputs";
  }
  if (/\bconfiguration verification\b/i.test(flow.title)) {
    return "the affected build or runtime variant starts cleanly and handles fallback values";
  }
  const verificationStep = flow.steps.find((step) => isAssertionStep(step));
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
  if (isDesignTokenFocusedFlow(flow)) {
    return `Can a reviewer confirm that the changed token artifact is regenerated, consumed, and that "${successSignal}" is asserted?`;
  }
  if (isCatalogFocusedFlow(flow)) {
    return `Can a reviewer confirm that the changed catalog artifact is regenerated, consumed, and that "${successSignal}" is asserted?`;
  }
  if (isTestEvidenceFocusedFlow(flow)) {
    return `Can a reviewer confirm that the changed tests are run and that "${successSignal}" is documented as PR evidence?`;
  }
  if (isDocumentationFocusedFlow(flow)) {
    return `Can a reviewer confirm that docs validation ran and that "${successSignal}" is true?`;
  }
  if (isGeneratedArtifactFocusedFlow(flow)) {
    return `Can a reviewer confirm that the artifact was regenerated and that "${successSignal}" is true?`;
  }
  if (isCliCommandFocusedFlow(flow)) {
    return `Can a reviewer confirm that the changed command path is run and that "${successSignal}" is asserted?`;
  }
  if (/\bconfiguration verification\b/i.test(flow.title)) {
    return `Can a reviewer confirm that the affected build, startup, or release variant is exercised and that "${successSignal}" is asserted?`;
  }
  return `Can a reviewer confirm that ${flow.title} still works from this entrypoint and that "${successSignal}" is asserted?`;
}

function isApiContractFocusedFlow(flow: Omit<E2eFlow, "languageBrief">): boolean {
  if (isEvidenceVerificationFocusedFlow(flow)) {
    return false;
  }
  return (
    /\bapi contract\b/i.test(flow.title) ||
    (flow.coverage.some((target) => target.title === "API contract compatibility") &&
      !hasUserFacingEntrypointOrFile(flow))
  );
}

function isDesignTokenFocusedFlow(flow: Omit<E2eFlow, "languageBrief">): boolean {
  return /\bdesign token contract\b/i.test(flow.title) || flow.files.some(isDesignTokenFile);
}

function isCatalogFocusedFlow(flow: Omit<E2eFlow, "languageBrief">): boolean {
  return /\btaxonomy catalog verification\b/i.test(flow.title) || flow.files.some(isCatalogDataFile);
}

function isTestEvidenceFocusedFlow(flow: Omit<E2eFlow, "languageBrief">): boolean {
  return /\btest evidence\b/i.test(flow.title) || (flow.files.length > 0 && flow.files.every(isTestLikeFile));
}

function isDocumentationFocusedFlow(flow: Omit<E2eFlow, "languageBrief">): boolean {
  return /\bdocumentation verification\b/i.test(flow.title) || (flow.files.length > 0 && flow.files.every(isDocumentationFile));
}

function isGeneratedArtifactFocusedFlow(flow: Omit<E2eFlow, "languageBrief">): boolean {
  return /\bgenerated artifact verification\b/i.test(flow.title) || (flow.files.length > 0 && flow.files.every(isGeneratedOutputFile));
}

function isCliCommandFocusedFlow(flow: Omit<E2eFlow, "languageBrief">): boolean {
  return /\bCLI command verification\b/i.test(flow.title);
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
  lines.push("# QAMap E2E Plan");
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
  if (result.verificationManifestPath) {
    lines.push(`- Verification manifest: \`${escapeMarkdownInline(result.verificationManifestPath)}\``);
  }
  lines.push(`- Matched core flows: ${result.coreFlows.length}`);
  lines.push(`- Matched domains: ${result.domains.length}`);
  lines.push(`- Manifest recommendations: ${result.verificationManifestMatches.length}`);
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
  appendRunnerSetupProposalMarkdown(lines, result.runnerSetup);

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

  appendVerificationManifestMatchesMarkdown(lines, result.verificationManifestMatches);

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

function appendVerificationManifestMatchesMarkdown(lines: string[], matches: VerificationManifestMatch[]): void {
  if (matches.length === 0) {
    return;
  }

  lines.push("## Manifest Recommendations");
  lines.push("");
  lines.push(
    "These recommendations come from `.qamap/manifest.yaml`. If they are wrong, update the manifest path shown below so the next PR gets better suggestions.",
  );
  lines.push("");

  for (const match of matches.slice(0, 10)) {
    lines.push(`### ${escapeMarkdownInline(match.name)} \`${escapeMarkdownInline(match.id)}\``);
    lines.push("");
    lines.push(`- Kind: ${match.kind}`);
    lines.push(`- Confidence: ${match.confidence}`);
    lines.push(`- Why this was recommended: ${escapeMarkdownInline(match.reason)}`);
    if (match.evidenceSources.length > 0) {
      lines.push(`- Evidence sources: ${match.evidenceSources.map(escapeMarkdownInline).join(", ")}`);
    }
    lines.push(`- Manifest evidence: \`${escapeMarkdownInline(match.manifestPath)}\``);
    lines.push(`- If this is wrong: update \`${escapeMarkdownInline(match.updatePath)}\``);
    if (match.nextActions.length > 0) {
      lines.push("- Next actions:");
      for (const action of match.nextActions.slice(0, 4)) {
        lines.push(`  - ${escapeMarkdownInline(action)}`);
      }
    }
    if (match.repairHints.length > 0) {
      lines.push("- Repair hints:");
      for (const hint of match.repairHints.slice(0, 4)) {
        lines.push(`  - ${escapeMarkdownInline(hint)}`);
      }
    }
    if (match.matchedFiles.length > 0) {
      lines.push("- Matched files:");
      for (const file of match.matchedFiles.slice(0, maxFilesPerFlow)) {
        lines.push(`  - \`${escapeMarkdownInline(file)}\``);
      }
    }
    lines.push("");
  }
}

export function formatMarkdownE2eDraft(result: E2eDraftResult): string {
  const lines: string[] = [];
  lines.push("# QAMap E2E Draft");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  lines.push(`- Runner: ${formatRunnerName(result.runner)}`);
  lines.push(`- Output directory: \`${escapeMarkdownInline(result.outputDirectory)}\``);
  if (result.dryRun) {
    lines.push("- Mode: dry run (no files were written)");
  }
  lines.push(
    `- Files: ${result.files.filter((file) => file.status === "created").length} created, ${result.files.filter((file) => file.status === "preview").length} previewed, ${result.files.filter((file) => file.status === "skipped").length} skipped`,
  );
  lines.push("");

  lines.push("## Draft Readiness Summary");
  lines.push("");
  lines.push(
    `Score: ${result.readinessSummary.score}/100 (${result.readinessSummary.level}) - ${escapeMarkdownInline(result.readinessSummary.recommendation)}`,
  );
  lines.push(
    `Summary: ${result.actionSummary.required} required action${result.actionSummary.required === 1 ? "" : "s"}, ${result.actionSummary.recommended} recommended action${result.actionSummary.recommended === 1 ? "" : "s"}.`,
  );
  lines.push(`- Runnable candidates: ${result.readinessSummary.runnableCandidates}`);
  lines.push(`- Near-runnable files: ${result.readinessSummary.nearRunnable}`);
  lines.push(`- Review-only files: ${result.readinessSummary.reviewOnly}`);
  lines.push(
    `- Self-checks: ${result.readinessSummary.selfCheckPass} pass, ${result.readinessSummary.selfCheckWarning} warning, ${result.readinessSummary.selfCheckFail} fail`,
  );
  lines.push(`- TODO markers: ${result.readinessSummary.totalTodos} across ${result.readinessSummary.filesWithTodos} file${result.readinessSummary.filesWithTodos === 1 ? "" : "s"}`);
  lines.push(`- Execution blockers: ${result.readinessSummary.totalExecutionBlockers} across ${result.readinessSummary.filesWithExecutionBlockers} file${result.readinessSummary.filesWithExecutionBlockers === 1 ? "" : "s"}`);
  if (result.readinessSummary.topBlockers.length > 0) {
    lines.push("- Top blockers:");
    for (const blocker of result.readinessSummary.topBlockers.slice(0, 3)) {
      lines.push(`  - ${escapeMarkdownInline(blocker)}`);
    }
  }
  lines.push(`- Ready files: ${result.actionSummary.readyFiles}`);
  lines.push(`- Files with required actions: ${result.actionSummary.filesWithRequiredActions}`);
  lines.push(`- Files with recommended actions: ${result.actionSummary.filesWithRecommendedActions}`);
  if (result.actionSummary.byKind.length > 0) {
    lines.push(`- Action categories: ${formatDraftActionKindSummary(result.actionSummary.byKind)}`);
  }
  lines.push("");

  appendVerificationManifestMatchesMarkdown(lines, result.plan.verificationManifestMatches);

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

export function formatMarkdownE2eSetup(result: E2eSetupResult): string {
  const lines: string[] = [];
  lines.push("# QAMap E2E Setup");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  lines.push(`- Runner: ${formatRunnerName(result.runner)}`);
  lines.push(`- Proposal: ${escapeMarkdownInline(result.proposal.title)}`);
  lines.push(`- Status: ${result.proposal.status}`);
  lines.push("");
  lines.push("## Applied Files");
  lines.push("");
  lines.push(`- Created: ${result.createdFiles.length > 0 ? result.createdFiles.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ") : "none"}`);
  lines.push(`- Updated: ${result.updatedFiles.length > 0 ? result.updatedFiles.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ") : "none"}`);
  lines.push(`- Skipped: ${result.skippedFiles.length > 0 ? result.skippedFiles.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ") : "none"}`);
  lines.push("");
  if (result.draftFiles.length > 0) {
    lines.push("## Generated Draft");
    lines.push("");
    if (result.draftOutputDirectory) {
      lines.push(`- Output directory: \`${escapeMarkdownInline(result.draftOutputDirectory)}\``);
    }
    if (result.draftReadinessSummary) {
      lines.push(`- Readiness: ${result.draftReadinessSummary.level} (${result.draftReadinessSummary.score}/100)`);
    }
    for (const file of result.draftFiles) {
      const details = [
        file.runnableStatus ? `runnable: ${file.runnableStatus}` : undefined,
        file.selfCheck ? `self-check: ${file.selfCheck.status}` : undefined,
        file.todoCount !== undefined ? `TODOs: ${file.todoCount}` : undefined,
      ].filter(Boolean);
      lines.push(
        `- [${file.status}] \`${escapeMarkdownInline(file.path)}\` for ${escapeMarkdownInline(file.flowTitle)}${details.length > 0 ? ` (${details.join(", ")})` : ""}`,
      );
    }
    lines.push("");
  }
  if (result.installCommands.length > 0) {
    lines.push("## Install Commands");
    lines.push("");
    for (const command of result.installCommands) {
      lines.push(`- \`${escapeMarkdownInline(command)}\``);
    }
    lines.push("");
  }
  if (result.nextCommands.length > 0) {
    lines.push("## Next Commands");
    lines.push("");
    for (const command of result.nextCommands) {
      lines.push(`- \`${escapeMarkdownInline(command)}\``);
    }
    lines.push("");
  }
  if (result.proposal.notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const note of result.proposal.notes) {
      lines.push(`- ${escapeMarkdownInline(note)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const frameworkSignalDependencies = [
  "expo",
  "react-native",
  "@playwright/test",
  "playwright",
  "@angular/core",
  "@remix-run/react",
  "astro",
  "next",
  "nuxt",
  "react-dom",
  "react-router-dom",
  "svelte",
  "vue",
  "vite",
  "@nestjs/core",
  "express",
  "fastify",
  "koa",
  "hono",
];

async function detectProjectProfile(root: string, workspaceRoot?: string): Promise<E2eProjectProfile> {
  const profileRoots = profileSearchRoots(root, workspaceRoot);
  const packageJson = await readPackageJson(root);
  const workspacePackageJson = workspaceRoot && workspaceRoot !== root ? await readPackageJson(workspaceRoot) : undefined;
  const dependencies = {
    ...(workspacePackageJson?.dependencies ?? {}),
    ...(workspacePackageJson?.devDependencies ?? {}),
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  const evidence: string[] = [];

  const rootHasFrameworkSignal = frameworkSignalDependencies.some((dependency) => dependency in dependencies);
  if (!rootHasFrameworkSignal) {
    const memberDependencies = await collectWorkspaceMemberDependencies(root, packageJson);
    for (const member of memberDependencies) {
      for (const [dependency, version] of Object.entries(member.dependencies)) {
        if (!(dependency in dependencies)) {
          dependencies[dependency] = version;
        }
      }
      if (member.frameworkSignals.length > 0) {
        evidence.push(`workspace member ${member.directory}: ${member.frameworkSignals.join(", ")}`);
      }
    }
  }

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
    "react-router-dom",
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
  const hasDjangoEntrypoint = await hasAnyProfileFile(profileRoots, ["manage.py"]);
  const hasPythonServiceDependency = await detectPythonServiceDependency(profileRoots);
  const hasPythonServiceModule = await hasAnyFile(root, [
    "urls.py",
    "views.py",
    "serializers.py",
    "routers.py",
    "admin.py",
  ]);
  const projectFilePaths = (await collectProjectFiles(root, 2000)).map((file) => file.path);
  const hasDesignTokenProject = projectFilePaths.some(isDesignTokenFile);
  const hasDataCatalogProject = projectFilePaths.some(isCatalogDataFile);
  const hasCliBin = packageJsonHasCliBin(packageJson);

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
  if (hasDjangoEntrypoint) {
    evidence.push("Django manage.py entrypoint found");
  }
  if (hasPythonServiceDependency) {
    evidence.push(`Python service dependency: ${hasPythonServiceDependency}`);
  }
  if (hasPythonServiceModule) {
    evidence.push("Python web service module file found");
  }
  if (hasDesignTokenProject) {
    evidence.push("Design token files found");
  }
  if (hasDataCatalogProject) {
    evidence.push("Catalog or taxonomy files found");
  }
  if (hasCliBin) {
    evidence.push("package.json bin entry found");
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
  if (apiServiceDependency || hasApiServiceConfig || hasDjangoEntrypoint || hasPythonServiceDependency || hasPythonServiceModule) {
    return { type: "api-service", evidence };
  }
  if (hasDesignTokenProject) {
    return { type: "design-tokens", evidence };
  }
  if (hasDataCatalogProject) {
    return { type: "data-catalog", evidence };
  }
  if (hasCliBin) {
    return { type: "cli", evidence };
  }
  return {
    type: "unknown",
    evidence,
  };
}

function packageJsonHasCliBin(packageJson: PackageJson | undefined): boolean {
  if (!packageJson?.bin) {
    return false;
  }
  if (typeof packageJson.bin === "string") {
    return packageJson.bin.trim().length > 0;
  }
  return Object.keys(packageJson.bin).length > 0;
}

function profileSearchRoots(root: string, workspaceRoot: string | undefined): string[] {
  return uniqueStrings([root, ...(workspaceRoot && workspaceRoot !== root ? [workspaceRoot] : [])]);
}

async function hasAnyProfileFile(roots: string[], fileNames: string[]): Promise<boolean> {
  for (const root of roots) {
    if (await hasAnyFile(root, fileNames)) {
      return true;
    }
  }
  return false;
}

async function detectPythonServiceDependency(roots: string[]): Promise<string | undefined> {
  for (const root of roots) {
    const dependency = await detectPythonServiceDependencyInRoot(root);
    if (dependency) {
      return dependency;
    }
  }
  return undefined;
}

async function detectPythonServiceDependencyInRoot(root: string): Promise<string | undefined> {
  const dependencyFiles = ["requirements.txt", "requirements-dev.txt", "requirements/base.txt", "pyproject.toml"];
  for (const fileName of dependencyFiles) {
    const text = await readTextIfExists(path.join(root, fileName));
    const dependency = text ? pythonServiceDependencyName(text) : undefined;
    if (dependency) {
      return dependency;
    }
  }
  return undefined;
}

function pythonServiceDependencyName(text: string): string | undefined {
  const match = text.match(/\b(django|djangorestframework|fastapi|flask|starlette|litestar|sanic|tornado)\b/i);
  return match?.[1]?.toLowerCase();
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
  if (project.type === "design-tokens") {
    return {
      name: "manual",
      reason:
        "Use an artifact verification checklist because this looks like a design token package, where schema, generated outputs, and consumer samples matter more than a browser journey.",
    };
  }
  if (project.type === "data-catalog") {
    return {
      name: "manual",
      reason:
        "Use a catalog verification checklist because this looks like a taxonomy or data catalog, where schema, generated output, and downstream consumers matter more than a browser journey.",
    };
  }
  if (project.type === "cli") {
    return {
      name: "manual",
      reason:
        "Use a CLI command verification checklist because this package exposes executable commands rather than a browser or device surface.",
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
  const configFiles = await existingFilesInRoots(root, workspaceRoot, executionConfigCandidates(runner));
  const envFiles = await existingFilesInRoots(root, workspaceRoot, [
    ".env",
    ".env.local",
    ".env.example",
    ".env.local.example",
    ".env.test",
    ".env.test.local",
    ".env.e2e",
    ".env.e2e.local",
    ".env.development",
    ".env.development.local",
    ".env.production",
    ".env.production.local",
  ]);
  const startScript = chooseScript(scripts, startScriptCandidates(runner, project.type));
  const testScript = chooseScript(scripts, testScriptCandidates(runner));
  const scriptStartCommand = startScript ? commandForScript(packageManager, startScript) : undefined;
  const scriptTestCommand = testScript ? commandForScript(packageManager, testScript) : defaultRunnerCommand(runner);
  const apiStartCommand = project.type === "api-service" ? await detectApiServiceStartCommand(root, workspaceRoot) : undefined;
  const apiTestCommand = project.type === "api-service" ? await detectApiServiceTestCommand(root) : undefined;
  const startCommand = scriptStartCommand ?? apiStartCommand;
  const testCommand = scriptTestCommand ?? apiTestCommand;
  const baseUrl =
    runner === "playwright"
      ? await detectPlaywrightBaseUrl(root, configFiles, envFiles, scripts, startScript, packageJson)
      : undefined;
  const appId = runner === "maestro" ? await detectMobileAppId(root, workspaceRoot) : undefined;
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

async function buildRunnerSetupProposal(
  root: string,
  workspaceRoot: string | undefined,
  project: E2eProjectProfile,
  runner: E2eRunnerName,
  profile: E2eExecutionProfile,
  base: string,
  head: string,
): Promise<E2eRunnerSetupProposal> {
  const packageJson = await readPackageJson(root);
  const packageManager = await detectPackageManager(root, packageJson?.packageManager, workspaceRoot);
  const setupCommand = `qamap e2e setup . --runner ${runner}`;
  const draftCommand = `qamap e2e draft . --base ${base} --head ${head}`;

  if (runner === "manual") {
    return {
      runner,
      status: "not-applicable",
      title: manualBootstrapTitle(project.type),
      reason: manualBootstrapReason(project.type),
      installCommands: [],
      filesToCreate: [],
      filesToUpdate: [],
      nextCommands: [draftCommand],
      notes: [manualBootstrapAction(project.type)],
    };
  }

  if (runner === "playwright") {
    const hasConfig = profile.configFiles.some((file) => /playwright\.config\.[cm]?[jt]s$/i.test(file));
    const hasDependency = packageHasDependency(packageJson, "@playwright/test");
    const hasScript = Boolean(packageJson?.scripts && chooseScript(packageJson.scripts, testScriptCandidates("playwright")));
    const status: E2eRunnerSetupStatus = hasConfig && hasDependency && hasScript ? "ready" : "proposed";
    const filesToCreate = hasConfig ? [] : ["playwright.config.ts", "tests/e2e/"];
    const filesToUpdate = packageJson && (!hasScript || !hasDependency) ? ["package.json"] : [];
    return {
      runner,
      status,
      title: status === "ready" ? "Playwright setup is ready for generated specs" : "Propose Playwright setup for generated browser specs",
      reason:
        status === "ready"
          ? "The repository already has Playwright dependency, script, and config evidence, so generated specs can target the existing E2E surface."
          : "This change targets a web surface, so Playwright is the best default for turning the generated scenario into browser E2E code without introducing a mobile or service runner.",
      setupCommand: status === "ready" ? undefined : setupCommand,
      installCommands: hasDependency ? [] : [packageInstallCommand(packageManager, "@playwright/test")],
      filesToCreate,
      filesToUpdate,
      nextCommands: uniqueStrings([
        profile.startCommand,
        profile.testCommand ?? "npx playwright test",
        draftCommand,
      ].filter(Boolean) as string[]),
      notes: [
        playwrightConfigGuidance(profile),
        "Run the setup command only after reviewing the generated scenario and confirming Playwright fits this repository's QA strategy.",
      ],
    };
  }

  const hasMaestroDirectory = profile.configFiles.some((file) => file === ".maestro" || /maestro\.ya?ml$/i.test(file));
  const hasScript = Boolean(packageJson?.scripts && chooseScript(packageJson.scripts, testScriptCandidates("maestro")));
  const status: E2eRunnerSetupStatus = hasMaestroDirectory && hasScript ? "ready" : "proposed";
  return {
    runner,
    status,
    title: status === "ready" ? "Maestro setup is ready for generated mobile flows" : "Propose Maestro setup for generated mobile flows",
    reason:
      status === "ready"
        ? "The repository already has Maestro flow directory/config and a runnable script signal."
        : "This change targets a React Native or Expo app surface, so Maestro is the best default for turning the generated scenario into device-level E2E code without assuming a browser runner.",
    setupCommand: status === "ready" ? undefined : setupCommand,
    installCommands: [],
    filesToCreate: hasMaestroDirectory ? [] : [".maestro/", ".maestro/README.md"],
    filesToUpdate: packageJson && !hasScript ? ["package.json"] : [],
    nextCommands: uniqueStrings([
      profile.startCommand,
      profile.testCommand ?? "maestro test .maestro",
      draftCommand,
    ].filter(Boolean) as string[]),
    notes: [
      profile.appId
        ? `Generated flows can use app id ${profile.appId}; keep APP_ID overrideable for local devices.`
        : "Confirm the app id from app.json or app.config before making generated Maestro flows required.",
      "Install Maestro with the team's preferred local or CI setup before running generated flows.",
    ],
  };
}

export async function setupE2eRunner(rootInput: string, options: E2eSetupOptions = {}): Promise<E2eSetupResult> {
  const root = path.resolve(rootInput);
  const plan = await generateE2ePlan(root, options);
  const runner = options.runner ?? plan.recommendedRunner.name;
  const proposal = await buildRunnerSetupProposal(
    root,
    plan.workspaceRoot,
    plan.project,
    runner,
    plan.executionProfile,
    plan.base,
    plan.head,
  );
  const createdFiles: string[] = [];
  const updatedFiles: string[] = [];
  const skippedFiles: string[] = [];

  if (runner === "playwright") {
    await applyPlaywrightSetup(root, plan.executionProfile, options.force ?? false, createdFiles, updatedFiles, skippedFiles);
  } else if (runner === "maestro") {
    await applyMaestroSetup(root, plan.executionProfile, options.force ?? false, createdFiles, updatedFiles, skippedFiles);
  } else {
    skippedFiles.push("manual runner setup");
  }
  const draftResult = runner === "manual"
    ? undefined
    : await generateE2eDraft(root, {
        base: plan.base,
        head: plan.head,
        workspaceRoot: plan.workspaceRoot,
        includeWorkingTree: options.includeWorkingTree,
        validationCommands: options.validationCommands,
        runner,
        force: options.force,
        maxDrafts: 1,
      });

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    runner,
    proposal,
    createdFiles,
    updatedFiles,
    skippedFiles,
    installCommands: proposal.installCommands,
    nextCommands: setupNextCommands(proposal.nextCommands, draftResult),
    draftOutputDirectory: draftResult?.outputDirectory,
    draftFiles: draftResult?.files ?? [],
    draftReadinessSummary: draftResult?.readinessSummary,
  };
}

function setupNextCommands(commands: string[], draftResult: E2eDraftResult | undefined): string[] {
  if (!draftResult || draftResult.files.length === 0) {
    return commands;
  }
  return commands.filter((command) => !/^qamap e2e draft\b/.test(command));
}

async function applyPlaywrightSetup(
  root: string,
  profile: E2eExecutionProfile,
  force: boolean,
  createdFiles: string[],
  updatedFiles: string[],
  skippedFiles: string[],
): Promise<void> {
  const packageJson = await readPackageJson(root);
  if (packageJson) {
    const didUpdatePackage = await updatePackageJsonScript(root, "test:e2e", "playwright test", force);
    if (didUpdatePackage) {
      updatedFiles.push("package.json");
    } else {
      skippedFiles.push("package.json");
    }
  } else {
    skippedFiles.push("package.json");
  }

  if (await exists(path.join(root, "tests/e2e"))) {
    skippedFiles.push("tests/e2e/");
  } else {
    await fs.mkdir(path.join(root, "tests/e2e"), { recursive: true });
    createdFiles.push("tests/e2e/");
  }

  const configPath = path.join(root, "playwright.config.ts");
  if ((await exists(configPath)) && !force) {
    skippedFiles.push("playwright.config.ts");
  } else {
    await fs.writeFile(configPath, playwrightConfigTemplate(profile), "utf8");
    createdFiles.push("playwright.config.ts");
  }
}

function packageHasDependency(packageJson: PackageJson | undefined, dependencyName: string): boolean {
  return Boolean(packageJson?.dependencies?.[dependencyName] || packageJson?.devDependencies?.[dependencyName]);
}

function packageInstallCommand(packageManager: string, dependencyName: string): string {
  if (packageManager === "pnpm") {
    return `pnpm add -D ${dependencyName}`;
  }
  if (packageManager === "yarn") {
    return `yarn add -D ${dependencyName}`;
  }
  if (packageManager === "bun") {
    return `bun add -d ${dependencyName}`;
  }
  return `npm install -D ${dependencyName}`;
}

async function updatePackageJsonScript(root: string, scriptName: string, scriptValue: string, force: boolean): Promise<boolean> {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = await readPackageJson(root);
  if (!packageJson) {
    return false;
  }
  packageJson.scripts ??= {};
  if (packageJson.scripts[scriptName] && packageJson.scripts[scriptName] !== scriptValue && !force) {
    return false;
  }
  if (packageJson.scripts[scriptName] === scriptValue) {
    return false;
  }
  packageJson.scripts[scriptName] = scriptValue;
  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  return true;
}

function playwrightConfigTemplate(profile: E2eExecutionProfile): string {
  const baseUrl = profile.baseUrl ?? "http://localhost:3000";
  const lines = [
    'import { defineConfig, devices } from "@playwright/test";',
    "",
    `const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? ${JSON.stringify(baseUrl)};`,
    "",
    "export default defineConfig({",
    '  testDir: "./tests/e2e",',
    "  retries: process.env.CI ? 1 : 0,",
    "  use: {",
    "    baseURL,",
    '    trace: "on-first-retry",',
    "  },",
  ];
  if (profile.startCommand) {
    lines.push(
      "  webServer: process.env.PLAYWRIGHT_SKIP_WEB_SERVER",
      "    ? undefined",
      "    : {",
      `        command: ${JSON.stringify(profile.startCommand)},`,
      "        url: baseURL,",
      "        reuseExistingServer: !process.env.CI,",
      "        timeout: 120_000,",
      "      },",
    );
  }
  lines.push(
    "  projects: [",
    "    {",
    '      name: "chromium",',
    '      use: { ...devices["Desktop Chrome"] },',
    "    },",
    "  ],",
    "});",
    "",
  );
  return lines.join("\n");
}

function maestroReadmeTemplate(profile: E2eExecutionProfile): string {
  const lines = [
    "# Maestro E2E Setup",
    "",
    "This directory is prepared for QAMap-generated Maestro flows.",
    "",
    "## Run",
    "",
    "```sh",
    profile.testCommand ?? "maestro test .maestro",
    "```",
    "",
  ];
  if (profile.appId) {
    lines.push("## App Id", "", `Use \`${profile.appId}\` or export \`APP_ID\` for generated flows.`, "");
  } else {
    lines.push("## App Id", "", "Confirm the app id from app.json or app.config before making generated flows required.", "");
  }
  if (profile.startCommand) {
    lines.push("## Launch", "", `Start or launch the app with \`${profile.startCommand}\` before running device flows.`, "");
  }
  return lines.join("\n");
}

async function applyMaestroSetup(
  root: string,
  profile: E2eExecutionProfile,
  force: boolean,
  createdFiles: string[],
  updatedFiles: string[],
  skippedFiles: string[],
): Promise<void> {
  await fs.mkdir(path.join(root, ".maestro"), { recursive: true });
  createdFiles.push(".maestro/");

  const packageJson = await readPackageJson(root);
  if (packageJson) {
    const didUpdatePackage = await updatePackageJsonScript(root, "test:e2e", "maestro test .maestro", force);
    if (didUpdatePackage) {
      updatedFiles.push("package.json");
    } else {
      skippedFiles.push("package.json");
    }
  }

  const readmePath = path.join(root, ".maestro/README.md");
  if ((await exists(readmePath)) && !force) {
    skippedFiles.push(".maestro/README.md");
  } else {
    await fs.writeFile(readmePath, maestroReadmeTemplate(profile), "utf8");
    createdFiles.push(".maestro/README.md");
  }
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

async function detectApiServiceStartCommand(root: string, workspaceRoot: string | undefined): Promise<string | undefined> {
  const roots = profileSearchRoots(root, workspaceRoot);
  for (const candidateRoot of roots) {
    const managePath = path.join(candidateRoot, "manage.py");
    if (await exists(managePath)) {
      return `python ${shellArg(relativeCommandPath(root, managePath))} runserver`;
    }
  }
  for (const candidate of ["main.py", "app.py"]) {
    if (await exists(path.join(root, candidate))) {
      return `python ${candidate}`;
    }
  }
  return undefined;
}

async function detectApiServiceTestCommand(root: string): Promise<string | undefined> {
  if (await hasAnyFile(root, ["pytest.ini", "tox.ini"]) || (await exists(path.join(root, "tests")))) {
    return "pytest";
  }
  return undefined;
}

function relativeCommandPath(fromRoot: string, targetPath: string): string {
  const relativePath = toPosixPath(path.relative(fromRoot, targetPath));
  if (!relativePath || relativePath === ".") {
    return path.basename(targetPath);
  }
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
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

async function existingFilesInRoots(root: string, workspaceRoot: string | undefined, candidates: string[]): Promise<string[]> {
  const files: string[] = [];
  const roots = profileSearchRoots(root, workspaceRoot);
  for (const candidateRoot of roots) {
    for (const candidate of candidates) {
      const absolutePath = path.join(candidateRoot, candidate);
      if (await exists(absolutePath)) {
        files.push(toPosixPath(path.relative(root, absolutePath)) || candidate);
      }
    }
  }
  return uniqueStrings(files);
}

async function detectPlaywrightBaseUrl(
  root: string,
  configFiles: string[],
  envFiles: string[],
  scripts: Record<string, string>,
  startScript: string | undefined,
  packageJson: PackageJson | undefined,
): Promise<string | undefined> {
  for (const configFile of configFiles) {
    const text = await readTextIfExists(path.join(root, configFile));
    const baseUrl = text?.match(/\bbaseURL\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
    if (baseUrl) {
      return baseUrl;
    }
  }

  for (const envFile of envFiles) {
    const text = await readTextIfExists(path.join(root, envFile));
    const baseUrl = text
      ?.match(/^(?:PLAYWRIGHT_BASE_URL|BASE_URL|E2E_BASE_URL|TEST_BASE_URL|APP_BASE_URL|APP_URL|PUBLIC_URL|NEXT_PUBLIC_SITE_URL)=(.+)$/m)?.[1]
      ?.trim();
    if (baseUrl && !/\$\{|<|TODO/i.test(baseUrl)) {
      return baseUrl.replace(/^["']|["']$/g, "");
    }
  }

  const startScriptValue = startScript ? scripts[startScript] : undefined;
  return detectPlaywrightBaseUrlFromScript(startScriptValue, packageJson);
}

function detectPlaywrightBaseUrlFromScript(
  startScript: string | undefined,
  packageJson: PackageJson | undefined,
): string | undefined {
  if (!startScript) {
    return undefined;
  }
  const host = detectDevServerHost(startScript) ?? "localhost";
  const port = detectDevServerPort(startScript) ?? frameworkDefaultPort(startScript, packageJson);
  return port ? `http://${host}:${port}` : undefined;
}

function detectDevServerHost(script: string): string | undefined {
  const hostMatch = script.match(/(?:--host(?:=|\s+)|-H\s+)([A-Za-z0-9._-]+)/);
  if (!hostMatch?.[1] || hostMatch[1] === "0.0.0.0" || hostMatch[1] === "::") {
    return undefined;
  }
  return hostMatch[1];
}

function detectDevServerPort(script: string): string | undefined {
  const envPort = script.match(/(?:^|\s)(?:PORT|VITE_PORT|NEXT_PORT)=(\d{2,5})(?:\s|$)/)?.[1];
  if (envPort) {
    return envPort;
  }
  return script.match(/(?:--port(?:=|\s+)|-p(?:=|\s+))(\d{2,5})(?:\s|$)/)?.[1];
}

function frameworkDefaultPort(script: string, packageJson: PackageJson | undefined): string | undefined {
  const dependencies = {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
  if (/\bnext\b/.test(script) || "next" in dependencies || /\bnuxt\b/.test(script) || "nuxt" in dependencies) {
    return "3000";
  }
  if (/\bvite\b/.test(script) || "vite" in dependencies || /\bsvelte-kit\b/.test(script)) {
    return "5173";
  }
  if (/\bastro\b/.test(script) || "astro" in dependencies) {
    return "4321";
  }
  if (/\bremix\b/.test(script) || "@remix-run/react" in dependencies) {
    return "3000";
  }
  return undefined;
}

async function detectMobileAppId(root: string, workspaceRoot: string | undefined): Promise<string | undefined> {
  const appJson = await readTextIfExists(path.join(root, "app.json"));
  if (appJson) {
    try {
      const parsed = JSON.parse(appJson) as {
        expo?: {
          android?: { package?: string };
          ios?: { bundleIdentifier?: string };
          slug?: string;
          name?: string;
        };
      };
      const jsonId = parsed.expo?.android?.package ?? parsed.expo?.ios?.bundleIdentifier ?? parsed.expo?.slug ?? parsed.expo?.name;
      if (jsonId) {
        return jsonId;
      }
    } catch {
      // Fall through to app.config.* parsing.
    }
  }

  for (const configFile of await existingFilesInRoots(root, workspaceRoot, ["app.config.ts", "app.config.js", "app.config.mjs", "app.config.cjs"])) {
    const text = await readTextIfExists(path.join(root, configFile));
    const appId = text ? extractMobileAppIdFromConfigText(text) : undefined;
    if (appId) {
      return appId;
    }
  }
  return undefined;
}

function extractMobileAppIdFromConfigText(text: string): string | undefined {
  return (
    extractLiteralPropertyValue(text, "package") ??
    resolveConfigIdentifier(text, "package") ??
    extractLiteralPropertyValue(text, "bundleIdentifier") ??
    resolveConfigIdentifier(text, "bundleIdentifier") ??
    extractLiteralPropertyValue(text, "slug") ??
    extractLiteralPropertyValue(text, "name")
  );
}

function extractLiteralPropertyValue(text: string, property: string): string | undefined {
  const quotePattern = `["'\\x60]`;
  const match = text.match(new RegExp(`\\b${property}\\s*:\\s*${quotePattern}([^"'\\x60]+)${quotePattern}`));
  return match?.[1];
}

function resolveConfigIdentifier(text: string, property: string): string | undefined {
  const identifier = text.match(new RegExp(`\\b${property}\\s*:\\s*([A-Za-z_$][A-Za-z0-9_$]*)`))?.[1];
  if (!identifier) {
    return undefined;
  }
  return extractStringAssignmentDefault(text, identifier);
}

function extractStringAssignmentDefault(text: string, identifier: string): string | undefined {
  const escapedIdentifier = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`\\b(?:const|let|var)\\s+${escapedIdentifier}\\s*=([\\s\\S]*?)(?:\\n\\s*(?:const|let|var|module\\.exports|export\\s+default)\\b|;\\s*\\n|$)`));
  const values = match?.[1] ? [...match[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((item) => item[1]) : [];
  return values.at(-1);
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
    if (!manualChecklistIsExpected(input.projectType)) {
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

function manualChecklistIsExpected(projectType: E2eProjectType): boolean {
  return projectType === "api-service" || projectType === "design-tokens" || projectType === "data-catalog" || projectType === "cli";
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
    "qamap",
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

type E2eFlowKind =
  | "ui"
  | "api"
  | "state"
  | "content"
  | "config"
  | "test-evidence"
  | "documentation"
  | "generated-artifact"
  | "artifact"
  | "catalog"
  | "command"
  | "domain"
  | "changed-file";
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
type DraftFlowSource = "verification-manifest" | "domain-language" | "core-flow" | "heuristic";
type DraftE2eFlow = E2eFlow & {
  draftSource?: DraftFlowSource;
  domainScenario?: DomainScenarioSuggestion;
  coreFlow?: MatchedCoreFlow;
  manifestMatch?: VerificationManifestMatch;
  manifestCheckMatches?: VerificationManifestMatch[];
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
  const importImpacts = await collectImportImpacts(root, files);
  const fixtureContext = await collectFixtureReadinessContext(root, files);
  const flowResults = await Promise.all(
    buildFlowCandidates(files, runner, projectType, domainLanguage, importImpacts).map((candidate) =>
      buildFlow(root, runner, candidate, testSuiteInventory, fixtureContext),
    ),
  );
  const flows = flowResults.filter((flow): flow is E2eFlow => Boolean(flow));

  return dedupeFlows(flows).slice(0, 4);
}

async function expandChangedFilesForMatching(
  root: string,
  changedFiles: TestPlanChangedFile[],
): Promise<TestPlanChangedFile[]> {
  if (changedFiles.length === 0 || changedFiles.length > 60) {
    return changedFiles;
  }
  try {
    const expansion = await expandChangedFilesWithImporters(root, changedFiles.map((file) => file.path));
    const knownPaths = new Set(changedFiles.map((file) => file.path));
    const importerEntries = expansion.files
      .filter((file) => !knownPaths.has(file))
      .map((file) => ({ status: "M", path: file }));
    return [...changedFiles, ...importerEntries];
  } catch {
    return changedFiles;
  }
}

function isRoutableSurfaceFile(file: string): boolean {
  if (isApiRouteFile(file) || isTestLikeFile(file)) {
    return false;
  }
  return (
    /(?:^|\/)app\/.*(?:^|\/)?page\.[cm]?[jt]sx?$/i.test(file) ||
    /(?:^|\/)pages\/(?!api\/).+\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(file) ||
    /(?:^|\/)(?:screens|views)\/.+\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(file) ||
    /(?:^|\/)routes\/(?!api\/).+\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(file)
  );
}

async function collectImportImpacts(root: string, changedFiles: string[]): Promise<ImportImpact[]> {
  const propagatableFiles = changedFiles.filter(
    (file) =>
      !isRoutableSurfaceFile(file) && !isTestLikeFile(file) && !isConfigLikeFile(file) && !isContentOrStyleFile(file),
  );
  if (propagatableFiles.length === 0) {
    return [];
  }
  try {
    const index = await buildReverseImportIndex(root);
    return findImportingSurfaces(index, propagatableFiles, isRoutableSurfaceFile);
  } catch {
    return [];
  }
}

function describeImportChain(impact: ImportImpact): string {
  return impact.chain.join(" -> ");
}

function buildFlowCandidates(
  files: string[],
  runner: E2eRunnerName,
  projectType: E2eProjectType,
  domainLanguage: DomainLanguageSummary,
  importImpacts: ImportImpact[] = [],
): FlowCandidate[] {
  const lowSignalCandidate = importImpacts.length === 0 ? buildLowSignalChangeCandidate(files) : undefined;
  if (lowSignalCandidate) {
    return [lowSignalCandidate];
  }

  const behaviorFiles = files.filter((file) => !isTestLikeFile(file));
  const candidateFiles = behaviorFiles.length > 0 ? behaviorFiles : files;
  const impactSurfaceFiles = importImpacts.map((impact) => impact.surface).filter((surface) => !candidateFiles.includes(surface));
  const uiFiles = uniqueStrings([...candidateFiles.filter(isUserFacingFile), ...impactSurfaceFiles]);
  const apiFiles = candidateFiles.filter(isApiLikeFile);
  const apiServiceSourceFiles =
    projectType === "api-service"
      ? candidateFiles.filter(
          (file) => !apiFiles.includes(file) && !isConfigLikeFile(file) && isServiceSourceFile(file),
        )
      : [];
  const cliCommandFiles =
    projectType === "cli"
      ? candidateFiles.filter((file) => !isConfigLikeFile(file) && !isTestLikeFile(file) && isServiceSourceFile(file))
      : [];
  const contractFiles = uniqueStrings([...apiFiles, ...apiServiceSourceFiles]);
  const stateFiles = candidateFiles.filter(isStateLikeFile);
  const designTokenFiles = candidateFiles.filter(isDesignTokenFile);
  const catalogFiles = candidateFiles.filter((file) => isCatalogDataFile(file) && !designTokenFiles.includes(file));
  const artifactFiles = uniqueStrings([...designTokenFiles]);
  const contentFiles = candidateFiles.filter(
    (file) => isContentOrStyleFile(file) && !artifactFiles.includes(file) && !catalogFiles.includes(file),
  );
  const configFiles = candidateFiles.filter(isConfigLikeFile);
  const domainFiles = candidateFiles.filter(isDomainOwnedFile);
  const candidates: FlowCandidate[] = [];

  if (uiFiles.length > 0) {
    const subject = summarizeFlowSubject(uiFiles, "Changed", domainLanguage);
    const impactReason = importImpacts.length > 0
      ? ` Changed shared files reach these surfaces through imports: ${importImpacts.slice(0, 3).map(describeImportChain).join("; ")}.`
      : "";
    candidates.push({
      kind: "ui",
      title: `${subject} UI smoke flow`,
      reason: `User-facing route, screen, navigation, or component files changed, so the draft should open the touched surface and cover the primary visible action.${impactReason}`,
      files: uniqueStrings([...uiFiles, ...importImpacts.map((impact) => impact.changedFile)]),
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

  if (artifactFiles.length > 0) {
    const subject = summarizeFlowSubject(artifactFiles, "Design token", domainLanguage);
    candidates.push({
      kind: "artifact",
      title: `${subject} design token contract checklist`,
      reason:
        "Design token files changed, so the draft should verify token schema, generated artifacts, and at least one downstream consumer sample instead of assuming a user-facing app journey.",
      files: artifactFiles,
      steps: [
        "Validate the changed token JSON or source format against the token schema.",
        "Regenerate token artifacts, CSS variables, theme files, or package outputs.",
        "Compare affected semantic aliases, component variables, and fallback values.",
        "Verify one downstream consumer sample or visual fixture renders the changed tokens intentionally.",
      ],
    });
  }

  if (catalogFiles.length > 0) {
    const subject = summarizeFlowSubject(catalogFiles, "Taxonomy", domainLanguage);
    candidates.push({
      kind: "catalog",
      title: `${subject} taxonomy catalog verification checklist`,
      reason:
        "Taxonomy, analytics catalog, or generated documentation files changed, so the draft should verify schema validity, generated catalog output, and downstream event/property consumers.",
      files: catalogFiles,
      steps: [
        "Validate changed catalog entries against the documented schema or migration script.",
        "Regenerate the catalog site, JSON export, or published artifact.",
        "Verify event names, property names, ownership, and descriptions remain backward compatible for consumers.",
        "Check one representative downstream analytics, documentation, or ingestion fixture.",
      ],
    });
  }

  if (cliCommandFiles.length > 0) {
    const subject = summarizeFlowSubject(cliCommandFiles, "CLI", domainLanguage);
    candidates.push({
      kind: "command",
      title: cliCommandChecklistTitle(subject),
      reason:
        "CLI command source changed, so the draft should verify command invocation, output, exit code, and failure behavior instead of inventing a browser or device journey.",
      files: cliCommandFiles,
      steps: [
        "Build or install the package in a clean local environment.",
        "Run the changed command with a representative valid argument set.",
        "Verify stdout, stderr, generated files, and exit code match the intended behavior.",
        "Run one invalid, missing-argument, or unsupported-input path and verify the failure message and exit code.",
      ],
    });
  }

  if (configFiles.length > 0) {
    const subject = isReleaseMetadataOnlyChange(configFiles)
      ? "Release metadata"
      : summarizeFlowSubject(configFiles, "Changed", domainLanguage);
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

  const remainingDomainFiles = domainFiles.filter(
    (file) =>
      !isUserFacingFile(file) &&
      !isApiLikeFile(file) &&
      !isConfigLikeFile(file) &&
      !isContentOrStyleFile(file) &&
      !isDesignTokenFile(file) &&
      !isCatalogDataFile(file) &&
      !cliCommandFiles.includes(file) &&
      !isReleaseMetadataFile(file),
  );
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
      reason: "Changed files did not match a specialized E2E pattern, so QAMap generated a conservative smoke path tied only to the changed files.",
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

function cliCommandChecklistTitle(subject: string): string {
  if (/^cli$/i.test(subject.trim())) {
    return "CLI command verification checklist";
  }
  return `${subject} CLI command verification checklist`;
}

function buildLowSignalChangeCandidate(files: string[]): FlowCandidate | undefined {
  const changedFiles = uniqueStrings(files);
  if (changedFiles.length === 0 || isReleaseMetadataOnlyChange(changedFiles)) {
    return undefined;
  }

  if (isTestEvidenceOnlyChange(changedFiles)) {
    return {
      kind: "test-evidence",
      title: "Changed test evidence verification checklist",
      reason:
        "Only test files changed, so QAMap should verify the test evidence and its protected behavior instead of inventing a product journey from test filenames.",
      files: changedFiles,
      steps: [
        "Run the changed test file or the nearest package test command.",
        "Confirm the changed test names the behavior, bug, or regression risk it protects.",
        "Verify the test includes a meaningful failure, edge, or previous-regression signal when the branch does not change product code.",
        "Record the command, result, and behavior protected by this test-only change as PR evidence.",
      ],
    };
  }

  if (isDocumentationOnlyChange(changedFiles)) {
    return {
      kind: "documentation",
      title: "Documentation verification checklist",
      reason:
        "Only documentation changed, so the useful verification is whether the documented command, workflow, or policy still matches the repository behavior.",
      files: changedFiles,
      steps: [
        "Open the changed documentation and identify the command, option, workflow, API, or policy it describes.",
        "Compare the documented behavior with the current source, CLI output, examples, or existing tests.",
        "Run markdown, link, example, or docs build validation when the repository provides it.",
        "Record any uncovered product behavior as a follow-up test gap instead of treating the doc change as E2E coverage.",
      ],
    };
  }

  if (isGeneratedOutputOnlyChange(changedFiles)) {
    return {
      kind: "generated-artifact",
      title: "Generated artifact verification checklist",
      reason:
        "Only generated output changed, so verification should prove the artifact came from its source of truth and still works for downstream consumers.",
      files: changedFiles,
      steps: [
        "Re-run the generator, codegen, build, or export command that owns the changed output.",
        "Confirm the generated diff matches a committed source-of-truth input, schema, or template.",
        "Run the nearest consumer build, typecheck, or test that imports the generated artifact.",
        "Reject hand-edited generated output unless the repository explicitly documents that workflow.",
      ],
    };
  }

  if (isLowSignalVerificationOnlyChange(changedFiles)) {
    return {
      kind: "test-evidence",
      title: "Changed evidence verification checklist",
      reason:
        "The branch only changed verification evidence such as tests, docs, or generated output, so QAMap should ask for proof that the evidence maps to real behavior before proposing a product E2E journey.",
      files: changedFiles,
      steps: [
        "Classify each changed file as test evidence, documentation, or generated output.",
        "Run the nearest validation command for each changed evidence type.",
        "Confirm no runtime product file changed; if product behavior is implied, name the missing product test explicitly.",
        "Record the validation command, result, and protected behavior as PR evidence.",
      ],
    };
  }

  return undefined;
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
  const selectors = await inferFlowSelectors(root, files, runner);
  const flow: Omit<E2eFlow, "languageBrief"> = {
    title: candidate.title,
    reason: candidate.reason,
    files,
    steps: refineStepsForInferredSelectors(candidate.steps, selectors),
    coverage,
    coverageEvidence: evaluateFlowCoverageEvidence({ title: candidate.title, files, coverage }, testSuiteInventory),
    entrypoints: await inferFlowEntrypoints(root, files, runner),
    setupHints,
    fixtureReadiness: await inferFlowFixtureReadiness(root, files, candidate.kind, setupHints, fixtureContext),
    selectors,
    missingTestability: await findFlowTestabilityGaps(root, files, runner),
  };
  return {
    ...flow,
    languageBrief: buildFlowLanguageBrief(flow),
  };
}

function refineStepsForInferredSelectors(steps: string[], selectors: E2eSelector[]): string[] {
  const inputSelector = selectors.find(isInputSelector);
  const actionSelector = selectors.find((selector) => selectorCanDriveInteraction(selector) && !isInputSelector(selector));
  if (!inputSelector || !actionSelector || steps.some((step) => /^\s*(?:fill|input|enter|type|provide|write)\b/i.test(step))) {
    return steps;
  }

  const refined: string[] = [];
  for (const step of steps) {
    const subject = exerciseStepSubject(step);
    if (!subject) {
      refined.push(step);
      continue;
    }
    refined.push(`Fill ${selectorStepLabel(inputSelector)} with realistic data.`);
    refined.push(`${actionVerbForSelector(actionSelector)} ${subject} using ${selectorStepLabel(actionSelector)}.`);
  }
  return uniqueStrings(refined);
}

function refineManifestStepsForInferredSelectors(steps: string[], selectors: E2eSelector[]): string[] {
  const inputSelector = selectors.find(isInputSelector);
  const actionSelector = selectors.find((selector) => selectorCanDriveInteraction(selector) && !isInputSelector(selector));
  if (!inputSelector || !actionSelector || steps.some(isInputStep)) {
    return steps;
  }
  return uniqueStrings([
    `Fill ${selectorStepLabel(inputSelector)} with realistic data.`,
    `${actionVerbForSelector(actionSelector)} using ${selectorStepLabel(actionSelector)}.`,
    ...steps,
  ]);
}

function exerciseStepSubject(step: string): string | undefined {
  const exerciseMatch = step.match(/^Exercise\s+(.+?)\s+with realistic data(?:\s+from[^.]*)?\.?$/i);
  if (exerciseMatch?.[1]) {
    return stripTerminalPunctuation(exerciseMatch[1]);
  }
  const completeMatch = step.match(/^Complete\s+(.+?)\s+with realistic data(?:\s+from[^.]*)?\.?$/i);
  if (completeMatch?.[1]) {
    return stripTerminalPunctuation(completeMatch[1]);
  }
  return undefined;
}

function selectorStepLabel(selector: E2eSelector): string {
  const label = titleCase(selector.value.replace(/[-_]+/g, " "));
  if (label) {
    return label;
  }
  const raw = selector.value.trim();
  return raw.length > 0 ? `"${raw}"` : `the ${selector.kind} control`;
}

function actionVerbForSelector(selector: E2eSelector): string {
  if (/\b(?:submit|send|apply|complete|confirm|save|continue|next|upload)\b/i.test(selector.value.replace(/[-_]+/g, " "))) {
    return "Submit";
  }
  return "Activate";
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
  if (
    kind === "artifact" ||
    kind === "catalog" ||
    kind === "test-evidence" ||
    kind === "documentation" ||
    kind === "generated-artifact"
  ) {
    return [];
  }

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
  const shouldUseContentSignals = kind !== "config" && kind !== "content" && kind !== "command";
  const signalText = shouldUseContentSignals ? combinedText : filesText;
  const matchingFiles = (pattern: RegExp) =>
    uniqueStrings([
      ...files.filter((file) => pattern.test(file)),
      ...(shouldUseContentSignals
        ? fileTexts.filter((item) => pattern.test(item.text)).map((item) => item.file)
        : []),
    ]).slice(0, maxFilesPerFlow);

  if (/(?:^|\/|[-_])(auth|session|login|logout|permission|permissions|guard|guards|token|jwt)(?:\/|[-_.]|$)/i.test(signalText)) {
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

  if (kind === "api" || /(?:fetch|axios|graphql|trpc|rpc|client|endpoint|request|response|msw|nock|mock|\/api\/)/i.test(signalText)) {
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

  if (/(?:fixture|fixtures|factory|factories|seed|seeds|mock|mocks|faker|test-data|testData)/i.test(signalText)) {
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

  if (/(?:\.env|environment|process\.env|feature-?flag|experiments?|remoteConfig|config|eas\.json|app\.config)/i.test(signalText)) {
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

  if (/(?:payment|billing|checkout|purchase|subscription|invoice|settlement|stripe|iap|in-app-purchase|storekit|revenuecat)/i.test(signalText)) {
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

  if (kind === "state" || /(?:store|state|cache|provider|context|atom|selector|reducer|storage|localStorage|AsyncStorage)/i.test(signalText)) {
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
  if (kind === "test-evidence" || kind === "documentation" || kind === "generated-artifact") {
    return {
      status: "not-needed",
      reason: "This verification flow targets changed evidence such as tests, docs, or generated output rather than an API-backed product journey.",
      apiSignals: [],
      apiEndpoints: [],
      backendSignals: [],
      mockSignals: [],
      nextActions: [],
    };
  }
  if (kind === "artifact" || kind === "catalog") {
    return {
      status: "not-needed",
      reason: "This verification flow targets generated artifacts, schema, catalog output, or consumer fixtures rather than API response data.",
      apiSignals: [],
      apiEndpoints: [],
      backendSignals: [],
      mockSignals: [],
      nextActions: [],
    };
  }
  if (kind === "config" || kind === "content") {
    return {
      status: "not-needed",
      reason: "This verification flow targets configuration, release, documentation, or content changes where clean validation evidence matters more than API fixture responses.",
      apiSignals: [],
      apiEndpoints: [],
      backendSignals: [],
      mockSignals: [],
      nextActions: [],
    };
  }
  if (
    kind === "command" &&
    !setupHints.some((hint) => hint.kind === "network" || hint.kind === "payment" || hint.kind === "fixture")
  ) {
    return {
      status: "not-needed",
      reason: "This verification flow targets CLI command behavior; command arguments, output, exit code, and generated files matter more than API fixture responses unless the command path explicitly depends on network data.",
      apiSignals: [],
      apiEndpoints: [],
      backendSignals: [],
      mockSignals: [],
      nextActions: [],
    };
  }

  const apiSignals = await findApiDependencySignals(root, files, kind, setupHints);
  const apiEndpoints = uniqueStrings([
    ...(await findApiEndpointHints(root, uniqueStrings([...files, ...apiSignals]))),
    ...context.changedBackendFiles.flatMap(apiEndpointFromBackendFile),
  ]).slice(0, maxFilesPerFlow);
  const requiresMock = apiSignals.length > 0 || setupHints.some((hint) => hint.kind === "network" || hint.kind === "payment");
  if (!requiresMock) {
    return {
      status: "not-needed",
      reason: "No API, network, payment, or external-response dependency was detected for this flow.",
      apiSignals: [],
      apiEndpoints: [],
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
      apiEndpoints,
      backendSignals,
      mockSignals,
      nextActions: [
        `Keep changed fixture/mock evidence aligned with this flow: ${formatFileSummary(changedMockSignals)}.`,
        "Keep deterministic success, empty, unauthorized, and failure fixture cases aligned with the changed flow.",
      ],
    };
  }

  if (context.projectMockFiles.length > 0) {
    const reusableMockSignals = mockSignals.length > 0 ? mockSignals : context.projectMockFiles;
    return {
      status: "partial",
      reason: "Mock or fixture infrastructure exists, but this branch does not add flow-specific fixture evidence.",
      apiSignals,
      apiEndpoints,
      backendSignals,
      mockSignals,
      nextActions: [
        `Reuse or extend existing fixture/mock evidence for this flow: ${formatFileSummary(reusableMockSignals)}.`,
        "Cover the primary success response and one empty, rejected, or server-error response.",
      ],
    };
  }

  if (backendSignals.length > 0) {
    return {
      status: "partial",
      reason: "Backend or API contract changes exist, but deterministic fixture evidence was not detected.",
      apiSignals,
      apiEndpoints,
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
    apiEndpoints,
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

async function findApiEndpointHints(root: string, files: string[]): Promise<string[]> {
  const endpoints: string[] = [];
  for (const file of files.slice(0, 12)) {
    const text = await readTextIfExists(path.join(root, file));
    if (text) {
      endpoints.push(...extractApiEndpointHints(text));
    }
  }
  return uniqueStrings(endpoints).slice(0, maxFilesPerFlow);
}

function extractApiEndpointHints(text: string): string[] {
  const endpoints: string[] = [];
  const stringLiteralMatcher = /(?:"([^"\n]+)"|'([^'\n]+)'|`([^`\n]+)`)/g;
  for (const match of text.matchAll(stringLiteralMatcher)) {
    const endpoint = normalizeApiEndpointHint(match[1] ?? match[2] ?? match[3]);
    if (endpoint) {
      endpoints.push(endpoint);
    }
  }
  return endpoints;
}

function normalizeApiEndpointHint(value: string | undefined): string | undefined {
  const endpoint = value?.trim().replace(/\$\{[^}]+\}/g, "*");
  if (!endpoint || endpoint.length > 180 || !/^(?:https?:\/\/|\/)/i.test(endpoint)) {
    return undefined;
  }
  if (!/(?:\/api(?:\/|$)|\/graphql(?:\/|$)|\/trpc(?:\/|$))/i.test(endpoint)) {
    return undefined;
  }
  if (/[\s<>{}]/.test(endpoint)) {
    return undefined;
  }
  return endpoint;
}

function apiEndpointFromBackendFile(file: string): string[] {
  const normalized = toPosixPath(file).replace(/\.(?:[cm]?[jt]sx?|py|go|rs|kt|java|rb|php)$/i, "");
  const segments = normalized.split("/").filter(Boolean);
  const appIndex = segments.findIndex((segment) => segment === "app");
  if (appIndex >= 0 && segments[appIndex + 1] === "api") {
    return [`/api/${routeSegmentsFromFileParts(segments.slice(appIndex + 2)).join("/")}`.replace(/\/+$/g, "") || "/api"];
  }
  const pagesIndex = segments.findIndex((segment) => segment === "pages");
  if (pagesIndex >= 0 && segments[pagesIndex + 1] === "api") {
    return [`/api/${routeSegmentsFromFileParts(segments.slice(pagesIndex + 2)).join("/")}`.replace(/\/+$/g, "") || "/api"];
  }
  const apiIndex = segments.findIndex((segment) => segment === "api" || segment === "apis");
  if (apiIndex >= 0) {
    const routeSegments = routeSegmentsFromFileParts(segments.slice(apiIndex + 1));
    if (routeSegments.length > 0) {
      return [`/api/${routeSegments.join("/")}`];
    }
  }
  return [];
}

function routeSegmentsFromFileParts(parts: string[]): string[] {
  return parts
    .filter((segment) => !/^(?:route|handler|controller|index)$/.test(segment))
    .map((segment) => segment.replace(/^\[(\.\.\.)?(.+)\]$/, ":$2"))
    .filter(Boolean);
}

function isBackendImplementationFile(file: string): boolean {
  return /(?:^|\/)(?:server|servers|backend|api|apis|routes|controllers?|handlers?|resolvers?|endpoints?)\//i.test(file) ||
    /(?:openapi|swagger|schema|controller|handler|resolver|route)\.(?:json|ya?ml|[cm]?[jt]sx?|py|go|rs|kt|java|rb|php)$/i.test(file) ||
    /(?:^|\/)(?:urls|views|viewsets|serializers|routers|controllers?|handlers?|admin|models|services|tasks|permissions|filters|consumers|signals)\w*\.py$/i.test(file) ||
    /(?:^|\/)(?:views|viewsets|serializers|services|routers|handlers|tasks|consumers)\/[^/]+\.py$/i.test(file);
}

function isMockOrFixtureFile(file: string): boolean {
  if (isFixtureEvidenceIgnoredPath(file)) {
    return false;
  }
  const basename = path.basename(file);
  const stem = basename.replace(/\.[^.]+$/g, "");
  const extension = path.extname(basename).toLowerCase();
  const canUseBroadFilenameMatch = fixtureEvidenceSourceExtensions.has(extension);
  return /(?:^|\/)(?:__mocks__|mocks?|fixtures?|factories|seeds?|test-data|testData|msw|mirage)\//i.test(file) ||
    /(?:mock|fixture|factory|seed|handler|msw)\.[cm]?[jt]sx?$/i.test(basename) ||
    (canUseBroadFilenameMatch && /(?:mock|fixture|factory|seed|msw|mirage)/i.test(stem));
}

function isFixtureEvidenceIgnoredPath(file: string): boolean {
  return /(?:^|\/)(?:node_modules|vendor|vendors|Pods|build|dist|coverage|\.next|\.nuxt|\.expo|\.turbo|\.yarn\/cache)\//i.test(file);
}

const fixtureEvidenceSourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".py",
]);

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
    const routeMatchers = [
      /(?:href|to)\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*["']([^"']+)["']\s*\})|(?:router\.(?:push|replace)|navigate)\(\s*["']([^"']+)["']/g,
      /\b(?:path|pathname)\s*:\s*["']([^"']+)["']/g,
    ];
    for (const matcher of routeMatchers) {
      for (const match of text.matchAll(matcher)) {
        const route = normalizeEntrypointRoute(match[1] ?? match[2] ?? match[3] ?? match[4]);
        if (route) {
          entrypoints.push({ kind: "route", value: route, file, confidence: "medium" });
        }
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
  if (isRouteConfigEntrypointFile(file)) {
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

function isRouteConfigEntrypointFile(file: string): boolean {
  const basename = stripKnownExtension(path.basename(file));
  return /^(?:app[-_ ]?)?routes?|(?:app[-_ ]?)?router|route[-_ ]?config$/i.test(basename);
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
  if (!stem || /^\([^)]*\)$/.test(stem) || stem.startsWith("_") || stem.startsWith("@")) {
    return undefined;
  }
  const routeStem = stem.replace(/^\((?:\.{1,3})\)/, "");
  if (!routeStem) {
    return undefined;
  }
  if (/^(?:index|page|route|layout|template|loading|error|not-found|404|500)$/i.test(routeStem)) {
    return undefined;
  }
  const dynamic = dynamicRouteSegmentName(routeStem);
  if (dynamic) {
    return `:${normalizeRouteParamName(dynamic)}`;
  }
  return normalizeStaticRouteSegment(routeStem.replace(/Page$/i, ""));
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

function normalizeStaticRouteSegment(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /[\s<>"'`\\{}]/.test(trimmed)) {
    return undefined;
  }
  if (/^[A-Za-z0-9._~-]+$/.test(trimmed)) {
    return trimmed;
  }
  return slugify(trimmed);
}

function shouldDropRouteLeaf(leaf: string, parent: string | undefined): boolean {
  return Boolean(parent && leaf.toLowerCase() === parent.toLowerCase());
}

function normalizeEntrypointRoute(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || /^\/\//.test(value) || /[{}]/.test(value)) {
    return undefined;
  }
  const withoutQuery = value.split(/[?#]/)[0];
  if (withoutQuery.length === 0 || withoutQuery.length > 120) {
    return undefined;
  }
  const segments = withoutQuery.split("/").filter(Boolean);
  const normalizedSegments: string[] = [];
  for (const segment of segments) {
    const normalized = normalizeEntrypointRouteSegment(segment);
    if (normalized) {
      normalizedSegments.push(normalized);
    }
  }
  return normalizedSegments.length === 0 ? "/" : `/${normalizedSegments.join("/")}`;
}

function normalizeEntrypointRouteSegment(segment: string): string | undefined {
  if (!segment || /^\([^)]*\)$/.test(segment) || segment.startsWith("_") || segment.startsWith("@")) {
    return undefined;
  }
  const routeSegment = segment.replace(/^\((?:\.{1,3})\)/, "");
  if (!routeSegment) {
    return undefined;
  }
  const dynamic = dynamicRouteSegmentName(routeSegment);
  if (dynamic) {
    return `:${normalizeRouteParamName(dynamic)}`;
  }
  if (routeSegment.startsWith(":")) {
    return `:${normalizeRouteParamName(routeSegment.slice(1))}`;
  }
  if (/[\s<>"'`\\]/.test(routeSegment)) {
    return undefined;
  }
  return routeSegment;
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
  if (project.type === "cli") {
    return [
      "Generated CLI checklists should verify valid invocation, invalid arguments, stdout, stderr, exit code, and generated files.",
      "Prefer one documented example command plus one failure-path command before treating the checklist as PR evidence.",
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

function isDesignTokenFile(file: string): boolean {
  return /(?:^|\/)(?:tokens?|design-tokens?)\/.+\.(?:json|ya?ml)$/i.test(file) ||
    /(?:^|\/)(?:style-dictionary|tokens?)\.config\.[cm]?[jt]s$/i.test(file) ||
    /(?:^|\/)(?:semantic|color|colors|spacing|radius|typography|font|fonts|size|sizes|shadow|shadows)\.tokens?\.(?:json|ya?ml)$/i.test(
      file,
    );
}

function isCatalogDataFile(file: string): boolean {
  return /(?:^|\/)(?:catalog|taxonomy)\/.+\.(?:json|ya?ml|csv|tsv|xlsx?)$/i.test(file) ||
    /(?:^|\/)(?:schema|schemas)\/.*(?:catalog|taxonomy|events?|properties|metrics?|tracking|analytics).*\.(?:json|ya?ml|csv|tsv|xlsx?)$/i.test(
      file,
    ) ||
    /(?:^|\/)(?:source|sources)\/.*(?:catalog|taxonomy|events?|properties|metrics?|tracking|analytics).*\.(?:csv|tsv|xlsx?)$/i.test(
      file,
    ) ||
    /(?:^|\/)tools\/(?:build|generate|validate)[-_]?(?:catalog|taxonomy|catalog[-_]site)\.(?:py|[cm]?[jt]s)$/i.test(file) ||
    /(?:^|\/)(?:catalog|taxonomy)-site\/index\.html$/i.test(file);
}

function isConfigLikeFile(file: string): boolean {
  return isReleaseMetadataFile(file) || /(?:(?:^|\/)(?:\.agents?|\.claude|\.cursor|\.dev|\.gemini|\.github|docs?)\/|(?:^|\/)(?:AGENTS|CLAUDE|CODEX|DECISIONS|GEMINI|PLAN|README|SKILL)\.md$|\.gitignore|package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb|pyproject\.toml|requirements\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|gradle\.properties|vite|webpack|babel|tsconfig|next\.config|app\.config|eas\.json|release-please|docker|env|feature-?flags?|experiments?)/i.test(
    file,
  );
}

function isReleaseMetadataFile(file: string): boolean {
  return /(?:^|\/)(?:CHANGELOG|RELEASES?|release-notes?|\.release-please-manifest)\.(?:md|json)$/i.test(file) ||
    /(?:^|\/)\.changeset\//i.test(file) ||
    /(?:release-please|changeset)/i.test(file);
}

function isPackageMetadataFile(file: string): boolean {
  return /(?:^|\/)package\.json$/i.test(file);
}

function isReleaseMetadataOnlyChange(files: string[]): boolean {
  return files.some(isReleaseMetadataFile) && files.every((file) => isReleaseMetadataFile(file) || isPackageMetadataFile(file));
}

function isTestEvidenceOnlyChange(files: string[]): boolean {
  return files.length > 0 && files.every(isTestLikeFile);
}

function isDocumentationOnlyChange(files: string[]): boolean {
  return files.length > 0 && files.every(isDocumentationFile);
}

function isGeneratedOutputOnlyChange(files: string[]): boolean {
  return files.length > 0 && files.every(isGeneratedOutputFile);
}

function isLowSignalVerificationOnlyChange(files: string[]): boolean {
  return files.length > 0 && files.every((file) => isTestLikeFile(file) || isDocumentationFile(file) || isGeneratedOutputFile(file));
}

function isTestLikeFile(file: string): boolean {
  return (
    /(?:^|\/)__snapshots__\//i.test(file) ||
    /(?:^|\/)(?:__tests__|tests?|specs?|e2e)\//i.test(file) ||
    /\.(?:snap|snapshot)$/i.test(file) ||
    /(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/i.test(file) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(file) ||
    /(?:^|\/)[^/]+_test\.(?:py|go)$/i.test(file) ||
    /(?:^|\/)[^/]+(?:Test|Tests|Spec)\.(?:java|kt|cs|swift)$/i.test(file) ||
    /(?:^|\/)[^/]+_(?:test|spec)\.rs$/i.test(file)
  );
}

function isDocumentationFile(file: string): boolean {
  if (isReleaseMetadataFile(file)) {
    return false;
  }
  return (
    /(?:^|\/)(?:docs?|adr|adrs|decisions|guides?|handbook|rfcs?|specs?)\//i.test(file) ||
    /(?:^|\/)(?:README|CONTRIBUTING|SECURITY|SUPPORT|CODE_OF_CONDUCT|ARCHITECTURE|DECISIONS|PLAN)\.(?:md|mdx|rst|adoc)$/i.test(
      file,
    ) ||
    /\.(?:md|mdx|rst|adoc)$/i.test(file)
  );
}

function isGeneratedOutputFile(file: string): boolean {
  if (isTestLikeFile(file) || isReleaseMetadataFile(file)) {
    return false;
  }
  return (
    /(?:^|\/)(?:dist|build|out|coverage|generated|__generated__|codegen)\//i.test(file) ||
    /(?:^|\/)(?:public|src|lib|packages?)\/(?:generated|__generated__|codegen)\//i.test(file) ||
    /(?:^|\/)[^/]*(?:generated|codegen)[^/]*\.(?:[cm]?[jt]sx?|json|ya?ml|css|scss|md)$/i.test(file) ||
    /\.(?:generated|gen)\.[cm]?[jt]sx?$/i.test(file)
  );
}

function isUiImplementationFile(file: string): boolean {
  return /\.(?:tsx|jsx|vue|svelte)$/i.test(file);
}

function isServiceSourceFile(file: string): boolean {
  return /(?:^|\/)src\/.+\.(?:[cm]?[jt]s|py|go|rs|java|kt|cs)$/i.test(file) ||
    /(?:^|\/)(?:urls|views|viewsets|serializers|routers|controllers?|handlers?|admin|models|services|tasks|permissions|filters|consumers|signals)\w*\.py$/i.test(file) ||
    /(?:^|\/)(?:views|viewsets|serializers|services|api|apis|routers|handlers|tasks|consumers)\/[^/]+\.py$/i.test(file);
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
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
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
  const manifestFlows = await buildManifestDraftFlows(plan, baseFlows);
  const domainScenarios = shouldUseDomainScenariosForDraft(plan) ? plan.domainLanguage.scenarios : [];
  const scenarioFlows = await Promise.all(
    domainScenarios
      .filter((scenario) => scenario.files.length > 0 || scenario.source === "core-flow")
      .slice(0, 4)
      .map((scenario) => buildDomainScenarioDraftFlow(plan, scenario, baseFlows)),
  );

  if (manifestFlows.length === 0 && scenarioFlows.length === 0) {
    return baseFlows.map((flow) => ({
      ...flow,
      draftSource: "heuristic",
    }));
  }

  const combined = prioritizeImportantBaseDraftFlow(dedupeDraftFlowsByOutputPath(
    dedupeFlows([...manifestFlows, ...scenarioFlows, ...baseFlows]),
    plan.recommendedRunner.name,
  ), baseFlows).slice(0, 4);
  return combined.map((flow) => ({
    ...flow,
    draftSource: draftFlowSource(flow),
  }));
}

function prioritizeImportantBaseDraftFlow(flows: DraftE2eFlow[], baseFlows: E2eFlow[]): DraftE2eFlow[] {
  const importantBaseFlow = baseFlows.find(isImportantBaseDraftFlow);
  if (!importantBaseFlow) {
    return flows;
  }
  const existingIndex = flows.findIndex((flow) => flow.title === importantBaseFlow.title);
  if (existingIndex < 0 || existingIndex < 4) {
    return flows;
  }
  const copy = [...flows];
  const [flow] = copy.splice(existingIndex, 1);
  return [...copy.slice(0, 3), flow, ...copy.slice(3)];
}

function isImportantBaseDraftFlow(flow: E2eFlow): boolean {
  return (
    isApiContractFocusedFlow(flow) ||
    isDesignTokenFocusedFlow(flow) ||
    isCatalogFocusedFlow(flow) ||
    isCliCommandFocusedFlow(flow) ||
    isEvidenceVerificationFocusedFlow(flow)
  );
}

function shouldUseDomainScenariosForDraft(plan: E2ePlanResult): boolean {
  const files = plan.changedFiles.map((file) => file.path);
  if (isLowSignalVerificationOnlyChange(files)) {
    return false;
  }
  return !plan.flows.every(isEvidenceVerificationFocusedFlow);
}

function isEvidenceVerificationFocusedFlow(flow: Omit<E2eFlow, "languageBrief">): boolean {
  return isTestEvidenceFocusedFlow(flow) || isDocumentationFocusedFlow(flow) || isGeneratedArtifactFocusedFlow(flow);
}

function dedupeDraftFlowsByOutputPath(flows: DraftE2eFlow[], runner: E2eRunnerName): DraftE2eFlow[] {
  const flowsByOutput = new Map<string, DraftE2eFlow>();
  for (const flow of flows) {
    const outputKey = `${slugify(flow.title)}${draftExtension(runner)}`;
    const existing = flowsByOutput.get(outputKey);
    flowsByOutput.set(outputKey, existing ? mergeDraftFlows(existing, flow) : flow);
  }
  return [...flowsByOutput.values()];
}

function mergeDraftFlows(left: DraftE2eFlow, right: DraftE2eFlow): DraftE2eFlow {
  const mergedFlow: Omit<DraftE2eFlow, "languageBrief"> = {
    ...left,
    files: uniqueStrings([...left.files, ...right.files]).slice(0, 20),
    steps: uniqueStrings([...left.steps, ...right.steps]).slice(0, 8),
    coverage: uniqueCoverageTargets([...left.coverage, ...right.coverage]).slice(0, 7),
    coverageEvidence: left.coverageEvidence.length > 0 ? left.coverageEvidence : right.coverageEvidence,
    entrypoints: uniqueEntrypoints([...left.entrypoints, ...right.entrypoints]).slice(0, 6),
    setupHints: uniqueSetupHints([...left.setupHints, ...right.setupHints]).slice(0, 6),
    selectors: uniqueSelectors([...left.selectors, ...right.selectors]).slice(0, 12),
    missingTestability: uniqueStrings([...left.missingTestability, ...right.missingTestability]),
    draftSource: preferredDraftSource(left.draftSource, right.draftSource),
    manifestMatch: left.manifestMatch ?? right.manifestMatch,
    manifestCheckMatches: uniqueManifestCheckMatches([
      ...(left.manifestCheckMatches ?? []),
      ...(right.manifestCheckMatches ?? []),
    ]),
    domainScenario: left.domainScenario ?? right.domainScenario,
    coreFlow: left.coreFlow ?? right.coreFlow,
  };
  return {
    ...mergedFlow,
    languageBrief: buildFlowLanguageBrief(mergedFlow),
  };
}

function uniqueManifestCheckMatches(matches: VerificationManifestMatch[]): VerificationManifestMatch[] {
  const seen = new Set<string>();
  const unique: VerificationManifestMatch[] = [];
  for (const match of matches) {
    const key = `${match.id}:${match.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(match);
  }
  return unique;
}

function preferredDraftSource(left: DraftFlowSource | undefined, right: DraftFlowSource | undefined): DraftFlowSource | undefined {
  const ranks: Record<DraftFlowSource, number> = {
    "verification-manifest": 0,
    "core-flow": 1,
    "domain-language": 2,
    heuristic: 3,
  };
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return ranks[right] < ranks[left] ? right : left;
}

async function buildManifestDraftFlows(
  plan: E2ePlanResult,
  baseFlows: E2eFlow[],
): Promise<DraftE2eFlow[]> {
  const flowMatches = plan.verificationManifestMatches
    .filter((match) => match.kind === "flow")
    .slice(0, 4);
  const checkMatches = plan.verificationManifestMatches.filter((match) => match.kind === "check");
  return Promise.all(
    flowMatches.map((match) => buildManifestDraftFlow(plan, match, checkMatches, baseFlows)),
  );
}

async function buildManifestDraftFlow(
  plan: E2ePlanResult,
  match: VerificationManifestMatch,
  checkMatches: VerificationManifestMatch[],
  baseFlows: E2eFlow[],
): Promise<DraftE2eFlow> {
  const relatedChecks = checkMatches.filter((check) => check.id.startsWith(`${match.id}.`));
  const manifestFiles = normalizeScenarioFilesForRoot(plan, match.matchedFiles);
  const baseFlow = bestBaseFlowForManifestMatch(manifestFiles, baseFlows);
  const files = uniqueStrings(manifestFiles.length > 0 ? manifestFiles : (baseFlow?.files ?? [])).slice(0, 20);
  const runner = plan.recommendedRunner.name;
  const manifestSteps = manifestStepsForMatch(match, relatedChecks);
  const baseCoverage = baseFlow?.coverage ?? buildCoverageTargets("domain", files, runner);
  const coverage = uniqueCoverageTargets([...manifestCoverageTargets(match, relatedChecks), ...baseCoverage]).slice(0, 7);
  const entrypoints = uniqueEntrypoints([
    ...manifestEntrypoints(plan, match, runner),
    ...filterEntrypointsForFiles(baseFlows.flatMap((flow) => flow.entrypoints), files),
    ...(await inferFlowEntrypoints(plan.root, files, runner)),
  ]);
  const selectors = uniqueSelectors([
    ...filterSelectorsForFiles(baseFlows.flatMap((flow) => flow.selectors), files),
    ...(await inferFlowSelectors(plan.root, files, runner)),
  ]);
  const refinedSteps = refineManifestStepsForInferredSelectors(
    refineStepsForInferredSelectors(manifestSteps.length > 0 ? manifestSteps : (baseFlow?.steps ?? []), selectors),
    selectors,
  );
  const setupHints = uniqueSetupHints([
    ...filterSetupHintsForFiles(baseFlows.flatMap((flow) => flow.setupHints), files),
    ...(await inferFlowSetupHints(plan.root, files, "domain")),
  ]);
  const flow: Omit<DraftE2eFlow, "languageBrief"> = {
    title: match.name,
    reason: match.reason,
    files,
    steps: refinedSteps,
    coverage,
    coverageEvidence: baseFlow?.coverageEvidence ?? [],
    entrypoints,
    setupHints,
    fixtureReadiness: scenarioFixtureReadiness(baseFlow, setupHints),
    selectors,
    missingTestability: await findFlowTestabilityGaps(plan.root, files, runner),
    draftSource: "verification-manifest",
    manifestMatch: match,
    manifestCheckMatches: relatedChecks,
    coreFlow: coreFlowForManifestMatch(plan, match),
  };
  return {
    ...flow,
    languageBrief: buildFlowLanguageBrief(flow),
  };
}

function bestBaseFlowForManifestMatch(files: string[], baseFlows: E2eFlow[]): E2eFlow | undefined {
  let best: { flow: E2eFlow; score: number } | undefined;
  for (const flow of baseFlows) {
    const score = fileOverlapScore(files, flow.files);
    if (!best || score > best.score) {
      best = { flow, score };
    }
  }
  return best && best.score > 0 ? best.flow : baseFlows[0];
}

function coreFlowForManifestMatch(plan: E2ePlanResult, match: VerificationManifestMatch): MatchedCoreFlow | undefined {
  return plan.coreFlows.find((flow) => flow.name === match.name || flow.id === match.id);
}

function manifestStepsForMatch(
  match: VerificationManifestMatch,
  relatedChecks: VerificationManifestMatch[],
): string[] {
  const checks = relatedChecks.length > 0 ? relatedChecks : (match.checks ?? []).map((checkTitle, index) => ({
    ...match,
    id: `${match.id}:check-${index + 1}`,
    name: checkTitle,
    checks: [checkTitle],
  }));
  return uniqueStrings(checks.flatMap(manifestStepsForCheckMatch));
}

function manifestStepsForCheckMatch(match: VerificationManifestMatch): string[] {
  if (match.checkSteps && match.checkSteps.length > 0) {
    return match.checkSteps.map((step) => withTerminalPeriod(step.trim())).filter(Boolean);
  }
  return [manifestStepForCheckMatch(match)];
}

function manifestStepForCheckMatch(match: VerificationManifestMatch): string {
  const title = stripTerminalPunctuation(match.name.trim());
  if (!title) {
    return "Verify the manifest-declared behavior.";
  }
  if (/^(?:verify|assert|check|confirm)\b/i.test(title)) {
    return `${title}.`;
  }
  if (match.checkType === "success" && isInteractionStep(title)) {
    return `${title}.`;
  }
  if (/^(?:show|display|render|return|surface|preserve)\b/i.test(title)) {
    return `Verify the flow can ${lowercaseFirst(title)}.`;
  }
  return `Verify ${lowercaseFirst(title)}.`;
}

function manifestCoverageTargets(
  match: VerificationManifestMatch,
  relatedChecks: VerificationManifestMatch[],
): E2eCoverageTarget[] {
  const checks = relatedChecks.length > 0
    ? relatedChecks.map((check) => manifestStepForCheckMatch(check))
    : (match.checks ?? []).map((check) => `Verify ${lowercaseFirst(stripTerminalPunctuation(check))}.`);
  if (checks.length === 0) {
    return [];
  }
  return [
    coverageTarget(
      "Manifest-required checks",
      match.criticality === "high" ? "critical" : "recommended",
      "The verification manifest declares these checks as team-owned PR evidence for this flow.",
      checks,
    ),
  ];
}

function manifestEntrypoints(
  plan: E2ePlanResult,
  match: VerificationManifestMatch,
  runner: E2eRunnerName,
): E2eEntrypoint[] {
  if (runner === "maestro" || !match.entryRoute) {
    return [];
  }
  const route = normalizeEntrypointRoute(match.entryRoute);
  if (!route) {
    return [];
  }
  return [
    {
      kind: "route",
      value: route,
      file: plan.verificationManifestPath ?? ".qamap/manifest.yaml",
      confidence: match.confidence === "high" ? "high" : "medium",
    },
  ];
}

async function buildDomainScenarioDraftFlow(
  plan: E2ePlanResult,
  scenario: DomainScenarioSuggestion,
  baseFlows: E2eFlow[],
): Promise<DraftE2eFlow> {
  const coreFlow = matchedCoreFlowForScenario(plan, scenario);
  const baseFlow = bestBaseFlowForScenario(scenario, baseFlows);
  const specializedScenario = specializedDomainScenarioDraft(scenario, baseFlow);
  const title = specializedScenario?.title ?? scenario.title;
  const reason = specializedScenario?.reason ?? scenario.intent;
  const steps = specializedScenario?.steps ?? (scenario.checks.length > 0 ? scenario.checks : (baseFlow?.steps ?? []));
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
  const refinedSteps = refineStepsForInferredSelectors(steps, selectors);
  const setupHints = uniqueSetupHints([
    ...filterSetupHintsForFiles(baseFlows.flatMap((flow) => flow.setupHints), files),
    ...(shouldInferDomainScenarioSetupHints(baseFlow) ? await inferFlowSetupHints(plan.root, files, "domain") : []),
  ]);
  const draftScenario = {
    ...scenario,
    title,
    intent: reason,
    checks: refinedSteps,
  };
  const flow: Omit<DraftE2eFlow, "languageBrief"> = {
    title,
    reason,
    files,
    steps: refinedSteps,
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

function shouldInferDomainScenarioSetupHints(baseFlow: E2eFlow | undefined): boolean {
  return !baseFlow || (!isDesignTokenFocusedFlow(baseFlow) && !isCatalogFocusedFlow(baseFlow));
}

interface SpecializedDomainScenarioDraft {
  title: string;
  reason: string;
  steps: string[];
}

function specializedDomainScenarioDraft(
  scenario: DomainScenarioSuggestion,
  baseFlow: E2eFlow | undefined,
): SpecializedDomainScenarioDraft | undefined {
  if (scenario.source !== "changed-file" || !baseFlow) {
    return undefined;
  }
  if (isApiContractFocusedFlow(baseFlow)) {
    const subject = scenario.title.replace(/\s+primary journey$/i, "");
    return {
      title: `${subject} API contract`,
      reason: `Verify "${subject}" through the changed API or service contract instead of assuming a browser or device journey.`,
      steps: baseFlow.steps,
    };
  }
  if (isDesignTokenFocusedFlow(baseFlow) || isCatalogFocusedFlow(baseFlow)) {
    return {
      title: baseFlow.title,
      reason: baseFlow.reason,
      steps: baseFlow.steps,
    };
  }
  if (isCliCommandFocusedFlow(baseFlow)) {
    const subject = scenario.title.replace(/\s+primary journey$/i, "");
    return {
      title: cliCommandChecklistTitle(subject),
      reason: `Verify "${subject}" through command invocation, output, exit code, and failure behavior instead of assuming a browser or device journey.`,
      steps: baseFlow.steps,
    };
  }
  return undefined;
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
      apiEndpoints: [],
      backendSignals: [],
      mockSignals: [],
      nextActions: [],
    };
  }
  return {
    status: "missing",
    reason: "This scenario has response or fixture setup hints, but no base flow fixture evidence was available.",
    apiSignals: setupHints.flatMap((hint) => hint.files).slice(0, maxFilesPerFlow),
    apiEndpoints: [],
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
  const manifestPath = plan.coreFlowManifestPath ?? ".qamap/flows.yml";
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
    blockers.push(
      `${validationSummary.blockingGapCount} blocking validation gap${validationSummary.blockingGapCount === 1 ? "" : "s"} ${
        validationSummary.blockingGapCount === 1 ? "remains" : "remain"
      }.`,
    );
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
  const fallback = fallbackFlowDefinition(plan.project.type);
  const coverage = buildCoverageTargets(fallback.kind, [], plan.recommendedRunner.name);
  const flow: Omit<E2eFlow, "languageBrief"> = {
    title: fallback.title,
    reason: fallback.reason,
    files: [],
    steps: fallback.steps,
    coverage,
    coverageEvidence: evaluateFlowCoverageEvidence(
      { title: fallback.title, files: [], coverage },
      {
        ...plan.testSuite,
        files: [],
      },
    ),
    entrypoints: [],
    setupHints: [],
    fixtureReadiness: {
      status: fallback.fixtureStatus,
      reason: fallback.fixtureReason,
      apiSignals: [],
      apiEndpoints: [],
      backendSignals: [],
      mockSignals: [],
      nextActions: fallback.fixtureActions,
    },
    selectors: [],
    missingTestability: plan.missingTestability,
  };
  return {
    ...flow,
    languageBrief: buildFlowLanguageBrief(flow),
  };
}

function fallbackFlowDefinition(projectType: E2eProjectType): {
  title: string;
  reason: string;
  steps: string[];
  kind: E2eFlowKind;
  fixtureStatus: E2eFixtureReadinessStatus;
  fixtureReason: string;
  fixtureActions: string[];
} {
  if (projectType === "api-service") {
    return {
      title: "API contract smoke flow",
      reason:
        "No changed endpoint-specific files were detected, so QAMap generated a service contract smoke checklist instead of an app-launch journey.",
      steps: [
        "Start the service with the documented local command.",
        "Call one representative health, auth, or changed-domain endpoint.",
        "Verify response status, response shape, auth behavior, and error handling.",
        "Record the request example and response fixture as PR evidence.",
      ],
      kind: "api",
      fixtureStatus: "missing",
      fixtureReason: "API service smoke coverage needs at least one deterministic request and response fixture before it can be trusted.",
      fixtureActions: [
        "Add a success response fixture plus one unauthorized, validation, timeout, or server-error response.",
        "Document the local base URL, auth header, and request payload used for the contract check.",
      ],
    };
  }
  if (projectType === "cli") {
    return {
      title: "CLI command smoke flow",
      reason:
        "No changed command-specific files were detected, so QAMap generated a command contract smoke checklist.",
      steps: [
        "Run the documented help or version command.",
        "Run one valid command invocation with a small fixture input.",
        "Verify stdout, stderr, exit code, and generated files.",
        "Run one invalid argument path and verify the failure message.",
      ],
      kind: "command",
      fixtureStatus: "not-needed",
      fixtureReason: "CLI fallback coverage starts with command arguments, output, exit code, and fixture files rather than API response data.",
      fixtureActions: [],
    };
  }
  if (projectType === "design-tokens") {
    return {
      title: "Design token artifact smoke flow",
      reason:
        "No changed token-specific files were detected, so QAMap generated an artifact validation checklist.",
      steps: [
        "Run the token validation or build command.",
        "Regenerate published token artifacts.",
        "Verify one representative consumer, visual sample, or theme fixture.",
        "Record any renamed, removed, or newly-required token fields.",
      ],
      kind: "artifact",
      fixtureStatus: "not-needed",
      fixtureReason: "Design token fallback coverage needs generated artifacts and consumer samples rather than API response fixtures.",
      fixtureActions: [],
    };
  }
  if (projectType === "data-catalog") {
    return {
      title: "Catalog artifact smoke flow",
      reason:
        "No changed catalog-specific files were detected, so QAMap generated a catalog validation checklist.",
      steps: [
        "Run the catalog schema or generation command.",
        "Verify the generated export or documentation artifact.",
        "Run one downstream consumer, ingestion, or migration fixture if available.",
        "Record renamed, removed, deprecated, or newly-required fields.",
      ],
      kind: "catalog",
      fixtureStatus: "not-needed",
      fixtureReason: "Catalog fallback coverage needs schema, generated output, and consumer fixtures rather than API response data.",
      fixtureActions: [],
    };
  }
  return {
    title: "App launch smoke flow",
    reason:
      "No changed user-facing files were detected, so QAMap generated a minimal smoke draft for the detected app surface.",
    steps: [
      "Launch the app.",
      "Verify the first screen renders.",
      "Exercise the primary visible action if one is present.",
      "Verify the app remains usable after the action.",
    ],
    kind: "changed-file",
    fixtureStatus: "not-needed",
    fixtureReason: "No API, network, payment, or external-response dependency was detected for this fallback flow.",
    fixtureActions: [],
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

function dryRunPreviewReason(fileAlreadyExists: boolean, force: boolean): string {
  if (!fileAlreadyExists) {
    return "Dry run only; no file was written.";
  }
  if (force) {
    return "Dry run only; no file was written. Existing file would be overwritten because --force is set.";
  }
  return "Dry run only; no file was written. Existing file would be skipped unless --force is set.";
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
  lines.push(`# Generated by QAMap ${VERSION}`);
  lines.push(`# Flow: ${flow.title}`);
  if (scenario) {
    lines.push(`# Domain scenario: ${scenario.title}`);
    lines.push(`# Intent: ${scenario.intent}`);
  }
  lines.push(`# Base: ${plan.base}`);
  lines.push(`# Head: ${plan.head}`);
  appendDraftBriefComments(lines, flow, "maestro", "#");
  appendExecutionProfileComments(lines, plan.executionProfile, "#");
  appendRunnerSetupProposalComments(lines, plan.runnerSetup, "#");
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
  appendManifestMatchComments(lines, flow, "#");
  for (const step of draftExecutableSteps(flow, "maestro")) {
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

type MaestroDraftCommand =
  | { kind: "tapOn" | "assertVisible" | "swipe"; value: string }
  | { kind: "inputText"; target: string; text: string }
  | { kind: "comment"; value: string };

function maestroCommandForStep(
  step: string,
  selectors: E2eSelector[],
): MaestroDraftCommand {
  if (isGestureStep(step)) {
    return {
      kind: "swipe",
      value: "{ start: \"35%, 55%\", end: \"65%, 55%\" }",
    };
  }
  const selector = takeSelectorForStep(selectors, step);
  if (isAssertionStep(step)) {
    return {
      kind: "assertVisible",
      value: selector ? maestroSelectorValue(selector) : quoteYaml(".*"),
    };
  }
  if (selector && isInputSelector(selector) && isInteractionStep(step)) {
    return {
      kind: "inputText",
      target: maestroSelectorValue(selector),
      text: quoteYaml(sampleInputForStepOrSelector(step, selector.value)),
    };
  }
  if (!selector) {
    return {
      kind: "comment",
      value: `QAMap could not infer a stable Maestro selector for: ${step}`,
    };
  }
  return {
    kind: "tapOn",
    value: maestroSelectorValue(selector),
  };
}

function buildPlaywrightDraft(plan: E2ePlanResult, flow: E2eFlow): string {
  const testName = flow.title.replaceAll('"', "'");
  const selectorQueue = [...flow.selectors];
  const scenario = domainScenarioForFlow(flow);
  const lines: string[] = [];
  lines.push(`// Generated by QAMap ${VERSION}`);
  lines.push(`// Base: ${plan.base}`);
  lines.push(`// Head: ${plan.head}`);
  lines.push(`// Flow: ${flow.title}`);
  if (scenario) {
    lines.push(`// Domain scenario: ${scenario.title}`);
    lines.push(`// Intent: ${scenario.intent}`);
  }
  appendDraftBriefComments(lines, flow, "playwright", "//");
  appendExecutionProfileComments(lines, plan.executionProfile, "//");
  appendRunnerSetupProposalComments(lines, plan.runnerSetup, "//");
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
  appendManifestMatchComments(lines, flow, "  //");
  const routeEntrypoint = primaryRouteEntrypoint(flow);
  const routeDraft = buildPlaywrightRouteDraft(routeEntrypoint?.value ?? "/", flow.entrypoints);
  if (routeDraft.params.length > 0) {
    lines.push("");
    lines.push("  const routeParams = {");
    for (const param of routeDraft.params) {
      lines.push(`    ${playwrightRouteParamKey(param.name)}: "${quoteJs(param.value ?? routeParamPlaceholder(param.name))}",`);
    }
    lines.push("  };");
    if (routeDraft.params.some((param) => param.value === undefined)) {
      lines.push("  // QAMap used stable sample route params; replace them with domain fixture values when available.");
    } else {
      lines.push("  // Route params were inferred from concrete route hints in the changed files.");
    }
  }
  appendPlaywrightMockRouteScaffold(lines, flow);
  appendPlaywrightTestStep(lines, flow.languageBrief.trigger, [
    `await page.goto(${routeDraft.expression});`,
  ]);
  for (const step of draftExecutableSteps(flow, "playwright")) {
    const manifestCheck = manifestCheckForDraftStep(flow, step);
    const manifestBody = manifestCheck ? playwrightActionForManifestCheck(manifestCheck, step) : undefined;
    const selector = manifestBody ? undefined : takeSelectorForStep(selectorQueue, step);
    const body = manifestBody ??
      (selector
        ? playwrightActionForStep(selector, playwrightLocator(selector), step)
        : playwrightFallbackActionForStep(step));
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

function draftExecutableSteps(flow: E2eFlow, runner: E2eRunnerName): string[] {
  const executableSteps = flow.steps.filter((step) => !shouldSkipDraftStep(step, flow, runner));
  return executableSteps.length > 0 ? executableSteps : flow.steps;
}

function shouldSkipDraftStep(step: string, flow: E2eFlow, runner: E2eRunnerName): boolean {
  if (!isEntrypointPreparationStep(step)) {
    return false;
  }
  if (runner === "playwright") {
    return Boolean(primaryRouteEntrypoint(flow));
  }
  if (runner === "maestro") {
    return stepMatchesLaunchStep(step) || flow.entrypoints.length > 0;
  }
  return false;
}

function isEntrypointPreparationStep(step: string): boolean {
  return /^start from\b/i.test(step) ||
    /^launch the app\b/i.test(step) ||
    /^open route\b/i.test(step) ||
    /^open the .+ screen\b/i.test(step) ||
    /^(?:navigate|go) to\b/i.test(step);
}

function stepMatchesLaunchStep(step: string): boolean {
  return /^launch\b/i.test(step);
}

function buildManualDraft(plan: E2ePlanResult, flow: E2eFlow): string {
  const scenario = domainScenarioForFlow(flow);
  const lines: string[] = [];
  lines.push(`# ${flow.title}`);
  lines.push("");
  lines.push(`Generated by QAMap ${VERSION}.`);
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
  appendManualRunnerSetupProposal(lines, plan.runnerSetup);
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
  appendManualManifestMatch(lines, flow);
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

function appendRunnerSetupProposalMarkdown(lines: string[], setup: E2eRunnerSetupProposal): void {
  lines.push("## Runner Setup Proposal");
  lines.push("");
  lines.push(`- Status: ${setup.status}`);
  lines.push(`- Runner: ${formatRunnerName(setup.runner)}`);
  lines.push(`- Proposal: ${escapeMarkdownInline(setup.title)}`);
  lines.push(`- Why this runner: ${escapeMarkdownInline(setup.reason)}`);
  if (setup.setupCommand) {
    lines.push(`- Accept setup with: \`${escapeMarkdownInline(setup.setupCommand)}\``);
  }
  if (setup.installCommands.length > 0) {
    lines.push("- Install commands:");
    for (const command of setup.installCommands) {
      lines.push(`  - \`${escapeMarkdownInline(command)}\``);
    }
  }
  if (setup.filesToCreate.length > 0) {
    lines.push(`- Files to create: ${setup.filesToCreate.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`);
  }
  if (setup.filesToUpdate.length > 0) {
    lines.push(`- Files to update: ${setup.filesToUpdate.map((file) => `\`${escapeMarkdownInline(file)}\``).join(", ")}`);
  }
  if (setup.nextCommands.length > 0) {
    lines.push("- Next commands after setup:");
    for (const command of setup.nextCommands.slice(0, 4)) {
      lines.push(`  - \`${escapeMarkdownInline(command)}\``);
    }
  }
  for (const note of setup.notes.slice(0, 3)) {
    lines.push(`- Note: ${escapeMarkdownInline(note)}`);
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

function appendManifestMatchComments(lines: string[], flow: E2eFlow, commentPrefix: string): void {
  const match = manifestMatchForDraftFlow(flow);
  if (!match) {
    return;
  }
  lines.push("");
  lines.push(`${commentPrefix} Verification manifest evidence:`);
  lines.push(`${commentPrefix} - Flow: ${match.name} (${match.id})`);
  lines.push(`${commentPrefix} - Confidence: ${match.confidence}`);
  lines.push(`${commentPrefix} - Evidence: ${match.manifestPath}`);
  lines.push(`${commentPrefix} - If wrong: update ${match.updatePath}`);
  if (match.entryRoute) {
    lines.push(`${commentPrefix} - Entry route: ${match.entryRoute}`);
  }
  if (match.checks && match.checks.length > 0) {
    lines.push(`${commentPrefix} - Required checks:`);
    for (const check of match.checks.slice(0, maxFilesPerFlow)) {
      lines.push(`${commentPrefix}   - [ ] ${check}`);
    }
  }
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

function appendManualManifestMatch(lines: string[], flow: E2eFlow): void {
  const match = manifestMatchForDraftFlow(flow);
  if (!match) {
    return;
  }
  lines.push("");
  lines.push("## Verification Manifest Evidence");
  lines.push("");
  lines.push(`- Flow: ${match.name} (${match.id})`);
  lines.push(`- Confidence: ${match.confidence}`);
  lines.push(`- Evidence: \`${match.manifestPath}\``);
  lines.push(`- If wrong: update \`${match.updatePath}\``);
  if (match.entryRoute) {
    lines.push(`- Entry route: \`${match.entryRoute}\``);
  }
  if (match.checks && match.checks.length > 0) {
    lines.push("- Required checks:");
    for (const check of match.checks.slice(0, maxFilesPerFlow)) {
      lines.push(`  - [ ] ${check}`);
    }
  }
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

function appendRunnerSetupProposalComments(
  lines: string[],
  setup: E2eRunnerSetupProposal,
  commentPrefix: string,
): void {
  if (setup.status === "ready" || setup.status === "not-applicable") {
    return;
  }
  lines.push("");
  lines.push(`${commentPrefix} Runner setup proposal:`);
  lines.push(`${commentPrefix} - ${setup.title}`);
  lines.push(`${commentPrefix} - Why: ${setup.reason}`);
  if (setup.setupCommand) {
    lines.push(`${commentPrefix} - Accept with: ${setup.setupCommand}`);
  }
  for (const command of setup.installCommands) {
    lines.push(`${commentPrefix} - Install: ${command}`);
  }
  if (setup.filesToCreate.length > 0) {
    lines.push(`${commentPrefix} - Creates: ${setup.filesToCreate.join(", ")}`);
  }
  if (setup.filesToUpdate.length > 0) {
    lines.push(`${commentPrefix} - Updates: ${setup.filesToUpdate.join(", ")}`);
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

function appendManualRunnerSetupProposal(lines: string[], setup: E2eRunnerSetupProposal): void {
  if (setup.status === "ready" || setup.status === "not-applicable") {
    return;
  }
  lines.push("");
  lines.push("## Runner Setup Proposal");
  lines.push("");
  lines.push(`- ${setup.title}`);
  lines.push(`- Why: ${setup.reason}`);
  if (setup.setupCommand) {
    lines.push(`- Accept with: \`${setup.setupCommand}\``);
  }
  for (const command of setup.installCommands) {
    lines.push(`- Install: \`${command}\``);
  }
  if (setup.filesToCreate.length > 0) {
    lines.push(`- Creates: ${setup.filesToCreate.map((file) => `\`${file}\``).join(", ")}`);
  }
  if (setup.filesToUpdate.length > 0) {
    lines.push(`- Updates: ${setup.filesToUpdate.map((file) => `\`${file}\``).join(", ")}`);
  }
}

function buildDraftBrief(flow: E2eFlow, runner: E2eRunnerName): DraftBrief {
  const manifestMatch = manifestMatchForDraftFlow(flow);
  const scenario = domainScenarioForFlow(flow);
  const coreFlow = coreFlowForDraftFlow(flow);
  const changedBehavior = flow.files.length > 0
    ? `${flow.reason} Changed files include ${formatFileSummary(flow.files)}.`
    : flow.reason;
  const criticalCoverage = flow.coverage.filter((target) => target.priority === "critical").map((target) => target.title);
  let whyThisFlowMatters: string;
  if (manifestMatch) {
    whyThisFlowMatters =
      `Verification manifest: ${manifestMatch.id} [${manifestMatch.confidence} confidence]. It protects the team-declared "${manifestMatch.name}" flow and ${formatHumanList(criticalCoverage)}.`;
  } else if (coreFlow) {
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
  const manifestMatch = manifestMatchForDraftFlow(flow);
  if (manifestMatch?.checks?.length) {
    inputs.push(`Keep verification manifest checks required: ${formatHumanList(manifestMatch.checks.slice(0, 3))}.`);
  }
  const coreFlow = coreFlowForDraftFlow(flow);
  if (coreFlow?.checks.length) {
    inputs.push(`Keep manifest checks required: ${formatHumanList(coreFlow.checks.slice(0, 3))}.`);
  }
  if (isDesignTokenFocusedFlow(flow)) {
    inputs.push("Record the token validation command and the artifact generation command used by this repository.");
    inputs.push("Keep one representative consumer, visual fixture, or theme sample that reads the changed tokens.");
  }
  if (isCatalogFocusedFlow(flow)) {
    inputs.push("Record the catalog validation command and the generation command for the published catalog artifact.");
    inputs.push("Keep one representative analytics, documentation, ingestion, or migration fixture that reads the changed entries.");
  }
  if (isTestEvidenceFocusedFlow(flow)) {
    inputs.push("Record the changed test command and the behavior, bug, or regression risk protected by the test.");
    inputs.push("Keep one failure, edge, or previous-regression signal visible in the test evidence.");
  }
  if (isDocumentationFocusedFlow(flow)) {
    inputs.push("Record the docs, markdown, link, example, or source comparison command used for the changed documentation.");
    inputs.push("Name any documented product behavior that still needs automated coverage as follow-up evidence.");
  }
  if (isGeneratedArtifactFocusedFlow(flow)) {
    inputs.push("Record the generator or build command that reproduced the changed artifact.");
    inputs.push("Keep one consumer build, typecheck, or test that imports the generated output.");
  }
  if (runner === "maestro") {
    inputs.push("Set APP_ID to the target app id or export it before running the flow.");
  }
  if (runner === "playwright") {
    const route = primaryRouteEntrypoint(flow)?.value;
    const routeDraft = route ? buildPlaywrightRouteDraft(route, flow.entrypoints) : undefined;
    for (const param of routeDraft?.params.filter((item) => item.value === undefined) ?? []) {
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

function manifestMatchForDraftFlow(flow: E2eFlow): VerificationManifestMatch | undefined {
  return (flow as DraftE2eFlow).manifestMatch;
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

function appendPlaywrightMockRouteScaffold(lines: string[], flow: E2eFlow): void {
  if (flow.fixtureReadiness.status === "not-needed" || flow.fixtureReadiness.apiEndpoints.length === 0) {
    return;
  }
  const changedEndpointHints = uniqueStrings(flow.fixtureReadiness.backendSignals.flatMap(apiEndpointFromBackendFile));
  const observedEndpoints = changedEndpointHints.length > 0
    ? changedEndpointHints
    : flow.fixtureReadiness.backendSignals.length > 0
    ? flow.fixtureReadiness.apiEndpoints
    : [];
  if (observedEndpoints.length > 0) {
    appendPlaywrightApiObservationScaffold(lines, observedEndpoints);
  }
  const mockableEndpoints = flow.fixtureReadiness.backendSignals.length > 0
    ? flow.fixtureReadiness.apiEndpoints.filter((endpoint) => !endpointMatchesAny(endpoint, observedEndpoints))
    : flow.fixtureReadiness.apiEndpoints;
  if (mockableEndpoints.length === 0) {
    return;
  }
  lines.push("");
  lines.push("  const mockApiResponses = {");
  for (const endpoint of mockableEndpoints.slice(0, maxFilesPerFlow)) {
    lines.push(`    "${quoteJs(playwrightMockRoutePattern(endpoint))}": {`);
    lines.push("      status: 200,");
    lines.push("      body: {");
    lines.push('        ok: true,');
    lines.push('        source: "qamap-draft",');
    lines.push("      },");
    lines.push("    },");
  }
  lines.push("  };");
  lines.push("  // Replace sample responses with deterministic fixtures from the target domain before promoting this draft.");
  lines.push("  for (const [urlPattern, response] of Object.entries(mockApiResponses)) {");
  lines.push("    await page.route(urlPattern, async (route) => {");
  lines.push("      await route.fulfill({");
  lines.push("        status: response.status,");
  lines.push('        contentType: "application/json",');
  lines.push("        body: JSON.stringify(response.body),");
  lines.push("      });");
  lines.push("    });");
  lines.push("  }");
}

function appendPlaywrightApiObservationScaffold(lines: string[], endpoints: string[]): void {
  lines.push("");
  lines.push("  const changedApiEndpointPatterns = [");
  for (const endpoint of endpoints.slice(0, maxFilesPerFlow)) {
    lines.push(`    "${quoteJs(playwrightMockRoutePattern(endpoint))}",`);
  }
  lines.push("  ];");
  lines.push("  const observedChangedApiResponses: Array<{ url: string; status: number }> = [];");
  lines.push("  page.on(\"response\", (response) => {");
  lines.push("    if (changedApiEndpointPatterns.some((pattern) => response.url().includes(pattern.replace(/^\\*\\*/, \"\")))) {");
  lines.push("      observedChangedApiResponses.push({ url: response.url(), status: response.status() });");
  lines.push("    }");
  lines.push("  });");
  lines.push("  // Changed API endpoints are observed, not intercepted with synthetic responses, so the draft does not hide the contract under test.");
}

function endpointMatchesAny(endpoint: string, candidates: string[]): boolean {
  const normalizedEndpoint = endpoint.replace(/^\*\*/, "");
  return candidates.some((candidate) => {
    const normalizedCandidate = candidate.replace(/^\*\*/, "");
    return normalizedEndpoint === normalizedCandidate ||
      normalizedEndpoint.endsWith(normalizedCandidate) ||
      normalizedCandidate.endsWith(normalizedEndpoint);
  });
}

function playwrightMockRoutePattern(endpoint: string): string {
  return endpoint.startsWith("/") ? `**${endpoint}` : endpoint;
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
  params: Array<{ name: string; value?: string }>;
}

function buildPlaywrightRouteDraft(route: string, entrypoints: E2eEntrypoint[] = []): PlaywrightRouteDraft {
  const normalizedRoute = route || "/";
  const inferredValues = inferRouteParamValues(normalizedRoute, entrypoints);
  const params: Array<{ name: string; value?: string }> = [];
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
      params.push({ name, value: inferredValues.get(name) });
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

function inferRouteParamValues(route: string, entrypoints: E2eEntrypoint[]): Map<string, string> {
  const routeSegments = route.split("/").filter(Boolean);
  const dynamicSegments = routeSegments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.startsWith(":"));
  if (dynamicSegments.length === 0) {
    return new Map();
  }

  for (const entrypoint of entrypoints) {
    if (entrypoint.kind !== "route" || entrypoint.value === route || entrypoint.value.includes(":")) {
      continue;
    }
    const candidateSegments = entrypoint.value.split("/").filter(Boolean);
    if (candidateSegments.length !== routeSegments.length) {
      continue;
    }
    const values = new Map<string, string>();
    let matches = true;
    for (let index = 0; index < routeSegments.length; index += 1) {
      const routeSegment = routeSegments[index] ?? "";
      const candidateSegment = candidateSegments[index] ?? "";
      if (routeSegment.startsWith(":")) {
        const name = routeSegment.slice(1);
        if (!candidateSegment || candidateSegment.startsWith("[") || candidateSegment.includes(":")) {
          matches = false;
          break;
        }
        values.set(name, decodeURIComponent(candidateSegment));
      } else if (routeSegment !== candidateSegment) {
        matches = false;
        break;
      }
    }
    if (matches && values.size === dynamicSegments.length) {
      return values;
    }
  }
  return new Map();
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
  return `qamap-${readableName || "param"}`;
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
  if (readiness.apiEndpoints.length > 0) {
    evidence.push(`${readiness.apiEndpoints.length} endpoint hint${readiness.apiEndpoints.length === 1 ? "" : "s"}`);
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
    if (plan.executionProfile.blockers.some((blocker) => /No Playwright config/i.test(blocker))) {
      steps.push(playwrightConfigGuidance(plan.executionProfile));
    }
    if (plan.executionProfile.baseUrl) {
      steps.push(`Confirm Playwright baseURL \`${plan.executionProfile.baseUrl}\` points at the target environment.`);
    } else {
      steps.push("Configure baseURL in Playwright before making the specs required in CI.");
    }
    steps.push(plan.executionProfile.startCommand
      ? `Serve the app with \`${plan.executionProfile.startCommand}\`, then run \`${plan.executionProfile.testCommand ?? "npx playwright test"}\`.`
      : `Run \`${plan.executionProfile.testCommand ?? "npx playwright test"}\` after the app can be served locally.`);
  } else {
    steps.push(manualDraftNextStep(plan.project.type));
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

function manualDraftNextStep(projectType: E2eProjectType): string {
  if (projectType === "api-service") {
    return "Document the API contract start command, request examples, response status, response shape, auth behavior, and error handling fixtures before treating the checklist as PR evidence.";
  }
  if (projectType === "design-tokens") {
    return "Document the token validation command, artifact generation command, and representative consumer fixture before treating the checklist as PR evidence.";
  }
  if (projectType === "data-catalog") {
    return "Document the catalog validation command, generation command, and downstream consumer or migration fixture before treating the checklist as PR evidence.";
  }
  if (projectType === "cli") {
    return "Document the CLI command, representative arguments, expected stdout/stderr, generated files, exit codes, and at least one failure case before treating the checklist as PR evidence.";
  }
  return "Choose a runnable E2E framework once the primary app surface is documented.";
}

function playwrightConfigGuidance(profile: E2eExecutionProfile): string {
  if (profile.baseUrl && profile.startCommand) {
    return `Create playwright.config.ts with testDir "./tests/e2e", use.baseURL "${profile.baseUrl}", and webServer.command "${profile.startCommand}" before treating generated specs as required.`;
  }
  if (profile.baseUrl) {
    return `Create playwright.config.ts with testDir "./tests/e2e" and use.baseURL "${profile.baseUrl}", then document the app serve command before treating generated specs as required.`;
  }
  if (profile.startCommand) {
    return `Create playwright.config.ts with a confirmed baseURL and webServer.command "${profile.startCommand}", then run the generated spec locally.`;
  }
  return "Create playwright.config.ts with testDir \"./tests/e2e\", a confirmed baseURL, and a webServer command before treating generated specs as required.";
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

function formatMaestroCommand(command: MaestroDraftCommand): string[] {
  if (command.kind === "comment") {
    return [`# ${command.value}`];
  }
  if (command.kind === "inputText") {
    return [`- tapOn: ${command.target}`, `- inputText: ${command.text}`];
  }
  return [`- ${command.kind}: ${command.value}`];
}

function takeSelectorForStep(selectors: E2eSelector[], step: string): E2eSelector | undefined {
  if (/^launch\b/i.test(step)) {
    return undefined;
  }
  if (isInputStep(step)) {
    const inputIndex = selectors.findIndex((selector) => isInputSelector(selector) && selectorMatchesStep(selector, step));
    if (inputIndex >= 0) {
      const [selector] = selectors.splice(inputIndex, 1);
      return selector;
    }
    const fallbackInputIndex = selectors.findIndex(isInputSelector);
    if (fallbackInputIndex >= 0) {
      const [selector] = selectors.splice(fallbackInputIndex, 1);
      return selector;
    }
  }
  if (!isInteractionStep(step) && !isVerificationStep(step) && !canUsePrimarySelector(step)) {
    return undefined;
  }
  const index = selectors.findIndex((selector) => !isInputSelector(selector) && selectorMatchesStep(selector, step));
  if (index >= 0) {
    const [selector] = selectors.splice(index, 1);
    return selector;
  }
  if (isAssertionStep(step)) {
    const assertionIndex = selectors.findIndex((selector) => selectorCanSupportAssertion(selector));
    if (assertionIndex >= 0) {
      const [selector] = selectors.splice(assertionIndex, 1);
      return selector;
    }
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
  return /^(?:complete|submit|continue|fill|input|enter|upload)\b/i.test(step) ||
    /\bprimary action\b/i.test(step);
}

function selectorCanDriveInteraction(selector: E2eSelector): boolean {
  if (selector.kind === "visible-text") {
    return false;
  }
  return !isPassiveControlLabel(selector.value);
}

function selectorCanSupportAssertion(selector: E2eSelector): boolean {
  return selector.kind !== "placeholder" && !isPassiveControlLabel(selector.value);
}

function isInputSelector(selector: E2eSelector): boolean {
  return selector.kind === "input-test-id" ||
    selector.kind === "input-web-test-id" ||
    selector.kind === "input-accessibility-label" ||
    selector.kind === "input-aria-label" ||
    selector.kind === "placeholder";
}

function isInputStep(step: string): boolean {
  return /\b(?:fill|input|enter|type|provide|write|realistic data)\b/i.test(step);
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
  if (
    selector.kind === "test-id" ||
    selector.kind === "web-test-id" ||
    selector.kind === "input-test-id" ||
    selector.kind === "input-web-test-id"
  ) {
    return `{ id: ${quoteYaml(selector.value)} }`;
  }
  return quoteYaml(selector.value);
}

function playwrightLocator(selector: E2eSelector): string {
  const value = quoteJs(selector.value);
  if (
    selector.kind === "test-id" ||
    selector.kind === "web-test-id" ||
    selector.kind === "input-test-id" ||
    selector.kind === "input-web-test-id"
  ) {
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
  if (
    selector.kind === "accessibility-label" ||
    selector.kind === "aria-label" ||
    selector.kind === "input-accessibility-label" ||
    selector.kind === "input-aria-label"
  ) {
    return `page.getByLabel("${value}")`;
  }
  return `page.getByText("${value}")`;
}

function playwrightActionForStep(selector: E2eSelector, locator: string, step: string): string[] {
  const body = [`// Step intent: ${step}`];
  if (isAssertionStep(step)) {
    body.push(`await expect(${locator}).toBeVisible();`);
    return body;
  }
  if (isInputSelector(selector)) {
    body.push(`await ${locator}.fill("${quoteJs(sampleInputForStepOrSelector(step, selector.value))}");`);
    return body;
  }
  body.push(`await ${locator}.click();`);
  return body;
}

interface ManifestSelectorHint {
  locator: string;
  selectorText: string;
}

function manifestCheckForDraftStep(flow: E2eFlow, step: string): VerificationManifestMatch | undefined {
  const checks = (flow as DraftE2eFlow).manifestCheckMatches ?? [];
  const stepKey = normalizeManifestStepKey(step);
  return checks.find((check) =>
    manifestStepsForCheckMatch(check).some((candidate) => normalizeManifestStepKey(candidate) === stepKey) ||
    normalizeManifestStepKey(check.name) === stepKey ||
    stepKey.includes(normalizeManifestStepKey(check.name)),
  );
}

function playwrightActionForManifestCheck(match: VerificationManifestMatch, step: string): string[] | undefined {
  const instruction = manifestDraftInstruction(match, step);
  const body = [`// Step intent: ${step}`];
  if (instruction.route && isEntrypointPreparationStep(step)) {
    body.push(`await page.goto("${quoteJs(instruction.route)}");`);
    return body;
  }
  if (!instruction.selector) {
    return undefined;
  }
  if (instruction.action === "fill") {
    body.push(`await ${instruction.selector.locator}.fill("${quoteJs(instruction.value ?? sampleInputForStepOrSelector(step, instruction.selector.selectorText))}");`);
    return body;
  }
  if (instruction.action === "assert") {
    body.push(`await expect(${instruction.selector.locator}).toBeVisible();`);
    return body;
  }
  if (instruction.action === "click") {
    body.push(`await ${instruction.selector.locator}.click();`);
    return body;
  }
  return undefined;
}

function manifestDraftInstruction(
  match: VerificationManifestMatch,
  step: string,
): {
  action?: "assert" | "click" | "fill";
  route?: string;
  selector?: ManifestSelectorHint;
  value?: string;
} {
  const text = [step, match.name, ...(match.checks ?? [])].join(" ");
  const selector = selectorHintFromManifestText(match.checkSelector) ?? selectorHintFromManifestText(text);
  const value = match.checkValue ?? sampleValueFromManifestText(text);
  const route = routeFromManifestText(text);
  const action = manifestActionForStep(step, match, selector, value);
  return { action, route, selector, value };
}

function manifestActionForStep(
  step: string,
  match: VerificationManifestMatch,
  selector: ManifestSelectorHint | undefined,
  value: string | undefined,
): "assert" | "click" | "fill" | undefined {
  if (!selector) {
    return undefined;
  }
  if (value || isInputStep(step)) {
    return "fill";
  }
  if (
    isAssertionStep(step) ||
    match.checkType === "failure" ||
    match.checkType === "visual" ||
    /^(?:show|display|render|verify|assert|confirm)\b/i.test(stripTerminalPunctuation(step))
  ) {
    return "assert";
  }
  if (isInteractionStep(step) || canUsePrimarySelector(step)) {
    return "click";
  }
  return undefined;
}

function selectorHintFromManifestText(value: string | undefined): ManifestSelectorHint | undefined {
  if (!value) {
    return undefined;
  }
  const text = value.trim();
  const attribute = text.match(/\[\s*(data-testid|data-test|testid|testID|aria-label|placeholder)\s*=\s*["']?([^"'\]]+)["']?\s*\]/i) ??
    text.match(/\b(data-testid|data-test|testid|testID|aria-label|placeholder)\s*[:=]\s*["']?([^"',\]\s]+(?: [^"',\]]+)*)["']?/i);
  if (attribute) {
    return selectorHintFromAttribute(attribute[1], attribute[2]);
  }
  const role = text.match(/\brole\s*[:=]\s*(button|link)\s*[:=]\s*["']?([^"',\]\s]+(?: [^"',\]]+)*)["']?/i);
  if (role) {
    const roleName = role[1].toLowerCase();
    const label = stripTerminalPunctuation(role[2].trim());
    return {
      locator: `page.getByRole("${quoteJs(roleName)}", { name: "${quoteJs(label)}" })`,
      selectorText: label,
    };
  }
  return undefined;
}

function selectorHintFromAttribute(attributeName: string | undefined, rawValue: string | undefined): ManifestSelectorHint | undefined {
  const value = stripTerminalPunctuation(rawValue?.trim() ?? "");
  if (!value) {
    return undefined;
  }
  const normalizedName = attributeName?.toLowerCase();
  if (normalizedName === "data-testid" || normalizedName === "data-test" || normalizedName === "testid") {
    return { locator: `page.getByTestId("${quoteJs(value)}")`, selectorText: value };
  }
  if (normalizedName === "aria-label") {
    return { locator: `page.getByLabel("${quoteJs(value)}")`, selectorText: value };
  }
  if (normalizedName === "placeholder") {
    return { locator: `page.getByPlaceholder("${quoteJs(value)}")`, selectorText: value };
  }
  return undefined;
}

function sampleValueFromManifestText(value: string): string | undefined {
  const text = value.replace(/\[[^\]]+\]/g, " ");
  const url = text.match(/\bhttps?:\/\/[^\s"'`)]+/i)?.[0];
  if (url) {
    return stripTerminalPunctuation(url);
  }
  const quoted = text.match(/\b(?:with|to|as|value|enter|input|fill|type)\s+(["'`])([^"'`]+)\1/i);
  if (quoted?.[2]) {
    return quoted[2].trim();
  }
  const bare = text.match(/\b(?:with|to|as|value|enter|input|fill|type)\s+([A-Z0-9][A-Z0-9_-]{2,})\b/);
  return bare?.[1];
}

function routeFromManifestText(value: string): string | undefined {
  const text = value.replace(/\bhttps?:\/\/\S+/gi, " ");
  const route = text.match(/(?:^|[\s(])((?!\/\/)\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+)/)?.[1];
  if (!route) {
    return undefined;
  }
  return normalizeEntrypointRoute(stripTerminalPunctuation(route));
}

function normalizeManifestStepKey(value: string): string {
  return stripTerminalPunctuation(value)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function playwrightFallbackActionForStep(step: string): string[] {
  return [
    `// QAMap could not infer a stable locator for this step: ${step}`,
    "// Keep this as a runnable smoke assertion, then replace it with a domain-specific locator when the app exposes one.",
    'await expect(page.locator("body")).toBeVisible();',
  ];
}

function sampleInputForStepOrSelector(step: string, selector: string): string {
  return playwrightSampleInput(`${step} ${selector}`);
}

function playwrightSampleInput(label: string): string {
  if (/\b(?:email|e-mail|메일)\b/i.test(label)) {
    return "qamap@example.com";
  }
  if (/\b(?:url|link|링크|주소)\b/i.test(label)) {
    return "https://example.com/qamap";
  }
  if (/\b(?:code|otp|pin|코드|인증)\b/i.test(label)) {
    return "123456";
  }
  if (/\b(?:name|이름)\b/i.test(label)) {
    return "QAMap Test";
  }
  return "QAMap sample value";
}

function isGestureStep(step: string): boolean {
  return /\b(?:draw|stroke|swipe)\b/i.test(step);
}

function isInteractionStep(step: string): boolean {
  return /^(?:choose|select|open|tap|click|create|save|submit|continue|complete|renew|apply|approve|confirm|send|fill|input|enter|type|provide|return|switch|exercise|activate)\b/i.test(step);
}

function isVerificationStep(step: string): boolean {
  return /\b(?:verify|assert|visible|appears|renders|available|usable|remains|survive)\b/i.test(step);
}

function isAssertionStep(step: string): boolean {
  return isVerificationStep(step);
}

function extractSelectorsFromText(file: string, text: string, runner: E2eRunnerName): E2eSelector[] {
  const selectors: E2eSelector[] = [];
  const canUseWebSelectors = runner === "playwright" || runner === "manual";
  const inputSelectors = [
    ...extractInputAttributeSelectors(file, text, ["testID"], "input-test-id"),
    ...extractInputAttributeSelectors(file, text, ["accessibilityLabel"], "input-accessibility-label"),
  ];

  selectors.push(...inputSelectors);
  selectors.push(
    ...withoutSelectorValueDuplicates(extractAttributeSelectors(file, text, ["testID"], "test-id"), inputSelectors),
    ...withoutSelectorValueDuplicates(
      extractAttributeSelectors(file, text, ["accessibilityLabel"], "accessibility-label"),
      inputSelectors,
    ),
    ...extractAttributeSelectors(file, text, ["placeholder"], "placeholder"),
  );

  if (canUseWebSelectors) {
    const webInputSelectors = [
      ...extractInputAttributeSelectors(file, text, ["data-testid", "data-test"], "input-web-test-id"),
      ...extractInputAttributeSelectors(file, text, ["aria-label"], "input-aria-label"),
    ];
    selectors.push(...webInputSelectors);
    selectors.push(
      ...withoutSelectorValueDuplicates(
        extractAttributeSelectors(file, text, ["data-testid", "data-test"], "web-test-id"),
        webInputSelectors,
      ),
      ...withoutSelectorValueDuplicates(extractAttributeSelectors(file, text, ["aria-label"], "aria-label"), webInputSelectors),
      ...extractRoleSelectorsFromText(file, text),
    );
  }

  selectors.push(...extractTextNodeSelectors(file, text));
  return selectors.filter((selector) => isUsefulSelector(selector.value));
}

function extractInputAttributeSelectors(
  file: string,
  text: string,
  attributes: string[],
  kind: E2eSelectorKind,
): E2eSelector[] {
  const selectors: E2eSelector[] = [];
  const inputElementMatcher = /<(?:TextInput|input|textarea)\b[^>]*>/g;
  for (const elementMatch of text.matchAll(inputElementMatcher)) {
    selectors.push(...extractAttributeSelectors(file, elementMatch[0], attributes, kind));
  }
  return selectors;
}

function withoutSelectorValueDuplicates(selectors: E2eSelector[], existing: E2eSelector[]): E2eSelector[] {
  const existingKeys = new Set(existing.map((selector) => `${selector.file}\0${selector.value}`));
  return selectors.filter((selector) => !existingKeys.has(`${selector.file}\0${selector.value}`));
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

  const htmlTextNodeMatcher = /<(p|span|strong|em|small|label|li|output|h[1-6])\b[^>]*>\s*([^<>{}\n][^<>{}]*)\s*<\/\1>/g;
  for (const match of text.matchAll(htmlTextNodeMatcher)) {
    const value = normalizeSelectorValue(match[2]);
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

interface WorkspaceMemberDependencies {
  directory: string;
  dependencies: Record<string, string>;
  frameworkSignals: string[];
}

const maxWorkspaceMembers = 30;

async function collectWorkspaceMemberDependencies(
  root: string,
  packageJson: PackageJson | undefined,
): Promise<WorkspaceMemberDependencies[]> {
  const patterns = await readWorkspaceMemberPatterns(root, packageJson);
  if (patterns.length === 0) {
    return [];
  }
  const memberDirectories = await expandWorkspaceMemberPatterns(root, patterns);
  const members: WorkspaceMemberDependencies[] = [];
  for (const directory of memberDirectories.slice(0, maxWorkspaceMembers)) {
    const memberPackageJson = await readPackageJson(path.join(root, directory));
    if (!memberPackageJson) {
      continue;
    }
    const dependencies = {
      ...(memberPackageJson.dependencies ?? {}),
      ...(memberPackageJson.devDependencies ?? {}),
    };
    members.push({
      directory,
      dependencies,
      frameworkSignals: frameworkSignalDependencies.filter((dependency) => dependency in dependencies),
    });
  }
  return members;
}

async function readWorkspaceMemberPatterns(root: string, packageJson: PackageJson | undefined): Promise<string[]> {
  const patterns: string[] = [];
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) {
    patterns.push(...workspaces);
  } else if (workspaces?.packages) {
    patterns.push(...workspaces.packages);
  }
  const workspaceYaml = await readTextIfExists(path.join(root, "pnpm-workspace.yaml"));
  if (workspaceYaml) {
    try {
      const parsed = YAML.parse(workspaceYaml) as { packages?: string[] };
      patterns.push(...(parsed?.packages ?? []));
    } catch {
      // ignore unparseable workspace config
    }
  }
  return uniqueStrings(patterns.filter((pattern) => typeof pattern === "string" && !pattern.startsWith("!")));
}

async function expandWorkspaceMemberPatterns(root: string, patterns: string[]): Promise<string[]> {
  const directories: string[] = [];
  for (const pattern of patterns) {
    const normalized = pattern.replace(/\/\*{1,2}$/, "");
    if (normalized.includes("*")) {
      continue;
    }
    if (normalized === pattern) {
      directories.push(normalized);
      continue;
    }
    try {
      const entries = await fs.readdir(path.join(root, normalized), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          directories.push(`${normalized}/${entry.name}`);
        }
      }
    } catch {
      continue;
    }
  }
  return uniqueStrings(directories);
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
  if (
    kind === "input-test-id" ||
    kind === "input-web-test-id" ||
    kind === "input-accessibility-label" ||
    kind === "input-aria-label" ||
    kind === "placeholder"
  ) {
    return 0;
  }
  if (kind === "test-id" || kind === "web-test-id") {
    return 1;
  }
  if (kind === "accessibility-label" || kind === "aria-label") {
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
