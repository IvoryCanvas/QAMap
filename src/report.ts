import { isAtLeastSeverity } from "./severity.js";
import type { Finding, ScanResult, Severity } from "./types.js";

const severityOrder: Severity[] = ["high", "medium", "low", "info"];

export function formatTextReport(result: ScanResult): string {
  const lines: string[] = [];
  lines.push(`${result.tool.name} ${result.tool.version}`);
  lines.push(`Root: ${result.root}`);
  if (result.workspaceRoot) {
    lines.push(`Workspace root: ${result.workspaceRoot}`);
  }
  lines.push(
    `Findings: ${result.findings.length} (${severityOrder
      .map((severity) => `${severity}: ${result.counts[severity]}`)
      .join(", ")})`,
  );

  if (result.findings.length === 0) {
    lines.push("");
    lines.push("No findings. Your repository has a clean first-pass QAMap scan.");
    return lines.join("\n");
  }

  for (const severity of severityOrder) {
    const findings = result.findings.filter((finding) => finding.severity === severity);
    if (findings.length === 0) {
      continue;
    }

    lines.push("");
    lines.push(severity.toUpperCase());
    for (const finding of findings) {
      lines.push(`- ${finding.id} ${finding.title}${finding.file ? ` (${finding.file})` : ""}`);
      lines.push(`  ${finding.message}`);
      lines.push(`  Fix: ${finding.recommendation}`);
      if (finding.evidence) {
        lines.push(`  Evidence: ${finding.evidence}`);
      }
    }
  }

  return lines.join("\n");
}

export function formatMarkdownReport(result: ScanResult): string {
  const lines: string[] = [];
  lines.push("# QAMap Report");
  lines.push("");
  lines.push(`Generated: ${result.scannedAt}`);
  lines.push(`Root: \`${result.root}\``);
  if (result.workspaceRoot) {
    lines.push(`Workspace root: \`${result.workspaceRoot}\``);
  }
  lines.push(`Files inspected: ${result.filesInspected}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("| --- | ---: |");
  for (const severity of severityOrder) {
    lines.push(`| ${severity} | ${result.counts[severity]} |`);
  }
  lines.push("");

  if (result.findings.length === 0) {
    lines.push("No findings. Your repository has a clean first-pass QAMap scan.");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Findings");
  lines.push("");

  for (const finding of sortFindings(result.findings)) {
    lines.push(`### ${finding.id}: ${finding.title}`);
    lines.push("");
    lines.push(
      `- Severity: \`${finding.severity}\`${finding.originalSeverity ? ` (overridden from \`${finding.originalSeverity}\`)` : ""}`,
    );
    if (finding.file) {
      lines.push(`- File: \`${finding.file}\``);
    }
    lines.push(`- Message: ${finding.message}`);
    lines.push(`- Recommendation: ${finding.recommendation}`);
    if (finding.evidence) {
      lines.push(`- Evidence: \`${finding.evidence.replaceAll("`", "'")}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function formatSarifReport(result: ScanResult): string {
  const rules = new Map<string, Finding>();
  for (const finding of result.findings) {
    if (!rules.has(finding.id)) {
      rules.set(finding.id, finding);
    }
  }

  const sarif = {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: result.tool.name,
            semanticVersion: result.tool.version,
            informationUri: "https://github.com/IvoryCanvas/qamap",
            rules: Array.from(rules.values()).map((finding) => ({
              id: finding.id,
              name: finding.title,
              shortDescription: {
                text: finding.title,
              },
              fullDescription: {
                text: finding.message,
              },
              help: {
                text: finding.recommendation,
              },
              defaultConfiguration: {
                level: sarifLevel(finding.severity),
              },
              properties: {
                severity: finding.severity,
                originalSeverity: finding.originalSeverity,
              },
            })),
          },
        },
        results: result.findings.map((finding) => ({
          ruleId: finding.id,
          level: sarifLevel(finding.severity),
          message: {
            text: `${finding.message} ${finding.recommendation}`,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: finding.file ?? ".",
                },
              },
            },
          ],
          properties: {
            severity: finding.severity,
            originalSeverity: finding.originalSeverity,
            evidence: finding.evidence,
          },
        })),
      },
    ],
  };

  return `${JSON.stringify(sarif, null, 2)}\n`;
}

export function hasFindingsAtOrAbove(result: ScanResult, threshold: Severity): boolean {
  return result.findings.some((finding) => isAtLeastSeverity(finding.severity, threshold));
}

function sarifLevel(severity: Severity): "error" | "warning" | "note" {
  if (severity === "high") {
    return "error";
  }
  if (severity === "medium" || severity === "low") {
    return "warning";
  }
  return "note";
}

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const severityDelta = severityOrder.indexOf(left.severity) - severityOrder.indexOf(right.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    return left.id.localeCompare(right.id);
  });
}
