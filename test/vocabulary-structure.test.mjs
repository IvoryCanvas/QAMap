import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeChangeIntents } from "../dist/change-intent.js";
import { classifyChangedSourceRoles, classifyChangeSourceRole } from "../dist/source-role.js";

async function analyze(t, source, { file = "src/features/operation.ts", changedLines, anchor = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-vocabulary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = [source, ...(anchor ? [
    file.endsWith(".go") ? "func completeOperation() {" : "function completeOperation() {",
    "  onComplete();",
    "  persistResult();",
    "  showResult();",
    "}",
  ] : [])].join("\n");
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
  const lines = content.split("\n").map((text, index) => ({ line: index + 1, text }))
    .filter((line) => !changedLines || changedLines.includes(line.line));
  const result = await analyzeChangeIntents(root, {
    base: "HEAD", head: "HEAD", includeWorkingTree: true,
    changedFiles: [{ path: file, status: "M" }],
    addedDiffText: { [file]: lines.map((line) => line.text).join("\n") },
    addedDiffEvidence: { [file]: [{ file, hunkHeader: "@@ -0,0 +1,1 @@", lines, removedLines: [] }] },
  });
  if (anchor && !changedLines) assert.ok(result.intents.length > 0, "the changed product control must remain detectable");
  return result;
}

function symbols(result) {
  return result.intents.flatMap((intent) => intent.lifecycle.flatMap((stage) => stage.evidence.map((item) => item.symbol)));
}

test("unparseable nested input does not crash role or vocabulary analysis", async (t) => {
  const source = `export const value = ${"(".repeat(2000)}1${")".repeat(2000)};`;
  assert.equal(classifyChangeSourceRole("src/value.ts", source).role, "product");
  const result = await analyze(t, source, { anchor: false });
  assert.ok(Array.isArray(result.intents));
});

for (const [name, source] of [
  ["namespace chain", "import * as crypto from 'node:crypto';\ncrypto.createHash('sha256').update(value).digest('hex');"],
  ["named factory alias", "import { createHash as makeDigest } from 'crypto';\nconst digest = makeDigest('sha256');\ndigest.update(value);"],
  ["CommonJS factory", "const { createHash } = require('node:crypto');\nconst digest = createHash('sha256');\ndigest.update(value);"],
  ["multiline chain", "import crypto from 'node:crypto';\ncrypto.createHash('sha256')\n  .update(value)\n  .digest('hex');"],
]) {
  test(`hash ${name} does not promote update to a product transition`, async (t) => {
    const result = await analyze(t, source);
    assert.equal(symbols(result).some((symbol) => /update/i.test(symbol ?? "")), false);
    assert.ok(symbols(result).includes("persistResult"));
  });
}

test("unchanged import and factory context can suppress a changed hash call", async (t) => {
  const result = await analyze(t, [
    "import { createHash } from 'node:crypto';",
    "const digest = createHash('sha256');",
    "digest.update(value);",
  ].join("\n"), { changedLines: [3, 5, 6, 7] });
  assert.ok(result.intents.length > 0);
  assert.equal(symbols(result).includes("digest.update"), false);
});

test("standard-library file writes and network requests retain side-effect evidence", async (t) => {
  const result = await analyze(t, [
    "import { writeFile } from 'node:fs/promises';",
    "import http from 'node:http';",
    "writeFile(destination, content);",
    "http.request(endpoint);",
  ].join("\n"));
  assert.ok(symbols(result).includes("writeFile"));
  assert.ok(symbols(result).includes("http.request"));
});

for (const [name, source, expected] of [
  ["product receiver", "repository.update(value);", "repository.update"],
  ["product chain", "repository.item(id).update(value);", "repository.item().update"],
  ["local function", "function update(value) { return value; }\nupdate(value);", "update"],
  ["shadowed import", "import crypto from 'node:crypto';\nfunction apply(crypto) { crypto.update(value); }", "crypto.update"],
  ["shadowed factory result", "import { createHash } from 'node:crypto';\nconst digest = createHash('sha256');\nfunction apply(digest) { digest.update(value); }", "digest.update"],
]) {
  test(`same-token ${name} keeps its changed product transition`, async (t) => {
    const result = await analyze(t, source);
    assert.ok(symbols(result).includes(expected), JSON.stringify(symbols(result)));
  });
}

test("imports, declarations, types, comments and strings are not executable calls", async (t) => {
  const result = await analyze(t, [
    "import { update, onMessage, copy } from './adapter.js';",
    "export { onResponse } from './adapter.js';",
    "interface Adapter { update(value: string): void; copy(): void }",
    "class State { public update(value: string) {} }",
    "const example = 'update(value); onMessage(); copy(value)';",
    "// update(value); onMessage(); copy(value)",
    "/* update(value); onMessage(); copy(value) */",
    "const pattern = /update(value)|copy(value)/;",
  ].join("\n"));
  assert.equal(symbols(result).some((symbol) => /update|onMessage|onResponse|copy/.test(symbol ?? "")), false);
});

for (const [name, source] of [
  ["standard import", "package operation\nimport \"io\"\nfunc run() { io.Copy(dst, src) }"],
  ["aliased grouped import", "package operation\nimport (\n stream \"io\"\n)\nfunc run() { stream.Copy(dst, src) }"],
]) {
  test(`Go ${name} does not imply import or clipboard behavior`, async (t) => {
    const result = await analyze(t, source, { file: "src/operation.go" });
    assert.equal(symbols(result).some((symbol) => /import|copy/i.test(symbol ?? "")), false, JSON.stringify(symbols(result)));
    assert.equal(result.intents.flatMap((intent) => intent.scenarios).some((scenario) => /clipboard|sharing capability/i.test(scenario.title)), false);
  });
}

test("a Go product Copy call retains side-effect evidence", async (t) => {
  const result = await analyze(t, "package operation\nimport records \"example.test/product/records\"\nfunc run() { records.Copy(dst, src) }", { file: "src/operation.go" });
  assert.ok(symbols(result).includes("records.Copy"));
});

test("an unqualified Go module is not assumed to be a standard library", async (t) => {
  const result = await analyze(t, "package operation\nimport records \"records\"\nfunc run() { records.Copy(dst, src) }", { file: "src/operation.go" });
  assert.ok(symbols(result).includes("records.Copy"));
});

test("JavaScript dynamic import retains a code-splitting contract", async (t) => {
  const result = await analyze(t, "const panel = import('./panel.js');");
  assert.ok(result.intents.flatMap((intent) => intent.evidence).some((item) => item.symbol === "performance:code-splitting:import"));
});

test("JavaScript query, public, location and auth text does not imply routing or guards", async (t) => {
  const result = await analyze(t, [
    "import { searchParams, publicRoute, authenticated } from './adapter.js';",
    "const query = 'params.get(\"mode\")';",
    "const publicLabel = 'publicRoute';",
    "const location = 'window.location.href';",
    "const auth = 'authenticated';",
    "const sample = 'router.push(\"/example\")';",
    "const example = \"params.get('mode')\"; values.get('entry');",
    "class State { protected value = 1; public query = ''; }",
    "// publicRoute; window.location.href; authenticated; searchParams.get('mode')",
  ].join("\n"));
  const evidence = result.intents.flatMap((intent) => intent.evidence);
  assert.equal(evidence.some((item) => /routing evidence|query parameter|access boundary|guard or validation evidence/i.test(item.value)), false);
  assert.equal(symbols(result).some((symbol) => /navigation|router/.test(symbol ?? "")), false);
});

test("changed query operations, public routes and auth guards retain evidence", async (t) => {
  const result = await analyze(t, [
    "const params = new URLSearchParams(window.location.search);",
    "const mode = params.get('mode');",
    "params.set('mode', mode);",
    "if (isAuthenticated) router.push(publicRoute);",
    "window.location.assign('/public');",
  ].join("\n"));
  const evidence = result.intents.flatMap((intent) => intent.evidence);
  assert.ok(evidence.some((item) => /reads query parameter "mode"/.test(item.value)));
  assert.ok(evidence.some((item) => /writes query parameter "mode"/.test(item.value)));
  assert.ok(evidence.some((item) => /public access/.test(item.value)));
  assert.ok(evidence.some((item) => /guard or validation evidence/.test(item.value)));
  assert.ok(symbols(result).includes("navigation:/public"));
});

test("unchanged neighboring product calls cannot seed a flow for a hash-only diff", async (t) => {
  const result = await analyze(t, [
    "import crypto from 'node:crypto';",
    "crypto.createHash('sha256').update(value);",
    "function openProduct() { onComplete(); persistResult(); showResult(); }",
  ].join("\n"), { changedLines: [2], anchor: false });
  assert.deepEqual(result.intents, []);
});

test("source-role import propagation ignores quoted and commented import examples", () => {
  const roles = classifyChangedSourceRoles({
    "src/rules/engine.ts": "const evidencePattern = /request/; export function analyzeEvidence(source) { return evidencePattern.test(source); }",
    "src/quoted.ts": 'const example = "import { run } from \'./rules/engine.js\'";',
    "src/comment.ts": "// export { run } from './rules/engine.js';",
    "src/linked.ts": "export { run } from './rules/engine.js';",
  });
  assert.equal(roles["src/quoted.ts"].role, "product");
  assert.equal(roles["src/comment.ts"].role, "product");
  assert.equal(roles["src/linked.ts"].role, "analysis-rule");
});

test("CLI vocabulary needs executable or imported source evidence", () => {
  for (const text of ["const example = 'process.argv; parseArgs(); commander';", "// process.argv; parseArgs(); yargs", "const pattern = /commander|meow|cac/;"]) {
    assert.equal(classifyChangeSourceRole("src/features/operation.ts", text).role, "product");
  }
  assert.equal(classifyChangeSourceRole("src/entry.ts", "const args = process.argv;").role, "command");
  assert.equal(classifyChangeSourceRole("src/entry.ts", "import args from 'yargs/helpers';").role, "command");
});
