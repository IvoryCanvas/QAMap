import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("context benchmark is deterministic and keeps reuse separate from correctness", async () => {
  const first = await runBenchmark();
  const second = await runBenchmark();

  assert.deepEqual(second, first);
  assert.deepEqual(first.normativeMetrics, ["utf8-bytes", "structural-block-counts"]);
  assert.equal(first.summary.passed, true, JSON.stringify(first.summary.failures));
  assert.equal(first.handoff.rawChangedEvidenceBytes > 0, true);
  assert.equal(first.handoff.compactAgentPayloadBytes <= 4095, true);
  assert.equal(first.handoff.stableBlockCount, 4);
  assert.match(first.interpretation.join(" "), /not QA correctness/i);
  assert.match(first.interpretation.join(" "), /calling agent still uses its own model tokens/i);
  assert.doesNotMatch(JSON.stringify(first), /\$\d|times cheaper|x cheaper|\/tmp|\/var\/folders/iu);
});

test("context benchmark reports exact block invalidation reasons", async () => {
  const report = await runBenchmark();
  const scenarios = new Map(report.scenarios.map((scenario) => [scenario.id, scenario]));

  assert.equal(scenarios.get("identical-rerun").stableMatched, true);
  assert.equal(scenarios.get("identical-rerun").deltaMatched, true);
  assert.equal(scenarios.get("related-pull-request").stableMatched, true);
  assert.equal(scenarios.get("related-pull-request").deltaMatched, false);
  assert.deepEqual(invalidatedKinds(scenarios.get("manifest-correction")), ["manifest"]);
  assert.deepEqual(invalidatedKinds(scenarios.get("validation-command-change")), ["validation"]);
  assert.deepEqual(invalidatedKinds(scenarios.get("behavior-structure-change")), ["behavior"]);
  assert.deepEqual(invalidatedKinds(scenarios.get("unrelated-repository")), ["repository"]);
  assert.equal(scenarios.get("volatile-run-metadata").stableMatched, true);
  assert.equal(scenarios.get("volatile-run-metadata").deltaMatched, false);
  assert.equal(
    report.scenarios.every((scenario) =>
      scenario.invalidatedBlocks.every((block) => typeof block.reason === "string" && block.reason.length > 0)
    ),
    true,
  );
});

async function runBenchmark() {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["scripts/context-bench.mjs", "--format", "json", "--assert"],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function invalidatedKinds(scenario) {
  return scenario.invalidatedBlocks.map((block) => block.kind);
}
