import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { runAgentLoop } from "../scripts/agent-bench/loop.mjs";
import { createProvider } from "../scripts/agent-bench/provider.mjs";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRepositoryEnvironment } from "../scripts/agent-bench/repository-arms.mjs";

test("a failed later provider request preserves known usage but never complete totals", async () => {
  let calls = 0;
  const provider = { complete: async () => {
    if (calls++) throw new Error("provider unavailable");
    return { assistantMessage: { role: "assistant", content: [] },
      toolUses: [{ id: "one", name: "read_file", input: {} }], stopReason: "tool-use",
      usage: { inputTokens: 120, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: null } };
  } };
  await assert.rejects(runAgentLoop({ provider, tools: [], executor: { execute: async () => "ok" },
    system: "test", prompt: "test", maxTurns: 3 }), (error) => {
    assert.equal(error.receipt.inputTokens, null);
    assert.equal(error.receipt.partialUsage.inputTokens, 120);
    assert.equal(error.receipt.partialUsage.outputTokens, 8);
    assert.equal(error.receipt.usageComplete, false);
    assert.equal(error.receipt.toolCalls, 1);
    assert.equal(error.receipt.turns, 2);
    return true;
  });
});

test("provider timeout covers response bodies and redacts transport errors", async () => {
  const provider = createProvider({ name: "openai", model: "test", apiKey: "synthetic-secret",
    requestTimeoutMs: 10, fetchImpl: async (_url, { signal }) => ({ ok: true,
      text: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("synthetic-secret")))) }) });
  const result = assert.rejects(provider.complete({ system: "test", messages: [], tools: [] }),
    (error) => /timed out/.test(error.message) && !error.message.includes("synthetic-secret"));
  await Promise.all([setTimeout(30), result]);
});

test("the shared request ceiling blocks network calls after its limit", async () => {
  let calls = 0;
  const provider = createProvider({ name: "openai", model: "test", apiKey: "synthetic-secret",
    maxRequests: 1, fetchImpl: async () => { calls++; return { ok: true,
      text: async () => JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 } }) }; } });
  await provider.complete({ system: "test", messages: [], tools: [] });
  await assert.rejects(provider.complete({ system: "test", messages: [], tools: [] }), /request budget exhausted/);
  assert.equal(calls, 1);
});

test("CLI failure reports preserve partial usage with a local-only transport stub", async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-provider-receipt-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const stub = path.join(temporary, "transport.mjs");
  await fs.writeFile(stub, `let calls = 0;
globalThis.fetch = async () => ++calls === 1 ? { ok: true, text: async () => JSON.stringify({
  choices: [{ message: { tool_calls: [{ id: 'one', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 12, completion_tokens: 3 }
}) } : { ok: false, status: 503, text: async () => 'synthetic outage' };
`);
  const env = { ...await createRepositoryEnvironment(temporary), QAMAP_BENCH_PROVIDER: "openai",
    QAMAP_BENCH_MODEL: "synthetic-local-test", QAMAP_BENCH_API_KEY: "synthetic-test-key" };
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", stub,
    path.join(root, "scripts/agent-bench.mjs"), "--config", path.join(root, "agent-repository-bench.config.json"),
    "--task", "plan-ui-change", "--arm", "generic", "--runs", "1", "--assert", "--format", "json", "--save"],
  { cwd: temporary, env, maxBuffer: 4 * 1024 * 1024 }), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(report.pinned.provider, "openai");
    assert.match(report.pinned.implementationSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.tasks.length, 1);
    const run = report.tasks[0].arms.generic.runs[0];
    assert.equal(run.partialUsage.inputTokens, 12);
    assert.equal(run.partialUsage.outputTokens, 3);
    assert.equal(run.inputTokens, null);
    assert.equal(run.success, false);
    assert.equal(report.summary.qualityPassed, false);
    assert.doesNotMatch(error.stdout + error.stderr, /synthetic-test-key/);
    return true;
  });
});

test("CLI judge errors retain completed usage without passing quality", async (t) => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-judge-receipt-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const stub = path.join(temporary, "transport.mjs");
  await fs.writeFile(stub, `let calls = 0;
globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({
  choices: [{ message: ++calls === 1 ? { tool_calls: [{ id: 'one', type: 'function', function: {
    name: 'bash', arguments: JSON.stringify({command: 'ln -s package.json unexpected-link'})
  } }] } : {content: 'done'}, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 12, completion_tokens: 3 }
}) });
`);
  const env = { ...await createRepositoryEnvironment(temporary), QAMAP_BENCH_PROVIDER: "openai",
    QAMAP_BENCH_MODEL: "synthetic-local-test", QAMAP_BENCH_API_KEY: "synthetic-test-key" };
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", stub,
    path.join(root, "scripts/agent-bench.mjs"), "--config", path.join(root, "agent-repository-bench.config.json"),
    "--task", "plan-ui-change", "--arm", "generic", "--runs", "1", "--assert", "--format", "json"],
  { cwd: temporary, env, maxBuffer: 4 * 1024 * 1024 }), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    const run = report.tasks[0].arms.generic.runs[0];
    assert.match(run.error, /unsupported entry/);
    assert.equal(run.inputTokens, 24);
    assert.equal(run.outputTokens, 6);
    assert.equal(run.success, false);
    assert.equal(report.summary.qualityPassed, false);
    assert.equal(run.partialUsage, undefined);
    return true;
  });
});
