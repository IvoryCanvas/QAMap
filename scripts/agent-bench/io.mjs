// Executor-observed UTF-8 bytes, deliberately separate from provider usage and
// from index-reported read/rebuild counters. Child filesystem I/O is unknown.
import { constants, promises as fs } from "node:fs";
import path from "node:path";

const MAX_DIAGNOSTIC_BYTES = 32 * 1024 * 1024;

export function createIORecorder({ tempDirectory }) {
  const recoveryFiles = new Map();
  const metrics = {
    scope: "executor-boundary", subprocessFileReadBytes: null,
    toolInputBytes: 0, toolOutputBytes: 0, fileReadBytes: 0,
    commandStdoutBytes: 0, commandStderrBytes: 0,
    compactOutputBytes: 0, fullReportGeneratedBytes: 0,
    fullRecoveryReadBytes: 0, fullRecoveryOutputBytes: 0, diagnosticReadBytes: 0,
    toolErrors: 0, commandFailures: 0, truncatedResponses: 0, cappedFileReads: 0,
    repositoryIndexes: [], recoveryReports: [], recoveryReads: [],
  };
  const bytes = (text) => Buffer.byteLength(String(text), "utf8");
  const observeIndex = (value, source) => {
    const index = value?.repositoryIndex;
    if (!index?.reuse || !index?.coverage) return;
    metrics.repositoryIndexes.push({ source, fingerprint: index.coverage.fingerprint,
      indexedFiles: index.coverage.indexedFiles, reuse: index.reuse });
  };

  return {
    snapshot: () => structuredClone(metrics),
    recoveryPath: (alias) => recoveryFiles.get(alias),
    input(name, input) { metrics.toolInputBytes += bytes(JSON.stringify({ name, input })); },
    error() { metrics.toolErrors++; },
    command(stdout, stderr, code) {
      metrics.commandStdoutBytes += bytes(stdout);
      metrics.commandStderrBytes += bytes(stderr);
      if (code !== 0) metrics.commandFailures++;
    },
    read(count, recovery, fileBytes) {
      metrics.fileReadBytes += count;
      if (fileBytes > count) metrics.cappedFileReads++;
      if (recovery) {
        metrics.fullRecoveryReadBytes += count;
        metrics.recoveryReads.push({ path: recovery, bytes: count, fileBytes, complete: count === fileBytes });
      }
    },
    output(output, { compact, recovery, truncated }) {
      metrics.toolOutputBytes += bytes(output);
      if (compact) metrics.compactOutputBytes += bytes(output);
      if (recovery) metrics.fullRecoveryOutputBytes += bytes(output);
      if (truncated) metrics.truncatedResponses++;
    },
    async qamapOutput(stdout, format) {
      if (!["agent", "json"].includes(format)) return stdout;
      let report;
      try { report = JSON.parse(stdout); } catch { return stdout; }
      observeIndex(report, "json-output");
      const fullPath = report.compaction?.fullReport;
      if (format !== "agent" || typeof fullPath !== "string" || !tempDirectory) return stdout;
      // Only CLI-generated regular recovery files in this run's own temp
      // directory are eligible for diagnostic inspection or agent recovery.
      if (path.dirname(fullPath) !== tempDirectory
        || !/^qamap-qa-agent-full-[a-f0-9-]+\.json$/.test(path.basename(fullPath))) return stdout;
      try {
        const handle = await fs.open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1) return stdout;
          const alias = `.qamap-bench-recovery/${recoveryFiles.size + 1}.json`;
          recoveryFiles.set(alias, fullPath);
          metrics.fullReportGeneratedBytes += stat.size;
          metrics.recoveryReports.push({ path: alias, bytes: stat.size });
          if (stat.size <= MAX_DIAGNOSTIC_BYTES) {
            const content = await handle.readFile();
            metrics.diagnosticReadBytes += content.length;
            try { observeIndex(JSON.parse(content.toString("utf8")), "full-report-diagnostic"); } catch { /* Unavailable metadata is not reuse. */ }
          }
          // A stable, executor-resolvable pointer; no copying into the fixture
          // and no subsequent index rebuild merely to collect diagnostics.
          return stdout.split(fullPath).join(alias);
        } finally { await handle.close(); }
      } catch { return stdout; }
    },
  };
}
