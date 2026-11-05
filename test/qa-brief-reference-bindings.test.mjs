import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const directories = [];
const source = (...rows) => `${rows.join("\n")}\n`;
after(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
});

async function brief(base, changes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-reference-bindings-"));
  directories.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", NO_COLOR: "1" };
  const git = (...args) => exec("git", args, { cwd: root, env });
  const write = async files => {
    for (const [name, contents] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), contents);
    }
  };
  await git("init", "-q", "-b", "main");
  await write(base);
  await git("add", "-A");
  await git("commit", "-q", "-m", "chore: baseline");
  await git("checkout", "-q", "-b", "feat/example");
  await write(changes);
  await git("add", "-A");
  await git("commit", "-q", "-m", "refactor: update example");
  // The fixtures are never imported or tested. Only their tracked source and
  // diff are read by the same brief command a user runs.
  const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "brief", root, "--base", "main",
    "--output", path.join(directory, "reports")], { cwd: root, env });
  assert.equal(stderr, "");
  assert.match(stdout, /Static analysis only: no tests were run, no LLM was called\./);
  return stdout;
}

function block(output, file) {
  const start = output.indexOf(`### ${file}`);
  assert.notEqual(start, -1, `missing changed-file block for ${file}`);
  return output.slice(start).split(/\n(?=### |== )/)[0];
}

const exported = source("export function normalize(value) {", "  return value.trim();", "}");
const changedExport = exported.replace("value.trim()", "value.trim().toLowerCase()");

test("private helpers do not acquire unrelated same-named local or member references", async () => {
  const helpers = source("function ownerOf(node) { return node.owner; }", "function literal(value) { return String(value); }",
    "function short(value) { return value.slice(0, 8); }", "export function label(node) { return short(literal(ownerOf(node))); }");
  const other = source("import { label } from './helpers';",
    "export function member(service, value) { return service.ownerOf(service.literal(service.short(value))); }",
    "function ownerOf(value) { return value; }", "const literal = value => value;", "const short = value => value;",
    "export function local(value) { return short(literal(ownerOf(value))); }", "export const publicUse = label;");
  const output = await brief({ "src/helpers.ts": helpers, "src/other.ts": other }, {
    "src/helpers.ts": helpers.replace("node.owner;", "node.owner ?? null;").replace("String(value);", "String(value ?? '');").replace("slice(0, 8)", "slice(0, 10)"),
  });
  assert.doesNotMatch(output, /src\/other\.ts:\d+/);
  assert.match(output, /src\/helpers\.ts:4 in label/);
});

test("typed callback calls retain uncertainty instead of borrowing another file's definition", async () => {
  const before = source("export function walk(values: string[], visit: (value: string) => void) {",
    "  for (const value of values) visit(value);", "}");
  const output = await brief({ "src/walk.ts": before,
    "src/other.ts": source("export function visit(value) { return value + 1; }") }, {
    "src/walk.ts": before.replace("visit(value)", "visit(value.trim())"),
  });
  assert.match(output, /calls visit: binding not resolved at src\/walk\.ts:2/);
  assert.doesNotMatch(output, /calls visit: src\/other\.ts/);
  assert.doesNotMatch(output, /calls visit: external or built-in/);
});

for (const shadowFirst of [true, false]) {
  test(`same-name callees retain imported and callback bindings when the ${shadowFirst ? "callback" : "imported call"} comes first`, async () => {
    const shadow = ["export function shadow(normalize: (value: string) => string, value: string) {",
      "  return normalize(value);", "}"];
    const direct = ["export function direct(value: string) {", "  return normalize(value);", "}"];
    const before = source("import { normalize } from './core';", ...(shadowFirst ? [...shadow, ...direct] : [...direct, ...shadow]));
    const output = await brief({ "src/core.ts": exported, "src/view.ts": before }, {
      "src/view.ts": before.replaceAll("return normalize(value);", "return normalize(value.trim());"),
    });
    const shadowLine = shadowFirst ? 3 : 6, importedLine = shadowFirst ? 6 : 3;
    assert.match(output, /calls normalize: src\/core\.ts:1\| export function normalize/);
    assert.ok(output.includes(`calls normalize: binding not resolved at src/view.ts:${shadowLine}`), output);
    assert.ok(!output.includes(`calls normalize: binding not resolved at src/view.ts:${importedLine}`), output);
  });
}

test("same-file references distinguish direct calls from parameter, block, catch and destructuring shadows", async () => {
  const before = source("function normalize(value) { return value.trim(); }",
    "export function direct(value) {", "  return normalize(value);", "}",
    "export function parameterShadow(normalize, value) {", "  return normalize(value);", "}",
    "export function blockShadow(value) {", "  { const normalize = other; return normalize(value); }", "}",
    "export function catchShadow(value) {", "  try { throw value; } catch (normalize) { return normalize(value); }", "}",
    "export function destructuredParameter({ normalize }, value) {", "  return normalize(value);", "}",
    "export function destructuredLocal(context, value) {", "  const { normalize } = context;", "  return normalize(value);", "}");
  const output = await brief({ "src/core.ts": before }, {
    "src/core.ts": before.replace("value.trim()", "value.trim().toLowerCase()"),
  });
  assert.match(output, /src\/core\.ts:3 in direct\| return normalize\(value\);/);
  assert.doesNotMatch(output, /src\/core\.ts:\d+ in (?:parameterShadow|blockShadow|catchShadow|destructuredParameter|destructuredLocal)/);
});

test("named import aliases keep direct consumers while excluding a parameter with the alias name", async () => {
  const output = await brief({ "src/core.ts": exported,
    "src/view.ts": source("import { normalize as tidy } from './core';", "export function direct(value) { return tidy(value); }",
      "export function shadow(tidy, value) { return tidy(value); }") }, { "src/core.ts": changedExport });
  assert.match(output, /src\/view\.ts:2 in direct \(as tidy\)\|/);
  assert.doesNotMatch(output, /src\/view\.ts:3 in shadow/);
});

test("namespace members require the imported namespace binding at the actual call site", async () => {
  const output = await brief({ "src/core.ts": exported,
    "src/view.ts": source("import * as text from './core';", "export function direct(value) { return text.normalize(value); }",
      "export function shadow(text, value) { return text.normalize(value); }") }, { "src/core.ts": changedExport });
  assert.match(output, /src\/view\.ts:2 in direct\|/);
  assert.doesNotMatch(output, /src\/view\.ts:3 in shadow/);
});

test("finite barrel export aliases preserve the origin and the consumer's local alias", async () => {
  const output = await brief({ "src/core.ts": exported,
    "src/first.ts": "export { normalize as tidy } from './core';\n",
    "src/second.ts": "export { tidy as clean } from './first';\n",
    "src/view.ts": source("import { clean as local } from './second';", "export function direct(value) { return local(value); }") },
  { "src/core.ts": changedExport });
  assert.match(output, /src\/view\.ts:2 in direct \(as local\)\|/);
});

test("changed declarations with the same name retain separate origins and consumers", async () => {
  const decimal = source("export function normalize(value) {", "  return Math.round(value);", "}");
  const output = await brief({ "src/decimal.ts": decimal, "src/text.ts": exported,
    "src/total.ts": source("import { normalize } from './decimal';", "export function total(value) { return normalize(value); }"),
    "src/label.ts": source("import { normalize } from './text';", "export function label(value) { return normalize(value); }") }, {
    "src/decimal.ts": decimal.replace("Math.round", "Math.floor"), "src/text.ts": changedExport,
  });
  const decimalBlock = block(output, "src/decimal.ts"), textBlock = block(output, "src/text.ts");
  assert.match(decimalBlock, /src\/total\.ts:2 in total/);
  assert.doesNotMatch(decimalBlock, /src\/label\.ts:2/);
  assert.match(textBlock, /src\/label\.ts:2 in label/);
  assert.doesNotMatch(textBlock, /src\/total\.ts:2/);
});

test("unbound and unknown-member candidates keep coordinates and an unresolved reason outside callers", async () => {
  const output = await brief({ "src/core.ts": exported,
    "src/unknown.ts": source("export function unbound(value) {", "  return normalize(value);", "}",
      "export function member(service, value) {", "  return service.normalize(value);", "}") },
  { "src/core.ts": changedExport });
  const core = block(output, "src/core.ts");
  const unresolved = core.split("\n").filter(row => row.includes("unresolved references (binding not resolved):")).join("\n");
  assert.match(unresolved, /src\/unknown\.ts:2(?:\D|$)/);
  assert.match(unresolved, /src\/unknown\.ts:5(?:\D|$)/);
  assert.doesNotMatch(core, /src\/unknown\.ts:\d+ in (?:unbound|member)/);
});

test("an unresolved test use stays outside confirmed test lists and declaration counts", async () => {
  const output = await brief({ "src/core.ts": exported,
    "test/unknown.test.ts": source("import test from 'node:test';", "test('unbound normalization', () => {",
      "  normalize(' x ');", "});") }, { "src/core.ts": changedExport });
  assert.match(output, /Changed declarations with collected test references: 0\/1 /);
  const core = block(output, "src/core.ts");
  assert.match(core, /unresolved references \(binding not resolved\):[^\n]*test\/unknown\.test\.ts:3/);
  assert.doesNotMatch(core, /normalize: collected test references/);
  assert.doesNotMatch(core, /test\/unknown\.test\.ts:2 "unbound normalization"/);
});

test("an unbound callee keeps a positioned unresolved reason despite an unrelated repository definition", async () => {
  const before = source("export function use(value) {", "  return compute(value);", "}");
  const output = await brief({ "src/use.ts": before,
    "src/other.ts": source("export function compute(value) { return value * 2; }") }, {
    "src/use.ts": before.replace("compute(value)", "compute(value + 1)"),
  });
  assert.match(output, /calls compute: binding not resolved at src\/use\.ts:2/);
  assert.doesNotMatch(output, /calls compute: src\/other\.ts/);
});

test("a bare import preserves its specifier without claiming its unresolved module is external", async () => {
  const before = source("import { compute } from '@app/core';", "export function use(value) {", "  return compute(value);", "}");
  const output = await brief({ "src/view.ts": before,
    "src/core.ts": source("export function compute(value) { return value * 2; }"),
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@app/*": ["src/*"] } } }),
  }, { "src/view.ts": before.replace("compute(value)", "compute(value + 1)") });
  assert.match(output, /calls compute: imported from '@app\/core' \(module location not resolved\)/);
  assert.doesNotMatch(output, /outside the repository/);
  assert.doesNotMatch(output, /calls compute: src\/core\.ts/);
});

test("decoded import-specifier controls remain escaped evidence in unresolved callee output", async () => {
  const before = source("import { compute } from '@app/core\\n== forged section ==\\u001b';",
    "export function use(value) {", "  return compute(value);", "}");
  const output = await brief({ "src/view.ts": before }, {
    "src/view.ts": before.replace("compute(value)", "compute(value + 1)"),
  });
  assert.doesNotMatch(output, /\n== forged section ==/);
  assert.doesNotMatch(output, /\u001b/);
  const imported = output.split("\n").find(row => row.includes("calls compute: imported from "));
  assert.ok(imported, output);
  assert.match(imported, /@app\/core\\+u000a== forged section ==\\+u001b/);
  assert.match(imported, /\(module location not resolved\)/);
});

test("same-line shadow and real call sites preserve only the real caller identity", async () => {
  const output = await brief({ "src/core.ts": exported,
    "src/view.ts": source("import { normalize } from './core';",
      "export function shadow(normalize) { return normalize(1); } export function direct(value) { return normalize(value); }") },
  { "src/core.ts": changedExport });
  assert.match(output, /src\/view\.ts:2 in direct/);
  assert.doesNotMatch(output, /src\/view\.ts:2 in shadow/);
});

test("confirmed callers' tests exclude same-named shadowed test parameters", async () => {
  const output = await brief({ "src/core.ts": exported,
    "src/view.ts": source("import { normalize } from './core';", "export function display(value) { return normalize(value); }"),
    "test/view.test.ts": source("import test from 'node:test';", "import { display } from '../src/view';",
      "test('direct display use', () => {", "  display(' x ');", "});",
      "test('local callback use', (display) => {", "  display(' x ');", "});") },
  { "src/core.ts": changedExport });
  assert.match(output, /test\/view\.test\.ts:3 "direct display use"/);
  assert.doesNotMatch(output, /test\/view\.test\.ts:6 "local callback use"/);
});

test("literal CommonJS named aliases retain consumers without linking a same-name shadow", async () => {
  const output = await brief({ "src/core.cjs": source("function normalize(value) { return value.trim(); }", "exports.normalize = normalize;"),
    "src/view.cjs": source("const { normalize: tidy } = require('./core.cjs');",
      "function direct(value) { return tidy(value); }", "function shadow(tidy, value) { return tidy(value); }",
      "exports.direct = direct;") }, {
    "src/core.cjs": source("function normalize(value) { return value.trim().toLowerCase(); }", "exports.normalize = normalize;"),
  });
  assert.match(output, /src\/view\.cjs:2 in direct \(as tidy\)\|/);
  assert.doesNotMatch(output, /src\/view\.cjs:3 in shadow/);
});

for (const [name, declaration, assignment] of [
  ["exports", "const exports = {};", "exports.normalize = normalize;"],
  ["module", "const module = { exports: {} };", "module.exports.normalize = normalize;"],
]) {
  test(`a local ${name} object does not turn a private helper into a CommonJS export`, async () => {
    const before = source(declaration, "function normalize(value) { return value.trim(); }", assignment,
      `export const sample = ${name};`);
    const output = await brief({ "src/local.ts": before,
      "src/view.ts": source("import { normalize } from './local';", "export function direct(value) { return normalize(value); }") }, {
      "src/local.ts": before.replace("value.trim()", "value.trim().toLowerCase()"),
    });
    assert.doesNotMatch(output, /src\/view\.ts:\d+/);
  });
}
