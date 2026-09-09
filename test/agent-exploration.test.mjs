import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createIORecorder } from "../scripts/agent-bench/io.mjs";
import { createToolExecutor } from "../scripts/agent-bench/tools.mjs";
import { compareRepositoryArms } from "../scripts/agent-bench/repository-arms.mjs";

const compact = JSON.stringify({ schema: { name: "qamap.qa", version: 1 }, execution: { status: "not-run" } }) + "\n[exit 0]";
const plain = { compact: false, recovery: false, truncated: false };

test("exploration starts only after an intact compact receipt, not an attempted call", () => {
  const io = createIORecorder({});
  io.input("read_file", { path: "source.js" });
  io.output("before", plain);
  io.input("qamap_qa", { format: "agent" });
  io.output(compact, { ...plain, compact: true });
  assert.equal(io.snapshot().exploration.callsByTool.read_file, 1);
  assert.equal(io.snapshot().exploration.afterCompact.toolOutputBytes, 0);
  assert.equal(io.snapshot().exploration.afterCompact.callsByTool.qamap_qa, 0);

  io.input("grep", { pattern: "value" });
  io.output("caf\u00e9", plain);
  io.input("read_file", { path: "missing.js" });
  io.error();
  io.input("qamap_qa", { format: "agent" });
  io.output(compact, { ...plain, compact: true });
  const result = io.snapshot();
  assert.equal(result.exploration.afterCompact.callsByTool.grep, 1);
  assert.equal(result.exploration.afterCompact.callsByTool.read_file, 1);
  assert.equal(result.exploration.afterCompact.callsByTool.qamap_qa, 1);
  assert.equal(result.exploration.afterCompact.toolErrors, 1);
  assert.equal(result.exploration.afterCompact.toolOutputBytes, Buffer.byteLength("caf\u00e9" + compact));
  result.exploration.afterCompact.callsByTool.grep = 99;
  assert.equal(io.snapshot().exploration.afterCompact.callsByTool.grep, 1);
});

test("invalid, failed, full, and truncated reports do not imply a compact handoff", () => {
  for (const [output, options] of [
    ["not JSON\n[exit 0]", { compact: true }],
    ["{}\n[exit 0]", { compact: true }],
    [compact.replace("[exit 0]", "[exit 1]"), { compact: true }],
    [compact, { compact: true, truncated: true }],
    [compact, { recovery: true }],
  ]) {
    const io = createIORecorder({});
    io.input("qamap_qa", {});
    io.output(output, { ...plain, ...options });
    assert.equal(io.snapshot().exploration.afterCompact, null);
  }
  const io = createIORecorder({});
  io.input("__proto__", {});
  assert.equal(io.snapshot().exploration.callsByTool.other, 1);
  io.output(compact.replace("\n[exit 0]", "\n[stderr]\nwarning\n[exit 0]"), { ...plain, compact: true });
  assert.ok(io.snapshot().exploration.afterCompact, "stderr does not hide a successfully delivered report");
});

test("direct rereads match normalized paths and observed bytes, not just file names", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-exploration-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "source.txt"), "caf\u00e9\n");
  await fs.writeFile(path.join(root, "other.txt"), "caf\u00e9\n");
  const executor = await createToolExecutor({ repositoryRoot: root, cliPath: "unused", measureIO: true, maxOutputBytes: 64 });
  await executor.execute("read_file", { path: "source.txt" });
  await executor.execute("read_file", { path: "./source.txt" });
  await executor.execute("read_file", { path: "other.txt" });
  await fs.writeFile(path.join(root, "source.txt"), "new\n");
  await executor.execute("read_file", { path: "source.txt" });
  await executor.execute("grep", { path: "source.txt", pattern: "new" });
  await executor.execute("bash", { command: "printf 'opaque'" });
  await assert.rejects(executor.execute("read_file", { path: "missing.txt" }));
  const io = executor.measurements();
  assert.deepEqual(io.exploration.directFileReads, { calls: 4, uniqueTargets: 2, repeatedCalls: 1, repeatedBytes: 6 });
  assert.equal(io.fileReadBytes, 26);
  assert.equal(io.exploration.callsByTool.read_file, 5, "failed attempts remain visible");
  assert.equal(io.exploration.callsByTool.grep, 1);
  assert.equal(io.exploration.callsByTool.bash, 1);
  assert.equal(io.exploration.afterCompact, null);
  assert.equal(io.subprocessFileReadBytes, null);
  assert.doesNotMatch(JSON.stringify(io), new RegExp(root));
});

test("capped repeated prefixes are counted without claiming complete file coverage", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-prefix-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "source.txt"), "same-old");
  const executor = await createToolExecutor({ repositoryRoot: root, cliPath: "unused", measureIO: true, maxOutputBytes: 4 });
  await executor.execute("read_file", { path: "source.txt" });
  await fs.writeFile(path.join(root, "source.txt"), "same-new");
  await executor.execute("read_file", { path: "source.txt" });
  const io = executor.measurements();
  assert.equal(io.exploration.directFileReads.repeatedBytes, 4);
  assert.equal(io.cappedFileReads, 2);
  assert.equal(io.inputTokens, undefined);
});

test("efficiency differences require matched quality and usage, including missing-metric controls", () => {
  const pairing = { taskSha256: "a".repeat(64), systemPromptSha256: "b".repeat(64), toolsSha256: "c".repeat(64),
    provider: "test", model: "fixed", maxOutputTokens: 64, fixtureTrees: ["a".repeat(40), "b".repeat(40)], carryOver: "none" };
  const run = (totalMs, repeatedBytes) => ({ run: 1, firstAuthoring: false, pairing, success: true,
    inputTokens: 100, outputTokens: 10, toolCalls: 3, timing: { totalMs },
    io: { toolOutputBytes: 100, exploration: { directFileReads: { repeatedBytes } } } });
  const arms = { generic: { runs: [run(100, 40)] }, "qamap-warm": { runs: [run(120, 10)] } };
  const compare = (value = arms, status = "measured") => compareRepositoryArms(value, status)[0];
  assert.deepEqual(compare().diagnostics, {
    toolCallsMedianDifference: 0, toolOutputBytesMedianDifference: 0,
    repeatedFileReadBytesMedianDifference: 30, totalWallClockMsMedianDifference: -20,
  });
  for (const status of ["dry-run", "skipped"]) {
    assert.ok(Object.values(compare(arms, status).diagnostics).every((value) => value === null));
  }
  for (const overrides of [{ success: false }, { error: "timeout" }, { inputTokens: null }, { pairing: null }, { run: 2 }]) {
    const changed = structuredClone(arms);
    Object.assign(changed["qamap-warm"].runs[0], overrides);
    assert.ok(Object.values(compare(changed).diagnostics).every((value) => value === null));
  }
  for (const invalid of [null, undefined, NaN, Infinity, -1]) {
    const changed = structuredClone(arms);
    changed["qamap-warm"].runs[0].timing.totalMs = invalid;
    assert.equal(compare(changed).diagnostics.totalWallClockMsMedianDifference, null);
    assert.equal(compare(changed).diagnostics.repeatedFileReadBytesMedianDifference, 30);
  }
});
