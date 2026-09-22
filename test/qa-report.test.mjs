import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateQaDraft } from "../dist/qa.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
let directory;
let root;
let result;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-local-report-test-"));
  root = path.join(directory, "repository");
  await fs.mkdir(root);
  const git = (...args) => exec("git", args, { cwd: root });
  await git("init", "-b", "main");
  await git("config", "user.name", "QAMap Fixture");
  await git("config", "user.email", "fixture@example.com");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "local-report-fixture", type: "module",
    scripts: { test: "node check.mjs" },
  }));
  await fs.writeFile(path.join(root, "check.mjs"),
    'import { writeFileSync } from "node:fs"; writeFileSync("MUST_NOT_RUN", "executed");\n');
  await fs.writeFile(path.join(root, "profile.mjs"), 'export const label = "Before";\n');
  await git("add", ".");
  await git("commit", "-m", "chore: create report fixture");
  await git("checkout", "-b", "fix/profile");
  await fs.writeFile(path.join(root, "profile.mjs"), 'export const label = "PRIVATE_PROFILE_EVIDENCE";\n');
  await git("add", ".");
  await git("commit", "-m", "fix: retain PRIVATE_PROFILE_EVIDENCE");
  result = await generateQaDraft(root, { base: "main", head: "HEAD" });
});

after(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

async function run(args = [], env = {}) {
  return exec(process.execPath, [cli, "qa", "report", root, "--base", "main", ...args], {
    cwd: root, env: { ...process.env, NO_COLOR: "1", ...env },
  });
}

test("qa report saves complete evidence and returns only a receipt to piped callers", async () => {
  const output = path.join(directory, "reports with spaces");
  const { stdout, stderr } = await run(["--output", output]);
  const receipt = JSON.parse(stdout);
  assert.deepEqual(receipt.schema, { name: "qamap.qa.report", version: 1 });
  assert.equal(receipt.analysis, "complete");
  assert.deepEqual(receipt.execution, { status: "not-run", performed: false });
  assert.equal(receipt.noLlmToken, true);
  assert.equal(stderr, "");
  assert.ok(Buffer.byteLength(stdout) < 2048);
  assert.doesNotMatch(stdout, /PRIVATE_PROFILE_EVIDENCE|run-repository-command|\u001b/);
  assert.deepEqual(Object.keys(receipt.files).sort(), ["full", "report", "summary"]);
  for (const filename of Object.values(receipt.files)) {
    assert.ok(path.isAbsolute(filename));
    assert.ok(filename.startsWith(await fs.realpath(output)));
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(path.dirname(receipt.files.report))).mode & 0o777, 0o700);
  const full = JSON.parse(await fs.readFile(receipt.files.full, "utf8"));
  assert.equal(await fs.realpath(full.evidence.root), await fs.realpath(root));
  assert.equal(full.evidence.execution.status, "not-run");
  assert.ok(full.repositoryIndex);
  assert.match(JSON.stringify(full), /PRIVATE_PROFILE_EVIDENCE/);
  const compact = await fs.readFile(receipt.files.summary, "utf8");
  assert.ok(Buffer.byteLength(compact) <= 4096);
  assert.equal(JSON.parse(compact).compaction.fullReport, receipt.files.full);
  assert.match(await fs.readFile(receipt.files.report, "utf8"), /# QAMap QA Draft/);
  await assert.rejects(fs.access(path.join(root, "MUST_NOT_RUN")));
  assert.equal((await exec("git", ["status", "--porcelain"], { cwd: root })).stdout, "");

  const second = JSON.parse((await run(["--output", output, "--format", "agent"])).stdout);
  assert.notEqual(second.files.full, receipt.files.full);
  assert.equal(await fs.readFile(receipt.files.summary, "utf8"), compact);
});

test("qa report text has a completion banner, usable file links, and no implied passing tests", async () => {
  const output = path.join(directory, "spaces # and 한글");
  const { stdout } = await run(["--output", output, "--format", "text"], { FORCE_COLOR: "1" });
  assert.match(stdout, /\+[-]+\+/);
  assert.match(stdout, /QAMap analysis complete/);
  assert.match(stdout, /Tests: not-run/);
  assert.doesNotMatch(stdout, /PRIVATE_PROFILE_EVIDENCE|\u001b|Tests: passed/);
  const link = stdout.split("\n").find((line) => line.startsWith("file://"));
  assert.match(link, /%20/);
  assert.match(link, /%23/);
  assert.match(await fs.readFile(fileURLToPath(link), "utf8"), /# QAMap QA Draft/);
});

test("qa report defaults to a durable directory outside the repository", async () => {
  const home = path.join(directory, "home");
  await fs.mkdir(home);
  const receipt = JSON.parse((await run(["--format", "json"], { HOME: home })).stdout);
  assert.ok(receipt.files.full.startsWith(path.join(await fs.realpath(home), "QAMap-reports")));
});

test("handoff returns planning evidence but never executes the suggested repository command", async () => {
  const config = path.join(directory, "handoff-config.json");
  await fs.writeFile(config, JSON.stringify({ validationCommands: ["node check.mjs"] }));
  const testFile = path.join(root, "profile.test.mjs");
  await fs.writeFile(testFile, 'import "./check.mjs";\nimport test from "node:test";\ntest("profile output", () => {});\n');
  try {
    const receipt = JSON.parse((await run(["--handoff", "--config", config, "--base", "HEAD",
      "--include-working-tree", "--output", path.join(directory, "handoff")])).stdout);
    assert.equal(receipt.schema.name, "qamap.qa.handoff");
    assert.equal(receipt.summary.route.nextAction, "run-repository-command");
    assert.equal(receipt.execution.performed, false);
    await assert.rejects(fs.access(path.join(root, "MUST_NOT_RUN")));
  } finally { await fs.unlink(testFile); }
});

test("qa report errors never print a success receipt or overwrite an existing file", async () => {
  const output = path.join(directory, "sentinel");
  await fs.writeFile(output, "keep");
  await assert.rejects(run(["--output", output]), (error) => {
    assert.equal(error.stdout, "");
    assert.ok(error.code !== 0);
    return true;
  });
  assert.equal(await fs.readFile(output, "utf8"), "keep");
  await assert.rejects(run(["--format", "sarif"]), (error) => {
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /qa report supports text, json, or agent/);
    return true;
  });
  const { stdout } = await exec(process.execPath, [cli, "qa", "report", "--help"]);
  assert.match(stdout, /qamap qa report/);
});

test("report writer refuses symlink destinations and cleans up partial bundles", async (context) => {
  const { writeLocalQaReport } = await import("../dist/qa-report.js");
  const output = path.join(directory, "atomic");
  await fs.mkdir(output);
  const alias = path.join(directory, "alias");
  await fs.symlink(output, alias);
  await assert.rejects(writeLocalQaReport(result, alias), /symbolic link/);
  const original = fs.writeFile;
  let calls = 0;
  const mocked = context.mock.method(fs, "writeFile", async (...args) => {
    if (++calls === 2) throw new Error("simulated disk failure");
    return original(...args);
  });
  await assert.rejects(writeLocalQaReport(result, output), /simulated disk failure/);
  mocked.mock.restore();
  assert.deepEqual(await fs.readdir(output), []);
});

test("report writer cannot relabel an executed result as static analysis", async () => {
  const { writeLocalQaReport } = await import("../dist/qa-report.js");
  await assert.rejects(writeLocalQaReport({ ...result, execution: { status: "passed", performed: true } },
    path.join(directory, "must-not-create")), /static analysis/);
  await assert.rejects(fs.access(path.join(directory, "must-not-create")));
});

test("human receipt neutralizes terminal controls without damaging its file URL", async () => {
  const { formatLocalQaReportReceipt } = await import("../dist/qa-report.js");
  const filename = "/example/new\nline-\u001b[31m/report.md";
  const receipt = {
    schema: { name: "qamap.qa.report", version: 1 },
    analysis: "complete", execution: { status: "not-run", performed: false },
    noLlmToken: true, files: { report: filename, summary: filename, full: filename },
  };
  const human = formatLocalQaReportReceipt(receipt, true);
  assert.doesNotMatch(human, /\u001b|new\nline/);
  const url = human.split("\n").find((line) => line.startsWith("file://"));
  assert.equal(fileURLToPath(url), filename);
  assert.deepEqual(JSON.parse(formatLocalQaReportReceipt(receipt, false)), receipt);
});
