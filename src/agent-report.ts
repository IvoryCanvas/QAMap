import { readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const agentRecoveryReportPrefix = "qamap-qa-agent-full-";
export const agentRecoveryReportMaxAgeMs = 24 * 60 * 60 * 1_000;

export function cleanupStaleAgentRecoveryReports(
  directory: string,
  now = Date.now(),
): string[] {
  const removed: string[] = [];

  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        !entry.isFile()
        || !entry.name.startsWith(agentRecoveryReportPrefix)
        || !entry.name.endsWith(".json")
      ) {
        continue;
      }

      const reportPath = path.join(directory, entry.name);
      try {
        const report = statSync(reportPath);
        if (now - report.mtimeMs <= agentRecoveryReportMaxAgeMs) {
          continue;
        }
        unlinkSync(reportPath);
        removed.push(reportPath);
      } catch {
        // Cleanup is best effort and must not prevent a fresh analysis.
      }
    }
  } catch {
    // The caller may still be able to write its current report.
  }

  return removed;
}

export function writeAgentRecoveryReport(
  reportPath: string,
  content: string,
  now = Date.now(),
): void {
  cleanupStaleAgentRecoveryReports(path.dirname(reportPath), now);
  writeFileSync(reportPath, content, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}
