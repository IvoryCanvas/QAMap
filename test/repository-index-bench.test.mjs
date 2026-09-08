import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { measureSerializedPayload, qualityGate, requiredPhases, requiredQualityCases, scoreEvidence, scoreImpactPaths, summarizeBenchmark } from "../scripts/bench-repository-index.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("precision and recall reject both omissions and fabricated structural evidence", () => {
  const perfect = scoreEvidence(["declaration", "import"], ["declaration", "import"]);
  assert.equal(qualityGate(perfect, perfect, true), true);
  const omitted = scoreEvidence(["declaration", "import"], ["declaration"]);
  assert.equal(omitted.precision, 1);
  assert.equal(omitted.recall, 0.5);
  assert.equal(qualityGate(perfect, omitted, true), false);
  const fabricated = scoreEvidence(["declaration", "import"], ["declaration", "import", "invented"]);
  assert.equal(fabricated.falsePositives, 1);
  assert.equal(qualityGate(perfect, fabricated, true), false);
  assert.equal(qualityGate(perfect, perfect, false), false);
  assert.equal(qualityGate(scoreEvidence([], []), scoreEvidence([], []), true), false);
});

test("repository benchmark is deterministic with honest warm reads and one-file invalidation", async () => {
  const first = await benchmark(8);
  const second = await benchmark(8);
  assert.deepEqual(withoutDiagnostics(first), withoutDiagnostics(second));
  assert.equal(first.summary.passed, true);
  assert.equal(first.summary.qualityComplete, true);
  assert.equal(first.summary.checks, 11);
  assert.equal(first.summary.passedChecks, 11);
  assert.deepEqual(first.summary.qualityCoverage, { expected: 7, passed: 7, notRun: [], failed: [] });
  assert.equal(first.fixture.inventoryFiles, 20);
  assert.equal(first.generic.work.discoveryCommands, 4);
  assert.equal(first.generic.work.discoveredPaths, 80);
  for (const scenario of first.scenarios) {
    assert.equal(scenario.quality.precision, 1, JSON.stringify(scenario.quality));
    assert.equal(scenario.quality.recall, 1);
    assert.equal(scenario.coverage.inventoryFiles, 20);
    for (const entry of scenario.productPaths) {
      assert.equal(entry.passed, true, JSON.stringify(entry));
      assert.equal(entry.quality.precision, 1);
      assert.equal(entry.quality.recall, 1);
      assert.equal(entry.impact.execution, "not-run");
      assert.equal(entry.impact.status, "draft");
      assert.ok(entry.impact.paths.every((item) => !item.evidence.some((step) => step.file.endsWith("unused.test.ts"))));
    }
    assert.ok(scenario.work.discoveryCommands > 0);
    assert.ok(scenario.work.repositoryReadBytes > 0);
    assert.equal(scenario.savings.eligible, true);
    assert.equal(scenario.savings.providerTokensAvoided, null);
    assert.ok(scenario.payload.blocksJsonBytes > 0);
    assert.ok(scenario.payload.individualBlockJsonBytes < scenario.payload.blocksJsonBytes);
    assert.ok(scenario.payload.recoveryIndexJsonBytes > scenario.payload.blocksJsonBytes);
    assert.equal(scenario.payload.fullCliPayloadBytes, null);
    assert.equal(scenario.recovery.indexJsonBytes, scenario.payload.recoveryIndexJsonBytes);
    assert.equal(scenario.recovery.status, "passed");
    assert.ok(scenario.recovery.cacheSnapshotBytes > 0);
    for (const value of Object.values(scenario.diagnostics)) assert.ok(Number.isFinite(value) && value >= 0);
  }
  const warm = first.scenarios[1];
  assert.equal(warm.reuse.rebuiltFiles, 0);
  assert.ok(warm.reuse.reusedFiles > 0);
  assert.ok(warm.work.cacheReadBytes > 0);
  assert.equal(warm.savings.totalReadBytesAvoided, first.generic.work.repositoryReadBytes - warm.work.repositoryReadBytes - warm.work.cacheReadBytes);
  assert.equal(warm.reuse.readFiles, first.scenarios[0].reuse.readFiles);
  assert.equal(warm.reuse.readBytes, first.scenarios[0].reuse.readBytes);
  assert.equal(first.qualityScenarios[1].status, "passed");
  assert.deepEqual(first.qualityScenarios.map((entry) => entry.id), requiredQualityCases);
  for (const entry of first.qualityScenarios) assert.equal(entry.status, "passed", JSON.stringify(entry));
  const byCase = Object.fromEntries(first.qualityScenarios.map((entry) => [entry.id, entry]));
  assert.equal(byCase["compiler-path-alias-resolution"].quality.recall, 1);
  assert.equal(byCase["conditional-package-exports"].quality.recall, null);
  assert.equal(byCase["conditional-package-exports"].impact.paths.length, 0);
  assert.equal(byCase["conditional-package-exports"].resolutions[0].reason, "ambiguous-package-export");
  assert.ok(byCase["dynamic-module-boundary"].impact.boundaries.some((entry) => entry.reason === "runtime-module-loading"));
  assert.ok(byCase["unresolved-module-boundary"].impact.boundaries.some((entry) => entry.reason === "unresolved-relative-module"));
  assert.equal(byCase["unresolved-module-boundary"].disconnectedProducerImpact.paths.length, 0);
  const mixed = byCase["mixed-maintenance-coverage"];
  assert.equal(mixed.coverage.complete, false);
  assert.equal(mixed.coverage.inventoryFiles, 6);
  assert.equal(mixed.coverage.indexedFiles, 4);
  assert.equal(mixed.reuse.rebuiltFiles, 2);
  assert.equal(mixed.quality.recall, 1);
  assert.deepEqual(mixed.coverage.skipped, [
    { path: ".github/workflows/check.yml", reason: "non-source" }, { path: "README.md", reason: "documentation" },
  ]);
  assert.equal(first.scenarios[2].reuse.rebuiltFiles, 1);
  assert.equal(first.scenarios[3].reuse.rebuiltFiles, 1);
  assert.deepEqual(first.scenarios[3].reuse.changedFiles, ["packages/value/src/value.ts"]);
  assert.equal(first.providerUsage.status, "not-measured");
  assert.equal(first.providerUsage.inputTokens, null);
  assert.doesNotMatch(JSON.stringify(first), /\/Users\/|\/tmp\/|\/var\/folders\//);
});

test("summary requires every expected phase and quality control, including not-run and missing cases", () => {
  const phases = requiredPhases.map((id) => ({ id, passed: true }));
  const cases = requiredQualityCases.map((id) => ({ id, status: "passed" }));
  assert.equal(summarizeBenchmark(phases, cases).passed, true);
  assert.equal(summarizeBenchmark(phases.slice(1), cases).passed, false);
  for (const status of ["not-run", "failed", "blocked"]) {
    const report = summarizeBenchmark(phases, cases.map((entry, index) => index === 2 ? { ...entry, status } : entry));
    assert.equal(report.passed, false);
    assert.equal(report.qualityComplete, false);
    assert.equal(report.passedChecks, 10);
  }
  const missing = summarizeBenchmark(phases, cases.slice(0, -1));
  assert.equal(missing.qualityComplete, false);
  assert.deepEqual(missing.qualityCoverage.notRun, ["mixed-maintenance-coverage"]);
  assert.equal(summarizeBenchmark(phases, [...cases, cases[0]]).qualityComplete, false);
});

test("payload sizes count actual UTF-8 JSON and never substitute for full CLI bytes", () => {
  const index = { schemaVersion: 1, blocks: [
    { file: "src/value.ts", kind: "source", declarations: [{ name: "caf\u00e9" }] },
    { file: "tests/value.test.ts", kind: "test", tests: [{ line: 2, kind: "assertion" }] },
  ] };
  const impacts = [{ status: "draft", execution: "not-run", paths: [] }];
  const sizes = measureSerializedPayload(index, impacts);
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  assert.equal(sizes.blocksJsonBytes, bytes(index.blocks));
  assert.equal(sizes.individualBlockJsonBytes, index.blocks.reduce((sum, block) => sum + bytes(block), 0));
  assert.equal(sizes.recoveryIndexJsonBytes, bytes(index));
  assert.equal(sizes.impactArrayJsonBytes, bytes(impacts));
  assert.equal(sizes.blocksByKind.source.bytes, bytes(index.blocks[0]));
  assert.equal(sizes.fullCliPayloadBytes, null);
});

test("product path scoring penalizes missing endpoints and wrong changed-symbol evidence", () => {
  const expected = [JSON.stringify(["src/value.ts", "value", "test-reference", "test/value.test.ts", 2, "value"])];
  const entry = { changedFile: "src/value.ts", changedSymbol: "value", endpoint: "test-reference", evidence: [{ file: "test/value.test.ts", line: 2, symbol: "value" }] };
  assert.equal(scoreImpactPaths(expected, { paths: [entry] }).recall, 1);
  assert.equal(scoreImpactPaths(expected, { paths: [] }).recall, 0);
  assert.equal(scoreImpactPaths(expected, { paths: [{ ...entry, changedSymbol: "unrelated" }] }).precision, 0);
});

test("repository benchmark rejects unbounded fixture sizes before materialization", async () => {
  await assert.rejects(benchmark(10001), /--files must be an integer/);
  await assert.rejects(benchmark(0), /--files must be an integer/);
});

test("repository benchmark removes fixtures and caches after success and a failed reuse gate", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-bench-cleanup-test-"));
  try {
    const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    delete env.QAMAP_REPOSITORY_CACHE;
    await benchmark(2, env);
    assert.deepEqual(await fs.readdir(temporary), []);
    await assert.rejects(benchmark(2, { ...env, QAMAP_REPOSITORY_CACHE: "off" }), (error) => {
      assert.equal(error.code, 1);
      const failed = JSON.parse(error.stdout);
      assert.equal(failed.summary.passed, false);
      assert.equal(failed.summary.qualityComplete, false);
      assert.ok(failed.summary.qualityCoverage.failed.includes("mixed-maintenance-coverage"));
      for (const scenario of failed.scenarios) {
        assert.equal(scenario.savings.eligible, false);
        assert.equal(scenario.savings.totalReadBytesAvoided, null);
        assert.equal(scenario.savings.providerTokensAvoided, null);
      }
      return true;
    });
    assert.deepEqual(await fs.readdir(temporary), []);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

async function benchmark(files, env = process.env) {
  const { stdout } = await exec(process.execPath, [path.join(root, "scripts/bench-repository-index.mjs"),
    "--files", String(files), "--format", "json", "--assert"], { cwd: root, env, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
}

function withoutDiagnostics(value) {
  if (Array.isArray(value)) return value.map(withoutDiagnostics);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "diagnostics").map(([key, entry]) => [key, withoutDiagnostics(entry)]));
  return value;
}
