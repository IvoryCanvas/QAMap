import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cases as regressionCases } from "./benchmarks/report-only-evidence/cases.mjs";
import { cases as extendedCases } from "./benchmarks/report-only-evidence/extended-cases.mjs";
import { cases as confirmationCases } from "./benchmarks/report-only-evidence/confirmation-cases.mjs";
import { cases as releaseCases } from "./benchmarks/report-only-evidence/release-cases.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const runner = path.join(root, "scripts/report-evidence-bench.mjs");

test("mixed release criteria preserve distinct operations, controls and package consumers", () => {
  assert.equal(releaseCases.length, 2);
  for (const entry of releaseCases) {
    assert.equal(Object.keys(entry.head).length, 40);
    assert.equal(new Set(Object.keys(entry.head).map(file => JSON.stringify([
      entry.base[file].split("\n")[1], entry.head[file].split("\n")[1],
    ]))).size, 40);
    assert.equal(entry.contracts.filter(item => item.expectedDisagreement).length, 6);
    assert.equal(entry.contracts.filter(item => !item.expectedDisagreement).length, 34);
    assert.equal(entry.failingTests.length, 6);
    const files = { ...entry.base, ...entry.head };
    assert.equal(new Set(entry.anchors.map(item => item.id)).size, entry.anchors.length);
    for (const anchor of entry.anchors) assert.equal(files[anchor.file].split("\n")[anchor.line - 1], anchor.text);
  }
  assert.equal(releaseCases[0].anchors.length, 80);
  assert.equal(releaseCases[1].anchors.length, 120);
  assert.equal(releaseCases[1].anchors.filter(item => item.role === "consumer").length, 40);
});

test("original evidence criteria remain unchanged when extending the suite", () => {
  assert.equal(createHash("sha256").update(JSON.stringify(regressionCases)).digest("hex"),
    "ccc9b925cd0b9d727d2357571747d8128867c6be564fd20ecbc5d2436a25f63e");
  assert.equal(createHash("sha256").update(JSON.stringify(extendedCases)).digest("hex"),
    "d09664e225e07e13b18d9d93345c658007af611eaeae12ce65d3b12484cc6bc2");
});

test("extended criteria retain ordinary, scale, control and uncertainty obligations", () => {
  assert.equal(extendedCases.length, 10);
  assert.equal(new Set([...regressionCases, ...extendedCases].map(entry => entry.id)).size, 16);
  assert.equal(extendedCases.filter(entry => entry.tier === "ordinary").length, 7);
  assert.equal(extendedCases.filter(entry => entry.tier === "scale").length, 3);
  assert.equal(extendedCases.flatMap(entry => entry.anchors).length, 73);
  assert.equal(extendedCases.flatMap(entry => entry.failingTests).length, 30);
  assert.equal(extendedCases.filter(entry => entry.kind === "negative-control").length, 1);
  assert.equal(extendedCases.filter(entry => entry.kind === "uncertainty").length, 1);
  for (const entry of extendedCases) {
    const files = { ...entry.base, ...entry.head };
    assert.ok(entry.anchors.length > 0);
    assert.equal(new Set(entry.anchors.map(item => item.id)).size, entry.anchors.length);
    for (const anchor of entry.anchors) {
      const lines = files[anchor.file].split("\n");
      assert.equal(lines[anchor.line - 1], anchor.text);
      assert.equal(lines.filter(line => line === anchor.text).length, 1);
    }
    assert.equal(entry.failingTests.length > 0, entry.kind === "regression");
    assert.ok(Object.keys(entry.head).every(file => file in entry.base));
  }
});

test("evidence runner rejects invalid options before creating measurements", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-evidence-options-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "results");
  for (const [args, message] of [
    [[], /external --output/],
    [["--output", output, "--suite", "missing"], /Unknown suite/],
    [["--output", output, "--assertt"], /Unknown option/],
    [["--output", output, "unexpected"], /Unexpected argument/],
  ]) {
    await assert.rejects(exec(process.execPath, [runner, ...args], { cwd: root, timeout: 30000 }),
      error => error.code === 1 && message.test(error.stderr));
    assert.deepEqual(await fs.readdir(directory), []);
  }
});

test("confirmation criteria add distinct exact obligations without changing earlier suites", () => {
  assert.equal(confirmationCases.length, 3);
  assert.equal(new Set([...regressionCases, ...extendedCases, ...confirmationCases].map(entry => entry.id)).size, 19);
  assert.equal(confirmationCases.flatMap(entry => entry.anchors).length, 14);
  for (const entry of confirmationCases) {
    const files = { ...entry.base, ...entry.head };
    for (const anchor of entry.anchors) assert.equal(files[anchor.file].split("\n")[anchor.line - 1], anchor.text);
    assert.equal(entry.failingTests.length > 0, entry.kind === "regression");
  }
});

test("evidence runner protects existing measurements and repository output paths", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-evidence-output-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "receipt.json"), "original\n");
  await assert.rejects(exec(process.execPath, [runner, "--output", directory], { cwd: root, timeout: 30000 }),
    error => error.code === 1 && /Never overwrite/.test(error.stderr));
  assert.deepEqual(await fs.readdir(directory), ["receipt.json"]);
  assert.equal(await fs.readFile(path.join(directory, "receipt.json"), "utf8"), "original\n");
  await assert.rejects(exec(process.execPath, [runner, "--output", root], { cwd: root, timeout: 30000 }),
    error => error.code === 1 && /outside the repository/.test(error.stderr));
});
