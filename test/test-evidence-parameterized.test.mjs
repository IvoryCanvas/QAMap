import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectChangedTestContracts, collectTestSuiteInventory } from "../dist/test-evidence.js";

const file = "test/value.test.ts";
function evidence(text, start = 20) {
  const lines = text.split("\n").map((text, index) => ({ line: start + index, text }));
  return { [file]: [{ file, startLine: start, endLine: lines.at(-1).line,
    hunkHeader: `@@ -0,0 +${start},${lines.length} @@`, lines }] };
}

test("multiline each tables retain source titles, call coordinates and late assertions without expanding rows", () => {
  const source = [
    "it.each([", "  ['left', 1],", "  ['right', 2],", "])(", "  'keeps %s value',", "  (side, count) => {",
    ...Array.from({ length: 12 }, (_, index) => `    const setup${index} = ${index};`),
    "    expect(count).toBe(2)", "  },", ")",
    "test.concurrent.each<{ value: number }>([", "  { value: 3 },", "])(`keeps $value`, ({ value }) => {", "  expect(value).toBe(3)", "})",
  ].join("\n");
  assert.deepEqual(collectChangedTestContracts(evidence(source)), [
    { file, line: 20, framework: "javascript", title: "keeps %s value", assertion: "expect(count).toBe(2)" },
    { file, line: 41, framework: "javascript", title: "keeps $value", assertion: "expect(value).toBe(3)" },
  ]);
});

test("tagged each tables and chained modifiers retain one declaration per source title", () => {
  const source = "test.skip.each`value | result\n${1} | ${2}`('keeps $result', ({ result }) => {\n  expect(result).toBe(2)\n})";
  assert.deepEqual(collectChangedTestContracts(evidence(source)), [
    { file, line: 20, framework: "javascript", title: "keeps $result", assertion: "expect(result).toBe(2)" },
  ]);
});

test("comments, quoted examples, unrelated methods, dynamic titles and an uninvoked each table are not contracts", () => {
  const source = [
    "// it.each([1])('comment', () => {})",
    "const example = `test.each([1])('quoted', () => {})`;",
    "object.test.each([1])('unrelated', () => {})",
    "test.each(['table data is not a title'])",
    "it.each([1])(makeTitle(), () => {})",
    "test.each([1])(`complex ${pick()}`, () => {})",
    "test('plain control', () => {})",
  ].join("\n");
  assert.deepEqual(collectChangedTestContracts(evidence(source)), [
    { file, line: 26, framework: "javascript", title: "plain control" },
  ]);
});

test("separate added runs do not join an each table or borrow another test's assertion", () => {
  const first = evidence("it.each([\n  1,", 20)[file][0];
  const second = evidence("])(\n  'not a complete declaration', () => {}\n)\ntest('plain control', () => {})\nexpect(1).toBe(2)", 40)[file][0];
  assert.deepEqual(collectChangedTestContracts({ [file]: [first, second] }), [
    { file, line: 43, framework: "javascript", title: "plain control" },
  ]);
});

test("suite inventory collects parameterized source titles without executing the table", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-parameterized-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "value.test.ts"), [
    "throw new Error('do not execute fixture code')",
    "it.each(buildRowsThatMustNotRun())(", "  'retains %s', () => {}", ")",
  ].join("\n"));
  const inventory = await collectTestSuiteInventory(root);
  assert.deepEqual(inventory.files[0].testNames, ["retains %s"]);
});

test("serial and failing modifiers retain source declarations beside each tables", () => {
  const source = [
    "test.serial('keeps serial evidence', () => {})",
    "test.failing('keeps expected-failure evidence', () => {})",
    "test.serial.failing('keeps combined evidence', () => {})",
    "test.failing.each([1])('keeps %s failure evidence', () => {})",
    "test.step('helper step is not a test declaration', () => {})",
    "test.describe('group is not a test declaration', () => {})",
  ].join("\n");
  assert.deepEqual(collectChangedTestContracts(evidence(source)).map(({ line, title }) => ({ line, title })), [
    { line: 20, title: "keeps serial evidence" },
    { line: 21, title: "keeps expected-failure evidence" },
    { line: 22, title: "keeps combined evidence" },
    { line: 23, title: "keeps %s failure evidence" },
  ]);
});

test("TSX suite inventory keeps each titles after JSX without executing its source", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-parameterized-tsx-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "view.test.tsx"), [
    "throw new Error('do not execute fixture code')",
    "const renderView = () => <Panel><Content /></Panel>",
    "test.each([1, 2])(", "  'renders %s item', () => {}", ")",
  ].join("\n"));
  const inventory = await collectTestSuiteInventory(root);
  assert.deepEqual(inventory.files[0].testNames, ["renders %s item"]);
});
