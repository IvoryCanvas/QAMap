import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildReverseImportIndex, findImportingSurfaces } from "../dist/import-graph.js";
import { formatAgentQaDraft, formatMarkdownQaDraft, generateQaDraft } from "../dist/qa.js";

async function repository(t, git = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (git) execFileSync("git", ["init", "-q"], { cwd: root });
  return root;
}

async function put(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

function track(root) {
  execFileSync("git", ["add", "."], { cwd: root });
}

test("Git discovery reaches late sources without counting unrelated files as source capacity", async (t) => {
  const root = await repository(t);
  for (let index = 0; index < 2005; index++) {
    await put(root, `assets/${index}.txt`, "supporting asset");
  }
  await put(root, "src/value.ts", "export const value = 1;");
  await put(root, "src/pages/view.tsx", "import { value } from '../value'; export const view = value;");
  await put(root, ".gitignore", "ignored/\n");
  track(root);
  await put(root, "ignored/secret.ts", "export const secret = 'must not be inspected';");
  await put(root, "local.ts", "export const local = 1;");
  const before = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });

  const index = await buildReverseImportIndex(root);
  assert.equal(index.coverage.discovery, "git");
  assert.equal(index.coverage.inventoryComplete, true);
  assert.equal(index.coverage.snapshot, "working-tree");
  assert.equal(index.coverage.parsedSources, 3);
  assert.equal(index.coverage.inventoryFiles, 2009);
  assert.deepEqual(findImportingSurfaces(index, ["src/value.ts"], (file) => file.includes("/pages/"))[0].chain,
    ["src/value.ts", "src/pages/view.tsx"]);
  assert.ok(!JSON.stringify(index.coverage).includes("secret"));
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), before);
});

test("discovery reports excluded, unsupported, oversized, binary, missing and symlink evidence", async (t) => {
  const root = await repository(t);
  const outside = await repository(t, false);
  await put(root, "src/ok.ts", "export const ok = 1;");
  await put(root, "src/huge.ts", "x".repeat(300001));
  await put(root, "src/binary.ts", Buffer.from([0, 1, 2]));
  await put(root, "service.py", "def calculate(): return 1");
  await put(root, "vendor/library.ts", "export const vendor = 1;");
  await put(root, "removed.ts", "export const removed = 1;");
  await put(root, "linked/hidden.ts", "export const inside = 1;");
  track(root);
  await rm(path.join(root, "removed.ts"));
  await rm(path.join(root, "linked"), { recursive: true });
  await put(outside, "hidden.ts", "export const DO_NOT_READ = 1;");
  await symlink(outside, path.join(root, "linked"));
  await symlink(path.join(outside, "hidden.ts"), path.join(root, "alias.ts"));

  const { coverage } = await buildReverseImportIndex(root);
  const reasons = new Map(coverage.skipped.map((entry) => [entry.path, entry.reason]));
  assert.equal(reasons.get("src/huge.ts"), "oversized");
  assert.equal(reasons.get("src/binary.ts"), "binary");
  assert.equal(reasons.get("service.py"), "unsupported-language");
  assert.equal(reasons.get("vendor/library.ts"), "excluded-directory");
  assert.equal(reasons.get("removed.ts"), "unreadable");
  assert.equal(reasons.get("alias.ts"), "symlink");
  assert.equal(reasons.get("linked/hidden.ts"), "symlink");
  assert.equal(coverage.parsedSources, 1);
  assert.ok(!JSON.stringify(coverage).includes(outside));
  assert.ok(!JSON.stringify(coverage).includes("DO_NOT_READ"));
});

test("repeated analysis refreshes changed imports, deletions and path configuration", async (t) => {
  const root = await repository(t);
  await put(root, "src/one.ts", "export const one = 1;");
  await put(root, "src/two.ts", "export const two = 2;");
  await put(root, "src/page.tsx", "import { one } from './one'; export const page = one;");
  track(root);
  const initial = await buildReverseImportIndex(root);
  const warm = await buildReverseImportIndex(root);
  assert.equal(initial.coverage.fingerprint, warm.coverage.fingerprint);

  await put(root, "src/page.tsx", "import { two } from './two'; export const page = two;");
  const changed = await buildReverseImportIndex(root);
  assert.notEqual(changed.coverage.fingerprint, initial.coverage.fingerprint);
  assert.ok(!changed.importersOf.has("src/one.ts"));
  assert.deepEqual([...changed.importersOf.get("src/two.ts")], ["src/page.tsx"]);

  await put(root, "tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@value": ["src/one"] } } }));
  await put(root, "src/page.tsx", "import { one } from '@value'; export const page = one;");
  const aliased = await buildReverseImportIndex(root);
  assert.ok(aliased.importersOf.has("src/one.ts"));
  await put(root, "tsconfig.json", JSON.stringify({ compilerOptions: { paths: { "@value": ["src/two"] } } }));
  const remapped = await buildReverseImportIndex(root);
  assert.notEqual(remapped.coverage.fingerprint, aliased.coverage.fingerprint);
  assert.ok(remapped.importersOf.has("src/two.ts"));
  await rm(path.join(root, "src/page.tsx"));
  const removed = await buildReverseImportIndex(root);
  assert.equal(removed.importersOf.size, 0);
});

test("fallback discovery names its filesystem scope and never follows nested repositories", async (t) => {
  const root = await repository(t, false);
  await put(root, "src/a.ts", "export const a = 1;");
  await put(root, "src/b.ts", "import { a } from './a'; export const b = a;");
  await put(root, "nested/.git", "gitdir: elsewhere");
  await put(root, "nested/source.ts", "export const ignored = 1;");
  const index = await buildReverseImportIndex(root);
  assert.equal(index.coverage.discovery, "filesystem");
  assert.equal(index.coverage.inventoryComplete, true);
  assert.equal(index.coverage.parsedSources, 2);
  assert.ok(index.coverage.skipped.some((entry) => entry.path === "nested" && entry.reason === "nested-repository"));
  assert.equal(await readFile(path.join(root, "nested/.git"), "utf8"), "gitdir: elsewhere");
});

test("a failed Git inventory stays unavailable instead of scanning ignored files", async (t) => {
  const root = await repository(t);
  await put(root, ".gitignore", "private/\n");
  await put(root, "src/value.ts", "export const value = 1;");
  track(root);
  await put(root, "private/secret.ts", "export const DO_NOT_READ = 1;");
  await put(root, ".git/index", "invalid index");
  const { coverage } = await buildReverseImportIndex(root);
  assert.equal(coverage.discovery, "unavailable");
  assert.equal(coverage.inventoryComplete, false);
  assert.equal(coverage.inventoryFiles, 0);
  assert.equal(coverage.parsedSources, 0);
  assert.ok(!JSON.stringify(coverage).includes("DO_NOT_READ"));
});

test("missing Git cannot broaden a repository scan past ignore rules", async (t) => {
  const root = await repository(t);
  const emptyPath = await repository(t, false);
  await put(root, ".gitignore", "private/\n");
  track(root);
  await put(root, "private/secret.ts", "export const secret = 1;");
  const moduleUrl = new URL("../dist/import-graph.js", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { buildReverseImportIndex } from ${JSON.stringify(moduleUrl)};
    const { coverage } = await buildReverseImportIndex(process.cwd());
    console.log(JSON.stringify(coverage));
  `], { cwd: root, env: { ...process.env, PATH: emptyPath }, encoding: "utf8" });
  const coverage = JSON.parse(output);
  assert.equal(coverage.discovery, "unavailable");
  assert.equal(coverage.inventoryComplete, false);
  assert.equal(coverage.parsedSources, 0);
  assert.ok(!output.includes("secret"));
});

test("package capacity and unreadable alias configuration stay visible", async (t) => {
  const root = await repository(t);
  const outside = await repository(t, false);
  for (let index = 0; index < 201; index++) {
    await put(root, `packages/p${String(index).padStart(3, "0")}/package.json`,
      JSON.stringify({ name: `package-${index}` }));
  }
  await put(root, "src/value.ts", "export const value = 1;");
  await put(outside, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "/external" } }));
  await symlink(path.join(outside, "tsconfig.json"), path.join(root, "tsconfig.json"));
  const { coverage } = await buildReverseImportIndex(root);
  assert.equal(coverage.parsedSources, 1);
  assert.ok(coverage.skipped.some((entry) => entry.path === "packages/p200/package.json" && entry.reason === "package-limit"));
  assert.ok(coverage.skipped.some((entry) => entry.path === "tsconfig.json" && entry.reason === "symlink"));
  assert.ok(!JSON.stringify(coverage).includes("/external"));
});

test("source capacity is reported for every omitted tracked source", async (t) => {
  const root = await repository(t);
  for (let index = 0; index < 12002; index++) {
    await put(root, `src/file-${String(index).padStart(5, "0")}.ts`, "export const value = 1;");
  }
  track(root);
  const { coverage } = await buildReverseImportIndex(root);
  assert.equal(coverage.inventoryFiles, 12002);
  assert.equal(coverage.parsedSources, 12000);
  assert.deepEqual(coverage.skipped, [
    { path: "src/file-12000.ts", reason: "source-limit" },
    { path: "src/file-12001.ts", reason: "source-limit" },
  ]);
});

test("QA exposes scoped discovery without changing static execution or compact payload budgets", async (t) => {
  const root = await repository(t);
  await put(root, "package.json", JSON.stringify({ name: "example", scripts: { test: "node --test" } }));
  await put(root, "src/value.ts", "export const value = 1;");
  track(root);
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "initial"], { cwd: root });
  execFileSync("git", ["branch", "-M", "main"], { cwd: root });
  await put(root, "src/value.ts", "export const value = 2;");
  const result = await generateQaDraft(root, { base: "main", head: "HEAD", includeWorkingTree: true });
  assert.equal(result.importDiscovery.scope, "import-graph");
  assert.equal(result.importDiscovery.parsedSources, 1);
  assert.equal(result.execution.status, "not-run");
  assert.equal(result.execution.performed, false);
  const markdown = formatMarkdownQaDraft(result);
  assert.match(markdown, /working-tree import graph only/);
  assert.match(markdown, /not full semantic coverage/);
  assert.ok(Buffer.byteLength(formatAgentQaDraft(result)) <= 4096);
});
