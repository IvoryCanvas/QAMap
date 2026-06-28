import { promises as fs } from "node:fs";
import path from "node:path";
import { generateTestPlan } from "./test-plan.js";
import type { TestPlanChangedFile, TestPlanOptions } from "./test-plan.js";
import { TOOL_NAME, VERSION } from "./version.js";

export type E2eProjectType = "expo-react-native" | "react-native" | "web" | "unknown";
export type E2eRunnerName = "maestro" | "playwright" | "manual";
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

export interface E2eFlow {
  title: string;
  reason: string;
  files: string[];
  steps: string[];
  selectors: E2eSelector[];
  missingTestability: string[];
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
  changedFiles: TestPlanChangedFile[];
  suggestedCommands: string[];
  flows: E2eFlow[];
  missingTestability: string[];
  setupNotes: string[];
}

export interface E2eDraftFile {
  path: string;
  flowTitle: string;
  runner: E2eRunnerName;
  status: "created" | "skipped";
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
  const flows = await buildFlows(root, testPlan.changedFiles, recommendedRunner.name);
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
  const flows = plan.flows.length > 0 ? plan.flows : [buildFallbackFlow(plan)];

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
        reason: "File already exists. Pass --force to overwrite it.",
      });
      continue;
    }
    await fs.writeFile(filePath, draftContentForFlow(plan, flow, runner), "utf8");
    files.push({
      path: displayPath,
      flowTitle: flow.title,
      runner,
      status: "created",
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
  lines.push(`- Changed files considered: ${result.changedFiles.length}`);
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
    const suffix = file.reason ? ` - ${file.reason}` : "";
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

async function buildFlows(root: string, changedFiles: TestPlanChangedFile[], runner: E2eRunnerName): Promise<E2eFlow[]> {
  const files = changedFiles.map((file) => file.path);
  const flows = [
    await buildFlow(root, runner, {
      title: "Ink drawing capture flow",
      reason: "Drawing, sketch, or canvas-related files changed, so the primary drawing path needs a runnable smoke flow.",
      files: files.filter((file) => /(?:ink|draw|drawing|canvas|sketch)/i.test(file)),
      steps: [
        "Launch the app and open the record entry point.",
        "Choose the drawing or ink record mode.",
        "Draw at least one stroke on the canvas.",
        "Select the required emotion or depth controls.",
        "Save the entry and verify that the saved result appears in the next screen.",
      ],
    }),
    await buildFlow(root, runner, {
      title: "Record mode selection flow",
      reason: "Home, route, or record mode UI changed, so the entry-point choice should be covered before deeper flows run.",
      files: files.filter((file) => /(?:home|record|mode|route|layout|navigation|_layout)/i.test(file)),
      steps: [
        "Launch the app on a clean state.",
        "Open the main record action from the home screen.",
        "Choose each visible record mode at least once.",
        "Verify the selected mode opens the expected next screen.",
      ],
    }),
    await buildFlow(root, runner, {
      title: "Saved entry persistence flow",
      reason: "State, context, storage, service, or report files changed, so a saved entry should survive the user path that reads it back.",
      files: files.filter((file) => /(?:context|store|state|storage|service|report)/i.test(file)),
      steps: [
        "Create a realistic entry through the UI.",
        "Save the entry.",
        "Return to the home or report surface.",
        "Verify the saved entry is visible with the expected content.",
        "Restart or refresh the app if the project supports it, then verify the entry is still available.",
      ],
    }),
    await buildFlow(root, runner, {
      title: "Localized visual smoke flow",
      reason: "Theme or i18n files changed, so the E2E draft should include a quick visual and text smoke pass.",
      files: files.filter((file) => /(?:theme|i18n|locale|translation|copy|styles?)/i.test(file)),
      steps: [
        "Launch the app with the default locale and theme.",
        "Open the changed screen.",
        "Verify primary text, buttons, and visual states are present.",
        "Switch locale or theme if the app exposes that control, then repeat the changed screen smoke path.",
      ],
    }),
    await buildFlow(root, runner, {
      title: "Changed UI smoke flow",
      reason: "User-facing UI files changed, so the first generated E2E should at least open the touched surface.",
      files: files.filter(isUserFacingFile),
      steps: [
        "Launch the app.",
        "Navigate to the changed screen or component surface.",
        "Exercise the primary visible action.",
        "Verify loading, empty, error, and success states when they are reachable.",
      ],
    }),
  ].filter((flow): flow is E2eFlow => Boolean(flow));

  return dedupeFlows(flows).slice(0, 4);
}

async function buildFlow(
  root: string,
  runner: E2eRunnerName,
  candidate: Omit<E2eFlow, "selectors" | "missingTestability">,
): Promise<E2eFlow | undefined> {
  const files = uniqueStrings(candidate.files).slice(0, 20);
  if (files.length === 0) {
    return undefined;
  }
  return {
    ...candidate,
    files,
    selectors: await inferFlowSelectors(root, files, runner),
    missingTestability: await findFlowTestabilityGaps(root, files, runner),
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
  return (
    /(?:^|\/)(app|pages|routes|screens|components|ui|navigation)\//i.test(file) ||
    /\.(?:tsx|jsx|vue|svelte)$/i.test(file)
  );
}

function isUiImplementationFile(file: string): boolean {
  return /\.(?:tsx|jsx|vue|svelte)$/i.test(file);
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
  return /\b(?:testID|accessibilityLabel)=/.test(text);
}

function selectorName(runner: E2eRunnerName): string {
  return runner === "playwright" ? "data-testid or accessible role" : "testID or accessibilityLabel";
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

function buildFallbackFlow(plan: E2ePlanResult): E2eFlow {
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
  lines.push(`# Generated by CodeWard ${VERSION}`);
  lines.push(`# Flow: ${flow.title}`);
  lines.push(`# Base: ${plan.base}`);
  lines.push(`# Head: ${plan.head}`);
  lines.push("# Replace ${APP_ID} with the app id or export APP_ID before running Maestro.");
  lines.push("");
  lines.push("appId: ${APP_ID}");
  lines.push("---");
  lines.push("- launchApp");
  for (const step of flow.steps) {
    const command = maestroCommandForStep(step, selectorQueue);
    lines.push(...formatMaestroCommand(command));
  }
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
  const lines: string[] = [];
  lines.push(`// Generated by CodeWard ${VERSION}`);
  lines.push(`// Base: ${plan.base}`);
  lines.push(`// Head: ${plan.head}`);
  lines.push(`// Flow: ${flow.title}`);
  lines.push("");
  lines.push('import { expect, test } from "@playwright/test";');
  lines.push("");
  lines.push(`test("${testName}", async ({ page }) => {`);
  lines.push('  await page.goto("/");');
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
  const lines: string[] = [];
  lines.push(`# ${flow.title}`);
  lines.push("");
  lines.push(`Generated by CodeWard ${VERSION}.`);
  lines.push("");
  lines.push(`- Base: \`${plan.base}\``);
  lines.push(`- Head: \`${plan.head}\``);
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  for (const step of flow.steps) {
    lines.push(`- [ ] ${step}`);
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
    return selectors.shift();
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
  const isWebRunner = runner === "playwright";

  selectors.push(
    ...extractAttributeSelectors(file, text, ["testID"], "test-id"),
    ...extractAttributeSelectors(file, text, ["accessibilityLabel"], "accessibility-label"),
    ...extractAttributeSelectors(file, text, ["placeholder"], "placeholder"),
  );

  if (isWebRunner) {
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

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}
