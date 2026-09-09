import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareRepositoryArms, createRepositoryEnvironment, prebuildRepositoryIndex, repositoryPairing } from "../scripts/agent-bench/repository-arms.mjs";
import { createIORecorder } from "../scripts/agent-bench/io.mjs";
import { createScriptedProvider } from "../scripts/agent-bench/scripted.mjs";
import { formatTextReport } from "../scripts/agent-bench/report.mjs";
import { createToolExecutor, toolsForArm, toolSchemaSha256 } from "../scripts/agent-bench/tools.mjs";
import { materializeFixtureRepo } from "../scripts/lib/fixture-repo.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(root, "dist/cli.js");

test("optional QAMap arms keep exactly the existing tools and offline script", async () => {
  for (const arm of ["qamap-cold", "qamap-warm"]) {
    assert.deepEqual(toolsForArm(arm), toolsForArm("qamap"));
    assert.equal(toolSchemaSha256(toolsForArm(arm)), toolSchemaSha256(toolsForArm("qamap")));
    for (let turn = 0; turn < 5; turn++) {
      const messages = Array.from({ length: turn }, () => ({ role: "assistant" }));
      const actual = await createScriptedProvider({ arm }).complete({ messages });
      assert.deepEqual(actual, await createScriptedProvider({ arm: "qamap" }).complete({ messages }));
      assert.equal(actual.usage.inputTokens, null);
    }
  }
  assert.throws(() => toolsForArm("unknown"), /Unknown benchmark arm/);
});

test("same-root warm baseline is incremental after the head change; cold remains cold", async () => {
  const states = [];
  try {
    for (const arm of ["qamap-cold", "qamap-warm"]) {
      let env;
      let setup;
      let baselineRoot;
      const prepared = await materializeFixtureRepo({
        fixtureRoot: path.join(root, "test/benchmarks/web-symbol-annotated-renewal"),
        tempPrefix: "qamap-agent-repository-test-",
        commits: [{ dir: "head", message: "fix: prevent duplicate renewal requests" }],
        afterBaseline: async ({ repositoryRoot, tempRoot }) => {
          baselineRoot = repositoryRoot;
          env = await createRepositoryEnvironment(tempRoot);
          if (arm === "qamap-warm") setup = await prebuildRepositoryIndex({ repositoryRoot, cliPath, env, dryRun: true });
        },
      });
      states.push({ ...prepared, env });
      assert.equal(prepared.repositoryRoot, baselineRoot);
      assert.equal(env.QAMAP_BENCH_API_KEY, undefined);
      assert.equal(env.NODE_OPTIONS, undefined);
      assert.equal(env.QAMAP_REPOSITORY_CACHE, undefined);
      assert.ok(!env.TMPDIR.startsWith(prepared.repositoryRoot + path.sep));
      const executor = await createToolExecutor({ repositoryRoot: prepared.repositoryRoot, cliPath, env, measureIO: true });
      const output = await executor.execute("qamap_qa", { format: "agent" });
      assert.doesNotMatch(output, /\/var\/folders|\/private\/var|\/tmp\//);
      const metrics = executor.measurements();
      assert.equal(metrics.repositoryIndexes.length, 1);
      const observed = metrics.repositoryIndexes[0];
      if (arm === "qamap-cold") {
        assert.equal(observed.reuse.status, "cold");
        assert.equal(observed.reuse.reusedFiles, 0);
        assert.equal(observed.reuse.rebuiltFiles, observed.indexedFiles);
      } else {
        assert.equal(setup.phase, "base-before-head-overlay");
        assert.equal(setup.sameRoot, true);
        assert.equal(setup.reuse.status, "cold");
        assert.equal(setup.wallClockMs, null);
        assert.equal(observed.reuse.status, "incremental");
        assert.ok(observed.reuse.reusedFiles > 0);
        assert.ok(observed.reuse.rebuiltFiles > 0);
        assert.deepEqual(observed.reuse.changedFiles, ["src/pages/renewal.tsx"]);
        assert.notEqual(observed.fingerprint, setup.fingerprint);
      }
      assert.equal(metrics.fullRecoveryReadBytes, 0, "diagnostic inspection is not agent recovery");
      assert.equal(metrics.compactOutputBytes, Buffer.byteLength(output));
      assert.ok(metrics.exploration.afterCompact, "a real compact CLI response establishes the observation boundary");
      assert.equal(metrics.exploration.afterCompact.toolOutputBytes, 0);
      assert.ok(metrics.fullReportGeneratedBytes > 0);
      assert.equal(metrics.diagnosticReadBytes, metrics.fullReportGeneratedBytes);
      const recovery = metrics.recoveryReports[0];
      assert.match(output, new RegExp(recovery.path.replaceAll(".", "\\.")));
      const recovered = await executor.execute("read_file", { path: recovery.path });
      const after = executor.measurements();
      assert.equal(after.fullRecoveryReadBytes, Math.min(16_384, recovery.bytes));
      assert.equal(after.fullRecoveryOutputBytes, Buffer.byteLength(recovered));
      assert.equal(after.recoveryReads[0].complete, recovery.bytes <= 16_384);
      assert.equal(after.exploration.afterCompact.callsByTool.read_file, 1);
      assert.equal(after.exploration.afterCompact.toolOutputBytes, Buffer.byteLength(recovered));
      await executor.execute("read_file", { path: recovery.path });
      assert.equal(executor.measurements().exploration.directFileReads.repeatedCalls, 1);
      assert.equal(after.subprocessFileReadBytes, null);
      await executor.execute("qamap_qa", { format: "json" });
      assert.equal(executor.measurements().repositoryIndexes.at(-1).reuse.status, "warm");
      assert.equal(executor.measurements().repositoryIndexes.at(-1).reuse.rebuiltFiles, 0);
      const pairing = await repositoryPairing({ task: { id: "synthetic", prompt: "Inspect", successCriteria: [], maxTurns: 1 },
        repositoryRoot: prepared.repositoryRoot, env, provider: "scripted", model: null,
        system: "Shared", tools: toolsForArm(arm), maxOutputTokens: 32 });
      states.at(-1).pairing = pairing;
    }
    assert.notEqual(states[0].env.HOME, states[1].env.HOME);
    assert.notEqual(states[0].env.TMPDIR, states[1].env.TMPDIR);
    assert.deepEqual(states[0].pairing, states[1].pairing);
  } finally {
    for (const state of states) await state.cleanup();
  }
  for (const state of states) await assert.rejects(fs.stat(state.tempRoot), { code: "ENOENT" });
});

test("warm setup rejects an already populated cache rather than claiming a cold baseline", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-agent-baseline-test-"));
  try {
    const repositoryRoot = path.join(temporary, "repo");
    await fs.mkdir(repositoryRoot);
    await fs.writeFile(path.join(repositoryRoot, "source.mjs"), "export const value = 1;\n");
    const env = await createRepositoryEnvironment(temporary);
    await prebuildRepositoryIndex({ repositoryRoot, cliPath, env });
    await assert.rejects(prebuildRepositoryIndex({ repositoryRoot, cliPath, env }), /empty isolated cache/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test("executor bytes count actual reads and delivered UTF-8 without becoming tokens", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-agent-io-test-"));
  try {
    const repositoryRoot = path.join(temporary, "repo");
    await fs.mkdir(repositoryRoot);
    await fs.writeFile(path.join(repositoryRoot, "sample.txt"), "caf\u00e9\n");
    const env = await createRepositoryEnvironment(temporary);
    const executor = await createToolExecutor({ repositoryRoot, cliPath, env, measureIO: true, maxOutputBytes: 64 });
    const text = await executor.execute("read_file", { path: "sample.txt" });
    const command = await executor.execute("bash", { command: "printf 'ok'; printf 'bad' >&2; exit 3" });
    await assert.rejects(executor.execute("read_file", { path: "../escape.txt" }), /escapes/);
    const metrics = executor.measurements();
    assert.equal(metrics.fileReadBytes, 6);
    assert.equal(metrics.toolOutputBytes, Buffer.byteLength(text + command));
    assert.equal(metrics.commandStdoutBytes, 2);
    assert.equal(metrics.commandStderrBytes, 3);
    assert.equal(metrics.commandFailures, 1);
    assert.equal(metrics.toolErrors, 1);
    assert.ok(metrics.toolInputBytes > 0);
    assert.equal(metrics.fullRecoveryReadBytes, 0);
    assert.equal(metrics.inputTokens, undefined);
    assert.equal(metrics.subprocessFileReadBytes, null);
    const capped = await executor.execute("bash", { command: "printf '%100s' x" });
    assert.match(capped, /truncated/);
    assert.equal(executor.measurements().truncatedResponses, 1);
    assert.equal(metrics.truncatedResponses, 0, "snapshots must not mutate");
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test("diagnostics do not follow arbitrary paths or symlink recovery pointers", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-agent-recovery-test-"));
  try {
    const io = createIORecorder({ tempDirectory: temporary });
    const outside = JSON.stringify({ compaction: { fullReport: "/untrusted/report.json" } });
    assert.equal(await io.qamapOutput(outside, "agent"), outside);
    const target = path.join(temporary, "synthetic.json");
    await fs.writeFile(target, "{}");
    const pointer = path.join(temporary, "qamap-qa-agent-full-aabb-ccdd.json");
    await fs.symlink(target, pointer);
    const linked = JSON.stringify({ compaction: { fullReport: pointer } });
    assert.equal(await io.qamapOutput(linked, "agent"), linked);
    assert.equal(io.snapshot().diagnosticReadBytes, 0);
    assert.deepEqual(io.snapshot().recoveryReports, []);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});

test("repository comparison requires exact task, model, prompts, fixture and passing paired runs", () => {
  const pairing = { taskSha256: "a".repeat(64), systemPromptSha256: "b".repeat(64), toolsSha256: "c".repeat(64),
    provider: "synthetic", model: "fixed-model", maxOutputTokens: 32, fixtureTrees: ["a".repeat(40), "b".repeat(40)], carryOver: "none" };
  const run = { run: 1, firstAuthoring: true, pairing, success: true, inputTokens: 100, outputTokens: 10 };
  const arms = { "qamap-cold": { runs: [structuredClone(run)] }, "qamap-warm": { runs: [{ ...structuredClone(run), inputTokens: 70 }] } };
  const compare = (value = arms, status = "measured") => compareRepositoryArms(value, status)[0];
  assert.equal(compare().eligible, true);
  assert.equal(compare().inputTokensMedianDifference, 30);
  for (const status of ["dry-run", "skipped"]) {
    assert.equal(compare(arms, status).status, "not-measured");
    assert.equal(compare(arms, status).inputTokensMedianDifference, null);
    assert.equal(compare(arms, status).qualityPassed, null);
  }
  for (const field of Object.keys(pairing)) {
    const changed = structuredClone(arms);
    changed["qamap-warm"].runs[0].pairing[field] = "different";
    assert.equal(compare(changed).status, "unpaired", field);
    assert.equal(compare(changed).inputTokensMedianDifference, null);
  }
  for (const override of [{ success: false }, { error: "provider failure" }, { inputTokens: null }, { outputTokens: -1 }, { run: 2 }, { firstAuthoring: false }, { pairing: null }, { pairing: {} }]) {
    const changed = structuredClone(arms);
    Object.assign(changed["qamap-warm"].runs[0], override);
    assert.equal(compare(changed).eligible, false, JSON.stringify(override));
  }
  assert.equal(compare({ ...arms, "qamap-warm": { runs: [] } }).status, "unpaired");
  const generic = structuredClone(arms["qamap-cold"]);
  generic.runs[0].pairing.toolsSha256 = "d".repeat(64);
  assert.equal(compareRepositoryArms({ generic, ...arms }, "measured").every((pair) => pair.eligible), true);
});

test("optional config is offline harness-only and missing-provider runs stay skipped", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-agent-config-test-"));
  try {
    const env = await createRepositoryEnvironment(temporary);
    const flags = ["scripts/agent-bench.mjs", "--config", "agent-repository-bench.config.json", "--runs", "1", "--format", "json", "--assert"];
    const skipped = JSON.parse((await execFileAsync(process.execPath, flags, { cwd: root, env })).stdout);
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.summary.qualityPassed, null);
    const report = JSON.parse((await execFileAsync(process.execPath, [...flags, "--dry-run"], {
      cwd: root, env, maxBuffer: 10 * 1024 * 1024,
    })).stdout);
    assert.equal(report.status, "dry-run");
    assert.equal(report.tasks.length, 6);
    assert.equal(report.summary.harnessPassed, true);
    assert.equal(report.summary.qualityPassed, null);
    const rendered = formatTextReport(report);
    assert.match(rendered, /direct file reads:/);
    assert.match(rendered, /after first compact receipt: [^\n]*qamap_qa=1/);
    assert.match(rendered, /after compact: n\/a/);
    assert.match(rendered, /total run ms: n\/a/);
    assert.match(rendered, /repeated file-read bytes n\/a, total run ms n\/a/);
    for (const task of report.tasks) {
      assert.deepEqual(Object.keys(task.arms), ["generic", "qamap-cold", "qamap-warm"]);
      assert.equal(task.repositoryComparisons.length, 3);
      for (const comparison of task.repositoryComparisons) {
        assert.equal(comparison.status, "not-measured");
        assert.equal(comparison.eligible, false);
        assert.equal(comparison.inputTokensMedianDifference, null);
        assert.ok(Object.values(comparison.diagnostics).every((value) => value === null));
      }
      for (const arm of Object.values(task.arms)) {
        const run = arm.runs[0];
        assert.equal(run.error, undefined);
        assert.equal(run.inputTokens, null);
        assert.equal(run.outputTokens, null);
        assert.equal(run.cacheReadTokens, null);
        assert.equal(run.cacheWriteTokens, null);
        assert.equal(run.wallClockMs, null);
        assert.deepEqual(run.timing, { fixtureSetupMs: null, agentMs: null, judgeMs: null, cleanupMs: null, totalMs: null });
        assert.ok(run.io.exploration.directFileReads.calls > 0);
        assert.equal(run.success, false);
        assert.equal(run.quality[0].passed, false, "the scripted harness does not fabricate a correct answer");
      }
      const cold = task.arms["qamap-cold"].runs[0];
      const warm = task.arms["qamap-warm"].runs[0];
      assert.deepEqual(cold.pairing, warm.pairing);
      assert.equal(cold.repositoryCache.setup.status, "not-requested");
      assert.equal(warm.repositoryCache.setup.status, "prebuilt");
      assert.equal(cold.io.repositoryIndexes[0].reuse.status, "cold");
      assert.equal(warm.io.repositoryIndexes[0].reuse.status, "incremental");
      assert.equal(warm.io.repositoryIndexes[1].reuse.status, "warm");
      assert.equal(warm.io.repositoryIndexes[1].reuse.rebuiltFiles, 0);
      assert.equal(cold.io.exploration.afterCompact.callsByTool.qamap_qa, 1);
      assert.equal(warm.io.exploration.afterCompact.callsByTool.qamap_qa, 1);
      assert.equal(task.arms.generic.runs[0].io.exploration.afterCompact, null);
    }
    assert.doesNotMatch(JSON.stringify(report), /\/var\/folders|\/private\/var|\/tmp\//);
    assert.deepEqual(await fs.readdir(env.TMPDIR), [], "all fixture/cache directories must be cleaned");
    const config = JSON.parse(await fs.readFile(path.join(root, "agent-repository-bench.config.json"), "utf8"));
    config.carryOverPaths = [".qamap"];
    const invalid = path.join(temporary, "invalid.json");
    await fs.writeFile(invalid, JSON.stringify(config));
    await assert.rejects(execFileAsync(process.execPath, ["scripts/agent-bench.mjs", "--config", invalid, "--dry-run"], { cwd: root, env }), /carryOverPaths/);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
