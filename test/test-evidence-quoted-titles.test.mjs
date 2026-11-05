import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { collectChangedTestContracts, collectTestSuiteInventory } from "../dist/test-evidence.js";

const directories = [];
after(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
});

function changedContracts(text, line = 17) {
  const file = "test/quoted.test.mjs";
  return collectChangedTestContracts({ [file]: [{ file, startLine: line, endLine: line,
    hunkHeader: `@@ -0,0 +${line} @@`, lines: [{ line, text }] }] });
}

const cases = [
  ["plain double-quoted title", 'test("plain title", () => {});', "plain title"],
  ["apostrophe inside double quotes", 'test("owner\'s value", () => {});', "owner's value"],
  ["double quote inside single quotes", 'test(\'contains "quote"\', () => {});', 'contains "quote"'],
  ["escaped matching double quotes", 'test("keeps \\"quoted\\" text", () => {});', 'keeps \\"quoted\\" text'],
  ["escaped matching apostrophe", "test('owner\\'s value', () => {});", "owner\\'s value"],
  ["escaped backslash before the closing quote", 'test("ends with \\\\", () => {});', 'ends with \\\\'],
  ["backtick title without substitution", 'test(`owner\'s "value"`, () => {});', 'owner\'s "value"'],
  ["escaped matching backticks", 'test(`keeps \\`literal\\` text`, () => {});', 'keeps \\`literal\\` text'],
];

for (const [name, text, title] of cases) {
  test(`changed contracts preserve ${name} and its source location`, () => {
    assert.deepEqual(changedContracts(text), [{ file: "test/quoted.test.mjs", line: 17, framework: "javascript", title }]);
  });
}

for (const [name, text] of [
  ["unterminated title", 'test("unterminated, () => {});'],
  ["escaped quote without a closing delimiter", 'test("ends in escaped quote\\", () => {});'],
  ["mismatched closing delimiter", 'test("mismatched\', () => {});'],
]) {
  test(`changed contracts reject a ${name}`, () => {
    assert.deepEqual(changedContracts(text), []);
  });
}

test("a template keeps source placeholders and coordinates without deriving runtime names or loop counts", () => {
  const file = "test/quoted.test.mjs";
  const title = "${kind} keeps the owner's value";
  const contracts = collectChangedTestContracts({ [file]: [{ file, startLine: 41, endLine: 43,
    hunkHeader: "@@ -0,0 +41,3 @@", lines: [
      { line: 41, text: 'for (const kind of ["alpha", "beta"]) {' },
      { line: 42, text: `  test(\`${title}\`, () => {});` },
      { line: 43, text: "}" },
    ] }] });
  assert.deepEqual(contracts, [{ file, line: 42, framework: "javascript", title }]);
  assert.ok(!contracts.some(contract => /alpha|beta/.test(contract.title)), "Source collection must not expand or evaluate template values");
});

test("the suite inventory uses the same delimiter boundaries without importing fixture code", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-quoted-titles-"));
  directories.push(root);
  const file = "quoted.test.mjs";
  const dynamicTitle = "${kind} keeps the owner's value";
  const text = [
    'throw new Error("fixture code must never execute");',
    ...cases.map(([, line]) => line),
    `test(\`${dynamicTitle}\`, () => {});`,
    'test("unterminated, () => {});',
  ].join("\n");
  await fs.writeFile(path.join(root, file), text);
  const inventory = await collectTestSuiteInventory(root);
  assert.equal(inventory.testFileCount, 1);
  assert.deepEqual(inventory.files[0].testNames, [...cases.map(([, , title]) => title), dynamicTitle]);
});

const unsupportedInterpolations = [
  ["a function call containing a quoted backtick", 'test(`case ${pick("`")} suffix`, () => {});'],
  ["a nested template", 'test(`case ${`nested`} suffix`, () => {});'],
  ["a function call", 'test(`case ${pick()} suffix`, () => {});'],
  ["a quoted expression", 'test(`case ${"quoted"} suffix`, () => {});'],
];

for (const [name, text] of unsupportedInterpolations) {
  test(`changed contracts omit ${name} instead of collecting a title fragment`, () => {
    assert.deepEqual(changedContracts(text), []);
  });
}

test("a simple property placeholder retains its source spelling and location", () => {
  const title = "case ${context.kind} keeps the owner's value";
  assert.deepEqual(changedContracts(`test(\`${title}\`, () => {});`, 29), [
    { file: "test/quoted.test.mjs", line: 29, framework: "javascript", title },
  ]);
});

test("the inventory omits complex interpolation fragments while retaining a plain control", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-complex-title-"));
  directories.push(root);
  await fs.writeFile(path.join(root, "quoted.test.mjs"), [
    'throw new Error("fixture code must never execute");',
    ...unsupportedInterpolations.map(([, text]) => text),
    'test("plain control", () => {});',
  ].join("\n"));
  const inventory = await collectTestSuiteInventory(root);
  assert.equal(inventory.testFileCount, 1);
  assert.deepEqual(inventory.files[0].testNames, ["plain control"]);
});
