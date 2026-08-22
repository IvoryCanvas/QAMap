import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, cp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assessScenarioExecutability,
  diffE2eRunReceipts,
  formatMarkdownE2eRun,
  generateE2eDraft,
  generateQaDraft,
  runE2eScenario,
} from "../dist/index.js";
import { loadConfig } from "../dist/config.js";

const execFileAsync = promisify(execFile);
const cliPath = path.resolve("dist/cli.js");
const fixtureRoot = path.resolve("test/benchmarks/web-symbol-annotated-renewal");

/** Playwright-shaped executor stand-in: honours the JSON report path, fixture and artifact directories, and a mode file. */
const fakeRunnerSource = `
import { promises as fs } from "node:fs";
import path from "node:path";

const [, , file, grep] = process.argv;
const mode = (await fs.readFile("runner-mode.txt", "utf8")).trim();
const fixtureDir = process.env.QAMAP_FIXTURE_DIR;
const artifactDir = process.env.QAMAP_ARTIFACT_DIR;
const report = process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
if (!fixtureDir || !artifactDir || !report) {
  throw new Error("executor environment is incomplete");
}
await fs.access(path.join(fixtureDir, "photo.bin"));
const seeded = await fs.readFile(path.join(fixtureDir, "seeded.txt"), "utf8");
if (seeded.trim() !== "seeded") throw new Error("seed hook did not run");
const failed = mode === "fail";
if (failed) {
  await fs.writeFile(path.join(artifactDir, "shot.png"), "not really a png");
}
await fs.writeFile(report, JSON.stringify({
  suites: [{
    title: path.basename(file),
    specs: [{
      title: grep.replace(/\\\\/g, ""),
      tests: [{
        projectName: "chromium",
        results: [{
          status: failed ? "failed" : "passed",
          duration: 12.4,
          ...(failed ? { error: { message: "expected 1 request, received 2" }, attachments: [{ name: "screenshot", path: path.join(artifactDir, "shot.png"), contentType: "image/png" }] } : {}),
        }],
      }],
    }],
  }],
}));
process.exit(failed ? 1 : 0);
`;

async function makeRepository(t, configOverrides = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qamap-e2e-run-"));
  const root = path.join(tempRoot, "repo");
  await mkdir(root, { recursive: true });
  await cp(path.join(fixtureRoot, "base"), root, { recursive: true });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "e2e-run-test@qamap.local"]);
  await git(root, ["config", "user.name", "QAMap E2E Run Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  await git(root, ["switch", "-c", "feature/renewal"]);
  await cp(path.join(fixtureRoot, "head"), root, { recursive: true, force: true });
  await mkdir(path.join(root, "fixtures"), { recursive: true });
  await writeFile(path.join(root, "fixtures", "photo.bin"), "binary-ish fixture bytes");
  await writeFile(path.join(root, "fake-runner.mjs"), fakeRunnerSource);
  await writeFile(path.join(root, "seed.mjs"), `
import { promises as fs } from "node:fs";
import path from "node:path";
await fs.writeFile(path.join(process.env.QAMAP_FIXTURE_DIR, "seeded.txt"), "seeded\\n");
`);
  await writeFile(path.join(root, "runner-mode.txt"), "pass\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "feat: guard duplicate renewal requests"]);

  const draft = await generateE2eDraft(root, { base: "main", head: "HEAD", output: "tests/e2e" });
  const compiled = draft.files.flatMap((file) =>
    file.scenarioAutomation.filter((receipt) => receipt.status === "compiled").map((receipt) => ({ file, receipt }))
  );
  assert.ok(compiled.length > 0, "the renewal fixture must compile at least one scenario");
  const { receipt } = compiled.find((entry) => /duplicate renewal request/i.test(entry.receipt.title)) ?? compiled[0];

  const config = {
    executors: {
      fake: { runner: "playwright", command: ["node", "fake-runner.mjs", "{file}", "{grep}"] },
    },
    fixtures: {
      photo: { kind: "file", path: "fixtures/photo.bin" },
      seeded: { kind: "seed", command: ["node", "seed.mjs"] },
    },
    scenarioFixtures: { [receipt.scenarioId]: ["photo", "seeded"] },
    ...configOverrides,
  };
  await writeFile(path.join(root, "qamap.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  t.after(async () => {
    // Leave temp directories for the operating system; nothing else to tear down.
  });
  return { root, scenarioId: receipt.scenarioId, title: receipt.title };
}

function options(root) {
  return { base: "main", head: "HEAD", includeWorkingTree: true, output: "tests/e2e" };
}

async function loadRepoConfig(root) {
  return (await loadConfig(root)).config;
}

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}

test("e2e run executes a compiled scenario through the configured executor and stores a receipt", async (t) => {
  const { root, scenarioId, title } = await makeRepository(t);
  const config = await loadRepoConfig(root);

  const result = await runE2eScenario(root, scenarioId, { ...options(root), config });

  assert.equal(result.scenarioId, scenarioId);
  assert.equal(result.title, title);
  assert.match(result.specPath, /^tests\/e2e\/.+\.spec\.ts$/);
  assert.equal(result.receipt.status, "passed");
  assert.equal(result.receipt.performed, true);
  assert.equal(result.receipt.executor, "fake");
  assert.equal(result.receipt.runner, "playwright");
  assert.equal(result.receipt.exitCode, 0);
  assert.equal(result.receipt.timedOut, false);
  assert.deepEqual(result.receipt.command.slice(0, 2), ["node", "fake-runner.mjs"]);
  assert.match(result.receipt.command[2], /\.spec\.ts$/);
  assert.equal(result.receipt.assertions.length, 1);
  assert.equal(result.receipt.assertions[0].status, "passed");
  assert.match(result.receipt.assertions[0].title, /\[chromium\]$/);
  assert.ok(result.receipt.assertions[0].durationMs >= 12);
  assert.deepEqual(result.receipt.artifacts, []);
  assert.equal(result.receipt.fixtures.status, "ready");
  assert.deepEqual(
    result.receipt.fixtures.fixtures.map((item) => [item.id, item.kind, item.status]),
    [["photo", "file", "materialized"], ["seeded", "seed", "executed"]],
  );
  assert.match(result.receipt.fixtures.fixtures[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(result.receipt.stdoutSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.gitState.observed, true);
  assert.equal(result.comparison, undefined);
  assert.match(result.receiptPath, /^\.qamap\/runs\/e2e\/[a-f0-9]+\/.+\.json$/);
  const stored = JSON.parse(await readFile(path.join(root, ".qamap/runs/e2e", scenarioId.replace("scenario:", ""), "latest.json"), "utf8"));
  assert.equal(stored.receipt.status, "passed");
  assert.doesNotMatch(JSON.stringify(result), /expected 1 request/);

  const markdown = formatMarkdownE2eRun(result);
  assert.match(markdown, /# QAMap E2E Run/);
  assert.match(markdown, /Status: passed/);
  assert.match(markdown, /\[passed\] .*\(1[0-9]ms\)/);
  assert.match(markdown, /photo \(file\): materialized sha256/);
});

test("a failing run keeps assertion errors and failure-only artifacts, and reruns compare receipts", async (t) => {
  const { root, scenarioId } = await makeRepository(t);
  const config = await loadRepoConfig(root);

  const passed = await runE2eScenario(root, scenarioId, { ...options(root), config });
  assert.equal(passed.receipt.status, "passed");

  await writeFile(path.join(root, "runner-mode.txt"), "fail\n");
  const failed = await runE2eScenario(root, scenarioId, { ...options(root), config });
  assert.equal(failed.receipt.status, "failed");
  assert.equal(failed.receipt.exitCode, 1);
  assert.equal(failed.receipt.assertions[0].status, "failed");
  assert.match(failed.receipt.assertions[0].error, /expected 1 request, received 2/);
  assert.deepEqual(failed.receipt.artifacts, [`.qamap/tmp/e2e-run/${scenarioId.replace("scenario:", "")}/artifacts/shot.png`]);
  assert.equal(failed.comparison.verdict, "regressed");
  assert.deepEqual(failed.comparison.statusChanged.map((item) => [item.from, item.to]), [["passed", "failed"]]);
  assert.match(formatMarkdownE2eRun(failed), /Verdict: regressed \(passed -> failed\)/);
  assert.match(formatMarkdownE2eRun(failed), /## Failure Artifacts/);

  await writeFile(path.join(root, "runner-mode.txt"), "pass\n");
  const recovered = await runE2eScenario(root, scenarioId, { ...options(root), config });
  assert.equal(recovered.receipt.status, "passed");
  assert.equal(recovered.comparison.verdict, "recovered");
  assert.deepEqual(recovered.receipt.artifacts, []);

  const same = await runE2eScenario(root, scenarioId, { ...options(root), config });
  assert.equal(same.comparison.verdict, "same");
});

test("missing executor, unknown scenario, failed fixture, and uncompiled scenarios are blocked instead of passed", async (t) => {
  const { root, scenarioId } = await makeRepository(t);

  const noExecutor = await runE2eScenario(root, scenarioId, { ...options(root), config: { fixtures: {}, scenarioFixtures: {} } });
  assert.equal(noExecutor.receipt.status, "blocked");
  assert.equal(noExecutor.receipt.performed, false);
  assert.match(noExecutor.receipt.reason, /No executor is configured/);
  assert.equal(noExecutor.receiptPath, undefined);

  const unknown = await runE2eScenario(root, "scenario:000000000000", { ...options(root), config: await loadRepoConfig(root) });
  assert.equal(unknown.receipt.status, "blocked");
  assert.match(unknown.receipt.reason, /No drafted scenario matches/);

  const badFixtureConfig = {
    ...(await loadRepoConfig(root)),
    fixtures: { photo: { kind: "file", path: "fixtures/missing.bin" }, seeded: { kind: "seed", command: ["node", "seed.mjs"] } },
  };
  const missingFixture = await runE2eScenario(root, scenarioId, { ...options(root), config: badFixtureConfig });
  assert.equal(missingFixture.receipt.status, "blocked");
  assert.match(missingFixture.receipt.reason, /could not be copied/);
  assert.equal(missingFixture.receipt.fixtures.status, "blocked");
  assert.equal(missingFixture.receipt.fixtures.fixtures[0].status, "failed");

  const escapingFixture = {
    ...(await loadRepoConfig(root)),
    fixtures: { photo: { kind: "file", path: "../outside.bin" }, seeded: { kind: "seed", command: ["node", "seed.mjs"] } },
  };
  const escaped = await runE2eScenario(root, scenarioId, { ...options(root), config: escapingFixture });
  assert.equal(escaped.receipt.status, "blocked");
  assert.match(escaped.receipt.reason, /inside the repository/);

  assert.deepEqual(
    assessScenarioExecutability({ scenarioId, status: "partial" }, await loadRepoConfig(root)).status,
    "not-compiled",
  );
  assert.deepEqual(
    assessScenarioExecutability({ scenarioId, status: "compiled" }, { executors: {}, fixtures: {}, scenarioFixtures: {} }).status,
    "executor-missing",
  );
  assert.deepEqual(
    assessScenarioExecutability({ scenarioId, status: "compiled" }, await loadRepoConfig(root)),
    { status: "executable", executor: "fake", fixtureIds: ["photo", "seeded"], reason: "A compiled scenario, a configured executor, and declared fixtures are all present." },
  );
});

test("qamap qa marks scenarios executable when the executor and fixtures are declared", async (t) => {
  const { root, scenarioId } = await makeRepository(t);
  const config = await loadRepoConfig(root);

  const draft = await generateQaDraft(root, { base: "main", head: "HEAD", includeWorkingTree: true, config });
  const receipts = draft.flows.flatMap((flow) => flow.scenarioAutomation);
  const target = receipts.find((receipt) => receipt.scenarioId === scenarioId);
  assert.ok(target, "the executed scenario must appear in the qa draft");
  assert.equal(target.executable?.status, "executable");
  assert.equal(target.executable?.executor, "fake");
  assert.ok(receipts.filter((receipt) => receipt.status !== "compiled").every((receipt) => receipt.executable?.status === "not-compiled"));

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "qa", root, "--base", "main", "--head", "HEAD", "--include-working-tree", "--format", "markdown"]);
  assert.match(stdout, new RegExp(`Executable now: \`qamap e2e run ${scenarioId}\` for .* \\(executor fake; not run by qamap qa\\)`));

  // The compact agent payload may drop scenario automation under its byte limit; the recoverable full report keeps it.
  const agent = await execFileAsync(process.execPath, [cliPath, "qa", root, "--base", "main", "--head", "HEAD", "--include-working-tree", "--format", "agent"]);
  const agentPayload = JSON.parse(agent.stdout);
  const fullReportPath = agentPayload.compaction?.fullReport ?? agentPayload.context?.recovery?.fullReport;
  const fullReport = fullReportPath ? await readFile(fullReportPath, "utf8") : agent.stdout;
  assert.match(fullReport, new RegExp(`"scenarioId": ?"${scenarioId}"[\\s\\S]{0,400}"executable": ?\\{[\\s\\S]{0,80}"status": ?"executable"`));
});

test("qamap e2e run returns the receipt as json or markdown with exit codes for passed, failed, and blocked", async (t) => {
  const { root, scenarioId } = await makeRepository(t);
  const run = (...args) => execFileAsync(process.execPath, [cliPath, "e2e", "run", ...args], { cwd: root }).then(
    (result) => ({ code: 0, stdout: result.stdout }),
    (error) => ({ code: error.code, stdout: error.stdout ?? "" }),
  );

  const passed = await run(scenarioId, root, "--base", "main", "--head", "HEAD", "--include-working-tree", "--format", "json");
  assert.equal(passed.code, 0);
  const payload = JSON.parse(passed.stdout);
  assert.equal(payload.receipt.status, "passed");
  assert.equal(payload.scenarioId, scenarioId);

  await writeFile(path.join(root, "runner-mode.txt"), "fail\n");
  const failed = await run(scenarioId, root, "--base", "main", "--head", "HEAD", "--include-working-tree");
  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /Status: failed/);
  assert.match(failed.stdout, /Verdict: regressed/);

  const blocked = await run("scenario:000000000000", root, "--base", "main", "--head", "HEAD", "--include-working-tree");
  assert.equal(blocked.code, 2);
  assert.match(blocked.stdout, /Status: blocked/);

  const withoutId = await run(root);
  assert.notEqual(withoutId.code, 0);

  const prefix = await run(scenarioId.replace("scenario:", "").slice(0, 8), root, "--base", "main", "--head", "HEAD", "--include-working-tree", "--format", "json");
  assert.equal(prefix.code, 1);
  assert.equal(JSON.parse(prefix.stdout).scenarioId, scenarioId);
});

test("config validation rejects executors without a file token and bindings to undeclared fixtures", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qamap-e2e-run-config-"));
  const write = (value) => writeFile(path.join(tempRoot, "qamap.config.json"), JSON.stringify(value));

  await write({ executors: { web: { runner: "playwright", command: ["pnpm", "exec", "playwright", "test"] } } });
  await assert.rejects(loadConfig(tempRoot), /must reference \{file\}/);

  await write({ executors: { web: { runner: "browser", command: ["x", "{file}"] } } });
  await assert.rejects(loadConfig(tempRoot), /runner must be playwright or command/);

  await write({ executors: { web: { runner: "command", command: ["x", "{file}", "{nope}"] } } });
  await assert.rejects(loadConfig(tempRoot), /unknown token \{nope\}/);

  await write({ fixtures: { photo: { kind: "blob", path: "a" } } });
  await assert.rejects(loadConfig(tempRoot), /kind must be file or seed/);

  await write({ fixtures: { photo: { kind: "file", path: "a.jpg" } }, scenarioFixtures: { "scenario:abcdef123456": ["photo", "ghost"] } });
  await assert.rejects(loadConfig(tempRoot), /references unknown fixture ghost/);

  await write({ scenarioFixtures: { "compose-thumbnail": [] } });
  await assert.rejects(loadConfig(tempRoot), /must be a scenario id/);

  await write({
    executors: { web: { runner: "playwright", command: ["pnpm", "exec", "playwright", "test", "{file}", "--grep", "{grep}", "--reporter=json"], timeoutMs: 120000, env: { CI: "1" } } },
    fixtures: { photo: { kind: "file", path: "fixtures/geo-photo.jpg", description: "geotagged sample" }, seed: { kind: "seed", command: ["node", "scripts/seed.mjs"], timeoutMs: 5000 } },
    scenarioFixtures: { "scenario:abcdef123456": ["photo", "seed"] },
  });
  const { config } = await loadConfig(tempRoot);
  assert.equal(config.executors.web.runner, "playwright");
  assert.equal(config.executors.web.timeoutMs, 120000);
  assert.deepEqual(config.scenarioFixtures, { "scenario:abcdef123456": ["photo", "seed"] });
  assert.equal(config.fixtures.photo.description, "geotagged sample");
  assert.ok(await stat(path.join(tempRoot, "qamap.config.json")));
});

test("diffE2eRunReceipts reports added, removed, and changed assertions", () => {
  const base = { status: "passed", performed: true, scope: "scenario-executor", durationMs: 100, assertions: [
    { title: "a", status: "passed", durationMs: 1 },
    { title: "b", status: "passed", durationMs: 1 },
  ] };
  const next = { ...base, status: "failed", durationMs: 140, assertions: [
    { title: "a", status: "failed", durationMs: 1 },
    { title: "c", status: "passed", durationMs: 1 },
  ] };
  const comparison = diffE2eRunReceipts(base, next);
  assert.equal(comparison.verdict, "regressed");
  assert.deepEqual(comparison.added, ["c"]);
  assert.deepEqual(comparison.removed, ["b"]);
  assert.deepEqual(comparison.statusChanged, [{ title: "a", from: "passed", to: "failed" }]);
  assert.equal(comparison.durationDeltaMs, 40);
  assert.equal(diffE2eRunReceipts(base, base).verdict, "same");
  assert.equal(diffE2eRunReceipts({ status: "blocked", performed: false, scope: "scenario-executor", reason: "x" }, base).verdict, "changed");
});
