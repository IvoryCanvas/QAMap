import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReverseImportIndex } from "../dist/import-graph.js";
import { openImportCache } from "../dist/import-index-cache.js";

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "qamap-import-cache-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  const cacheDirectory = path.join(temp, "cache");
  await mkdir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  await put("src/value.ts", "export const value = 1;");
  await put("src/service.ts", "import { value } from './value'; export const service = value;");
  await put("src/pages/view.ts", "import { service } from '../service'; export const view = service;");
  await put("src/unrelated.ts", "export const unrelated = 1;");
  return { root, cacheDirectory, put };
}

function edges(index) {
  return [...index.importsOf].map(([file, imports]) => [file, [...imports]]);
}

test("cold, warm and separate-process import indexes preserve semantic evidence", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const cold = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(cold.reuse.status, "cold");
  assert.equal(cold.reuse.rebuiltSources, 4);
  assert.equal(cold.reuse.reusedSources, 0);
  assert.equal(cold.reuse.storage, "saved");
  assert.equal(cold.reuse.hasBaseline, false);
  assert.deepEqual(cold.reuse.changedSources, []);
  const warm = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(warm.reuse.status, "warm");
  assert.equal(warm.reuse.reusedSources, 4);
  assert.equal(warm.reuse.rebuiltSources, 0);
  assert.equal(warm.reuse.storage, "unchanged");
  if (process.platform !== "win32") {
    assert.equal((await lstat(cacheDirectory)).mode & 0o777, 0o700);
    const [file] = await readdir(cacheDirectory);
    assert.equal((await lstat(path.join(cacheDirectory, file))).mode & 0o777, 0o600);
  }
  assert.deepEqual(warm.coverage, cold.coverage);
  assert.deepEqual(edges(warm), edges(cold));

  const moduleUrl = new URL("../dist/import-graph.js", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { buildReverseImportIndex } from ${JSON.stringify(moduleUrl)};
    const index = await buildReverseImportIndex(process.cwd(), { cacheDirectory: ${JSON.stringify(cacheDirectory)} });
    console.log(JSON.stringify({ coverage: index.coverage, reuse: index.reuse }));
  `], { cwd: root, encoding: "utf8" });
  const separate = JSON.parse(output);
  assert.equal(separate.reuse.reusedSources, 4);
  assert.deepEqual(separate.coverage, cold.coverage);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), before);
});

test("content changes reuse unrelated blocks and name transitive affected importers", async (t) => {
  const { root, cacheDirectory, put } = await fixture(t);
  const initial = await buildReverseImportIndex(root, { cacheDirectory });
  await put("src/value.ts", "export const value = 2;");
  const changed = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(changed.reuse.status, "incremental");
  assert.equal(changed.reuse.rebuiltSources, 1);
  assert.equal(changed.reuse.reusedSources, 3);
  assert.deepEqual(changed.reuse.changedSources, ["src/value.ts"]);
  assert.deepEqual(changed.reuse.affectedImporters, ["src/pages/view.ts", "src/service.ts"]);
  assert.notEqual(changed.coverage.fingerprint, initial.coverage.fingerprint);
  const fresh = await buildReverseImportIndex(root, { cacheDirectory: false });
  assert.deepEqual(changed.coverage, fresh.coverage);
  assert.deepEqual(edges(changed), edges(fresh));
});

test("alias and inventory changes rebuild resolution instead of retaining old edges", async (t) => {
  const { root, cacheDirectory, put } = await fixture(t);
  await put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@value": ["src/value"] } } }));
  await put("src/service.ts", "import { value } from '@value'; export const service = value;");
  await buildReverseImportIndex(root, { cacheDirectory });
  await put("tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@value": ["src/unrelated"] } } }));
  const remapped = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(remapped.reuse.status, "rebuilt");
  assert.equal(remapped.reuse.reason, "resolution-context-changed");
  assert.deepEqual([...remapped.importsOf.get("src/service.ts")], ["src/unrelated.ts"]);
  await rm(path.join(root, "src/unrelated.ts"));
  const removed = await buildReverseImportIndex(root, { cacheDirectory });
  assert.ok(!removed.importsOf.has("src/service.ts"));
  assert.ok(removed.reuse.changedSources.includes("src/unrelated.ts"));
});

test("cache corruption is disposable and cache files do not contain source bodies", async (t) => {
  const { root, cacheDirectory, put } = await fixture(t);
  await put("src/private.ts", "export const value = 'DO_NOT_COPY_THIS_SOURCE'; import 'https://example.test/?token=DO_NOT_COPY_TOKEN';");
  const initial = await buildReverseImportIndex(root, { cacheDirectory });
  const [file] = await readdir(cacheDirectory);
  const content = await readFile(path.join(cacheDirectory, file), "utf8");
  assert.ok(!content.includes("DO_NOT_COPY"));
  assert.ok(!content.includes(root));
  await writeFile(path.join(cacheDirectory, file), "broken json");
  const repaired = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(repaired.reuse.status, "rebuilt");
  assert.equal(repaired.reuse.reason, "invalid-cache");
  assert.deepEqual(repaired.coverage, initial.coverage);
  assert.deepEqual(edges(repaired), edges(initial));
  assert.equal(repaired.reuse.storage, "saved");
});

test("disabled and in-repository cache paths cannot write cache state", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  const disabled = await buildReverseImportIndex(root, { cacheDirectory: false });
  assert.equal(disabled.reuse.status, "disabled");
  assert.equal(disabled.reuse.storage, "skipped");
  const forbidden = path.join(root, ".cache");
  const rejected = await buildReverseImportIndex(root, { cacheDirectory: forbidden });
  assert.equal(rejected.reuse.status, "unavailable");
  await assert.rejects(lstat(forbidden), { code: "ENOENT" });
  assert.deepEqual(edges(rejected), edges(disabled));
  const moduleUrl = new URL("../dist/import-graph.js", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { buildReverseImportIndex } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify((await buildReverseImportIndex(process.cwd(), {
      cacheDirectory: ${JSON.stringify(cacheDirectory)}
    })).reuse));
  `], { cwd: root, env: { ...process.env, QAMAP_IMPORT_CACHE: "off" }, encoding: "utf8" });
  assert.equal(JSON.parse(output).status, "disabled");
  await assert.rejects(lstat(cacheDirectory), { code: "ENOENT" });
});

test("symlink and shared cache locations are not followed or repaired", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  const outside = path.join(path.dirname(root), "outside");
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, cacheDirectory, "dir");
  const directoryLink = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(directoryLink.reuse.status, "unavailable");
  assert.deepEqual(await readdir(outside), []);
  await rm(cacheDirectory);
  await buildReverseImportIndex(root, { cacheDirectory });
  const [name] = await readdir(cacheDirectory);
  const filename = path.join(cacheDirectory, name);
  const sentinel = path.join(outside, "sentinel");
  await writeFile(sentinel, "keep this unchanged");
  await rm(filename);
  await symlink(sentinel, filename);
  const fileLink = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(fileLink.reuse.status, "unavailable");
  assert.equal(await readFile(sentinel, "utf8"), "keep this unchanged");
  assert.equal((await lstat(filename)).isSymbolicLink(), true);
  if (process.platform !== "win32") {
    await chmod(cacheDirectory, 0o755);
    const shared = await buildReverseImportIndex(root, { cacheDirectory });
    assert.equal(shared.reuse.status, "unavailable");
    assert.equal((await lstat(cacheDirectory)).mode & 0o777, 0o755);
  }
});

test("invalid schema, unsafe paths and oversized snapshots rebuild without stale imports", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  const baseline = await buildReverseImportIndex(root, { cacheDirectory });
  const [name] = await readdir(cacheDirectory);
  const filename = path.join(cacheDirectory, name);
  const original = await readFile(filename, "utf8");
  const mutations = [
    (value) => { value.schema = 999; },
    (value) => { value.blocks[0].file = "../outside.ts"; },
    (value) => { value.blocks[0].imports = ["missing.ts"]; },
    (value) => { value.blocks[0].source = "must not be carried forward"; },
    (value) => { value.blocks.push(value.blocks[0]); },
  ];
  for (const mutate of mutations) {
    const value = JSON.parse(original);
    mutate(value);
    await writeFile(filename, JSON.stringify(value));
    const rebuilt = await buildReverseImportIndex(root, { cacheDirectory });
    assert.equal(rebuilt.reuse.reason, "invalid-cache");
    assert.equal(rebuilt.reuse.reusedSources, 0);
    assert.deepEqual(edges(rebuilt), edges(baseline));
    assert.deepEqual(rebuilt.coverage, baseline.coverage);
  }
  await writeFile(filename, "x".repeat(8 * 1024 * 1024 + 1));
  const oversized = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(oversized.reuse.reason, "invalid-cache");
  assert.equal(oversized.reuse.storage, "saved");
  assert.deepEqual(edges(oversized), edges(baseline));
});

test("failing discovery never reads or overwrites an otherwise valid cache", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  await buildReverseImportIndex(root, { cacheDirectory });
  const [name] = await readdir(cacheDirectory);
  const filename = path.join(cacheDirectory, name);
  const original = await readFile(filename, "utf8");
  await writeFile(path.join(root, ".git/index"), "invalid git index");
  const unavailable = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(unavailable.coverage.discovery, "unavailable");
  assert.equal(unavailable.reuse.status, "unavailable");
  assert.equal(unavailable.reuse.reusedSources, 0);
  assert.equal(unavailable.importsOf.size, 0);
  assert.equal(await readFile(filename, "utf8"), original);
});

test("cycles and removed imports retain affected importers from the previous graph", async (t) => {
  const { root, cacheDirectory, put } = await fixture(t);
  await put("src/value.ts", "import { service } from './service'; export const value = service;");
  await buildReverseImportIndex(root, { cacheDirectory });
  await put("src/service.ts", "export const service = 2;");
  const changed = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(changed.reuse.rebuiltSources, 1);
  assert.deepEqual(changed.reuse.affectedImporters, ["src/pages/view.ts", "src/value.ts"]);
  assert.equal(changed.importsOf.has("src/service.ts"), false);
  const fresh = await buildReverseImportIndex(root, { cacheDirectory: false });
  assert.deepEqual(edges(changed), edges(fresh));
});

test("concurrent writers leave one complete reusable snapshot and no temporary files", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => buildReverseImportIndex(root, { cacheDirectory })));
  for (const result of results) assert.deepEqual(result.coverage, results[0].coverage);
  assert.equal((await readdir(cacheDirectory)).length, 1);
  const warm = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(warm.reuse.status, "warm");
  assert.equal(warm.reuse.reusedSources, 4);
});

test("expired snapshots rebuild; writes bound retained snapshots and preserve unrelated files", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  await buildReverseImportIndex(root, { cacheDirectory });
  const [name] = await readdir(cacheDirectory);
  const filename = path.join(cacheDirectory, name);
  const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(filename, yesterday, yesterday);
  const expired = await buildReverseImportIndex(root, { cacheDirectory });
  assert.equal(expired.reuse.reason, "expired-cache");
  assert.equal(expired.reuse.storage, "saved");
  await writeFile(path.join(cacheDirectory, "keep.txt"), "unrelated");
  for (let index = 0; index < 9; index++) {
    const anotherRoot = path.join(path.dirname(root), `repo-${index}`);
    await mkdir(anotherRoot);
    const cache = await openImportCache(anotherRoot, cacheDirectory);
    await cache.save({ schema: 1, context: "0".repeat(64), blocks: [] });
  }
  assert.equal((await readdir(cacheDirectory)).filter((file) => file.endsWith(".json")).length, 8);
  assert.equal(await readFile(path.join(cacheDirectory, "keep.txt"), "utf8"), "unrelated");
});

test("storage failure does not fail analysis or recreate a replaced cache directory", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  const cache = await openImportCache(root, cacheDirectory);
  const moved = `${cacheDirectory}-moved`;
  await rename(cacheDirectory, moved);
  await mkdir(cacheDirectory, { mode: 0o700 });
  assert.equal(await cache.save({ schema: 1, context: "0".repeat(64), blocks: [] }), "failed");
  assert.deepEqual(await readdir(cacheDirectory), []);
  assert.deepEqual(await readdir(moved), []);
});

test("large import inventory preserves uncached, cold, warm and incremental evidence", async (t) => {
  const { root, cacheDirectory, put } = await fixture(t);
  for (let index = 0; index < 2001; index++) {
    const dependencies = ["../value", "../service", "../unrelated"];
    if (index) dependencies.push(`./module-${index - 1}`);
    await put(`src/modules/module-${index}.ts`, dependencies.map((dependency, offset) =>
      `import * as dependency${offset} from '${dependency}';`).join("\n") + `\nexport const index = ${index};`);
  }
  execFileSync("git", ["add", "."], { cwd: root });
  const times = {};
  const measure = async (label, options) => {
    const started = performance.now();
    const index = await buildReverseImportIndex(root, options);
    times[label] = Math.round((performance.now() - started) * 10) / 10;
    return index;
  };
  const uncached = await measure("uncachedMs", { cacheDirectory: false });
  const cold = await measure("coldMs", { cacheDirectory });
  const warm = await measure("warmMs", { cacheDirectory });
  assert.equal(cold.coverage.parsedSources, 2005);
  assert.equal(warm.reuse.reusedSources, 2005);
  assert.equal(warm.reuse.rebuiltSources, 0);
  for (const index of [cold, warm]) {
    assert.deepEqual(index.coverage, uncached.coverage);
    assert.deepEqual(edges(index), edges(uncached));
  }
  await put("src/value.ts", "export const value = 2;");
  const changed = await measure("incrementalMs", { cacheDirectory });
  assert.equal(changed.reuse.rebuiltSources, 1);
  assert.equal(changed.reuse.reusedSources, 2004);
  assert.equal(changed.reuse.affectedImporters.length, 2003);
  const fresh = await measure("changedUncachedMs", { cacheDirectory: false });
  assert.deepEqual(changed.coverage, fresh.coverage);
  assert.deepEqual(edges(changed), edges(fresh));
  t.diagnostic(JSON.stringify({ files: 2005, ...times, warmReused: 2005, incrementalRebuilt: 1,
    evidenceParity: true, timing: "single local sample; no speed or token-savings threshold" }));
});
