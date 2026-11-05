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
after(async () => {
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
});

async function repository(file, contents) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-folded-contracts-"));
  directories.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", NO_COLOR: "1" };
  const git = (...args) => exec("git", args, { cwd: root, env });
  await git("init", "-q", "-b", "main");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "folded-contract-fixture", type: "module",
    scripts: { test: "node --test" } }));
  await git("add", "-A");
  await git("commit", "-q", "-m", "chore: baseline");
  await git("checkout", "-q", "-b", "feat/examples");
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await fs.writeFile(path.join(root, file), contents);
  await git("add", "-A");
  await git("commit", "-q", "-m", "test: add behavior examples");
  return { root, directory, env };
}

function changedTests(count) {
  const lines = ["import test from 'node:test';", "import assert from 'node:assert/strict';"];
  const contracts = [];
  for (let index = 0; index < count; index++) {
    const title = `case${String(index).padStart(3, "0")}`;
    contracts.push({ title, line: lines.length + 1 });
    lines.push(`test('${title}', () => {`, `  assert.equal(${index}, ${index});`, "});");
  }
  assert.ok(lines.length > 400, "the regression needs a long run beyond the full-detail hunk cap");
  return { contents: `${lines.join("\n")}\n`, contracts };
}

async function brief(fixture, args = []) {
  const outputDirectory = path.join(fixture.directory, "reports");
  const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "brief", fixture.root, "--base", "main",
    "--output", outputDirectory, ...args], { cwd: fixture.root, env: fixture.env });
  assert.equal(stderr, "");
  const runs = await fs.readdir(outputDirectory);
  assert.equal(runs.length, 1);
  const full = JSON.parse(await fs.readFile(path.join(outputDirectory, runs[0], "report.json"), "utf8"));
  assert.match(stdout, /Static analysis only: no tests were run, no LLM was called\./);
  assert.equal(full.testContracts.execution, "not-run");
  return { output: stdout, full };
}

function section(output) {
  const start = output.indexOf("== Changed test contracts ==\n");
  if (start < 0) return "";
  const content = output.slice(start + "== Changed test contracts ==\n".length);
  const end = content.search(/^== |^References:/m);
  return end < 0 ? content : content.slice(0, end);
}

test("folded long added test runs retain every contract identity when the default budget allows", async () => {
  const file = "test/fold.test.mjs", changed = changedTests(150);
  const fixture = await repository(file, changed.contents);
  const { output, full } = await brief(fixture);
  assert.ok(Buffer.byteLength(output) <= 24000);
  assert.match(output, /more added lines at head/);
  const contracts = section(output);
  assert.ok(contracts, "folded declarations are not fully shown tests");
  for (const contract of changed.contracts) {
    assert.ok(contracts.split("\n").some(row => row.includes(`${file}:${contract.line} `) && row.includes(`"${contract.title}"`)),
      `the folded contract ${file}:${contract.line} ${contract.title} needs its identity`);
  }
  assert.match(contracts, /test\/fold\.test\.mjs:450 "case149"/);
  assert.doesNotMatch(contracts, /contract titles\/locations omitted/);
  assert.equal(full.evidence.changedTestContracts.filter(contract => contract.file === file).length, changed.contracts.length);
});

test("a tight folded-test brief reports the exact number of contract identities it omits", async () => {
  const file = "test/fold.test.mjs", changed = changedTests(150);
  const fixture = await repository(file, changed.contents);
  const { output, full } = await brief(fixture, ["--max-bytes", "4000"]);
  assert.ok(Buffer.byteLength(output) <= 4000);
  const contracts = section(output);
  assert.ok(contracts, "folded test identities need a bounded pending list");
  const displayed = new Set([...contracts.matchAll(/"(case\d{3})"/g)].map(match => match[1]));
  assert.ok(displayed.size > 0 && displayed.size < changed.contracts.length);
  for (const contract of changed.contracts.filter(contract => displayed.has(contract.title))) {
    assert.ok(contracts.split("\n").some(row => row.includes(`${file}:${contract.line} `) && row.includes(`"${contract.title}"`)));
  }
  const omitted = changed.contracts.length - displayed.size;
  assert.match(contracts, new RegExp(`- ${omitted} changed test contract titles/locations omitted by byte budget`));
  assert.match(output, /== Not fully shown \(removed lines appear only in the diff\) ==/);
  assert.match(output, /References:/);
  assert.doesNotMatch(output, /\[brief truncated at/);
  assert.equal(full.evidence.changedTestContracts.filter(contract => contract.file === file).length, changed.contracts.length);
});
