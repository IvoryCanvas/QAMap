import assert from "node:assert/strict";
import test from "node:test";
import { createTestExpectationReader } from "../dist/test-expectation-evidence.js";

const source = lines => lines.join("\n") + "\n";
const base = ["import assert from 'node:assert/strict';", "import test from 'node:test';", "import { total } from './total.mjs';"];
function evidence(lines, target, symbol = "total") {
  return createTestExpectationReader("test/sample.test.mjs", source(lines))(lines.indexOf(target) + 1, symbol).map(n => lines[n - 1]);
}

test("distant expected values follow local const bindings and omit unrelated assertions", () => {
  const target = "  const observed = total(['x']);";
  const lines = [...base, "test('total', () => {", target,
    ...Array.from({ length: 20 }, (_, i) => `  const unrelated${i} = ${i};`),
    "  assert.equal(unrelated0, 0);", "  assert.equal(observed, 1);", "});"];
  assert.deepEqual(evidence(lines, target), [target, "  assert.equal(observed, 1);"]);
});

test("multiline expect assertions retain the intermediate constant transformation", () => {
  const target = "  const observed = total(['x']);";
  const lines = [...base, "test('total', () => {", target,
    "  const doubled = observed * 2;", "  expect(doubled).toEqual(", "    2", "  );", "});"];
  assert.deepEqual(evidence(lines, target), [target, "  const doubled = observed * 2;",
    "  expect(doubled).toEqual(", "    2", "  );"]);
});

test("same-spelled variables in another test or nested scope are not linked", () => {
  const target = "  const observed = total(['x']);";
  const lines = [...base, "test('one', () => {", target,
    "  { const observed = 9;", "    assert.equal(observed, 9);", "  }", "});",
    "test('two', () => {", "  const observed = 8;", "  assert.equal(observed, 8);", "});"];
  assert.deepEqual(evidence(lines, target), []);
});

test("shadowed assert and nested helper functions cannot supply the expectation", () => {
  const target = "  const observed = total(['x']);";
  const lines = [...base, "test('one', () => {", target,
    "  const assert = { equal() {} };", "  assert.equal(observed, 9);",
    "  function helper() { expect(observed).toBe(8); }", "});"];
  assert.deepEqual(evidence(lines, target), []);
});

test("import aliases preserve real Node assertions without accepting an unrelated module", () => {
  const target = "  check.equal(total(['x']), 1);";
  const lines = ["import check from 'node:assert/strict';", "import run from 'node:test';", base[2],
    "run('total', () => {", target, "});"];
  assert.deepEqual(evidence(lines, target), [target]);
  lines[0] = "import check from './fake-assert.mjs';";
  assert.deepEqual(evidence(lines, target), []);
});

test("parse errors, absent references and mutable aliases produce no invented expectations", () => {
  const target = "  let observed = total(['x']);";
  const lines = [...base, "test('one', () => {", target, "  observed = 8;", "  assert.equal(observed, 8);", "});"];
  assert.deepEqual(evidence(lines, target), []);
  assert.deepEqual(createTestExpectationReader("test/bad.ts", "function {{{")(1, "total"), []);
  assert.deepEqual(createTestExpectationReader("test/empty.mjs", source(base))(99, "total"), []);
});

test("a namespace name alone cannot borrow an unrelated member's expectation", () => {
  const target = "  const observed = values.total(['x']);";
  const lines = [base[0], base[1], "import * as values from './total.mjs';", "test('one', () => {", target,
    "  assert.equal(values.other(), 9);", "});"];
  assert.deepEqual(evidence(lines, target, "values"), []);
});
