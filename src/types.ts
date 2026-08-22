export const severities = ["info", "low", "medium", "high"] as const;

export type Severity = (typeof severities)[number];

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  originalSeverity?: Severity;
  message: string;
  recommendation: string;
  file?: string;
  evidence?: string;
}

export interface ScanCounts {
  info: number;
  low: number;
  medium: number;
  high: number;
}

export interface ScanResult {
  tool: {
    name: string;
    version: string;
  };
  root: string;
  workspaceRoot?: string;
  scannedAt: string;
  filesInspected: number;
  config?: {
    path?: string;
    ignoredRules: string[];
    severityOverrides: Record<string, Severity>;
  };
  findings: Finding[];
  counts: ScanCounts;
}

export interface ScanOptions {
  maxFiles?: number;
  workspaceRoot?: string;
  configPath?: string;
  ignoreRules?: string[];
  severityOverrides?: Record<string, Severity>;
}

export interface ProjectFile {
  path: string;
  absolutePath: string;
  size: number;
  text?: string;
}

export interface QAMapConfig {
  $schema?: string;
  failOn?: Severity;
  ignoreRules?: string[];
  maxFiles?: number;
  severity?: Record<string, Severity>;
  validationCommands?: string[];
  executors?: Record<string, QAMapExecutorConfig>;
  fixtures?: Record<string, QAMapFixtureDeclaration>;
  scenarioFixtures?: Record<string, string[]>;
}

export type QAMapExecutorRunner = "playwright" | "command";

/**
 * A repository-owned scenario executor. QAMap never bundles a browser; it invokes
 * the command the repository already uses and reads the result it produces.
 * Tokens: {file} draft path, {grep} scenario title pattern, {scenarioId}, {fixtureDir}, {artifactDir}.
 */
export interface QAMapExecutorConfig {
  runner: QAMapExecutorRunner;
  command: string[];
  cwd?: string;
  timeoutMs?: number;
  artifactDirectory?: string;
  env?: Record<string, string>;
}

export type QAMapFixtureDeclaration =
  | { kind: "file"; path: string; target?: string; description?: string }
  | { kind: "seed"; command: string[]; cwd?: string; timeoutMs?: number; description?: string };

export interface ResolvedQAMapConfig {
  path?: string;
  config: QAMapConfig;
}
