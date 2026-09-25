// Grades review-host answers against frozen oracles, then aggregates usage and quality.
//
//   node scripts/agent-bench/review-judge.mjs --runs <dir> [--model <id>] [--concurrency 3]
//   node scripts/agent-bench/review-judge.mjs --runs <dir> --summary <file.json>
//
// Grading runs a separate host session with no tools. Answers are redacted so the
// grader cannot see which arm produced them. A run counts toward a comparison only
// when it completed with host usage and its grade exists.
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));

export function redactArm(text) {
  return text.replace(/\bqamap\b[\w-]*/gi, "TOOL").replace(/\b(?:QA )?brief\b/gi, "report").replace(/\bhandoff\b/gi, "report")
    .replace(/\/tmp\/[^\s)`'"]+/g, "<path>");
}

export function gradingPrompt(oracle, answer) {
  return `You are grading a code-review answer against a frozen oracle. Grade substance only; ignore style, length and which tools were used.

ORACLE (JSON):
${JSON.stringify(oracle, null, 1)}

Rules:
- A seeded item is FOUND only if the answer states the concrete behavior change and that it breaks the described contract/test (naming the affected function, consumer or test, or an unambiguous equivalent). Listing a file as "changed" or "to verify" without saying what breaks is NOT found.
- For kind "mixed-regression": list every safeContracts name the answer explicitly claims as a definite behavior break (hedged "verify"/"possible edge case" wording is not definite).
- For negativeControl cases with no seeded items: falseDefinite lists definite defect claims about the changed code (hedged notes are fine).
- For kind "uncertainty": uncertaintyRetained is true if the answer says runtime/caller-selected behavior cannot be established from the static change (and does not assert a definite defect).
- For kind "qa-planning": for each qaExpectations item (index Q1..), covered is true if the answer asks to verify that behavior or an unambiguous equivalent.

Return ONLY a JSON object, no prose, with keys:
{"found": ["S1", ...], "missed": ["S2", ...], "falseDefinite": ["short text", ...], "uncertaintyRetained": true|false|null,
 "qaCovered": ["Q1", ...], "qaMissed": ["Q2", ...], "notes": "one short sentence"}

ANSWER:
<<<
${answer}
>>>`;
}

async function grade(prompt, model) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-review-judge-"));
  const env = { ...process.env, HOME: home };
  for (const key of Object.keys(env)) if (/^CLAUDE_CODE_(?:SESSION_ID|REMOTE_SESSION_ID|MESSAGING_|CHILD_SESSION|SYNC_SESSION_REFS|TEE_SDK_STDOUT)|^CLAUDECODE$|^CLAUDE_PID$|^GH_TOKEN$|^GITHUB_TOKEN$/.test(key)) delete env[key];
  try {
    const stdout = await new Promise((resolve) => {
      const child = spawn("claude", ["-p", prompt, "--output-format", "json", ...(model ? ["--model", model] : []), "--no-session-persistence",
        "--strict-mcp-config", "--tools", ""], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("close", () => resolve(out));
    });
    const result = JSON.parse(stdout);
    const body = result.result.trim();
    return { verdict: JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)), costUsd: result.total_cost_usd ?? null };
  } catch (error) {
    return { error: String(error.message ?? error) };
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

export function scoreVerdict(oracle, verdict) {
  if (!verdict) return null;
  const seeded = oracle.seeded?.length ?? 0;
  const expectations = oracle.qaExpectations?.length ?? 0;
  return {
    recall: seeded ? (verdict.found?.length ?? 0) / seeded : null,
    qaRecall: expectations ? (verdict.qaCovered?.length ?? 0) / expectations : null,
    falseDefinite: verdict.falseDefinite?.length ?? 0,
    uncertaintyRetained: oracle.kind === "uncertainty" ? verdict.uncertaintyRetained === true : null,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
};

export function aggregateRuns(records) {
  const cases = new Map();
  for (const record of records) {
    const entry = cases.get(record.case) ?? { case: record.case, arms: {} };
    (entry.arms[record.arm] ??= []).push(record);
    cases.set(record.case, entry);
  }
  const summary = [];
  for (const entry of [...cases.values()].sort((a, b) => (a.case < b.case ? -1 : 1))) {
    const arms = {};
    for (const [arm, runs] of Object.entries(entry.arms)) {
      const eligible = runs.filter((run) => run.status === "completed" && Number.isSafeInteger(run.totalTokens) && run.score);
      const tokens = eligible.map((run) => run.totalTokens);
      arms[arm] = { runs: runs.length, eligible: eligible.length, medianTokens: median(tokens), maxTokens: tokens.length ? Math.max(...tokens) : null,
        minTokens: tokens.length ? Math.min(...tokens) : null, medianRequests: median(eligible.map((run) => run.requests)),
        medianUncachedInput: median(eligible.map((run) => run.uncachedInputTokens)),
        recall: eligible.some((run) => run.score.recall !== null) ? median(eligible.map((run) => run.score.recall ?? 0)) : null,
        qaRecall: eligible.some((run) => run.score.qaRecall !== null) ? median(eligible.map((run) => run.score.qaRecall ?? 0)) : null,
        falseDefinite: eligible.reduce((total, run) => total + run.score.falseDefinite, 0),
        uncertaintyRetained: eligible.some((run) => run.score.uncertaintyRetained !== null) ? eligible.filter((run) => run.score.uncertaintyRetained).length : null };
    }
    summary.push({ case: entry.case, arms });
  }
  return summary;
}

async function main() {
  const { values } = parseArgs({ options: { runs: { type: "string" }, model: { type: "string" },
    concurrency: { type: "string", default: "3" }, summary: { type: "string" }, force: { type: "boolean", default: false } } });
  if (!values.runs) throw new Error("--runs is required");
  const oracles = JSON.parse(await fs.readFile(path.join(root, "test/benchmarks/review-host/oracles.json"), "utf8"));
  const directories = (await fs.readdir(values.runs, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name).sort();
  if (values.summary) {
    const records = [];
    for (const name of directories) {
      const raw = await fs.readFile(path.join(values.runs, name, "result.json"), "utf8").catch(() => undefined);
      if (!raw) continue;
      const result = JSON.parse(raw);
      const graded = await fs.readFile(path.join(values.runs, name, "judge.json"), "utf8").then(JSON.parse, () => undefined);
      const { answer: _answer, stderrTail: _stderr, ...kept } = result;
      records.push({ ...kept, score: graded?.verdict ? scoreVerdict(oracles[result.case], graded.verdict) : null, verdict: graded?.verdict ?? null });
    }
    await fs.writeFile(values.summary, `${JSON.stringify({ schema: { name: "qamap.review-host-summary", version: 1 },
      cases: aggregateRuns(records), runs: records }, null, 2)}\n`);
    return;
  }
  let next = 0;
  const worker = async () => {
    while (next < directories.length) {
      const directory = path.join(values.runs, directories[next++]);
      const target = path.join(directory, "judge.json");
      if (!values.force && await fs.stat(target).then(() => true, () => false)) continue;
      const raw = await fs.readFile(path.join(directory, "result.json"), "utf8").catch(() => undefined);
      if (!raw) continue;
      const result = JSON.parse(raw);
      const oracle = oracles[result.case];
      if (!oracle || result.status !== "completed") continue;
      const graded = await grade(gradingPrompt(oracle, redactArm(result.answer ?? "")), values.model);
      await fs.writeFile(target, JSON.stringify({ case: result.case, arm: result.arm, run: result.run, judgeModel: values.model, ...graded }, null, 2));
      process.stdout.write(`${JSON.stringify({ label: path.basename(directory), ...scoreVerdict(oracle, graded.verdict), error: graded.error ?? null })}\n`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
