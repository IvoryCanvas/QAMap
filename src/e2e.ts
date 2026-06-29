import { promises as fs } from "node:fs";
import path from "node:path";
import { buildDomainLanguageSummary } from "./domain-language.js";
import { loadCoreFlowManifest, matchCoreFlows } from "./flows.js";
import {
  collectTestSuiteInventory,
  evaluateFlowCoverageEvidence,
  summarizeTestSuiteInventory,
} from "./test-evidence.js";
import { generateTestPlan } from "./test-plan.js";
import type { TestPlanChangedFile, TestPlanOptions } from "./test-plan.js";
import type { DomainLanguageSummary, DomainScenarioSuggestion } from "./domain-language.js";
import type { MatchedCoreFlow } from "./flows.js";
import type { LocalHistoryReference } from "./history.js";
import type { CoverageEvidence, TestSuiteInventory, TestSuiteSummary } from "./test-evidence.js";
import { TOOL_NAME, VERSION } from "./version.js";

export type E2eProjectType = "expo-react-native" | "react-native" | "web" | "unknown";
export type E2eRunnerName = "maestro" | "playwright" | "manual";
export type E2eEntrypointKind = "route" | "screen" | "command";
export type E2eEntrypointConfidence = "high" | "medium" | "low";
export type E2eSetupHintKind = "auth" | "network" | "fixture" | "environment" | "payment" | "state";
export type E2eSetupHintConfidence = "high" | "medium" | "low";
export type E2eSelectorKind =
  | "test-id"
  | "accessibility-label"
  | "visible-text"
  | "web-test-id"
  | "aria-label"
  | "placeholder";

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

export type E2eCoveragePriority = "critical" | "recommended" | "optional";

export interface E2eCoverageTarget {
  title: string;
  priority: E2eCoveragePriority;
  reason: string;
  checks: string[];
}

export interface E2eFlow {
  title: string;
  reason: string;
  files: string[];
  steps: string[];
  coverage: E2eCoverageTarget[];
  coverageEvidence: CoverageEvidence[];
  entrypoints: E2eEntrypoint[];
  setupHints: E2eSetupHint[];
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
  testSuite: TestSuiteSummary;
  coreFlowManifestPath?: string;
  coreFlows: MatchedCoreFlow[];
  domainLanguage: DomainLanguageSummary;
  changedFiles: TestPlanChangedFile[];
  suggestedCommands: string[];
  localHistory?: LocalHistoryReference;
  flows: E2eFlow[];
  missingTestability: string[];
  setupNotes: string[];
}

export interface E2eDraftFile {
  path: string;
  flowTitle: string;
  runner: E2eRunnerName;
  status: "created" | "skipped";
  source?: "domain-language" | "core-flow" | "heuristic";
  stability?: "ready" | "needs-selector" | "needs-setup" | "needs-selector-and-setup";
  todoCount?: number;
  entrypointCount?: number;
  primaryEntrypoint?: string;
  setupHintCount?: number;
  inferredSelectorCount?: number;
  coverageTargetCount?: number;
  reason?: string;
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
  plan: E2ePlanResult;
  files: E2eDraftFile[];
  nextSteps: string[];
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const maxFilesPerFlow = 8;

export async function generateE2ePlan(rootInput: string, options: E2ePlanOptions = {}): Promise<E2ePlanResult> {
  const root = path.resolve(rootInput);
  const testPlan = await generateTestPlan(root, options);
  const project = await detectProjectProfile(root);
  const recommendedRunner = options.runner ? overrideRunner(project, options.runner) : recommendRunner(project);
  const testSuiteInventory = await collectTestSuiteInventory(root);
  const coreFlowRoot = testPlan.workspaceRoot ?? root;
  const coreFlowManifest = await loadCoreFlowManifest(coreFlowRoot);
  const coreFlowChangedFiles = toCoreFlowChangedFiles(testPlan.changedFiles, root, coreFlowRoot);
  const coreFlows = matchCoreFlows(coreFlowManifest, coreFlowChangedFiles);
  const domainLanguage = await buildDomainLanguageSummary(root, testPlan.changedFiles, coreFlows);
  const flows = await buildFlows(root, testPlan.changedFiles, recommendedRunner.name, project.type, testSuiteInventory);
  const missingTestability = uniqueStrings([
    ...flows.flatMap((flow) => flow.missingTestability),
    ...(await buildGlobalTestabilityGaps(root, recommendedRunner.name)),
  ]);

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
    testSuite: summarizeTestSuiteInventory(testSuiteInventory),
    coreFlowManifestPath: coreFlowManifest.path,
    coreFlows,
    domainLanguage,
    changedFiles: testPlan.changedFiles,
    suggestedCommands: testPlan.suggestedCommands,
    flows,
    missingTestability,
    setupNotes: await buildSetupNotes(root, recommendedRunner.name, project),
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
    if ((await exists(filePath)) && !options.force) {
      files.push({
        path: displayPath,
        flowTitle: flow.title,
        runner,
        status: "skipped",
        source: draftFlowSource(flow),
        stability: draftStability(plan, flow),
        entrypointCount: flow.entrypoints.length,
        primaryEntrypoint: primaryEntrypointLabel(flow),
        setupHintCount: flow.setupHints.length,
        coverageTargetCount: flow.coverage.length,
        reason: "File already exists. Pass --force to overwrite it.",
      });
      continue;
    }
    const content = draftContentForFlow(plan, flow, runner);
    await fs.writeFile(filePath, content, "utf8");
    files.push({
      path: displayPath,
      flowTitle: flow.title,
      runner,
      status: "created",
      source: draftFlowSource(flow),
      stability: draftStability(plan, flow),
      todoCount: countTodos(content),
      entrypointCount: flow.entrypoints.length,
      primaryEntrypoint: primaryEntrypointLabel(flow),
      setupHintCount: flow.setupHints.length,
      inferredSelectorCount: flow.selectors.length,
      coverageTargetCount: flow.coverage.length,
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
  lines.push(`- Matched core flows: ${result.coreFlows.length}`);
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
      lines.push("");
    }
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

  lines.push("## Files");
  lines.push("");
  for (const file of result.files) {
    const quality = formatDraftFileQuality(file);
    const suffix = file.reason ? ` - ${file.reason}` : quality ? ` - ${quality}` : "";
    lines.push(`- ${file.status}: \`${escapeMarkdownInline(file.path)}\` (${escapeMarkdownInline(file.flowTitle)})${suffix}`);
  }
  lines.push("");

  if (result.plan.missingTestability.length > 0) {
    lines.push("## Testability Gaps");
    lines.push("");
    for (const gap of result.plan.missingTestability) {
      lines.push(`- ${escapeMarkdownInline(gap)}`);
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
  const hasWebDependency =
    "next" in dependencies || "vite" in dependencies || "react-dom" in dependencies || hasPlaywrightDependency;
  const hasExpoConfig = await hasAnyFile(root, ["app.json", "app.config.js", "app.config.ts"]);
  const hasNativeDirs = (await exists(path.join(root, "ios"))) || (await exists(path.join(root, "android")));

  if (hasExpoDependency) {
    evidence.push("package.json dependency: expo");
  }
  if (hasReactNativeDependency) {
    evidence.push("package.json dependency: react-native");
  }
  if (hasPlaywrightDependency) {
    evidence.push("package.json dependency: Playwright");
  }
  if (hasExpoConfig) {
    evidence.push("Expo app configuration file found");
  }
  if (hasNativeDirs) {
    evidence.push("ios/ or android/ directory found");
  }

  if (hasExpoDependency || (hasExpoConfig && hasReactNativeDependency)) {
    return { type: "expo-react-native", evidence };
  }
  if (hasReactNativeDependency || hasNativeDirs) {
    return { type: "react-native", evidence };
  }
  if (hasWebDependency) {
    return { type: "web", evidence };
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
  "coverage" | "coverageEvidence" | "entrypoints" | "setupHints" | "selectors" | "missingTestability"
> & {
  kind: E2eFlowKind;
};
type DraftFlowSource = "domain-language" | "core-flow" | "heuristic";
type DraftE2eFlow = E2eFlow & {
  draftSource?: DraftFlowSource;
  domainScenario?: DomainScenarioSuggestion;
};

async function buildFlows(
  root: string,
  changedFiles: TestPlanChangedFile[],
  runner: E2eRunnerName,
  projectType: E2eProjectType,
  testSuiteInventory: TestSuiteInventory,
): Promise<E2eFlow[]> {
  const files = changedFiles.map((file) => file.path);
  const flowResults = await Promise.all(
    buildFlowCandidates(files, runner, projectType).map((candidate) =>
      buildFlow(root, runner, candidate, testSuiteInventory),
    ),
  );
  const flows = flowResults.filter((flow): flow is E2eFlow => Boolean(flow));

  return dedupeFlows(flows).slice(0, 4);
}

function buildFlowCandidates(files: string[], runner: E2eRunnerName, projectType: E2eProjectType): FlowCandidate[] {
  const behaviorFiles = files.filter((file) => !isTestLikeFile(file));
  const candidateFiles = behaviorFiles.length > 0 ? behaviorFiles : files;
  const uiFiles = candidateFiles.filter(isUserFacingFile);
  const apiFiles = candidateFiles.filter(isApiLikeFile);
  const stateFiles = candidateFiles.filter(isStateLikeFile);
  const contentFiles = candidateFiles.filter(isContentOrStyleFile);
  const configFiles = candidateFiles.filter(isConfigLikeFile);
  const domainFiles = candidateFiles.filter(isDomainOwnedFile);
  const candidates: FlowCandidate[] = [];

  if (uiFiles.length > 0) {
    const subject = summarizeFlowSubject(uiFiles, "Changed");
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

  if (apiFiles.length > 0) {
    const subject = summarizeFlowSubject(apiFiles, "Changed");
    candidates.push({
      kind: "api",
      title: `${subject} API contract smoke ${runner === "manual" ? "checklist" : "flow"}`,
      reason: "API client, schema, endpoint, request, or response files changed, so the generated draft should verify contract shape and failure handling before relying on UI-only coverage.",
      files: apiFiles,
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
    const subject = summarizeFlowSubject(stateFiles, "Changed");
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
    const subject = summarizeFlowSubject(contentFiles, "Changed");
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
    const subject = summarizeFlowSubject(configFiles, "Changed");
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
    const subject = summarizeFlowSubject(remainingDomainFiles, "Changed domain");
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
      title: `${summarizeFlowSubject(candidateFiles, "Changed-file")} smoke ${runner === "manual" ? "checklist" : "flow"}`,
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
): Promise<E2eFlow | undefined> {
  const files = uniqueStrings(candidate.files).slice(0, 20);
  if (files.length === 0) {
    return undefined;
  }
  const coverage = buildCoverageTargets(candidate.kind, files, runner);
  return {
    title: candidate.title,
    reason: candidate.reason,
    files,
    steps: candidate.steps,
    coverage,
    coverageEvidence: evaluateFlowCoverageEvidence({ title: candidate.title, files, coverage }, testSuiteInventory),
    entrypoints: await inferFlowEntrypoints(root, files, runner),
    setupHints: await inferFlowSetupHints(root, files, candidate.kind),
    selectors: await inferFlowSelectors(root, files, runner),
    missingTestability: await findFlowTestabilityGaps(root, files, runner),
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

  const leaf = stripKnownExtension(rawRouteSegments.at(-1) ?? "");
  const confidence =
    appIndex >= 0 || /^(?:index|page|route)$/i.test(leaf) || /Page$/i.test(leaf) ? "high" : "medium";
  return { value, confidence };
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
    return `:${slugify(dynamic)}`;
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
  return /(?:package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb|pyproject\.toml|requirements\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|gradle\.properties|vite|webpack|babel|tsconfig|next\.config|app\.config|eas\.json|docker|env|feature-?flags?|experiments?)/i.test(
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

function summarizeFlowSubject(files: string[], fallback: string): string {
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

function isMeaningfulLabel(value: string): boolean {
  const normalized = value.toLowerCase();
  const ignored = new Set([
    "api",
    "apis",
    "app",
    "apps",
    "client",
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
    "env",
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
    "production",
    "provider",
    "providers",
    "route",
    "routes",
    "screen",
    "screens",
    "server",
    "service",
    "services",
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
  const baseFlow = bestBaseFlowForScenario(scenario, baseFlows);
  const files = uniqueStrings(scenario.files.length > 0 ? scenario.files : (baseFlow?.files ?? [])).slice(0, 20);
  const coverage = baseFlow?.coverage ?? buildCoverageTargets("domain", files, plan.recommendedRunner.name);
  const runner = plan.recommendedRunner.name;
  const entrypoints = uniqueEntrypoints([
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
  return {
    title: scenario.title,
    reason: scenario.intent,
    files,
    steps: scenario.checks.length > 0 ? scenario.checks : (baseFlow?.steps ?? []),
    coverage,
    coverageEvidence: baseFlow?.coverageEvidence ?? [],
    entrypoints,
    setupHints,
    selectors,
    missingTestability: await findFlowTestabilityGaps(plan.root, files, runner),
    draftSource: scenario.source === "core-flow" ? "core-flow" : "domain-language",
    domainScenario: scenario,
  };
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

function buildFallbackFlow(plan: E2ePlanResult): E2eFlow {
  const coverage = buildCoverageTargets("changed-file", [], plan.recommendedRunner.name);
  return {
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
    selectors: [],
    missingTestability: plan.missingTestability,
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
  lines.push("# Replace ${APP_ID} with the app id or export APP_ID before running Maestro.");
  lines.push("");
  lines.push("appId: ${APP_ID}");
  lines.push("---");
  lines.push("- launchApp");
  appendEntrypointHints(lines, flow, "#");
  appendSetupHints(lines, flow, "#");
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
  lines.push("");
  lines.push('import { expect, test } from "@playwright/test";');
  lines.push("");
  lines.push(`test("${testName}", async ({ page }) => {`);
  appendEntrypointHints(lines, flow, "  //");
  appendSetupHints(lines, flow, "  //");
  const routeEntrypoint = primaryRouteEntrypoint(flow);
  lines.push(`  await page.goto("${quoteJs(routeEntrypoint?.value ?? "/")}");`);
  for (const step of flow.steps) {
    const selector = takeSelectorForStep(selectorQueue, step);
    const locator = selector ? playwrightLocator(selector) : 'page.getByText("TODO")';
    lines.push(`  // TODO: ${step}`);
    if (isVerificationStep(step) && !isInteractionStep(step)) {
      lines.push(`  await expect(${locator}).toBeVisible();`);
    } else {
      lines.push(`  await ${locator}.click();`);
    }
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

function formatEntrypoint(entrypoint: E2eEntrypoint): string {
  return `${entrypoint.kind} ${entrypoint.value} [${entrypoint.confidence}] (${entrypoint.file})`;
}

function formatSetupHint(hint: E2eSetupHint): string {
  const files = hint.files.length > 0 ? ` (${hint.files.slice(0, 3).join(", ")})` : "";
  return `[${hint.kind}, ${hint.confidence}] ${hint.title}: ${hint.detail}${files}`;
}

function buildDraftNextSteps(plan: E2ePlanResult, runner: E2eRunnerName): string[] {
  const steps: string[] = [];
  if (runner === "maestro") {
    steps.push("Replace ${APP_ID} or export APP_ID before running Maestro.");
    steps.push("Replace TODO text selectors with visible copy, testID, or accessibilityLabel selectors.");
    steps.push("Run the app with the launch command that matches your simulator or device, then run `maestro test .maestro`.");
  } else if (runner === "playwright") {
    steps.push("Replace TODO locators with role, text, or data-testid locators from the app.");
    steps.push("Configure baseURL in Playwright before making the specs required in CI.");
    steps.push("Run `npx playwright test` after the app can be served locally.");
  } else {
    steps.push("Choose a runnable E2E framework once the primary app surface is documented.");
  }
  if (plan.missingTestability.length > 0) {
    steps.push("Address the listed testability gaps before treating the generated drafts as stable regression tests.");
  }
  return steps;
}

function formatDraftFileQuality(file: E2eDraftFile): string | undefined {
  const details: string[] = [];
  if (file.source !== undefined) {
    details.push(file.source);
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
  if (selector.kind === "accessibility-label" || selector.kind === "aria-label" || selector.kind === "placeholder") {
    return `page.getByLabel("${value}")`;
  }
  return `page.getByText("${value}")`;
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
  return 3;
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
