import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { materializeFixtureRepo } from "../scripts/lib/fixture-repo.mjs";
import { generateQaDraft } from "../dist/qa.js";
import { writeLocalQaReport } from "../dist/qa-report.js";
import { buildRepositoryEvidenceIndex } from "../dist/repository-index.js";
import { traceRepositoryImpact } from "../dist/repository-impact.js";
import { formatReviewEvidenceText } from "../dist/qa-evidence-text.js";
import { unpackReviewText } from "../dist/qa-evidence-pack.js";
import { buildLocalQaHandoff } from "../dist/qa-handoff.js";
import { cases } from "./benchmarks/report-only-evidence/extended-cases.mjs";

async function repository(t, base, head) {
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-complete-evidence-"));
  t.after(() => fs.rm(staging, { recursive: true, force: true }));
  for (const [phase, files] of [["base", base], ["head", head]]) {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(staging, phase, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
  }
  const fixture = await materializeFixtureRepo({ fixtureRoot: staging,
    commits: [{ dir: "head", message: "feat: update validation behavior" }] });
  t.after(fixture.cleanup);
  return { root: fixture.repositoryRoot, output: path.join(staging, "reports") };
}

test("literal runtime policy arguments retain the concrete module without claiming runtime coverage", async t => {
  const scenario = cases.find(entry => entry.id === "runtime-policy-choice");
  const { root, output } = await repository(t, scenario.base, scenario.head);
  const result = await generateQaDraft(root, { base: "HEAD~1", head: "HEAD" });
  const receipt = await writeLocalQaReport(result, output, { handoff: true });
  const candidates = result.repositoryImpact.paths.flatMap(entry => entry.evidence)
    .filter(step => step.relation === "runtime-module-candidate");
  assert.ok(candidates.some(step => step.file === "src/policy.mjs" && step.symbol === "accept"));
  assert.match(JSON.stringify(receipt.reviewEvidence), /value >= 0/);
  assert.ok(result.repositoryImpact.boundaries.some(gap => gap.reason === "runtime-module-loading"));
  assert.equal(receipt.execution.status, "not-run");
  assert.equal(receipt.reviewEvidence.complete, false);
  const cacheDirectory = path.join(output, "cache");
  const cold = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  const warm = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.equal(warm.reuse.status, "warm");
  assert.deepEqual(warm.blocks, cold.blocks);
  assert.deepEqual(traceRepositoryImpact(warm, [{ file: "src/select.mjs", lines: [2] }]),
    traceRepositoryImpact(cold, [{ file: "src/select.mjs", lines: [2] }]));
});

for (const [name, body, call] of [
  ["unknown argument", "return import(moduleName);", "selectPolicy(runtimeValue)"],
  ["reassigned parameter", "moduleName = './other.mjs'; return import(moduleName);", "selectPolicy('./policy.mjs')"],
  ["nested shadow", "return (async moduleName => import(moduleName))('./other.mjs');", "selectPolicy('./policy.mjs')"],
  ["traversal", "return import(moduleName);", "selectPolicy('../../outside.mjs')"],
  ["shadowed callee", "return import(moduleName);", "(selectPolicy => selectPolicy('./policy.mjs'))(unrelated)"],
  ["spread arguments", "return import(moduleName);", "selectPolicy(...values, './policy.mjs')"],
  ["default parameter", "return import(moduleName);", "selectPolicy()"],
  ["loop assignment", "for (moduleName of choices) {} return import(moduleName);", "selectPolicy('./policy.mjs')"],
  ["eval mutation", "eval(assignment); return import(moduleName);", "selectPolicy('./policy.mjs')"],
]) {
  test(`runtime evidence does not guess from ${name}`, async t => {
    const base = {
      "src/select.mjs": "export async function selectPolicy(moduleName) { return null; }\n",
      "src/policy.mjs": "export const accept = value => value >= 0;\n",
      "test/select.test.mjs": `import { selectPolicy } from '../src/select.mjs';\ntest('policy', async () => { await ${call}; });\n`,
    };
    const { root } = await repository(t, base, {
      "src/select.mjs": `export async function selectPolicy(moduleName) { ${body} }\n`,
    });
    const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
    const impact = traceRepositoryImpact(index, [{ file: "src/select.mjs", lines: [1] }]);
    assert.ok(impact.paths.every(entry => !entry.evidence.some(step => step.relation === "runtime-module-candidate")));
    assert.ok(impact.boundaries.some(gap => gap.reason === "runtime-module-loading"));
  });
}

test("large changes preserve every discovered endpoint in the local evidence archive", async t => {
  const count = 160;
  const base = {}, head = {};
  for (let i = 0; i < count; i++) {
    base[`src/rule-${i}.mjs`] = `export function check${i}(value) { return Math.max(0, value); }\n`;
    head[`src/rule-${i}.mjs`] = `export function check${i}(value) { return value; }\n`;
    base[`test/rule-${i}.test.mjs`] = `import { check${i} } from '../src/rule-${i}.mjs';\ntest('lower bound', () => { assert.equal(check${i}(-1), 0); });\n`;
  }
  const { root, output } = await repository(t, base, head);
  const result = await generateQaDraft(root, { base: "HEAD~1", head: "HEAD" });
  const receipt = await writeLocalQaReport(result, output, { handoff: true });
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) + 1 <= 16384);
  assert.equal(result.repositoryImpact.discardedPaths, 0);
  assert.equal(result.repositoryImpact.paths.length + result.repositoryImpact.overflowPaths.length, count);
  assert.equal(receipt.evidenceArchive.required, false);
  assert.ok(receipt.inlineReview);
  const archiveText = await fs.readFile(receipt.evidenceArchive.file, "utf8");
  assert.equal(receipt.evidenceArchive.bytes, Buffer.byteLength(archiveText));
  assert.equal(receipt.evidenceArchive.sha256, createHash("sha256").update(archiveText).digest("hex"));
  assert.equal((await fs.stat(receipt.evidenceArchive.file)).mode & 0o777, 0o600);
  const archive = JSON.parse(archiveText);
  assert.equal(unpackReviewText(receipt.inlineReview), formatReviewEvidenceText(archive.reviewEvidence, { digest: true }));
  const review = await fs.readFile(receipt.evidenceArchive.review.file, "utf8");
  assert.equal(receipt.evidenceArchive.review.bytes, Buffer.byteLength(review));
  assert.equal(receipt.evidenceArchive.review.sha256, createHash("sha256").update(review).digest("hex"));
  assert.ok(Buffer.byteLength(review) < Buffer.byteLength(archiveText));
  const reviewLines = new Map();
  let current;
  for (const line of review.split("\n")) {
    const header = line.match(/^FILE (".*") sha256=/);
    if (header) current = JSON.parse(header[1]);
    const numbered = line.match(/^(\d+)\|(.*)$/);
    if (numbered && current) reviewLines.set(`${current}:${numbered[1]}`, numbered[2]);
  }
  assert.equal(archive.reviewEvidence.omittedPathCount, 0);
  assert.equal(archive.reviewEvidence.paths.length, count);
  assert.equal(archive.execution.status, "not-run");
  const full = JSON.parse(await fs.readFile(receipt.files.full, "utf8"));
  for (const entry of archive.reviewEvidence.paths) {
    const original = entry.pointer.split("/").slice(1).reduce((value, key) => value?.[key], full);
    assert.equal(original.changedFile, entry.source.file);
    assert.ok(entry.source.lines.some(line => line.text.includes("return value")));
    assert.ok(entry.contract.lines.some(line => line.text.includes("assert.equal")));
    for (const excerpt of [entry.source, entry.contract]) for (const line of excerpt.lines) {
      assert.equal(reviewLines.get(`${excerpt.file}:${line.line}`), line.text);
    }
  }
  assert.equal(new Set(archive.reviewEvidence.paths.map(entry => entry.source.file)).size, count);
  assert.equal(archive.reviewEvidence.omittedGapCount, 0);
  const fallback = await buildLocalQaHandoff(result, {
    analysis: receipt.analysis, execution: receipt.execution, noLlmToken: true, files: receipt.files,
  }, receipt.summary, receipt.evidenceArchive, { ...receipt.inlineReview, instructions: "x".repeat(17000) });
  assert.equal(fallback.inlineReview, undefined);
  assert.equal(fallback.evidenceArchive.required, true);
  assert.ok(fallback.reviewEvidence.paths.length > 0);
  const bounded = traceRepositoryImpact(result.repositoryIndex,
    Object.keys(head).map(file => ({ file, lines: [1] })), { maxPaths: 2, maxArchivePaths: 3 });
  assert.equal(bounded.paths.length, 2);
  assert.equal(bounded.overflowPaths.length, 3);
  assert.equal(bounded.omittedPaths, 158);
  assert.equal(bounded.discardedPaths, 155);
  assert.ok(bounded.boundaries.some(entry => entry.reason === "evidence-archive-limit"));
  const byteLimited = traceRepositoryImpact(result.repositoryIndex,
    Object.keys(head).map(file => ({ file, lines: [1] })), { maxPaths: 2, maxArchiveBytes: 1 });
  assert.equal(byteLimited.overflowPaths.length, 0);
  assert.equal(byteLimited.discardedPaths, 158);
});

test("text review resolves backward references and rejects conflicting source evidence", () => {
  const excerpt = { file: "src/value.mjs", line: 1, sourceHash: "a".repeat(64), lines: [{ line: 1, text: "export const value = 1;" }] };
  const pair = { source: excerpt, contract: excerpt, endpoint: "test-reference" };
  const evidence = { paths: [pair, { ...pair, source: { ...excerpt, lines: undefined, excerptRef: "/reviewEvidence/paths/0/source" } }],
    gaps: [{ file: "src/value.mjs", line: 1, reason: "runtime-module-loading" }, { file: "src/value.mjs", line: 1, reason: "runtime-module-loading" }],
    omittedPathCount: 0, omittedGapCount: 0 };
  const text = formatReviewEvidenceText(evidence);
  assert.equal(text.split("1|export const value = 1;").length - 1, 1);
  assert.match(text, /count=2 lines=1/);
  assert.throws(() => formatReviewEvidenceText({ ...evidence, paths: [{ ...pair,
    source: { ...excerpt, excerptRef: "/reviewEvidence/paths/9/source" } }] }), /Invalid review evidence reference/);
  assert.throws(() => formatReviewEvidenceText({ ...evidence, paths: [pair, { ...pair,
    source: { ...excerpt, sourceHash: "b".repeat(64) } }] }), /Conflicting review evidence hashes/);
  assert.throws(() => formatReviewEvidenceText({ ...evidence, paths: [pair, { ...pair,
    source: { ...excerpt, lines: [{ line: 1, text: "changed" }] } }] }), /Conflicting review evidence lines/);
});
