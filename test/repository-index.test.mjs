import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRepositoryEvidenceIndex, repositoryIndexMatchesRef } from "../dist/repository-index.js";
import { collectSourceStructure } from "../dist/source-structure.js";
import { buildReverseImportIndex } from "../dist/import-graph.js";

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "qamap-repository-evidence-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  await mkdir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  await put("src/value.ts", "export function format(value: string) { return value.trim(); }");
  await put("src/service.ts", "import { format as label } from './value';\nexport const service = (value: string) => label(value);");
  await put("tests/service.test.ts", "import { service } from '../src/service';\ntest('hidden description', () => { expect(service('DO_NOT_PERSIST_PAYLOAD')).toBe('expected'); });");
  await put("package.json", JSON.stringify({ private: true, scripts: { test: "node --test SECRET_COMMAND", dev: "SECRET_DEV" } }));
  await put("schema/openapi.json", JSON.stringify({ openapi: "3.1.0", paths: { "/items": { get: { responses: { 200: { description: "ok" }, 400: { example: "SECRET_ERROR" } } } } } }));
  return { root, cacheDirectory: path.join(temp, "cache"), put };
}

test("repository index reuses metadata across processes without persisting source or payloads", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
  const cold = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.equal(cold.reuse.status, "cold");
  assert.equal(cold.reuse.rebuiltFiles, 5);
  assert.equal(cold.reuse.storage, "saved");
  const warm = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.equal(warm.reuse.status, "warm");
  assert.equal(warm.reuse.reusedFiles, 5);
  assert.equal(warm.reuse.readFiles, 5);
  assert.equal(warm.reuse.readBytes, cold.reuse.readBytes);
  assert.equal(warm.reuse.rebuiltFiles, 0);
  assert.deepEqual(warm.coverage, cold.coverage);
  assert.deepEqual(warm.blocks, cold.blocks);
  const moduleUrl = new URL("../dist/repository-index.js", import.meta.url).href;
  const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { buildRepositoryEvidenceIndex } from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await buildRepositoryEvidenceIndex(process.cwd(), { cacheDirectory: ${JSON.stringify(cacheDirectory)} })));
  `], { cwd: root, encoding: "utf8" }));
  assert.equal(restarted.reuse.reusedFiles, 5);
  assert.deepEqual(restarted.blocks, cold.blocks);
  const [name] = await readdir(cacheDirectory);
  const stored = await readFile(path.join(cacheDirectory, name), "utf8");
  for (const privateText of [root, "hidden description", "DO_NOT_PERSIST_PAYLOAD", "SECRET_COMMAND", "SECRET_DEV", "SECRET_ERROR", "value.trim()"]) {
    assert.ok(!stored.includes(privateText), privateText);
  }
  assert.deepEqual(cold.blocks.find((block) => block.file === "src/service.ts").imports,
    [{ module: "./value", imported: "format", local: "label", line: 1 }]);
  assert.ok(cold.blocks.find((block) => block.kind === "test").tests.some((entry) => entry.kind === "assertion"));
  assert.ok(cold.blocks.find((block) => block.kind === "contract").contracts.some((entry) => entry.pointer.endsWith("/400")));
  assert.deepEqual(cold.blocks.find((block) => block.kind === "configuration").validation.map((entry) => entry.name), ["test"]);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), before);
});

test("one changed block invalidates transitive dependents while syntax remains reusable", async (t) => {
  const { root, cacheDirectory, put } = await fixture(t);
  await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  await put("src/value.ts", "export function format(value: string) { return value.trim().toUpperCase(); }");
  const edit = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.equal(edit.reuse.status, "incremental");
  assert.equal(edit.reuse.rebuiltFiles, 1);
  assert.equal(edit.reuse.reusedFiles, 4);
  assert.deepEqual(edit.reuse.changedFiles, ["src/value.ts"]);
  assert.deepEqual(edit.reuse.affectedFiles, ["src/service.ts", "tests/service.test.ts"]);
  const fresh = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  assert.deepEqual(edit.blocks, fresh.blocks);
  assert.deepEqual(edit.coverage, fresh.coverage);
  await put("package.json", JSON.stringify({ scripts: { test: "node --test --test-reporter=tap" } }));
  const config = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.equal(config.reuse.rebuiltFiles, 1);
  assert.deepEqual(config.reuse.affectedFiles, ["src/service.ts", "tests/service.test.ts"]);
  await rm(path.join(root, "src/value.ts"));
  const removed = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.deepEqual(removed.reuse.changedFiles, ["src/value.ts"]);
  assert.ok(removed.reuse.affectedFiles.includes("tests/service.test.ts"));
});

test("index coverage names unreadable boundaries and does not hide late tracked evidence", async (t) => {
  const { root, cacheDirectory, put } = await fixture(t);
  await put(".gitignore", "ignored/\n");
  await put("ignored/secret.ts", "export const secret = 1;");
  await put("src/large.ts", " ".repeat(300001));
  await put("src/binary.ts", Buffer.from([1, 0, 2]));
  await put("src/unsupported.go", "package example");
  await put("dist/generated.ts", "export const generated = 1;");
  await put("README.md", "Documentation only");
  await symlink("value.ts", path.join(root, "src/link.ts"));
  for (let i = 0; i < 2001; i++) await put(`src/a-${i}.ts`, `export const value${i} = ${i};`);
  await put("src/z-last.ts", "export const finalContract = true;");
  execFileSync("git", ["add", "."], { cwd: root });
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.ok(index.blocks.some((block) => block.file === "src/z-last.ts"));
  assert.ok(index.blocks.some((block) => block.file === "tests/service.test.ts"));
  assert.equal(index.coverage.complete, false);
  for (const [file, reason] of [["src/large.ts", "oversized"], ["src/binary.ts", "binary"], ["src/unsupported.go", "unsupported-language"],
    ["src/link.ts", "symlink"], ["dist/generated.ts", "excluded-directory"], ["README.md", "documentation"]]) {
    assert.ok(index.coverage.skipped.some((gap) => gap.path === file && gap.reason === reason), file);
  }
  assert.ok(!JSON.stringify(index).includes("ignored/secret.ts"));
  const warm = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.equal(warm.reuse.reusedFiles, 2007);
  assert.equal(warm.coverage.fingerprint, index.coverage.fingerprint);
});

test("corrupt metadata is disposable, disabled caches and repository paths are not written", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  const baseline = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  const [name] = await readdir(cacheDirectory);
  const filename = path.join(cacheDirectory, name);
  const original = await readFile(filename, "utf8");
  for (const mutate of [
    (snapshot) => { snapshot.schema = 99; },
    (snapshot) => { snapshot.blocks[0].source = "unsafe"; },
    (snapshot) => { snapshot.blocks[0].file = "../outside.ts"; },
    (snapshot) => { snapshot.blocks[0].imports = [{ module: "https://example.test/?secret=1", local: "x", imported: "x", line: 1 }]; },
    (snapshot) => { snapshot.blocks[0].references = [{ name: "x", owner: "x", line: -1 }]; },
  ]) {
    const value = JSON.parse(original); mutate(value);
    await writeFile(filename, JSON.stringify(value));
    const repaired = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
    assert.equal(repaired.reuse.status, "rebuilt");
    assert.deepEqual(repaired.blocks, baseline.blocks);
  }
  const disabled = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  assert.equal(disabled.reuse.status, "disabled");
  const rejected = await buildRepositoryEvidenceIndex(root, { cacheDirectory: path.join(root, "cache") });
  assert.equal(rejected.reuse.status, "unavailable");
  await assert.rejects(readFile(path.join(root, "cache")), { code: "ENOENT" });
});

test("a shared cache directory keeps import and repository snapshots independent", async (t) => {
  const { root, cacheDirectory } = await fixture(t);
  await buildReverseImportIndex(root, { cacheDirectory });
  await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.equal((await readdir(cacheDirectory)).length, 2);
  assert.equal((await buildReverseImportIndex(root, { cacheDirectory })).reuse.status, "warm");
  assert.equal((await buildRepositoryEvidenceIndex(root, { cacheDirectory })).reuse.status, "warm");
});

test("deep or oversized configuration metadata fails closed without poisoning reuse", async (t) => {
  const { root, cacheDirectory, put } = await fixture(t);
  await put("package.json", '{"name":"@fixture/core","exports":' + '{"default":'.repeat(12000) + '"./src/value.ts"' + '}'.repeat(12000) + '}');
  await put("schema/openapi.json", JSON.stringify({ openapi: "3.1.0", paths: {
    ["/" + "x".repeat(4100)]: { get: { responses: { 400: {} } } },
    "/safe": { get: { responses: { 200: {} } } },
  } }));
  const cold = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  const configuration = cold.blocks.find((block) => block.file === "package.json");
  assert.ok(configuration.gaps.some((gap) => gap.kind === "parse-error"));
  assert.deepEqual(configuration.modules, []);
  const contract = cold.blocks.find((block) => block.kind === "contract");
  assert.ok(contract.gaps.some((gap) => gap.kind === "unsupported-contract-pointer"));
  assert.equal(contract.contracts.length, 2);
  assert.ok(contract.contracts.every((entry) => entry.pointer.includes("safe")));
  const warm = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.equal(warm.reuse.rebuiltFiles, 0);
  assert.deepEqual(warm.blocks, cold.blocks);
});

test("a working-tree index does not supply evidence for a different committed snapshot", async (t) => {
  const { root, put } = await fixture(t);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "initial fixture"], { cwd: root });
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  assert.equal(await repositoryIndexMatchesRef(root, index, "HEAD"), true);
  await put("README.md", "Untracked documentation does not change indexed evidence.");
  assert.equal(await repositoryIndexMatchesRef(root, index, "HEAD"), true);
  await put("src/value.ts", "export function format() { return 'changed'; }");
  assert.equal(await repositoryIndexMatchesRef(root, index, "HEAD"), false);
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "change fixture"], { cwd: root });
  assert.equal(await repositoryIndexMatchesRef(root, index, "HEAD~1"), false);
  await rm(path.join(root, "src/service.ts"));
  assert.equal(await repositoryIndexMatchesRef(root, index, "HEAD"), false);
  assert.equal(await repositoryIndexMatchesRef(root, index, "nonexistent-ref"), false);
});

test("syntax facts keep aliases and exports, exclude shadowed references, and flag dynamic imports", () => {
  const structure = collectSourceStructure("service.ts", [
    "import { format as label } from './value';",
    "export function render(value: string) { return label(value); }",
    "function unrelated(label: (x: string) => string) { return label('x'); }",
    "export { render as view };",
    "router.get('/items', render);",
    "const dynamic = import(getPath());",
  ].join("\n"));
  assert.ok(structure.references.some((entry) => entry.name === "label" && entry.owner === "render"));
  assert.ok(!structure.references.some((entry) => entry.name === "label" && entry.owner === "unrelated"));
  assert.ok(structure.exports.some((entry) => entry.local === "render" && entry.exported === "view"));
  assert.ok(structure.routes.some((entry) => entry.handler === "render"));
  assert.ok(structure.gaps.some((entry) => entry.kind === "runtime-module-loading"));
  assert.ok(!JSON.stringify(structure).includes("/items"));
});
