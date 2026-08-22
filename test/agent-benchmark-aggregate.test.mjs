import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRuns, median, range, RUN_METRICS } from "../scripts/agent-bench/aggregate.mjs";

test("median and range handle odd, even, single, and empty samples", () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([40, 10, 30, 20]), 25);
  assert.equal(median([5]), 5);
  assert.equal(median([]), null);
  assert.deepEqual(range([30, 10, 20]), { min: 10, max: 30 });
  assert.deepEqual(range([]), { min: null, max: null });
});

test("aggregate keeps the first-authoring run in its own column and medians the steady state", () => {
  const runs = [
    run({ firstAuthoring: true, inputTokens: 3000, outputTokens: 900, toolCalls: 12, wallClockMs: 40000, success: true }),
    run({ inputTokens: 1000, outputTokens: 300, toolCalls: 4, wallClockMs: 12000, success: true }),
    run({ inputTokens: 2000, outputTokens: 500, toolCalls: 6, wallClockMs: 20000, success: false }),
  ];
  const aggregate = aggregateRuns(runs);

  assert.equal(aggregate.runs, 3);
  assert.equal(aggregate.completedRuns, 3);
  assert.equal(aggregate.failedRuns, 0);
  assert.equal(aggregate.successfulRuns, 2);
  assert.equal(aggregate.firstAuthoringSuccess, true);
  assert.equal(aggregate.steadyStateSuccessfulRuns, 1);
  assert.equal(aggregate.steadyStateRuns, 2);
  assert.deepEqual(Object.keys(aggregate.metrics), RUN_METRICS);
  assert.deepEqual(aggregate.metrics.inputTokens, {
    median: 2000,
    range: { min: 1000, max: 3000 },
    samples: 3,
    firstAuthoring: 3000,
    steadyState: { median: 1500, range: { min: 1000, max: 2000 }, samples: 2 },
  });
  assert.equal(aggregate.metrics.toolCalls.median, 6);
  assert.equal(aggregate.metrics.toolCalls.firstAuthoring, 12);
  assert.equal(aggregate.metrics.toolCalls.steadyState.median, 5);
  assert.equal(aggregate.metrics.wallClockMs.range.max, 40000);
});

test("aggregate excludes errored runs from every metric and counts them", () => {
  const runs = [
    run({ firstAuthoring: true, inputTokens: 500, outputTokens: 50, toolCalls: 2, wallClockMs: 1000, success: true }),
    { run: 2, firstAuthoring: false, success: false, error: "provider request failed with status 500" },
    run({ inputTokens: 700, outputTokens: 70, toolCalls: 3, wallClockMs: 1500, success: true }),
    run({ inputTokens: 900, outputTokens: 90, toolCalls: 5, wallClockMs: 2500, success: true }),
  ];
  const aggregate = aggregateRuns(runs);

  assert.equal(aggregate.failedRuns, 1);
  assert.equal(aggregate.completedRuns, 3);
  assert.equal(aggregate.successfulRuns, 3);
  assert.equal(aggregate.metrics.inputTokens.samples, 3);
  assert.equal(aggregate.metrics.inputTokens.median, 700);
  assert.deepEqual(aggregate.metrics.inputTokens.steadyState, { median: 800, range: { min: 700, max: 900 }, samples: 2 });
});

test("aggregate reports null instead of a number when a provider did not report a field", () => {
  const runs = [
    run({ firstAuthoring: true, inputTokens: 100, outputTokens: 10, cacheWriteTokens: null, toolCalls: 1, wallClockMs: 10 }),
    run({ inputTokens: 120, outputTokens: 12, cacheWriteTokens: null, toolCalls: 1, wallClockMs: 12 }),
  ];
  const aggregate = aggregateRuns(runs);

  assert.deepEqual(aggregate.metrics.cacheWriteTokens, {
    median: null,
    range: { min: null, max: null },
    samples: 0,
    firstAuthoring: null,
    steadyState: { median: null, range: { min: null, max: null }, samples: 0 },
  });
  assert.equal(aggregate.metrics.cacheReadTokens.median, 0);
  assert.deepEqual(aggregateRuns([]).metrics.inputTokens.median, null);
  assert.equal(aggregateRuns([]).firstAuthoringSuccess, null);
});

function run(overrides) {
  return {
    firstAuthoring: false,
    success: true,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
    turns: 1,
    wallClockMs: 0,
    ...overrides,
  };
}
