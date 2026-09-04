// Shared fixture materialization for the benchmark runners. A committed
// fixture directory becomes an isolated temporary Git repository with a
// `main` baseline and a change branch, so every runner analyzes the same
// repository shape without touching the checked-in fixture.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dependencyFixtureSuffix = ".fixture";
const dependencyManifestNames = new Set([
  "bun.lock",
  "bun.lockb",
  "build.gradle",
  "build.gradle.kts",
  "cargo.lock",
  "cargo.toml",
  "composer.json",
  "composer.lock",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "gradle.lockfile",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "packages.lock.json",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pom.xml",
  "pubspec.lock",
  "pubspec.yaml",
  "pyproject.toml",
  "requirements.txt",
  "uv.lock",
  "yarn.lock",
]);

export async function materializeFixtureRepo({
  fixtureRoot,
  tempPrefix = "qamap-bench-",
  baseDirs = ["base"],
  baseCommits = [],
  commits = [],
  workingTreeDirs = [],
  baselineMessage = "benchmark baseline",
  branch = "benchmark/change",
  identity = { name: "QAMap Benchmark", email: "benchmark@qamap.local" },
  afterBaseline,
  git = defaultGit,
}) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix));
  const repositoryRoot = path.join(tempRoot, "repo");
  await fs.mkdir(repositoryRoot, { recursive: true });
  for (const dir of baseDirs) {
    await copyFixtureOverlay(path.join(fixtureRoot, dir), repositoryRoot);
  }
  await git(repositoryRoot, ["init", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.email", identity.email]);
  await git(repositoryRoot, ["config", "user.name", identity.name]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", baselineMessage]);
  if (afterBaseline) {
    await afterBaseline({ repositoryRoot, tempRoot });
  }
  if (baseCommits.length > 0) {
    await git(repositoryRoot, ["branch", branch]);
    for (const step of baseCommits) {
      const overlayRoot = path.join(fixtureRoot, step.dir);
      if (await exists(overlayRoot)) {
        await copyFixtureOverlay(overlayRoot, repositoryRoot);
      }
      await git(repositoryRoot, ["add", "-A"]);
      await git(repositoryRoot, ["commit", "--allow-empty", "-m", step.message]);
    }
    await git(repositoryRoot, ["switch", branch]);
  } else {
    await git(repositoryRoot, ["switch", "-c", branch]);
  }
  // An overlay directory may be absent so a step can still record an empty
  // commit; that keeps multi-commit branch shapes expressible.
  for (const step of commits) {
    const overlayRoot = path.join(fixtureRoot, step.dir);
    if (await exists(overlayRoot)) {
      await copyFixtureOverlay(overlayRoot, repositoryRoot);
    }
    await git(repositoryRoot, ["add", "-A"]);
    await git(repositoryRoot, ["commit", "--allow-empty", "-m", step.message]);
  }
  for (const dir of workingTreeDirs) {
    const overlayRoot = path.join(fixtureRoot, dir);
    if (await exists(overlayRoot)) {
      await copyFixtureOverlay(overlayRoot, repositoryRoot);
    }
  }
  return {
    tempRoot,
    repositoryRoot,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
  };
}

export function isDependencyManifestName(filename) {
  const normalized = filename.toLowerCase();
  return dependencyManifestNames.has(normalized) ||
    /^requirements(?:[-_.][a-z0-9_-]+)?\.(?:in|txt)$/i.test(filename) ||
    normalized.endsWith(".csproj");
}

export async function copyFixtureOverlay(source, destination) {
  await fs.cp(source, destination, { recursive: true, force: true });
  await restoreDependencyFixtureManifests(destination);
}

async function restoreDependencyFixtureManifests(root) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const source = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await restoreDependencyFixtureManifests(source);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(dependencyFixtureSuffix)) {
      continue;
    }
    const restoredName = entry.name.slice(0, -dependencyFixtureSuffix.length);
    if (!isDependencyManifestName(restoredName)) {
      continue;
    }
    const target = path.join(root, restoredName);
    await fs.copyFile(source, target);
    await fs.unlink(source);
  }
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function defaultGit(cwd, gitArgs) {
  await execFileAsync("git", gitArgs, { cwd });
}
