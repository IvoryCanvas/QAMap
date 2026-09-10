import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildLocalQaHandoff, type LocalQaHandoffReceipt } from "./qa-handoff.js";
import {
  formatAgentQaDraft,
  formatAgentQaFullReport,
  formatMarkdownQaDraft,
  type QaDraftResult,
} from "./qa.js";

export interface LocalQaReportReceipt {
  schema: { name: "qamap.qa.report"; version: 1 };
  analysis: "complete";
  execution: { status: "not-run"; performed: false };
  noLlmToken: true;
  files: { report: string; summary: string; full: string };
}

export function writeLocalQaReport(result: QaDraftResult, outputDirectory?: string): Promise<LocalQaReportReceipt>;
export function writeLocalQaReport(result: QaDraftResult, outputDirectory: string | undefined,
  options: { handoff: true }): Promise<LocalQaHandoffReceipt>;
export async function writeLocalQaReport(
  result: QaDraftResult,
  outputDirectory = path.join(os.homedir(), "QAMap-reports"),
  options: { handoff?: boolean } = {},
): Promise<LocalQaReportReceipt | LocalQaHandoffReceipt> {
  if (result.execution.status !== "not-run" || result.execution.performed) {
    throw new Error("Local QA reports accept static analysis only; use qa run for execution receipts.");
  }
  const requestedDirectory = path.resolve(outputDirectory);
  await fs.mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(requestedDirectory)).isSymbolicLink()) {
    throw new Error("Report output directory must not be a symbolic link.");
  }
  // Canonicalize platform aliases, then isolate every run in its own private directory.
  const parent = await fs.realpath(requestedDirectory);
  const directory = await fs.mkdtemp(path.join(parent, "qa-"));
  try {
    await fs.chmod(directory, 0o700);
    const files = {
      report: path.join(directory, "report.md"),
      summary: path.join(directory, "summary.json"),
      full: path.join(directory, "report.json"),
    };
    const summary = formatAgentQaDraft(result, { fullReportPath: files.full });
    const contents = [
      [files.full, formatAgentQaFullReport(result)],
      [files.summary, summary],
      [files.report, formatMarkdownQaDraft(result)],
    ];
    for (const [filename, content] of contents) {
      await fs.writeFile(filename, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
    // Publish the receipt only after every artifact has been written successfully.
    const receipt: LocalQaReportReceipt = {
      schema: { name: "qamap.qa.report", version: 1 },
      analysis: "complete",
      execution: { status: "not-run", performed: false },
      noLlmToken: true,
      files,
    };
    if (!options.handoff) return receipt;
    const handoff = await buildLocalQaHandoff(result, receipt, JSON.parse(summary));
    await fs.writeFile(path.join(directory, "handoff.json"), `${JSON.stringify(handoff)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 });
    return handoff;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function formatLocalQaReportReceipt(receipt: LocalQaReportReceipt, human: boolean): string {
  if (!human) return `${JSON.stringify(receipt)}\n`;
  const displayPath = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return [
    "+----------------------------------+",
    "| QAMap analysis complete          |",
    "| Tests: not-run                   |",
    "+----------------------------------+",
    "",
    `Report: ${displayPath(receipt.files.report)}`,
    pathToFileURL(receipt.files.report).href,
    "",
    "Share this summary path only when you want interpretation:",
    displayPath(receipt.files.summary),
    `Full evidence: ${displayPath(receipt.files.full)}`,
    "",
  ].join("\n");
}
