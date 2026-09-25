#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAgentRecoveryReport } from "./agent-report.js";
import { formatLocalQaReportReceipt, writeLocalQaReport } from "./qa-report.js";
import { buildQaBrief, qaBriefMinimumBytes } from "./qa-brief.js";
import { readReviewEvidencePage } from "./qa-evidence-read.js";
import { loadConfig, writeDefaultConfig } from "./config.js";
import { formatAgentInitReport, initAgentSetup } from "./agent-init.js";
import { consentRoot, formatConsentChange, formatConsentRequired, formatConsentStatus, grantConsent, readConsentStatus, revokeConsent } from "./agent-consent.js";
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
import {
  analyzeVerificationManifestContext,
  defaultVerificationManifestPath,
  explainVerificationManifest,
  formatVerificationManifestContextResult,
  formatVerificationManifestExplainResult,
  formatVerificationManifestInitResult,
  formatVerificationManifestValidationResult,
  validateVerificationManifest,
  writeVerificationManifestBaseline,
} from "./manifest.js";
import { formatMarkdownReport, formatSarifReport, formatTextReport, hasFindingsAtOrAbove } from "./report.js";
import {
  formatAgentQaDraft,
  formatAgentQaFullReport,
  formatMarkdownQaDraft,
  formatTextQaDraft,
  generateQaDraft,
} from "./qa.js";
import { formatMarkdownQaValidation, runQaValidation } from "./qa-execution.js";
import { formatMarkdownReviewReport, formatReviewReport, reviewProject } from "./review.js";
import { scanProject } from "./scanner.js";
import { formatQaScriptInitReport, initializeQaScripts } from "./script-init.js";
import { isAtLeastSeverity, isSeverity } from "./severity.js";
import { formatMarkdownTestPlan, generateTestPlan } from "./test-plan.js";
import { colorizeReport, shouldColorize } from "./terminal.js";
import { formatMarkdownVerifyReport, formatVerifyReport, verifyChange } from "./verify.js";
import type { QAMapConfig } from "./types.js";
import type { Severity } from "./types.js";
import { VERSION } from "./version.js";
import type { E2eRunnerName } from "./e2e.js";
import { formatMarkdownE2eRun, runE2eScenario } from "./e2e-run.js";
import type { GitHubActionMode } from "./github.js";

type OutputFormat = "text" | "json" | "markdown" | "sarif" | "agent";

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
  maxBytes?: number;
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
  manifestPath?: string;
  recordHistory?: boolean;
  dryRun?: boolean;
  agent?: boolean;
  reviewMode?: "ask" | "report";
  handoff?: boolean;
  scripts?: boolean;
  timeoutMs?: number;
  executor?: string;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command) {
    printStartHere();
    return 0;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    if (rest.includes("--all") || rest.includes("all")) {
      printFullHelp();
    } else {
      printHelp();
    }
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
      manifestPath: options.manifestPath,
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
    if (subcommand !== "plan" && subcommand !== "draft" && subcommand !== "setup" && subcommand !== "run") {
      throw new Error(`Unknown e2e subcommand: ${subcommand}`);
    }
    // e2e run takes the scenario id as its first positional before the optional path
    const scenarioId = subcommand === "run" ? subcommandRest[0] : undefined;
    if (subcommand === "run" && (!scenarioId || scenarioId.startsWith("-"))) {
      throw new Error("e2e run requires a scenario id, for example: qamap e2e run scenario:1a2b3c4d5e6f");
    }
    const options = parseOptions(subcommand === "run" ? subcommandRest.slice(1) : subcommandRest);
    const loadedConfig = await loadOptionsConfig(options);
    const e2eOptions = {
      base: options.base,
      head: options.head,
      workspaceRoot: options.workspaceRoot,
      includeWorkingTree: options.includeWorkingTree,
      validationCommands: loadedConfig.config.validationCommands,
      runner: options.e2eRunner,
      manifestPath: options.manifestPath,
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
    if (subcommand === "run") {
      const result = await runE2eScenario(options.path, scenarioId as string, {
        ...e2eOptions,
        config: loadedConfig.config,
        executor: options.executor,
        timeoutMs: options.timeoutMs,
        output: options.output,
      });
      const format = options.format ?? (options.json ? "json" : "markdown");
      if (format !== "json" && format !== "markdown") {
        throw new Error(`e2e run supports json or markdown output, not ${format}`);
      }
      const output = format === "json" ? `${JSON.stringify(result, null, 2)}\n` : formatMarkdownE2eRun(result);
      console.log(output.trimEnd());
      return e2eRunExitCode(result.receipt);
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

  if (command === "qa") {
    if (rest[0] === "brief") {
      if (rest.includes("--help") || rest.includes("-h")) { printQaHelp(); return 0; }
      const requireConsent = rest.includes("--require-consent");
      const options = parseOptions(rest.slice(1).filter((arg) => arg !== "--require-consent"));
      if (requireConsent) {
        // Checked before any analysis, so an unconsented agent run reads nothing from the repository.
        const status = await readConsentStatus(await consentRoot(options.path));
        if (status.effective !== "automatic") {
          process.stdout.write(formatConsentRequired(status));
          return 0;
        }
      }
      const loadedConfig = await loadOptionsConfig(options);
      const result = await generateQaDraft(options.path, {
        base: options.base,
        head: options.head,
        workspaceRoot: options.workspaceRoot,
        includeWorkingTree: options.includeWorkingTree,
        validationCommands: loadedConfig.config.validationCommands,
        runner: options.e2eRunner,
        manifestPath: options.manifestPath,
        config: loadedConfig.config,
      });
      const receipt = await writeLocalQaReport(result, options.output);
      process.stdout.write(await buildQaBrief(result, { maxBytes: options.maxBytes, reportFile: receipt.files.report }));
      return 0;
    }
    if (rest[0] === "read") {
      if (rest.includes("--help") || rest.includes("-h")) { printQaHelp(); return 0; }
      process.stdout.write(await readReviewEvidencePage(rest.slice(1)));
      return 0;
    }
    const localReport = rest[0] === "report";
    if (rest[0] === "help" || rest[0] === "--help" || rest[0] === "-h" ||
      (localReport && rest.some((arg) => arg === "--help" || arg === "-h"))) {
      printQaHelp();
      return 0;
    }
    const runValidation = rest[0] === "run";
    const options = parseOptions(runValidation || localReport ? rest.slice(1) : rest, localReport);
    const format = options.format ?? (options.json ? "json" :
      options.handoff || localReport && !process.stdout.isTTY ? "json" : "text");
    if (options.handoff && format !== "json" && format !== "agent") {
      throw new Error("qa report --handoff supports json or agent output only.");
    }
    if (localReport && format !== "text" && format !== "json" && format !== "agent") {
      throw new Error(`qa report supports text, json, or agent receipts, not ${format}`);
    }
    const loadedConfig = await loadOptionsConfig(options);
    const qaOptions = {
      base: options.base,
      head: options.head,
      workspaceRoot: options.workspaceRoot,
      includeWorkingTree: options.includeWorkingTree,
      validationCommands: loadedConfig.config.validationCommands,
      runner: options.e2eRunner,
      manifestPath: options.manifestPath,
      config: loadedConfig.config,
    };
    const streamCommandOutput = runValidation &&
      !options.output &&
      (format === "markdown" || format === "text");
    const result = runValidation
      ? await runQaValidation(options.path, {
          ...qaOptions,
          timeoutMs: options.timeoutMs,
          ...(streamCommandOutput
            ? {
                onStdout: (chunk: Uint8Array) => process.stdout.write(chunk),
                onStderr: (chunk: Uint8Array) => process.stderr.write(chunk),
              }
            : {}),
        })
      : await generateQaDraft(options.path, qaOptions);
    if (localReport) {
      if (options.handoff) {
        const handoff = await writeLocalQaReport(result, options.output, { handoff: true });
        process.stdout.write(`${JSON.stringify(handoff)}\n`);
        return 0;
      }
      const receipt = await writeLocalQaReport(result, options.output);
      process.stdout.write(formatLocalQaReportReceipt(receipt, format === "text"));
      return 0;
    }
    if (streamCommandOutput && result.execution.performed) {
      console.log("");
    }
    const output = runValidation && (format === "markdown" || format === "text")
      ? formatMarkdownQaValidation(result)
      : formatQaDraftOutput(result, format);
    await printOrWrite(output, options.output);
    return runValidation ? qaValidationExitCode(result.execution) : 0;
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

  if (command === "manifest") {
    const [subcommand, ...subcommandRest] = rest;
    if (!subcommand || subcommand === "--help" || subcommand === "-h") {
      printManifestHelp();
      return 0;
    }
    if (subcommand !== "init" && subcommand !== "validate" && subcommand !== "explain" && subcommand !== "context") {
      throw new Error(`Unknown manifest subcommand: ${subcommand}`);
    }
    const options = parseOptions(subcommandRest);
    if (subcommand === "validate") {
      const result = await validateVerificationManifest(options.path, options.workspaceRoot, options.manifestPath);
      const format = manifestCommandFormat(options.format ?? (options.json ? "json" : "text"));
      await printOrWrite(formatVerificationManifestValidationResult(result, format), options.output);
      return result.status === "invalid" || result.status === "missing" ? 1 : 0;
    }
    if (subcommand === "explain") {
      const loadedConfig = await loadOptionsConfig(options);
      const result = await explainVerificationManifest(options.path, {
        base: options.base,
        head: options.head,
        workspaceRoot: options.workspaceRoot,
        includeWorkingTree: options.includeWorkingTree,
        validationCommands: loadedConfig.config.validationCommands,
        manifestPath: options.manifestPath,
      });
      const format = manifestCommandFormat(options.format ?? (options.json ? "json" : "markdown"));
      await printOrWrite(formatVerificationManifestExplainResult(result, format), options.output);
      return 0;
    }
    if (subcommand === "context") {
      const result = await analyzeVerificationManifestContext(options.path, {
        workspaceRoot: options.workspaceRoot,
        maxFiles: options.maxFiles,
      });
      const format = manifestCommandFormat(options.format ?? (options.json ? "json" : "markdown"));
      await printOrWrite(formatVerificationManifestContextResult(result, format), options.output);
      return 0;
    }
    const result = await writeVerificationManifestBaseline(options.path, {
      workspaceRoot: options.workspaceRoot,
      write: options.write ?? defaultVerificationManifestPath,
      force: options.force,
      maxFiles: options.maxFiles,
    });
    if (options.json || options.format === "json") {
      await printOrWrite(`${JSON.stringify(result, null, 2)}\n`, options.output);
    } else {
      await printOrWrite(formatVerificationManifestInitResult(result), options.output);
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

  if (command === "consent") {
    const [action, ...consentArgs] = rest;
    if (action !== "status" && action !== "grant" && action !== "revoke") throw new Error("Usage: qamap consent status|grant|revoke [path] [--global]");
    const global = consentArgs.includes("--global");
    const paths = consentArgs.filter((arg) => arg !== "--global");
    const unknown = paths.find((arg) => arg.startsWith("-"));
    if (unknown) throw new Error(`Unknown consent option: ${unknown}`);
    if (paths.length > 1) throw new Error("qamap consent accepts one path.");
    const root = await consentRoot(paths[0] ?? ".");
    if (action === "status") {
      if (global) throw new Error("qamap consent status reports both scopes; omit --global.");
      console.log(formatConsentStatus(await readConsentStatus(root)));
      return 0;
    }
    const change = action === "grant" ? await grantConsent(root, { global }) : await revokeConsent(root, { global });
    console.log(formatConsentChange(change));
    return 0;
  }

  if (command === "init") {
    const options = parseOptions(rest, false, true);
    if (options.reviewMode && !options.agent) throw new Error("--review-mode requires init --agent.");
    if (options.agent && options.scripts) {
      throw new Error("Choose either --agent or --scripts for one init run.");
    }
    if (options.agent) {
      const result = await initAgentSetup(options.path, { force: options.force, reviewMode: options.reviewMode });
      await printOrWrite(formatAgentInitReport(result));
      return 0;
    }
    if (options.scripts) {
      const result = await initializeQaScripts(options.path, { force: options.force });
      await printOrWrite(formatQaScriptInitReport(result));
      return 0;
    }
    const outputPath = await writeDefaultConfig(options.path, options.write ?? "qamap.config.json", options.force);
    console.log(`Wrote ${outputPath}`);
    return 0;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseOptions(args: string[], allowHandoff = false, allowReviewMode = false): ParsedOptions {
  const options: ParsedOptions = {
    path: ".",
    json: false,
    force: false,
  };

  let sawPath = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--review-mode") {
      if (!allowReviewMode) throw new Error("--review-mode is only available with init --agent.");
      const value = args[++index];
      if (value !== "ask" && value !== "report") throw new Error("--review-mode must be ask or report.");
      options.reviewMode = value;
      continue;
    }

    if (arg === "--handoff") {
      if (!allowHandoff) throw new Error("--handoff is only available with qa report.");
      options.handoff = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      options.format = "json";
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    if (arg === "--agent") {
      options.agent = true;
      continue;
    }

    if (arg === "--scripts") {
      options.scripts = true;
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

    if (arg === "--manifest") {
      options.manifestPath = readValue(args, ++index, arg);
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

    if (arg === "--max-bytes") {
      const value = Number.parseInt(readValue(args, ++index, arg), 10);
      if (!Number.isFinite(value) || value < qaBriefMinimumBytes) {
        throw new Error(`--max-bytes must be an integer of at least ${qaBriefMinimumBytes}`);
      }
      options.maxBytes = value;
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

    if (arg === "--executor") {
      options.executor = readValue(args, ++index, arg);
      continue;
    }

    if (arg === "--timeout-ms") {
      const value = Number.parseInt(readValue(args, ++index, arg), 10);
      if (!Number.isFinite(value) || value < 1_000) {
        throw new Error("--timeout-ms must be an integer of at least 1000");
      }
      options.timeoutMs = value;
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
  loadedConfig: { path?: string; config: QAMapConfig },
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

async function loadOptionsConfig(options: ParsedOptions): Promise<{ path?: string; config: QAMapConfig }> {
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
  if (format !== "text") {
    throw new Error(`Scan supports text, json, markdown, or sarif output, not ${format}`);
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

function formatQaDraftOutput(result: Awaited<ReturnType<typeof generateQaDraft>>, format: OutputFormat): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  if (format === "agent") {
    // Write the pre-compaction summary next to the system temp directory so a
    // consuming agent can recover omitted traces, scenarios, and flows without
    // re-running the analysis. The analyzed repository itself stays untouched.
    // Best effort: when the write fails the payload simply omits the pointer.
    const digest = createHash("sha256")
      .update(`${result.root}\0${result.base}\0${result.head}`)
      .digest("hex")
      .slice(0, 12);
    const nonce = randomBytes(6).toString("hex");
    const fullReportPath = path.join(
      os.tmpdir(),
      `qamap-qa-agent-full-${digest}-${nonce}.json`,
    );
    try {
      writeAgentRecoveryReport(fullReportPath, formatAgentQaFullReport(result));
      return formatAgentQaDraft(result, { fullReportPath });
    } catch {
      return formatAgentQaDraft(result);
    }
  }
  if (format !== "markdown" && format !== "text") {
    throw new Error(`QA draft supports text, json, markdown, or agent output, not ${format}`);
  }
  return format === "markdown" ? formatMarkdownQaDraft(result) : formatTextQaDraft(result);
}

function e2eRunExitCode(receipt: Awaited<ReturnType<typeof runE2eScenario>>["receipt"]): number {
  if (receipt.status === "passed") return 0;
  return receipt.status === "blocked" ? 2 : 1;
}

function qaValidationExitCode(
  execution: Awaited<ReturnType<typeof runQaValidation>>["execution"],
): number {
  if (execution.status === "passed") {
    return 0;
  }
  if (execution.status === "failed" && execution.exitCode && execution.exitCode > 0 && execution.exitCode < 126) {
    return execution.exitCode;
  }
  return execution.status === "blocked" ? 2 : 1;
}

function manifestSuggestionFormat(format: OutputFormat, command: "domains" | "flows"): "text" | "json" | "markdown" {
  if (format === "sarif" || format === "agent") {
    throw new Error(`${command} suggest supports text, json, or markdown output, not ${format}`);
  }
  return format;
}

function manifestCommandFormat(format: OutputFormat): "text" | "json" | "markdown" {
  if (format === "sarif" || format === "agent") {
    throw new Error(`manifest supports text, json, or markdown output, not ${format}`);
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
    console.log(shouldColorize() ? colorizeReport(output.trimEnd()) : output.trimEnd());
  }
}

function isOutputFormat(value: string): value is OutputFormat {
  return value === "text" || value === "json" || value === "markdown" || value === "sarif" || value === "agent";
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

function printStartHere(): void {
  console.log(`QAMap ${VERSION} — local zero-LLM PR QA design from commit intent and code diffs.

Start here, from inside your repository, on the branch you want to check:

  qamap qa
      What did this branch intend to change, and what should it prove before
      merge? Prints a concise change, scenario, evidence, and next-action
      summary. Add --format markdown for the complete reasoning trace.
      The base branch defaults to origin/main (then main); override with
      --base <ref> --head <ref>.

  qamap qa --format agent
      Print the same QA judgment as compact JSON, including scenario-level
      file and line sources, for an agent or PR workflow.

  qamap qa run
      Re-analyze the change and execute only the exact existing repository
      validation command selected by QAMap. Returns a bounded execution receipt;
      it never installs a runner or executes a proposed product E2E draft.

  qamap e2e draft . --base origin/main --head HEAD
      Optional: after accepting a QA scenario, preview or create an automation
      draft. Runner setup remains an explicit team choice.

  qamap manifest init
      Save reviewed team QA language to .qamap/manifest.yaml so future
      branches get sharper recommendations. Optional — qa works without it.

Handing the result to a coding agent? Add: --format agent
Want your agent to run QAMap by itself? Run once: qamap init --agent
      Adds a Pre-PR QA section to AGENTS.md and installs the packaged
      QAMap skill, so agents run the QA pass before every handoff.

Want shorter commands for repeat use? Run once: qamap init --scripts
      Adds qa, qa:local, qa:run, and qa:e2e package scripts without replacing
      existing scripts unless --force is passed.

Full command reference: qamap help --all`);
}

function printHelp(): void {
  console.log(`QAMap ${VERSION}

Find what a change needs to prove before merge.

Core workflow:
  qamap qa [path]
      Analyze the current branch and show changed behavior, QA scenarios,
      diff evidence, and the safest next action. Does not run product QA.

  qamap qa run [path]
      Re-analyze the branch and run only the exact existing repository
      validation selected by QAMap. Returns an explicit execution receipt.

  qamap e2e draft [path] --dry-run
      Preview an optional automation or checklist draft after reviewing the
      selected QA scenarios. Does not install a runner or execute the draft.

  qamap manifest init [path]
      Optional: create repo-local QA context when repeated runs need durable
      team language or flow corrections.

Agent and repeat-use setup:
  qamap init --agent [path]
  qamap init --scripts [path]

Output:
  --format text       concise human summary (default)
  --format markdown   complete reasoning trace
  --format agent      compact versioned agent contract
  --format json       complete structured result

Use \`qamap qa --help\` for QA options or \`qamap help --all\` for every
advanced and compatibility command.`);
}

function printQaHelp(): void {
  console.log(`QAMap ${VERSION}

Analyze first. Execute only through an explicit follow-up command.

Usage:
  qamap qa [path] [--workspace-root <path>] [--manifest <file>]
    [--base <ref>] [--head <ref>] [--include-working-tree]
    [--runner maestro|playwright|manual] [--format <format>] [--output <file>]

  qamap qa run [path] [--workspace-root <path>] [--manifest <file>]
    [--base <ref>] [--head <ref>] [--include-working-tree]
    [--timeout-ms <n>] [--format <format>] [--output <file>]

  qamap qa report [path] [--workspace-root <path>] [--manifest <file>]
    [--base <ref>] [--head <ref>] [--include-working-tree]
    [--output <directory>] [--format text|json|agent] [--handoff]

  qamap qa brief [path] [--base <ref>] [--head <ref>] [--include-working-tree]
    [--max-bytes <n>] [--output <directory>] [--require-consent]

  qamap qa read <report-file> --sha256 <receipt-hash> --bytes <receipt-bytes>
    [--offset <nextOffset>]

Behavior:
  qa brief prints one bounded text brief for a reviewing agent or person: the
           diff, changed declarations with the tests and callers that use them
           (assertion lines included), QA focus, and unknowns. The base is
           auto-selected unless --base is given. Default limit: 24000 bytes.
           Saves the full report locally. Tests remain not-run; no LLM calls.
           --require-consent prints a consent notice instead, without analysis,
           unless QAMap review consent is recorded (see qamap consent status).
  qa read verifies an existing report and returns one bounded evidence page.
           Continue from nextOffset until null. No analysis or test execution.
  qa       maps diff -> affected behavior -> risk -> scenario -> evidence.
           Product QA and generated drafts remain marked not run.
  qa run   repeats the analysis, then executes only the selected existing
           repository command when the action contract permits it.
  qa report saves static analysis, full evidence, and a compact summary in
           ~/QAMap-reports/qa-* (or a new subdirectory of --output).
           By default, prints only a completion receipt, not the analysis.
           Interactive terminals get a banner; pipes get JSON.
           Tests remain not-run. No LLM calls or automatic report reading.
           --handoff opts into one JSON response containing that summary,
           bounded source excerpts and full-report recovery pointers.
           Analysis makes no LLM calls; caller token savings are not guaranteed.

Common examples:
  qamap qa
  qamap qa --include-working-tree
  qamap qa --format markdown
  qamap qa --format agent
  qamap qa report --format agent
  qamap qa report --handoff
  qamap qa run

Use \`qamap help --all\` for every advanced and compatibility command.`);
}

function printFullHelp(): void {
  console.log(`QAMap ${VERSION}

Local zero-LLM PR QA design, deterministic automation drafts, and repository guardrails.

Usage:
  qamap scan [path] [--format <format>] [--fail-on <severity>] [--max-files <n>]
  qamap report [path] [--format <format>] [--output <file>] [--fail-on <severity>]
  qamap doctor [path] [--format <format>] [--output <file>] [--fail-on <severity>]
  qamap review [path] [--base <ref>] [--head <ref>] [--format <format>] [--fail-on <severity>]
  qamap verify [path] [--workspace-root <path>] [--manifest <file>] [--base <ref>] [--head <ref>] [--include-working-tree] [--pr-body-file <file>] [--fail-on <severity>]
  qamap eval [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--pr-body-file <file>] [--format <format>]
  qamap github-action [path] [--mode auto|scan|review] [--base <ref>] [--head <ref>] [--fail-on <severity>]
  qamap test-plan [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format <format>] [--output <file>]
  qamap qa [path] [--workspace-root <path>] [--manifest <file>] [--base <ref>] [--head <ref>] [--include-working-tree] [--runner maestro|playwright|manual] [--format <format>] [--output <file>]
  qamap qa report [path] [--base <ref>] [--head <ref>] [--include-working-tree] [--output <directory>] [--format text|json|agent] [--handoff]
  qamap qa run [path] [--workspace-root <path>] [--manifest <file>] [--base <ref>] [--head <ref>] [--include-working-tree] [--timeout-ms <n>] [--format <format>] [--output <file>]
  qamap e2e plan [path] [--workspace-root <path>] [--manifest <file>] [--base <ref>] [--head <ref>] [--include-working-tree] [--record-history] [--format <format>]
  qamap e2e setup [path] [--workspace-root <path>] [--runner maestro|playwright] [--force]
  qamap e2e draft [path] [--workspace-root <path>] [--manifest <file>] [--base <ref>] [--head <ref>] [--runner maestro|playwright|manual] [--output <dir>] [--dry-run] [--force]
  qamap e2e run <scenario-id> [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--executor <name>] [--timeout-ms <n>] [--format json|markdown]
  qamap manifest init [path] [--workspace-root <path>] [--write <file>] [--max-files <n>] [--force]
  qamap manifest validate [path] [--workspace-root <path>] [--manifest <file>] [--format <format>]
  qamap manifest explain [path] [--workspace-root <path>] [--manifest <file>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format <format>]
  qamap flows init [path] [--write <file>] [--force]
  qamap flows suggest [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format <format>] [--output <file>] [--write <file>] [--force]
  qamap domains init [path] [--write <file>] [--force]
  qamap domains suggest [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format <format>] [--output <file>] [--write <file>] [--force]
  qamap history init [path]
  qamap context [path] [--write [file]] [--force]
  qamap init [path] [--write <file>] [--force]
  qamap init --agent [path] [--review-mode ask|report] [--force]
  qamap consent status|grant|revoke [path] [--global]
  qamap init --scripts [path] [--force]

Severities:
  info, low, medium, high

Formats:
  text (concise human summary), markdown (full review artifact), json, sarif
  agent (qa only: compact machine-readable summary for coding agents)

Examples:
  qamap scan .
  qamap scan services/listing --workspace-root .
  qamap scan . --format sarif --output qamap.sarif
  qamap scan . --fail-on medium
  qamap report . --output QAMAP_REPORT.md
  qamap doctor .
  qamap review . --base origin/main --head HEAD
  qamap verify . --base origin/main --head HEAD --pr-body-file pr-body.md
  qamap eval . --base origin/main --head HEAD --pr-body-file pr-body.md
  qamap github-action . --mode review --base origin/main --head HEAD --fail-on high
  qamap test-plan . --base origin/main --head HEAD
  qamap qa . --base origin/main --head HEAD
  qamap qa run . --base origin/main --head HEAD
  qamap qa . --manifest /tmp/qamap-manifest.yaml --base origin/main --head HEAD --output QAMAP_QA.md
  qamap e2e plan . --base origin/main --head HEAD
  qamap e2e plan . --base origin/main --head HEAD --record-history
  qamap e2e setup . --runner playwright
  qamap e2e draft . --base origin/main --head HEAD --dry-run
  qamap e2e draft . --manifest /tmp/qamap-manifest.yaml --base origin/main --head HEAD --dry-run
  qamap manifest init .
  qamap manifest explain . --base origin/main --head HEAD
  qamap flows init .
  qamap flows suggest . --base origin/main --head HEAD
  qamap domains init .
  qamap domains suggest . --base origin/main --head HEAD
  qamap history init .
  qamap test-plan services/listing --workspace-root . --base origin/main --head HEAD --include-working-tree
  qamap context . --write AGENTS.md
  qamap init .
  qamap init --agent .
  qamap init --scripts .
`);
}

function printManifestHelp(): void {
  console.log(`QAMap ${VERSION}

Repository-level verification manifest.

Usage:
  qamap manifest init [path] [--workspace-root <path>] [--write <file>] [--max-files <n>] [--force] [--format json] [--output <file>]
  qamap manifest validate [path] [--workspace-root <path>] [--manifest <file>] [--format text|json|markdown] [--output <file>]
  qamap manifest context [path] [--workspace-root <path>] [--max-files <n>] [--format text|json|markdown] [--output <file>]
  qamap manifest explain [path] [--workspace-root <path>] [--manifest <file>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format text|json|markdown] [--output <file>]

Examples:
  qamap manifest init .
  qamap manifest init services/listing --workspace-root .
  qamap manifest init . --write .qamap/manifest.yaml --force
  qamap manifest init . --write /tmp/qamap-manifest.yaml
  qamap manifest validate .
  qamap manifest validate . --manifest /tmp/qamap-manifest.yaml
  qamap manifest context .
  qamap manifest explain . --manifest /tmp/qamap-manifest.yaml --base origin/main --head HEAD
`);
}

function printE2eHelp(): void {
  console.log(`QAMap ${VERSION}

Intent-first QA planning with optional Playwright, Maestro, or manual adapters.

Usage:
  qamap e2e plan [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--record-history] [--format <format>] [--output <file>]
  qamap e2e setup [path] [--workspace-root <path>] [--runner maestro|playwright] [--force] [--format <format>] [--output <file>]
  qamap e2e draft [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--runner maestro|playwright|manual] [--output <dir>] [--dry-run] [--force]
  qamap e2e run <scenario-id> [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--executor <name>] [--timeout-ms <n>] [--output <dir>] [--format json|markdown]

Execution boundary:
  e2e run executes one compiled scenario through an executor the repository configured in
  qamap.config.json, after materializing the fixtures declared for that scenario id. It prints
  a receipt with pass/fail per assertion, timing, and failure-only artifacts, stores it under
  .qamap/runs/e2e, and compares it to the previous receipt for the same id. Without a configured
  executor or declared fixtures the receipt is blocked and nothing runs.

Examples:
  qamap e2e plan . --base origin/main --head HEAD
  qamap e2e plan . --base origin/main --head HEAD --record-history
  qamap e2e setup . --runner playwright
  qamap e2e setup apps/mobile --workspace-root . --runner maestro
  qamap e2e draft . --base origin/main --head HEAD --dry-run
  qamap e2e run scenario:1a2b3c4d5e6f . --base origin/main --head HEAD
  qamap e2e plan apps/mobile --workspace-root . --include-working-tree
`);
}

function printHistoryHelp(): void {
  console.log(`QAMap ${VERSION}

Local history for QAMap analysis runs.

Usage:
  qamap history init [path] [--json] [--output <file>]

Examples:
  qamap history init .
`);
}

function printFlowsHelp(): void {
  console.log(`QAMap ${VERSION}

Core flow definitions for project-specific E2E planning.

Usage:
  qamap flows init [path] [--write <file>] [--force]
  qamap flows suggest [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format text|json|markdown] [--output <file>] [--write <file>] [--force]

Examples:
  qamap flows init .
  qamap flows suggest . --base origin/main --head HEAD
  qamap flows suggest services/listing --workspace-root . --include-working-tree
`);
}

function printDomainsHelp(): void {
  console.log(`QAMap ${VERSION}

Domain definitions for project-specific E2E naming and route hints.

Usage:
  qamap domains init [path] [--write <file>] [--force]
  qamap domains suggest [path] [--workspace-root <path>] [--base <ref>] [--head <ref>] [--include-working-tree] [--format text|json|markdown] [--output <file>] [--write <file>] [--force]

Examples:
  qamap domains init .
  qamap domains suggest . --base origin/main --head HEAD
  qamap domains suggest services/listing --workspace-root . --include-working-tree
`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`QAMap error: ${message}`);
    process.exitCode = 1;
  });
