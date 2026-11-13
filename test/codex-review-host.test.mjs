import assert from "node:assert/strict";
import test from "node:test";
import { codexArguments, summarizeCodexRun } from "../scripts/agent-bench/codex-review-host.mjs";
import { aggregateRuns } from "../scripts/agent-bench/review-judge.mjs";

const receipt = usage => ({ type: "turn.completed", usage });
const answer = { type: "item.completed", item: { type: "agent_message", text: "Review findings" } };
const transcript = (...events) => events.map(event => JSON.stringify(event)).join("\n");
const validUsage = { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 };

test("Codex cached input is counted once and unavailable metrics stay unknown", () => {
  const run = summarizeCodexRun(transcript(answer, receipt(validUsage)));
  assert.equal(run.completed, true);
  assert.equal(run.totalTokens, 110);
  assert.equal(run.uncachedInputTokens, 20);
  assert.deepEqual(run.usage, { input: 20, cacheRead: 80, cacheWrite: null, output: 10 });
  assert.equal(run.requests, null);
  assert.equal(run.costUsd, null);
  assert.deepEqual(run.models, []);
  assert.equal(run.receiptScope, "CLI-reported-turn");
  assert.equal(summarizeCodexRun(transcript(answer, receipt({ ...validUsage, total_tokens: 110 }))).completed, true);
});

test("Codex incomplete, contradictory, negative and overflowing receipts are ineligible", () => {
  for (const usage of [null, { input_tokens: 1 }, { ...validUsage, cached_input_tokens: 101 }, { ...validUsage, total_tokens: 111 },
    { ...validUsage, input_tokens: -1 }, { ...validUsage, output_tokens: 0.5 },
    { ...validUsage, input_tokens: Number.MAX_SAFE_INTEGER }]) {
    const run = summarizeCodexRun(transcript(answer, receipt(usage)));
    assert.equal(run.completed, false);
    assert.equal(run.totalTokens, null);
  }
});

test("Codex multiple turns, malformed streams and failed turns never become a complete run", () => {
  assert.equal(summarizeCodexRun(transcript(answer, receipt(validUsage), receipt(validUsage))).totalTokens, null);
  assert.equal(summarizeCodexRun(transcript(answer, receipt(validUsage)) + "\ntruncated-json").completed, false);
  assert.equal(summarizeCodexRun(transcript(answer, { type: "turn.failed" }, receipt(validUsage))).completed, false);
  assert.equal(summarizeCodexRun(transcript(receipt(validUsage))).completed, false);
  assert.equal(summarizeCodexRun(transcript(answer, receipt(validUsage)) + "\nnull").completed, false);
  assert.equal(summarizeCodexRun(transcript({ ...answer, item: { ...answer.item, text: "" } }, receipt(validUsage))).completed, false);
});

test("Codex external tools or file changes make a static-only receipt ineligible", () => {
  for (const type of ["web_search", "mcp_tool_call", "file_change"]) {
    const run = summarizeCodexRun(transcript({ type: "item.completed", item: { type } }, answer, receipt(validUsage)));
    assert.equal(run.completed, false);
    assert.deepEqual(run.policyViolations, [type]);
  }
});

test("Codex uses an explicit model, a fresh read-only session and no rules bypass", () => {
  const args = codexArguments({ model: "fixed-model", prompt: "Static review" });
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(!args.includes("--ignore-rules"));
  assert.ok(!args.includes("danger-full-access"));
  assert.throws(() => codexArguments({ prompt: "Review" }), /explicit --model/);
  assert.throws(() => codexArguments({ model: "fixed", prompt: "Review", disableSkills: true }), /not supported/);
});

test("summaries keep hosts separate and do not turn unknown request counts into zero", () => {
  const record = { case: "public-fixture", arm: "qamap", host: "codex", status: "completed", totalTokens: 110,
    uncachedInputTokens: 20, requests: null, score: { recall: 1, qaRecall: null, falseDefinite: 0, uncertaintyRetained: null } };
  const summary = aggregateRuns([record, { ...record }]);
  assert.equal(summary[0].arms.qamap.medianRequests, null);
  assert.equal(summary[0].arms.qamap.medianTokens, 110);
  assert.throws(() => aggregateRuns([record, { ...record, host: "claude" }]), /separate summaries/);
});
