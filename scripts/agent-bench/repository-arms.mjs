// Optional cache treatment for the existing agent harness, not another agent loop.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareQualityGatedRuns } from "./aggregate.mjs";

const execFileAsync = promisify(execFile);
export const REPOSITORY_ARMS = ["qamap-cold", "qamap-warm"];
export const isRepositoryArm = (arm) => REPOSITORY_ARMS.includes(arm);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function createRepositoryEnvironment(tempRoot) {
  const state = path.join(tempRoot, "agent-state");
  const env = {};
  // Only process-launch essentials are inherited. No provider variables or
  // user config, credentials, Node preload hooks, or cache switches are read.
  for (const key of ["PATH", "SystemRoot", "WINDIR", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, directory] of Object.entries({
    HOME: "home", XDG_CACHE_HOME: "cache", XDG_CONFIG_HOME: "config", TMPDIR: "tmp",
  })) {
    env[key] = path.join(state, directory);
    await fs.mkdir(env[key], { recursive: true, mode: 0o700 });
  }
  return { ...env, TMP: env.TMPDIR, TEMP: env.TMPDIR, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(env.HOME, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

export async function prebuildRepositoryIndex({ repositoryRoot, cliPath, env, dryRun = false }) {
  const startedAt = Date.now();
  const { stdout } = await execFileAsync(process.execPath, [
    fileURLToPath(new URL("./repository-snapshot.mjs", import.meta.url)),
    path.join(path.dirname(cliPath), "repository-index.js"), repositoryRoot,
  ], { cwd: repositoryRoot, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
  const snapshot = JSON.parse(stdout);
  if (snapshot.reuse?.status !== "cold" || snapshot.reuse?.storage !== "saved"
    || !(snapshot.indexedFiles > 0) || snapshot.reuse.reusedFiles !== 0) {
    throw new Error("Warm baseline index was not built and saved in an empty isolated cache.");
  }
  return { status: "prebuilt", phase: "base-before-head-overlay", sameRoot: true,
    wallClockMs: dryRun ? null : Date.now() - startedAt, ...snapshot };
}

export async function repositoryPairing({ task, repositoryRoot, env, provider, model, system, tools, maxOutputTokens }) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "main^{tree}", "HEAD^{tree}"], {
    cwd: repositoryRoot, env, timeout: 10_000,
  });
  const fixtureTrees = stdout.trim().split(/\r?\n/);
  if (fixtureTrees.length !== 2 || fixtureTrees[0] === fixtureTrees[1]) {
    throw new Error("Repository arms require a meaningful base-to-head fixture change.");
  }
  return {
    taskSha256: hash({ id: task.id, prompt: task.prompt, successCriteria: task.successCriteria, maxTurns: task.maxTurns }),
    systemPromptSha256: hash(system), toolsSha256: hash(tools),
    provider, model, maxOutputTokens, fixtureTrees,
    carryOver: "none",
  };
}

export function compareRepositoryArms(arms, status) {
  const pairs = [["generic", "qamap-cold"], ["generic", "qamap-warm"], ["qamap-cold", "qamap-warm"]];
  return pairs.filter(([left, right]) => arms[left] && arms[right]).map(([baselineArm, candidateArm]) => {
    const baseline = arms[baselineArm].runs;
    const candidate = arms[candidateArm].runs;
    const matched = baseline.length > 0 && baseline.length === candidate.length
      && baseline.every((run, index) => {
        const other = candidate[index];
        if (!validPairing(run.pairing) || !validPairing(other.pairing)
          || run.run !== index + 1 || other.run !== index + 1) return false;
        const { toolsSha256: leftTools, ...left } = run.pairing;
        const { toolsSha256: rightTools, ...right } = other.pairing;
        return hash(left) === hash(right) && (baselineArm === "generic" || leftTools === rightTools);
      });
    const result = compareQualityGatedRuns({ generic: arms[baselineArm], qamap: arms[candidateArm] }, status);
    if (status === "measured" && !matched) Object.assign(result, {
      status: "unpaired", eligible: false, qualityPassed: false,
      inputTokensMedianDifference: null, outputTokensMedianDifference: null,
    });
    return { baselineArm, candidateArm, ...result };
  });
}

function validPairing(value) {
  return value && ["taskSha256", "systemPromptSha256", "toolsSha256"].every((key) => /^[a-f0-9]{64}$/.test(value[key]))
    && typeof value.provider === "string" && value.provider.length > 0
    && typeof value.model === "string" && value.model.length > 0
    && Number.isSafeInteger(value.maxOutputTokens) && value.maxOutputTokens > 0
    && Array.isArray(value.fixtureTrees) && value.fixtureTrees.length === 2
    && value.fixtureTrees.every((tree) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree))
    && value.fixtureTrees[0] !== value.fixtureTrees[1] && value.carryOver === "none";
}
