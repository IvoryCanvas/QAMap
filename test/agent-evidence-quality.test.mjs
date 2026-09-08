import assert from "node:assert/strict";
import test from "node:test";
import { evaluateEvidenceAnswer } from "../scripts/agent-bench/evidence-quality.mjs";

const expected = {
  evidence: [{ file: "src/view.tsx", line: 2 }, { file: "test/view.test.tsx", line: 4 }],
  contracts: { emptyDisabled: true, filledDisabled: false },
  uncertainties: [], execution: "not-run",
};

test("quality requires exact located evidence, complete contracts and honest execution", () => {
  const result = evaluateEvidenceAnswer(structuredClone(expected), expected);
  assert.equal(result.passed, true);
  assert.equal(result.evidencePrecision, 1);
  assert.equal(result.evidenceRecall, 1);
  assert.equal(result.contractCompleteness, 1);
  for (const mutate of [
    (value) => value.evidence.pop(),
    (value) => value.evidence.push({ file: "docs/readme.md", line: 1 }),
    (value) => value.evidence[0].line++,
    (value) => value.evidence.push(value.evidence[0]),
    (value) => delete value.contracts.filledDisabled,
    (value) => value.contracts.emptyDisabled = false,
    (value) => value.contracts.unsupported = true,
    (value) => value.uncertainties.push("invented"),
    (value) => value.execution = "passed",
    (value) => value.extra = "unsupported",
  ]) {
    const answer = structuredClone(expected);
    mutate(answer);
    assert.equal(evaluateEvidenceAnswer(answer, expected).passed, false);
  }
});

test("partial evidence is quantified without accepting malformed answers", () => {
  const answer = structuredClone(expected);
  answer.evidence.pop();
  answer.contracts.emptyDisabled = false;
  const result = evaluateEvidenceAnswer(answer, expected);
  assert.equal(result.evidencePrecision, 1);
  assert.equal(result.evidenceRecall, 0.5);
  assert.equal(result.contractCompleteness, 0.5);
  for (const value of [null, [], {}, "passed", { ...answer, evidence: [null] }]) {
    assert.equal(evaluateEvidenceAnswer(value, expected).passed, false);
  }
  const uncertain = { ...expected, uncertainties: ["runtime-module"] };
  assert.equal(evaluateEvidenceAnswer(expected, uncertain).passed, false);
  assert.equal(evaluateEvidenceAnswer(uncertain, uncertain).passed, true);
});
