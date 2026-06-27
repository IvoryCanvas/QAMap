import { promises as fs } from "node:fs";
import path from "node:path";
import { generateTestPlan } from "./test-plan.js";
import type { TestPlanChangedFile, TestPlanItem, TestPlanOptions } from "./test-plan.js";
import { TOOL_NAME, VERSION } from "./version.js";

export type EvalCheckStatus = "pass" | "warn" | "fail";
export type EvalRating = "strong" | "ready" | "needs-work" | "high-risk";

export interface EvalOptions extends TestPlanOptions {
  prBody?: string;
  prBodyFile?: string;
}

export interface EvalCheck {
  id: string;
  title: string;
  status: EvalCheckStatus;
  score: number;
  maxScore: number;
  reason: string;
  evidence: string[];
  recommendation: string;
}

export interface EvalResult {
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
  score: number;
  maxScore: number;
  rating: EvalRating;
  changedFiles: TestPlanChangedFile[];
  suggestedCommands: string[];
  testPlanItems: TestPlanItem[];
  checks: EvalCheck[];
  recommendations: string[];
}

export async function evaluateChangeReadiness(rootInput: string, options: EvalOptions = {}): Promise<EvalResult> {
  const testPlan = await generateTestPlan(rootInput, options);
  const prBody = normalizeText(options.prBody ?? (await readPrBodyFile(options.prBodyFile)));
  const checks = [
    scoreValidationCommands(testPlan.suggestedCommands),
    scoreChangedTestCoverage(testPlan.changedFiles, testPlan.suggestedCommands),
    await scoreIntentCapture(testPlan.root, testPlan.workspaceRoot, testPlan.changedFiles, prBody),
    scoreRiskExplanation(testPlan.changedFiles, prBody),
    scoreDomainTestPlan(testPlan.changedFiles, testPlan.items),
    scoreReviewSize(testPlan.changedFiles),
  ];
  const score = checks.reduce((total, check) => total + check.score, 0);
  const maxScore = checks.reduce((total, check) => total + check.maxScore, 0);

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
    score,
    maxScore,
    rating: ratingForScore(score, maxScore),
    changedFiles: testPlan.changedFiles,
    suggestedCommands: testPlan.suggestedCommands,
    testPlanItems: testPlan.items,
    checks,
    recommendations: buildRecommendations(checks),
  };
}

export function formatEvalReport(result: EvalResult): string {
  const lines: string[] = [];
  lines.push(`${result.tool.name} Eval`);
  lines.push(`Root: ${result.root}`);
  if (result.workspaceRoot) {
    lines.push(`Workspace root: ${result.workspaceRoot}`);
  }
  lines.push(`Base: ${result.base}`);
  lines.push(`Head: ${result.head}`);
  if (result.includeWorkingTree) {
    lines.push("Includes working tree changes: yes");
  }
  lines.push(`Score: ${result.score}/${result.maxScore} (${result.rating})`);
  lines.push(`Changed files: ${result.changedFiles.length}`);
  lines.push("");

  for (const check of result.checks) {
    lines.push(`${check.status.toUpperCase()} ${check.title}: ${check.score}/${check.maxScore}`);
    lines.push(`  ${check.reason}`);
    for (const evidence of check.evidence) {
      lines.push(`  Evidence: ${evidence}`);
    }
    if (check.status !== "pass") {
      lines.push(`  Fix: ${check.recommendation}`);
    }
  }

  if (result.recommendations.length > 0) {
    lines.push("");
    lines.push("Recommendations:");
    for (const recommendation of result.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }

  return lines.join("\n");
}

export function formatMarkdownEvalReport(result: EvalResult): string {
  const lines: string[] = [];
  lines.push("# CodeWard Eval");
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
  lines.push(`- Score: **${result.score}/${result.maxScore}** (${result.rating})`);
  lines.push(`- Changed files: ${result.changedFiles.length}`);
  lines.push("");
  lines.push("## Verification Gates");
  lines.push("");
  lines.push("| Gate | Status | Score | Reason |");
  lines.push("| --- | --- | ---: | --- |");
  for (const check of result.checks) {
    lines.push(
      `| ${escapeMarkdownCell(check.title)} | ${check.status} | ${check.score}/${check.maxScore} | ${escapeMarkdownCell(
        check.reason,
      )} |`,
    );
  }

  lines.push("");
  lines.push("## Evidence");
  lines.push("");
  for (const check of result.checks) {
    lines.push(`### ${escapeMarkdownInline(check.title)}`);
    lines.push("");
    if (check.evidence.length === 0) {
      lines.push("- No direct evidence found.");
    } else {
      for (const evidence of check.evidence) {
        lines.push(`- ${escapeMarkdownInline(evidence)}`);
      }
    }
    if (check.status !== "pass") {
      lines.push(`- Recommendation: ${escapeMarkdownInline(check.recommendation)}`);
    }
    lines.push("");
  }

  if (result.recommendations.length > 0) {
    lines.push("## Recommendations");
    lines.push("");
    for (const recommendation of result.recommendations) {
      lines.push(`- ${escapeMarkdownInline(recommendation)}`);
    }
    lines.push("");
  }

  if (result.suggestedCommands.length > 0) {
    lines.push("## Suggested Commands");
    lines.push("");
    for (const command of result.suggestedCommands) {
      lines.push(`- \`${escapeMarkdownInline(command)}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function readPrBodyFile(prBodyFile: string | undefined): Promise<string | undefined> {
  if (!prBodyFile) {
    return undefined;
  }
  return fs.readFile(path.resolve(prBodyFile), "utf8");
}

function scoreValidationCommands(commands: string[]): EvalCheck {
  const hasTest = commands.some(isTestCommand);
  const hasSupport = commands.some(isSupportingValidationCommand);
  if (hasTest && hasSupport) {
    return check(
      "validation-commands",
      "Validation commands",
      "pass",
      2,
      "Test and supporting validation commands are available.",
      commands,
    );
  }
  if (commands.length > 0) {
    return check(
      "validation-commands",
      "Validation commands",
      "warn",
      1,
      "Some validation commands are available, but the branch lacks a balanced test plus support command set.",
      commands,
      "Add or document a default test command plus a typecheck, lint, build, or e2e command.",
    );
  }
  return check(
    "validation-commands",
    "Validation commands",
    "fail",
    0,
    "No usable validation command was detected.",
    [],
    "Add a real package test script or document the validation command agents should run.",
  );
}

function isTestCommand(command: string): boolean {
  return /\b(?:test|vitest|jest|playwright|node --test|pytest|tox|go test|cargo test|gradle test|mvn test)\b/i.test(
    command,
  );
}

function isSupportingValidationCommand(command: string): boolean {
  return /\b(?:typecheck|lint|build|check|e2e|go vet|ruff|mypy|clippy|mvn verify)\b/i.test(command);
}

function scoreChangedTestCoverage(files: TestPlanChangedFile[], commands: string[]): EvalCheck {
  const sourceFiles = files.filter((file) => isSourceFile(file.path));
  const testFiles = files.filter((file) => isTestFile(file.path));
  if (sourceFiles.length === 0) {
    return check(
      "changed-test-coverage",
      "Changed test coverage",
      "pass",
      2,
      "No source files changed, so changed-test coverage is not required.",
      files.slice(0, 6).map((file) => file.path),
    );
  }
  if (testFiles.length > 0) {
    return check(
      "changed-test-coverage",
      "Changed test coverage",
      "pass",
      2,
      "Source changes are paired with changed test files.",
      testFiles.map((file) => file.path),
    );
  }
  if (commands.some((command) => /\btest\b/i.test(command))) {
    return check(
      "changed-test-coverage",
      "Changed test coverage",
      "warn",
      1,
      "Source files changed without changed test files, but a test command is available.",
      sourceFiles.slice(0, 6).map((file) => file.path),
      "Add focused tests for the changed behavior or explain why existing coverage is sufficient.",
    );
  }
  return check(
    "changed-test-coverage",
    "Changed test coverage",
    "fail",
    0,
    "Source files changed without changed test files or a detected test command.",
    sourceFiles.slice(0, 6).map((file) => file.path),
    "Add focused tests and a runnable test command before relying on the branch.",
  );
}

async function scoreIntentCapture(
  root: string,
  workspaceRoot: string | undefined,
  files: TestPlanChangedFile[],
  prBody: string,
): Promise<EvalCheck> {
  const intentEvidence = intentEvidenceFromText(prBody);
  if (intentEvidence.length >= 2) {
    return check(
      "intent-capture",
      "Intent capture",
      "pass",
      2,
      "The PR body captures intent, context, or tradeoffs.",
      intentEvidence.slice(0, 4),
    );
  }

  const documentationFiles = files.filter((file) => isIntentDocumentationFile(file.path)).map((file) => file.path);
  if (documentationFiles.length > 0) {
    return check(
      "intent-capture",
      "Intent capture",
      "warn",
      1,
      "Documentation changed, but the PR body does not clearly capture intent.",
      documentationFiles.slice(0, 6),
      "Summarize the problem, chosen approach, rejected alternatives, and tradeoffs in the PR body.",
    );
  }

  const template = await findPullRequestTemplate(root, workspaceRoot);
  if (template) {
    return check(
      "intent-capture",
      "Intent capture",
      "warn",
      1,
      "A pull request template exists, but no intent-rich PR body was detected.",
      [template],
      "Fill the PR template with context, rationale, tradeoffs, and validation evidence.",
    );
  }

  if (files.length === 0) {
    return check("intent-capture", "Intent capture", "pass", 2, "No changed files were detected.", []);
  }

  return check(
    "intent-capture",
    "Intent capture",
    "fail",
    0,
    "No PR body, decision document, or pull request template captured the reason for the change.",
    [],
    "Add an intent note that explains the problem, why this approach was chosen, and what tradeoffs reviewers should know.",
  );
}

function scoreRiskExplanation(files: TestPlanChangedFile[], prBody: string): EvalCheck {
  const riskyFiles = files.filter((file) => isRiskyChangeFile(file.path)).map((file) => file.path);
  if (riskyFiles.length === 0) {
    return check(
      "risk-explanation",
      "Risk explanation",
      "pass",
      2,
      "No high-risk change surfaces were detected.",
      files.slice(0, 6).map((file) => file.path),
    );
  }

  const riskEvidence = riskEvidenceFromText(prBody);
  if (riskEvidence.length > 0) {
    return check(
      "risk-explanation",
      "Risk explanation",
      "pass",
      2,
      "Risky surfaces changed and the PR body includes risk or rollback context.",
      [...riskyFiles.slice(0, 4), ...riskEvidence.slice(0, 2)],
    );
  }

  if (prBody.trim().length > 0) {
    return check(
      "risk-explanation",
      "Risk explanation",
      "warn",
      1,
      "Risky surfaces changed, but the PR body does not clearly discuss risk, rollback, compatibility, or migration impact.",
      riskyFiles.slice(0, 6),
      "Add risk, rollback, migration, compatibility, or security notes for the changed risky surfaces.",
    );
  }

  return check(
    "risk-explanation",
    "Risk explanation",
    "fail",
    0,
    "Risky surfaces changed without a detected risk explanation.",
    riskyFiles.slice(0, 6),
    "Add a PR risk section before merging changes to config, workflow, API, auth, billing, migration, or environment surfaces.",
  );
}

function scoreDomainTestPlan(files: TestPlanChangedFile[], items: TestPlanItem[]): EvalCheck {
  if (files.length === 0) {
    return check("domain-test-plan", "Domain test plan", "pass", 2, "No changed files were detected.", []);
  }
  if (items.some((item) => item.title !== "Changed-file smoke path")) {
    return check(
      "domain-test-plan",
      "Domain test plan",
      "pass",
      2,
      "Changed files map to specialized domain test scenarios.",
      items.map((item) => item.title),
    );
  }
  if (items.length > 0) {
    return check(
      "domain-test-plan",
      "Domain test plan",
      "warn",
      1,
      "Only a generic smoke path could be inferred for this change.",
      items.map((item) => item.title),
      "Add a domain-owned path, API contract, state, UI, or configuration hint so reviewers can verify the right behavior.",
    );
  }
  return check(
    "domain-test-plan",
    "Domain test plan",
    "fail",
    0,
    "No test plan could be inferred.",
    [],
    "Add enough change context for CodeWard to suggest a domain verification path.",
  );
}

function scoreReviewSize(files: TestPlanChangedFile[]): EvalCheck {
  if (files.length <= 10) {
    return check(
      "review-size",
      "Review size",
      "pass",
      2,
      "The changed-file set is small enough for focused review.",
      [`${files.length} changed files`],
    );
  }
  if (files.length <= 30) {
    return check(
      "review-size",
      "Review size",
      "warn",
      1,
      "The changed-file set is moderately large and may increase verification tax.",
      [`${files.length} changed files`],
      "Split unrelated changes or add stronger intent, risk, and validation notes.",
    );
  }
  return check(
    "review-size",
    "Review size",
    "fail",
    0,
    "The changed-file set is large enough to create substantial cognitive load.",
    [`${files.length} changed files`],
    "Split the branch or add a reviewer guide that separates independent verification paths.",
  );
}

function check(
  id: string,
  title: string,
  status: EvalCheckStatus,
  score: number,
  reason: string,
  evidence: string[],
  recommendation = "No action needed.",
): EvalCheck {
  return {
    id,
    title,
    status,
    score,
    maxScore: 2,
    reason,
    evidence,
    recommendation,
  };
}

function buildRecommendations(checks: EvalCheck[]): string[] {
  return checks
    .filter((check) => check.status !== "pass")
    .map((check) => check.recommendation)
    .filter((recommendation, index, recommendations) => recommendations.indexOf(recommendation) === index);
}

function ratingForScore(score: number, maxScore: number): EvalRating {
  const ratio = maxScore === 0 ? 1 : score / maxScore;
  if (ratio >= 0.85) {
    return "strong";
  }
  if (ratio >= 0.7) {
    return "ready";
  }
  if (ratio >= 0.45) {
    return "needs-work";
  }
  return "high-risk";
}

function intentEvidenceFromText(text: string): string[] {
  return evidenceFromText(text, [
    "why",
    "because",
    "rationale",
    "intent",
    "context",
    "tradeoff",
    "decision",
    "alternative",
    "문제",
    "이유",
    "의도",
    "맥락",
    "결정",
    "대안",
    "트레이드오프",
  ]);
}

function riskEvidenceFromText(text: string): string[] {
  return evidenceFromText(text, [
    "risk",
    "rollback",
    "migration",
    "compatibility",
    "breaking",
    "security",
    "impact",
    "위험",
    "리스크",
    "롤백",
    "마이그레이션",
    "호환",
    "보안",
    "영향",
  ]);
}

function evidenceFromText(text: string, keywords: string[]): string[] {
  if (!text.trim()) {
    return [];
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .filter((line) => keywords.some((keyword) => line.toLowerCase().includes(keyword.toLowerCase())))
    .slice(0, 6);
}

function isSourceFile(filePath: string): boolean {
  return (
    /\.(?:[cm]?[jt]sx?|vue|svelte|py|rb|go|rs|java|kt|swift|cs)$/i.test(filePath) &&
    !isTestFile(filePath) &&
    !/(?:^|\/)(dist|build|coverage|vendor)\//i.test(filePath)
  );
}

function isTestFile(filePath: string): boolean {
  return (
    /(?:^|\/)(__tests__|tests?|specs?|e2e)\//i.test(filePath) ||
    /(\.|-)(test|spec)\.[cm]?[jt]sx?$/i.test(filePath) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(filePath) ||
    /(?:^|\/)[^/]+_test\.(?:py|go)$/i.test(filePath) ||
    /(?:^|\/)[^/]+(?:Test|Tests|Spec)\.(?:java|kt|cs|swift)$/i.test(filePath) ||
    /(?:^|\/)[^/]+_(?:test|spec)\.rs$/i.test(filePath)
  );
}

function isIntentDocumentationFile(filePath: string): boolean {
  return /(?:^|\/)(docs|adr|adrs|decisions?|rfcs?|proposals?)\/|(?:adr|decision|rfc|proposal|design|intent).*\.md$/i.test(
    filePath,
  );
}

function isRiskyChangeFile(filePath: string): boolean {
  const riskyDirectory =
    /(?:^|\/)(\.github\/workflows|migrations?|schema|prisma|db|database|auth|billing|payment|permissions?|security|config|configs)\//i;
  const riskyFile =
    /(?:action\.ya?ml|package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|pyproject\.toml|requirements\.txt|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pom\.xml|build\.gradle|gradle\.properties|\.env|config|workflow|openapi|swagger|graphql|proto)/i;
  return riskyDirectory.test(filePath) || riskyFile.test(filePath);
}

async function findPullRequestTemplate(root: string, workspaceRoot: string | undefined): Promise<string | undefined> {
  for (const baseRoot of [root, workspaceRoot].filter((value): value is string => Boolean(value))) {
    const directCandidates = [
      ".github/pull_request_template.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      "docs/pull_request_template.md",
    ];
    for (const candidate of directCandidates) {
      const resolved = path.join(baseRoot, candidate);
      if (await exists(resolved)) {
        return displayPath(root, workspaceRoot, baseRoot, resolved, candidate);
      }
    }

    const templateDirectory = path.join(baseRoot, ".github/PULL_REQUEST_TEMPLATE");
    try {
      const entries = await fs.readdir(templateDirectory);
      const template = entries.find((entry) => entry.endsWith(".md"));
      if (template) {
        const resolved = path.join(templateDirectory, template);
        return displayPath(root, workspaceRoot, baseRoot, resolved, `.github/PULL_REQUEST_TEMPLATE/${template}`);
      }
    } catch {
      // No template directory in this root.
    }
  }
  return undefined;
}

function displayPath(
  root: string,
  workspaceRoot: string | undefined,
  baseRoot: string,
  filePath: string,
  fallback: string,
): string {
  const displayRoot = workspaceRoot && baseRoot === workspaceRoot ? workspaceRoot : root;
  return path.relative(displayRoot, filePath) || fallback;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeText(value: string | undefined): string {
  return value?.replaceAll("\0", "").trim() ?? "";
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}

function escapeMarkdownCell(value: string): string {
  return escapeMarkdownInline(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}
