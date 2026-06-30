import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists, toPosixPath } from "./fs.js";
import type { E2ePlanResult } from "./e2e.js";
import { TOOL_NAME, VERSION } from "./version.js";

export const codewardDirectoryName = ".codeward";
export const localHistoryDirectory = ".codeward/runs";
export const localCacheDirectory = ".codeward/cache";
export const localTmpDirectory = ".codeward/tmp";

export const localHistoryGitignorePatterns = [
  `${localHistoryDirectory}/`,
  `${localCacheDirectory}/`,
  `${localTmpDirectory}/`,
  ".codeward/*.local.json",
];

export interface LocalHistoryReference {
  path: string;
  gitignoreUpdated: boolean;
  addedGitignorePatterns: string[];
}

export interface LocalHistoryInitResult {
  root: string;
  createdDirectories: string[];
  gitignorePath: string;
  gitignoreUpdated: boolean;
  addedGitignorePatterns: string[];
  existingGitignorePatterns: string[];
}

export interface E2ePlanHistorySnapshot {
  schemaVersion: 1;
  tool: {
    name: string;
    version: string;
  };
  kind: "e2e-plan";
  recordedAt: string;
  plan: {
    generatedAt: string;
    scope: string;
    base: string;
    head: string;
    includeWorkingTree: boolean;
    projectType: string;
    recommendedRunner: string;
    executionProfile: {
      runner: string;
      confidence: string;
      startCommand?: string;
      testCommand?: string;
      baseUrl?: string;
      appId?: string;
      configFiles: string[];
      envFiles: string[];
      evidence: string[];
      blockers: string[];
    };
    coreFlowManifestPath?: string;
    coreFlows: Array<{
      id: string;
      name: string;
      priority: string;
      matchedFiles: string[];
      matchedSignals: string[];
      routes: string[];
    }>;
    domainManifestPath?: string;
    domains: Array<{
      id: string;
      name: string;
      matchedFiles: string[];
      matchedSignals: string[];
      routes: string[];
      scenarios: string[];
    }>;
    domainLanguage: {
      terms: Array<{
        term: string;
        confidence: string;
        source: string;
      }>;
      scenarios: string[];
    };
    validationMatrix: {
      summary: {
        ready: number;
        partial: number;
        missing: number;
      };
      rows: Array<{
        area: string;
        category: string;
        status: string;
        requiredEvidence: string;
        currentEvidence: string;
        nextAction: string;
      }>;
    };
    bootstrap: {
      summary: string;
      counts: {
        required: number;
        recommended: number;
        ready: number;
      };
      steps: Array<{
        category: string;
        status: string;
        title: string;
        action: string;
        commands: string[];
        files: string[];
      }>;
    };
    changedFilesCount: number;
    changedFiles: string[];
    suggestedCommands: string[];
    workspaceTargets: Array<{
      path: string;
      packageName?: string;
      projectType: string;
      recommendedRunner: string;
      changedFiles: string[];
      suggestedCommand: string;
    }>;
    testSuite: E2ePlanResult["testSuite"];
    flows: Array<{
      title: string;
      files: string[];
      coverageTargets: Array<{
        title: string;
        priority: string;
      }>;
      coverageEvidence: Array<{
        targetTitle: string;
        status: string;
        confidence: string;
        files: string[];
        reason: string;
      }>;
      fixtureReadiness: {
        status: string;
        reason: string;
        apiSignals: string[];
        backendSignals: string[];
        mockSignals: string[];
      };
      missingTestabilityCount: number;
    }>;
  };
  summary: {
    changedFiles: number;
    workspaceTargets: number;
    flows: number;
    coreFlows: number;
    domains: number;
    domainTerms: number;
    coverageEvidence: {
      covered: number;
      partial: number;
      missing: number;
    };
    fixtureReadiness: {
      ready: number;
      partial: number;
      missing: number;
    };
    validationMatrix: {
      ready: number;
      partial: number;
      missing: number;
    };
    bootstrap: {
      required: number;
      recommended: number;
      ready: number;
    };
    missingTestability: number;
  };
}

export async function initializeLocalHistory(rootInput: string): Promise<LocalHistoryInitResult> {
  const root = path.resolve(rootInput);
  const createdDirectories: string[] = [];
  for (const directory of [codewardDirectoryName, localHistoryDirectory, localCacheDirectory, localTmpDirectory]) {
    const absolutePath = path.join(root, directory);
    if (!(await pathExists(absolutePath))) {
      await fs.mkdir(absolutePath, { recursive: true });
      createdDirectories.push(directory);
    }
  }

  const gitignore = await ensureLocalHistoryIgnored(root);
  return {
    root,
    createdDirectories,
    gitignorePath: ".gitignore",
    ...gitignore,
  };
}

export function formatLocalHistoryInitResult(result: LocalHistoryInitResult): string {
  const lines: string[] = [];
  lines.push("CodeWard Local History");
  lines.push(`Root: ${result.root}`);
  lines.push(
    `Directories: ${result.createdDirectories.length > 0 ? result.createdDirectories.join(", ") : "already present"}`,
  );
  lines.push(
    `Gitignore: ${result.gitignoreUpdated ? `updated ${result.gitignorePath}` : `${result.gitignorePath} already protected`}`,
  );
  if (result.addedGitignorePatterns.length > 0) {
    lines.push("Added patterns:");
    for (const pattern of result.addedGitignorePatterns) {
      lines.push(`- ${pattern}`);
    }
  }
  lines.push("Shared flow definitions stay commit-friendly; local runs, cache, and temp files stay ignored.");
  return `${lines.join("\n")}\n`;
}

export async function recordE2ePlanHistory(rootInput: string, plan: E2ePlanResult): Promise<LocalHistoryReference> {
  const root = path.resolve(rootInput);
  const gitignore = await ensureLocalHistoryIgnored(root);
  await fs.mkdir(path.join(root, localHistoryDirectory), { recursive: true });

  const snapshot = buildE2ePlanHistorySnapshot(root, plan);
  const displayPath = await nextHistoryPath(root, snapshot.recordedAt, snapshot.kind);
  await fs.writeFile(path.join(root, displayPath), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  return {
    path: displayPath,
    gitignoreUpdated: gitignore.gitignoreUpdated,
    addedGitignorePatterns: gitignore.addedGitignorePatterns,
  };
}

function buildE2ePlanHistorySnapshot(historyRoot: string, plan: E2ePlanResult): E2ePlanHistorySnapshot {
  const coverageEvidence = plan.flows.flatMap((flow) => flow.coverageEvidence);
  const recordedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    tool: {
      name: TOOL_NAME,
      version: VERSION,
    },
    kind: "e2e-plan",
    recordedAt,
    plan: {
      generatedAt: plan.generatedAt,
      scope: plan.workspaceRoot ? toDisplayScope(plan.workspaceRoot, plan.root) : toDisplayScope(historyRoot, plan.root),
      base: plan.base,
      head: plan.head,
      includeWorkingTree: plan.includeWorkingTree,
      projectType: plan.project.type,
      recommendedRunner: plan.recommendedRunner.name,
      executionProfile: {
        runner: plan.executionProfile.runner,
        confidence: plan.executionProfile.confidence,
        startCommand: plan.executionProfile.startCommand,
        testCommand: plan.executionProfile.testCommand,
        baseUrl: plan.executionProfile.baseUrl,
        appId: plan.executionProfile.appId,
        configFiles: plan.executionProfile.configFiles.slice(0, 10),
        envFiles: plan.executionProfile.envFiles.slice(0, 10),
        evidence: plan.executionProfile.evidence.slice(0, 12),
        blockers: plan.executionProfile.blockers.slice(0, 12),
      },
      coreFlowManifestPath: plan.coreFlowManifestPath,
      coreFlows: plan.coreFlows.map((flow) => ({
        id: flow.id,
        name: flow.name,
        priority: flow.priority,
        matchedFiles: flow.matchedFiles.slice(0, 10),
        matchedSignals: flow.matchedSignals.slice(0, 10),
        routes: flow.routes.slice(0, 10),
      })),
      domainManifestPath: plan.domainManifestPath,
      domains: plan.domains.map((domain) => ({
        id: domain.id,
        name: domain.name,
        matchedFiles: domain.matchedFiles.slice(0, 10),
        matchedSignals: domain.matchedSignals.slice(0, 10),
        routes: domain.routes.slice(0, 10),
        scenarios: domain.scenarios.map((scenario) => scenario.title).slice(0, 8),
      })),
      domainLanguage: {
        terms: plan.domainLanguage.terms.slice(0, 12).map((term) => ({
          term: term.term,
          confidence: term.confidence,
          source: term.source,
        })),
        scenarios: plan.domainLanguage.scenarios.map((scenario) => scenario.title).slice(0, 8),
      },
      validationMatrix: {
        summary: plan.validationMatrix.summary,
        rows: plan.validationMatrix.rows.slice(0, 20).map((row) => ({
          area: row.area,
          category: row.category,
          status: row.status,
          requiredEvidence: row.requiredEvidence,
          currentEvidence: row.currentEvidence,
          nextAction: row.nextAction,
        })),
      },
      bootstrap: {
        summary: plan.bootstrap.summary,
        counts: plan.bootstrap.counts,
        steps: plan.bootstrap.steps.slice(0, 12).map((step) => ({
          category: step.category,
          status: step.status,
          title: step.title,
          action: step.action,
          commands: step.commands.slice(0, 5),
          files: step.files.slice(0, 8),
        })),
      },
      changedFilesCount: plan.changedFiles.length,
      changedFiles: plan.changedFiles.map((file) => file.path).slice(0, 50),
      suggestedCommands: plan.suggestedCommands.slice(0, 20),
      workspaceTargets: plan.workspaceTargets.map((target) => ({
        path: target.path,
        packageName: target.packageName,
        projectType: target.project.type,
        recommendedRunner: target.recommendedRunner.name,
        changedFiles: target.changedFiles.slice(0, 20),
        suggestedCommand: target.suggestedCommand,
      })),
      testSuite: plan.testSuite,
      flows: plan.flows.map((flow) => ({
        title: flow.title,
        files: flow.files.slice(0, 20),
        coverageTargets: flow.coverage.map((target) => ({
          title: target.title,
          priority: target.priority,
        })),
        coverageEvidence: flow.coverageEvidence.map((evidence) => ({
          targetTitle: evidence.targetTitle,
          status: evidence.status,
          confidence: evidence.confidence,
          files: evidence.files.slice(0, 5),
          reason: evidence.reason,
        })),
        fixtureReadiness: {
          status: flow.fixtureReadiness.status,
          reason: flow.fixtureReadiness.reason,
          apiSignals: flow.fixtureReadiness.apiSignals.slice(0, 5),
          backendSignals: flow.fixtureReadiness.backendSignals.slice(0, 5),
          mockSignals: flow.fixtureReadiness.mockSignals.slice(0, 5),
        },
        missingTestabilityCount: flow.missingTestability.length,
      })),
    },
    summary: {
      changedFiles: plan.changedFiles.length,
      workspaceTargets: plan.workspaceTargets.length,
      flows: plan.flows.length,
      coreFlows: plan.coreFlows.length,
      domains: plan.domains.length,
      domainTerms: plan.domainLanguage.terms.length,
      coverageEvidence: {
        covered: coverageEvidence.filter((evidence) => evidence.status === "covered").length,
        partial: coverageEvidence.filter((evidence) => evidence.status === "partial").length,
        missing: coverageEvidence.filter((evidence) => evidence.status === "missing").length,
      },
      fixtureReadiness: {
        ready: plan.flows.filter((flow) => flow.fixtureReadiness.status === "ready").length,
        partial: plan.flows.filter((flow) => flow.fixtureReadiness.status === "partial").length,
        missing: plan.flows.filter((flow) => flow.fixtureReadiness.status === "missing").length,
      },
      validationMatrix: plan.validationMatrix.summary,
      bootstrap: plan.bootstrap.counts,
      missingTestability: plan.missingTestability.length,
    },
  };
}

async function ensureLocalHistoryIgnored(root: string): Promise<{
  gitignoreUpdated: boolean;
  addedGitignorePatterns: string[];
  existingGitignorePatterns: string[];
}> {
  const gitignorePath = path.join(root, ".gitignore");
  const raw = (await pathExists(gitignorePath)) ? await fs.readFile(gitignorePath, "utf8") : "";
  const lines = raw.split(/\r?\n/);
  const existing = new Set(lines.map((line) => line.trim()).filter(Boolean));
  const addedGitignorePatterns = localHistoryGitignorePatterns.filter((pattern) => !existing.has(pattern));

  if (addedGitignorePatterns.length === 0) {
    return {
      gitignoreUpdated: false,
      addedGitignorePatterns: [],
      existingGitignorePatterns: localHistoryGitignorePatterns,
    };
  }

  const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  const separator = raw.trim().length > 0 ? "\n" : "";
  const block = [
    "# CodeWard local analysis history",
    ...addedGitignorePatterns,
  ].join("\n");
  await fs.writeFile(gitignorePath, `${raw}${prefix}${separator}${block}\n`, "utf8");

  return {
    gitignoreUpdated: true,
    addedGitignorePatterns,
    existingGitignorePatterns: localHistoryGitignorePatterns.filter((pattern) => existing.has(pattern)),
  };
}

async function nextHistoryPath(root: string, recordedAt: string, kind: string): Promise<string> {
  const safeTimestamp = recordedAt.replace(/[:.]/g, "-");
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const displayPath = `${localHistoryDirectory}/${safeTimestamp}.${kind}${suffix}.json`;
    if (!(await pathExists(path.join(root, displayPath)))) {
      return displayPath;
    }
  }
  throw new Error("Could not allocate a CodeWard local history file name");
}

function toDisplayScope(base: string, target: string): string {
  const relative = toPosixPath(path.relative(base, target));
  if (!relative) {
    return ".";
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return ".";
  }
  return relative;
}
