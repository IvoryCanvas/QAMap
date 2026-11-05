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

after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function repository(base, head) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-contract-brief-test-"));
  roots.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
  const git = (...args) => exec("git", args, { cwd: root, env });
  const write = async files => {
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents);
    }
  };
  await git("init", "-q", "-b", "main");
  await write(base);
  await git("add", "-A");
  await git("commit", "-q", "-m", "chore: baseline");
  await git("checkout", "-q", "-b", "feat/change");
  await write(head);
  await git("add", "-A");
  await git("commit", "-q", "-m", "test: retain changed behavior expectations");
  return { root, directory };
}

async function brief(root, args = []) {
  const reportDirectory = path.join(path.dirname(root), "reports");
  const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "brief", root, "--base", "main",
    "--output", reportDirectory, ...args], { cwd: root, env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(stderr, "");
  const runs = await fs.readdir(reportDirectory);
  assert.equal(runs.length, 1, "the brief still saves one complete local report");
  const full = JSON.parse(await fs.readFile(path.join(reportDirectory, runs[0], "report.json"), "utf8"));
  return { output: stdout, full };
}

function testFile(titles) {
  const lines = ["import test from 'node:test';", "import assert from 'node:assert/strict';"];
  const contracts = [];
  for (const [index, title] of titles.entries()) {
    contracts.push({ title, line: lines.length + 1 });
    lines.push(`test(${JSON.stringify(title)}, () => {`, `  assert.equal(${index}, ${index});`, "});");
  }
  return { source: `${lines.join("\n")}\n`, contracts };
}

// A legitimate source delta that cannot fit even at the brief's smallest detail
// level makes test excerpts compete for the same finite output budget.
function largeSource(value) {
  return "export function buildRows() {\n" + Array.from({ length: 96 }, (_, index) =>
    `  const row${index} = '${value.repeat(720)}';\n`).join("") + "  return row0;\n}\n";
}

function contractSection(output) {
  const start = output.indexOf("== Changed test contracts ==\n");
  if (start < 0) return "";
  const content = output.slice(start + "== Changed test contracts ==\n".length);
  const end = content.search(/^== |^References:/m);
  return end < 0 ? content : content.slice(0, end);
}

function assertCompleteReport(full, file, contracts) {
  assert.equal(full.testContracts.declared, contracts.length);
  assert.equal(full.testContracts.omittedItemCount, 0);
  assert.equal(full.testContracts.execution, "not-run");
  const retained = full.evidence.changedTestContracts.filter(contract => contract.file === file);
  assert.equal(retained.length, contracts.length);
  for (const contract of contracts) {
    assert.ok(retained.some(item => item.line === contract.line && item.title === contract.title),
      `the saved JSON lost ${file}:${contract.line} ${contract.title}`);
  }
}

test("compact changed-test contracts retain every title and location beyond eight when the default budget allows", async () => {
  const file = "test/behavior.test.mjs";
  const titles = Array.from({ length: 21 }, (_, index) => `behavior case ${String(index).padStart(2, "0")} preserves its expectation`);
  const changed = testFile(titles);
  const { root } = await repository({
    "package.json": JSON.stringify({ name: "changed-contract-brief-fixture", type: "module", scripts: { test: "node --test" } }),
    "src/rows.mjs": largeSource("a"),
  }, { "src/rows.mjs": largeSource("b"), [file]: changed.source });
  const { output, full } = await brief(root);
  assert.ok(Buffer.byteLength(output) <= 24000);
  const section = contractSection(output);
  assert.ok(section, "a compact test diff needs its changed-contract list");
  for (const contract of changed.contracts) {
    assert.ok(section.split("\n").some(row => row.includes(`${file}:${contract.line}`) && row.includes(contract.title)),
      `the brief lost the title or location of ${file}:${contract.line}`);
  }
  assert.doesNotMatch(section, /\b\d+\s+(?:more\s+)?(?:changed\s+)?(?:test\s+)?(?:contracts?\s+)?(?:titles?\s+)?(?:not shown|omitted)\b/);
  assert.match(output, /Static analysis only: no tests were run, no LLM was called\./);
  assertCompleteReport(full, file, changed.contracts);
});

test("tight changed-contract briefs keep complete Unicode locations and truthful omissions without losing their tail", async () => {
  const file = `test/${"검증🧭-".repeat(8)}/${"기대🙂-".repeat(8)}/behavior.test.mjs`;
  const titles = Array.from({ length: 36 }, (_, index) =>
    `unicode-case-${String(index).padStart(2, "0")} / ${"정상🧭".repeat(48)} 결과를 유지한다`);
  const changed = testFile(titles);
  const { root } = await repository({
    "package.json": JSON.stringify({ name: "unicode-contract-brief-fixture", type: "module", scripts: { test: "node --test" } }),
    "src/rows.mjs": largeSource("a"),
  }, { "src/rows.mjs": largeSource("b"), [file]: changed.source });
  const { output, full } = await brief(root, ["--max-bytes", "4000"]);
  assert.ok(Buffer.byteLength(output) <= 4000, `brief exceeded 4000 bytes: ${Buffer.byteLength(output)}`);
  assert.doesNotMatch(output, /\uFFFD/, "title clipping must not split an emoji surrogate pair");
  assert.equal(Buffer.from(output).toString("utf8"), output);
  const section = contractSection(output);
  assert.ok(section, "byte pressure must not silently remove the changed-contract section");
  const displayed = new Set([...section.matchAll(/unicode-case-\d{2}/g)].map(match => match[0]));
  assert.ok(displayed.size > 0 && displayed.size < changed.contracts.length,
    "this fixture should retain some contracts and explicitly omit others");
  for (const contract of changed.contracts) {
    const identity = /^unicode-case-\d{2}/.exec(contract.title)[0];
    if (!displayed.has(identity)) continue;
    assert.ok(section.split("\n").some(row => row.includes(identity) && row.includes(`${file}:${contract.line}`)),
      `the displayed title ${identity} needs its complete, untruncated path and line`);
  }
  const omitted = changed.contracts.length - displayed.size;
  const omissionRows = section.split("\n").filter(row => /\b(?:omitted|not shown)\b/.test(row));
  assert.ok(omissionRows.some(row => new RegExp(`\\b${omitted}\\b`).test(row) && /\b(?:byte|budget)\b/.test(row)),
    `the brief must disclose exactly ${omitted} contract identities omitted by its byte budget`);
  assert.match(output, /== Not fully shown \(removed lines appear only in the diff\) ==/);
  assert.match(output, /src\/rows\.mjs: .*not shown/);
  assert.match(output, /- Show them with: git diff /);
  assert.match(output, /References: matched by name in tracked files at the compared head/);
  assert.doesNotMatch(output, /\[brief truncated at/, "bounded contract rendering should preserve the existing recovery tail");
  // A recovery pointer is optional. If supplied, it must identify the complete
  // JSON rather than the Markdown report, which has its own contract item cap.
  if (/report\.(?:json|md)/.test(output)) {
    assert.match(output, /report\.json/);
    assert.doesNotMatch(output, /report\.md/);
  }
  assertCompleteReport(full, file, changed.contracts);
});

test("fully printed changed test diffs do not repeat their contracts in a pending list", async () => {
  const file = "test/visible.test.mjs";
  const changed = testFile(Array.from({ length: 12 }, (_, index) => `visible behavior ${index} keeps its result`));
  const { root } = await repository({
    "package.json": JSON.stringify({ name: "visible-contract-brief-fixture", type: "module", scripts: { test: "node --test" } }),
  }, { [file]: changed.source });
  const { output, full } = await brief(root);
  assert.ok(Buffer.byteLength(output) <= 24000);
  for (const contract of changed.contracts) {
    assert.ok(output.includes(`+${contract.line}|test(${JSON.stringify(contract.title)}, () => {`),
      `the fixture must show the declaration at ${file}:${contract.line}`);
    assert.ok(output.includes(`+${contract.line + 1}|  assert.equal(`),
      `the fixture must also show its assertion at ${file}:${contract.line + 1}`);
  }
  assert.equal(contractSection(output), "", "fully shown test files do not belong in the pending contract list");
  assertCompleteReport(full, file, changed.contracts);
});
