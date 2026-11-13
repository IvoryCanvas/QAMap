import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import test from "node:test";

const root = new URL("./benchmarks/review-host/independent-2026-11-13/", import.meta.url);
test("independent public snapshots retain their exact source bytes and frozen oracles", async () => {
  const sources = JSON.parse(await fs.readFile(new URL("sources.json", root), "utf8"));
  const cases = JSON.parse(await fs.readFile(new URL("cases.json", root), "utf8"));
  const oracles = JSON.parse(await fs.readFile(new URL("oracles.json", root), "utf8"));
  assert.equal(cases.cases.length, 2);
  for (const source of sources) {
    const bytes = await fs.readFile(new URL(source.file, root));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), source.sha256, source.file);
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), source.gitBlobSha, source.file);
  }
  for (const entry of cases.cases) {
    assert.equal(oracles[entry.id].seeded.length, 1);
    assert.match(oracles[entry.id].source, /^https:\/\/github.com\//);
    assert.match(oracles[entry.id].fixtureScope, /No dependencies installed and no tests executed/);
  }
});
