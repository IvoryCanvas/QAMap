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

export interface CodeWardConfig {
  $schema?: string;
  failOn?: Severity;
  ignoreRules?: string[];
  maxFiles?: number;
  severity?: Record<string, Severity>;
}

export interface ResolvedCodeWardConfig {
  path?: string;
  config: CodeWardConfig;
}
