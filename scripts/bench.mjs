#!/usr/bin/env node
// QAMap benchmark runner: scores plan/qa output quality against a fixed set of
// repositories with pinned base/head commits. Read-only against every target.
//
// Usage:
//   node scripts/bench.mjs [--config bench.config.local.json] [--save] [--baseline bench-results/<file>.json]
//
// Config format (see bench.config.example.json):
//   { "targets": [ { "name", "path", "base", "head",
//       "expect": { "runner", "mustReachFiles": [], "mustNameFlows": [] } } ] }

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { formatAgentQaDraft, generateE2ePlan, generateQaDraft } from "../dist/index.js";

const args = process.argv.slice(2);
const configPath = readArg("--config") ?? "bench.config.local.json";
const baselinePath = readArg("--baseline");
const save = args.includes("--save");

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const results = [];

for (const target of config.targets) {
  const root = expandHome(target.path);
  const options = { base: target.base, head: target.head };
  const startedAt = Date.now();
  let plan;
  let qa;
  try {
    plan = await generateE2ePlan(root, options);
    qa = await generateQaDraft(root, { ...options, runner: undefined });
  } catch (error) {
    results.push({ name: target.name, error: String(error && error.message ? error.message : error) });
    continue;
  }
  const durationMs = Date.now() - startedAt;

  const flowSteps = plan.flows.flatMap((flow) => flow.steps);
  const draftSteps = qa.flows.flatMap((flow) => flow.draftSteps ?? []);
  const allSteps = [...flowSteps, ...draftSteps];
  const blankActionPattern = /Fill\s{2,}|using \.\s*$|\s{2,}with realistic data/;
  const genericTitlePattern = /(?:primary journey|smoke flow|smoke checklist)$/i;

  const expect = target.expect ?? {};
  const flowFiles = new Set(plan.flows.flatMap((flow) => flow.files));
  const mustReach = expect.mustReachFiles ?? [];
  const reached = mustReach.filter((file) => flowFiles.has(file));
  const flowTitles = plan.flows.map((flow) => flow.title.toLowerCase());
  const mustName = expect.mustNameFlows ?? [];
  const named = mustName.filter((name) => flowTitles.some((title) => title.includes(name.toLowerCase())));

  results.push({
    name: target.name,
    runner: plan.recommendedRunner.name,
    runnerExpected: expect.runner ?? null,
    runnerCorrect: expect.runner ? plan.recommendedRunner.name === expect.runner : null,
    flows: plan.flows.length,
    genericTitles: qa.flows.filter((flow) => genericTitlePattern.test(flow.title)).length,
    importPropagatedFlows: plan.flows.filter((flow) => flow.reason.includes("through imports")).length,
    diffAnchoredFlows: plan.flows.filter((flow) => (flow.selectors ?? []).some((selector) => selector.addedInDiff)).length,
    blankActions: allSteps.filter((step) => blankActionPattern.test(step)).length,
    mustReachRecall: mustReach.length > 0 ? `${reached.length}/${mustReach.length}` : null,
    mustReachMissing: mustReach.filter((file) => !flowFiles.has(file)),
    mustNameRecall: mustName.length > 0 ? `${named.length}/${mustName.length}` : null,
    readiness: `${qa.readiness.level} (${qa.readiness.score})`,
    agentBytes: formatAgentQaDraft(qa).length,
    durationMs,
  });
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

function printTable(rows) {
  const columns = [
    ["name", 22],
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
      console.log(`${row.name.padEnd(22)} ERROR: ${row.error}`);
      continue;
    }
    console.log(
      columns
        .map(([key, width]) => String(row[key] ?? "-").padEnd(width))
        .join(" "),
    );
    if (row.runnerCorrect === false) {
      console.log(`  ! runner mismatch: expected ${row.runnerExpected}, got ${row.runner}`);
    }
    if (row.mustReachMissing && row.mustReachMissing.length > 0) {
      console.log(`  ! not reached: ${row.mustReachMissing.join(", ")}`);
    }
  }
}

function printDeltas(baselineRows, currentRows) {
  console.log("\nDelta vs baseline (numeric metrics; negative blankActions/genericTitles is better):");
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
