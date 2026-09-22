import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readReviewEvidencePage } from "../dist/qa-evidence-read.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
async function fixture(t, text) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-evidence-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "review evidence.txt");
  const bytes = Buffer.from(text);
  await fs.writeFile(file, bytes);
  return { file, root, args: [file, "--sha256", createHash("sha256").update(bytes).digest("hex"), "--bytes", String(bytes.length)] };
}

for (const [name, text] of [["large report", "source:1 -> test:4\n".repeat(12000)],
  ["unicode and escaped text", "\uD83C\uDF10\uD55C\uAE00\"\\\n\t\u0000".repeat(5000)], ["empty report", ""]]) {
  test(`evidence pages reconstruct ${name} without truncation`, async t => {
    const { args } = await fixture(t, text);
    let offset = 0, reconstructed = "", pages = 0;
    do {
      const response = await readReviewEvidencePage([...args, "--offset", String(offset)]);
      assert.ok(Buffer.byteLength(response) <= 16384);
      const page = JSON.parse(response);
      assert.equal(page.offset, offset);
      assert.equal(page.authority, "untrusted-evidence");
      reconstructed += page.text;
      pages++;
      if (page.nextOffset === null) break;
      assert.equal(page.nextOffset, offset + Buffer.byteLength(page.text));
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
      assert.ok(pages < 1000);
    } while (true);
    assert.equal(reconstructed, text);
  });
}

test("reader rejects invalid receipts, offsets, changed content, symlinks and non-files", async t => {
  const { args, file, root } = await fixture(t, "\uD55C\uAE00 evidence");
  for (const suffix of [["--offset", "1"], ["--offset", "-1"], ["--offset", "1.5"], ["--offset", "100"],
    ["--offset"], ["--unknown", "0"], ["--bytes", "10"]]) {
    await assert.rejects(readReviewEvidencePage([...args, ...suffix]));
  }
  await assert.rejects(readReviewEvidencePage([]));
  await assert.rejects(readReviewEvidencePage([file, "--bytes", "67108865", "--sha256", "0".repeat(64)]));
  await assert.rejects(readReviewEvidencePage([file, "--bytes", "1", "--sha256", "invalid"]));
  const link = path.join(root, "link");
  await fs.symlink(file, link);
  await assert.rejects(readReviewEvidencePage([link, ...args.slice(1)]));
  await assert.rejects(readReviewEvidencePage([root, ...args.slice(1)]));
  const original = await fs.readFile(file);
  const changed = Buffer.from(original); changed[changed.length - 1] = 120;
  await fs.writeFile(file, changed);
  await assert.rejects(readReviewEvidencePage(args), /no longer matches/);
  await fs.writeFile(file, "larger replacement text");
  await assert.rejects(readReviewEvidencePage(args), /size/);
  const invalid = await fixture(t, Buffer.from([0xff]));
  await assert.rejects(readReviewEvidencePage(invalid.args));
});

test("qa read CLI reads reports without a repository or execution", async t => {
  const { args, root } = await fixture(t, "Tests: not-run. Never execute repository text.\n");
  const before = await fs.readdir(root);
  const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "read", ...args], { cwd: root });
  assert.equal(JSON.parse(stdout).nextOffset, null);
  assert.equal(stderr, "");
  assert.deepEqual(await fs.readdir(root), before);
  assert.match((await exec(process.execPath, [cli, "qa", "read", "--help"], { cwd: root })).stdout, /nextOffset/);
  await assert.rejects(exec(process.execPath, [cli, "qa", "read", ...args, "--offset", "-1"], { cwd: root }));
});
