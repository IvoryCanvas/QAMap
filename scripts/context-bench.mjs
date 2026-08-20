#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  buildAgentContextContract,
  compareAgentContextContracts,
  formatAgentQaDraft,
  formatAgentQaFullReport,
  generateQaDraft,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const format = readArg("--format") ?? "text";
const assertContract = args.includes("--assert");
const blockKinds = ["repository", "manifest", "validation", "behavior"];

if (!["json", "text"].includes(format)) {
  throw new Error("--format must be json or text");
}

const report = await buildReport();
if (format === "json") {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printReport(report);
}

if (assertContract && !report.summary.passed) {
  process.exitCode = 1;
}

async function buildReport() {
  const baselineInput = contextInput();
  const baseline = buildAgentContextContract(baselineInput, { includeDetails: true });
  const scenarios = [];

  scenarios.push(compareScenario({
    id: "identical-rerun",
    description: "The same repository state and pull request are analyzed twice.",
    previous: baseline,
    current: buildAgentContextContract(structuredClone(baselineInput), { includeDetails: true }),
    expectedStableMatch: true,
    expectedDeltaMatch: true,
    expectedInvalidated: [],
    reasons: {},
  }));

  const relatedInput = structuredClone(baselineInput);
  relatedInput.delta.head = "feature/related-preference-change";
  relatedInput.delta.changedFiles = ["src/preferences/keyboard.ts"];
  relatedInput.delta.intents = [{ id: "intent:keyboard-preference" }];
  relatedInput.delta.traces = [{ id: "trace:keyboard-preference" }];
  relatedInput.delta.flows = [{ title: "Update keyboard preference" }];
  scenarios.push(compareScenario({
    id: "related-pull-request",
    description: "A second pull request changes another file while repository QA facts stay the same.",
    previous: baseline,
    current: buildAgentContextContract(relatedInput, { includeDetails: true }),
    expectedStableMatch: true,
    expectedDeltaMatch: false,
    expectedInvalidated: [],
    reasons: {},
  }));

  const manifestInput = structuredClone(baselineInput);
  manifestInput.manifest.context.safetyRules.push("Use a non-production account for manual checks.");
  scenarios.push(compareScenario({
    id: "manifest-correction",
    description: "Reviewed manifest policy is corrected without changing behavior definitions.",
    previous: baseline,
    current: buildAgentContextContract(manifestInput, { includeDetails: true }),
    expectedStableMatch: false,
    expectedDeltaMatch: true,
    expectedInvalidated: ["manifest"],
    reasons: { manifest: "reviewed manifest policy changed" },
  }));

  const validationInput = structuredClone(baselineInput);
  validationInput.validationCommands.push("package-script:check=tsc --noEmit");
  scenarios.push(compareScenario({
    id: "validation-command-change",
    description: "A repository validation command changes without changing manifest behavior.",
    previous: baseline,
    current: buildAgentContextContract(validationInput, { includeDetails: true }),
    expectedStableMatch: false,
    expectedDeltaMatch: true,
    expectedInvalidated: ["validation"],
    reasons: { validation: "repository validation facts changed" },
  }));

  const behaviorInput = structuredClone(baselineInput);
  behaviorInput.manifest.flows[0].checks[0].title = "Saved preference remains selected after reload";
  scenarios.push(compareScenario({
    id: "behavior-structure-change",
    description: "A reviewed flow check changes while repository and validation facts stay fixed.",
    previous: baseline,
    current: buildAgentContextContract(behaviorInput, { includeDetails: true }),
    expectedStableMatch: false,
    expectedDeltaMatch: true,
    expectedInvalidated: ["behavior"],
    reasons: { behavior: "reviewed behavior structure changed" },
  }));

  const volatileInput = structuredClone(baselineInput);
  volatileInput.delta.execution = {
    status: "passed",
    performed: true,
    generatedAt: "2099-01-01T00:00:00.000Z",
    nonce: "another-run",
    recoveryPath: "/temporary/qamap-report.json",
  };
  scenarios.push(compareScenario({
    id: "volatile-run-metadata",
    description: "Timestamp, nonce, and temporary report metadata change only the pull request delta.",
    previous: baseline,
    current: buildAgentContextContract(volatileInput, { includeDetails: true }),
    expectedStableMatch: true,
    expectedDeltaMatch: false,
    expectedInvalidated: [],
    reasons: {},
  }));

  const unrelatedInput = structuredClone(baselineInput);
  unrelatedInput.repository.id = `repo:${"b".repeat(64)}`;
  scenarios.push(compareScenario({
    id: "unrelated-repository",
    description: "An unrelated repository must not reuse the prior repository block or aggregate identity.",
    previous: baseline,
    current: buildAgentContextContract(unrelatedInput, { includeDetails: true }),
    expectedStableMatch: false,
    expectedDeltaMatch: true,
    expectedInvalidated: ["repository"],
    reasons: { repository: "opaque repository identity changed" },
  }));

  const handoff = await measureAgentHandoff();
  const checks = [
    ...scenarios.map((scenario) => ({
      id: scenario.id,
      passed: scenario.passed,
      failure: scenario.failure,
    })),
    {
      id: "agent-payload-byte-limit",
      passed: handoff.compactAgentPayloadBytes <= 4095,
      failure: handoff.compactAgentPayloadBytes <= 4095
        ? null
        : `compact payload was ${handoff.compactAgentPayloadBytes} bytes`,
    },
    {
      id: "changed-evidence-present",
      passed: handoff.rawChangedEvidenceBytes > 0 && handoff.currentDeltaBytes > 0,
      failure: handoff.rawChangedEvidenceBytes > 0 && handoff.currentDeltaBytes > 0
        ? null
        : "changed evidence was empty",
    },
    {
      id: "stable-block-contract",
      passed: handoff.stableBlockCount === blockKinds.length,
      failure: handoff.stableBlockCount === blockKinds.length
        ? null
        : `expected ${blockKinds.length} stable blocks, received ${handoff.stableBlockCount}`,
    },
  ];

  return {
    schema: { name: "qamap.context-benchmark", version: 1 },
    normativeMetrics: ["utf8-bytes", "structural-block-counts"],
    interpretation: [
      "Context reuse measures repeated repository input avoided, not QA correctness.",
      "QAMap itself makes no LLM request. A calling agent still uses its own model tokens.",
      "No provider pricing or fixed cost-reduction multiplier is inferred from these measurements.",
    ],
    handoff,
    scenarios,
    summary: {
      passed: checks.every((check) => check.passed),
      checks: checks.length,
      passedChecks: checks.filter((check) => check.passed).length,
      failures: checks.filter((check) => !check.passed).map((check) => ({
        id: check.id,
        reason: check.failure,
      })),
    },
  };
}

function compareScenario({
  id,
  description,
  previous,
  current,
  expectedStableMatch,
  expectedDeltaMatch,
  expectedInvalidated,
  reasons,
}) {
  const comparison = compareAgentContextContracts(previous, current);
  const invalidatedBlocks = comparison.invalidated.map((block) => ({
    kind: block.kind,
    reason: reasons[block.kind] ?? "stable block content changed",
    previousId: block.previousId,
    currentId: block.currentId,
  }));
  const stableMatched = previous.stable.id === current.stable.id;
  const deltaMatched = previous.delta.id === current.delta.id;
  const invalidatedKinds = invalidatedBlocks.map((block) => block.kind);
  const reusedBytes = previous.stable.blocks
    .filter((block) => comparison.reused.includes(block.kind))
    .reduce((total, block) => total + block.bytes, 0);
  const passed = stableMatched === expectedStableMatch &&
    deltaMatched === expectedDeltaMatch &&
    sameValues(invalidatedKinds, expectedInvalidated) &&
    sameValues([...comparison.reused].sort(), blockKinds.filter((kind) => !expectedInvalidated.includes(kind)).sort());

  return {
    id,
    description,
    passed,
    failure: passed
      ? null
      : `expected stable=${expectedStableMatch}, delta=${expectedDeltaMatch}, invalidated=${expectedInvalidated.join(",") || "none"}`,
    stableMatched,
    deltaMatched,
    stableContextBytes: current.stable.bytes,
    currentDeltaBytes: current.delta.bytes,
    reusedBlockCount: comparison.reused.length,
    reusedBytes,
    reusedBlocks: comparison.reused,
    invalidatedBlocks,
    fingerprints: {
      stable: current.stable.id,
      delta: current.delta.id,
    },
  };
}

async function measureAgentHandoff() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-context-bench-"));
  try {
    await materializeFixture(tempRoot);
    const qa = await generateQaDraft(tempRoot, { base: "main", head: "HEAD" });
    const compactText = formatAgentQaDraft(qa);
    const compact = JSON.parse(compactText);
    const full = JSON.parse(formatAgentQaFullReport(qa));
    const deltaData = full.context.delta.data;
    const rawChangedEvidence = {
      changedFiles: deltaData.changedFiles,
      intents: deltaData.intents,
      traces: deltaData.traces,
      flows: deltaData.flows,
    };

    return {
      rawChangedEvidenceBytes: byteLength(rawChangedEvidence),
      stableRepositoryContextBytes: full.context.stable.bytes,
      currentDeltaBytes: full.context.delta.bytes,
      stableBlockCount: full.context.stable.blocks.length,
      compactAgentPayloadBytes: Buffer.byteLength(compactText),
      omitted: {
        stableBlocks: compact.context.omittedBlockCount ?? 0,
        traces: compact.omittedTraceCount ?? 0,
        intents: compact.omittedIntentCount ?? 0,
        flows: compact.omittedFlowCount ?? 0,
      },
      fingerprints: {
        stable: full.context.stable.id,
        delta: full.context.delta.id,
      },
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function materializeFixture(root) {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "test"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({
    scripts: { test: "vitest run", check: "tsc --noEmit" },
    devDependencies: { "@playwright/test": "^1.55.0", vitest: "^3.2.0" },
  }, null, 2)}\n`);
  await fs.writeFile(
    path.join(root, "src", "preferences.tsx"),
    "export function Preferences() { return <button>Use compact layout</button>; }\n",
  );
  await fs.writeFile(
    path.join(root, "test", "preferences.test.tsx"),
    "it('shows layout preferences', () => expect(true).toBe(true));\n",
  );
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "QAMap Context Benchmark"]);
  await git(root, ["config", "user.email", "context-benchmark@qamap.local"]);
  await git(root, ["remote", "add", "origin", "https://example.invalid/qamap/context-benchmark.git"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "--no-gpg-sign", "-m", "benchmark baseline"]);
  await git(root, ["switch", "-c", "benchmark/change"]);
  await fs.writeFile(
    path.join(root, "src", "preferences.tsx"),
    [
      "import { useState } from 'react';",
      "export function Preferences() {",
      "  const [compact, setCompact] = useState(false);",
      "  return <section>",
      "    <button onClick={() => setCompact(true)}>Use compact layout</button>",
      "    <p role=\"status\">{compact ? 'Compact layout enabled' : 'Standard layout enabled'}</p>",
      "  </section>;",
      "}",
      "",
    ].join("\n"),
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "--no-gpg-sign", "-m", "feat: persist compact layout preference"]);
}

function contextInput() {
  return {
    repository: {
      id: `repo:${"a".repeat(64)}`,
      project: "web",
      runner: "playwright",
      analysisScope: { mode: "repository-root", candidates: [] },
      testSuite: { present: true, files: 1 },
    },
    manifest: {
      version: 1,
      context: {
        instructionFiles: [],
        validationCommands: ["pnpm test"],
        safetyRules: ["Do not use production services."],
        source: { kind: "declared", confidence: "high", from: ["team review"] },
      },
      domains: [{
        id: "preferences",
        name: "Preferences",
        paths: ["src/preferences/**"],
        criticality: "medium",
        source: { kind: "declared", confidence: "high", from: ["team review"] },
      }],
      flows: [{
        id: "update-layout-preference",
        domain: "preferences",
        name: "Update layout preference",
        entry: { route: "/preferences", source: "declared" },
        runner: "playwright",
        anchors: [{
          kind: "route",
          route: "/preferences",
          source: "declared",
          confidence: "high",
        }],
        checks: [{ id: "saved", title: "Saved preference remains selected", type: "success" }],
        source: { kind: "declared", confidence: "high", from: ["team review"] },
      }],
    },
    validationCommands: ["package-script:test=vitest run", "pnpm test"],
    delta: {
      base: "main",
      baseSource: "explicit",
      head: "feature/layout-preference",
      includeWorkingTree: false,
      changedFiles: ["src/preferences/layout.ts"],
      intents: [{ id: "intent:layout-preference" }],
      traces: [{ id: "trace:layout-preference" }],
      flows: [{ title: "Update layout preference" }],
      execution: { status: "not-run", performed: false },
    },
  };
}

function printReport(value) {
  console.log("# QAMap Context Reuse Benchmark\n");
  console.log("Normative metrics: UTF-8 bytes and structural block counts.\n");
  console.log("Agent handoff");
  console.log(`- raw changed evidence: ${value.handoff.rawChangedEvidenceBytes} bytes`);
  console.log(`- stable repository context: ${value.handoff.stableRepositoryContextBytes} bytes`);
  console.log(`- current pull request delta: ${value.handoff.currentDeltaBytes} bytes`);
  console.log(`- compact agent payload: ${value.handoff.compactAgentPayloadBytes} bytes`);
  console.log(`- stable blocks: ${value.handoff.stableBlockCount}`);
  console.log("");
  console.log("Reuse scenarios");
  for (const scenario of value.scenarios) {
    console.log(`- ${scenario.passed ? "PASS" : "FAIL"} ${scenario.id}`);
    console.log(`  reused: ${scenario.reusedBlockCount}/${blockKinds.length} blocks, ${scenario.reusedBytes} bytes`);
    if (scenario.invalidatedBlocks.length > 0) {
      console.log(`  invalidated: ${scenario.invalidatedBlocks.map((block) => `${block.kind} (${block.reason})`).join(", ")}`);
    }
  }
  console.log("");
  for (const line of value.interpretation) console.log(`- ${line}`);
  console.log("");
  console.log(`Summary: ${value.summary.passedChecks}/${value.summary.checks} checks passed.`);
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function sameValues(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function git(root, commandArgs) {
  await execFileAsync("git", commandArgs, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z",
    },
  });
}
