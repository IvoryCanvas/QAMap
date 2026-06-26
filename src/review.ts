import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { scanProject } from "./scanner.js";
import type { Finding, ScanOptions, ScanResult, Severity } from "./types.js";

const execFileAsync = promisify(execFile);
const severityOrder: Severity[] = ["high", "medium", "low", "info"];

export interface ReviewOptions {
  base?: string;
  head?: string;
  scanOptions?: ScanOptions;
}

export interface ChangedFile {
  status: string;
  path: string;
  previousPath?: string;
}

export interface ReviewResult {
  tool: ScanResult["tool"];
  root: string;
  scannedAt: string;
  base: string;
  head: string;
  changedFiles: ChangedFile[];
  newFindings: Finding[];
  counts: ScanResult["counts"];
}

export async function reviewProject(rootInput: string, options: ReviewOptions = {}): Promise<ReviewResult> {
  const root = path.resolve(rootInput);
  const workspaceRoot = options.scanOptions?.workspaceRoot
    ? path.resolve(options.scanOptions.workspaceRoot)
    : undefined;
  const archiveSourceRoot = workspaceRoot ?? root;
  const relativeScanRoot = workspaceRoot ? path.relative(workspaceRoot, root) : "";
  if (workspaceRoot && (relativeScanRoot.startsWith("..") || path.isAbsolute(relativeScanRoot))) {
    throw new Error(`Review path must be inside workspace root: ${root}`);
  }

  const base = options.base ?? (await defaultBaseRef(root));
  const head = options.head ?? "HEAD";
  const changedFiles = await getChangedFiles(root, base, head);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeward-review-"));

  try {
    const baseRoot = path.join(tempRoot, "base");
    const headRoot = path.join(tempRoot, "head");
    await fs.mkdir(baseRoot);
    await fs.mkdir(headRoot);
    await extractGitArchive(archiveSourceRoot, base, baseRoot);
    await extractGitArchive(archiveSourceRoot, head, headRoot);

    const baseScanRoot = relativeScanRoot ? path.join(baseRoot, relativeScanRoot) : baseRoot;
    const headScanRoot = relativeScanRoot ? path.join(headRoot, relativeScanRoot) : headRoot;
    const baseScanOptions = workspaceRoot ? { ...options.scanOptions, workspaceRoot: baseRoot } : options.scanOptions;
    const headScanOptions = workspaceRoot ? { ...options.scanOptions, workspaceRoot: headRoot } : options.scanOptions;
    const baseResult = await scanProject(baseScanRoot, baseScanOptions);
    const headResult = await scanProject(headScanRoot, headScanOptions);
    const baseFingerprints = new Set(baseResult.findings.map(fingerprintFinding));
    const changedPathSet = buildChangedPathSet(changedFiles, relativeScanRoot);
    const newFindings = headResult.findings
      .filter((finding) => !baseFingerprints.has(fingerprintFinding(finding)))
      .filter((finding) => shouldIncludeFinding(finding, changedPathSet))
      .sort(compareFindings);

    return {
      tool: headResult.tool,
      root,
      scannedAt: headResult.scannedAt,
      base,
      head,
      changedFiles,
      newFindings,
      counts: countFindings(newFindings),
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

export function formatReviewReport(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`${result.tool.name} Review`);
  lines.push(`Root: ${result.root}`);
  lines.push(`Base: ${result.base}`);
  lines.push(`Head: ${result.head}`);
  lines.push(`Changed files: ${result.changedFiles.length}`);
  lines.push(
    `New findings: ${result.newFindings.length} (${severityOrder
      .map((severity) => `${severity}: ${result.counts[severity]}`)
      .join(", ")})`,
  );

  if (result.changedFiles.length > 0) {
    lines.push("");
    lines.push("Changed files:");
    for (const file of result.changedFiles.slice(0, 20)) {
      const renameSuffix = file.previousPath ? ` from ${file.previousPath}` : "";
      lines.push(`- ${file.status} ${file.path}${renameSuffix}`);
    }
    if (result.changedFiles.length > 20) {
      lines.push(`- ... ${result.changedFiles.length - 20} more`);
    }
  }

  if (result.newFindings.length === 0) {
    lines.push("");
    lines.push("No new CodeWard findings were introduced by this branch.");
    return lines.join("\n");
  }

  for (const severity of severityOrder) {
    const findings = result.newFindings.filter((finding) => finding.severity === severity);
    if (findings.length === 0) {
      continue;
    }

    lines.push("");
    lines.push(severity.toUpperCase());
    for (const finding of findings) {
      lines.push(`- ${finding.id} ${finding.title}${finding.file ? ` (${finding.file})` : ""}`);
      lines.push(`  ${finding.message}`);
      lines.push(`  Fix: ${finding.recommendation}`);
      if (finding.evidence) {
        lines.push(`  Evidence: ${finding.evidence}`);
      }
    }
  }

  return lines.join("\n");
}

export function formatMarkdownReviewReport(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push("# CodeWard Review");
  lines.push("");
  lines.push(`- Root: \`${escapeMarkdownInline(result.root)}\``);
  lines.push(`- Base: \`${escapeMarkdownInline(result.base)}\``);
  lines.push(`- Head: \`${escapeMarkdownInline(result.head)}\``);
  lines.push(`- Changed files: ${result.changedFiles.length}`);
  lines.push("");
  lines.push("## New Findings");
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("| --- | ---: |");
  for (const severity of severityOrder) {
    lines.push(`| ${severity} | ${result.counts[severity]} |`);
  }

  if (result.changedFiles.length > 0) {
    lines.push("");
    lines.push("## Changed Files");
    lines.push("");
    for (const file of result.changedFiles.slice(0, 20)) {
      const renameSuffix = file.previousPath ? ` from \`${escapeMarkdownInline(file.previousPath)}\`` : "";
      lines.push(`- \`${file.status}\` \`${escapeMarkdownInline(file.path)}\`${renameSuffix}`);
    }
    if (result.changedFiles.length > 20) {
      lines.push(`- ... ${result.changedFiles.length - 20} more`);
    }
  }

  lines.push("");
  if (result.newFindings.length === 0) {
    lines.push("No new CodeWard findings were introduced by this branch.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Findings");
  lines.push("");
  for (const severity of severityOrder) {
    const findings = result.newFindings.filter((finding) => finding.severity === severity);
    if (findings.length === 0) {
      continue;
    }

    lines.push(`### ${severity.toUpperCase()}`);
    lines.push("");
    for (const finding of findings) {
      const fileSuffix = finding.file ? ` (${escapeMarkdownInline(finding.file)})` : "";
      lines.push(`- \`${finding.id}\` **${escapeMarkdownInline(finding.title)}**${fileSuffix}`);
      lines.push(`  - Message: ${escapeMarkdownInline(finding.message)}`);
      lines.push(`  - Fix: ${escapeMarkdownInline(finding.recommendation)}`);
      if (finding.evidence) {
        lines.push(`  - Evidence: \`${escapeMarkdownInline(finding.evidence)}\``);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function defaultBaseRef(root: string): Promise<string> {
  for (const candidate of ["origin/main", "main", "origin/master", "master"]) {
    try {
      await git(root, ["rev-parse", "--verify", "--quiet", candidate]);
      return candidate;
    } catch {
      // Try the next common default branch name.
    }
  }
  throw new Error("Could not infer a base ref. Pass --base <ref>.");
}

async function getChangedFiles(root: string, base: string, head: string): Promise<ChangedFile[]> {
  const { stdout } = await git(root, ["diff", "--name-status", "--diff-filter=ACMRTUXB", `${base}...${head}`]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseChangedFile);
}

function parseChangedFile(line: string): ChangedFile {
  const [status, firstPath, secondPath] = line.split(/\t+/);
  if (!status || !firstPath) {
    throw new Error(`Could not parse git diff entry: ${line}`);
  }
  if (status.startsWith("R") || status.startsWith("C")) {
    return {
      status,
      previousPath: firstPath,
      path: secondPath ?? firstPath,
    };
  }
  return {
    status,
    path: firstPath,
  };
}

async function extractGitArchive(root: string, ref: string, outputDirectory: string): Promise<void> {
  const archivePath = path.join(outputDirectory, "archive.tar");
  await git(root, ["archive", "--format=tar", `--output=${archivePath}`, ref]);
  await execFileAsync("tar", ["-xf", archivePath, "-C", outputDirectory]);
  await fs.rm(archivePath, { force: true });
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}

function shouldIncludeFinding(finding: Finding, changedPathSet: Set<string | undefined>): boolean {
  if (!finding.file) {
    return true;
  }
  return changedPathSet.has(finding.file);
}

function buildChangedPathSet(changedFiles: ChangedFile[], relativeScanRoot: string): Set<string | undefined> {
  const paths = new Set<string | undefined>();
  for (const file of changedFiles) {
    addChangedPath(paths, file.path, relativeScanRoot);
    addChangedPath(paths, file.previousPath, relativeScanRoot);
  }
  return paths;
}

function addChangedPath(paths: Set<string | undefined>, filePath: string | undefined, relativeScanRoot: string): void {
  if (!filePath) {
    return;
  }
  paths.add(filePath);

  if (!relativeScanRoot) {
    return;
  }

  const prefix = `${relativeScanRoot.split(path.sep).join("/")}/`;
  if (filePath.startsWith(prefix)) {
    paths.add(filePath.slice(prefix.length));
  }
}

function fingerprintFinding(finding: Finding): string {
  return [finding.id, finding.file ?? "", finding.title, finding.message, finding.evidence ?? ""].join("\0");
}

function compareFindings(left: Finding, right: Finding): number {
  const severityDelta = severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  const idDelta = left.id.localeCompare(right.id);
  if (idDelta !== 0) {
    return idDelta;
  }
  return (left.file ?? "").localeCompare(right.file ?? "");
}

function countFindings(findings: Finding[]): ScanResult["counts"] {
  return findings.reduce<ScanResult["counts"]>(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { info: 0, low: 0, medium: 0, high: 0 },
  );
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("`", "'");
}
