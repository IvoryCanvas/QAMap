#!/usr/bin/env node

import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const fields = ["declarations", "imports", "exports", "references", "tests", "routes", "contracts", "validation"];
const fact = (file, field, value) => JSON.stringify([file, field, value]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const impactIdentity = (changedFile, changedSymbol, endpoint, file, line, symbol) => JSON.stringify([changedFile, changedSymbol, endpoint, file, line, symbol]);
export const requiredPhases = ["cold", "warm", "one-file-edit", "one-package-file-edit"];
export const requiredQualityCases = ["relative-import-and-alias", "workspace-package-resolution", "compiler-path-alias-resolution",
  "conditional-package-exports", "dynamic-module-boundary", "unresolved-module-boundary", "mixed-maintenance-coverage"];
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

export function summarizeBenchmark(scenarios, qualityScenarios) {
  const phaseChecks = requiredPhases.map((id) => ({ id, passed: scenarios.filter((entry) => entry.id === id).length === 1
    && scenarios.find((entry) => entry.id === id).passed === true }));
  const qualityChecks = requiredQualityCases.map((id) => {
    const matches = qualityScenarios.filter((entry) => entry.id === id);
    return { id, status: matches.length === 0 ? "not-run" : matches.length > 1 ? "failed" : matches[0].status };
  });
  const qualityComplete = qualityChecks.every((entry) => entry.status === "passed");
  return {
    passed: phaseChecks.every((entry) => entry.passed) && qualityComplete,
    qualityComplete,
    checks: phaseChecks.length + qualityChecks.length,
    passedChecks: phaseChecks.filter((entry) => entry.passed).length + qualityChecks.filter((entry) => entry.status === "passed").length,
    qualityCoverage: {
      expected: qualityChecks.length,
      passed: qualityChecks.filter((entry) => entry.status === "passed").length,
      notRun: qualityChecks.filter((entry) => entry.status === "not-run").map((entry) => entry.id),
      failed: qualityChecks.filter((entry) => entry.status !== "passed" && entry.status !== "not-run").map((entry) => entry.id),
    },
    failedPhases: phaseChecks.filter((entry) => !entry.passed).map((entry) => entry.id),
  };
}

export function measureSerializedPayload(index, impacts) {
  const blocks = index.blocks.map((block) => ({ file: block.file, kind: block.kind, bytes: jsonBytes(block) }));
  const byKind = {};
  for (const block of blocks) {
    const entry = byKind[block.kind] ?? (byKind[block.kind] = { blocks: 0, bytes: 0 });
    entry.blocks++;
    entry.bytes += block.bytes;
  }
  return {
    encoding: "utf8", format: "compact-json",
    blocksJsonBytes: jsonBytes(index.blocks),
    individualBlockJsonBytes: blocks.reduce((total, block) => total + block.bytes, 0),
    maxBlockJsonBytes: Math.max(0, ...blocks.map((block) => block.bytes)),
    blocksByKind: byKind,
    impactArrayJsonBytes: jsonBytes(impacts),
    recoveryIndexJsonBytes: jsonBytes(index),
    fullCliPayloadBytes: null,
  };
}

export function scoreImpactPaths(expected, impact) {
  return scoreEvidence(expected, impact.paths.map((entry) => {
    const last = entry.evidence.at(-1);
    return impactIdentity(entry.changedFile, entry.changedSymbol, entry.endpoint, last?.file, last?.line, last?.symbol);
  }));
}

export function scoreEvidence(expected, actual) {
  const truth = new Set(expected);
  const observed = new Set(actual);
  const missing = [...truth].filter((value) => !observed.has(value)).sort();
  const unexpected = [...observed].filter((value) => !truth.has(value)).sort();
  const truePositives = truth.size - missing.length;
  return {
    expected: truth.size, observed: observed.size, truePositives,
    falsePositives: unexpected.length, falseNegatives: missing.length,
    precision: observed.size ? truePositives / observed.size : 0,
    recall: truth.size ? truePositives / truth.size : 0,
    missing, unexpected,
  };
}

export function qualityGate(baseline, indexed, complete) {
  return complete === true && indexed.expected > 0 && indexed.precision === 1 && indexed.recall === 1
    && indexed.precision >= baseline.precision && indexed.recall >= baseline.recall;
}

function projectEvidence(blocks) {
  const result = [];
  for (const block of blocks) {
    for (const field of fields) {
      if (!Array.isArray(block[field])) throw new Error(`Index block.${field} must be an array`);
      for (const entry of block[field]) {
        let value;
        if (field === "declarations") value = [entry.name, entry.kind, entry.line];
        if (field === "imports") value = [entry.module, entry.imported, entry.local, entry.line];
        if (field === "exports") value = [entry.local, entry.exported, entry.line];
        if (field === "references") value = [entry.name, entry.owner, entry.line];
        if (field === "tests" || field === "routes") value = [entry.kind, entry.line];
        if (field === "contracts") value = [entry.pointer, entry.kind];
        if (field === "validation") value = [entry.name, entry.hash];
        result.push(fact(block.file, field, value));
      }
    }
  }
  return result;
}

async function materializeFixture(root, fileCount) {
  const contents = new Map();
  const expected = [];
  const add = (file, field, value) => expected.push(fact(file, field, value));
  for (let i = 0; i < fileCount; i++) {
    const file = `src/module-${String(i).padStart(5, "0")}.ts`;
    const name = `value${i}`;
    contents.set(file, `export function ${name}() { return ${i}; }\n`);
    add(file, "declarations", [name, "function", 1]);
    add(file, "exports", [name, name, 1]);
  }
  contents.set("src/consumer.ts", "import { value0 as selectedValue } from './module-00000';\nexport function consume() { return selectedValue(); }\n");
  add("src/consumer.ts", "imports", ["./module-00000", "value0", "selectedValue", 1]);
  add("src/consumer.ts", "declarations", ["consume", "function", 2]);
  add("src/consumer.ts", "exports", ["consume", "consume", 2]);
  add("src/consumer.ts", "references", ["selectedValue", "consume", 2]);
  contents.set("src/routes.ts", "import { consume } from './consumer';\nrouter.get('/values', consume);\n");
  add("src/routes.ts", "imports", ["./consumer", "consume", "consume", 1]);
  add("src/routes.ts", "references", ["consume", "<module>", 2]);
  add("src/routes.ts", "routes", ["registration-candidate:get", 2]);
  contents.set("test/values.test.ts", "import { consume } from '../src/consumer';\ntest('returns a value', () => { expect(consume()).toBe(0); });\n");
  add("test/values.test.ts", "imports", ["../src/consumer", "consume", "consume", 1]);
  add("test/values.test.ts", "references", ["consume", "<module>", 2]);
  add("test/values.test.ts", "tests", ["test-declaration", 2]);
  add("test/values.test.ts", "tests", ["assertion", 2]);
  contents.set("package.json", JSON.stringify({ name: "repository-index-fixture", private: true, main: "./src/consumer.ts", scripts: { test: "node --test" } }) + "\n");
  add("package.json", "validation", ["test", digest("node --test")]);
  contents.set("openapi.json", JSON.stringify({ openapi: "3.0.3", info: { title: "Generic fixture", version: "1" }, paths: { "/values": { get: { responses: { "200": { description: "Values" } } } } } }) + "\n");
  add("openapi.json", "contracts", ["/paths/~1values/get", "operation"]);
  add("openapi.json", "contracts", ["/paths/~1values/get/responses/200", "response"]);
  contents.set("packages/value/package.json", JSON.stringify({ name: "@fixture/value", exports: { ".": "./src/index.ts" } }) + "\n");
  contents.set("packages/value/src/value.ts", "export function normalize(value: string) { return value.trim(); }\n");
  add("packages/value/src/value.ts", "declarations", ["normalize", "function", 1]);
  add("packages/value/src/value.ts", "exports", ["normalize", "normalize", 1]);
  contents.set("packages/value/src/index.ts", "export { normalize as formatLabel } from './value';\n");
  add("packages/value/src/index.ts", "exports", ["normalize", "formatLabel", 1]);
  contents.set("apps/web/service.ts", "import { formatLabel as label } from '@fixture/value';\nexport function render(value: string) { return label(value); }\n");
  add("apps/web/service.ts", "imports", ["@fixture/value", "formatLabel", "label", 1]);
  add("apps/web/service.ts", "declarations", ["render", "function", 2]);
  add("apps/web/service.ts", "exports", ["render", "render", 2]);
  add("apps/web/service.ts", "references", ["label", "render", 2]);
  contents.set("apps/web/routes.ts", "import { render as handle } from './service';\nrouter.get('/labels', handle);\n");
  add("apps/web/routes.ts", "imports", ["./service", "render", "handle", 1]);
  add("apps/web/routes.ts", "references", ["handle", "<module>", 2]);
  add("apps/web/routes.ts", "routes", ["registration-candidate:get", 2]);
  contents.set("apps/web/labels.test.ts", "import { render as run } from './service';\ntest('normalizes a label', () => { expect(run(' value ')).toBe('value'); });\n");
  add("apps/web/labels.test.ts", "imports", ["./service", "render", "run", 1]);
  add("apps/web/labels.test.ts", "references", ["run", "<module>", 2]);
  add("apps/web/labels.test.ts", "tests", ["test-declaration", 2]);
  add("apps/web/labels.test.ts", "tests", ["assertion", 2]);
  contents.set("apps/web/unused.test.ts", "import { formatLabel as ignored } from '@fixture/value';\ntest('independent check', () => { expect(true).toBe(true); });\n");
  add("apps/web/unused.test.ts", "imports", ["@fixture/value", "formatLabel", "ignored", 1]);
  add("apps/web/unused.test.ts", "tests", ["test-declaration", 2]);
  add("apps/web/unused.test.ts", "tests", ["assertion", 2]);
  for (const [file, content] of contents) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  // Git inventory includes untracked paths; the benchmark never creates commits.
  await promisify(childProcess.execFile)("git", ["init", "-b", "main"], { cwd: root });
  return { contents, expected, impactCases: [
    {
      id: "relative-import-and-alias", changedFile: "src/module-00000.ts", changedSymbol: "value0",
      affected: ["src/consumer.ts", "src/routes.ts", "test/values.test.ts"],
      expected: [impactIdentity("src/module-00000.ts", "value0", "registration-candidate", "src/routes.ts", 2, "consume"),
        impactIdentity("src/module-00000.ts", "value0", "test-reference", "test/values.test.ts", 2, "consume")],
    },
    {
      id: "workspace-package-resolution", changedFile: "packages/value/src/value.ts", changedSymbol: "normalize",
      affected: ["packages/value/src/index.ts", "apps/web/service.ts", "apps/web/routes.ts", "apps/web/labels.test.ts", "apps/web/unused.test.ts"],
      expected: [impactIdentity("packages/value/src/value.ts", "normalize", "registration-candidate", "apps/web/routes.ts", 2, "handle"),
        impactIdentity("packages/value/src/value.ts", "normalize", "test-reference", "apps/web/labels.test.ts", 2, "run")],
    },
  ] };
}

// A deliberately specified generic baseline, not a claim about every agent:
// four exhaustive scans, using small lexical recognizers over this public fixture grammar.
async function genericDiscovery(root) {
  const result = [];
  for (const lane of ["symbols", "dependencies", "tests", "configuration"]) {
    const { stdout } = await promisify(childProcess.execFile)("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    for (const file of stdout.split("\0").filter(Boolean).sort()) {
      const text = await fs.readFile(path.join(root, file), "utf8");
      const lines = text.split("\n");
      const add = (field, value) => result.push(fact(file, field, value));
      if (lane === "symbols") {
        lines.forEach((line, i) => {
          const match = /^export (function|const) (\w+)/.exec(line);
          if (!match) return;
          add("declarations", [match[2], match[1] === "function" ? "function" : "variable", i + 1]);
          add("exports", [match[2], match[2], i + 1]);
        });
      } else if (lane === "dependencies") {
        const bindings = [];
        lines.forEach((line, i) => {
          const match = /^import \{ (\w+)(?: as (\w+))? \} from '([^']+)'/.exec(line);
          const reexport = /^export \{ (\w+)(?: as (\w+))? \} from '([^']+)'/.exec(line);
          if (reexport) { add("exports", [reexport[1], reexport[2] ?? reexport[1], i + 1]); return; }
          if (match) {
            const local = match[2] ?? match[1];
            bindings.push(local);
            add("imports", [match[3], match[1], local, i + 1]);
          } else {
            const owner = /^export function (\w+)/.exec(line)?.[1] ?? "<module>";
            for (const name of bindings) if (new RegExp(`\\b${name}\\b`).test(line)) add("references", [name, owner, i + 1]);
          }
        });
      } else if (lane === "tests") {
        lines.forEach((line, i) => {
          if (/^test\(/.test(line)) add("tests", ["test-declaration", i + 1]);
          if (/\bexpect\(/.test(line)) add("tests", ["assertion", i + 1]);
          if (/^router\.get\(/.test(line)) add("routes", ["registration-candidate:get", i + 1]);
        });
      } else if (file.endsWith(".json")) {
        const value = JSON.parse(text);
        if (file === "package.json") for (const [name, command] of Object.entries(value.scripts ?? {})) add("validation", [name, digest(command)]);
        if (value.openapi && value.paths) for (const [endpoint, methods] of Object.entries(value.paths)) {
          for (const [method, operation] of Object.entries(methods)) {
            const pointer = `/paths/${endpoint.replace(/~/g, "~0").replace(/\//g, "~1")}/${method}`;
            add("contracts", [pointer, "operation"]);
            for (const status of Object.keys(operation.responses ?? {})) add("contracts", [`${pointer}/responses/${status}`, "response"]);
          }
        }
      }
    }
  }
  return result;
}

async function runQualityControls(temporary, { buildRepositoryEvidenceIndex, traceRepositoryImpact, createRepositoryModuleResolver }) {
  const baseFiles = {
    "src/value.ts": "export function value() { return 1; }\n",
    "src/service.ts": "import { value } from './value';\nexport function consume() { return value(); }\n",
    "tests/value.test.ts": "import { consume } from '../src/service';\ntest('value', () => expect(consume()).toBe(1));\n",
  };
  const expectedPath = impactIdentity("src/value.ts", "value", "test-reference", "tests/value.test.ts", 2, "consume");
  const definitions = [
    {
      id: "compiler-path-alias-resolution",
      files: { ...baseFiles,
        "tsconfig.json": { compilerOptions: { paths: { "@core/*": ["src/*"], "@exact": ["src/value.ts"] } } },
        "src/service.ts": "import { value } from '@core/value';\nexport function consume() { return value(); }\n",
        "tests/direct.test.ts": "import { value as direct } from '@exact';\ntest('direct', () => expect(direct()).toBe(1));\n",
      },
      paths: [expectedPath, impactIdentity("src/value.ts", "value", "test-reference", "tests/direct.test.ts", 2, "direct")],
      complete: true, indexedFiles: 5, skipped: [], boundaries: [],
      resolutions: [
        { module: "@core/value", candidates: ["src/value.ts"] },
        { module: "@exact", candidates: ["src/value.ts"] },
        { module: "@exactExtra", candidates: [], reason: "external-or-unresolved-package" },
      ],
    },
    {
      id: "conditional-package-exports",
      files: {
        "packages/value/package.json": { name: "@fixture/value", exports: { ".": { import: "./src/first.ts", default: "./src/second.ts" } } },
        "packages/value/src/first.ts": "export function value() { return 1; }\n",
        "packages/value/src/second.ts": "export function value() { return 2; }\n",
        "src/service.ts": "import { value } from '@fixture/value';\nexport function consume() { return value(); }\n",
        "tests/value.test.ts": baseFiles["tests/value.test.ts"],
      },
      changes: [{ file: "packages/value/src/first.ts", lines: [1] }],
      paths: [], complete: false, indexedFiles: 5,
      skipped: [{ path: "packages/value/package.json:1", reason: "conditional-package-exports" }],
      boundaries: [
        { file: "packages/value/src/first.ts", reason: "no-observable-contract-path" },
        { file: "src/service.ts", reason: "ambiguous-package-export" },
      ],
      resolutions: [{ module: "@fixture/value", candidates: ["packages/value/src/first.ts", "packages/value/src/second.ts"], reason: "ambiguous-package-export" }],
    },
    {
      id: "dynamic-module-boundary",
      files: { ...baseFiles, "src/service.ts": baseFiles["src/service.ts"] + "const optional = import(runtimePath());\n" },
      paths: [expectedPath], complete: false, indexedFiles: 3,
      skipped: [{ path: "src/service.ts:3", reason: "runtime-module-loading" }],
      boundaries: [{ file: "src/service.ts", reason: "runtime-module-loading" }],
    },
    {
      id: "unresolved-module-boundary",
      files: { ...baseFiles, "src/service.ts": "import { value } from './missing';\nexport function consume() { return value(); }\n" },
      changes: [{ file: "src/service.ts", lines: [2] }],
      paths: [impactIdentity("src/service.ts", "consume", "test-reference", "tests/value.test.ts", 2, "consume")],
      complete: true, indexedFiles: 3, skipped: [],
      boundaries: [{ file: "src/service.ts", reason: "unresolved-relative-module" }],
      resolutions: [{ module: "./missing", candidates: [], reason: "unresolved-relative-module" }],
      disconnectedProducer: true,
    },
    {
      id: "mixed-maintenance-coverage",
      files: { ...baseFiles, "README.md": "# Generic fixture\n",
        ".github/workflows/check.yml": "name: Check\non: push\n",
        "scripts/check.mjs": "export function check() { return true; }\n" },
      edits: {
        "src/value.ts": "export function value() { return 2; }\n",
        "scripts/check.mjs": "export function check() { return false; }\n",
        "README.md": "# Updated generic fixture\n",
        ".github/workflows/check.yml": "name: Updated check\non: push\n",
      },
      changes: [{ file: "src/value.ts", lines: [1] }, { file: "scripts/check.mjs", lines: [1] },
        { file: "README.md" }, { file: ".github/workflows/check.yml" }],
      paths: [expectedPath], complete: false, indexedFiles: 4,
      skipped: [{ path: "README.md", reason: "documentation" }, { path: ".github/workflows/check.yml", reason: "non-source" }],
      boundaries: [
        { file: "README.md", reason: "changed-file-not-indexed" }, { file: "README.md", reason: "no-observable-contract-path" },
        { file: ".github/workflows/check.yml", reason: "changed-file-not-indexed" }, { file: ".github/workflows/check.yml", reason: "no-observable-contract-path" },
        { file: "scripts/check.mjs", reason: "no-observable-contract-path" },
      ],
    },
  ];
  const results = [];
  for (const definition of definitions) {
    const root = path.join(temporary, "controls", definition.id, "repo");
    const cacheDirectory = path.join(temporary, "controls", definition.id, "cache");
    const putFiles = async (files) => {
      for (const [file, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await fs.writeFile(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
      }
    };
    await putFiles(definition.files);
    await promisify(childProcess.execFile)("git", ["init", "-b", "main"], { cwd: root });
    if (definition.edits) {
      await buildRepositoryEvidenceIndex(root, { cacheDirectory });
      await putFiles(definition.edits);
    }
    const started = performance.now();
    const index = await buildRepositoryEvidenceIndex(root, { cacheDirectory });
    const impact = traceRepositoryImpact(index, definition.changes ?? [{ file: "src/value.ts", lines: [1] }]);
    const quality = scoreImpactPaths(definition.paths, impact);
    // Empty expected endpoint sets are negative controls, not perfect recall claims.
    if (definition.paths.length === 0) { quality.recall = null; if (quality.observed === 0) quality.precision = null; }
    const resolve = createRepositoryModuleResolver(index.blocks);
    const resolutions = (definition.resolutions ?? []).map((expected) => {
      const actual = resolve("src/service.ts", expected.module);
      return { module: expected.module, ...actual, passed: actual.reason === expected.reason
        && JSON.stringify([...actual.candidates].sort()) === JSON.stringify([...expected.candidates].sort()) };
    });
    const skippedQuality = scoreEvidence(definition.skipped.map((entry) => JSON.stringify(entry)), index.coverage.skipped.map((entry) => JSON.stringify(entry)));
    const boundaryQuality = scoreEvidence(definition.boundaries.map((entry) => JSON.stringify([entry.file, entry.reason])),
      impact.boundaries.map((entry) => JSON.stringify([entry.file, entry.reason])));
    const disconnected = definition.disconnectedProducer ? traceRepositoryImpact(index, [{ file: "src/value.ts", lines: [1] }]) : null;
    const checks = {
      endpoints: quality.falsePositives === 0 && quality.falseNegatives === 0,
      boundaries: boundaryQuality.falsePositives === 0 && boundaryQuality.falseNegatives === 0,
      coverage: index.coverage.complete === definition.complete && index.coverage.inventoryComplete === true
        && index.coverage.inventoryFiles === Object.keys(definition.files).length && index.coverage.indexedFiles === definition.indexedFiles
        && skippedQuality.falsePositives === 0 && skippedQuality.falseNegatives === 0,
      resolutions: resolutions.every((entry) => entry.passed),
      execution: impact.status === "draft" && impact.execution === "not-run" && impact.omittedPaths === 0,
      disconnectedProducer: !disconnected || disconnected.paths.length === 0
        && disconnected.boundaries.some((entry) => entry.file === "src/value.ts" && entry.reason === "no-observable-contract-path")
        && disconnected.status === "draft" && disconnected.execution === "not-run",
      maintenanceReuse: !definition.edits || index.reuse.rebuiltFiles === 2
        && JSON.stringify(index.reuse.changedFiles) === JSON.stringify(["scripts/check.mjs", "src/value.ts"]),
    };
    results.push({ id: definition.id, status: Object.values(checks).every(Boolean) ? "passed" : "failed",
      checks, quality, coverage: index.coverage, reuse: index.reuse, impact, resolutions,
      ...(disconnected ? { disconnectedProducerImpact: disconnected } : {}),
      diagnostics: { wallClockMs: performance.now() - started },
      expected: { complete: definition.complete, indexedFiles: definition.indexedFiles, paths: definition.paths,
        skipped: definition.skipped, boundaries: definition.boundaries },
    });
  }
  return results;
}

function observeIO(root, cacheDirectory) {
  const originals = { readFile: fs.readFile, open: fs.open, readdir: fs.readdir, execFile: childProcess.execFile };
  let active;
  const classify = (file) => {
    if (file instanceof URL) file = fileURLToPath(file);
    if (typeof file !== "string") return null;
    const absolute = path.resolve(file);
    if (absolute.startsWith(root + path.sep)) return "repository";
    if (absolute.startsWith(cacheDirectory + path.sep)) return "cache";
    return null;
  };
  const record = (target, kind, bytes) => {
    if (!target || !kind) return;
    target[`${kind}ReadCalls`]++;
    target[`${kind}ReadBytes`] += bytes;
  };
  fs.readFile = async function(file, ...args) {
    const target = active;
    const value = await originals.readFile.call(this, file, ...args);
    record(target, classify(file), Buffer.byteLength(value));
    return value;
  };
  fs.open = async function(file, ...args) {
    const handle = await originals.open.call(this, file, ...args);
    const read = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const target = active;
      const value = await read(...readArgs);
      record(target, classify(file), value.bytesRead);
      return value;
    };
    return handle;
  };
  fs.readdir = async function(file, ...args) {
    if (active && (path.resolve(file) === root || classify(file) === "repository")) active.directoryReads++;
    return originals.readdir.call(this, file, ...args);
  };
  childProcess.execFile = function(command, args, ...rest) {
    const target = active;
    if (target && command === "git" && args.includes("ls-files")) {
      target.discoveryCommands++;
      const callback = rest.pop();
      rest.push((error, stdout, stderr) => {
        if (!error) target.discoveredPaths += String(stdout).split("\0").filter(Boolean).length;
        callback(error, stdout, stderr);
      });
    }
    return originals.execFile.call(this, command, args, ...rest);
  };
  childProcess.execFile[promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {
    childProcess.execFile(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  syncBuiltinESMExports();
  return {
    async measure(operation) {
      const work = { discoveryCommands: 0, discoveredPaths: 0, directoryReads: 0,
        repositoryReadCalls: 0, repositoryReadBytes: 0, cacheReadCalls: 0, cacheReadBytes: 0 };
      active = work;
      const started = performance.now();
      try { return { value: await operation(), work, diagnostics: { wallClockMs: performance.now() - started } }; }
      finally { active = undefined; }
    },
    restore() {
      Object.assign(fs, { readFile: originals.readFile, open: originals.open, readdir: originals.readdir });
      childProcess.execFile = originals.execFile;
      syncBuiltinESMExports();
    },
  };
}

async function buildReport(fileCount) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qamap-repository-bench-")));
  const root = path.join(temporary, "fixture");
  const cacheDirectory = path.join(temporary, "cache");
  let observer;
  try {
    const fixture = await materializeFixture(root, fileCount);
    observer = observeIO(root, cacheDirectory);
    // Import after installing observation so module-scoped promisified discovery is counted.
    const { buildRepositoryEvidenceIndex } = await import("../dist/repository-index.js");
    const { traceRepositoryImpact, createRepositoryModuleResolver } = await import("../dist/repository-impact.js");
    if (typeof buildRepositoryEvidenceIndex !== "function") throw new Error("Compile the exported buildRepositoryEvidenceIndex before benchmarking.");
    const baseline = await observer.measure(() => genericDiscovery(root));
    const generic = { work: baseline.work, diagnostics: baseline.diagnostics, evidenceJsonBytes: jsonBytes(baseline.value), quality: scoreEvidence(fixture.expected, baseline.value) };
    const scenarios = [];
    let previous;
    for (const id of requiredPhases) {
      const editedCase = id === "one-file-edit" ? fixture.impactCases[0] : id === "one-package-file-edit" ? fixture.impactCases[1] : null;
      if (editedCase) {
        const changed = editedCase.changedFile;
        const symbol = id === "one-file-edit" ? "revision" : "packageRevision";
        await fs.appendFile(path.join(root, changed), `export const ${symbol} = 1;\n`);
        fixture.expected.push(fact(changed, "declarations", [symbol, "variable", 2]), fact(changed, "exports", [symbol, symbol, 2]));
        const edited = await observer.measure(() => genericDiscovery(root));
        generic[id] = { work: edited.work, diagnostics: edited.diagnostics, evidenceJsonBytes: jsonBytes(edited.value), quality: scoreEvidence(fixture.expected, edited.value) };
      }
      const { value: index, work, diagnostics } = await observer.measure(() => buildRepositoryEvidenceIndex(root, { cacheDirectory }));
      const quality = scoreEvidence(fixture.expected, projectEvidence(index.blocks));
      const comparison = editedCase ? generic[id] : generic;
      const impactStarted = performance.now();
      const productPaths = fixture.impactCases.map((testCase) => {
        const impact = traceRepositoryImpact(index, [{ file: testCase.changedFile, lines: [1] }]);
        const quality = scoreImpactPaths(testCase.expected, impact);
        const evidenceLocated = impact.paths.every((entry) => entry.evidence.every((step) =>
          fixture.contents.has(step.file) && Number.isInteger(step.line) && step.line > 0));
        return { id: testCase.id, quality, impact, evidenceLocated,
          passed: quality.precision === 1 && quality.recall === 1 && evidenceLocated
            && impact.status === "draft" && impact.execution === "not-run" && impact.boundaries.length === 0 && impact.omittedPaths === 0 };
      });
      const impactWallClockMs = performance.now() - impactStarted;
      const sizingStarted = performance.now();
      const impacts = productPaths.map((entry) => entry.impact);
      const payload = measureSerializedPayload(index, impacts);
      const recoveredIndex = JSON.parse(JSON.stringify(index));
      const recoveredImpacts = fixture.impactCases.map((testCase) => traceRepositoryImpact(recoveredIndex, [{ file: testCase.changedFile, lines: [1] }]));
      const cacheEntries = await fs.readdir(cacheDirectory, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      let cacheSnapshotBytes = 0;
      for (const entry of cacheEntries) if (entry.isFile()) cacheSnapshotBytes += (await fs.stat(path.join(cacheDirectory, entry.name))).size;
      const recovery = {
        status: JSON.stringify(recoveredImpacts) === JSON.stringify(impacts) ? "passed" : "failed",
        scope: "serialized-repository-index-round-trip",
        indexJsonBytes: payload.recoveryIndexJsonBytes,
        cacheSnapshotBytes,
        cacheSnapshotFiles: cacheEntries.filter((entry) => entry.isFile()).length,
      };
      const qualityPassed = qualityGate(comparison.quality, quality, index.coverage.complete) && productPaths.every((entry) => entry.passed);
      const readsVerified = work.repositoryReadBytes === index.reuse.readBytes && index.reuse.readFiles === index.coverage.indexedFiles;
      const canCompareReads = qualityPassed && readsVerified;
      const reusePassed = id === "cold" ? index.reuse.rebuiltFiles === index.coverage.indexedFiles && index.reuse.reusedFiles === 0
        : id === "warm" ? index.reuse.rebuiltFiles === 0 && index.reuse.reusedFiles === index.coverage.indexedFiles
          && index.coverage.fingerprint === previous.coverage.fingerprint
        : index.reuse.rebuiltFiles === 1 && index.reuse.changedFiles.length === 1
          && index.reuse.changedFiles[0] === editedCase.changedFile
          && editedCase.affected.every((file) => index.reuse.affectedFiles.includes(file))
          && index.coverage.fingerprint !== previous.coverage.fingerprint;
      scenarios.push({
        id, work, quality, productPaths, payload, recovery,
        diagnostics: { indexWallClockMs: diagnostics.wallClockMs, impactWallClockMs, sizingAndRecoveryWallClockMs: performance.now() - sizingStarted },
        coverage: index.coverage, reuse: index.reuse,
        qualityPassed, reusePassed, readsVerified,
        savings: {
          eligible: canCompareReads,
          repositoryReadBytesAvoided: canCompareReads ? comparison.work.repositoryReadBytes - work.repositoryReadBytes : null,
          totalReadBytesAvoided: canCompareReads ? comparison.work.repositoryReadBytes + comparison.work.cacheReadBytes - work.repositoryReadBytes - work.cacheReadBytes : null,
          discoveryCommandsAvoided: canCompareReads ? comparison.work.discoveryCommands - work.discoveryCommands : null,
          providerTokensAvoided: null,
        },
        passed: qualityPassed && reusePassed && readsVerified && recovery.status === "passed",
      });
      previous = index;
    }
    const qualityScenarios = [
      ...fixture.impactCases.map((testCase) => ({ id: testCase.id,
        status: scenarios.every((scenario) => scenario.productPaths.find((entry) => entry.id === testCase.id)?.passed === true) ? "passed" : "failed" })),
      ...await runQualityControls(temporary, { buildRepositoryEvidenceIndex, traceRepositoryImpact, createRepositoryModuleResolver }),
    ];
    const summary = summarizeBenchmark(scenarios, qualityScenarios);
    // A smaller workload cannot earn a savings claim when any required quality control was omitted or failed.
    if (!summary.qualityComplete) for (const scenario of scenarios) {
      scenario.savings = { eligible: false, reason: "required-quality-case-not-passed", repositoryReadBytesAvoided: null,
        totalReadBytesAvoided: null, discoveryCommandsAvoided: null, providerTokensAvoided: null };
    }
    return {
      schema: { name: "qamap.repository-index-benchmark", version: 1 },
      fixture: { modules: fileCount, inventoryFiles: fixture.contents.size },
      generic, scenarios, qualityScenarios,
      providerUsage: { status: "not-measured", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null },
      interpretation: [
        "Generic means four exhaustive scans of the same fixture, not all possible agent strategies.",
        "Structural identities and lines, contract JSON pointers, and validation names and command hashes are checked against an independent synthetic oracle; this does not measure semantic QA correctness.",
        "Real traceRepositoryImpact output is scored against exact changed-symbol and endpoint identities for relative and cross-package cases. Product paths remain draft/not-run, not executed behavior. The generic baseline measures structural discovery, not agent product-path quality.",
        "Observed Node file reads include content validation on warm runs and zero-byte EOF reads; syntax reuse is not zero file reads.",
        "Cache I/O is separate. These are API-level reads, not physical disk reads; stat calls and cache-write I/O are not counted.",
        "Wall-clock uses performance.now for one fixed-order instrumented sample in this process. It is diagnostic only, includes contention, excludes module loading and fixture setup, and never gates success or establishes a speedup.",
        "Payload sizes are actual compact UTF-8 JSON serializations of blocks, the impact array, and the returned repository index. Recovery checks replay the serialized index. Cache snapshot sizes are actual persisted file sizes. None is a full CLI or agent-recovery-report byte count.",
        "Read comparisons require complete primary-fixture coverage and all seven quality cases to pass, including explicit incomplete-coverage and unresolved/dynamic/ambiguous boundaries. Negative reductions remain visible.",
        "No model was called. UTF-8 bytes, discovery work and syntax reuse are not provider tokens or money saved.",
      ],
      summary,
    };
  } finally {
    observer?.restore();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let fileCount = 64;
  let format = "text";
  let assertContract = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--assert") assertContract = true;
    else if (args[i] === "--files") fileCount = Number(args[++i]);
    else if (args[i] === "--format") format = args[++i];
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 10000) throw new Error("--files must be an integer from 1 to 10000");
  if (!["text", "json"].includes(format)) throw new Error("--format must be text or json");
  const report = await buildReport(fileCount);
  if (format === "json") console.log(JSON.stringify(report, null, 2));
  else {
    console.log("# Repository Index Benchmark");
    console.log(`Generic: discoveries=${report.generic.work.discoveryCommands}, repository-read-bytes=${report.generic.work.repositoryReadBytes}`);
    for (const scenario of report.scenarios) console.log(`${scenario.passed ? "PASS" : "FAIL"} ${scenario.id}: precision=${scenario.quality.precision}, recall=${scenario.quality.recall}, read-files=${scenario.reuse.readFiles}, repository-read-bytes=${scenario.work.repositoryReadBytes}, cache-read-bytes=${scenario.work.cacheReadBytes}, total-read-bytes-avoided=${scenario.savings.totalReadBytesAvoided}, syntax-reused=${scenario.reuse.reusedFiles}`);
    for (const scenario of report.scenarios) console.log(`SIZE ${scenario.id}: blocks-json-bytes=${scenario.payload.blocksJsonBytes}, recovery-index-json-bytes=${scenario.recovery.indexJsonBytes}, cache-snapshot-bytes=${scenario.recovery.cacheSnapshotBytes}; diagnostic-index-ms=${scenario.diagnostics.indexWallClockMs.toFixed(2)}`);
    for (const scenario of report.qualityScenarios) console.log(`${scenario.status.toUpperCase()} quality:${scenario.id}${scenario.checks ? ` ${JSON.stringify(scenario.checks)}` : ""}`);
    console.log(`Summary: ${report.summary.passedChecks}/${report.summary.checks} checks; quality-complete=${report.summary.qualityComplete}`);
    for (const note of report.interpretation) console.log(note);
  }
  if (assertContract && !report.summary.passed) process.exitCode = 1;
}
