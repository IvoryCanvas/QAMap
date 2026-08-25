import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import {
  isBenchmarkRevisionFixturePath,
  isBenchmarkValidationStructurePath,
  isRepositoryBenchmarkScript,
} from "./benchmark-paths.js";
import { collectProjectFiles } from "./fs.js";
import { collectChangedFiles, resolveBaseRef, resolveMergeBase } from "./git-context.js";
import type { BaseRefResolution } from "./git-context.js";
import { TOOL_NAME, VERSION } from "./version.js";

const execFileAsync = promisify(execFile);

export interface TestPlanOptions {
  base?: string;
  head?: string;
  workspaceRoot?: string;
  includeWorkingTree?: boolean;
  validationCommands?: string[];
}

export interface TestPlanChangedFile {
  status: string;
  path: string;
  previousPath?: string;
}

export interface TestPlanItem {
  title: string;
  reason: string;
  files: string[];
  checks: string[];
}

export interface TestPlanResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  workspaceRoot?: string;
  generatedAt: string;
  base: string;
  baseResolution: BaseRefResolution;
  head: string;
  includeWorkingTree: boolean;
  changedFiles: TestPlanChangedFile[];
  suggestedCommands: string[];
  items: TestPlanItem[];
}

const maxFilesPerItem = 6;

export async function generateTestPlan(rootInput: string, options: TestPlanOptions = {}): Promise<TestPlanResult> {
  const root = path.resolve(rootInput);
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  const gitRoot = workspaceRoot ?? root;
  const relativeRoot = workspaceRoot ? toPosixPath(path.relative(workspaceRoot, root)) : "";
  if (workspaceRoot && (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot))) {
    throw new Error(`Test plan path must be inside workspace root: ${root}`);
  }

  const head = options.head ?? "HEAD";
  const baseResolution = await resolveBaseRef(gitRoot, { explicit: options.base, head });
  const base = baseResolution.ref;
  const includeWorkingTree = options.includeWorkingTree ?? false;
  const changedFiles = scopeChangedFiles(
    await collectChangedFiles(gitRoot, { base, head, includeWorkingTree }),
    relativeRoot,
  );
  const suggestedCommands = uniqueCommands([
    ...normalizeValidationCommands(options.validationCommands),
    ...commandsForChangedTestEvidence(changedFiles),
    ...(await discoverSuggestedCommands(root, workspaceRoot, changedFiles)),
  ]);
  const items = buildPlanItems(changedFiles);

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root,
    workspaceRoot,
    generatedAt: new Date().toISOString(),
    base,
    baseResolution,
    head,
    includeWorkingTree,
    changedFiles,
    suggestedCommands,
    items,
  };
}

export function formatMarkdownTestPlan(result: TestPlanResult): string {
  const lines: string[] = [];
  lines.push("# QAMap Test Plan");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  if (result.workspaceRoot) {
    lines.push(`- Workspace root: \`${escapeMarkdownInline(result.workspaceRoot)}\``);
  }
  lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
  lines.push(`- Base selection: ${escapeMarkdownInline(result.baseResolution.reason)}`);
  lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
  if (result.includeWorkingTree) {
    lines.push("- Includes working tree changes: yes");
  }
  lines.push(`- Changed files considered: ${result.changedFiles.length}`);
  lines.push("");

  if (result.suggestedCommands.length > 0) {
    lines.push("## Suggested Commands");
    lines.push("");
    for (const command of result.suggestedCommands) {
      lines.push(`- \`${escapeMarkdownInline(command)}\``);
    }
    lines.push("");
  }

  lines.push("## Suggested Domain Tests");
  lines.push("");
  if (result.items.length === 0) {
    lines.push("No changed files were detected for a domain test plan.");
    lines.push("");
    return lines.join("\n");
  }

  for (const [index, item] of result.items.entries()) {
    lines.push(`### ${index + 1}. ${escapeMarkdownInline(item.title)}`);
    lines.push("");
    lines.push(item.reason);
    lines.push("");
    lines.push("Files:");
    for (const file of item.files.slice(0, maxFilesPerItem)) {
      lines.push(`- \`${escapeMarkdownInline(file)}\``);
    }
    if (item.files.length > maxFilesPerItem) {
      lines.push(`- ... ${item.files.length - maxFilesPerItem} more`);
    }
    lines.push("");
    lines.push("Checks:");
    for (const check of item.checks) {
      lines.push(`- ${check}`);
    }
    lines.push("");
  }

  lines.push("## Changed Files");
  lines.push("");
  for (const file of result.changedFiles.slice(0, 30)) {
    const renameSuffix = file.previousPath ? ` from \`${escapeMarkdownInline(file.previousPath)}\`` : "";
    lines.push(`- \`${file.status}\` \`${escapeMarkdownInline(file.path)}\`${renameSuffix}`);
  }
  if (result.changedFiles.length > 30) {
    lines.push(`- ... ${result.changedFiles.length - 30} more`);
  }
  lines.push("");

  return lines.join("\n");
}

function buildPlanItems(changedFiles: TestPlanChangedFile[]): TestPlanItem[] {
  const files = changedFiles.map((file) => file.path);
  const items = [
    buildWorkflowItem(files),
    buildUiItem(files),
    buildApiItem(files),
    buildDomainConfigItem(files),
    buildStateItem(files),
    buildConfigItem(files),
    buildTestCoverageItem(files),
  ].filter((item): item is TestPlanItem => Boolean(item));

  if (items.length > 0) {
    return items;
  }

  if (changedFiles.length === 0) {
    return [];
  }

  return [
    {
      title: "Changed-file smoke path",
      reason: "The branch changes files that do not match a specialized domain pattern.",
      files: files.slice(0, maxFilesPerItem),
      checks: [
        "Run the nearest automated test command for the touched package.",
        "Exercise the primary user or maintainer workflow that imports the changed files.",
        "Check error, empty, and permission-denied states if the changed code is user-facing.",
      ],
    },
  ];
}

function buildWorkflowItem(files: string[]): TestPlanItem | undefined {
  const matched = files.filter((file) => /(?:^|\/)(features|domains|modules|services)\/[^/]+/i.test(file));
  if (matched.length === 0) {
    return undefined;
  }
  const domains = summarizeDomains(matched);
  return {
    title: `${domains} workflow regression`,
    reason: "Feature or domain-owned files changed, so reviewers should verify the end-to-end business path.",
    files: matched,
    checks: [
      "Verify the happy path for the affected domain from entry point to completion.",
      "Verify at least one blocked, rejected, or invalid-state path.",
      "Verify persistence or navigation after refresh, back navigation, or re-entry.",
    ],
  };
}

function buildUiItem(files: string[]): TestPlanItem | undefined {
  const matched = files.filter((file) =>
    /(?:^|\/)(pages|app|routes|screens|components|navigations?)\//i.test(file) || /\.(tsx|jsx|vue|svelte)$/i.test(file),
  );
  if (matched.length === 0) {
    return undefined;
  }
  return {
    title: "User-facing UI states",
    reason: "User-facing route, screen, navigation, or component files changed.",
    files: matched,
    checks: [
      "Render the affected view with realistic production-like data.",
      "Verify loading, empty, error, and success states.",
      "Check the smallest supported viewport and the primary desktop viewport for layout regressions.",
    ],
  };
}

function buildApiItem(files: string[]): TestPlanItem | undefined {
  const matched = files.filter((file) =>
    /(?:api|apis|client|clients|queries|mutations|graphql|trpc|rpc|proto|openapi|swagger|endpoint|request|response)/i.test(
      file,
    ),
  );
  if (matched.length === 0) {
    return undefined;
  }
  return {
    title: "API contract and failure handling",
    reason: "API client, schema, request, response, or endpoint-related files changed.",
    files: matched,
    checks: [
      "Verify request parameters, response shape, and type generation or parsing.",
      "Verify 4xx, 5xx, timeout, and network-failure handling.",
      "Check backward compatibility for existing callers or clients.",
    ],
  };
}

function buildDomainConfigItem(files: string[]): TestPlanItem | undefined {
  const matched = files.filter((file) =>
    /(?:^|\/)(features|domains|modules|services)\/[^/]+\/(?:config|configs)\//i.test(file),
  );
  if (matched.length === 0) {
    return undefined;
  }
  return {
    title: "Domain configuration and variants",
    reason: "Domain-owned configuration files changed, so variant-specific behavior should be verified.",
    files: matched,
    checks: [
      "Verify each new or changed configuration branch maps to the expected domain variant.",
      "Verify fallback behavior when the configuration key is absent, disabled, or unknown.",
      "Check copy, visibility, analytics, and navigation that depend on the configuration.",
    ],
  };
}

function buildStateItem(files: string[]): TestPlanItem | undefined {
  const matched = files.filter((file) =>
    /(?:^|\/)(stores?|states?|reducers?|atoms?|selectors?|contexts?|providers?|cache|session|auth|permissions?|guards?)\//i.test(
      file,
    ) || /(?:^|\/)[^/]*(?:auth|permission|session|cache|guard)[^/]*\.[cm]?[jt]sx?$/i.test(file),
  );
  if (matched.length === 0) {
    return undefined;
  }
  return {
    title: "State, auth, and permission transitions",
    reason: "State management, auth, permission, cache, or provider files changed.",
    files: matched,
    checks: [
      "Verify state transitions before and after the changed action.",
      "Verify unauthorized, expired-session, and permission-denied behavior.",
      "Verify cached data is invalidated or preserved intentionally.",
    ],
  };
}

function buildConfigItem(files: string[]): TestPlanItem | undefined {
  const matched = files.filter((file) =>
    /(?:package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|pyproject\.toml|requirements\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|gradle\.properties|vite|webpack|babel|tsconfig|next\.config|app\.config|eas\.json|docker|env)/i.test(
      file,
    ),
  );
  if (matched.length === 0) {
    return undefined;
  }
  return {
    title: "Build, runtime, and environment configuration",
    reason: "Dependency, build, runtime, or environment configuration changed.",
    files: matched,
    checks: [
      "Run install or lockfile validation in a clean checkout.",
      "Run build and typecheck for the affected package.",
      "Verify required environment variables and defaults for local, staging, and production-like runs.",
    ],
  };
}

function buildTestCoverageItem(files: string[]): TestPlanItem | undefined {
  const matched = files.filter((file) =>
    isTestLikeFile(file) && !isBenchmarkRevisionFixturePath(file)
  );
  if (matched.length === 0) {
    return undefined;
  }
  return {
    title: "Test coverage integrity",
    reason: "Test files changed, so the test suite itself needs a sanity check.",
    files: matched,
    checks: [
      "Run the changed tests alone and as part of the nearest suite.",
      "Check that assertions fail for the right reason by reviewing the behavior under test.",
      "Avoid snapshot-only coverage for new domain behavior unless paired with explicit assertions.",
    ],
  };
}

async function discoverSuggestedCommands(
  root: string,
  workspaceRoot: string | undefined,
  changedFiles: TestPlanChangedFile[],
): Promise<string[]> {
  const commandGroups = await Promise.all([
    discoverJavaScriptCommands(root, workspaceRoot, changedFiles),
    discoverPythonCommands(root, changedFiles),
    discoverGoCommands(root),
    discoverRustCommands(root),
    discoverJvmCommands(root),
  ]);
  return uniqueCommands(commandGroups.flat());
}

async function discoverJavaScriptCommands(
  root: string,
  workspaceRoot: string | undefined,
  changedFiles: TestPlanChangedFile[],
): Promise<string[]> {
  const packageJsonPath = path.join(root, "package.json");
  let parsed: { packageManager?: string; scripts?: Record<string, string>; workspaces?: unknown };
  try {
    parsed = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      packageManager?: string;
      scripts?: Record<string, string>;
      workspaces?: unknown;
    };
  } catch {
    return [];
  }

  const packageManager = await detectPackageManager(root, parsed.packageManager, workspaceRoot);
  const affectedPackages = await isJavaScriptWorkspaceRoot(root, parsed.workspaces)
    ? await discoverAffectedJavaScriptPackages(root, changedFiles)
    : [];
  if (affectedPackages.length > 0) {
    return affectedPackages.flatMap((affectedPackage) => {
      const platformBuildScripts = discoverPlatformBuildScripts(
        affectedPackage.scripts,
        affectedPackage.changedFiles,
      );
      return preferredJavaScriptScripts(
        affectedPackage.scripts,
        platformBuildScripts,
        affectedPackage.changedFiles,
      )
        .map((script) => buildWorkspaceScriptCommand(
          packageManager,
          affectedPackage.name ?? `./${affectedPackage.path}`,
          script,
        ));
    });
  }

  const platformBuildScripts = discoverPlatformBuildScripts(parsed.scripts ?? {}, changedFiles.map((file) => file.path));
  return preferredJavaScriptScripts(
    parsed.scripts ?? {},
    platformBuildScripts,
    changedFiles.map((file) => file.path),
  )
    .map((script) => (script === "test" ? `${packageManager} test` : `${packageManager} run ${script}`));
}

async function isJavaScriptWorkspaceRoot(root: string, workspaces: unknown): Promise<boolean> {
  const hasPackageWorkspaces = Array.isArray(workspaces) || (
    isRecord(workspaces) && Array.isArray(workspaces.packages)
  );
  return hasPackageWorkspaces || await hasAnyFile(root, [
    "pnpm-workspace.yaml",
    "pnpm-workspace.yml",
    "lerna.json",
    "rush.json",
  ]);
}

interface AffectedJavaScriptPackage {
  path: string;
  name?: string;
  scripts: Record<string, string>;
  changedFiles: string[];
}

async function discoverAffectedJavaScriptPackages(
  root: string,
  changedFiles: TestPlanChangedFile[],
): Promise<AffectedJavaScriptPackage[]> {
  const packages = new Map<string, AffectedJavaScriptPackage>();
  for (const changedFile of changedFiles) {
    let directory = path.posix.dirname(toPosixPath(changedFile.path));
    while (directory !== "." && directory !== "/") {
      const packageJsonPath = path.join(root, directory, "package.json");
      const packageJson = await readJavaScriptPackage(packageJsonPath);
      if (packageJson) {
        const existing = packages.get(directory);
        if (existing) {
          existing.changedFiles.push(changedFile.path);
        } else {
          packages.set(directory, {
            path: directory,
            name: packageJson.name,
            scripts: packageJson.scripts ?? {},
            changedFiles: [changedFile.path],
          });
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
  return [...packages.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function readJavaScriptPackage(
  packageJsonPath: string,
): Promise<{ name?: string; scripts?: Record<string, string> } | undefined> {
  try {
    return JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
    };
  } catch {
    return undefined;
  }
}

function preferredJavaScriptScripts(
  scripts: Record<string, string>,
  platformBuildScripts: string[],
  changedFiles: string[],
): string[] {
  return uniqueCommands([
    ...discoverBenchmarkValidationScripts(scripts, changedFiles),
    ...platformBuildScripts,
    "test",
    "typecheck",
    "lint",
    "build",
    "test:e2e",
    "e2e",
  ]).filter((script) => isUsableScript(scripts[script]));
}

function discoverBenchmarkValidationScripts(
  scripts: Record<string, string>,
  changedFiles: string[],
): string[] {
  if (!changedFiles.some(isBenchmarkValidationStructurePath)) {
    return [];
  }
  const candidates = Object.entries(scripts)
    .filter(([name, command]) => isUsableScript(command) && isRepositoryBenchmarkScript(name, command));
  if (candidates.length === 0) {
    return [];
  }
  const ranked = candidates
    .map(([name, command]) => ({
      name,
      command,
      affinity: benchmarkScriptAffinity(name, command, changedFiles),
    }))
    .sort((left, right) =>
      benchmarkScriptRank(left.name, left.command) - benchmarkScriptRank(right.name, right.command) ||
      left.name.localeCompare(right.name)
    );
  const selected = ranked.filter((candidate) => candidate.affinity > 0);
  if (changedFiles.some(isGenericBenchmarkValidationPath)) {
    selected.push(ranked[0]);
  }
  const result = selected.length > 0 ? selected : [ranked[0]];
  const selectedNames = new Set(result.map((candidate) => candidate.name));
  return ranked
    .filter((candidate) => selectedNames.has(candidate.name))
    .map((candidate) => candidate.name);
}

const benchmarkVariantStopWords = new Set([
  "assert",
  "bench",
  "benchmark",
  "ci",
  "config",
  "json",
  "mjs",
  "node",
  "script",
  "scripts",
  "test",
  "tests",
]);

function benchmarkScriptAffinity(
  name: string,
  command: string,
  changedFiles: string[],
): number {
  const scriptTokens = new Set(benchmarkVariantTokens(name + " " + command));
  const changedTokens = new Set(changedFiles.flatMap(benchmarkVariantTokens));
  return [...scriptTokens].filter((token) => changedTokens.has(token)).length;
}

function benchmarkVariantTokens(value: string): string[] {
  return uniqueCommands(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !benchmarkVariantStopWords.has(token)),
  );
}

function isGenericBenchmarkValidationPath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  if (isBenchmarkRevisionFixturePath(normalized)) {
    return true;
  }
  return /(?:^|\/)(?:bench|benchmark)(?:\.config)?\.(?:json|json5|ya?ml|toml)$/i.test(normalized) ||
    /(?:^|\/)scripts\/(?:bench|benchmark)\.[cm]?[jt]s$/i.test(normalized);
}

function benchmarkScriptRank(name: string, command: string): number {
  if (/(?:^|:)ci(?:$|:)/i.test(name) || /(?:^|\s)--assert(?:\s|$)/i.test(command)) {
    return 0;
  }
  if (/^(?:bench|benchmark)$/i.test(name)) {
    return 1;
  }
  return 2;
}

export function buildWorkspaceScriptCommand(packageManager: string, target: string, script: string): string {
  const scopedTarget = shellArgument(target);
  if (packageManager === "pnpm") {
    return script === "test"
      ? `pnpm --filter ${scopedTarget} test`
      : `pnpm --filter ${scopedTarget} run ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn workspace ${scopedTarget} ${script}`;
  }
  if (packageManager === "bun") {
    return script === "test"
      ? `bun --filter ${scopedTarget} test`
      : `bun --filter ${scopedTarget} run ${script}`;
  }
  return script === "test"
    ? `npm test --workspace ${scopedTarget}`
    : `npm run ${script} --workspace ${scopedTarget}`;
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function discoverPlatformBuildScripts(scripts: Record<string, string>, changedFiles: string[]): string[] {
  const names = Object.keys(scripts).filter((name) => isUsableScript(scripts[name]));
  const androidChanged = changedFiles.some((file) => /(?:^|\/)android(?:\/|$)|AndroidManifest|\.gradle(?:\.kts)?$/i.test(file));
  const iosChanged = changedFiles.some((file) => /(?:^|\/)ios(?:\/|$)|Info\.plist$|\.xcodeproj(?:\/|$)|\.xcworkspace(?:\/|$)/i.test(file));
  const selected: string[] = [];

  if (androidChanged) {
    const androidScript = preferredPlatformScript(names, /(?:^|:)(?:android|apk|aab)(?::|$)/i);
    if (androidScript) {
      selected.push(androidScript);
    }
  }
  if (iosChanged) {
    const iosScript = preferredPlatformScript(names, /(?:^|:)(?:ios|archive)(?::|$)/i);
    if (iosScript) {
      selected.push(iosScript);
    }
  }
  return uniqueCommands(selected);
}

function preferredPlatformScript(names: string[], pattern: RegExp): string | undefined {
  return names
    .filter((name) => pattern.test(name))
    .sort((left, right) => platformScriptRank(left) - platformScriptRank(right) || left.localeCompare(right))[0];
}

function platformScriptRank(name: string): number {
  if (/^build(?::|$)/i.test(name)) {
    return 0;
  }
  if (/(?:^|:)clean(?:$|:)/i.test(name)) {
    return 1;
  }
  return 2;
}

async function discoverPythonCommands(root: string, changedFiles: TestPlanChangedFile[]): Promise<string[]> {
  const pyproject = await readTextIfExists(path.join(root, "pyproject.toml"));
  const hasPythonMarker =
    Boolean(pyproject) ||
    (await hasAnyFile(root, [
      "requirements.txt",
      "setup.py",
      "setup.cfg",
      "tox.ini",
      "pytest.ini",
      "uv.lock",
      "poetry.lock",
      "Pipfile",
    ]));
  if (!hasPythonMarker) {
    return [];
  }

  const runner = await detectPythonRunner(root, pyproject);
  const dockerTarget = await detectPythonComposeTarget(root);
  const pytestTargets = await discoverRelevantPythonTests(root, changedFiles);
  const commands: string[] = [];
  const hasToxSignal = await exists(path.join(root, "tox.ini"));
  const hasPytestSignal =
    /\bpytest\b|\[tool\.pytest/i.test(pyproject ?? "") ||
    (await exists(path.join(root, "pytest.ini"))) ||
    (await hasDirectory(path.join(root, "tests")));
  const hasRuffSignal = /\[tool\.ruff/i.test(pyproject ?? "") || (await hasAnyFile(root, ["ruff.toml", ".ruff.toml"]));
  const hasMypySignal = /\[tool\.mypy/i.test(pyproject ?? "") || (await hasAnyFile(root, ["mypy.ini", ".mypy.ini"]));

  if (hasToxSignal) {
    commands.push(withPythonEnvironment(runner, dockerTarget, "tox"));
  }
  if (hasPytestSignal) {
    const targetSuffix = pytestTargets.length > 0
      ? ` ${pytestTargets.map(shellArgument).join(" ")}`
      : "";
    commands.push(withPythonEnvironment(runner, dockerTarget, `pytest${targetSuffix}`));
  }
  if (hasRuffSignal) {
    commands.push(withPythonEnvironment(runner, dockerTarget, "ruff check ."));
  }
  if (hasMypySignal) {
    commands.push(withPythonEnvironment(runner, dockerTarget, "mypy ."));
  }

  return commands;
}

function withPythonEnvironment(
  runner: string | undefined,
  dockerTarget: PythonComposeTarget | undefined,
  command: string,
): string {
  if (dockerTarget) {
    const usesDefaultComposeFile = [
      "compose.yml",
      "compose.yaml",
      "docker-compose.yml",
      "docker-compose.yaml",
    ].includes(dockerTarget.composeFile);
    const composeOption = usesDefaultComposeFile ? "" : ` -f ${shellArgument(dockerTarget.composeFile)}`;
    const containerCommand = dockerTarget.runner ? `${dockerTarget.runner} ${command}` : command;
    return `docker compose${composeOption} run --rm ${shellArgument(dockerTarget.service)} ${containerCommand}`;
  }
  return withRunner(runner, command);
}

interface PythonComposeTarget {
  composeFile: string;
  service: string;
  runner?: string;
}

async function detectPythonComposeTarget(root: string): Promise<PythonComposeTarget | undefined> {
  const composeFiles = await discoverComposeFiles(root);
  const candidates: Array<PythonComposeTarget & { score: number }> = [];
  for (const composeFile of composeFiles) {
    let parsed: unknown;
    try {
      parsed = YAML.parse(await fs.readFile(path.join(root, composeFile), "utf8"));
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.services)) {
      continue;
    }

    for (const [serviceName, service] of Object.entries(parsed.services)) {
      if (!isRecord(service)) {
        continue;
      }
      const serialized = JSON.stringify(service);
      const build = service.build;
      const buildsRoot = build === "." || (
        isRecord(build) && (build.context === undefined || build.context === ".")
      );
      const dockerfile = isRecord(build) && typeof build.dockerfile === "string"
        ? build.dockerfile
        : "Dockerfile";
      const dockerfileText = buildsRoot
        ? await readTextIfExists(path.join(root, dockerfile))
        : undefined;
      const dockerfileUsesPython = /^\s*FROM\s+[^\n]*python/im.test(dockerfileText ?? "");
      const explicitPython = /python|pytest|django|flask|fastapi|gunicorn|uvicorn|celery/i.test(serialized);
      if (!explicitPython && !dockerfileUsesPython) {
        continue;
      }
      const runner = detectContainerPythonRunner(dockerfileText);
      const primaryService = /^(?:app|api|web|backend|server)$/i.test(serviceName);
      const backgroundService = /(?:^|[-_])(?:worker|beat|scheduler|consumer|queue)(?:$|[-_])/i.test(serviceName);
      candidates.push({
        composeFile,
        service: serviceName,
        runner,
        score:
          (explicitPython ? 2 : 0) +
          (dockerfileUsesPython ? 4 : 0) +
          (primaryService ? 5 : 0) +
          (backgroundService ? -4 : 0) +
          (Array.isArray(service.ports) && service.ports.length > 0 ? 2 : 0) +
          (Array.isArray(service.volumes) && service.volumes.some((volume) => String(volume).startsWith(".:")) ? 1 : 0) +
          composeFilePreference(composeFile),
      });
    }
  }
  const selected = candidates.sort((left, right) =>
    right.score - left.score || left.composeFile.localeCompare(right.composeFile) || left.service.localeCompare(right.service)
  )[0];
  if (!selected) {
    return undefined;
  }
  return {
    composeFile: selected.composeFile,
    service: selected.service,
    runner: selected.runner,
  };
}

function detectContainerPythonRunner(dockerfileText: string | undefined): string | undefined {
  const normalized = (dockerfileText ?? "").replace(/[\"',\[\]]+/g, " ");
  if (/\buv\s+run\b/i.test(normalized)) {
    return "uv run";
  }
  if (/\bpoetry\s+run\b/i.test(normalized)) {
    return "poetry run";
  }
  return undefined;
}

async function discoverComposeFiles(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(root))
      .filter((file) => /^(?:docker-)?compose(?:[._-][A-Za-z0-9_-]+)*\.ya?ml$/i.test(file))
      .sort((left, right) => composeFilePreference(right) - composeFilePreference(left) || left.localeCompare(right));
  } catch {
    return [];
  }
}

function composeFilePreference(file: string): number {
  if (/^(?:docker-)?compose\.ya?ml$/i.test(file)) return 5;
  if (/(?:^|[._-])local(?:[._-]|\.)/i.test(file)) return 4;
  if (/(?:^|[._-])dev(?:[._-]|\.)/i.test(file)) return 3;
  if (/(?:^|[._-])test(?:[._-]|\.)/i.test(file)) return 2;
  if (/(?:^|[._-])prod(?:[._-]|\.)/i.test(file)) return -3;
  return 0;
}

async function discoverRelevantPythonTests(
  root: string,
  changedFiles: TestPlanChangedFile[],
): Promise<string[]> {
  const directlyChangedTests = changedFiles
    .map((file) => file.path)
    .filter((file) => isPythonTestFile(file) && !isBenchmarkRevisionFixturePath(file));
  if (directlyChangedTests.length > 0) {
    return uniqueCommands(directlyChangedTests).slice(0, 6);
  }

  const changedSources = changedFiles
    .map((file) => file.path)
    .filter((file) => file.endsWith(".py") && !isPythonTestFile(file));
  if (changedSources.length === 0) {
    return [];
  }

  let projectFiles: Awaited<ReturnType<typeof collectProjectFiles>>;
  try {
    projectFiles = await collectProjectFiles(root, 4_000);
  } catch {
    return [];
  }
  const testFiles = projectFiles
    .map((file) => file.path)
    .filter((file) => isPythonTestFile(file) && !isBenchmarkRevisionFixturePath(file));
  const ranked = testFiles
    .map((testFile) => ({
      file: testFile,
      score: Math.max(...changedSources.map((sourceFile) => pythonTestRelevance(sourceFile, testFile))),
    }))
    .filter((candidate) => candidate.score >= 4)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file));
  return ranked.slice(0, 6).map((candidate) => candidate.file);
}

const ignoredPythonPathTokens = new Set([
  "app",
  "apps",
  "src",
  "lib",
  "project",
  "service",
  "services",
  "test",
  "tests",
  "unit",
  "integration",
  "python",
]);
const genericPythonFileStems = new Set([
  "api",
  "client",
  "handler",
  "index",
  "model",
  "models",
  "service",
  "utils",
  "view",
  "views",
]);

function pythonTestRelevance(sourceFile: string, testFile: string): number {
  const sourceBase = pythonFileStem(sourceFile);
  const testBase = pythonFileStem(testFile).replace(/^test_/, "").replace(/_test$/, "");
  const sourceTokens = meaningfulPythonPathTokens(sourceFile);
  const testTokens = new Set(meaningfulPythonPathTokens(testFile));
  const sharedTokens = sourceTokens.filter((token) => testTokens.has(token));
  const basenameScore = sourceBase === testBase
    ? (genericPythonFileStems.has(sourceBase) ? 2 : 6)
    : 0;
  return basenameScore + Math.min(6, sharedTokens.length * 2);
}

function meaningfulPythonPathTokens(filePath: string): string[] {
  return uniqueCommands(
    toPosixPath(filePath)
      .replace(/\.py$/i, "")
      .split(/[\/_-]+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 3 && !ignoredPythonPathTokens.has(token)),
  );
}

function pythonFileStem(filePath: string): string {
  return path.posix.basename(toPosixPath(filePath)).replace(/\.py$/i, "").toLowerCase();
}

function isPythonTestFile(filePath: string): boolean {
  return /(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/i.test(filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function detectPythonRunner(root: string, pyproject: string | undefined): Promise<string | undefined> {
  if (await exists(path.join(root, "uv.lock"))) {
    return "uv run";
  }
  if (/\[tool\.poetry/i.test(pyproject ?? "") || (await exists(path.join(root, "poetry.lock")))) {
    return "poetry run";
  }
  return undefined;
}

async function discoverGoCommands(root: string): Promise<string[]> {
  if (!(await exists(path.join(root, "go.mod")))) {
    return [];
  }
  const commands = ["go test ./...", "go vet ./..."];
  if (await hasAnyFile(root, [".golangci.yml", ".golangci.yaml", "golangci.yml", "golangci.yaml"])) {
    commands.push("golangci-lint run");
  }
  return commands;
}

async function discoverRustCommands(root: string): Promise<string[]> {
  if (!(await exists(path.join(root, "Cargo.toml")))) {
    return [];
  }
  return ["cargo test", "cargo clippy --all-targets --all-features", "cargo build"];
}

async function discoverJvmCommands(root: string): Promise<string[]> {
  if (await exists(path.join(root, "gradlew"))) {
    return ["./gradlew test", "./gradlew build"];
  }
  if (await hasAnyFile(root, ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"])) {
    return ["gradle test", "gradle build"];
  }
  if (await exists(path.join(root, "pom.xml"))) {
    return ["mvn test", "mvn verify"];
  }
  return [];
}

async function detectPackageManager(
  root: string,
  packageManager: string | undefined,
  workspaceRoot: string | undefined,
): Promise<string> {
  const workspacePackageManager =
    workspaceRoot && workspaceRoot !== root ? await readPackageManager(workspaceRoot) : undefined;
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

async function readPackageManager(root: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    return parsed.packageManager;
  } catch {
    return undefined;
  }
}

async function existsInRoots(fileName: string, root: string, workspaceRoot: string | undefined): Promise<boolean> {
  if (await exists(path.join(root, fileName))) {
    return true;
  }
  return Boolean(workspaceRoot && workspaceRoot !== root && (await exists(path.join(workspaceRoot, fileName))));
}

function isUsableScript(script: string | undefined): boolean {
  return Boolean(script && !/no test specified|exit\s+1/i.test(script));
}

async function hasAnyFile(root: string, fileNames: string[]): Promise<boolean> {
  for (const fileName of fileNames) {
    if (await exists(path.join(root, fileName))) {
      return true;
    }
  }
  return false;
}

async function hasDirectory(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function withRunner(runner: string | undefined, command: string): string {
  return runner ? `${runner} ${command}` : command;
}

function uniqueCommands(commands: string[]): string[] {
  return commands.filter((command, index) => commands.indexOf(command) === index);
}

function commandsForChangedTestEvidence(files: TestPlanChangedFile[]): string[] {
  if (files.some((file) => /(?:^|\/)\.maestro\/[^/]+\.ya?ml$/i.test(file.path))) {
    return ["maestro test .maestro"];
  }
  return [];
}

function normalizeValidationCommands(commands: string[] | undefined): string[] {
  return (commands ?? []).map((command) => command.trim()).filter(Boolean);
}

function isTestLikeFile(filePath: string): boolean {
  return (
    /(?:^|\/)(__tests__|tests?|specs?|e2e)\//i.test(filePath) ||
    /(\.|-)(test|spec)\.[cm]?[jt]sx?$/i.test(filePath) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(filePath) ||
    /(?:^|\/)[^/]+_test\.(?:py|go)$/i.test(filePath) ||
    /(?:^|\/)[^/]+(?:Test|Tests|Spec)\.(?:java|kt|cs|swift)$/i.test(filePath) ||
    /(?:^|\/)[^/]+_(?:test|spec)\.rs$/i.test(filePath) ||
    /(?:^|\/)\.maestro\/[^/]+\.ya?ml$/i.test(filePath)
  );
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function summarizeDomains(files: string[]): string {
  const domains = [...new Set(files.map(domainFromPath).filter((domain): domain is string => Boolean(domain)))];
  if (domains.length === 0) {
    return "Domain";
  }
  return domains.slice(0, 3).map(titleCase).join(" / ");
}

function domainFromPath(file: string): string | undefined {
  const segments = file.split("/");
  for (const key of ["features", "domains", "modules", "services"]) {
    const index = segments.indexOf(key);
    if (index >= 0 && segments[index + 1]) {
      const segment = segments[index + 1];
      // Mirror the e2e flow naming rule: two-letter all-lowercase segments are
      // near-always acronyms and keep their uppercase form.
      return /^[a-z]{2}$/.test(segment) ? segment.toUpperCase() : segment;
    }
  }
  return undefined;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function scopeChangedFiles(changedFiles: TestPlanChangedFile[], relativeRoot: string): TestPlanChangedFile[] {
  if (!relativeRoot) {
    return changedFiles;
  }
  const prefix = `${relativeRoot}/`;
  return changedFiles
    .flatMap((file): TestPlanChangedFile[] => {
      const scopedPath = stripScopedPath(file.path, relativeRoot, prefix);
      if (!scopedPath) {
        return [];
      }
      const previousPath = file.previousPath
        ? stripScopedPath(file.previousPath, relativeRoot, prefix) ?? file.previousPath
        : undefined;
      return [
        {
          ...file,
          path: scopedPath,
          previousPath,
        },
      ];
    });
}

function stripScopedPath(filePath: string, relativeRoot: string, prefix: string): string | undefined {
  if (filePath === relativeRoot) {
    return ".";
  }
  if (filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length);
  }
  return undefined;
}

export interface AddedDiffTextOptions {
  base: string;
  head: string;
  workspaceRoot?: string;
  includeWorkingTree?: boolean;
}

export interface AddedDiffLine {
  line: number;
  text: string;
}

export interface AddedDiffHunk {
  file: string;
  previousFile?: string;
  baseStartLine?: number;
  baseEndLine?: number;
  startLine: number;
  endLine: number;
  hunkHeader: string;
  lines: AddedDiffLine[];
  removedLines?: AddedDiffLine[];
}

export type AddedDiffEvidence = Record<string, AddedDiffHunk[]>;

const maxAddedTextFiles = 200;
const maxAddedTextPerFile = 20_000;

export async function collectAddedDiffText(
  rootInput: string,
  options: AddedDiffTextOptions,
): Promise<Record<string, string>> {
  return addedDiffTextFromEvidence(await collectAddedDiffEvidence(rootInput, options));
}

export async function collectAddedDiffEvidence(
  rootInput: string,
  options: AddedDiffTextOptions,
): Promise<AddedDiffEvidence> {
  const root = path.resolve(rootInput);
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  const gitRoot = workspaceRoot ?? root;
  const relativeRoot = workspaceRoot ? toPosixPath(path.relative(workspaceRoot, root)) : "";
  const byFile: AddedDiffEvidence = {};
  try {
    const diffTarget = options.includeWorkingTree
      ? await resolveMergeBase(gitRoot, options.base, options.head)
      : `${options.base}...${options.head}`;
    if (!options.includeWorkingTree) {
      await mergePriorityDiffEvidence(byFile, gitRoot, relativeRoot, options);
    }
    if (options.includeWorkingTree) {
      await mergeUntrackedDiffEvidence(byFile, gitRoot, relativeRoot);
    }
    const { stdout } = await git(gitRoot, [
      "diff",
      "--no-color",
      "--find-renames",
      "--unified=0",
      diffTarget,
    ]);
    mergeAddedDiffEvidence(byFile, stdout, relativeRoot);
  } catch {
    return byFile;
  }
  return byFile;
}

async function mergePriorityDiffEvidence(
  byFile: AddedDiffEvidence,
  gitRoot: string,
  relativeRoot: string,
  options: AddedDiffTextOptions,
): Promise<void> {
  try {
    const priorityCommit = await resolvePriorityDiffCommit(gitRoot, options.base, options.head);
    if (!priorityCommit) {
      return;
    }
    const { stdout } = await git(gitRoot, [
      "diff",
      "--no-color",
      "--find-renames",
      "--unified=0",
      `${priorityCommit}^`,
      priorityCommit,
    ]);
    mergeAddedDiffEvidence(byFile, stdout, relativeRoot);
  } catch {
    // A root commit has no parent; the complete base/head diff below remains valid.
  }
}

async function resolvePriorityDiffCommit(
  gitRoot: string,
  base: string,
  head: string,
): Promise<string | undefined> {
  const { stdout } = await git(gitRoot, [
    "rev-list",
    "--first-parent",
    "--no-merges",
    "--max-count=1",
    `${base}..${head}`,
  ]);
  return stdout.trim() || undefined;
}

async function mergeUntrackedDiffEvidence(
  byFile: AddedDiffEvidence,
  gitRoot: string,
  relativeRoot: string,
): Promise<void> {
  const { stdout } = await git(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untrackedFiles = stdout.split("\0").filter(Boolean);

  for (const gitFile of untrackedFiles) {
    const file = relativeRoot
      ? stripScopedPath(gitFile, relativeRoot, `${relativeRoot}/`)
      : gitFile;
    if (!file || file === "." || byFile[file]) {
      continue;
    }
    if (Object.keys(byFile).length >= maxAddedTextFiles) {
      break;
    }

    const absoluteFile = path.resolve(gitRoot, gitFile);
    const relativeFile = path.relative(gitRoot, absoluteFile);
    if (relativeFile.startsWith("..") || path.isAbsolute(relativeFile)) {
      continue;
    }

    try {
      const stat = await fs.lstat(absoluteFile);
      if (!stat.isFile() || stat.size === 0 || stat.size > maxAddedTextPerFile) {
        continue;
      }
      const content = await fs.readFile(absoluteFile);
      if (content.includes(0)) {
        continue;
      }
      const text = content.toString("utf8");
      const sourceLines = text.split(/\r?\n/);
      if (sourceLines.at(-1) === "") {
        sourceLines.pop();
      }
      if (sourceLines.length === 0) {
        continue;
      }
      const lines = sourceLines.map((line, index) => ({ line: index + 1, text: line }));
      byFile[file] = [{
        file,
        baseStartLine: 0,
        baseEndLine: 0,
        startLine: 1,
        endLine: lines.length,
        hunkHeader: `@@ -0,0 +1,${lines.length} @@`,
        lines,
        removedLines: [],
      }];
    } catch {
      // A working-tree file can disappear between listing and reading it.
    }
  }
}

export function addedDiffTextFromEvidence(evidence: AddedDiffEvidence): Record<string, string> {
  return Object.fromEntries(
    Object.entries(evidence).map(([file, hunks]) => [
      file,
      hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join("\n") + "\n",
    ]),
  );
}

function mergeAddedDiffEvidence(byFile: AddedDiffEvidence, diffText: string, relativeRoot: string): void {
  let currentFile: string | undefined;
  let previousFile: string | undefined;
  let currentHunk: AddedDiffHunk | undefined;
  let baseLine = 0;
  let headLine = 0;

  const flushHunk = (): void => {
    if (!currentHunk || (currentHunk.lines.length === 0 && (currentHunk.removedLines?.length ?? 0) === 0) || !currentFile) {
      currentHunk = undefined;
      return;
    }
    if (byFile[currentFile] === undefined && Object.keys(byFile).length >= maxAddedTextFiles) {
      currentHunk = undefined;
      return;
    }
    const existing = byFile[currentFile] ?? [];
    const existingLength = existing.reduce(
      (total, hunk) => total + [...hunk.lines, ...(hunk.removedLines ?? [])]
        .reduce((sum, line) => sum + line.text.length + 1, 0),
      0,
    );
    if (existingLength < maxAddedTextPerFile) {
      const remaining = maxAddedTextPerFile - existingLength;
      let includedLength = 0;
      const candidateLines = [
        ...currentHunk.lines.map((line) => ({ ...line, side: "head" as const })),
        ...(currentHunk.removedLines ?? []).map((line) => ({ ...line, side: "base" as const })),
      ].sort((left, right) => left.line - right.line);
      const included = candidateLines.filter((line) => {
        includedLength += line.text.length + 1;
        return includedLength <= remaining;
      });
      const lines = included.filter((line) => line.side === "head").map(({ line, text }) => ({ line, text }));
      const removedLines = included.filter((line) => line.side === "base").map(({ line, text }) => ({ line, text }));
      if (lines.length > 0 || removedLines.length > 0) {
        existing.push({
          ...currentHunk,
          baseStartLine: removedLines[0]?.line ?? currentHunk.baseStartLine,
          baseEndLine: removedLines.at(-1)?.line ?? currentHunk.baseEndLine,
          startLine: lines[0]?.line ?? currentHunk.startLine,
          endLine: lines.at(-1)?.line ?? currentHunk.endLine,
          lines,
          removedLines,
        });
        byFile[currentFile] = existing;
      }
    }
    currentHunk = undefined;
  };

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flushHunk();
      currentFile = undefined;
      previousFile = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      const rawPath = line.replace(/^--- /, "");
      if (rawPath !== "/dev/null") {
        const filePath = rawPath.replace(/^a\//, "");
        previousFile = relativeRoot ? stripScopedPath(filePath, relativeRoot, `${relativeRoot}/`) : filePath;
      }
      continue;
    }
    if (line.startsWith("+++ ")) {
      flushHunk();
      const rawPath = line.replace(/^\+\+\+ /, "");
      if (rawPath === "/dev/null") {
        currentFile = previousFile;
        continue;
      }
      const filePath = rawPath.replace(/^b\//, "");
      currentFile = relativeRoot ? stripScopedPath(filePath, relativeRoot, `${relativeRoot}/`) : filePath;
      continue;
    }
    if (line.startsWith("@@ ")) {
      flushHunk();
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!currentFile || !match) {
        continue;
      }
      baseLine = Number.parseInt(match[1], 10);
      headLine = Number.parseInt(match[3], 10);
      currentHunk = {
        file: currentFile,
        previousFile: previousFile && previousFile !== currentFile ? previousFile : undefined,
        baseStartLine: baseLine,
        baseEndLine: baseLine,
        startLine: headLine,
        endLine: headLine,
        hunkHeader: line,
        lines: [],
        removedLines: [],
      };
      continue;
    }
    if (!currentHunk) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentHunk.lines.push({ line: headLine, text: line.slice(1) });
      currentHunk.endLine = headLine;
      headLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      currentHunk.removedLines?.push({ line: baseLine, text: line.slice(1) });
      currentHunk.baseEndLine = baseLine;
      baseLine += 1;
      continue;
    }
    if (!line.startsWith("-") && !line.startsWith("\\")) {
      baseLine += 1;
      headLine += 1;
    }
  }
  flushHunk();
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}
