#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, writeDefaultConfig } from "./config.js";
import { generateAgentContext } from "./context.js";
import { buildDoctorResult, formatDoctorReport, formatMarkdownDoctorReport } from "./doctor.js";
import { runGitHubAction } from "./github.js";
import { formatMarkdownReport, formatSarifReport, formatTextReport, hasFindingsAtOrAbove } from "./report.js";
import { formatMarkdownReviewReport, formatReviewReport, reviewProject } from "./review.js";
import { scanProject } from "./scanner.js";
import { isAtLeastSeverity, isSeverity } from "./severity.js";
import type { CodeWardConfig } from "./types.js";
import type { Severity } from "./types.js";
import { VERSION } from "./version.js";
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
    });
    return result.exitCode;
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

    if (arg === "--report-file") {
      options.reportFile = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--comment-file") {
      options.commentFile = readValue(args, ++index, arg);
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
  codeward github-action [path] [--mode auto|scan|review] [--base <ref>] [--head <ref>] [--fail-on <severity>]
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
  codeward github-action . --mode review --base origin/main --head HEAD --fail-on high
  codeward context . --write AGENTS.md
  codeward init .
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
