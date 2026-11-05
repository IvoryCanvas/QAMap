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
const roots = [];
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });

async function briefFixture(base, head, args = []) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-source-reference-"));
  roots.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com" };
  const git = (...values) => exec("git", values, { cwd: root, env });
  const write = async files => {
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), text);
    }
  };
  await git("init", "-q", "-b", "main");
  await write(base);
  await git("add", ".");
  await git("commit", "-qm", "fixture baseline");
  await git("switch", "-qc", "fixture/change");
  await write(head);
  await git("add", ".");
  await git("commit", "-qm", "fix: change the public contract");
  const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "brief", root, "--base", "main",
    "--output", path.join(directory, "reports"), ...args], { cwd: root, env });
  assert.equal(stderr, "");
  return stdout;
}

const baseClass = "export class Envelope {\n  read(value: string) { return value; }\n}\n";
const headClass = "export class Envelope {\n  read(value: string) { return value.trim(); }\n}\n";
const packageJson = JSON.stringify({ name: "reference-fixture", type: "module", scripts: { test: "node --test" } });
const section = (output, symbol, name) => output.split(`  ${symbol}: ${name}`)[1]?.split(/\n  \S|\n==|\n###/)[0] ?? "";

test("brief keeps class type positions as non-call source references beside real constructors", async () => {
  const consumer = [
    "import { Envelope } from './envelope.js';",
    "import type { Envelope as StoredEnvelope } from './envelope.js';",
    "export const storage = new Set<Envelope>();",
    "export function typed(value: Envelope): StoredEnvelope { return value; }",
    "export function construct() { return new Envelope(); }",
    "export function mixed(): Envelope { const value: Envelope = new Envelope(); return value; }",
    "export const savedConstructor = Envelope;",
    "export function wrapped() { return new (Envelope)(); }",
    "export function asserted() { return new (Envelope as typeof Envelope)(); }",
    "",
  ].join("\n");
  const output = await briefFixture({ "package.json": packageJson, "src/envelope.ts": baseClass, "src/consumer.ts": consumer,
    "test/consumer.test.ts": "import { typed } from '../src/consumer.js';\ntest('retains a typed value', () => { expect(typed({})).toBeDefined(); });\n" },
    { "src/envelope.ts": headClass });
  assert.match(output, /Envelope: source references \(invocation not established\)/);
  const callers = section(output, "Envelope", "callers");
  const references = section(output, "Envelope", "source references");
  assert.match(callers, /src\/consumer\.ts:5 in construct\|/);
  assert.match(callers, /src\/consumer\.ts:6 in mixed\|/);
  assert.match(callers, /src\/consumer\.ts:8 in wrapped\|/);
  assert.match(callers, /src\/consumer\.ts:9 in asserted\|/);
  assert.doesNotMatch(callers, /in typed|in storage|in savedConstructor/);
  assert.match(references, /src\/consumer\.ts:3/);
  assert.match(references, /src\/consumer\.ts:4/);
  assert.match(references, /src\/consumer\.ts:6/);
  assert.match(references, /src\/consumer\.ts:7/);
  assert.doesNotMatch(output, /retains a typed value/, "a type-only owner does not establish a runtime caller-test hop");
  assert.match(output, /No collected test references: Envelope/);
});

test("brief preserves callback values without promoting their owners to direct callers", async () => {
  const output = await briefFixture({ "package.json": packageJson,
    "src/adjust.mjs": "export function adjust(value) { return value + 1; }\n",
    "src/consumer.mjs": "import { adjust } from './adjust.mjs';\nexport function queue(values) { return values.map(adjust); }\nexport function direct(value) { return adjust(value); }\nexport const savedCallback = adjust;\nexport function wrapped(value) { return (adjust)(value); }\n",
    "test/consumer.test.mjs": "import { queue } from '../src/consumer.mjs';\ntest('queues callbacks', () => { expect(queue([1])).toEqual([2]); });\n",
  }, { "src/adjust.mjs": "export function adjust(value) { return value + 2; }\n" });
  const callers = section(output, "adjust", "callers");
  const references = section(output, "adjust", "source references");
  assert.match(callers, /src\/consumer\.mjs:3 in direct\|/);
  assert.match(callers, /src\/consumer\.mjs:5 in wrapped\|/);
  assert.doesNotMatch(callers, /in queue|in savedCallback/);
  assert.match(references, /src\/consumer\.mjs:2/);
  assert.match(references, /src\/consumer\.mjs:4/);
  assert.doesNotMatch(output, /queues callbacks/, "a callback value alone does not prove the owner invokes it");
});

test("brief keeps unrelated imported and shadowed constructors outside all confirmed reference groups", async () => {
  const output = await briefFixture({ "package.json": packageJson, "src/envelope.ts": baseClass,
    "src/unrelated.ts": "export class Envelope {}\n",
    "src/other-consumer.ts": "import { Envelope } from './unrelated.js';\nexport function other() { return new Envelope(); }\n",
    "src/shadow.ts": "import { Envelope } from './envelope.js';\nexport function shadow(Envelope: any) { return new Envelope(); }\n",
    "src/consumer.ts": "import { Envelope } from './envelope.js';\nexport function construct() { return new Envelope(); }\n",
  }, { "src/envelope.ts": headClass });
  assert.match(section(output, "Envelope", "callers"), /src\/consumer\.ts:2 in construct/);
  assert.doesNotMatch(output, /src\/other-consumer\.ts|src\/shadow\.ts/);
});

test("brief treats HTML title mentions as source references rather than constructor callers", async () => {
  const output = await briefFixture({ "package.json": packageJson, "src/envelope.ts": baseClass,
    "src/consumer.ts": "import { Envelope } from './envelope.js';\nexport function construct() { return new Envelope(); }\n",
    "examples/index.html": "<!doctype html>\n<title>Envelope example</title>\n",
  }, { "src/envelope.ts": headClass });
  assert.match(section(output, "Envelope", "callers"), /src\/consumer\.ts:2 in construct/);
  assert.doesNotMatch(section(output, "Envelope", "callers"), /examples\/index\.html/);
  assert.match(section(output, "Envelope", "source references"), /examples\/index\.html:2/);
});

test("non-call reference overflow keeps every collected coordinate within the brief budget", async () => {
  const uses = Array.from({ length: 22 }, (_, index) => `export const stored${index} = Envelope;`);
  const output = await briefFixture({ "package.json": packageJson, "src/envelope.ts": baseClass,
    "src/values.ts": "import { Envelope } from './envelope.js';\n" + uses.join("\n") + "\n",
  }, { "src/envelope.ts": headClass }, ["--max-bytes", "4000"]);
  assert.match(output, /Envelope: source references \(invocation not established\)/);
  assert.doesNotMatch(output, /Envelope: callers/);
  for (let line = 2; line <= 23; line++) assert.match(output, new RegExp(`src/values\\.ts:${line}(?![0-9])`));
  assert.ok(Buffer.byteLength(output) <= 4000);
});

test("type queries and stored function values do not acquire caller throw-handling claims", async () => {
  const output = await briefFixture({ "package.json": packageJson,
    "src/parse.ts": "export function parseValue(value: string) { return value; }\n",
    "src/consumer.ts": "import { parseValue } from './parse.js';\nexport type Parser = typeof parseValue;\nexport const saved = parseValue;\nexport function invoke(value: string) { return parseValue(value); }\n",
  }, { "src/parse.ts": "export function parseValue(value: string) {\n  if (!value) throw new Error('missing value');\n  return value;\n}\n" });
  const callers = section(output, "parseValue", "callers");
  const references = section(output, "parseValue", "source references");
  assert.match(output, /parseValue: callers \(now throws Error/);
  assert.match(callers, /src\/consumer\.ts:4 in invoke/);
  assert.doesNotMatch(callers, /src\/consumer\.ts:[23](?![0-9])/);
  assert.match(references, /src\/consumer\.ts:2/);
  assert.match(references, /src\/consumer\.ts:3/);
  assert.doesNotMatch(references, /\[inside try\]|\[\.catch|\[err checked\]/);
});

test("member invocations on a function value remain references while direct aliases and namespace callees remain callers", async () => {
  const source = "export function parseValue(value: string) { return value; }\nexport function localBind() { return parseValue.bind(null); }\nexport function localDirect(value: string) { return parseValue(value); }\n";
  const output = await briefFixture({ "package.json": packageJson, "src/parse.ts": source,
    "src/consumer.ts": [
      "import { parseValue as readValue } from './parse.js';",
      "import * as api from './parse.js';",
      "export function bindImported() { return readValue.bind(null); }",
      "export function callImported() { return readValue.call(null, 'x'); }",
      "export function applyImported() { return readValue.apply(null, ['x']); }",
      "export function directAlias() { return readValue('x'); }",
      "export function directNamespace() { return api.parseValue('x'); }",
      "export const storedName = readValue.name;",
      "",
    ].join("\n"),
  }, { "src/parse.ts": source.replace("return value;", "return value.trim();") });
  const callers = section(output, "parseValue", "callers");
  const references = section(output, "parseValue", "source references");
  assert.match(callers, /src\/parse\.ts:3 in localDirect/);
  assert.match(callers, /src\/consumer\.ts:6 in directAlias/);
  assert.match(callers, /src\/consumer\.ts:7 in directNamespace/);
  assert.doesNotMatch(callers, /in localBind|in bindImported|in callImported|in applyImported|in storedName/);
  assert.match(references, /src\/parse\.ts:2 in localBind/);
  for (const line of [3, 4, 5, 8]) assert.match(references, new RegExp(`src/consumer\\.ts:${line}(?![0-9])`));
});
