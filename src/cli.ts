#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig, writeDefaultConfig } from "./config.js";
import { generateAgentContext } from "./context.js";
import { buildDoctorResult, formatDoctorReport } from "./doctor.js";
import { formatMarkdownReport, formatSarifReport, formatTextReport, hasFindingsAtOrAbove } from "./report.js";
import { scanProject } from "./scanner.js";
import { isSeverity } from "./severity.js";
import type { CodeWardConfig } from "./types.js";
import type { Severity } from "./types.js";
import { VERSION } from "./version.js";

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
    const loadedConfig = await loadConfig(options.path, options.config);
    const result = await scanProject(options.path, buildScanOptions(options, loadedConfig));
    const output = formatOutput(result, options.format ?? (options.json ? "json" : "text"));
    await printOrWrite(output, options.output);
    const failOn = options.failOn ?? loadedConfig.config.failOn;
    return failOn && hasFindingsAtOrAbove(result, failOn) ? 1 : 0;
  }

  if (command === "report") {
    const options = parseOptions(rest);
    const loadedConfig = await loadConfig(options.path, options.config);
    const result = await scanProject(options.path, buildScanOptions(options, loadedConfig));
    const output = formatOutput(result, options.format ?? (options.json ? "json" : "markdown"));
    await printOrWrite(output, options.output);
    const failOn = options.failOn ?? loadedConfig.config.failOn;
    return failOn && hasFindingsAtOrAbove(result, failOn) ? 1 : 0;
  }

  if (command === "doctor") {
    const options = parseOptions(rest);
    const loadedConfig = await loadConfig(options.path, options.config);
    const result = await scanProject(options.path, buildScanOptions(options, loadedConfig));
    const output = formatDoctorOutput(result, options.format ?? (options.json ? "json" : "text"));
    await printOrWrite(output, options.output);
    const failOn = options.failOn ?? loadedConfig.config.failOn;
    return failOn && hasFindingsAtOrAbove(result, failOn) ? 1 : 0;
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
  severityOverrides?: Record<string, Severity>;
} {
  return {
    configPath: loadedConfig.path,
    ignoreRules: loadedConfig.config.ignoreRules,
    maxFiles: options.maxFiles ?? loadedConfig.config.maxFiles,
    severityOverrides: loadedConfig.config.severity,
  };
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
  if (format !== "text") {
    throw new Error(`Doctor supports text or json output, not ${format}`);
  }
  return formatDoctorReport(result);
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
  codeward doctor [path] [--json] [--output <file>] [--fail-on <severity>]
  codeward context [path] [--write [file]] [--force]
  codeward init [path] [--write <file>] [--force]

Severities:
  info, low, medium, high

Formats:
  text, json, markdown, sarif

Examples:
  codeward scan .
  codeward scan . --format sarif --output codeward.sarif
  codeward scan . --fail-on medium
  codeward report . --output CODEWARD_REPORT.md
  codeward doctor .
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
