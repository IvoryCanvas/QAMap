import { evaluateChangeReadiness } from "./eval.js";
import type { EvalOptions, EvalResult } from "./eval.js";
import { reviewProject } from "./review.js";
import type { ReviewResult } from "./review.js";
import type { Finding, ScanOptions } from "./types.js";
import { TOOL_NAME, VERSION } from "./version.js";

export interface VerifyOptions extends EvalOptions {
  scanOptions?: ScanOptions;
}

export interface VerifyResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  workspaceRoot?: string;
  generatedAt: string;
  base: string;
  head: string;
  review: ReviewResult;
  evaluation: EvalResult;
  recommendations: string[];
}

export async function verifyChange(rootInput: string, options: VerifyOptions = {}): Promise<VerifyResult> {
  const scanOptions = options.workspaceRoot
    ? { ...options.scanOptions, workspaceRoot: options.workspaceRoot }
    : options.scanOptions;
  const review = await reviewProject(rootInput, {
    base: options.base,
    head: options.head,
    scanOptions,
  });
  const evaluation = await evaluateChangeReadiness(rootInput, {
    base: options.base,
    head: options.head,
    workspaceRoot: options.workspaceRoot ?? scanOptions?.workspaceRoot,
    includeWorkingTree: options.includeWorkingTree,
    prBody: options.prBody,
    prBodyFile: options.prBodyFile,
    validationCommands: options.validationCommands,
  });

  return {
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    root: evaluation.root,
    workspaceRoot: evaluation.workspaceRoot,
    generatedAt: new Date().toISOString(),
    base: evaluation.base,
    head: evaluation.head,
    review,
    evaluation,
    recommendations: buildRecommendations(review, evaluation),
  };
}

export function formatVerifyReport(result: VerifyResult): string {
  const lines: string[] = [];
  lines.push(`${result.tool.name} Verify`);
  lines.push(`Root: ${result.root}`);
  if (result.workspaceRoot) {
    lines.push(`Workspace root: ${result.workspaceRoot}`);
  }
  lines.push(`Base: ${result.base}`);
  lines.push(`Head: ${result.head}`);
  lines.push(`Readiness: ${result.evaluation.score}/${result.evaluation.maxScore} (${result.evaluation.rating})`);
  lines.push(`Changed files: ${result.evaluation.changedFiles.length}`);
  lines.push(`New findings: ${result.review.newFindings.length}`);
  lines.push(`Changed risky files: ${result.review.changedRiskyFindings.length}`);

  lines.push("");
  lines.push("Verification gates:");
  for (const check of result.evaluation.checks) {
    lines.push(`- ${check.status.toUpperCase()} ${check.title}: ${check.score}/${check.maxScore} - ${check.reason}`);
  }

  if (result.evaluation.testPlanItems.length > 0) {
    lines.push("");
    lines.push("Suggested domain tests:");
    for (const item of result.evaluation.testPlanItems) {
      lines.push(`- ${item.title}: ${item.checks[0]}`);
    }
  }

  if (result.evaluation.suggestedCommands.length > 0) {
    lines.push("");
    lines.push("Suggested commands:");
    for (const command of result.evaluation.suggestedCommands) {
      lines.push(`- ${command}`);
    }
  }

  if (result.recommendations.length > 0) {
    lines.push("");
    lines.push("Next actions:");
    for (const recommendation of result.recommendations) {
      lines.push(`- ${recommendation}`);
    }
  }

  return lines.join("\n");
}

export function formatMarkdownVerifyReport(result: VerifyResult): string {
  const lines: string[] = [];
  lines.push("# CodeWard Verify");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  if (result.workspaceRoot) {
    lines.push(`- Workspace root: \`${escapeMarkdownInline(result.workspaceRoot)}\``);
  }
  lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
  lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
  if (result.evaluation.includeWorkingTree) {
    lines.push("- Includes working tree changes: yes");
  }
  lines.push(`- Readiness: **${result.evaluation.score}/${result.evaluation.maxScore}** (${result.evaluation.rating})`);
  lines.push(`- Changed files: ${result.evaluation.changedFiles.length}`);
  lines.push(`- New findings: ${result.review.newFindings.length}`);
  lines.push(`- Changed risky files: ${result.review.changedRiskyFindings.length}`);
  lines.push("");

  lines.push("## Verification Gates");
  lines.push("");
  lines.push("| Gate | Status | Score | Reason |");
  lines.push("| --- | --- | ---: | --- |");
  for (const check of result.evaluation.checks) {
    lines.push(
      `| ${escapeMarkdownCell(check.title)} | ${check.status} | ${check.score}/${check.maxScore} | ${escapeMarkdownCell(
        check.reason,
      )} |`,
    );
  }
  lines.push("");

  lines.push("## Review Findings");
  lines.push("");
  if (result.review.newFindings.length === 0 && result.review.changedRiskyFindings.length === 0) {
    lines.push("No new CodeWard findings or changed risky files were introduced by this branch.");
  } else {
    for (const finding of [...result.review.newFindings, ...result.review.changedRiskyFindings].slice(0, 12)) {
      const fileSuffix = finding.file ? ` (${escapeMarkdownInline(finding.file)})` : "";
      lines.push(`- \`${finding.id}\` **${escapeMarkdownInline(finding.title)}**${fileSuffix}`);
      lines.push(`  - ${escapeMarkdownInline(finding.message)}`);
      lines.push(`  - Fix: ${escapeMarkdownInline(finding.recommendation)}`);
    }
  }
  lines.push("");

  if (result.evaluation.testPlanItems.length > 0) {
    lines.push("## Suggested Domain Tests");
    lines.push("");
    for (const [index, item] of result.evaluation.testPlanItems.entries()) {
      lines.push(`### ${index + 1}. ${escapeMarkdownInline(item.title)}`);
      lines.push("");
      lines.push(item.reason);
      lines.push("");
      lines.push("Checks:");
      for (const check of item.checks) {
        lines.push(`- ${escapeMarkdownInline(check)}`);
      }
      lines.push("");
    }
  }

  if (result.evaluation.suggestedCommands.length > 0) {
    lines.push("## Suggested Commands");
    lines.push("");
    for (const command of result.evaluation.suggestedCommands) {
      lines.push(`- \`${escapeMarkdownInline(command)}\``);
    }
    lines.push("");
  }

  if (result.recommendations.length > 0) {
    lines.push("## Next Actions");
    lines.push("");
    for (const recommendation of result.recommendations) {
      lines.push(`- ${escapeMarkdownInline(recommendation)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildRecommendations(review: ReviewResult, evaluation: EvalResult): string[] {
  return [
    ...reviewRecommendations(review),
    ...evaluation.recommendations,
  ].filter((recommendation, index, recommendations) => recommendations.indexOf(recommendation) === index);
}

function reviewRecommendations(review: ReviewResult): string[] {
  return [...review.newFindings, ...review.changedRiskyFindings]
    .map((finding: Finding) => finding.recommendation)
    .filter((recommendation, index, recommendations) => recommendations.indexOf(recommendation) === index);
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}

function escapeMarkdownCell(value: string): string {
  return escapeMarkdownInline(value).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
}
