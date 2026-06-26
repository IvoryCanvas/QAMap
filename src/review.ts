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

export interface ChangedRiskyFinding extends Finding {
  file: string;
  status: string;
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
  changedRiskyFindings: ChangedRiskyFinding[];
  counts: ScanResult["counts"];
  changedRiskyCounts: ScanResult["counts"];
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
  const diffRoot = workspaceRoot ?? root;
  const changedFiles = scopeChangedFiles(await getChangedFiles(diffRoot, base, head), relativeScanRoot);
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
    const baseStableKeys = new Set(baseResult.findings.map(stableFindingKey));
    const changedPathSet = buildChangedPathSet(changedFiles, relativeScanRoot);
    const changedFileMap = buildChangedFileMap(changedFiles, relativeScanRoot);
    const newFindings = headResult.findings
      .filter((finding) => !baseFingerprints.has(fingerprintFinding(finding)))
      .filter((finding) => shouldIncludeFinding(finding, changedPathSet))
      .sort(compareFindings);
    const newFingerprints = new Set(newFindings.map(fingerprintFinding));
    const changedRiskyFindings = headResult.findings
      .filter((finding): finding is Finding & { file: string } => Boolean(finding.file))
      .filter((finding) => baseStableKeys.has(stableFindingKey(finding)))
      .filter((finding) => !newFingerprints.has(fingerprintFinding(finding)))
      .flatMap((finding) => {
        const changedFile = changedFileMap.get(finding.file);
        if (!changedFile) {
          return [];
        }
        return [toChangedRiskyFinding(finding, changedFile)];
      })
      .sort(compareFindings);

    return {
      tool: headResult.tool,
      root,
      scannedAt: headResult.scannedAt,
      base,
      head,
      changedFiles,
      newFindings,
      changedRiskyFindings,
      counts: countFindings(newFindings),
      changedRiskyCounts: countFindings(changedRiskyFindings),
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
  lines.push(
    `Changed risky files: ${result.changedRiskyFindings.length} (${severityOrder
      .map((severity) => `${severity}: ${result.changedRiskyCounts[severity]}`)
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

  if (result.newFindings.length === 0 && result.changedRiskyFindings.length === 0) {
    lines.push("");
    lines.push("No new CodeWard findings or changed risky files were introduced by this branch.");
    return lines.join("\n");
  }

  if (result.newFindings.length === 0) {
    lines.push("");
    lines.push("No new CodeWard findings were introduced by this branch.");
  } else {
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
  }

  if (result.changedRiskyFindings.length > 0) {
    lines.push("");
    lines.push("Changed risky files:");
    for (const finding of result.changedRiskyFindings) {
      const renameSuffix = finding.previousPath ? ` from ${finding.previousPath}` : "";
      lines.push(`- ${finding.id} ${finding.title} (${finding.file}, ${finding.status}${renameSuffix})`);
      lines.push("  Existing finding on base; this file changed in the branch.");
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
  lines.push(`- Changed risky files: ${result.changedRiskyFindings.length}`);
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
  if (result.newFindings.length === 0 && result.changedRiskyFindings.length === 0) {
    lines.push("No new CodeWard findings or changed risky files were introduced by this branch.");
    lines.push("");
    return lines.join("\n");
  }

  if (result.newFindings.length === 0) {
    lines.push("No new CodeWard findings were introduced by this branch.");
    lines.push("");
  } else {
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
  }

  if (result.changedRiskyFindings.length > 0) {
    lines.push("## Changed Risky Files");
    lines.push("");
    lines.push("| Rule | Severity | File | Status | Recommendation |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const finding of result.changedRiskyFindings) {
      const renameSuffix = finding.previousPath ? ` from ${finding.previousPath}` : "";
      lines.push(
        `| \`${finding.id}\` | ${finding.severity} | \`${escapeMarkdownCell(finding.file)}\` | \`${escapeMarkdownCell(
          `${finding.status}${renameSuffix}`,
        )}\` | ${escapeMarkdownCell(finding.recommendation)} |`,
      );
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

function scopeChangedFiles(changedFiles: ChangedFile[], relativeScanRoot: string): ChangedFile[] {
  if (!relativeScanRoot) {
    return changedFiles;
  }
  const posixRoot = relativeScanRoot.split(path.sep).join("/");
  const prefix = `${posixRoot}/`;
  return changedFiles.flatMap((file): ChangedFile[] => {
    const scopedPath = stripScopedPath(file.path, posixRoot, prefix);
    if (!scopedPath) {
      return [];
    }
    const previousPath = file.previousPath
      ? stripScopedPath(file.previousPath, posixRoot, prefix) ?? file.previousPath
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

function toChangedRiskyFinding(finding: Finding & { file: string }, changedFile: ChangedFile): ChangedRiskyFinding {
  return {
    ...finding,
    status: changedFile.status,
    previousPath: changedFile.previousPath,
  };
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

function buildChangedFileMap(changedFiles: ChangedFile[], relativeScanRoot: string): Map<string, ChangedFile> {
  const paths = new Map<string, ChangedFile>();
  for (const file of changedFiles) {
    addChangedFile(paths, file.path, file, relativeScanRoot);
    addChangedFile(paths, file.previousPath, file, relativeScanRoot);
  }
  return paths;
}

function addChangedFile(
  paths: Map<string, ChangedFile>,
  filePath: string | undefined,
  changedFile: ChangedFile,
  relativeScanRoot: string,
): void {
  if (!filePath) {
    return;
  }
  paths.set(filePath, changedFile);

  if (!relativeScanRoot) {
    return;
  }

  const prefix = `${relativeScanRoot.split(path.sep).join("/")}/`;
  if (filePath.startsWith(prefix)) {
    paths.set(filePath.slice(prefix.length), changedFile);
  }
}

function fingerprintFinding(finding: Finding): string {
  return [finding.id, finding.file ?? "", finding.title, finding.message, finding.evidence ?? ""].join("\0");
}

function stableFindingKey(finding: Finding): string {
  return [finding.id, finding.file ?? "", finding.title].join("\0");
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

function escapeMarkdownCell(value: string): string {
  return escapeMarkdownInline(value).replaceAll("|", "\\|");
}
