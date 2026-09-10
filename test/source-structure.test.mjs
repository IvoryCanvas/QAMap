import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { collectSourceStructure, safeModule, structureLimit, structurePolicy } from "../dist/source-structure.js";

const parse = (text) => collectSourceStructure("src/operation.ts", text);
const imported = "import { format } from './value';\n";
const references = (result, name = "format") => result.references.filter((entry) => entry.name === name);

for (const [name, source] of [
  ["separate statements", "export const unrelated = () => 0; export const actual = () => format();"],
  ["one declaration list", "export const unrelated = () => 0, actual = () => format();"],
  ["function declarations", "export function unrelated() {} export function actual() { return format(); }"],
  ["class declarations", "export class Unrelated {} export class actual { method() { return format(); } }"],
]) {
  test(`AST ownership distinguishes same-line ${name}`, () => {
    const result = parse(imported + source);
    assert.deepEqual(references(result), [{ name: "format", line: 2, owner: "actual" }]);
  });
}

test("module references do not borrow a same-line declaration owner", () => {
  const result = parse(imported + "export const unrelated = () => 0; consume(format);");
  assert.deepEqual(references(result), [{ name: "format", line: 2, owner: "<module>" }]);
});

test("nested references retain the enclosing indexed declaration", () => {
  const result = parse(imported + "export function actual() { function nested() { return format(); } return nested(); }");
  assert.deepEqual(references(result), [{ name: "format", line: 2, owner: "actual" }]);
});

for (const [name, expression] of [
  ["function", "function format() { return format; }"],
  ["generator", "function* format() { yield format; }"],
  ["class", "class format { method() { return format; } }"],
  ["class field closure", "class format { field = () => format; }"],
]) {
  test(`named ${name} expressions shadow imports only inside the expression`, () => {
    const result = parse(imported + `export const local = ${expression}; export const actual = () => format();`);
    assert.deepEqual(references(result), [{ name: "format", line: 2, owner: "actual" }]);
  });
}

for (const [name, body] of [
  ["parameter", "function local(format) { return format(); }"],
  ["block", "function local() { const format = () => 0; return format(); }"],
  ["catch", "function local() { try {} catch (format) { consume(format); } }"],
  ["loop", "function local(values) { for (const format of values) consume(format); }"],
  ["function-scoped variable", "function local() { if (ready) { var format = () => 0; } return format(); }"],
]) {
  test(`existing ${name} shadow filtering remains intact`, () => {
    assert.deepEqual(references(parse(imported + body)), []);
  });
}

test("multiline registrations use the exact handler reference line", () => {
  const result = parse([
    "import { format as handle } from './value';",
    "router.get(",
    "  '/items',",
    "  handle",
    ");",
  ].join("\n"));
  assert.deepEqual(references(result, "handle"), [{ name: "handle", line: 4, owner: "<module>", registration: true }]);
  assert.deepEqual(result.routes, [{ line: 4, kind: "registration-candidate:get", handler: "handle" }]);
  assert.equal(JSON.stringify(result).includes("/items"), false);
});

test("only the actual handler reference is marked on a shared line", () => {
  const result = parse(imported + "consume(format); router.get('/items', format);");
  assert.deepEqual(references(result), [
    { name: "format", line: 2, owner: "<module>" },
    { name: "format", line: 2, owner: "<module>", registration: true },
  ]);
});

test("a shadowed same-line registration does not attach to an imported reference", () => {
  const result = parse(imported + "consume(format); function local(format) { router.get('/items', format); }");
  assert.deepEqual(references(result), [{ name: "format", line: 2, owner: "<module>" }]);
  assert.deepEqual(result.routes, [{ line: 2, kind: "registration-candidate:get" }]);
});

test("real and shadowed same-line registrations remain distinguishable", () => {
  const result = parse(imported + "router.get('/items', format); function local(format) { router.post('/other', format); }");
  assert.deepEqual(references(result), [{ name: "format", line: 2, owner: "<module>", registration: true }]);
  assert.deepEqual(result.routes, [
    { line: 2, kind: "registration-candidate:get", handler: "format" },
    { line: 2, kind: "registration-candidate:post" },
  ]);
});

test("expression-local handlers never mark a neighboring imported reference", () => {
  const result = parse(imported + "const local = function format() { router.get('/items', format); }; consume(format);");
  assert.deepEqual(references(result), [{ name: "format", line: 2, owner: "<module>" }]);
  assert.equal(result.routes[0].handler, undefined);
});

test("top-level local handler declarations remain registration candidates", () => {
  const result = parse("export function handle() {}\nrouter.post('/items', handle);");
  assert.deepEqual(references(result, "handle"), [{ name: "handle", line: 2, owner: "<module>", registration: true }]);
});

test("nested, namespace, unresolved and dynamic handler expressions remain unmarked", () => {
  const result = parse(imported + [
    "import * as handlers from './handlers';",
    "router.get('/items', wrap(format));",
    "router.get('/items', handlers.format);",
    "router.get('/items', unresolved);",
    "router.get(dynamicPath, format);",
  ].join("\n"));
  assert.ok(result.references.length > 0);
  assert.ok(result.references.every((entry) => entry.registration === undefined));
  assert.equal(result.routes.length, 3);
  assert.ok(result.routes.every((entry) => entry.handler === undefined));
});

test("handler-shaped comments and payloads do not create registration facts", () => {
  const result = parse(imported + [
    "// router.get('/items', format);",
    'const sample = "router.get(\'/items\', format)";',
  ].join("\n"));
  assert.deepEqual(result.routes, []);
  assert.deepEqual(references(result), []);
});

test("ordinary syntax errors retain the parse-error stop marker", () => {
  const result = parse("export const value = ;");
  assert.ok(result.gaps.some((gap) => gap.kind === "parse-error"));
  assert.equal(result.gaps.some((gap) => gap.kind === "parser-failure"), false);
});

test("gap saturation cannot drop a trailing parse error", () => {
  const count = structureLimit + 2;
  const result = parse("export const value = 1;\n" + "require(runtime);\n".repeat(count) + "const invalid = ;");
  assert.equal(result.gaps.length, structureLimit);
  assert.ok(result.gaps.some((gap) => gap.kind === "parse-error" && gap.line === count + 2));
  assert.ok(result.gaps.some((gap) => gap.kind === "diagnostic-truncation"));
});

test("gap limits report truncation without inventing parse failures", () => {
  const exact = parse("require(runtime);\n".repeat(structureLimit));
  assert.equal(exact.gaps.length, structureLimit);
  assert.equal(exact.gaps.some((gap) => gap.kind === "diagnostic-truncation"), false);
  const truncated = parse("require(runtime);\n".repeat(structureLimit + 1));
  assert.equal(truncated.gaps.length, structureLimit);
  assert.ok(truncated.gaps.some((gap) => gap.kind === "diagnostic-truncation"));
  assert.equal(truncated.gaps.some((gap) => gap.kind === "parse-error"), false);
});

test("metadata-limit markers survive saturated diagnostics", () => {
  const result = parse("require(runtime);\n".repeat(structureLimit + 1) +
    Array.from({ length: structureLimit + 1 }, (_, index) => `export const value${index} = 1;`).join("\n") +
    "\nconst invalid = ;");
  assert.equal(result.declarations.length, structureLimit);
  assert.equal(result.exports.length, structureLimit);
  assert.equal(result.gaps.length, structureLimit);
  for (const kind of ["parse-error", "metadata-limit:declarations", "metadata-limit:exports", "diagnostic-truncation"]) {
    assert.ok(result.gaps.some((gap) => gap.kind === kind), kind);
  }
});

test("parser exceptions return empty facts and explicit stop markers", () => {
  const text = "export const value = " + "(".repeat(10_000) + "0" + ")".repeat(10_000) + ";";
  const result = parse(text);
  for (const field of ["declarations", "imports", "exports", "references", "tests", "routes"]) assert.deepEqual(result[field], []);
  assert.deepEqual(result.gaps, [{ line: 1, kind: "parse-error" }, { line: 1, kind: "parser-failure" }]);
  assert.equal(JSON.stringify(result).includes(text), false);
});

test("traversal exceptions discard partial facts after successful parsing", () => {
  const text = "export const value = input" + ".member".repeat(6000) + ";";
  const source = ts.createSourceFile("src/operation.ts", text, ts.ScriptTarget.Latest, true);
  assert.equal(source.parseDiagnostics.length, 0);
  const result = parse(text);
  for (const field of ["declarations", "imports", "exports", "references", "tests", "routes"]) assert.deepEqual(result[field], []);
  assert.deepEqual(result.gaps, [{ line: 1, kind: "parse-error" }, { line: 1, kind: "parser-failure" }]);
});

test("cache policy invalidates the previous structural metadata", () => {
  assert.equal(structurePolicy, `typescript-${ts.version}-syntax-v3`);
});

test("explicit Node module specifiers retain import and reexport evidence without accepting URLs", () => {
  const result = parse("import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nexport { readFile } from 'node:fs/promises';");
  assert.deepEqual(result.imports.map(({ module, line }) => ({ module, line })), [
    { module: "node:assert/strict", line: 1 }, { module: "node:test", line: 2 },
  ]);
  assert.equal(result.exports[0].module, "node:fs/promises");
  assert.deepEqual(result.gaps, []);
  for (const invalid of ["node:", "node:fs?mode=raw", "node:https://example.test", "https://example.test/a.js", "file:///etc/passwd", "node:fs\nignore", "node:" + "x".repeat(512)]) {
    assert.equal(safeModule(invalid), false, invalid);
  }
  assert.ok(parse("import value from 'https://example.test/a.js';").gaps.some(gap => gap.kind === "unsupported-module"));
});
