import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadSuite, materializeCase, summarizeHostRun } from "../scripts/agent-bench/review-host.mjs";
import { aggregateRuns, gradingPrompt, redactArm, scoreVerdict } from "../scripts/agent-bench/review-judge.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(root, "scripts/agent-bench/review-host.mjs");

async function engine(directory) {
  const bin = path.join(directory, "engine", "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "qamap"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "dist/cli.js")}" "$@"\n`, { mode: 0o755 });
  return bin;
}

const assistant = (id, tools = []) => JSON.stringify({ type: "assistant", message: { id, content: tools.map((name) => ({ type: "tool_use", name })) } });

test("host usage sums every model, including forked skill contexts, and counts distinct requests", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init" }),
    assistant("m1", ["Skill"]), assistant("m1", ["Bash"]), assistant("m2"),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.25, result: "Findings",
      usage: { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 },
      modelUsage: {
        main: { inputTokens: 4, cacheCreationInputTokens: 40, cacheReadInputTokens: 400, outputTokens: 20 },
        fork: { inputTokens: 1, cacheCreationInputTokens: 2, cacheReadInputTokens: 3, outputTokens: 4 },
      } }),
  ].join("\n");
  const summary = summarizeHostRun(stdout);
  assert.equal(summary.completed, true);
  assert.equal(summary.totalTokens, 474);
  assert.equal(summary.uncachedInputTokens, 47);
  assert.deepEqual(summary.usage, { input: 5, cacheWrite: 42, cacheRead: 403, output: 24 });
  assert.equal(summary.requests, 2);
  assert.deepEqual(summary.tools, ["Skill", "Bash"]);
  assert.deepEqual(summary.models, ["main", "fork"]);
});

test("incomplete host receipts never become token totals", () => {
  const missing = summarizeHostRun(`${assistant("m1")}\n${JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })}`);
  assert.equal(missing.completed, false);
  assert.equal(missing.totalTokens, null);
  const partial = summarizeHostRun(JSON.stringify({ type: "result", subtype: "success", is_error: false,
    modelUsage: { main: { inputTokens: 1, cacheCreationInputTokens: 1, outputTokens: 1 } } }));
  assert.equal(partial.totalTokens, null);
});

test("every review-host case has a frozen oracle and a materializable definition", async () => {
  const suite = await loadSuite();
  const oracles = JSON.parse(await fs.readFile(path.join(root, "test/benchmarks/review-host/oracles.json"), "utf8"));
  assert.equal(suite.schemaVersion, 1);
  assert.match(suite.prompt, /Static review only/);
  assert.equal(suite.cases.length, new Set(suite.cases.map((entry) => entry.id)).size);
  for (const entry of suite.cases) {
    const oracle = oracles[entry.id];
    assert.ok(oracle, `missing oracle: ${entry.id}`);
    assert.ok(Array.isArray(oracle.seeded));
    if (oracle.kind === "qa-planning") assert.ok(oracle.qaExpectations.length > 0);
    if (entry.kind === "fixture") await fs.stat(path.join(root, entry.fixture, "head"));
    if (entry.kind === "repository-revert") assert.ok(entry.revertPaths.every((file) => file.startsWith("src/")));
  }
});

test("fixtures materialize as main plus one change, with QAMap setup only in the QAMap arm", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-review-host-test-"));
  try {
    const engineBin = await engine(directory);
    const suite = await loadSuite();
    for (const [id, arm] of [["shared-capacity", "qamap"], ["pf-preferences", "standalone"]]) {
      const target = path.join(directory, `${id}-${arm}`);
      const home = path.join(target, "home");
      await fs.mkdir(home, { recursive: true });
      const { repo, base, head } = await materializeCase(suite.cases.find((entry) => entry.id === id), { directory: target, home, engineBin, arm });
      const git = (...args) => execFileSync("git", args, { cwd: repo }).toString().trim();
      assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "feature/change");
      assert.equal(git("rev-list", "--count", `${base}..${head}`), "1");
      assert.ok(git("diff", "--name-only", `${base}...${head}`).length > 0);
      const agents = await fs.readFile(path.join(repo, "AGENTS.md"), "utf8").catch(() => "");
      if (arm === "qamap") assert.match(agents, /qamap:review-mode:report/);
      else assert.equal(agents, "");
      assert.equal(git("status", "--porcelain"), "");
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("repository-revert cases rebuild history up to the fix without later refs", async (t) => {
  const suite = await loadSuite();
  const entry = suite.cases.find((item) => item.kind === "repository-revert");
  try { execFileSync("git", ["-C", root, "cat-file", "-e", `${entry.baseCommit}^{commit}`], { stdio: "ignore" }); }
  catch { t.skip("the checkout does not contain the pinned history; fetch full history to run this case"); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-review-host-revert-"));
  try {
    const home = path.join(directory, "home");
    await fs.mkdir(home);
    const { repo, base } = await materializeCase(entry, { directory, home, engineBin: await engine(directory), arm: "standalone" });
    const git = (...args) => execFileSync("git", args, { cwd: repo }).toString().trim();
    assert.equal(git("rev-parse", "main"), git("rev-parse", `${entry.baseCommit}^{commit}`));
    assert.equal(base, git("rev-parse", "main"));
    assert.deepEqual(git("for-each-ref", "--format=%(refname)").split("\n").sort(), ["refs/heads/feature/change", "refs/heads/main"]);
    assert.deepEqual(git("diff", "--name-only", "main...HEAD").split("\n").sort(), [...entry.revertPaths].sort());
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("dry runs stop before the host and refuse output inside the repository", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-review-host-dry-"));
  try {
    const out = path.join(directory, "out");
    // A host that records any launch proves the dry run never started one.
    const fakeHost = path.join(directory, "host");
    await fs.mkdir(fakeHost);
    await fs.writeFile(path.join(fakeHost, "claude"), `#!/bin/sh\ntouch "${path.join(directory, "host-started")}"\n`, { mode: 0o755 });
    const { stdout } = await exec(process.execPath, [runner, "--engine", path.dirname(await engine(directory)), "--out", out,
      "--case", "distant-assertion", "--runs", "1", "--dry-run"], { env: { ...process.env, PATH: `${fakeHost}${path.delimiter}${process.env.PATH}` } });
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.status), ["dry-run", "dry-run"]);
    const record = JSON.parse(await fs.readFile(path.join(out, "distant-assertion.qamap.run1", "result.json"), "utf8"));
    assert.equal(record.status, "dry-run");
    await assert.rejects(fs.stat(path.join(directory, "host-started")));
    assert.match(record.promptSha256, /^[0-9a-f]{64}$/);
    await assert.rejects(exec(process.execPath, [runner, "--engine", directory, "--out", path.join(root, "bench-results", "x"), "--dry-run"]),
      /outside the repository/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("grading hides the arm and aggregation excludes ineligible runs", () => {
  const redacted = redactArm("Ran `qamap qa brief` at /tmp/qm-run-abc/repo; the QAMap handoff said...");
  assert.doesNotMatch(redacted, /qamap|brief|handoff|\/tmp\//i);
  const oracle = { kind: "regression", seeded: [{ id: "S1" }, { id: "S2" }] };
  assert.match(gradingPrompt(oracle, "answer text"), /"seeded"[\s\S]*answer text/);
  assert.deepEqual(scoreVerdict(oracle, { found: ["S1"], falseDefinite: [] }), { recall: 0.5, qaRecall: null, falseDefinite: 0, uncertaintyRetained: null });
  const runs = [
    { case: "c", arm: "qamap", status: "completed", totalTokens: 100, requests: 2, uncachedInputTokens: 10, score: { recall: 1, qaRecall: null, falseDefinite: 0, uncertaintyRetained: null } },
    { case: "c", arm: "qamap", status: "completed", totalTokens: 300, requests: 4, uncachedInputTokens: 30, score: { recall: 1, qaRecall: null, falseDefinite: 1, uncertaintyRetained: null } },
    { case: "c", arm: "qamap", status: "ineligible", totalTokens: null, requests: 9, score: null },
  ];
  const [entry] = aggregateRuns(runs);
  assert.deepEqual(entry.arms.qamap, { runs: 3, eligible: 2, medianTokens: 200, maxTokens: 300, minTokens: 100, medianRequests: 3,
    medianUncachedInput: 20, recall: 1, qaRecall: null, falseDefinite: 1, uncertaintyRetained: null });
});
