import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gradeReportEvidence } from "../scripts/report-evidence-grade.mjs";
import { cases } from "./benchmarks/report-only-evidence/cases.mjs";

function example() {
  const files = { "src/a.mjs": "return changed;\n", "test/a.mjs": "assert.equal(result, expected);\n" };
  const excerpt = file => ({ file, line: 1, sourceHash: createHash("sha256").update(files[file]).digest("hex"),
    lines: [{ line: 1, text: files[file].trimEnd() }] });
  const criteria = { anchors: [{ id: "condition", file: "src/a.mjs", line: 1, text: "return changed;" },
    { id: "assertion", file: "test/a.mjs", line: 1, text: "assert.equal(result, expected);" }] };
  const handoff = { schema: { name: "qamap.qa.handoff", version: 1 }, analysis: "complete",
    execution: { status: "not-run", performed: false }, summary: { execution: { status: "not-run", performed: false } },
    usage: { analysisLlmCalls: 0, callerTokens: "not-measured" },
    reviewEvidence: { complete: false, paths: [{ source: excerpt("src/a.mjs"), contract: excerpt("test/a.mjs") }], gaps: [] } };
  return { files, criteria, handoff };
}

test("evidence gate accepts exact anchors without claiming model quality or token savings", () => {
  const { files, criteria, handoff } = example();
  const grade = gradeReportEvidence(handoff, files, criteria, 1024);
  assert.equal(grade.passed, true);
  assert.equal(grade.modelQuality, "not-measured");
  assert.equal(grade.semanticFalsePositives, "not-measured");
  assert.equal(grade.tokenSavings, "not-measured");
});

test("missing critical evidence fails even when incompleteness is honestly disclosed", () => {
  const { files, criteria, handoff } = example();
  handoff.reviewEvidence.paths[0].contract.lines = [];
  handoff.reviewEvidence.omittedPathCount = 1;
  const grade = gradeReportEvidence(handoff, files, criteria, 1024);
  assert.equal(grade.passed, false);
  assert.deepEqual(grade.missing, ["assertion"]);
});

test("wrong hashes, invented line text and invalid line numbers do not satisfy evidence", () => {
  for (const mutate of [
    value => { value.sourceHash = "wrong"; },
    value => { value.lines[0].text = "invented"; },
    value => { value.lines[0].line = 0; },
  ]) {
    const { files, criteria, handoff } = example();
    mutate(handoff.reviewEvidence.paths[0].source);
    const grade = gradeReportEvidence(handoff, files, criteria, 1024);
    assert.equal(grade.passed, false);
    assert.ok(grade.integrityErrors.length > 0);
    assert.ok(grade.missing.includes("condition"));
  }
});

test("execution claims, output overflow and absent runtime gaps cannot pass", () => {
  const { files, criteria, handoff } = example();
  criteria.requiredGap = { file: "src/a.mjs", reason: "runtime-module-loading" };
  assert.equal(gradeReportEvidence(handoff, files, criteria, 1024).passed, false);
  handoff.reviewEvidence.gaps.push(criteria.requiredGap);
  assert.equal(gradeReportEvidence(handoff, files, criteria, 1024).passed, true);
  assert.equal(gradeReportEvidence(handoff, files, criteria, 16385).passed, false);
  handoff.execution.status = "passed";
  assert.equal(gradeReportEvidence(handoff, files, criteria, 1024).passed, false);
});

test("six frozen case definitions use exact unique head anchors and contain both controls", () => {
  assert.equal(cases.length, 6);
  assert.equal(new Set(cases.map(item => item.id)).size, 6);
  assert.ok(cases.some(item => item.kind === "negative-control"));
  assert.ok(cases.some(item => item.kind === "uncertainty"));
  for (const entry of cases) {
    const files = { ...entry.base, ...entry.head };
    assert.ok(entry.anchors.length > 0);
    assert.equal(new Set(entry.anchors.map(item => item.id)).size, entry.anchors.length);
    for (const anchor of entry.anchors) assert.equal(files[anchor.file].split("\n")[anchor.line - 1], anchor.text);
    assert.equal(entry.failingTests.length > 0, entry.kind === "regression");
  }
});

test("intermediate evidence and backward references retain the same hash and line requirements", () => {
  const { files, criteria, handoff } = example();
  const pair = handoff.reviewEvidence.paths[0];
  pair.via = [pair.contract];
  pair.contract = pair.source;
  handoff.reviewEvidence.paths.push({ source: { file: "src/a.mjs", line: 1,
    excerptRef: "/reviewEvidence/paths/0/source" }, contract: { file: "test/a.mjs", line: 1,
    excerptRef: "/reviewEvidence/paths/0/via/0" } });
  assert.equal(gradeReportEvidence(handoff, files, criteria, 1024).passed, true);
  pair.via[0].lines[0].text = "invented";
  const grade = gradeReportEvidence(handoff, files, criteria, 1024);
  assert.equal(grade.passed, false);
  assert.ok(grade.missing.includes("assertion"));
});

test("orphaned, forward and mismatched excerpt references cannot pass", () => {
  for (const reference of [
    { file: "src/a.mjs", line: 1, excerptRef: "/reviewEvidence/paths/9/source" },
    { file: "src/a.mjs", line: 1, excerptRef: "/reviewEvidence/paths/0/contract" },
    { file: "test/a.mjs", line: 1, excerptRef: "/reviewEvidence/paths/0/source" },
    { file: "src/a.mjs", line: 2, excerptRef: "/reviewEvidence/paths/0/source" },
    { file: "src/a.mjs", line: 1, deletionLines: [1], excerptRef: "/reviewEvidence/paths/0/source" },
    { file: "src/a.mjs", line: 1, anchorLines: [2], excerptRef: "/reviewEvidence/paths/0/source" },
  ]) {
    const { files, criteria, handoff } = example();
    handoff.reviewEvidence.paths[0].via = [reference];
    // The forward case must appear before its target.
    if (reference.excerptRef.endsWith("/contract")) handoff.reviewEvidence.paths[0].source = reference;
    const grade = gradeReportEvidence(handoff, files, criteria, 1024);
    assert.equal(grade.passed, false);
    assert.ok(grade.integrityErrors.some(error => error.startsWith("invalid-excerpt-reference:")));
  }
});

test("aggregate digests verify the same full files and cannot hide stale or forged excerpts", () => {
  const compact = () => {
    const exampleValue = example();
    const { handoff } = exampleValue;
    const pair = handoff.reviewEvidence.paths[0];
    const entries = [pair.source, pair.contract].map(item => [item.file, item.sourceHash]);
    handoff.reviewEvidence.sourceDigest = { algorithm: "sha256", fileCount: 2,
      value: createHash("sha256").update(JSON.stringify(entries)).digest("hex") };
    delete pair.source.sourceHash;
    delete pair.contract.sourceHash;
    return exampleValue;
  };
  const original = compact();
  assert.equal(gradeReportEvidence(original.handoff, original.files, original.criteria, 1024).passed, true);
  for (const mutate of [
    ({ files }) => { files["src/a.mjs"] += "// later edit outside the excerpt\n"; },
    ({ handoff }) => { handoff.reviewEvidence.sourceDigest.value = "wrong"; },
    ({ handoff }) => { handoff.reviewEvidence.sourceDigest.fileCount = 1; },
    ({ handoff }) => { handoff.reviewEvidence.sourceDigest.algorithm = "md5"; },
    ({ handoff }) => { delete handoff.reviewEvidence.sourceDigest; },
    ({ handoff }) => { handoff.reviewEvidence.paths[0].source.lines[0].text = "invented"; },
  ]) {
    const value = compact();
    mutate(value);
    const grade = gradeReportEvidence(value.handoff, value.files, value.criteria, 1024);
    assert.equal(grade.passed, false);
    assert.ok(grade.integrityErrors.length > 0);
  }
});
