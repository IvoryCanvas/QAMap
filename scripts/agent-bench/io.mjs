// Executor-observed UTF-8 bytes, deliberately separate from provider usage and
// from index-reported read/rebuild counters. Child filesystem I/O is unknown.
import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const MAX_DIAGNOSTIC_BYTES = 32 * 1024 * 1024;
const toolCounts = () => Object.fromEntries([
  "read_file", "grep", "list_dir", "bash", "qamap_qa", "qamap_qa_run", "qamap_e2e_draft_dry_run", "other",
].map((name) => [name, 0]));

export function createIORecorder({ tempDirectory }) {
  const recoveryFiles = new Map();
  const readTargets = new Map();
  const metrics = {
    scope: "executor-boundary", subprocessFileReadBytes: null,
    toolInputBytes: 0, toolOutputBytes: 0, fileReadBytes: 0,
    commandStdoutBytes: 0, commandStderrBytes: 0,
    compactOutputBytes: 0, fullReportGeneratedBytes: 0,
    fullRecoveryReadBytes: 0, fullRecoveryOutputBytes: 0, diagnosticReadBytes: 0,
    toolErrors: 0, commandFailures: 0, truncatedResponses: 0, cappedFileReads: 0,
    repositoryIndexes: [], recoveryReports: [], recoveryReads: [],
    exploration: {
      callsByTool: toolCounts(),
      directFileReads: { calls: 0, uniqueTargets: 0, repeatedCalls: 0, repeatedBytes: 0 },
      afterCompact: null,
    },
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
    input(name, input) {
      metrics.toolInputBytes += bytes(JSON.stringify({ name, input }));
      const key = Object.hasOwn(metrics.exploration.callsByTool, name) ? name : "other";
      metrics.exploration.callsByTool[key]++;
      if (metrics.exploration.afterCompact) metrics.exploration.afterCompact.callsByTool[key]++;
    },
    error() {
      metrics.toolErrors++;
      if (metrics.exploration.afterCompact) metrics.exploration.afterCompact.toolErrors++;
    },
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
    directRead(target, buffer) {
      const reads = metrics.exploration.directFileReads;
      reads.calls++;
      const digest = createHash("sha256").update(buffer).digest("hex");
      const observed = readTargets.get(target) ?? new Set();
      if (observed.has(digest)) {
        reads.repeatedCalls++;
        reads.repeatedBytes += buffer.length;
      }
      observed.add(digest);
      readTargets.set(target, observed);
      reads.uniqueTargets = readTargets.size;
    },
    output(output, { compact, recovery, truncated }) {
      metrics.toolOutputBytes += bytes(output);
      if (compact) metrics.compactOutputBytes += bytes(output);
      if (recovery) metrics.fullRecoveryOutputBytes += bytes(output);
      if (truncated) metrics.truncatedResponses++;
      if (metrics.exploration.afterCompact) metrics.exploration.afterCompact.toolOutputBytes += bytes(output);
      // The first handoff itself is excluded. A failed or truncated invocation
      // cannot establish that the agent received a usable compact report.
      if (!metrics.exploration.afterCompact && compact && !truncated && isCompactReceipt(output)) {
        metrics.exploration.afterCompact = { callsByTool: toolCounts(), toolOutputBytes: 0, toolErrors: 0 };
      }
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

function isCompactReceipt(output) {
  const suffix = "\n[exit 0]";
  if (!output.endsWith(suffix)) return false;
  try {
    const body = output.slice(0, -suffix.length);
    const stderrAt = body.indexOf("\n[stderr]\n");
    const report = JSON.parse(stderrAt < 0 ? body : body.slice(0, stderrAt));
    return report?.schema?.name === "qamap.qa" && report.schema.version === 1;
  } catch { return false; }
}
