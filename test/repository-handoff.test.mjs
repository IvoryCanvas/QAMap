import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatAgentQaDraft, formatAgentQaFullReport, generateQaDraft } from "../dist/qa.js";
import { collectSchemaViolations } from "./helpers/schema-validation.mjs";

const schema = JSON.parse(await readFile(new URL("../schema/qamap-agent.schema.json", import.meta.url), "utf8"));

test("mixed maintenance and product edits retain evidence in 4KB and recover the complete analysis", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-repository-handoff-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  execFileSync("git", ["init", "-q"], { cwd: root });
  await put("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  await put("src/value.ts", "export function format(value: string) { return value; }");
  await put("src/route.ts", "import { format } from './value';\nexport function showItem(value: string) { return format(value); }\nrouter.get('/items', showItem);\nconst optional = import(runtimePath());");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "initial fixture"], { cwd: root });
  for (let i = 0; i < 10; i++) await put(`docs/a-${i}.md`, `# Notes ${i}\nSupporting maintenance notes.\n`);
  await put("src/value.ts", "export function format(value: string) { return value.trim(); }");
  await put("tests/value.test.ts", [
    "import { showItem } from '../src/route';",
    ...Array.from({ length: 9 }, (_, i) => `test('preserves case ${i}', () => { expect(showItem(' value ')).toBe('value'); });`),
  ].join("\n"));
  const result = await generateQaDraft(root, { base: "HEAD", head: "HEAD", includeWorkingTree: true });
  const fullReportPath = path.join(root, "not-written-by-formatter.json");
  const text = formatAgentQaDraft(result, { fullReportPath });
  const compact = JSON.parse(text);
  const full = JSON.parse(formatAgentQaFullReport(result));
  assert.deepEqual(collectSchemaViolations(schema, compact), []);
  assert.ok(Buffer.byteLength(text) <= 4096, Buffer.byteLength(text));
  assert.equal(compact.execution.status, "not-run");
  assert.equal(compact.execution.performed, false);
  assert.deepEqual(compact.action, result.action);
  assert.equal(compact.route.command, result.route.command);
  assert.deepEqual(compact.currentDelta.files.slice(0, 2), ["src/value.ts", "tests/value.test.ts"]);
  assert.equal(compact.repository.fingerprint, result.repositoryIndex.coverage.fingerprint);
  assert.equal(compact.repository.path.changed.file, "src/value.ts");
  assert.equal(compact.repository.path.contract.file, "tests/value.test.ts");
  assert.ok(compact.repository.unresolved.some((gap) => gap.file === "src/route.ts" && gap.reason === "runtime-module-loading"));
  assert.equal(compact.compaction.fullReport, fullReportPath);
  assert.equal(full.currentDelta.files.length, 12);
  assert.deepEqual(full.evidence.currentDelta.files, result.currentDelta.files);
  assert.equal(full.testContracts.items.length, 9);
  assert.equal(full.testContracts.omittedItemCount, 0);
  assert.deepEqual(full.repositoryIndex, result.repositoryIndex);
  assert.deepEqual(full.repositoryImpact, result.repositoryImpact);
  assert.deepEqual(full.evidence.traces, result.traces);
  assert.deepEqual(full.evidence.changeAnalysis, JSON.parse(JSON.stringify(result.changeAnalysis)));
  assert.deepEqual(full.evidence.flows, JSON.parse(JSON.stringify(result.flows)));

  for (const length of [95, 246, 1200]) {
    const scoped = structuredClone(result);
    scoped.analysisScope = { ...scoped.analysisScope, mode: "explicit-package", commandCwd: "selected-package", selectedPath: `packages/${"component-".repeat(Math.ceil(length / 10))}` };
    scoped.route = { basis: "repository-validation", status: "verification-ready-to-run", nextAction: "run-repository-command", command: "npm test -- test/value.test.mjs" };
    const text = formatAgentQaDraft(scoped, { fullReportPath: `${root}/${"\u0001".repeat(length)}.json` });
    const bounded = JSON.parse(text);
    assert.ok(Buffer.byteLength(text) <= 4096, `${length}: ${Buffer.byteLength(text)}`);
    assert.deepEqual(collectSchemaViolations(schema, bounded), []);
    if (bounded.recoveryRequired) {
      assert.equal(bounded.action, undefined);
      assert.equal(bounded.route, undefined);
      assert.deepEqual(bounded.commands, []);
    } else {
      assert.equal(bounded.analysisScope.selectedPath, scoped.analysisScope.selectedPath);
      assert.equal(bounded.analysisScope.commandCwd, "selected-package");
      assert.equal(bounded.route.command, scoped.route.command);
    }
  }
});
