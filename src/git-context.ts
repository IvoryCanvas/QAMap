import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BaseRefSource = "explicit" | "environment" | "repository-config" | "git-history";

export interface BaseRefResolution {
  ref: string;
  source: BaseRefSource;
  reason: string;
  equivalentRefs?: string[];
}

export interface GitChangedFile {
  status: string;
  path: string;
  previousPath?: string;
}

export interface ChangedFilesOptions {
  base: string;
  head: string;
  includeWorkingTree?: boolean;
}

interface BaseCandidateScore {
  ref: string;
  commit: string;
  headDistance: number;
  targetDistance: number;
  order: number;
}

const commonBaseNames = ["develop", "development", "dev", "main", "master", "trunk"];
const environmentBaseNames = [
  "QAMAP_BASE_REF",
  "GITHUB_BASE_REF",
  "CI_MERGE_REQUEST_TARGET_BRANCH_NAME",
  "BITBUCKET_PR_DESTINATION_BRANCH",
  "BUILDKITE_PULL_REQUEST_BASE_BRANCH",
  "CHANGE_TARGET",
  "SYSTEM_PULLREQUEST_TARGETBRANCH",
] as const;

export async function resolveBaseRef(
  root: string,
  options: { explicit?: string; head?: string } = {},
): Promise<BaseRefResolution> {
  const head = options.head ?? "HEAD";
  if (options.explicit) {
    await requireRef(root, options.explicit);
    return {
      ref: options.explicit,
      source: "explicit",
      reason: `Selected from the explicit --base value (${options.explicit}).`,
    };
  }

  const remotes = await listRemotes(root);
  for (const variable of environmentBaseNames) {
    const value = process.env[variable]?.trim();
    if (!value) {
      continue;
    }
    const ref = await resolveNamedRef(root, value, remotes);
    if (ref) {
      return {
        ref,
        source: "environment",
        reason: `Selected from ${variable} (${value}).`,
      };
    }
  }

  const currentBranch = await readOptionalGitValue(root, ["branch", "--show-current"]);
  const configuredBase = currentBranch
    ? await readOptionalGitValue(root, ["config", "--get", `branch.${currentBranch}.qamap-base`])
    : undefined;
  const repositoryBase = configuredBase ?? await readOptionalGitValue(root, ["config", "--get", "qamap.base"]);
  if (repositoryBase) {
    const ref = await resolveNamedRef(root, repositoryBase, remotes);
    if (!ref) {
      throw new Error(`Configured QAMap base ref does not exist: ${repositoryBase}`);
    }
    return {
      ref,
      source: "repository-config",
      reason: configuredBase
        ? `Selected from branch.${currentBranch}.qamap-base (${repositoryBase}).`
        : `Selected from qamap.base (${repositoryBase}).`,
    };
  }

  const candidates = await collectBaseCandidates(root, remotes);
  const scored = (
    await Promise.all(candidates.map((ref, order) => scoreBaseCandidate(root, ref, head, order)))
  ).filter((candidate): candidate is BaseCandidateScore => candidate !== undefined);
  scored.sort((left, right) =>
    left.headDistance - right.headDistance ||
    left.targetDistance - right.targetDistance ||
    left.order - right.order
  );

  const selected = scored[0];
  if (!selected) {
    throw new Error(
      "Could not infer a base ref from CI metadata, repository configuration, or Git history. Pass --base <ref>.",
    );
  }
  const equivalentRefs = scored
    .filter((candidate) => candidate.ref !== selected.ref && candidate.commit === selected.commit)
    .map((candidate) => candidate.ref)
    .slice(0, 6);
  const equivalenceReason = equivalentRefs.length > 0
    ? ` ${equivalentRefs.join(", ")} ${equivalentRefs.length === 1 ? "points" : "point"} to the same commit, so the diff is identical.`
    : "";
  return {
    ref: selected.ref,
    source: "git-history",
    reason:
      `Selected the nearest long-lived branch in Git history (${selected.headDistance} head-only commit` +
      `${selected.headDistance === 1 ? "" : "s"}, ${selected.targetDistance} target-only commit` +
      `${selected.targetDistance === 1 ? "" : "s"}).${equivalenceReason}`,
    equivalentRefs: equivalentRefs.length > 0 ? equivalentRefs : undefined,
  };
}

export async function collectChangedFiles(
  root: string,
  options: ChangedFilesOptions,
): Promise<GitChangedFile[]> {
  if (!options.includeWorkingTree) {
    const { stdout } = await git(root, [
      "diff",
      "--find-renames",
      "--name-status",
      "--diff-filter=ACDMRTUXB",
      `${options.base}...${options.head}`,
    ]);
    return parseChangedFiles(stdout);
  }

  const comparisonBase = await resolveMergeBase(root, options.base, options.head);
  const { stdout: trackedStdout } = await git(root, [
    "diff",
    "--find-renames",
    "--name-status",
    "--diff-filter=ACDMRTUXB",
    comparisonBase,
  ]);
  const { stdout: untrackedStdout } = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  return mergeChangedFiles(
    parseChangedFiles(trackedStdout),
    untrackedStdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((filePath) => ({ status: "A", path: filePath })),
  );
}

export async function resolveMergeBase(root: string, base: string, head: string): Promise<string> {
  const { stdout } = await git(root, ["merge-base", base, head]);
  const mergeBase = stdout.trim();
  if (!mergeBase) {
    throw new Error(`Could not find a merge base between ${base} and ${head}.`);
  }
  return mergeBase;
}

export async function readFileAtRef(
  root: string,
  ref: string,
  filePath: string,
): Promise<string | undefined> {
  const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalizedPath || normalizedPath.startsWith("../") || normalizedPath.includes("\0")) {
    return undefined;
  }
  try {
    const { stdout } = await git(root, ["show", `${ref}:./${normalizedPath}`]);
    return stdout;
  } catch {
    return undefined;
  }
}

export async function listFilesAtRef(
  root: string,
  ref: string,
  directory?: string,
): Promise<string[]> {
  const normalizedDirectory = directory
    ?.replaceAll("\\", "/")
    .replace(/^\.\/+|\/+$/g, "");
  if (normalizedDirectory?.startsWith("../") || normalizedDirectory?.includes("\0")) {
    return [];
  }
  try {
    const args = ["ls-tree", "-r", "--name-only", ref];
    if (normalizedDirectory) {
      args.push("--", normalizedDirectory);
    }
    const { stdout } = await git(root, args);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function collectBaseCandidates(root: string, remotes: string[]): Promise<string[]> {
  const candidates: string[] = [];
  for (const remote of remotes) {
    const remoteHead = await readOptionalGitValue(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ]);
    if (remoteHead) {
      candidates.push(remoteHead);
    }
  }
  for (const name of commonBaseNames) {
    for (const remote of remotes) {
      candidates.push(`${remote}/${name}`);
    }
    candidates.push(name);
  }

  const existing: string[] = [];
  for (const candidate of uniqueStrings(candidates)) {
    if (await refExists(root, candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

async function scoreBaseCandidate(
  root: string,
  ref: string,
  head: string,
  order: number,
): Promise<BaseCandidateScore | undefined> {
  try {
    const mergeBase = await resolveMergeBase(root, ref, head);
    const [commit, headDistance, targetDistance] = await Promise.all([
      resolveCommit(root, ref),
      countCommits(root, `${mergeBase}..${head}`),
      countCommits(root, `${mergeBase}..${ref}`),
    ]);
    return { ref, commit, headDistance, targetDistance, order };
  } catch {
    return undefined;
  }
}

async function resolveCommit(root: string, ref: string): Promise<string> {
  const { stdout } = await git(root, ["rev-parse", `${ref}^{commit}`]);
  return stdout.trim();
}

async function countCommits(root: string, range: string): Promise<number> {
  const { stdout } = await git(root, ["rev-list", "--count", range]);
  const value = Number.parseInt(stdout.trim(), 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Could not count commits for ${range}.`);
  }
  return value;
}

async function resolveNamedRef(root: string, value: string, remotes: string[]): Promise<string | undefined> {
  const normalized = value
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");
  const matchedRemote = remotes.find((remote) => normalized.startsWith(`${remote}/`));
  const branchName = matchedRemote ? normalized.slice(matchedRemote.length + 1) : normalized;
  const candidates = [
    value,
    normalized,
    ...remotes.map((remote) => `${remote}/${branchName}`),
    branchName,
  ];
  for (const candidate of uniqueStrings(candidates)) {
    if (await refExists(root, candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function listRemotes(root: string): Promise<string[]> {
  const value = await readOptionalGitValue(root, ["remote"]);
  return value?.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) ?? [];
}

async function requireRef(root: string, ref: string): Promise<void> {
  if (!await refExists(root, ref)) {
    throw new Error(`Base ref does not exist: ${ref}`);
  }
}

async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalGitValue(root: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await git(root, args);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseChangedFiles(stdout: string): GitChangedFile[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseChangedFile);
}

function parseChangedFile(line: string): GitChangedFile {
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
  return { status, path: firstPath };
}

function mergeChangedFiles(...groups: GitChangedFile[][]): GitChangedFile[] {
  const filesByPath = new Map<string, GitChangedFile>();
  for (const group of groups) {
    for (const file of group) {
      filesByPath.set(file.path, file);
    }
  }
  return [...filesByPath.values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("git", args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args.join(" ")} failed: ${message}`);
  }
}
