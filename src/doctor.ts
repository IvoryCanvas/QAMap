import type { Finding, ScanCounts, ScanResult, Severity } from "./types.js";

type DoctorStatus = "ready" | "mostly-ready" | "needs-guardrails" | "high-risk";
type DoctorAreaStatus = "ok" | "review";

interface AreaDefinition {
  name: string;
  ruleIds: string[];
  okMessage: string;
  reviewMessage: string;
}

export interface DoctorArea {
  name: string;
  status: DoctorAreaStatus;
  message: string;
  ruleIds: string[];
}

export interface DoctorPriority {
  id: string;
  severity: Severity;
  title: string;
  recommendation: string;
  file?: string;
}

export interface DoctorResult {
  tool: ScanResult["tool"];
  root: string;
  scannedAt: string;
  filesInspected: number;
  status: DoctorStatus;
  statusLabel: string;
  counts: ScanCounts;
  areas: DoctorArea[];
  topPriorities: DoctorPriority[];
}

const severityOrder: Severity[] = ["high", "medium", "low", "info"];

const areaDefinitions: AreaDefinition[] = [
  {
    name: "Agent instructions",
    ruleIds: ["CW001", "CW002", "CW003"],
    okMessage: "Agent guidance is present and not obviously conflicting.",
    reviewMessage: "Agent guidance needs attention before broad agent use.",
  },
  {
    name: "MCP configuration",
    ruleIds: ["CW004", "CW005"],
    okMessage: "No risky committed MCP configuration was detected.",
    reviewMessage: "MCP configuration should be reviewed before agent sessions.",
  },
  {
    name: "Validation",
    ruleIds: ["CW006"],
    okMessage: "A usable test command is available.",
    reviewMessage: "Agents do not have a clear default validation command.",
  },
  {
    name: "CI workflows",
    ruleIds: ["CW007", "CW010"],
    okMessage: "CI exists without broad workflow permissions.",
    reviewMessage: "CI coverage or workflow permissions need attention.",
  },
  {
    name: "Repository automation",
    ruleIds: ["CW008", "CW009"],
    okMessage: "No committed env files or risky package scripts were detected.",
    reviewMessage: "Local environment files or risky scripts need maintainer review.",
  },
  {
    name: "Community health",
    ruleIds: ["CW011"],
    okMessage: "Core contributor and security files are present.",
    reviewMessage: "Community health files are incomplete.",
  },
];

export function buildDoctorResult(result: ScanResult): DoctorResult {
  return {
    tool: result.tool,
    root: result.root,
    scannedAt: result.scannedAt,
    filesInspected: result.filesInspected,
    status: readinessStatus(result.counts),
    statusLabel: readinessLabel(result.counts),
    counts: result.counts,
    areas: areaDefinitions.map((area) => buildArea(area, result.findings)),
    topPriorities: sortFindings(result.findings).slice(0, 5).map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      recommendation: finding.recommendation,
      file: finding.file,
    })),
  };
}

export function formatDoctorReport(result: ScanResult): string {
  const doctor = buildDoctorResult(result);
  const lines: string[] = [];

  lines.push(`${doctor.tool.name} Doctor`);
  lines.push(`Root: ${doctor.root}`);
  lines.push(`Agent readiness: ${doctor.statusLabel}`);
  lines.push(`Files inspected: ${doctor.filesInspected}`);
  lines.push(
    `Findings: ${sumCounts(doctor.counts)} (${severityOrder
      .map((severity) => `${severity}: ${doctor.counts[severity]}`)
      .join(", ")})`,
  );
  lines.push("");
  lines.push("Guardrail areas:");

  for (const area of doctor.areas) {
    const ruleSuffix = area.ruleIds.length > 0 ? ` (${area.ruleIds.join(", ")})` : "";
    lines.push(`- [${area.status}] ${area.name}: ${area.message}${ruleSuffix}`);
  }

  lines.push("");
  if (doctor.topPriorities.length === 0) {
    lines.push("Top priorities:");
    lines.push("- No immediate action. Your repository looks ready for a first-pass AI agent workflow.");
    return lines.join("\n");
  }

  lines.push("Top priorities:");
  for (const [index, priority] of doctor.topPriorities.entries()) {
    const fileSuffix = priority.file ? ` ${priority.file}` : "";
    lines.push(
      `${index + 1}. ${priority.id} ${priority.severity}${fileSuffix} - ${priority.recommendation}`,
    );
  }

  return lines.join("\n");
}

function buildArea(area: AreaDefinition, findings: Finding[]): DoctorArea {
  const matchedRuleIds = [
    ...new Set(findings.filter((finding) => area.ruleIds.includes(finding.id)).map((finding) => finding.id)),
  ];
  const status: DoctorAreaStatus = matchedRuleIds.length > 0 ? "review" : "ok";

  return {
    name: area.name,
    status,
    message: status === "ok" ? area.okMessage : area.reviewMessage,
    ruleIds: matchedRuleIds,
  };
}

function readinessStatus(counts: ScanCounts): DoctorStatus {
  if (counts.high > 0) {
    return "high-risk";
  }
  if (counts.medium > 0) {
    return "needs-guardrails";
  }
  if (counts.low > 0 || counts.info > 0) {
    return "mostly-ready";
  }
  return "ready";
}

function readinessLabel(counts: ScanCounts): string {
  const status = readinessStatus(counts);
  if (status === "high-risk") {
    return "High risk";
  }
  if (status === "needs-guardrails") {
    return "Needs guardrails";
  }
  if (status === "mostly-ready") {
    return "Mostly ready";
  }
  return "Ready";
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const severityDelta = severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    const idDelta = left.id.localeCompare(right.id);
    if (idDelta !== 0) {
      return idDelta;
    }
    return (left.file ?? "").localeCompare(right.file ?? "");
  });
}

function sumCounts(counts: ScanCounts): number {
  return severityOrder.reduce((sum, severity) => sum + counts[severity], 0);
}
