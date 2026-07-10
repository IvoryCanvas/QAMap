#!/usr/bin/env node
// QAMap benchmark runner: scores plan/qa output quality against fixed PR
// scenarios. Targets can be pinned real repositories or committed fixtures.
// The runner never executes project code.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { formatAgentQaDraft, generateE2ePlan, generateQaDraft } from "../dist/index.js";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const explicitConfigPath = readArg("--config");
const configPath = explicitConfigPath ?? await defaultConfigPath();
const baselinePath = readArg("--baseline");
const save = args.includes("--save");
const assertContract = args.includes("--assert");
const resolvedConfigPath = path.resolve(configPath);
const configDir = path.dirname(resolvedConfigPath);
const config = JSON.parse(await fs.readFile(resolvedConfigPath, "utf8"));
const results = [];

for (const target of config.targets) {
  let prepared;
  try {
    prepared = await prepareTarget(target, configDir);
    const options = {
      base: prepared.base,
      head: prepared.head,
      workspaceRoot: prepared.workspaceRoot,
    };
    const startedAt = Date.now();
    const plan = await generateE2ePlan(prepared.root, options);
    const qa = await generateQaDraft(prepared.root, { ...options, runner: undefined });
    const durationMs = Date.now() - startedAt;
    const result = scoreTarget(target, plan, qa, durationMs);
    result.contractFailures = evaluateContract(target.expect ?? {}, result, plan, qa);
    result.contractPassed = result.contractFailures.length === 0;
    results.push(result);
  } catch (error) {
    results.push({
      name: target.name,
      error: String(error && error.message ? error.message : error),
      contractPassed: false,
      contractFailures: ["benchmark target could not be analyzed"],
    });
  } finally {
    await prepared?.cleanup?.();
  }
}

printTable(results);

if (baselinePath) {
  const baseline = JSON.parse(await fs.readFile(baselinePath, "utf8"));
  printDeltas(baseline.results ?? baseline, results);
}

if (save) {
  await fs.mkdir("bench-results", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = path.join("bench-results", `bench-${stamp}.json`);
  await fs.writeFile(outputPath, `${JSON.stringify({ config: configPath, results }, null, 2)}\n`);
  console.log(`\nSaved: ${outputPath}`);
}

const failedTargets = results.filter((result) => !result.contractPassed);
if (assertContract && failedTargets.length > 0) {
  console.error(`\nBenchmark contract failed for ${failedTargets.length} target${failedTargets.length === 1 ? "" : "s"}.`);
  process.exitCode = 1;
}

function scoreTarget(target, plan, qa, durationMs) {
  const flowSteps = plan.flows.flatMap((flow) => flow.steps);
  const draftSteps = qa.flows.flatMap((flow) => flow.draftSteps ?? []);
  const allSteps = [...flowSteps, ...draftSteps];
  const blankActionPattern = /Fill\s{2,}|using \.\s*$|\s{2,}with realistic data/;
  const genericTitlePattern = /(?:primary journey|smoke flow|smoke checklist)$/i;
  const expect = target.expect ?? {};
  const flowFiles = new Set(plan.flows.flatMap((flow) => flow.files).map(normalizePath));
  const mustReach = (expect.mustReachFiles ?? []).map(normalizePath);
  const reached = mustReach.filter((file) => flowFiles.has(file));
  const flowTitles = qa.flows.map((flow) => flow.title);
  const planFlowTitles = plan.flows.map((flow) => flow.title);
  const successSignals = qa.flows
    .map((flow) => flow.userJourney?.successSignal)
    .filter(Boolean);
  const mustName = expect.mustNameFlows ?? [];
  const named = mustName.filter((name) => includesTerm(flowTitles, name));

  return {
    name: target.name,
    runner: plan.recommendedRunner.name,
    runnerExpected: expect.runner ?? null,
    runnerCorrect: expect.runner ? plan.recommendedRunner.name === expect.runner : null,
    flows: plan.flows.length,
    planFlowTitles,
    flowTitles,
    successSignals,
    draftPaths: qa.flows.map((flow) => normalizePath(flow.draftPath)),
    genericTitles: qa.flows.filter((flow) => genericTitlePattern.test(flow.title)).length,
    importPropagatedFlows: plan.flows.filter((flow) => flow.reason.includes("through imports")).length,
    diffAnchoredFlows: plan.flows.filter((flow) => (flow.selectors ?? []).some((selector) => selector.addedInDiff)).length,
    blankActions: allSteps.filter((step) => blankActionPattern.test(step)).length,
    mustReachRecall: mustReach.length > 0 ? `${reached.length}/${mustReach.length}` : null,
    mustReachMissing: mustReach.filter((file) => !flowFiles.has(file)),
    mustNameRecall: mustName.length > 0 ? `${named.length}/${mustName.length}` : null,
    mustNameMissing: mustName.filter((name) => !named.includes(name)),
    readiness: `${qa.readiness.level} (${qa.readiness.score})`,
    agentBytes: Buffer.byteLength(formatAgentQaDraft(qa)),
    durationMs,
  };
}

function evaluateContract(expect, result, plan, qa) {
  const failures = [];
  const steps = [
    ...plan.flows.flatMap((flow) => flow.steps),
    ...qa.flows.flatMap((flow) => flow.draftSteps ?? []),
  ];
  const selectors = qa.flows.flatMap((flow) => flow.selectorHints ?? []);
  const evidence = qa.missingEvidence.map((item) => `${item.kind} ${item.title} ${item.detail}`);
  const commands = [
    ...qa.suggestedCommands,
    qa.runnerSetup.setupCommand,
    ...qa.runnerSetup.installCommands,
    ...qa.runnerSetup.nextCommands,
  ].filter(Boolean);

  if (expect.runner && result.runner !== expect.runner) {
    failures.push(`runner expected ${expect.runner}, got ${result.runner}`);
  }
  if (expect.minFlows !== undefined && result.flows < expect.minFlows) {
    failures.push(`expected at least ${expect.minFlows} flow(s), got ${result.flows}`);
  }
  if (
    expect.minImportPropagatedFlows !== undefined &&
    result.importPropagatedFlows < expect.minImportPropagatedFlows
  ) {
    failures.push(
      `expected at least ${expect.minImportPropagatedFlows} import-propagated flow(s), got ${result.importPropagatedFlows}`,
    );
  }
  if (expect.minDiffAnchoredFlows !== undefined && result.diffAnchoredFlows < expect.minDiffAnchoredFlows) {
    failures.push(`expected at least ${expect.minDiffAnchoredFlows} diff-anchored flow(s), got ${result.diffAnchoredFlows}`);
  }
  appendMissingTerms(failures, "flow title", result.flowTitles, expect.mustNameFlows);
  appendMissingTerms(failures, "draft path", result.draftPaths, expect.mustDraftFiles);
  appendMissingTerms(failures, "step", steps, expect.mustIncludeSteps);
  appendMissingTerms(failures, "selector", selectors, expect.mustFindSelectors);
  appendMissingTerms(failures, "success signal", result.successSignals, expect.mustFindSuccessSignals);
  appendMissingTerms(failures, "evidence", evidence, expect.mustFindEvidence);
  appendMissingTerms(failures, "command", commands, expect.mustRecommendCommands);

  if (result.mustReachMissing.length > 0) {
    failures.push(`changed flow did not reach: ${result.mustReachMissing.join(", ")}`);
  }
  if (expect.maxBlankActions !== undefined && result.blankActions > expect.maxBlankActions) {
    failures.push(`blank actions ${result.blankActions} exceed ${expect.maxBlankActions}`);
  }
  if (expect.maxGenericTitles !== undefined && result.genericTitles > expect.maxGenericTitles) {
    failures.push(`generic titles ${result.genericTitles} exceed ${expect.maxGenericTitles}`);
  }
  if (expect.maxAgentBytes !== undefined && result.agentBytes > expect.maxAgentBytes) {
    failures.push(`agent payload ${result.agentBytes} bytes exceeds ${expect.maxAgentBytes}`);
  }
  return failures;
}

function appendMissingTerms(failures, label, actualValues, expectedTerms = []) {
  for (const term of expectedTerms) {
    if (!includesTerm(actualValues, term)) {
      failures.push(`${label} missing "${term}"`);
    }
  }
}

function includesTerm(values, term) {
  const expected = String(term).toLowerCase();
  return values.some((value) => String(value).toLowerCase().includes(expected));
}

async function prepareTarget(target, configDir) {
  if (target.fixture) {
    return materializeFixture(target, configDir);
  }
  if (!target.path) {
    throw new Error(`Target ${target.name} must define either path or fixture.`);
  }
  const repositoryRoot = path.resolve(expandHome(target.path));
  return targetPaths(target, repositoryRoot, target.base, target.head);
}

async function materializeFixture(target, configDir) {
  const fixtureRoot = path.resolve(configDir, target.fixture);
  const baseRoot = path.join(fixtureRoot, "base");
  const headRoot = path.join(fixtureRoot, "head");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-bench-"));
  const repositoryRoot = path.join(tempRoot, "repo");
  await fs.mkdir(repositoryRoot, { recursive: true });
  await fs.cp(baseRoot, repositoryRoot, { recursive: true });
  await git(repositoryRoot, ["init", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.email", "benchmark@qamap.local"]);
  await git(repositoryRoot, ["config", "user.name", "QAMap Benchmark"]);
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "benchmark baseline"]);
  await git(repositoryRoot, ["switch", "-c", "benchmark/change"]);
  if (await exists(headRoot)) {
    await fs.cp(headRoot, repositoryRoot, { recursive: true, force: true });
  }
  await git(repositoryRoot, ["add", "-A"]);
  await git(repositoryRoot, ["commit", "--allow-empty", "-m", "benchmark change"]);
  const prepared = targetPaths(target, repositoryRoot, "main", "HEAD");
  return {
    ...prepared,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
  };
}

function targetPaths(target, repositoryRoot, base, head) {
  const root = target.targetPath ? path.join(repositoryRoot, target.targetPath) : repositoryRoot;
  const workspaceRoot = target.workspaceRoot ? path.join(repositoryRoot, target.workspaceRoot) : undefined;
  return { root, workspaceRoot, base, head };
}

async function git(cwd, gitArgs) {
  await execFileAsync("git", gitArgs, { cwd });
}

async function defaultConfigPath() {
  for (const candidate of ["bench.config.local.json", "bench.config.json"]) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  throw new Error("No benchmark config found. Create bench.config.local.json or use --config <file>.");
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function printTable(rows) {
  const columns = [
    ["name", 24],
    ["contractPassed", 8],
    ["runner", 11],
    ["flows", 5],
    ["importPropagatedFlows", 10],
    ["diffAnchoredFlows", 10],
    ["blankActions", 6],
    ["genericTitles", 8],
    ["mustReachRecall", 10],
    ["readiness", 18],
    ["agentBytes", 10],
    ["durationMs", 10],
  ];
  const header = columns.map(([key, width]) => shortLabel(key).padEnd(width)).join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    if (row.error) {
      console.log(`${row.name.padEnd(24)} ERROR: ${row.error}`);
    } else {
      console.log(columns.map(([key, width]) => String(displayValue(row, key)).padEnd(width)).join(" "));
    }
    for (const failure of row.contractFailures ?? []) {
      console.log(`  ! ${failure}`);
    }
  }
}

function displayValue(row, key) {
  if (key === "contractPassed") {
    return row.contractPassed ? "PASS" : "FAIL";
  }
  return row[key] ?? "-";
}

function printDeltas(baselineRows, currentRows) {
  console.log("\nDelta vs baseline (negative blankActions/genericTitles is better):");
  for (const current of currentRows) {
    const before = baselineRows.find((row) => row.name === current.name);
    if (!before || current.error || before.error) {
      continue;
    }
    const deltas = [];
    for (const key of ["flows", "importPropagatedFlows", "diffAnchoredFlows", "blankActions", "genericTitles", "agentBytes"]) {
      const diff = (current[key] ?? 0) - (before[key] ?? 0);
      if (diff !== 0) {
        deltas.push(`${key} ${diff > 0 ? "+" : ""}${diff}`);
      }
    }
    console.log(`- ${current.name}: ${deltas.length > 0 ? deltas.join(", ") : "no change"}`);
  }
}

function shortLabel(key) {
  const labels = {
    contractPassed: "contract",
    importPropagatedFlows: "viaImport",
    diffAnchoredFlows: "diffAnchor",
    blankActions: "blank",
    genericTitles: "generic",
    mustReachRecall: "reach",
    durationMs: "ms",
  };
  return labels[key] ?? key;
}

function readArg(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function expandHome(value) {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function normalizePath(value) {
  return String(value).replaceAll(path.sep, "/").replace(/^\.\//, "");
}
