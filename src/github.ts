import { promises as fs } from "node:fs";
import path from "node:path";
import { evaluateChangeReadiness, formatMarkdownEvalReport } from "./eval.js";
import { formatMarkdownReport } from "./report.js";
import { formatMarkdownReviewReport, reviewProject } from "./review.js";
import { scanProject } from "./scanner.js";
import { isAtLeastSeverity } from "./severity.js";
import { formatMarkdownTestPlan, generateTestPlan } from "./test-plan.js";
import type { Finding, ScanOptions, Severity } from "./types.js";

export type GitHubActionMode = "auto" | "scan" | "review";

export interface GitHubActionOptions {
  mode?: GitHubActionMode;
  base?: string;
  head?: string;
  scanOptions?: ScanOptions;
  failOn?: Severity;
  reportFile?: string;
  commentFile?: string;
  annotations?: boolean;
  stepSummary?: boolean;
  stepSummaryPath?: string;
  testPlan?: boolean;
  testPlanFile?: string;
  evaluation?: boolean;
  evalFile?: string;
  prBody?: string;
  prBodyFile?: string;
  includeWorkingTree?: boolean;
}

export interface GitHubActionResult {
  mode: Exclude<GitHubActionMode, "auto">;
  reportFile: string;
  commentFile: string;
  testPlanFile?: string;
  evalFile?: string;
  findingCount: number;
  failedFindingCount: number;
  exitCode: number;
}

const annotationLimit = 50;
const commentMarker = "<!-- codeward-pr-comment -->";

export async function runGitHubAction(rootInput: string, options: GitHubActionOptions = {}): Promise<GitHubActionResult> {
  const mode = resolveMode(options.mode);
  const reportFile = path.resolve(options.reportFile ?? "codeward-report.md");
  const commentFile = path.resolve(options.commentFile ?? "codeward-pr-comment.md");
  const testPlanFile = options.testPlan ? path.resolve(options.testPlanFile ?? "codeward-test-plan.md") : undefined;
  const evalFile = options.evaluation ? path.resolve(options.evalFile ?? "codeward-eval.md") : undefined;

  const result =
    mode === "review"
      ? await runReviewAction(rootInput, options)
      : await runScanAction(rootInput, options);
  const testPlanMarkdown = options.testPlan
    ? formatMarkdownTestPlan(
        await generateTestPlan(rootInput, {
          base: options.base,
          head: options.head,
          workspaceRoot: options.scanOptions?.workspaceRoot,
          includeWorkingTree: options.includeWorkingTree,
        }),
      )
    : undefined;
  const evalMarkdown = options.evaluation
    ? formatMarkdownEvalReport(
        await evaluateChangeReadiness(rootInput, {
          base: options.base,
          head: options.head,
          workspaceRoot: options.scanOptions?.workspaceRoot,
          includeWorkingTree: options.includeWorkingTree,
          prBody: options.prBody ?? (await readPullRequestBody()),
          prBodyFile: options.prBodyFile,
        }),
      )
    : undefined;
  const markdown = [result.markdown, testPlanMarkdown, evalMarkdown]
    .filter((section): section is string => Boolean(section))
    .map((section) => section.trim())
    .join("\n\n---\n\n")
    .concat("\n");

  await fs.writeFile(reportFile, markdown, "utf8");
  await fs.writeFile(commentFile, buildCommentBody(markdown), "utf8");
  if (testPlanFile && testPlanMarkdown) {
    await fs.writeFile(testPlanFile, testPlanMarkdown, "utf8");
  }
  if (evalFile && evalMarkdown) {
    await fs.writeFile(evalFile, evalMarkdown, "utf8");
  }

  if (options.stepSummary !== false) {
    await appendStepSummary(markdown, options.stepSummaryPath ?? process.env.GITHUB_STEP_SUMMARY);
  }

  if (options.annotations !== false) {
    writeAnnotations(result.annotations);
  }

  console.log(`CodeWard ${mode} report: ${reportFile}`);
  console.log(`CodeWard PR comment body: ${commentFile}`);
  if (testPlanFile) {
    console.log(`CodeWard test plan: ${testPlanFile}`);
  }
  if (evalFile) {
    console.log(`CodeWard eval: ${evalFile}`);
  }

  return {
    mode,
    reportFile,
    commentFile,
    testPlanFile,
    evalFile,
    findingCount: result.findings.length,
    failedFindingCount: result.failedFindings.length,
    exitCode: result.failedFindings.length > 0 ? 1 : 0,
  };
}

async function runScanAction(
  rootInput: string,
  options: GitHubActionOptions,
): Promise<ActionRunArtifacts> {
  const result = await scanProject(rootInput, options.scanOptions);
  const failedFindings = options.failOn
    ? result.findings.filter((finding) => isAtLeastSeverity(finding.severity, options.failOn!))
    : [];

  return {
    markdown: formatMarkdownReport(result),
    findings: result.findings,
    failedFindings,
    annotations: result.findings.map((finding) => ({
      finding,
      failed: failedFindings.includes(finding),
    })),
  };
}

async function runReviewAction(
  rootInput: string,
  options: GitHubActionOptions,
): Promise<ActionRunArtifacts> {
  const result = await reviewProject(rootInput, {
    base: options.base,
    head: options.head,
    scanOptions: options.scanOptions,
  });
  const findings = [...result.newFindings, ...result.changedRiskyFindings];
  const failedFindings = options.failOn
    ? findings.filter((finding) => isAtLeastSeverity(finding.severity, options.failOn!))
    : [];

  return {
    markdown: formatMarkdownReviewReport(result),
    findings,
    failedFindings,
    annotations: [
      ...result.newFindings.map((finding) => ({
        finding,
        failed: failedFindings.includes(finding),
      })),
      ...result.changedRiskyFindings.map((finding) => ({
        finding,
        failed: failedFindings.includes(finding),
        prefix: "Changed risky file: ",
      })),
    ],
  };
}

interface ActionRunArtifacts {
  markdown: string;
  findings: Finding[];
  failedFindings: Finding[];
  annotations: AnnotationInput[];
}

interface AnnotationInput {
  finding: Finding;
  failed: boolean;
  prefix?: string;
}

function resolveMode(mode: GitHubActionMode | undefined): Exclude<GitHubActionMode, "auto"> {
  if (mode === "scan" || mode === "review") {
    return mode;
  }
  return process.env.GITHUB_BASE_REF || process.env.GITHUB_HEAD_REF ? "review" : "scan";
}

function buildCommentBody(markdown: string): string {
  return [
    commentMarker,
    "## CodeWard",
    "",
    markdown.trim(),
    "",
    "_Generated by CodeWard._",
    "",
  ].join("\n");
}

async function appendStepSummary(markdown: string, stepSummaryPath: string | undefined): Promise<void> {
  if (!stepSummaryPath) {
    return;
  }
  await fs.appendFile(stepSummaryPath, `${markdown.trim()}\n`, "utf8");
}

function writeAnnotations(annotations: AnnotationInput[]): void {
  for (const annotation of annotations.slice(0, annotationLimit)) {
    console.log(formatAnnotation(annotation));
  }
  if (annotations.length > annotationLimit) {
    console.log(
      `::notice title=CodeWard::${annotations.length - annotationLimit} additional CodeWard findings were omitted from annotations.`,
    );
  }
}

function formatAnnotation(annotation: AnnotationInput): string {
  const finding = annotation.finding;
  const level = annotation.failed ? "error" : finding.severity === "info" ? "notice" : "warning";
  const properties = [`title=${escapeAnnotationProperty(`${finding.id} ${finding.title}`)}`];
  if (finding.file) {
    properties.push(`file=${escapeAnnotationProperty(finding.file)}`);
  }

  const message = `${annotation.prefix ?? ""}${finding.message} Fix: ${finding.recommendation}`;
  return `::${level} ${properties.join(",")}::${escapeAnnotationMessage(message)}`;
}

function escapeAnnotationMessage(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeAnnotationProperty(value: string): string {
  return escapeAnnotationMessage(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

async function readPullRequestBody(): Promise<string | undefined> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return undefined;
  }
  try {
    const event = JSON.parse(await fs.readFile(eventPath, "utf8")) as {
      pull_request?: {
        body?: string | null;
      };
    };
    return event.pull_request?.body ?? undefined;
  } catch {
    return undefined;
  }
}

export function githubCommentMarker(): string {
  return commentMarker;
}
