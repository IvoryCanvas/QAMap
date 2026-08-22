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

export async function materializeFixtureRepo({
  fixtureRoot,
  tempPrefix = "qamap-bench-",
  baseDirs = ["base"],
  commits = [],
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
    await fs.cp(path.join(fixtureRoot, dir), repositoryRoot, { recursive: true, force: true });
  }
  await git(repositoryRoot, ["init", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.email", identity.email]);
  await git(repositoryRoot, ["config", "user.name", identity.name]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", baselineMessage]);
  if (afterBaseline) {
    await afterBaseline({ repositoryRoot, tempRoot });
  }
  await git(repositoryRoot, ["switch", "-c", branch]);
  // An overlay directory may be absent so a step can still record an empty
  // commit; that keeps multi-commit branch shapes expressible.
  for (const step of commits) {
    const overlayRoot = path.join(fixtureRoot, step.dir);
    if (await exists(overlayRoot)) {
      await fs.cp(overlayRoot, repositoryRoot, { recursive: true, force: true });
    }
    await git(repositoryRoot, ["add", "-A"]);
    await git(repositoryRoot, ["commit", "--allow-empty", "-m", step.message]);
  }
  return {
    tempRoot,
    repositoryRoot,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
  };
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
