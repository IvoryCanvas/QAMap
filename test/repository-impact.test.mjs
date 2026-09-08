import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRepositoryEvidenceIndex } from "../dist/repository-index.js";
import { createRepositoryModuleResolver, traceRepositoryImpact } from "../dist/repository-impact.js";

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "qamap-symbol-impact-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  await mkdir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const put = async (file, content) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
  };
  await put("packages/labels/package.json", { name: "@sample/labels", exports: { ".": "./src/index.ts" } });
  await put("packages/labels/src/format.ts", "export function format(value: string) { return value.trim(); }\nexport const unrelated = true;");
  await put("packages/labels/src/index.ts", "export { format as displayLabel } from './format';");
  await put("apps/web/service.ts", "import { displayLabel as label } from '@sample/labels';\nexport function loadLabel(value: string) { return label(value); }");
  await put("apps/web/route.ts", "import { loadLabel as load } from './service';\nexport function showItem(value: string) { return load(value); }\nrouter.get('/items', showItem);");
  await put("apps/web/unused.ts", "import { displayLabel as label } from '@sample/labels';\nexport function unrelated(label: string) { return label; }");
  await put("apps/web/tests/route.test.ts", "import { showItem } from '../route';\ntest('shows item', () => { expect(showItem(' value ')).toBe('value'); });");
  return { root, put, cacheDirectory: path.join(temp, "cache") };
}

test("named reexports and package declarations preserve symbol evidence to route and test references", async (t) => {
  const { root, cacheDirectory, put } = await fixture(t);
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  const changes = [{ file: "packages/labels/src/format.ts", lines: [1] }];
  const impact = traceRepositoryImpact(index, changes);
  assert.equal(impact.status, "draft");
  assert.equal(impact.execution, "not-run");
  assert.ok(impact.paths.some((entry) => entry.endpoint === "registration-candidate"));
  const testPath = impact.paths.find((entry) => entry.endpoint === "test-reference");
  assert.ok(testPath);
  assert.deepEqual([...new Set(testPath.evidence.map((step) => step.file))], [
    "packages/labels/src/format.ts", "packages/labels/src/index.ts", "apps/web/service.ts", "apps/web/route.ts", "apps/web/tests/route.test.ts",
  ]);
  assert.ok(testPath.evidence.some((step) => step.relation === "reexport" && step.symbol === "displayLabel"));
  assert.ok(testPath.evidence.some((step) => step.relation === "import" && step.symbol === "label"));
  assert.ok(!JSON.stringify(impact.paths).includes("unused.ts"));
  assert.ok(!impact.paths.some((entry) => entry.changedSymbol === "unrelated"));
  await put("packages/labels/src/format.ts", "export function format(value: string) { return value.toUpperCase(); }\nexport const unrelated = true;");
  const edited = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
  assert.equal(edited.reuse.rebuiltFiles, 1);
  assert.ok(edited.reuse.affectedFiles.includes("apps/web/tests/route.test.ts"));
  assert.deepEqual(traceRepositoryImpact(edited, changes), impact);
});

test("namespace members do not pull an unrelated export into a test", async (t) => {
  const { root, put } = await fixture(t);
  await put("packages/labels/src/index.ts", "export * from './format';");
  await put("apps/web/tests/namespace.test.ts", "import * as labels from '@sample/labels';\ntest('label', () => expect(labels.format('x')).toBe('x'));\ntest('flag', () => expect(labels.unrelated).toBe(true));");
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  const impact = traceRepositoryImpact(index, [{ file: "packages/labels/src/format.ts", lines: [1] }]);
  const reached = impact.paths.filter((entry) => entry.evidence.at(-1).file.endsWith("namespace.test.ts"));
  assert.equal(reached.length, 1);
  assert.equal(reached[0].evidence.at(-1).line, 2);
});

test("deep star-export origin searches stop before exhausting the process stack", async (t) => {
  const { root, put } = await fixture(t);
  await put("packages/labels/src/index.ts", "export * from './format';\nexport * from './chain-0';");
  await put("apps/web/service.ts", "import { format as label } from '@sample/labels';\nexport function loadLabel(value: string) { return label(value); }");
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  const chained = (count) => ({ ...index, blocks: [...index.blocks, ...Array.from({ length: count }, (_, i) => ({
    file: `packages/labels/src/chain-${i}.ts`, hash: "0".repeat(64), kind: "source",
    declarations: [], imports: [], references: [], routes: [], tests: [], contracts: [], validation: [], modules: [], gaps: [],
    exports: i + 1 < count ? [{ local: "*", exported: "*", module: `./chain-${i + 1}`, line: 1 }] : [],
  }))] });
  const changes = [{ file: "packages/labels/src/format.ts", lines: [1] }];
  assert.ok(traceRepositoryImpact(chained(32), changes).paths.length > 0);
  const bounded = traceRepositoryImpact(chained(3000), changes);
  assert.equal(bounded.execution, "not-run");
  assert.equal(bounded.paths.length, 0);
  assert.ok(bounded.boundaries.some((entry) => entry.reason === "export-origin-depth-limit"));
});

test("bounded paths retain cross-file product evidence ahead of test helper references", async (t) => {
  const { root, put } = await fixture(t);
  await put("apps/web/tests/helpers.test.ts", "const helper = () => 1;\n" + Array.from({ length: 20 }, (_, i) => `test('helper ${i}', () => expect(helper()).toBe(1));`).join("\n"));
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  const changes = [{ file: "apps/web/tests/helpers.test.ts" }, { file: "packages/labels/src/format.ts", lines: [1] }];
  const impact = traceRepositoryImpact(index, changes, { maxPaths: 2 });
  assert.equal(impact.paths.length, 2);
  assert.ok(impact.paths.every((entry) => entry.changedFile === "packages/labels/src/format.ts"));
  assert.equal(impact.paths[0].endpoint, "test-reference");
  assert.equal(impact.omittedPaths, 20);
  assert.ok(impact.boundaries.some((entry) => entry.file.endsWith("helpers.test.ts") && entry.reason === "path-count-limit"));
  assert.deepEqual(traceRepositoryImpact(index, changes.toReversed(), { maxPaths: 2 }), impact);
});

test("ambiguous package conditions stop instead of choosing an unproven target", async (t) => {
  const { root, put } = await fixture(t);
  await put("packages/labels/package.json", { name: "@sample/labels", exports: { ".": { import: "./src/index.ts", default: "./src/other.ts" } } });
  await put("packages/labels/src/other.ts", "export const displayLabel = () => 'other';");
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  const resolution = createRepositoryModuleResolver(index.blocks)("apps/web/service.ts", "@sample/labels");
  assert.equal(resolution.reason, "ambiguous-package-export");
  const impact = traceRepositoryImpact(index, [{ file: "packages/labels/src/format.ts" }]);
  assert.equal(impact.paths.length, 0);
  assert.ok(impact.boundaries.some((entry) => entry.file === "apps/web/service.ts" && entry.reason === "ambiguous-package-export"));
  assert.ok(impact.boundaries.some((entry) => entry.reason === "no-observable-contract-path"));
});

test("aliases use exact names or declared wildcards and package wildcard subpaths", async (t) => {
  const { root, put } = await fixture(t);
  await put("tsconfig.json", { compilerOptions: { paths: { "@app/*": ["apps/web/*"], "@exact": ["apps/web/route.ts"] } } });
  await put("packages/labels/package.json", { name: "@sample/labels", exports: { "./*": "./src/*.ts" } });
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  const resolve = createRepositoryModuleResolver(index.blocks);
  assert.deepEqual(resolve("apps/web/example.ts", "@app/service").candidates, ["apps/web/service.ts"]);
  assert.deepEqual(resolve("apps/web/example.ts", "@exact").candidates, ["apps/web/route.ts"]);
  assert.equal(resolve("apps/web/example.ts", "@exactExtra").candidates.length, 0);
  assert.deepEqual(resolve("apps/web/example.ts", "@sample/labels/format").candidates, ["packages/labels/src/format.ts"]);
});

test("cycles terminate and dynamic loading or traversal limits preserve explicit boundaries", async (t) => {
  const { root, put } = await fixture(t);
  await put("packages/labels/src/cycle.ts", "export * from './index';");
  await put("packages/labels/src/index.ts", "export { format as displayLabel } from './format';\nexport * from './cycle';");
  await put("apps/web/service.ts", "import { displayLabel as label } from '@sample/labels';\nexport function loadLabel(value: string) { return label(value); }\nconst optional = import(runtimePath());");
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  const full = traceRepositoryImpact(index, [{ file: "packages/labels/src/format.ts", lines: [1] }]);
  assert.ok(full.paths.length > 0);
  assert.ok(full.visitedStates < 100);
  assert.ok(full.boundaries.some((entry) => entry.file === "apps/web/service.ts" && entry.reason === "runtime-module-loading"));
  const limited = traceRepositoryImpact(index, [{ file: "packages/labels/src/format.ts" }], { maxStates: 2 });
  assert.ok(limited.boundaries.some((entry) => entry.reason === "state-limit"));
  const short = traceRepositoryImpact(index, [{ file: "packages/labels/src/format.ts" }], { maxPathSteps: 2 });
  assert.ok(short.boundaries.some((entry) => entry.reason === "path-step-limit"));
  assert.deepEqual(traceRepositoryImpact(index, [{ file: "packages/labels/src/format.ts", lines: [1] }]), full);
});

test("unindexed runtime alternatives do not turn type declarations into a unique package target", async (t) => {
  const { root, put } = await fixture(t);
  await put("packages/labels/package.json", { name: "@sample/labels", exports: { ".": { types: "./src/index.ts", import: "./dist/index.js" } } });
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  assert.equal(createRepositoryModuleResolver(index.blocks)("apps/web/service.ts", "@sample/labels").reason, "conditional-package-export");
  const impact = traceRepositoryImpact(index, [{ file: "packages/labels/src/format.ts" }]);
  assert.equal(impact.paths.length, 0);
  assert.ok(impact.boundaries.some((entry) => entry.file === "apps/web/service.ts" && entry.reason === "conditional-package-export"));
});

test("module extensions and co-located configs never select an incompatible source", async (t) => {
  const { root, put } = await fixture(t);
  await put("src/value.ts", "export const value = 1;");
  await put("src/nested/index.ts", "export const nested = 1;");
  await put("src/module.mts", "export const module = 1;");
  await put("src/common.cts", "export const common = 1;");
  await put("tsconfig.json", { compilerOptions: { paths: { "@value": ["src/value.ts"] } } });
  await put("jsconfig.json", { compilerOptions: { paths: { "@value": ["src/nested/index.ts"] } } });
  const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  const resolve = createRepositoryModuleResolver(index.blocks);
  for (const module of ["./value.mjs", "./value.cjs", "./nested.js"]) assert.equal(resolve("src/use.ts", module).candidates.length, 0);
  assert.deepEqual(resolve("src/use.ts", "./value.js").candidates, ["src/value.ts"]);
  assert.deepEqual(resolve("src/use.ts", "./module.mjs").candidates, ["src/module.mts"]);
  assert.deepEqual(resolve("src/use.ts", "./common.cjs").candidates, ["src/common.cts"]);
  assert.equal(resolve("src/use.ts", "@value").reason, "ambiguous-compiler-config");
});

test("star exports omit default exports and stop at conflicting named origins", async (t) => {
  const { root, put } = await fixture(t);
  await put("src/a.ts", "export default function primary() { return 1; }\nexport const value = 1;");
  await put("src/b.ts", "export const value = 2;");
  await put("src/index.ts", "export * from './a';\nexport * from './b';");
  await put("tests/star.test.ts", "import primary, { value } from '../src/index';\ntest('value', () => expect(value).toBe(1));\ntest('default', () => expect(primary()).toBe(1));");
  let index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  const impact = traceRepositoryImpact(index, [{ file: "src/a.ts" }]);
  assert.equal(impact.paths.length, 0);
  assert.ok(impact.boundaries.some((entry) => entry.reason === "ambiguous-star-export" && entry.symbol === "value"));
  await put("src/index.ts", "export * from './a';\nexport * from './b';\nexport { value } from './a';");
  index = await buildRepositoryEvidenceIndex(root, { cacheDirectory: false });
  const explicit = traceRepositoryImpact(index, [{ file: "src/a.ts" }]);
  assert.equal(explicit.paths.length, 1);
  assert.equal(explicit.paths[0].changedSymbol, "value");
});
