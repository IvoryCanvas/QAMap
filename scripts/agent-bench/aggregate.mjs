// Pure aggregation for agent benchmark runs. Each metric is reported as the
// median plus range over completed runs, with the first-authoring run kept in
// its own column and the steady-state median computed without it.

export const RUN_METRICS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "toolCalls",
  "turns",
  "wallClockMs",
];

export function aggregateRuns(runs) {
  const completed = runs.filter((run) => !run.error);
  const firstAuthoringRun = completed.find((run) => run.firstAuthoring === true);
  const steadyRuns = completed.filter((run) => run.firstAuthoring !== true);
  const metrics = {};
  for (const metric of RUN_METRICS) {
    const values = numbers(completed, metric);
    const steadyValues = numbers(steadyRuns, metric);
    metrics[metric] = {
      median: median(values),
      range: range(values),
      samples: values.length,
      firstAuthoring: firstAuthoringRun && typeof firstAuthoringRun[metric] === "number"
        ? firstAuthoringRun[metric]
        : null,
      steadyState: {
        median: median(steadyValues),
        range: range(steadyValues),
        samples: steadyValues.length,
      },
    };
  }
  return {
    runs: runs.length,
    completedRuns: completed.length,
    failedRuns: runs.length - completed.length,
    successfulRuns: completed.filter((run) => run.success === true).length,
    firstAuthoringSuccess: firstAuthoringRun ? firstAuthoringRun.success === true : null,
    steadyStateSuccessfulRuns: steadyRuns.filter((run) => run.success === true).length,
    steadyStateRuns: steadyRuns.length,
    metrics,
  };
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function range(values) {
  if (values.length === 0) return { min: null, max: null };
  return { min: Math.min(...values), max: Math.max(...values) };
}

function numbers(runs, metric) {
  return runs.map((run) => run[metric]).filter((value) => typeof value === "number" && Number.isFinite(value));
}
