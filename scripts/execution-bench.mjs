#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateE2eDraft, runE2eScenario } from "../dist/index.js";
import { materializeFixtureRepo } from "./lib/fixture-repo.mjs";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const configPath = path.resolve(readArg("--config") ?? "execution-bench.config.json");
const keep = args.includes("--keep");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));

validateConfig(config);

const results = [];
console.log("# QAMap Execution Benchmark\n");

for (const contract of config.contracts) {
  let prepared;
  try {
    prepared = await materializeContract(contract);
    const draft = await generateE2eDraft(prepared.repositoryRoot, {
      base: "main",
      head: "HEAD",
      output: contract.output ?? "tests/e2e",
    });
    const compiledScenarios = draft.files.flatMap((file) =>
      file.scenarioAutomation
        .filter((receipt) => receipt.status === "compiled")
        .map((receipt) => receipt.title),
    );
    const generatedFiles = draft.files.map((file) => file.path);
    assertDraftContract(contract, generatedFiles, compiledScenarios);
    const artifactDigest = await digestFiles(prepared.repositoryRoot, generatedFiles);

    await runRequiredCommand(contract.installCommand, prepared.repositoryRoot, "dependency install");
    for (const command of contract.prepareCommands ?? []) {
      await runRequiredCommand(command, prepared.repositoryRoot, "runtime preparation");
    }

    const fixedBefore = await runCommand(contract.validateCommand, prepared.repositoryRoot);
    assertExpectedPass(contract, fixedBefore, "fixed head before regression");

    await copyLayer(prepared.fixtureRoot, contract.regressionOverlay, prepared.repositoryRoot);
    await assertArtifactDigest(prepared.repositoryRoot, generatedFiles, artifactDigest, "regression overlay");
    const regression = await runCommand(contract.validateCommand, prepared.repositoryRoot);
    assertExpectedFailure(contract, regression);
    await assertArtifactDigest(prepared.repositoryRoot, generatedFiles, artifactDigest, "regression run");
    const scenarioRegression = await runScenarioContract(contract, draft, prepared.repositoryRoot, "failed");

    await copyLayer(prepared.fixtureRoot, contract.fixedOverlay, prepared.repositoryRoot);
    await assertArtifactDigest(prepared.repositoryRoot, generatedFiles, artifactDigest, "fixed overlay");
    const fixedAfter = await runCommand(contract.validateCommand, prepared.repositoryRoot);
    assertExpectedPass(contract, fixedAfter, "restored fixed head");
    await assertArtifactDigest(prepared.repositoryRoot, generatedFiles, artifactDigest, "fixed run");
    const scenarioFixed = await runScenarioContract(contract, draft, prepared.repositoryRoot, "passed");
    if (scenarioRegression && scenarioFixed && scenarioFixed.comparison?.verdict !== "recovered") {
      throw new Error(
        `scenario run comparison expected recovered, got ${scenarioFixed.comparison?.verdict ?? "none"}`,
      );
    }

    results.push({
      name: contract.name,
      passed: true,
      compiledScenarios: compiledScenarios.length,
      generatedFiles: draft.files.length,
      artifactDigest: artifactDigest.slice(0, 12),
      regression: contract.regressionName,
      fixedEvidence: firstMatchingLine(fixedAfter.output, contract.fixedOutputIncludes),
      failureEvidence: firstMatchingLine(regression.output, contract.regressionOutputIncludes),
      scenarioRun: scenarioFixed
        ? {
            scenarioId: scenarioFixed.scenarioId,
            regression: scenarioRegression.receipt.status,
            fixed: scenarioFixed.receipt.status,
            verdict: scenarioFixed.comparison?.verdict,
            assertions: scenarioFixed.receipt.assertions.length,
          }
        : undefined,
      tempRoot: keep ? prepared.tempRoot : undefined,
    });
  } catch (error) {
    results.push({
      name: contract.name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
      tempRoot: keep ? prepared?.tempRoot : undefined,
    });
  } finally {
    if (prepared && !keep) {
      await fs.rm(prepared.tempRoot, { recursive: true, force: true });
    }
  }
}

for (const result of results) {
  if (!result.passed) {
    console.log(`- FAIL ${result.name}: ${result.error}`);
    if (result.tempRoot) console.log(`  kept: ${result.tempRoot}`);
    continue;
  }
  console.log(`- PASS ${result.name}`);
  console.log(`  generated: ${result.generatedFiles} file(s), ${result.compiledScenarios} compiled scenario(s)`);
  console.log(`  artifact unchanged: sha256:${result.artifactDigest}`);
  if (result.scenarioRun) {
    console.log(
      `  scenario run: ${result.scenarioRun.regression} on regression, ${result.scenarioRun.fixed} on fix, ` +
        `${result.scenarioRun.verdict} (${result.scenarioRun.assertions} assertion(s))`,
    );
  }
  console.log(`  regression caught: ${result.regression}`);
  if (result.failureEvidence) console.log(`  failure evidence: ${result.failureEvidence}`);
  if (result.fixedEvidence) console.log(`  fixed evidence: ${result.fixedEvidence}`);
  if (result.tempRoot) console.log(`  kept: ${result.tempRoot}`);
}

const failed = results.filter((result) => !result.passed);
console.log("");
console.log(
  `Summary: ${results.length - failed.length}/${results.length} contract(s) passed; ` +
  `${results.length - failed.length} seeded regression(s) caught.`,
);
if (failed.length > 0) process.exitCode = 1;

function readArg(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function validateConfig(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.contracts) || value.contracts.length === 0) {
    throw new Error("Execution benchmark config must use schemaVersion 1 and include contracts.");
  }
  for (const contract of value.contracts) {
    for (const field of [
      "name",
      "fixture",
      "regressionName",
      "regressionOverlay",
      "fixedOverlay",
    ]) {
      if (typeof contract[field] !== "string" || contract[field].trim().length === 0) {
        throw new Error(`Execution benchmark contract requires ${field}.`);
      }
    }
    if (
      contract.commitMessage !== undefined &&
      (typeof contract.commitMessage !== "string" || contract.commitMessage.trim().length === 0)
    ) {
      throw new Error("Execution benchmark commitMessage must be a non-empty string when provided.");
    }
    for (const field of ["installCommand", "validateCommand"]) {
      validateCommand(contract[field], field);
    }
    for (const command of contract.prepareCommands ?? []) {
      validateCommand(command, "prepareCommands");
    }
  }
}

function validateCommand(command, field) {
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`Execution benchmark ${field} must be a non-empty command array.`);
  }
}

async function materializeContract(contract) {
  const fixtureRoot = resolveInside(repositoryRoot, contract.fixture);
  const baseRoot = resolveInside(fixtureRoot, "base");
  const headRoot = resolveInside(fixtureRoot, "head");
  await requireDirectory(baseRoot);
  await requireDirectory(headRoot);

  const materialized = await materializeFixtureRepo({
    fixtureRoot,
    tempPrefix: "qamap-execution-bench-",
    baselineMessage: "execution benchmark baseline",
    identity: { name: "QAMap Execution Benchmark", email: "execution-benchmark@qamap.local" },
    commits: [{ dir: "head", message: contract.commitMessage ?? "execution benchmark change" }],
    git,
  });

  return { fixtureRoot, repositoryRoot: materialized.repositoryRoot, tempRoot: materialized.tempRoot };
}

function assertDraftContract(contract, generatedFiles, compiledScenarios) {
  const minimumGeneratedFiles = contract.minimumGeneratedFiles ?? 1;
  const minimumCompiledScenarios = contract.minimumCompiledScenarios ?? 1;
  if (generatedFiles.length < minimumGeneratedFiles) {
    throw new Error(`Generated ${generatedFiles.length} file(s); expected at least ${minimumGeneratedFiles}.`);
  }
  if (compiledScenarios.length < minimumCompiledScenarios) {
    throw new Error(
      `Compiled ${compiledScenarios.length} scenario(s); expected at least ${minimumCompiledScenarios}.`,
    );
  }
  for (const required of contract.mustCompileScenarios ?? []) {
    if (!compiledScenarios.includes(required)) {
      throw new Error(`Required compiled scenario was missing: ${required}`);
    }
  }
  for (const required of contract.mustGenerateFiles ?? []) {
    if (!generatedFiles.some((file) => normalizePath(file) === normalizePath(required))) {
      throw new Error(`Required generated file was missing: ${required}`);
    }
  }
}

async function runRequiredCommand(command, cwd, label) {
  const result = await runCommand(command, cwd);
  if (result.code !== 0) {
    throw new Error(`${label} failed (${formatCommand(command)}):\n${tail(result.output)}`);
  }
}

/**
 * Optional contract: execute the compiled scenario through qamap e2e run with the
 * contract's executor declaration and require the receipt status for this phase.
 * Proves the receipt itself tells the seeded regression from the fix.
 */
async function runScenarioContract(contract, draft, repositoryRoot, expectedStatus) {
  if (!contract.scenarioRun) {
    return undefined;
  }
  const receipt = draft.files
    .flatMap((file) => file.scenarioAutomation)
    .find((candidate) => candidate.title === contract.scenarioRun.scenarioTitle && candidate.status === "compiled");
  if (!receipt) {
    throw new Error(`scenario run could not find a compiled scenario titled ${contract.scenarioRun.scenarioTitle}`);
  }
  // Resolve the scenario from the committed range so its id stays stable while the
  // overlays change the working tree the executor actually runs against.
  const result = await runE2eScenario(repositoryRoot, receipt.scenarioId, {
    base: "main",
    head: "HEAD",
    includeWorkingTree: false,
    output: contract.output ?? "tests/e2e",
    config: { executors: { benchmark: contract.scenarioRun.executor }, fixtures: {}, scenarioFixtures: {} },
    executor: "benchmark",
  });
  if (result.receipt.status !== expectedStatus) {
    throw new Error(
      `scenario run expected ${expectedStatus} but received ${result.receipt.status}` +
        (result.receipt.status === "blocked" ? `: ${result.receipt.reason}` : ""),
    );
  }
  if (result.receipt.assertions.length === 0) {
    throw new Error("scenario run produced no assertions");
  }
  return result;
}

async function runCommand(command, cwd) {
  const [file, ...commandArgs] = command;
  try {
    const result = await execFileAsync(file, commandArgs, {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    return {
      code: 0,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

function assertExpectedPass(contract, result, phase) {
  if (result.code !== 0) {
    throw new Error(`${phase} unexpectedly failed:\n${tail(result.output)}`);
  }
  assertOutputIncludes(result.output, contract.fixedOutputIncludes ?? [], phase);
}

function assertExpectedFailure(contract, result) {
  if (result.code === 0) {
    throw new Error(`Seeded regression unexpectedly passed: ${contract.regressionName}`);
  }
  assertOutputIncludes(result.output, contract.regressionOutputIncludes ?? [], "seeded regression");
}

function assertOutputIncludes(output, expected, phase) {
  for (const value of expected) {
    if (!output.includes(value)) {
      throw new Error(`${phase} output did not include ${JSON.stringify(value)}:\n${tail(output)}`);
    }
  }
}

async function copyLayer(fixtureRoot, relativeLayer, targetRoot) {
  const layerRoot = resolveInside(fixtureRoot, relativeLayer);
  await requireDirectory(layerRoot);
  await fs.cp(layerRoot, targetRoot, { recursive: true, force: true });
}

async function digestFiles(root, files) {
  const hash = createHash("sha256");
  for (const relativeFile of [...files].sort()) {
    const normalized = normalizePath(relativeFile);
    hash.update(normalized);
    hash.update("\0");
    hash.update(await fs.readFile(resolveInside(root, relativeFile)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function assertArtifactDigest(root, files, expected, phase) {
  const actual = await digestFiles(root, files);
  if (actual !== expected) {
    throw new Error(`Generated artifact changed during ${phase}; expected ${expected}, received ${actual}.`);
  }
}

async function requireDirectory(directory) {
  const stats = await fs.stat(directory);
  if (!stats.isDirectory()) throw new Error(`Expected a directory: ${directory}`);
}

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes its allowed root: ${relativePath}`);
  }
  return resolved;
}

function firstMatchingLine(output, values = []) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => values.some((value) => line.includes(value)));
}

function tail(value, lineCount = 24) {
  return value.split(/\r?\n/).slice(-lineCount).join("\n").trim();
}

function formatCommand(command) {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

async function git(cwd, gitArgs) {
  const result = await runCommand(["git", ...gitArgs], cwd);
  if (result.code !== 0) throw new Error(`git ${gitArgs.join(" ")} failed:\n${tail(result.output)}`);
}
