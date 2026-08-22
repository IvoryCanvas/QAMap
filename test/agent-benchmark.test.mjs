import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { judgeSuccess, readJsonPath } from "../scripts/agent-bench/judge.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const forbiddenReportText = /\$\d|times cheaper|x cheaper|\/tmp|\/var\/folders|sk-ant|sk-/;

test("agent benchmark dry run is deterministic and never needs a provider", async () => {
  const first = await runBenchmark(["--dry-run", "--format", "json", "--runs", "2"]);
  const second = await runBenchmark(["--dry-run", "--format", "json", "--runs", "2"]);

  assert.deepEqual(second, first);
  assert.deepEqual(first.schema, { name: "qamap.agent-benchmark", version: 1 });
  assert.equal(first.status, "dry-run");
  assert.equal(first.pinned.provider, "scripted");
  assert.equal(first.pinned.model, null);
  assert.equal(first.pinned.runs, 2);
  assert.match(first.pinned.systemPromptSha256, /^[a-f0-9]{64}$/);
  assert.match(first.pinned.toolSchemaSha256.generic, /^[a-f0-9]{64}$/);
  assert.match(first.pinned.toolSchemaSha256.qamap, /^[a-f0-9]{64}$/);
  assert.notEqual(first.pinned.toolSchemaSha256.generic, first.pinned.toolSchemaSha256.qamap);
  assert.match(first.pinned.suiteSha256, /^[a-f0-9]{64}$/);
  assert.match(first.pinned.qamapVersion, /^\d+\.\d+\.\d+/);
  assert.deepEqual(
    first.tasks.map((task) => task.id),
    ["reproduce-regression", "verify-copy-against-spec", "reverify-after-fix"],
  );

  for (const task of first.tasks) {
    assert.deepEqual(Object.keys(task.arms), ["generic", "qamap"]);
    for (const arm of Object.values(task.arms)) {
      assert.equal(arm.runs.length, 2);
      assert.equal(arm.aggregate.failedRuns, 0);
      assert.equal(arm.runs[0].firstAuthoring, task.firstAuthoring);
      assert.equal(arm.runs[1].firstAuthoring, false);
      for (const run of arm.runs) {
        assert.equal(run.error, undefined);
        assert.equal(run.inputTokens, null, "a dry run must not report token counts");
        assert.equal(run.outputTokens, null);
        assert.equal(run.wallClockMs, null);
        assert.equal(run.toolCalls > 0, true);
        assert.equal(run.turns > 0, true);
        assert.equal(run.success, false);
        assert.equal(run.checks.length > 0, true);
      }
    }
    assert.equal(
      task.arms.qamap.runs[0].toolCalls > task.arms.generic.runs[0].toolCalls,
      true,
      "the scripted qamap arm exercises the extra tools",
    );
  }

  assert.match(first.interpretation.join(" "), /nothing is estimated/i);
  assert.match(first.interpretation.join(" "), /no provider pricing/i);
  assert.match(first.interpretation.join(" "), /second run/i);
  assert.equal(first.summary.passed, true);
  assert.doesNotMatch(JSON.stringify(first), forbiddenReportText);
});

test("agent benchmark is skipped without a provider key and exits 0 even with --assert", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/agent-bench.mjs", "--assert", "--format", "json"],
    { cwd: root, env: environmentWithoutProvider(), maxBuffer: 10 * 1024 * 1024 },
  );
  const report = JSON.parse(stdout);

  assert.equal(report.status, "skipped");
  assert.equal(report.reason, "provider key not configured");
  assert.equal(report.pinned.provider, null);
  assert.deepEqual(report.tasks.map((task) => task.arms), [{}, {}, {}]);
  assert.equal(report.summary.passed, true);
  assert.doesNotMatch(JSON.stringify(report), forbiddenReportText);

  const text = await execFileAsync(
    process.execPath,
    ["scripts/agent-bench.mjs", "--assert"],
    { cwd: root, env: environmentWithoutProvider(), maxBuffer: 10 * 1024 * 1024 },
  );
  assert.match(text.stdout, /^# QAMap Agent Token Benchmark\n/);
  assert.match(text.stdout, /Status: skipped \(provider key not configured\)/);
  assert.doesNotMatch(text.stdout, forbiddenReportText);
});

test("agent benchmark success is judged only by local deterministic checks", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "qamap-agent-judge-"));
  try {
    await writeFile(path.join(workspace, "notes.txt"), "present\n");
    await writeFile(
      path.join(workspace, "qa-result.json"),
      JSON.stringify({ verdict: "fail", surfaces: { list: [{ matches: false }] }, count: 1 }),
    );

    const passing = await judgeSuccess([
      { kind: "file-exists", path: "notes.txt" },
      { kind: "command-exit", command: [process.execPath, "-e", "process.exit(3)"], exitCode: 3 },
      { kind: "stdout-includes", command: [process.execPath, "-e", "console.log('hello there')"], includes: "hello" },
      { kind: "json-path-equals", path: "qa-result.json", jsonPath: "verdict", equals: "fail" },
      { kind: "json-path-equals", path: "qa-result.json", jsonPath: "surfaces.list.0.matches", equals: false },
      { kind: "json-path-equals", path: "qa-result.json", jsonPath: "count", equals: 1 },
    ], workspace);
    assert.equal(passing.success, true);
    assert.deepEqual(passing.checks.map((check) => check.passed), [true, true, true, true, true, true]);

    const failing = await judgeSuccess([
      { kind: "file-exists", path: "missing.txt" },
      { kind: "command-exit", command: [process.execPath, "-e", "process.exit(1)"] },
      { kind: "stdout-includes", command: [process.execPath, "-e", "console.log('nope')"], includes: "hello" },
      { kind: "json-path-equals", path: "qa-result.json", jsonPath: "verdict", equals: "pass" },
      { kind: "json-path-equals", path: "qa-result.json", jsonPath: "absent.key", equals: null },
      { kind: "json-path-equals", path: "no-answer.json", jsonPath: "verdict", equals: "fail" },
      { kind: "file-exists", path: "../outside.txt" },
    ], workspace);
    assert.equal(failing.success, false);
    assert.deepEqual(failing.checks.map((check) => check.passed), [false, false, false, false, false, false, false]);
    assert.match(failing.checks[6].detail, /escapes the repository root/);
    assert.doesNotMatch(JSON.stringify(failing), /\/tmp|\/var\/folders/);
    assert.equal((await judgeSuccess([], workspace)).success, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  assert.equal(readJsonPath({ a: { b: [{ c: 2 }] } }, "a.b.0.c"), 2);
  assert.equal(readJsonPath({ a: 1 }, "a.b"), undefined);
});

async function runBenchmark(flags) {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/agent-bench.mjs", ...flags], {
    cwd: root,
    env: environmentWithoutProvider(),
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function environmentWithoutProvider() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("QAMAP_BENCH_")) delete env[name];
  }
  return env;
}
