import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createCodexSessionGuard, measureCodexSession, watchCodexSession } from "../scripts/agent-bench/codex-session-guard.mjs";

const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
const turn = (id) => ({ type: "turn_context", payload: { turn_id: id } });
const count = (total, last = total) => ({ type: "event_msg", payload: { type: "token_count", info: {
  total_token_usage: total, last_token_usage: last,
} } });
const createGuard = (options = {}) => createCodexSessionGuard({ tokenLimit: 1000, requestLimit: 10, ...options });

test("explicitly unbounded tokens still reconcile usage and enforce request limits", () => {
  const values = usage(300000, 100000, 1200);
  const guard = createGuard({ tokenLimit: null });
  assert.equal(guard.observe([turn("one"), count(values)]), null);
  const result = guard.finish({ exitCode: 0, turnUsage: values });
  assert.equal(result.usageComplete, true);
  assert.equal(result.sessionUsage.total_tokens, 301200);
  assert.equal(result.budget.tokenLimit, null);
  assert.equal(result.budget.overrunTokens, 0);
  const bounded = createGuard({ tokenLimit: null, requestLimit: 1 });
  assert.equal(bounded.observe([turn("one"), count(values)]), "session-request-limit");
  for (const tokenLimit of [undefined, 0, -1, Infinity]) assert.throws(() => createGuard({ tokenLimit }));
});

test("usage spans resumed CLI counters without adding cache or reasoning subsets", () => {
  const offer = usage(100, 20, 10);
  const review = { ...usage(80, 60, 8), reasoning_output_tokens: 5, total_tokens: 88 };
  const result = measureCodexSession([turn("offer"), count(offer), turn("review"), count(review)]);
  assert.equal(result.total_tokens, 198);
  assert.equal(result.cached_input_tokens, 80);
  assert.equal(result.requests.length, 2);
});

test("unchanged snapshots deduplicate but identical requests in different turns count", () => {
  const event = count(usage(10, 5, 1));
  const result = measureCodexSession([turn("one"), event, event, turn("two"), event]);
  assert.equal(result.total_tokens, 22);
  assert.equal(result.requests.length, 2);
});

test("cumulative counters can continue across turns without double counting", () => {
  const result = measureCodexSession([turn("one"), count(usage(10, 5, 1)),
    turn("two"), count(usage(30, 15, 3), usage(20, 10, 2))]);
  assert.equal(result.total_tokens, 33);
});

test("missing initial increments cannot become deceptively small usage", () => {
  assert.throws(() => measureCodexSession([turn("one"), count(usage(30, 0, 3), usage(10, 0, 1))]), /initial usage/);
  assert.throws(() => measureCodexSession([turn("one"), count(usage(10, 0, 1)),
    turn("two"), count(usage(40, 0, 4), usage(20, 0, 2))]), /initial usage/);
});

test("sum overflow and unbounded request limits are rejected", () => {
  assert.throws(() => measureCodexSession([turn("one"), count(usage(Number.MAX_SAFE_INTEGER, 0, 0)),
    turn("two"), count(usage(1, 0, 0))]));
  for (const requestLimit of [0, -1, Infinity, 1.5]) assert.throws(() => createGuard({ requestLimit }));
});

test("bad, missing, discontinuous and conflicting usage fails closed", () => {
  for (const invalid of [usage(-1, 0, 0), usage(1, 2, 0), usage(1.5, 0, 1),
    usage(Number.MAX_SAFE_INTEGER, 0, 1), { ...usage(10, 0, 1), total_tokens: 15 },
    { input_tokens: 2, output_tokens: 1 }]) {
    assert.throws(() => measureCodexSession([turn("one"), count(invalid)]));
  }
  assert.throws(() => measureCodexSession([count(usage(1, 0, 1))]), /turn context/);
  assert.throws(() => measureCodexSession([turn("one"), count(usage(10, 0, 1)),
    count(usage(30, 0, 3), usage(10, 0, 1))]), /Discontinuous/);
  assert.throws(() => measureCodexSession([turn("one"), count(usage(10, 0, 1)),
    count(usage(10, 0, 1), usage(2, 0, 1))]), /Conflicting/);
});

test("a resumed stage reconciles its own receipt and retains the offer cost", () => {
  const initialRows = [turn("offer"), count(usage(100, 20, 10))];
  const guard = createGuard({ initialRows });
  const rows = [...initialRows, turn("review"), count(usage(80, 60, 8))];
  assert.equal(guard.observe(rows), null);
  assert.equal(guard.observe(rows), null);
  const result = guard.finish({ exitCode: 0, turnUsage: usage(80, 60, 8) });
  assert.equal(result.usageComplete, true);
  assert.equal(result.sessionUsage.total_tokens, 198);
  assert.equal(result.stageUsage.total_tokens, 88);
});

test("a resumed cumulative receipt must match both the final counter and the complete ledger", () => {
  const initialRows = [turn("offer"), count(usage(100, 20, 10))];
  const total = usage(180, 80, 18);
  const guard = createGuard({ initialRows });
  guard.observe([...initialRows, turn("review"), count(total, usage(80, 60, 8))]);
  const result = guard.finish({ exitCode: 0, turnUsage: total });
  assert.equal(result.usageComplete, true);
  assert.equal(result.receiptScope, "session");
  assert.equal(result.sessionUsage.total_tokens, 198);
  assert.equal(result.stageUsage.total_tokens, 88);
  assert.equal(result.sessionUsage.requests, 2);
  assert.equal(result.stageUsage.requests, 1);
});

test("a reset counter cannot be relabeled as a cumulative receipt to bypass reconciliation", () => {
  const initialRows = [turn("offer"), count(usage(100, 20, 10))];
  for (const claimed of [usage(180, 80, 18), usage(100, 20, 10), usage(180, 79, 18)]) {
    const guard = createGuard({ initialRows });
    guard.observe([...initialRows, turn("review"), count(usage(80, 60, 8))]);
    const result = guard.finish({ exitCode: 0, turnUsage: claimed });
    assert.equal(result.usageComplete, false);
    assert.equal(result.stopReason, "usage-unreconciled");
    assert.equal(result.receiptScope, null);
  }
});

test("cumulative completion does not waive limits, missing requests or process failures", () => {
  const initialRows = [turn("offer"), count(usage(100, 20, 10))];
  const total = usage(180, 80, 18);
  for (const scenario of ["limit", "failed", "missing", "blocked"]) {
    const guard = createGuard({ initialRows, tokenLimit: scenario === "limit" ? 190 : 1000 });
    if (scenario !== "missing") guard.observe([...initialRows, turn("review"), count(total, usage(80, 60, 8))]);
    if (scenario === "blocked") guard.fail("sandbox-infrastructure-failure");
    const result = guard.finish({ exitCode: scenario === "failed" ? 1 : 0,
      turnUsage: scenario === "missing" ? usage(100, 20, 10) : total });
    assert.equal(result.usageComplete, false, scenario);
    assert.equal(result.sessionUsage, null, scenario);
    assert.equal(result.stageUsage, null, scenario);
  }
});

test("the observed pilot overrun is detected even though resumed totals are below the limit", () => {
  const initialRows = [turn("offer"), count(usage(23255, 10752, 345))];
  const guard = createGuard({ tokenLimit: 120000, initialRows });
  const review = usage(103395, 97664, 1235);
  assert.equal(guard.observe([...initialRows, turn("review"), count(review)]), "session-token-limit");
  const result = guard.finish({ exitCode: 0, turnUsage: review });
  assert.equal(result.usageComplete, false);
  assert.equal(result.sessionUsage, null);
  assert.equal(result.observedUsage.total_tokens, 128230);
  assert.equal(result.budget.overrunTokens, 8230);
});

test("resume preflight rejects exhausted tokens and request counts at the boundary", () => {
  const initialRows = [turn("offer"), count(usage(90, 0, 10))];
  assert.equal(createGuard({ initialRows, tokenLimit: 100 }).stopReason, "session-token-limit");
  assert.equal(createGuard({ initialRows, requestLimit: 1 }).stopReason, "session-request-limit");
  for (const tokenLimit of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => createGuard({ tokenLimit }));
});

test("lost history or malformed usage preserves observed counts but forbids completion", () => {
  const rows = [turn("one"), count(usage(10, 0, 1))];
  for (const next of [[], [turn("other"), count(usage(10, 0, 1))], [...rows, count(usage(-1, 0, 1))]]) {
    const guard = createGuard();
    guard.observe(rows);
    assert.equal(guard.observe(next), "usage-invalid");
    const receipt = guard.finish({ exitCode: 0, turnUsage: usage(10, 0, 1) });
    assert.equal(receipt.sessionUsage, null);
    assert.equal(receipt.observedUsage.total_tokens, 11);
  }
});

test("failed, blocked, absent and inconsistent receipts cannot claim complete usage", () => {
  for (const scenario of ["failed", "blocked", "missing", "mismatch", "no-requests"]) {
    const guard = createGuard();
    if (scenario !== "no-requests") guard.observe([turn("one"), count(usage(10, 0, 1))]);
    if (scenario === "blocked") guard.fail("sandbox-infrastructure-failure");
    const result = guard.finish({ exitCode: scenario === "failed" ? 1 : 0,
      turnUsage: scenario === "missing" ? null : usage(scenario === "mismatch" ? 9 : 10, 0, 1) });
    assert.equal(result.usageComplete, false, scenario);
    assert.equal(result.sessionUsage, null, scenario);
    assert.equal(result.stageUsage, null, scenario);
  }
});

test("the final sample catches fast exits without waiting for the polling timer", async () => {
  const guard = createGuard({ tokenLimit: 10 });
  const stops = [];
  const watch = watchCodexSession({ guard, stop: (reason) => stops.push(reason),
    readRows: async () => [turn("one"), count(usage(10, 0, 1))] });
  await watch.finish();
  assert.deepEqual(stops, ["session-token-limit"]);
});

test("monitor read errors and infrastructure failures fail closed", async () => {
  for (const unreadable of [false, true]) {
    const guard = createGuard();
    const watch = watchCodexSession({ guard, stop: () => {},
      readRows: async () => { if (unreadable) throw new Error("read failed"); return []; },
      inspectRows: () => "sandbox-infrastructure-failure" });
    await watch.finish();
    assert.equal(guard.stopReason, unreadable ? "session-read-failed" : "sandbox-infrastructure-failure");
  }
});

test("overlapping reads cannot race the final sample", async () => {
  const guard = createGuard();
  let release, started;
  const reading = new Promise((resolve) => { started = resolve; });
  let active = 0, maxActive = 0, calls = 0;
  const watch = watchCodexSession({ guard, stop: () => {}, intervalMs: 1,
    readRows: async () => {
      active++; maxActive = Math.max(active, maxActive); calls++;
      if (calls === 1) { started(); await new Promise((resolve) => { release = resolve; }); }
      active--;
      return [turn("one"), count(usage(10, 0, 1))];
    } });
  await reading;
  const finished = watch.finish();
  release();
  await finished;
  assert.equal(maxActive, 1);
  assert.equal(calls, 2);
  assert.equal(guard.finish({ exitCode: 0, turnUsage: usage(10, 0, 1) }).usageComplete, true);
});

test("the live watcher terminates a local stub on cumulative usage, without a model", async (t) => {
  const initialRows = [turn("offer"), count(usage(100, 0, 10))];
  const guard = createGuard({ initialRows, tokenLimit: 150 });
  const rows = [...initialRows];
  // This executable only writes synthetic usage, then waits for termination.
  const child = spawn(process.execPath, ["-e", `
    process.stdout.write(JSON.stringify(${JSON.stringify(count(usage(50, 0, 5)))}) + '\\n');
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "pipe", "pipe"], env: {} });
  const closed = once(child, "close");
  t.after(() => child.kill("SIGKILL"));
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    if (buffered.includes("\n")) rows.push(turn("review"), JSON.parse(buffered));
  });
  const safety = setTimeout(() => child.kill("SIGKILL"), 5000);
  const watch = watchCodexSession({ guard, intervalMs: 5, readRows: async () => rows,
    stop: () => child.kill("SIGTERM") });
  try {
    const [code, signal] = await closed;
    await watch.finish();
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    assert.equal(guard.stopReason, "session-token-limit");
  } finally {
    clearTimeout(safety);
    await watch.finish();
  }
});
