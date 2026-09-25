import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { copyFixtureOverlay } from "./lib/fixture-repo.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function run(command, args, cwd) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`, {
      cause: error,
    });
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qamap-plugin-smoke-"));

try {
  const packDirectory = path.join(tempRoot, "pack");
  const harness = path.join(tempRoot, "harness");
  const fixture = path.join(tempRoot, "fixture");
  const emptyNpmrc = path.join(tempRoot, "npmrc");
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(harness, { recursive: true }),
    mkdir(fixture, { recursive: true }),
    writeFile(emptyNpmrc, ""),
  ]);

  const packed = await run(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    repositoryRoot,
  );
  const packResult = JSON.parse(packed.stdout)[0];
  const tarball = path.join(packDirectory, packResult.filename);
  const packedFiles = new Set(packResult.files.map((entry) => entry.path));
  for (const required of [
    ".codex-plugin/plugin.json",
    "skills/qamap-pr-qa/SKILL.md",
    "skills/qamap-pr-qa/agents/openai.yaml",
    "skills/qamap-pr-qa/references/advanced-workflow.md",
    "skills/qamap-pr-qa/assets/qamap-logo.png",
    "skills/qamap-pr-qa/assets/qamap-logo.svg",
    "plugin/submission.json",
    "PRIVACY.md",
    "SUPPORT.md",
    "TERMS.md",
  ]) {
    assert.ok(packedFiles.has(required), `${required} is missing from the npm tarball`);
  }

  await writeFile(
    path.join(harness, "package.json"),
    JSON.stringify({ name: "qamap-plugin-smoke", private: true }),
  );
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--userconfig",
      emptyNpmrc,
      tarball,
    ],
    harness,
  );

  const binary = path.join(
    harness,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "qamap.cmd" : "qamap",
  );
  const version = (await run(binary, ["--version"], harness)).stdout.trim();
  assert.equal(version, packResult.version);

  const benchmark = path.join(
    repositoryRoot,
    "test/benchmarks/web-symbol-annotated-renewal",
  );
  await copyFixtureOverlay(path.join(benchmark, "base"), fixture);
  await run("git", ["init", "-b", "main"], fixture);
  await run("git", ["config", "user.name", "QAMap Smoke"], fixture);
  await run("git", ["config", "user.email", "smoke@qamap.local"], fixture);
  await run("git", ["add", "."], fixture);
  await run("git", ["commit", "-m", "test: baseline renewal behavior"], fixture);

  await copyFixtureOverlay(path.join(benchmark, "head"), fixture);
  await run("git", ["add", "."], fixture);
  await run("git", ["commit", "-m", "feat: prevent duplicate renewal requests"], fixture);

  const analysis = await run(
    binary,
    ["qa", ".", "--base", "HEAD~1", "--head", "HEAD", "--format", "agent"],
    fixture,
  );
  const payload = JSON.parse(analysis.stdout);
  assert.equal(payload.schema.name, "qamap.qa");
  assert.equal(payload.execution.status, "not-run");
  assert.ok(payload.intents.length > 0, "fresh install must infer at least one change intent");
  assert.ok(payload.intents[0].scenarios.length > 0, "fresh install must route at least one QA scenario");
  assert.ok(payload.traces.length > 0, "fresh install must preserve at least one evidence trace");
  assert.ok(
    payload.traces.some((trace) => trace.source?.file),
    "at least one evidence trace must include its source file",
  );
  assert.ok(payload.route.nextAction, "fresh install must select one next action");
  assert.ok(Buffer.byteLength(analysis.stdout) <= 4 * 1024, "agent output must stay within 4 KiB");

  const handoffOutput = await run(binary,
    ["qa", "report", ".", "--base", "HEAD~1", "--handoff", "--output", path.join(tempRoot, "reports")], fixture);
  const handoff = JSON.parse(handoffOutput.stdout);
  assert.equal(handoff.schema.name, "qamap.qa.handoff");
  assert.equal(handoff.summary.execution.status, "not-run");
  assert.equal(handoff.execution.performed, false);
  assert.deepEqual(handoff.recovery.repository, ["/repositoryIndex", "/repositoryImpact"]);
  assert.equal(handoff.reviewEvidence.limits.responseBytes, 16384);
  assert.ok(Buffer.byteLength(handoffOutput.stdout) <= 16384);
  assert.deepEqual(JSON.parse(await readFile(handoff.files.summary, "utf8")), handoff.summary);
  const full = JSON.parse(await readFile(handoff.files.full, "utf8"));
  for (const pointer of Object.values(handoff.recovery).flat()) {
    assert.notEqual(pointer.split("/").slice(1).reduce((value, key) => value?.[key], full), undefined,
      `fresh-install recovery pointer is missing: ${pointer}`);
  }
  const briefOutput = await run(binary, ["qa", "brief", ".", "--base", "HEAD~1", "--output", path.join(tempRoot, "brief-reports")], fixture);
  assert.match(briefOutput.stdout, /^QAMap brief: HEAD~1\.\.\.HEAD/);
  assert.match(briefOutput.stdout, /no tests were run, no LLM was called/);
  assert.match(briefOutput.stdout, /== Changes ==/);
  assert.ok(Buffer.byteLength(briefOutput.stdout) <= 24000, "brief must stay within its default limit");
  const installedSkill = await readFile(path.join(harness,
    "node_modules/@ivorycanvas/qamap/skills/qamap-pr-qa/SKILL.md"), "utf8");
  assert.equal(installedSkill, await readFile(path.join(repositoryRoot, "skills/qamap-pr-qa/SKILL.md"), "utf8"));

  const agentProject = path.join(tempRoot, "agent-project");
  await mkdir(agentProject);
  const personalGuidance = "# Project guidance\nPreserve existing instructions.\n";
  await writeFile(path.join(agentProject, "AGENTS.md"), personalGuidance);
  await run(binary, ["init", agentProject, "--agent"], agentProject);
  for (const host of [".agents", ".claude"]) {
    assert.equal(await readFile(path.join(agentProject, host, "skills/qamap-pr-qa/SKILL.md"), "utf8"), installedSkill);
    assert.match(await readFile(path.join(agentProject, host, "skills/qamap-pr-qa/references/advanced-workflow.md"), "utf8"),
      /execution\.gitState/);
  }
  const instructions = await readFile(path.join(agentProject, "AGENTS.md"), "utf8");
  assert.match(instructions, /qa brief/);
  assert.ok(instructions.includes(`@ivorycanvas/qamap@${version} qa brief`));
  assert.ok(instructions.startsWith(personalGuidance));
  assert.doesNotMatch(instructions, /qamap:review-mode:report/);
  await run(binary, ["init", agentProject, "--agent", "--review-mode", "report"], agentProject);
  const optedIn = await readFile(path.join(agentProject, "AGENTS.md"), "utf8");
  assert.match(optedIn, /qamap:review-mode:report/);
  assert.ok(optedIn.startsWith(personalGuidance));
  await run(binary, ["init", agentProject, "--agent"], agentProject);
  assert.equal(await readFile(path.join(agentProject, "AGENTS.md"), "utf8"), optedIn);
  await run(binary, ["init", agentProject, "--agent", "--review-mode", "ask"], agentProject);
  assert.equal(await readFile(path.join(agentProject, "AGENTS.md"), "utf8"), instructions);
  await assert.rejects(run(binary, ["init", agentProject, "--agent", "--review-mode", "automatic"], agentProject), /review-mode/);
  assert.equal(await readFile(path.join(agentProject, "AGENTS.md"), "utf8"), instructions);
  await assert.rejects(run(binary, ["qa", "read", handoff.evidenceArchive.review.file,
    "--sha256", "0".repeat(64), "--bytes", String(handoff.evidenceArchive.review.bytes)], fixture), /Review evidence no longer matches its receipt/);

  const installedManifest = JSON.parse(
    await readFile(
      path.join(harness, "node_modules/@ivorycanvas/qamap/.codex-plugin/plugin.json"),
      "utf8",
    ),
  );
  assert.equal(installedManifest.version, version);

  console.log(
    `Plugin package smoke passed: packed ${packResult.files.length} files, installed ${version}, `
    + `and produced ${payload.intents.length} intent with ${payload.traces.length} evidence trace(s).`,
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
