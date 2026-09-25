#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const publishedSmokeVersion = "0.5.0";

export async function runReleaseSmoke({ version = publishedSmokeVersion, cli, tempDirectory = os.tmpdir() } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Use an exact release version, not a tag or range.");
  }
  const localCli = cli ? path.resolve(cli) : null;
  const temporary = await fs.mkdtemp(path.join(tempDirectory, "qamap-release-smoke-"));
  const fixture = path.join(temporary, "fixture");
  const runtime = path.join(temporary, "runtime");
  const env = {
    ...process.env,
    HOME: temporary,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CACHE_HOME: path.join(temporary, "cache"),
    npm_config_cache: path.join(temporary, "npm-cache"),
    npm_config_userconfig: path.join(temporary, "npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(temporary, "gitconfig"),
    NO_COLOR: "1",
  };
  // Do not let the caller's Git location redirect fixture operations.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = path.join(temporary, "gitconfig");
  const run = async (command, args, cwd = fixture) => exec(command, args, {
    cwd, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  const git = (args) => run("git", [
    "-c", "user.name=Fixture Maintainer", "-c", "user.email=fixture@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args,
  ]);
  try {
    await fs.mkdir(path.join(fixture, "src"), { recursive: true });
    await fs.mkdir(runtime);
    await fs.writeFile(path.join(temporary, "npmrc"), "");
    await fs.writeFile(path.join(temporary, "gitconfig"), "");
    let binary = localCli;
    if (!binary) {
      await fs.writeFile(path.join(runtime, "package.json"), JSON.stringify({ private: true }));
      await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false",
        "--registry=https://registry.npmjs.org", `@ivorycanvas/qamap@${version}`], runtime);
      binary = path.join(runtime, "node_modules/@ivorycanvas/qamap/dist/cli.js");
      const installed = JSON.parse(await fs.readFile(path.join(runtime, "node_modules/@ivorycanvas/qamap/package.json"), "utf8"));
      assert.equal(installed.version, version);
    }
    const qamap = async (args) => (await run(process.execPath, [binary, ...args])).stdout;
    assert.equal((await qamap(["--version"])).trim(), version);
    await fs.writeFile(path.join(fixture, "package.json"), JSON.stringify({
      name: "release-smoke-fixture", private: true, scripts: { test: "node --test" },
    }));
    await fs.writeFile(path.join(fixture, "src/preference.ts"), "export function savePreference(value: string) { return value; }\n");
    await git(["init", "-b", "main"]);
    await git(["add", "."]);
    await git(["commit", "-m", "test: baseline preference behavior"]);
    // The generated manifest belongs only to this disposable fixture.
    await qamap(["manifest", "init", "."]);
    await fs.access(path.join(fixture, ".qamap/manifest.yaml"));
    await git(["add", ".qamap/manifest.yaml"]);
    await git(["commit", "-m", "test: declare fixture verification context"]);
    await fs.writeFile(path.join(fixture, "src/preference.ts"),
      "export function savePreference(value: string) {\n  if (!value.trim()) throw new Error('Preference is required');\n  return value.trim();\n}\n");
    await git(["add", "src/preference.ts"]);
    await git(["commit", "-m", "fix: reject empty preference values"]);
    const refs = ["--base", "HEAD~1", "--head", "HEAD"];
    const validation = JSON.parse(await qamap(["manifest", "validate", ".", "--format", "json"]));
    assert.ok(["valid", "needs-work"].includes(validation.status), "fixture manifest must be present and schema-valid");
    const qa = JSON.parse(await qamap(["qa", ".", ...refs, "--format", "agent"]));
    assert.equal(qa.schema.name, "qamap.qa");
    assert.equal(qa.execution.status, "not-run");
    assert.equal(qa.execution.performed, false);
    assert.ok(qa.intents.length > 0, "the fixture change must produce intent evidence");
    await qamap(["manifest", "explain", ".", ...refs]);
    const beforeDraft = await fixtureSnapshot(fixture);
    const draft = JSON.parse(await qamap(["e2e", "draft", ".", ...refs, "--dry-run", "--format", "json"]));
    assert.equal(draft.dryRun, true);
    assert.deepEqual(await fixtureSnapshot(fixture), beforeDraft, "dry-run must not write fixture files");
    return {
      schema: { name: "qamap.release-smoke", version: 1 },
      source: localCli ? "local-cli" : "published-package",
      version,
      status: "passed",
      manifestStatus: validation.status,
      checks: ["exact-version", "manifest-init", "manifest-validate", "qa-static", "manifest-explain", "draft-dry-run-no-writes"],
      execution: { status: "not-run", performed: false },
      interpretation: "Static CLI and draft-preview smoke only; no repository test, browser, device, or provider was run.",
      cleanup: "removed",
    };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function fixtureSnapshot(root, directory = "") {
  const result = {};
  for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await fixtureSnapshot(root, relative));
    else result[relative] = (await fs.readFile(path.join(root, relative))).toString("base64");
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!["--version", "--cli"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) {
      throw new Error("Usage: node scripts/release-smoke.mjs [--version X.Y.Z] [--cli path/to/cli.js]");
    }
    options[args[i].slice(2)] = args[++i];
  }
  console.log(JSON.stringify(await runReleaseSmoke(options), null, 2));
}
