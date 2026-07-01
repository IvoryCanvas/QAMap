#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, writeDefaultConfig } from "./config.js";
import { generateAgentContext } from "./context.js";
import { defaultDomainManifestPath, writeDefaultDomainManifest } from "./domains.js";
import { buildDoctorResult, formatDoctorReport, formatMarkdownDoctorReport } from "./doctor.js";
import {
  formatMarkdownE2eDraft,
  formatMarkdownE2ePlan,
  formatMarkdownE2eSetup,
  generateE2eDraft,
  generateE2ePlan,
  setupE2eRunner,
} from "./e2e.js";
import { evaluateChangeReadiness, formatEvalReport, formatMarkdownEvalReport } from "./eval.js";
import { defaultFlowManifestPath, writeDefaultCoreFlowManifest } from "./flows.js";
import { runGitHubAction } from "./github.js";
import { formatLocalHistoryInitResult, initializeLocalHistory, recordE2ePlanHistory } from "./history.js";
import {
  defaultSuggestedDomainManifestPath,
  defaultSuggestedFlowManifestPath,
  formatDomainManifestSuggestion,
  formatFlowManifestSuggestion,
  generateDomainManifestSuggestion,
  generateFlowManifestSuggestion,
  writeSuggestedManifest,
} from "./manifest-suggestions.js";
import { formatMarkdownReport, formatSarifReport, formatTextReport, hasFindingsAtOrAbove } from "./report.js";
import { formatMarkdownReviewReport, formatReviewReport, reviewProject } from "./review.js";
import { scanProject } from "./scanner.js";
import { isAtLeastSeverity, isSeverity } from "./severity.js";
import { formatMarkdownTestPlan, generateTestPlan } from "./test-plan.js";
import { formatMarkdownVerifyReport, formatVerifyReport, verifyChange } from "./verify.js";
import type { CodeWardConfig } from "./types.js";
import type { Severity } from "./types.js";
import { VERSION } from "./version.js";
import type { E2eRunnerName } from "./e2e.js";
import type { GitHubActionMode } from "./github.js";

type OutputFormat = "text" | "json" | "markdown" | "sarif";

interface ParsedOptions {
  path: string;
  json: boolean;
  format?: OutputFormat;
  config?: string;
  output?: string;
  write?: string;
  force: boolean;
  failOn?: Severity;
  maxFiles?: number;
  workspaceRoot?: string;
  base?: string;
  head?: string;
  mode?: GitHubActionMode;
  reportFile?: string;
  commentFile?: string;
  annotations?: boolean;
  stepSummary?: boolean;
  testPlan?: boolean;
  testPlanFile?: string;
  evaluation?: boolean;
  evalFile?: string;
  prBodyFile?: string;
  includeWorkingTree?: boolean;
  e2eRunner?: E2eRunnerName;
  recordHistory?: boolean;
  dryRun?: boolean;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return 0;
  }

  if (command === "scan") {
    const options = parseOptions(rest);
    const loadedConfig = await loadOptionsConfig(options);
    const result = await scanProject(options.path, buildScanOptions(options, loadedConfig));
    const output = formatOutput(result, options.format ?? (options.json ? "json" : "text"));
    await printOrWrite(output, options.output);
    const failOn = options.failOn ?? loadedConfig.config.failOn;
    return failOn && hasFindingsAtOrAbove(result, failOn) ? 1 : 0;
  }

  if (command === "report") {
    const options = parseOptions(rest);
    const loadedConfig = await loadOptionsConfig(options);
    const result = await scanProject(options.path, buildScanOptions(options, loadedConfig));
    const output = formatOutput(result, options.format ?? (options.json ? "json" : "markdown"));
    await printOrWrite(output, options.output);
    const failOn = options.failOn ?? loadedConfig.config.failOn;
    return failOn && hasFindingsAtOrAbove(result, failOn) ? 1 : 0;
  }

  if (command === "doctor") {
    const options = parseOptions(rest);
    const loadedConfig = await loadOptionsConfig(options);
    const result = await scanProject(options.path, buildScanOptions(options, loadedConfig));
    const output = formatDoctorOutput(result, options.format ?? (options.json ? "json" : "text"));
    await printOrWrite(output, options.output);
    const failOn = options.failOn ?? loadedConfig.config.failOn;
    return failOn && hasFindingsAtOrAbove(result, failOn) ? 1 : 0;
  }

  if (command === "review") {
    const options = parseOptions(rest);
    const loadedConfig = await loadOptionsConfig(options);
    const result = await reviewProject(options.path, {
      base: options.base,
      head: options.head,
      scanOptions: buildScanOptions(options, loadedConfig),
    });
    const output = formatReviewOutput(result, options.format ?? (options.json ? "json" : "text"));
    await printOrWrite(output, options.output);
    const failOn = options.failOn ?? loadedConfig.config.failOn;
    const reviewFindings = [...result.newFindings, ...result.changedRiskyFindings];
    return failOn && reviewFindings.some((finding) => isAtLeastSeverity(finding.severity, failOn)) ? 1 : 0;
  }

  if (command === "verify") {
    const options = parseOptions(rest);
    const loadedConfig = await loadOptionsConfig(options);
    const result = await verifyChange(options.path, {
      base: options.base,
      head: options.head,
      scanOptions: buildScanOptions(options, loadedConfig),
      includeWorkingTree: options.includeWorkingTree,
      prBodyFile: options.prBodyFile,
      validationCommands: loadedConfig.config.validationCommands,
    });
    const output = formatVerifyOutput(result, options.format ?? (options.json ? "json" : "markdown"));
    await printOrWrite(output, options.output);
    const failOn = options.failOn ?? loadedConfig.config.failOn;
    const reviewFindings = [...result.review.newFindings, ...result.review.changedRiskyFindings];
    return failOn && reviewFindings.some((finding) => isAtLeastSeverity(finding.severity, failOn)) ? 1 : 0;
  }

  if (command === "github-action") {
    const options = parseOptions(rest);
    const loadedConfig = await loadOptionsConfig(options);
    const result = await runGitHubAction(options.path, {
      mode: options.mode,
      base: options.base,
      head: options.head,
      scanOptions: buildScanOptions(options, loadedConfig),
      failOn: options.failOn ?? loadedConfig.config.failOn,
      reportFile: options.reportFile,
      commentFile: options.commentFile,
      annotations: options.annotations,
      stepSummary: options.stepSummary,
      testPlan: options.testPlan,
      testPlanFile: options.testPlanFile,
      evaluation: options.evaluation,
      evalFile: options.evalFile,
      prBodyFile: options.prBodyFile,
      includeWorkingTree: options.includeWorkingTree,
      validationCommands: loadedConfig.config.validationCommands,
    });
    return result.exitCode;
  }

  if (command === "eval") {
    const options = parseOptions(rest);
    const loadedConfig = await loadOptionsConfig(options);
    const result = await evaluateChangeReadiness(options.path, {
      base: options.base,
      head: options.head,
      workspaceRoot: options.workspaceRoot,
      includeWorkingTree: options.includeWorkingTree,
      prBodyFile: options.prBodyFile,
      validationCommands: loadedConfig.config.validationCommands,
    });
    const output = formatEvalOutput(result, options.format ?? (options.json ? "json" : "markdown"));
    await printOrWrite(output, options.output);
    return 0;
  }

  if (command === "test-plan") {
    const options = parseOptions(rest);
    const loadedConfig = await loadOptionsConfig(options);
    const result = await generateTestPlan(options.path, {
      base: options.base,
      head: options.head,
      workspaceRoot: options.workspaceRoot,
      includeWorkingTree: options.includeWorkingTree,
      validationCommands: loadedConfig.config.validationCommands,
    });
    const output = formatTestPlanOutput(result, options.format ?? (options.json ? "json" : "markdown"));
    await printOrWrite(output, options.output);
    return 0;
  }

  if (command === "e2e") {
    const [subcommand, ...subcommandRest] = rest;
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printE2eHelp();
      return 0;
    }
    if (subcommand !== "plan" && subcommand !== "draft" && subcommand !== "setup") {
      throw new Error(`Unknown e2e subcommand: ${subcommand}`);
    }
    const options = parseOptions(subcommandRest);
    const loadedConfig = await loadOptionsConfig(options);
    const e2eOptions = {
      base: options.base,
      head: options.head,
      workspaceRoot: options.workspaceRoot,
      includeWorkingTree: options.includeWorkingTree,
      validationCommands: loadedConfig.config.validationCommands,
      runner: options.e2eRunner,
    };
    if (subcommand === "plan") {
      const result = await generateE2ePlan(options.path, e2eOptions);
      if (options.recordHistory) {
        result.localHistory = await recordE2ePlanHistory(options.workspaceRoot ?? options.path, result);
      }
      const output = formatE2ePlanOutput(result, options.format ?? (options.json ? "json" : "markdown"));
      await printOrWrite(output, options.output);
      return 0;
    }
    if (subcommand === "setup") {
      const result = await setupE2eRunner(options.path, {
        ...e2eOptions,
        force: options.force,
      });
      const output = formatE2eSetupOutput(result, options.format ?? (options.json ? "json" : "markdown"));
      await printOrWrite(output, options.output);
      return 0;
    }
    const result = await generateE2eDraft(options.path, {
      ...e2eOptions,
      output: options.output,
      force: options.force,
      dryRun: options.dryRun,
    });
    const output = formatE2eDraftOutput(result, options.format ?? (options.json ? "json" : "markdown"));
    console.log(output.trimEnd());
    return 0;
  }

  if (command === "history") {
    const [subcommand, ...subcommandRest] = rest;
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printHistoryHelp();
      return 0;
    }
    if (subcommand !== "init") {
      throw new Error(`Unknown history subcommand: ${subcommand}`);
    }
    const options = parseOptions(subcommandRest);
    const result = await initializeLocalHistory(options.path);
    if (options.json || options.format === "json") {
      await printOrWrite(`${JSON.stringify(result, null, 2)}\n`, options.output);
    } else {
      await printOrWrite(formatLocalHistoryInitResult(result), options.output);
    }
    return 0;
  }

  if (command === "flows") {
    const [subcommand, ...subcommandRest] = rest;
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printFlowsHelp();
      return 0;
    }
    if (subcommand !== "init" && subcommand !== "suggest") {
      throw new Error(`Unknown flows subcommand: ${subcommand}`);
    }
    const options = parseOptions(subcommandRest);
    if (subcommand === "suggest") {
      const loadedConfig = await loadOptionsConfig(options);
      const result = await generateFlowManifestSuggestion(options.path, {
        base: options.base,
        head: options.head,
        workspaceRoot: options.workspaceRoot,
        includeWorkingTree: options.includeWorkingTree,
        validationCommands: loadedConfig.config.validationCommands,
      });
      const format = options.format ?? (options.json ? "json" : "text");
      const output = formatFlowManifestSuggestion(result, manifestSuggestionFormat(format, "flows"));
      if (options.write) {
        const manifestRoot = options.workspaceRoot ?? options.path;
        const writePath = await writeSuggestedManifest(
          manifestRoot,
          manifestWritePath(options.write, defaultSuggestedFlowManifestPath),
          result.yaml,
          options.force,
        );
        await printOrWrite(`Wrote ${writePath}\nReview this generated core flow manifest before committing it.\n`, options.output);
      } else {
        await printOrWrite(output, options.output);
      }
      return 0;
    }
    const outputPath = await writeDefaultCoreFlowManifest(
      options.path,
      options.write ?? defaultFlowManifestPath,
      options.force,
    );
    if (options.json || options.format === "json") {
      await printOrWrite(`${JSON.stringify({ path: outputPath }, null, 2)}\n`, options.output);
    } else {
      await printOrWrite(
        `Wrote ${outputPath}\nCommit this file when the flow definitions should become team policy.\n`,
        options.output,
      );
    }
    return 0;
  }

  if (command === "domains") {
    const [subcommand, ...subcommandRest] = rest;
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printDomainsHelp();
      return 0;
    }
    if (subcommand !== "init" && subcommand !== "suggest") {
      throw new Error(`Unknown domains subcommand: ${subcommand}`);
    }
    const options = parseOptions(subcommandRest);
    if (subcommand === "suggest") {
      const loadedConfig = await loadOptionsConfig(options);
      const result = await generateDomainManifestSuggestion(options.path, {
        base: options.base,
        head: options.head,
        workspaceRoot: options.workspaceRoot,
        includeWorkingTree: options.includeWorkingTree,
        validationCommands: loadedConfig.config.validationCommands,
      });
      const format = options.format ?? (options.json ? "json" : "text");
      const output = formatDomainManifestSuggestion(result, manifestSuggestionFormat(format, "domains"));
      if (options.write) {
        const manifestRoot = options.workspaceRoot ?? options.path;
        const writePath = await writeSuggestedManifest(
          manifestRoot,
          manifestWritePath(options.write, defaultSuggestedDomainManifestPath),
          result.yaml,
          options.force,
        );
        await printOrWrite(`Wrote ${writePath}\nReview this generated domain manifest before committing it.\n`, options.output);
      } else {
        await printOrWrite(output, options.output);
      }
      return 0;
    }
    const outputPath = await writeDefaultDomainManifest(
      options.path,
      options.write ?? defaultDomainManifestPath,
      options.force,
    );
    if (options.json || options.format === "json") {
      await printOrWrite(`${JSON.stringify({ path: outputPath }, null, 2)}\n`, options.output);
    } else {
      await printOrWrite(
        `Wrote ${outputPath}\nCommit this file when the domain definitions should become team policy.\n`,
        options.output,
      );
    }
    return 0;
  }

  if (command === "context") {
    const options = parseOptions(rest);
    const context = await generateAgentContext(options.path);
    if (options.write) {
      const outputPath = path.resolve(options.path, options.write);
      if (!options.force) {
        try {
          await fs.access(outputPath);
          throw new Error(`Refusing to overwrite ${outputPath}. Pass --force to replace it.`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("Refusing")) {
            throw error;
          }
        }
      }
      await fs.writeFile(outputPath, context, "utf8");
      console.log(`Wrote ${outputPath}`);
    } else {
      console.log(context);
    }
    return 0;
  }

  if (command === "init") {
    const options = parseOptions(rest);
    const outputPath = await writeDefaultConfig(options.path, options.write ?? "codeward.config.json", options.force);
    console.log(`Wrote ${outputPath}`);
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseOptions(args: string[]): ParsedOptions {
  const options: ParsedOptions = {
    path: ".",
    json: false,
    force: false,
  };

  let sawPath = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      options.json = true;
      options.format = "json";
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--output" || arg === "-o") {
      options.output = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--format") {
      const value = readValue(args, ++index, arg);
      if (!isOutputFormat(value)) {
        throw new Error(`Invalid format for --format: ${value}`);
      }
      options.format = value;
      continue;
    }

    if (arg === "--config") {
      options.config = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--workspace-root") {
      options.workspaceRoot = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--write") {
      const next = args[index + 1];
      if (next && !next.startsWith("-")) {
        options.write = next;
        index += 1;
      } else {
        options.write = "AGENTS.md";
      }
      continue;
    }

    if (arg === "--fail-on") {
      const value = readValue(args, ++index, arg);
      if (!isSeverity(value)) {
        throw new Error(`Invalid severity for --fail-on: ${value}`);
      }
      options.failOn = value;
      continue;
    }

    if (arg === "--base") {
      options.base = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--head") {
      options.head = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--mode") {
      const value = readValue(args, ++index, arg);
      if (!isGitHubActionMode(value)) {
        throw new Error(`Invalid mode for --mode: ${value}`);
      }
      options.mode = value;
      continue;
    }

    if (arg === "--runner") {
      const value = readValue(args, ++index, arg);
      if (!isE2eRunnerName(value)) {
        throw new Error(`Invalid runner for --runner: ${value}`);
      }
      options.e2eRunner = value;
      continue;
    }

    if (arg === "--report-file") {
      options.reportFile = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--comment-file") {
      options.commentFile = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--test-plan-file") {
      options.testPlanFile = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--eval-file") {
      options.evalFile = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--pr-body-file") {
      options.prBodyFile = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--no-annotations") {
      options.annotations = false;
      continue;
    }

    if (arg === "--no-step-summary") {
      options.stepSummary = false;
      continue;
    }

    if (arg === "--test-plan") {
      options.testPlan = true;
      continue;
    }

    if (arg === "--no-test-plan") {
      options.testPlan = false;
      continue;
    }

    if (arg === "--eval") {
      options.evaluation = true;
      continue;
    }

    if (arg === "--no-eval") {
      options.evaluation = false;
      continue;
    }

    if (arg === "--include-working-tree") {
      options.includeWorkingTree = true;
      continue;
    }

    if (arg === "--record-history") {
      options.recordHistory = true;
      continue;
    }

    if (arg === "--max-files") {
      const value = Number.parseInt(readValue(args, ++index, arg), 10);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error("--max-files must be a positive integer");
      }
      options.maxFiles = value;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (sawPath) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    options.path = arg;
    sawPath = true;
  }

  return options;
}

function buildScanOptions(
  options: ParsedOptions,
  loadedConfig: { path?: string; config: CodeWardConfig },
): {
  configPath?: string;
  ignoreRules?: string[];
  maxFiles?: number;
  workspaceRoot?: string;
  severityOverrides?: Record<string, Severity>;
} {
  return {
    configPath: loadedConfig.path,
    ignoreRules: loadedConfig.config.ignoreRules,
    maxFiles: options.maxFiles ?? loadedConfig.config.maxFiles,
    workspaceRoot: options.workspaceRoot,
    severityOverrides: loadedConfig.config.severity,
  };
}

async function loadOptionsConfig(options: ParsedOptions): Promise<{ path?: string; config: CodeWardConfig }> {
  return loadConfig(options.workspaceRoot ?? options.path, options.config);
}

function formatOutput(result: Awaited<ReturnType<typeof scanProject>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "markdown") {
    return formatMarkdownReport(result);
  }
  if (format === "sarif") {
    return formatSarifReport(result);
  }
  return formatTextReport(result);
}

function formatDoctorOutput(result: Awaited<ReturnType<typeof scanProject>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(buildDoctorResult(result), null, 2)}\n`;
  }
  if (format === "markdown") {
    return formatMarkdownDoctorReport(result);
  }
  if (format !== "text") {
    throw new Error(`Doctor supports text, json, or markdown output, not ${format}`);
  }
  return formatDoctorReport(result);
}

function formatReviewOutput(result: Awaited<ReturnType<typeof reviewProject>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "markdown") {
    return formatMarkdownReviewReport(result);
  }
  if (format !== "text") {
    throw new Error(`Review supports text, json, or markdown output, not ${format}`);
  }
  return formatReviewReport(result);
}

function formatTestPlanOutput(result: Awaited<ReturnType<typeof generateTestPlan>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format !== "markdown" && format !== "text") {
    throw new Error(`Test plan supports text, json, or markdown output, not ${format}`);
  }
  return formatMarkdownTestPlan(result);
}

function formatE2ePlanOutput(result: Awaited<ReturnType<typeof generateE2ePlan>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format !== "markdown" && format !== "text") {
    throw new Error(`E2E plan supports text, json, or markdown output, not ${format}`);
  }
  return formatMarkdownE2ePlan(result);
}

function formatE2eDraftOutput(result: Awaited<ReturnType<typeof generateE2eDraft>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format !== "markdown" && format !== "text") {
    throw new Error(`E2E draft supports text, json, or markdown output, not ${format}`);
  }
  return formatMarkdownE2eDraft(result);
}

function formatE2eSetupOutput(result: Awaited<ReturnType<typeof setupE2eRunner>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format !== "markdown" && format !== "text") {
    throw new Error(`E2E setup supports text, json, or markdown output, not ${format}`);
  }
  return formatMarkdownE2eSetup(result);
}

function manifestSuggestionFormat(format: OutputFormat, command: "domains" | "flows"): "text" | "json" | "markdown" {
  if (format === "sarif") {
    throw new Error(`${command} suggest supports text, json, or markdown output, not sarif`);
  }
  return format;
}

function manifestWritePath(writeOption: string, defaultPath: string): string {
  return writeOption === "AGENTS.md" ? defaultPath : writeOption;
}

function formatEvalOutput(result: Awaited<ReturnType<typeof evaluateChangeReadiness>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "markdown") {
    return formatMarkdownEvalReport(result);
  }
  if (format !== "text") {
    throw new Error(`Eval supports text, json, or markdown output, not ${format}`);
  }
  return formatEvalReport(result);
}

function formatVerifyOutput(result: Awaited<ReturnType<typeof verifyChange>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "markdown") {
    return formatMarkdownVerifyReport(result);
  }
  if (format !== "text") {
    throw new Error(`Verify supports text, json, or markdown output, not ${format}`);
  }
  return formatVerifyReport(result);
}

async function printOrWrite(output: string, outputPath?: string): Promise<void> {
  if (outputPath) {
    const resolvedOutputPath = path.resolve(outputPath);
    await fs.writeFile(resolvedOutputPath, output, "utf8");
    console.log(`Wrote ${resolvedOutputPath}`);
  } else {
    console.log(output.trimEnd());
  }
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === "text" || value === "json" || value === "markdown" || value === "sarif";
}

function isGitHubActionMode(value: string): value is GitHubActionMode {
  return value === "auto" || value === "scan" || value === "review";
}

function isE2eRunnerName(value: string): value is E2eRunnerName {
  return value === "maestro" || value === "playwright" || value === "manual";
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp(): void {
  console.log(`CodeWard ${VERSION}

Guardrails for AI coding agents and the code they change.

Usage:
  codeward scan [path] [--format <format>] [--fail-on <severity>] [--max-files <n>]
  codeward report [path] [--format <format>] [--output <file>] [--fail-on <severity>]
  codeward doctor [path] [--format <format>] [--output <file>] [--fail-on <severity>]
  codeward review [path] [--base <ref>] [--head <ref>] [--format <format>] [--fail-on <severity>]
  codeward verify [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--pr-body-file <file>] [--fail-on <severity>]
  codeward eval [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--pr-body-file <file>] [--format <format>]
  codeward github-action [path] [--mode auto|scan|review] [--base <ref>] [--head <ref>] [--fail-on <severity>]
  codeward test-plan [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format <format>] [--output <file>]
  codeward e2e plan [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--record-history] [--format <format>]
  codeward e2e setup [path] [--workspace-root <path>] [--runner maestro|playwright] [--force]
  codeward e2e draft [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--runner maestro|playwright|manual] [--output <dir>] [--dry-run] [--force]
  codeward flows init [path] [--write <file>] [--force]
  codeward flows suggest [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format <format>] [--output <file>] [--write <file>] [--force]
  codeward domains init [path] [--write <file>] [--force]
  codeward domains suggest [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format <format>] [--output <file>] [--write <file>] [--force]
  codeward history init [path]
  codeward context [path] [--write [file]] [--force]
  codeward init [path] [--write <file>] [--force]

Severities:
  info, low, medium, high

Formats:
  text, json, markdown, sarif

Examples:
  codeward scan .
  codeward scan services/offer --workspace-root .
  codeward scan . --format sarif --output codeward.sarif
  codeward scan . --fail-on medium
  codeward report . --output CODEWARD_REPORT.md
  codeward doctor .
  codeward review . --base origin/main --head HEAD
  codeward verify . --base origin/main --head HEAD --pr-body-file pr-body.md
  codeward eval . --base origin/main --head HEAD --pr-body-file pr-body.md
  codeward github-action . --mode review --base origin/main --head HEAD --fail-on high
  codeward test-plan . --base origin/main --head HEAD
  codeward e2e plan . --base origin/main --head HEAD
  codeward e2e plan . --base origin/main --head HEAD --record-history
  codeward e2e setup . --runner playwright
  codeward e2e draft . --base origin/main --head HEAD --dry-run
  codeward flows init .
  codeward flows suggest . --base origin/main --head HEAD
  codeward domains init .
  codeward domains suggest . --base origin/main --head HEAD
  codeward history init .
  codeward test-plan services/offer --workspace-root . --base origin/main --head HEAD --include-working-tree
  codeward context . --write AGENTS.md
  codeward init .
`);
}

function printE2eHelp(): void {
  console.log(`CodeWard ${VERSION}

E2E planning for AI-assisted changes.

Usage:
  codeward e2e plan [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--record-history] [--format <format>] [--output <file>]
  codeward e2e setup [path] [--workspace-root <path>] [--runner maestro|playwright] [--force] [--format <format>] [--output <file>]
  codeward e2e draft [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--runner maestro|playwright|manual] [--output <dir>] [--dry-run] [--force]

Examples:
  codeward e2e plan . --base origin/main --head HEAD
  codeward e2e plan . --base origin/main --head HEAD --record-history
  codeward e2e setup . --runner playwright
  codeward e2e setup apps/mobile --workspace-root . --runner maestro
  codeward e2e draft . --base origin/main --head HEAD --dry-run
  codeward e2e plan apps/mobile --workspace-root . --include-working-tree
`);
}

function printHistoryHelp(): void {
  console.log(`CodeWard ${VERSION}

Local history for CodeWard analysis runs.

Usage:
  codeward history init [path] [--json] [--output <file>]

Examples:
  codeward history init .
`);
}

function printFlowsHelp(): void {
  console.log(`CodeWard ${VERSION}

Core flow definitions for project-specific E2E planning.

Usage:
  codeward flows init [path] [--write <file>] [--force]
  codeward flows suggest [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format text|json|markdown] [--output <file>] [--write <file>] [--force]

Examples:
  codeward flows init .
  codeward flows suggest . --base origin/main --head HEAD
  codeward flows suggest services/offer --workspace-root . --include-working-tree
`);
}

function printDomainsHelp(): void {
  console.log(`CodeWard ${VERSION}

Domain definitions for project-specific E2E naming and route hints.

Usage:
  codeward domains init [path] [--write <file>] [--force]
  codeward domains suggest [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format text|json|markdown] [--output <file>] [--write <file>] [--force]

Examples:
  codeward domains init .
  codeward domains suggest . --base origin/main --head HEAD
  codeward domains suggest services/offer --workspace-root . --include-working-tree
`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`CodeWard error: ${message}`);
    process.exitCode = 1;
  });
