import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cases as regressionCases } from "../test/benchmarks/report-only-evidence/cases.mjs";
import { cases as extendedCases } from "../test/benchmarks/report-only-evidence/extended-cases.mjs";
import { cases as confirmationCases } from "../test/benchmarks/report-only-evidence/confirmation-cases.mjs";
import { cases as completenessCases } from "../test/benchmarks/report-only-evidence/completeness-cases.mjs";
import { cases as releaseCases } from "../test/benchmarks/report-only-evidence/release-cases.mjs";
import { materializeFixtureRepo } from "./lib/fixture-repo.mjs";
import { gradeReportEvidence } from "./report-evidence-grade.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "dist/cli.js");
const { values } = parseArgs({ options: { output: { type: "string" }, assert: { type: "boolean" },
  suite: { type: "string", default: "regression" } }, allowPositionals: false });
assert.ok(values.output, "An external --output directory is required");
const suites = { regression: regressionCases, extended: extendedCases, confirmation: confirmationCases, completeness: completenessCases, release: releaseCases };
assert.ok(Object.hasOwn(suites, values.suite), "Unknown suite");
const cases = suites[values.suite];
const output = path.resolve(values.output);
const relative = path.relative(root, output);
assert.ok(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), "Keep generated reports outside the repository");
await fs.mkdir(output, { recursive: true });
assert.equal((await fs.readdir(output)).length, 0, "Never overwrite an earlier measurement");
const write = (name, value) => fs.writeFile(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const sha = value => createHash("sha256").update(value).digest("hex");
async function digestTree(directory) {
  const entries = [];
  for (const name of (await fs.readdir(directory, { recursive: true })).sort()) {
    const file = path.join(directory, name);
    if ((await fs.lstat(file)).isFile()) entries.push([name, sha(await fs.readFile(file))]);
  }
  return sha(JSON.stringify(entries));
}
const engineDigest = await digestTree(path.join(root, "dist"));
const criteriaDigest = sha(JSON.stringify(cases));
await write("protocol.json", { frozenAt: new Date().toISOString(), suite: values.suite, engineDigest, criteriaDigest,
  runnerDigest: sha(await fs.readFile(fileURLToPath(import.meta.url))),
  graderDigest: sha(await fs.readFile(new URL("./report-evidence-grade.mjs", import.meta.url))),
  modelCalls: 0, repetitions: 2, cases: cases.map(({ base, head, ...criteria }) => criteria),
  gates: ["base passes; head fails only the named tests", "every required implementation, consumer and assertion line is available in the response or its required checked archive",
    "exact excerpt bytes and hashes", "static not-run and unknown coverage retained", "declared runtime gap visible", "repeat evidence stable"],
  boundary: "Evidence availability only. No model reasoning, semantic false-positive rate, token savings, production coverage, or universal correctness claim." });
await write("frozen-cases.json", cases);
const staging = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-evidence-cases-"));
const outcomes = [];
const cleanedRoots = [];
async function writeTree(directory, files) {
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
}
function normalizePaths(value, reportRoot) {
  if (typeof value === "string") return value.split(reportRoot).join("<reports>").replace(/<reports>\/qa-[A-Za-z0-9]+/g, "<reports>/<run>");
  if (Array.isArray(value)) return value.map(item => normalizePaths(item, reportRoot));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizePaths(item, reportRoot)]));
  return value;
}
try {
  for (const entry of cases) {
    const caseRoot = path.join(staging, entry.id);
    await writeTree(path.join(caseRoot, "base"), entry.base);
    await writeTree(path.join(caseRoot, "head"), entry.head);
    const home = path.join(caseRoot, "home"), tmp = path.join(caseRoot, "tmp");
    await fs.mkdir(home); await fs.mkdir(tmp);
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, LANG: "en_US.UTF-8",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "gc.auto", GIT_CONFIG_VALUE_0: "0",
      GIT_CONFIG_KEY_1: "maintenance.auto", GIT_CONFIG_VALUE_1: "false",
      GIT_AUTHOR_DATE: "2026-09-22T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-22T00:00:00Z" };
    let ownedRoot;
    const git = async (cwd, commands) => {
      if (commands[0] === "init") {
        ownedRoot = path.dirname(cwd);
        assert.ok(path.basename(ownedRoot).startsWith("qamap-evidence-repo-"));
        assert.equal(path.basename(cwd), "repo");
      }
      return (await exec("git", commands, { cwd, env, timeout: 30000 })).stdout.trim();
    };
    const testFiles = Object.keys(entry.base).filter(name => name.endsWith(".test.mjs")).sort();
    async function verifyTests(repo, phase) {
      let result;
      try { result = { ...await exec(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], { cwd: repo, env, timeout: 30000 }), code: 0 }; }
      catch (error) { if (!Number.isInteger(error.code) || error.killed) throw error; result = { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
      await fs.writeFile(path.join(output, `${entry.id}.${phase}.tap`), result.stdout + result.stderr, { flag: "wx", mode: 0o600 });
      const failures = [...result.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map(match => match[1]).sort();
      const expected = phase === "base" ? [] : [...entry.failingTests].sort();
      assert.equal(result.code, expected.length ? 1 : 0, `${entry.id}/${phase}: unexpected exit`);
      assert.deepEqual(failures, expected, `${entry.id}/${phase}: unexpected failing tests`);
      assert.ok(/^# tests [1-9]\d*$/m.test(result.stdout), "No test receipt");
      return { code: result.code, failures, status: result.code === 0 ? "passed" : "failed-as-seeded" };
    }
    let fixture, baseTests;
    try {
      fixture = await materializeFixtureRepo({ fixtureRoot: caseRoot, tempPrefix: "qamap-evidence-repo-",
        commits: [{ dir: "head", message: entry.message }], git,
        afterBaseline: async ({ repositoryRoot }) => { baseTests = await verifyTests(repositoryRoot, "base"); } });
      const repo = fixture.repositoryRoot;
      const base = await git(repo, ["rev-parse", "HEAD~1"]), head = await git(repo, ["rev-parse", "HEAD"]);
      const headTests = await verifyTests(repo, "head");
      await git(repo, ["bundle", "create", path.join(output, `${entry.id}.bundle`), "--all"]);
      const files = { ...entry.base, ...entry.head };
      const initial = await git(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]);
      assert.equal(initial, "");
      const reportRoot = path.join(output, entry.id);
      const repeats = [];
      for (let repeat = 0; repeat < 2; repeat++) {
        const started = performance.now();
        const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "report", ".", "--base", base, "--head", head, "--handoff", "--output", reportRoot],
          { cwd: repo, env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
        const durationMs = performance.now() - started;
        const responseFile = path.join(output, `${entry.id}.repeat-${repeat + 1}.handoff.json`);
        await fs.writeFile(responseFile, stdout, { flag: "wx", mode: 0o600 });
        assert.equal(stderr, "");
        const handoff = JSON.parse(stdout);
        assert.equal(handoff.summary.base, base); assert.equal(handoff.summary.head, head);
        const previewGrade = gradeReportEvidence(handoff, files, entry, Buffer.byteLength(stdout));
        let reviewed = handoff;
        let archiveBytesRead = 0;
        let reviewBytesRead = 0;
        if (handoff.evidenceArchive?.required) {
          const archiveText = await fs.readFile(handoff.evidenceArchive.file, "utf8");
          archiveBytesRead = Buffer.byteLength(archiveText);
          assert.equal(archiveBytesRead, handoff.evidenceArchive.bytes);
          assert.equal(sha(archiveText), handoff.evidenceArchive.sha256);
          const archive = JSON.parse(archiveText);
          assert.deepEqual(archive.schema, { name: "qamap.qa.review-evidence", version: 1 });
          assert.deepEqual(archive.execution, handoff.execution);
          reviewed = { ...handoff, reviewEvidence: archive.reviewEvidence };
          if (handoff.evidenceArchive.review) {
            const view = handoff.evidenceArchive.review;
            const text = await fs.readFile(view.file, "utf8");
            reviewBytesRead = Buffer.byteLength(text);
            assert.equal(reviewBytesRead, view.bytes);
            assert.equal(sha(text), view.sha256);
            const retained = new Map();
            let file;
            for (const line of text.split("\n")) {
              const header = line.match(/^FILE (".*") sha256=/);
              if (header) file = JSON.parse(header[1]);
              const numbered = line.match(/^(\d+)\|(.*)$/);
              if (!numbered || !file) continue;
              assert.equal(files[file]?.split("\n")[Number(numbered[1]) - 1], numbered[2]);
              retained.set(`${file}:${numbered[1]}`, numbered[2]);
            }
            for (const anchor of entry.anchors) assert.equal(retained.get(`${anchor.file}:${anchor.line}`), anchor.text);
          }
        }
        const grade = gradeReportEvidence(reviewed, files, entry, Buffer.byteLength(stdout));
        repeats.push({ grade, normalized: normalizePaths(handoff, reportRoot), bytes: Buffer.byteLength(stdout), files: handoff.files,
          previewGrade, archiveBytesRead, reviewBytesRead, additionalReportReads: archiveBytesRead ? 1 : 0,
          responseFile, responseDigest: sha(stdout),
          durationMs, pathsReturned: handoff.reviewEvidence.paths.length,
          omittedPaths: handoff.reviewEvidence.omittedPathCount, omittedGaps: handoff.reviewEvidence.omittedGapCount });
      }
      const repeatStable = JSON.stringify(repeats[0].normalized) === JSON.stringify(repeats[1].normalized);
      assert.equal(await git(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]), "");
      for (const [name, contents] of Object.entries(files)) {
        const actual = name === "package.json.fixture" ? "package.json" : name;
        assert.equal(await fs.readFile(path.join(repo, actual), "utf8"), contents);
      }
      const outcome = { id: entry.id, kind: entry.kind, ...(entry.tier ? { tier: entry.tier } : {}),
        fileCount: Object.keys(files).length, changedFileCount: Object.keys(entry.head).length,
        base, head, baseTests, headTests,
        passed: repeatStable && repeats.every(item => item.grade.passed), repeatStable,
        repetitions: repeats.map(({ normalized, ...rest }) => rest) };
      outcomes.push(outcome);
      await write(`${entry.id}.result.json`, outcome);
      console.log(JSON.stringify({ case: entry.id, passed: outcome.passed, repeatStable,
        retained: repeats[0].grade.retained, required: repeats[0].grade.required,
        missing: repeats[0].grade.missing, safety: repeats[0].grade.safety, requiredGapPresent: repeats[0].grade.requiredGapPresent }));
    } finally {
      if (fixture) await fixture.cleanup();
      else if (ownedRoot) await fs.rm(ownedRoot, { recursive: true });
      if (ownedRoot) {
        assert.equal(await fs.stat(ownedRoot).then(() => true, () => false), false);
        cleanedRoots.push(ownedRoot);
      }
    }
  }
  assert.equal(await digestTree(path.join(root, "dist")), engineDigest);
  assert.equal(sha(JSON.stringify(cases)), criteriaDigest);
  await write("result.json", { status: outcomes.every(item => item.passed) ? "evidence-gate-passed" : "evidence-gate-failed",
    modelCalls: 0, analysisRuns: outcomes.length * 2, cases: outcomes,
    modelQuality: "not-measured", semanticFalsePositives: "not-measured", tokenSavings: "not-measured" });
} catch (error) {
  await write("failure.json", { status: "harness-error", message: error.message,
    completedCases: outcomes.map(item => item.id), modelCalls: 0 });
  throw error;
} finally {
  await fs.rm(staging, { recursive: true });
  assert.equal(await fs.stat(staging).then(() => true, () => false), false);
  await write("cleanup.json", { stagingRemoved: true, staging,
    independentFixtureRootsRemoved: cleanedRoots.length, cleanedRoots, reportsAndBundlesPreserved: true });
}
if (values.assert && outcomes.some(item => !item.passed)) process.exitCode = 1;
