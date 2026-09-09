import assert from "node:assert/strict";
import test from "node:test";
import { createRunTiming } from "../scripts/agent-bench/timing.mjs";

test("run timing includes setup and cleanup once, plus unclassified harness overhead", async () => {
  let clock = 100;
  const timing = createRunTiming({ now: () => clock });
  await timing.measure("fixtureSetupMs", async () => { clock += 20; });
  clock += 3;
  assert.equal(await timing.measure("agentMs", async () => { clock += 50; return "answer"; }), "answer");
  await timing.measure("judgeMs", async () => { clock += 7; });
  await timing.measure("cleanupMs", async () => { clock += 4; });
  assert.deepEqual(timing.snapshot(), { fixtureSetupMs: 20, agentMs: 50, judgeMs: 7, cleanupMs: 4, totalMs: 84 });
});

test("failed phase timings survive and unexecuted phases remain unavailable", async () => {
  let clock = 0;
  const timing = createRunTiming({ now: () => clock });
  await assert.rejects(timing.measure("agentMs", async () => { clock += 12; throw new Error("provider failed"); }), /provider failed/);
  await timing.measure("cleanupMs", async () => { clock += 2; });
  assert.deepEqual(timing.snapshot(), { fixtureSetupMs: null, agentMs: 12, judgeMs: null, cleanupMs: 2, totalMs: 14 });
  await assert.rejects(timing.measure("unknown", async () => {}), /Unknown timing phase/);
});

test("offline timing never reads the clock or pretends scripted latency is measured", async () => {
  const timing = createRunTiming({ enabled: false, now: () => { throw new Error("clock read"); } });
  assert.equal(await timing.measure("agentMs", async () => 42), 42);
  assert.deepEqual(timing.snapshot(), { fixtureSetupMs: null, agentMs: null, judgeMs: null, cleanupMs: null, totalMs: null });
});
