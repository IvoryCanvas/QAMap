// Human-readable rendering of the agent benchmark report. The JSON report is
// the contract; this view only formats it and never adds derived claims.

const TABLE_METRICS = [
  ["inputTokens", "input tokens"],
  ["outputTokens", "output tokens"],
  ["cacheReadTokens", "cache read"],
  ["toolCalls", "tool calls"],
  ["wallClockMs", "wall-clock ms"],
];

export function formatTextReport(report) {
  const lines = ["# QAMap Agent Token Benchmark", ""];
  lines.push(`Status: ${report.status}${report.reason ? ` (${report.reason})` : ""}`);
  lines.push(`Normative metrics: ${report.normativeMetrics.join(", ")}.`);
  lines.push("");
  lines.push("Pinned configuration");
  lines.push(`- provider: ${report.pinned.provider ?? "none"}`);
  lines.push(`- model: ${report.pinned.model ?? "none"}`);
  lines.push(`- runs per task and arm: ${report.pinned.runs}`);
  lines.push(`- max output tokens per request: ${report.pinned.maxOutputTokens}`);
  if (report.pinned.maxProviderRequests) lines.push(`- shared request ceiling: ${report.pinned.maxProviderRequests}; timeout ms: ${report.pinned.requestTimeoutMs}`);
  if (report.pinned.implementationSha256) lines.push(`- executed implementation: sha256:${report.pinned.implementationSha256}`);
  lines.push(`- system prompt: sha256:${report.pinned.systemPromptSha256}`);
  for (const [arm, digest] of Object.entries(report.pinned.toolSchemaSha256)) {
    lines.push(`- ${arm} tool schema: sha256:${digest}`);
  }
  lines.push(`- task suite: sha256:${report.pinned.suiteSha256}`);
  lines.push(`- qamap version: ${report.pinned.qamapVersion}`);
  lines.push("");

  for (const task of report.tasks) {
    lines.push(`## ${task.id}`);
    lines.push("");
    const arms = Object.entries(task.arms);
    if (arms.length === 0) {
      lines.push("- no runs recorded");
      lines.push("");
      continue;
    }
    lines.push("Values are median (min-max) over completed runs; first-authoring is the first run alone.");
    const header = ["arm", "success", ...TABLE_METRICS.map(([, label]) => label), "first-authoring in/out"];
    const rows = arms.map(([arm, result]) => {
      const aggregate = result.aggregate;
      return [
        arm,
        `${aggregate.successfulRuns}/${aggregate.completedRuns}${aggregate.failedRuns > 0 ? ` (${aggregate.failedRuns} errored)` : ""}`,
        ...TABLE_METRICS.map(([metric]) => formatMetric(aggregate.metrics[metric])),
        `${formatValue(aggregate.metrics.inputTokens.firstAuthoring)}/${formatValue(aggregate.metrics.outputTokens.firstAuthoring)}`,
      ];
    });
    lines.push(...renderTable([header, ...rows]));
    for (const [arm, result] of arms) {
      const steady = result.aggregate.metrics.inputTokens.steadyState;
      lines.push(
        `- ${arm} steady state (${steady.samples} run${steady.samples === 1 ? "" : "s"} after first authoring): ` +
          `input ${formatMetric(result.aggregate.metrics.inputTokens.steadyState)}, ` +
          `output ${formatMetric(result.aggregate.metrics.outputTokens.steadyState)}`,
      );
      for (const run of result.runs) {
        if (run.error) lines.push(`  ! run ${run.run} errored: ${run.error}`);
        if (run.partialUsage) lines.push(`  known partial input/output: ${formatValue(run.partialUsage.inputTokens)}/${formatValue(run.partialUsage.outputTokens)}; failed-request usage unknown, excluded from comparisons`);
        for (const quality of run.quality ?? []) lines.push(`  evidence precision/recall: ${quality.evidencePrecision}/${quality.evidenceRecall}; contract completeness: ${quality.contractCompleteness}; passed: ${quality.passed}`);
        if (run.repositoryCache) {
          const setup = run.repositoryCache.setup;
          const observations = run.io?.repositoryIndexes ?? [];
          lines.push(`  run ${run.run} cache setup: ${setup.status}; setup ms: ${formatValue(setup.wallClockMs)}; ` +
            `head index observations: ${observations.length || "unavailable"}`);
          for (const observation of observations) lines.push(`    ${observation.reuse.status}: ` +
            `${observation.reuse.rebuiltFiles} rebuilt, ${observation.reuse.reusedFiles} reused (index-reported)`);
          if (run.io) lines.push(`    executor bytes: tool output ${run.io.toolOutputBytes}, ` +
            `compact ${run.io.compactOutputBytes}, recovery read ${run.io.fullRecoveryReadBytes}`);
        }
      }
    }
    for (const comparison of task.repositoryComparisons ?? []) {
      lines.push(`- ${comparison.baselineArm} vs ${comparison.candidateArm}: ${comparison.status}; ` +
        `provider input-token median difference ${formatValue(comparison.inputTokensMedianDifference)}`);
    }
    lines.push("");
  }

  for (const line of report.interpretation) lines.push(`- ${line}`);
  lines.push("");
  lines.push(`Summary: ${formatSummary(report.summary)}`);
  return lines.join("\n");
}

function formatSummary(summary) {
  if (summary.status === "skipped") {
    return "skipped; no run was recorded.";
  }
  const parts = Object.entries(summary.byArm).map(
    ([arm, value]) => `${arm} ${value.successfulRuns}/${value.completedRuns} successful run(s), ${value.failedRuns} errored`,
  );
  return `${parts.join("; ")}.`;
}

function formatMetric(metric) {
  if (!metric || metric.median === null) return "n/a";
  return `${formatValue(metric.median)} (${formatValue(metric.range.min)}-${formatValue(metric.range.max)})`;
}

function formatValue(value) {
  return value === null || value === undefined ? "n/a" : String(value);
}

function renderTable(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  return rows.map((row, index) => {
    const line = row.map((cell, column) => String(cell).padEnd(widths[column])).join("  ");
    return index === 0 ? `${line}\n${"-".repeat(line.length)}` : line;
  });
}
