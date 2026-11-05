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
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });

async function fixture(base, head) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-brief-budget-"));
  roots.push(directory);
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
  await git("init", "-qb", "main");
  await write(base);
  await git("add", ".");
  await git("commit", "-qm", "fixture baseline");
  await git("switch", "-qc", "fixture/change");
  await write(head);
  await git("add", ".");
  await git("commit", "-qm", "fix: bound the returned value");
  return async (maxBytes = 24000) => {
    const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "brief", root, "--base", "main",
      "--max-bytes", String(maxBytes), "--output", path.join(directory, "reports")], { cwd: root, env });
    assert.equal(stderr, "");
    assert.ok(Buffer.byteLength(stdout) <= maxBytes);
    assert.match(stdout, /Static analysis only: no tests were run, no LLM was called\./);
    return stdout;
  };
}

test("a widely referenced class keeps its small source and test diff inside the default budget", async () => {
  const base = {
    "src/envelope.ts": "export class Envelope {\n  amount(value: number) {\n    return value;\n  }\n}\n",
    "test/envelope.test.ts": "import { Envelope } from '../src/envelope';\ntest('amount has a lower bound', () => {\n  expect(new Envelope().amount(-1)).toBe(-1);\n});\n",
  };
  for (let index = 0; index < 80; index++) base[`src/consumers/${"long-neutral-directory-name/".repeat(5)}consumer-${index}.ts`] =
    "import type { Envelope } from '../../../../../../envelope';\n" +
    "export function inspect(value: Envelope): Envelope {\n  const saved: Envelope = value;\n  return saved;\n}\n";
  const run = await fixture(base, {
    "src/envelope.ts": base["src/envelope.ts"].replace("return value;", "return Math.max(0, value);"),
    "test/envelope.test.ts": base["test/envelope.test.ts"].replace("toBe(-1)", "toBe(0)"),
  });
  const output = await run();
  assert.match(output, /-3\|    return value;\n\+3\|    return Math.max\(0, value\);/);
  assert.match(output, /-3\|  expect\(new Envelope\(\).amount\(-1\)\).toBe\(-1\);/);
  assert.match(output, /\+3\|  expect\(new Envelope\(\).amount\(-1\)\).toBe\(0\);/);
  assert.match(output, /reference detail lines omitted by byte budget/);
  assert.doesNotMatch(output, /src\/envelope.ts: diff and references not shown/);
});

test("a widely called function retains its changed lines even at the minimum budget", async () => {
  const base = { "src/amount.mjs": "export function amount(value) {\n  return value;\n}\n" };
  for (let index = 0; index < 80; index++) base[`src/${"long-neutral-name-".repeat(5)}${index}.mjs`] =
    "import { amount } from './amount.mjs';\nexport function inspect(value) {\n  return amount(value);\n}\n";
  const run = await fixture(base, { "src/amount.mjs": base["src/amount.mjs"].replace("return value;", "return Math.max(0, value);") });
  const output = await run(4000);
  assert.match(output, /-2\|  return value;\n\+2\|  return Math.max\(0, value\);/);
  assert.match(output, /reference detail lines omitted by byte budget/);
});

test("small reference sets still include their assertion and caller excerpts without budget omissions", async () => {
  const base = {
    "src/amount.mjs": "export function amount(value) {\n  return value;\n}\n",
    "src/panel.mjs": "import { amount } from './amount.mjs';\nexport function inspect(value) {\n  return amount(value);\n}\n",
    "test/amount.test.mjs": "import { amount } from '../src/amount.mjs';\ntest('amount stays nonnegative', () => {\n  assert.equal(amount(-1), 0);\n});\n",
  };
  const run = await fixture(base, { "src/amount.mjs": base["src/amount.mjs"].replace("return value;", "return Math.max(0, value);") });
  const output = await run();
  assert.match(output, /test\/amount.test.mjs:2 "amount stays nonnegative"/);
  assert.match(output, /3\| assert.equal\(amount\(-1\), 0\);/);
  assert.match(output, /src\/panel.mjs:3 in inspect\| return amount\(value\);/);
  assert.doesNotMatch(output, /reference detail lines omitted by byte budget/);
});

test("reference compaction preserves an added test's final assertion beyond the old thirty-line cap", async () => {
  const base = { "src/amount.mjs": "export function amount(value) {\n  return value;\n}\n" };
  for (let index = 0; index < 80; index++) base["src/" + "long-neutral-name-".repeat(8) + index + ".mjs"] =
    "import { amount } from './amount.mjs';\n" + Array.from({ length: 3 }, (_, owner) =>
      "export function inspect" + owner + "(value) {\n  return amount(value);\n}\n").join("");
  const addedTest = "import { amount } from '../src/amount.mjs';\ntest('amount stays bounded after setup', () => {\n" +
    Array.from({ length: 35 }, (_, index) => "  const item" + index + " = " + index + ";").join("\n") +
    "\n  assert.equal(amount(-1), 0);\n});\n";
  const run = await fixture(base, {
    "src/amount.mjs": base["src/amount.mjs"].replace("return value;", "return Math.max(0, value);"),
    "test/amount.test.mjs": addedTest,
  });
  const output = await run();
  assert.match(output, /\+\d+\|  assert.equal\(amount\(-1\), 0\);/);
  assert.match(output, /reference detail lines omitted by byte budget/);
  assert.doesNotMatch(output, /test\/amount.test.mjs: \d+ removed and \d+ added diff lines not shown/);
});
