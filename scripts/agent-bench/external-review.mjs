// Measures QAMap on public pull requests chosen by a fixed rule, not by hand.
// See test/benchmarks/review-host/external/PROTOCOL.md for the registered rules.
//
//   node scripts/agent-bench/external-review.mjs select --cache <dir> [--out cases.json]
//   node scripts/agent-bench/external-review.mjs select-holdout --cache <dir>
//   node scripts/agent-bench/external-review.mjs run --cache <dir> --engine <prefix> --out <dir> [--study 1|2|3] [--case <id>] [--model <id>] [--dry-run]
//     [--candidate <prefix> --arms standalone,qamap,candidate]
//   node scripts/agent-bench/external-review.mjs judge --cache <dir> --runs <dir> [--model <id>] [--arms ...] [--pairs candidate:standalone,...]
//   node scripts/agent-bench/external-review.mjs reanswer --runs <dir>
//   node scripts/agent-bench/external-review.mjs summary --runs <dir> --summary <file.json>
//
// `select` needs Git access to github.com. `run` and `judge` start the Claude Code CLI;
// provider charges apply. Selection, fixtures and grading never read the pull request
// page, so they depend only on Git history.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { armOrder, runHost, sessionAnswer, summarizeHostRun } from "./review-host.mjs";
import { redactArm } from "./review-judge.mjs";

export { armOrder, sessionAnswer };

const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = path.join(root, "test/benchmarks/review-host/external");
const prompts = JSON.parse(await fs.readFile(path.join(root, "test/benchmarks/review-host/cases.json"), "utf8"));
const day = 24 * 60 * 60 * 1000;

export async function loadProtocol() {
  return JSON.parse(await fs.readFile(path.join(directory, "protocol.json"), "utf8"));
}

// Standard input is an empty pipe, so no command can read unexpected input.
const git = (cwd, args, options = {}) => execFileSync("git", args, { cwd, maxBuffer: 512 * 1024 * 1024, input: "", stdio: ["pipe", "pipe", "pipe"], ...options }).toString();
const order = (seed, ...parts) => createHash("sha256").update([seed, ...parts].join(":")).digest("hex");
const cachePath = (cache, slug) => path.join(cache, slug.replace("/", "__"));
const inWindow = (date, [start, end]) => date >= `${start}T00:00:00Z` && date <= `${end}T23:59:59Z`;
const iso = (value) => new Date(value).toISOString();

async function ensureCache(cache, slug, since) {
  const target = cachePath(cache, slug);
  if (!(await fs.stat(target).then(() => true, () => false))) {
    git(cache, ["clone", "-q", "--bare", "--single-branch", "--no-tags", `--shallow-since=${since}`, `https://github.com/${slug}.git`, target]);
  }
  git(target, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  return target;
}

export function parseLog(text) {
  return text.split("\x1e").map((record) => record.replace(/^\n/, "")).filter(Boolean).map((record) => {
    const [sha, parents, author, email, date, subject, body] = record.split("\x1f");
    return { sha, parents: parents ? parents.split(" ") : [], author, email, date: iso(date), subject, message: body ?? "" };
  });
}

export function changeSize(numstat, protocol) {
  const ignored = new RegExp(protocol.paths.ignoredForSize), source = new RegExp(protocol.paths.source), test = new RegExp(protocol.paths.test);
  const files = [];
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [added, deleted, file] = line.split("\t");
    files.push({ file, lines: added === "-" ? 0 : Number(added) + Number(deleted) });
  }
  return {
    files: files.length,
    lines: files.filter(({ file }) => !ignored.test(file)).reduce((total, { lines }) => total + lines, 0),
    sourceFiles: files.filter(({ file }) => source.test(file) && !test.test(file) && !ignored.test(file)).map(({ file }) => file),
    nonTestFiles: files.filter(({ file }) => !test.test(file)).map(({ file }) => file),
  };
}

const pullNumber = (subject) => subject.match(/\(#(\d+)\)\s*$/)?.[1] ?? null;

function eligibleChange(commit, protocol) {
  return commit.parents.length === 1 && pullNumber(commit.subject)
    && !new RegExp(protocol.botAuthor, "i").test(`${commit.author} ${commit.email}`)
    && !new RegExp(protocol.excludedSubject, "i").test(commit.subject.trim());
}

export function causes(commit, protocol) {
  const study = protocol.study1;
  if (!new RegExp(study.fixSubject, "i").test(commit.subject) || /^revert\b/i.test(commit.subject.trim())) return [];
  const own = pullNumber(commit.subject);
  const text = `${commit.subject}\n${commit.message}`;
  const found = new Set();
  for (const pattern of [study.causeBefore, study.causeAfter]) {
    for (const match of text.matchAll(new RegExp(pattern, "gi"))) {
      const number = match.slice(1).find((group) => /^\d+$/.test(group ?? ""));
      if (number && number !== own) found.add(number);
    }
  }
  return [...found];
}

export async function select({ cache, out }) {
  const protocol = await loadProtocol();
  await fs.mkdir(cache, { recursive: true });
  const repositories = [], pairs = [], samples = [];
  const logs = new Map();
  for (const { slug, pool } of protocol.repositories) {
    let target;
    try { target = await ensureCache(cache, slug, protocol.cacheShallowSince); }
    catch (error) { repositories.push({ slug, pool, status: "clone-failed", reason: String(error.stderr ?? error.message).trim().slice(0, 200) }); continue; }
    const head = git(target, ["rev-parse", "HEAD"]).trim();
    const commits = parseLog(git(target, ["log", "--first-parent", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cI%x1f%s%x1f%B%x1e", head]));
    const windowed = commits.filter((commit) => inWindow(commit.date, protocol.eligibility.window));
    const squashShare = windowed.length ? windowed.filter((commit) => commit.parents.length === 1 && pullNumber(commit.subject)).length / windowed.length : 0;
    const status = windowed.length < protocol.eligibility.minCommits ? "too-few-commits"
      : squashShare < protocol.eligibility.minSquashShare ? "not-squash-merged" : "eligible";
    repositories.push({ slug, pool, status, head, windowCommits: windowed.length, squashShare: Number(squashShare.toFixed(3)) });
    if (status === "eligible") logs.set(slug, { pool, target, commits });
  }
  const sizes = new Map();
  const size = (target, sha) => {
    if (!sizes.has(sha)) sizes.set(sha, changeSize(git(target, ["show", "--numstat", "--format=", "--no-renames", sha]), protocol));
    return sizes.get(sha);
  };
  const study1 = (introWindow) => {
    const found = [];
    for (const [slug, { pool, target, commits }] of logs) {
      const byNumber = new Map(commits.filter((commit) => pullNumber(commit.subject)).map((commit) => [pullNumber(commit.subject), commit]));
      const seen = new Set();
      for (const fix of commits) {
        for (const number of causes(fix, protocol)) {
          const change = byNumber.get(number);
          if (!change || seen.has(number) || !eligibleChange(change, protocol) || !inWindow(change.date, introWindow) || change.date >= fix.date) continue;
          const changed = size(target, change.sha);
          const fixed = size(target, fix.sha);
          if (changed.files > protocol.study1.maxFiles || changed.lines > protocol.study1.maxLines || changed.sourceFiles.length === 0) continue;
          if (!fixed.nonTestFiles.some((file) => changed.nonTestFiles.includes(file))) continue;
          seen.add(number);
          found.push({ slug, pool, change, fix, size: changed, rank: order(protocol.seed, slug, number) });
        }
      }
    }
    const kept = [];
    for (const slug of new Set(found.map((pair) => pair.slug))) {
      kept.push(...found.filter((pair) => pair.slug === slug).sort((a, b) => (a.rank < b.rank ? -1 : 1)).slice(0, protocol.study1.perRepository));
    }
    return { qualifying: found.length, cases: kept.sort((a, b) => (a.rank < b.rank ? -1 : 1)).slice(0, protocol.study1.total) };
  };
  let introWindow = protocol.study1.introWindow;
  let chosen = study1(introWindow);
  const fallback = chosen.cases.length < protocol.study1.minimumCases;
  if (fallback) {
    introWindow = [protocol.study1.fallbackIntroStart, introWindow[1]];
    chosen = study1(introWindow);
  }
  for (const pair of chosen.cases) pairs.push(pair);
  const taken = new Set(pairs.map((pair) => pair.change.sha));
  for (const [slug, { pool, target, commits }] of logs) {
    const candidates = [];
    for (const change of commits) {
      if (taken.has(change.sha) || !eligibleChange(change, protocol) || !inWindow(change.date, protocol.study2.window)) continue;
      const changed = size(target, change.sha);
      const limits = protocol.study2;
      if (changed.files < limits.minFiles || changed.files > limits.maxFiles || changed.lines < limits.minLines || changed.lines > limits.maxLines) continue;
      if (changed.sourceFiles.length === 0) continue;
      candidates.push({ slug, pool, change, size: changed, rank: order(protocol.seed, slug, pullNumber(change.subject)) });
    }
    const picked = candidates.sort((a, b) => (a.rank < b.rank ? -1 : 1)).slice(0, protocol.study2.perRepository);
    repositories.find((entry) => entry.slug === slug).study2Candidates = candidates.length;
    samples.push(...picked);
  }
  const describe = (study, { slug, pool, change, fix, size: changed }) => ({
    id: `${study === 1 ? "s1" : "s2"}-${slug.split("/")[1]}-${pullNumber(change.subject)}`, study, repository: slug, pool,
    pr: Number(pullNumber(change.subject)), commit: change.sha, parent: change.parents[0], subject: change.subject, committedAt: change.date,
    files: changed.files, lines: changed.lines,
    ...(fix ? { fix: { commit: fix.sha, pr: pullNumber(fix.subject) ? Number(pullNumber(fix.subject)) : null, subject: fix.subject, committedAt: fix.date } } : {}),
  });
  const result = { schema: { name: "qamap.external-review-cases", version: 1 }, selectedAt: new Date().toISOString(), seed: protocol.seed, repositories,
    study1: { introWindow, fallback, qualifying: chosen.qualifying, cases: pairs.map((pair) => describe(1, pair)) },
    study2: { window: protocol.study2.window, cases: samples.map((sample) => describe(2, sample)) } };
  await fs.writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

// Study 3 is drawn after Studies 1 and 2 with Study 2's rules, from commits merged after its
// window. Existing studies stay as recorded; only `study3` is added to the cases file.
export async function selectHoldout({ cache, casesFile }) {
  const protocol = await loadProtocol();
  const recorded = JSON.parse(await fs.readFile(casesFile, "utf8"));
  if (recorded.study3) throw new Error("Study 3 is already selected");
  const limits = { ...protocol.study2, ...protocol.rerun.study3 };
  const taken = new Set([...recorded.study1.cases, ...recorded.study2.cases].map((entry) => entry.commit));
  const heads = [], cases = [];
  for (const { slug, pool } of protocol.repositories) {
    const target = cachePath(cache, slug);
    const branch = git(target, ["symbolic-ref", "HEAD"]).trim();
    git(target, ["fetch", "-q", "--no-tags", "origin", `+${branch}:${branch}`]);
    const head = git(target, ["rev-parse", "HEAD"]).trim();
    const candidates = [];
    for (const change of parseLog(git(target, ["log", "--first-parent", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cI%x1f%s%x1f%B%x1e", head]))) {
      if (taken.has(change.sha) || !eligibleChange(change, protocol) || !inWindow(change.date, limits.window)) continue;
      const changed = changeSize(git(target, ["show", "--numstat", "--format=", "--no-renames", change.sha]), protocol);
      if (changed.files < limits.minFiles || changed.files > limits.maxFiles || changed.lines < limits.minLines || changed.lines > limits.maxLines) continue;
      if (changed.sourceFiles.length === 0) continue;
      candidates.push({ change, changed, rank: order(protocol.seed, slug, pullNumber(change.subject)) });
    }
    heads.push({ slug, head, candidates: candidates.length });
    for (const { change, changed } of candidates.sort((a, b) => (a.rank < b.rank ? -1 : 1)).slice(0, limits.perRepository)) {
      cases.push({ id: `s3-${slug.split("/")[1]}-${pullNumber(change.subject)}`, study: 3, repository: slug, pool, pr: Number(pullNumber(change.subject)),
        commit: change.sha, parent: change.parents[0], subject: change.subject, committedAt: change.date, files: changed.files, lines: changed.lines });
    }
  }
  recorded.study3 = { selectedAt: new Date().toISOString(), window: limits.window, repositories: heads, cases };
  await fs.writeFile(casesFile, `${JSON.stringify(recorded, null, 2)}\n`);
  return recorded.study3;
}

function gitEnvironment(home) {
  return { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_COMMITTER_NAME: "Fixture Author", GIT_COMMITTER_EMAIL: "author@fixture.test", GIT_COMMITTER_DATE: "2026-09-22T00:00:00Z" };
}

// `main` is the reviewed commit's parent with 90 days of history; `feature/change` is the
// reviewed commit cherry-picked with its own message and author. Nothing later is fetched.
export async function materialize(entry, { cache, workspace, home, engineBin, arm, historyDays = 90 }) {
  const repo = path.join(workspace, "repo");
  const env = gitEnvironment(home);
  const run = (...args) => git(repo, args, { env });
  await fs.mkdir(repo, { recursive: true });
  run("init", "-q", "-b", "main");
  run("config", "gc.auto", "0");
  const since = new Date(Date.parse(entry.committedAt) - historyDays * day).toISOString().slice(0, 10);
  run("fetch", "-q", "--no-tags", `--shallow-since=${since}`, cachePath(cache, entry.repository), entry.commit);
  run("checkout", "-q", "-B", "main", entry.parent);
  if (arm !== "standalone") {
    execFileSync(path.join(engineBin, "qamap"), ["init", "--agent", "--review-mode", "report"], { cwd: repo, env, input: "", stdio: ["pipe", "pipe", "pipe"] });
    run("add", "-A");
    if (run("status", "--porcelain").trim()) run("-c", "user.name=Fixture Author", "-c", "user.email=author@fixture.test", "commit", "-q", "-m", "chore: add QAMap agent setup");
  }
  run("checkout", "-q", "-b", "feature/change");
  run("cherry-pick", "--allow-empty", "--keep-redundant-commits", entry.commit);
  await fs.rm(path.join(repo, ".git", "FETCH_HEAD"), { force: true });
  run("reflog", "expire", "--expire=now", "--all");
  // Pruning only drops the unreferenced original commit, which matches the reviewed change.
  try { run("gc", "-q", "--prune=now"); } catch { /* the reachability check below still applies */ }
  const later = run("rev-list", "--all").split("\n").filter(Boolean);
  if (later.includes(entry.fix?.commit)) throw new Error("fixture contains the later fix");
  return { repo, base: run("rev-parse", "main").trim(), head: run("rev-parse", "HEAD").trim() };
}

async function loadCases(file) {
  const cases = JSON.parse(await fs.readFile(file, "utf8"));
  return [...cases.study1.cases, ...cases.study2.cases, ...(cases.study3?.cases ?? [])];
}

// Study 3 is the held-out sample registered for the re-measurement; it follows Study 2's rules.
const runsPerArm = (protocol, entry) => entry.study === 1 ? protocol.study1.runsPerArm
  : entry.study === 3 ? protocol.rerun.study3.runsPerArm : protocol.study2.runsPerArm;

async function runCases({ cache, engines, arms: armList, out, study, only, model, dryRun, casesFile }) {
  const protocol = await loadProtocol();
  const arms = armList ?? protocol.host.arms;
  const cases = (await loadCases(casesFile)).filter((entry) => (!study || entry.study === Number(study)) && (!only || entry.id === only));
  const jobs = [];
  cases.forEach((entry, index) => {
    for (let run = 1; run <= runsPerArm(protocol, entry); run++) {
      for (const arm of armOrder(arms, index, run)) jobs.push({ entry, arm, run });
    }
  });
  await fs.mkdir(out, { recursive: true });
  const bins = Object.fromEntries(Object.entries(engines).map(([arm, prefix]) => [arm, path.join(path.resolve(prefix), "bin")]));
  for (const arm of arms) if (arm !== "standalone" && !bins[arm]) throw new Error(`No engine for arm ${arm}`);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { entry, arm, run } = jobs[next++];
      const label = `${entry.id}.${arm}.run${run}`;
      const outDir = path.join(out, label);
      if (await fs.stat(path.join(outDir, "result.json")).then(() => true, () => false)) continue;
      await fs.mkdir(outDir, { recursive: true });
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-external-"));
      let line;
      try {
        const home = path.join(workspace, "home");
        await fs.mkdir(home);
        const engineBin = bins[arm];
        const { repo, base, head } = await materialize(entry, { cache, workspace, home, engineBin, arm, historyDays: protocol.fixtureHistoryDays });
        const prompt = arm !== "standalone" ? `${prompts.qamapPrefix} ${prompts.prompt}` : prompts.prompt;
        const engineVersion = engineBin ? execFileSync(path.join(engineBin, "qamap"), ["--version"], { input: "", stdio: ["pipe", "pipe", "pipe"] }).toString().trim() : null;
        const record = { schema: { name: "qamap.external-review-run", version: 1 }, case: entry.id, study: entry.study, arm, run, model: model ?? null, base, head,
          engineVersion, promptSha256: createHash("sha256").update(prompt).digest("hex") };
        if (dryRun) {
          await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify({ ...record, status: "dry-run" }, null, 2));
          line = { label, status: "dry-run" };
        } else {
          const host = await runHost({ cwd: repo, home, pathPrefix: engineBin, prompt, model,
            transcript: path.join(outDir, "transcript.jsonl"), timeoutMs: protocol.host.timeoutMinutes * 60_000, maxTurns: protocol.host.maxTurns });
          const summary = summarizeHostRun(host.stdout);
          const status = host.code === 0 && summary.completed ? "completed" : "stopped";
          await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify({ ...record, status, exitCode: host.code, wallMs: host.wallMs,
            workingTreeChanged: git(repo, ["status", "--porcelain"]).length > 0, stderrTail: host.stderr, commands: bashCommands(host.stdout), ...summary }, null, 2));
          await fs.writeFile(path.join(outDir, "answer.md"), summary.answer);
          line = { label, status, totalTokens: summary.totalTokens, requests: summary.requests, wallMs: host.wallMs };
        }
      } catch (error) {
        line = { label, status: "fixture-error", message: String(error.stderr ?? error.message ?? error).slice(0, 500) };
        await fs.writeFile(path.join(outDir, "error.json"), JSON.stringify(line, null, 2));
      } finally {
        await fs.rm(workspace, { recursive: true, force: true });
      }
      await fs.appendFile(path.join(out, "runs.jsonl"), `${JSON.stringify(line)}\n`);
      process.stdout.write(`${JSON.stringify(line)}\n`);
    }
  };
  await Promise.all(Array.from({ length: protocol.host.concurrency }, worker));
}

export function bashCommands(stdout) {
  const commands = [];
  for (const line of stdout.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "assistant") continue;
    for (const block of event.message?.content ?? []) if (block.type === "tool_use" && block.name === "Bash") commands.push(String(block.input?.command ?? ""));
  }
  return commands;
}

// A segment counts when its command word starts a test runner or an install, not when a
// test file name is only passed to grep or find. Quoted text is removed first, so a `|`
// inside a grep pattern does not start a segment; `test -f` is the shell builtin.
const segments = (command) => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''").split(/&&|\|\||;|\||\n/).map((segment) => segment.trim().replace(/^(?:\S+=\S+\s+)+/, ""));
const testRunner = /^(?:(?:npx|pnpm(?:\s+(?:exec|dlx))?|yarn|bunx?|npm(?:\s+exec)?)\s+(?:run\s+)?(?:test|vitest|jest|playwright|mocha|ava)\b|(?:vitest|jest|mocha|ava|pytest)\b|playwright\s+test\b|node\s+--test\b|python3?\s+-m\s+(?:pytest|unittest)\b|(?:uv|poetry)\s+run\s+(?:pytest|python3?\s+-m\s+pytest)\b|go\s+test\b|make\s+test\b|cargo\s+test\b|(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b|pip3?\s+install\b|uv\s+(?:sync|pip\s+install)\b|poetry\s+install\b)/;

export function executedTests(commands) {
  return commands.some((command) => segments(command).some((segment) => testRunner.test(segment)));
}

// QAMap counts only as a command word, not as part of a temporary directory name.
export function ranQamap(commands) {
  return commands.some((command) => segments(command).some((segment) =>
    /^(?:(?:npx|pnpm\s+dlx|bunx)\s+(?:-{1,2}\S+\s+)*)?(?:\S*\/)?(?:@ivorycanvas\/)?qamap(?:@\S+)?\s+[a-z]/.test(segment)));
}

async function host(prompt, { model, cwd, tools }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-external-judge-"));
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  for (const key of Object.keys(env)) if (/^CLAUDE_CODE_(?:SESSION_ID|REMOTE_SESSION_ID|MESSAGING_|CHILD_SESSION|SYNC_SESSION_REFS|TEE_SDK_STDOUT)|^CLAUDECODE$|^CLAUDE_PID$|^GH_TOKEN$|^GITHUB_TOKEN$/.test(key)) delete env[key];
  const toolArgs = tools
    ? ["--allowedTools", "Read", "Grep", "Glob", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git log:*)",
      "--disallowedTools", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Agent", "Task", "Skill", "--max-turns", "80"]
    : ["--tools", ""];
  try {
    const stdout = await new Promise((resolve) => {
      const child = spawn("claude", ["-p", prompt, "--output-format", "json", ...(model ? ["--model", model] : []), "--no-session-persistence",
        "--strict-mcp-config", ...toolArgs], { cwd: cwd ?? home, env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.end();
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

export function fixPrompt(entry, fixMessage, fixDiff, answer) {
  return `You are grading whether a code review of a pull request identified a defect that
the project fixed later. Grade substance only; ignore style, length and which
tools were used.

REVIEWED PULL REQUEST: ${entry.subject}

LATER FIX, merged afterwards in the same repository. Its message names the
reviewed pull request as the cause:
${fixMessage}
${fixDiff.slice(0, 40_000)}

Verdicts:
- "found": the review states the failure that the later fix corrects, in the
  code the fix changes or an unambiguous equivalent. It may be a definite defect
  or a specific risk that names the triggering condition and the wrong behavior.
- "partial": the review points at the same code and condition, but does not
  state the wrong behavior.
- "missed": anything else, including generic "verify X works" items.

Return ONLY JSON: {"verdict": "found"|"partial"|"missed", "quote": "shortest
supporting excerpt from the review, or empty", "notes": "one short sentence"}

REVIEW:
<<<
${answer}
>>>`;
}

export function pairPrompt(first, second) {
  return `Two code reviews, A and B, were written for the change on this branch (base:
main, head: HEAD) in the current repository. Read the change yourself, for
example with \`git diff main...HEAD\`, and check each review against the code.
Grade substance only; ignore style, length and which tools were used. Do not
modify files or run tests.

For each review, list every distinct finding (a claimed defect, regression or
specific risk) and classify it:
- "valid": the code supports it as a real defect or a real, specific risk a
  maintainer should act on before merging;
- "minor": true but low impact, such as style, naming, comments or speculative
  hardening;
- "incorrect": contradicted by the code, or a defect that does not exist;
- "unverifiable": cannot be confirmed or refuted from this repository.
Then say which review better helps a maintainer decide whether this change is
safe to merge.

Return ONLY JSON: {"A": [{"finding": "short", "class": "valid"|"minor"|
"incorrect"|"unverifiable"}], "B": [...], "preferred": "A"|"B"|"tie",
"reason": "one short sentence"}

REVIEW A:
<<<
${first}
>>>

REVIEW B:
<<<
${second}
>>>`;
}

// Rebuilds stored answers from transcripts and drops grades of answers that changed.
export async function reanswer(runs) {
  const changed = [];
  for (const entry of await fs.readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(runs, entry.name);
    const stdout = await fs.readFile(path.join(directory, "transcript.jsonl"), "utf8").catch(() => undefined);
    const result = await readRun(runs, entry.name);
    if (stdout === undefined || !result) continue;
    const answer = sessionAnswer(stdout);
    if (answer === result.answer) continue;
    await fs.writeFile(path.join(directory, "result.json"), JSON.stringify({ ...result, answer }, null, 2));
    await fs.writeFile(path.join(directory, "answer.md"), answer);
    await fs.rm(path.join(directory, "judge.json"), { force: true });
    changed.push(entry.name);
  }
  const names = await fs.readdir(runs);
  for (const label of changed) {
    const [id, arm] = label.split(".");
    for (const name of names) {
      if ((name === `${id}.pair.json` && ["qamap", "standalone"].includes(arm)) || (name.startsWith(`${id}.pair-`) && name.split(".")[1].split("-").includes(arm))) await fs.rm(path.join(runs, name), { force: true });
    }
  }
  return changed;
}

const readRun = (runs, label) => fs.readFile(path.join(runs, label, "result.json"), "utf8").then(JSON.parse, () => undefined);
const answerOf = (result) => (result?.status === "completed" ? redactArm(result.answer ?? "") : "");

// The v1 pair (QAMap 0.5.1 against standalone) keeps its file name and A/B rule.
export const pairFile = (id, [first, second]) => first === "qamap" && second === "standalone" ? `${id}.pair.json` : `${id}.pair-${first}-${second}.json`;
const pairFlip = (seed, id, [first, second]) => Number.parseInt((first === "qamap" && second === "standalone"
  ? order(seed, id) : order(seed, id, first, second)).slice(-1), 16) % 2 === 1;

async function judge({ cache, runs, model, casesFile, arms: armList, pairs: pairList }) {
  const protocol = await loadProtocol();
  const arms = armList ?? protocol.host.arms;
  const pairs = pairList ?? [["qamap", "standalone"]];
  const cases = await loadCases(casesFile);
  const jobs = [];
  for (const entry of cases) {
    if (entry.study === 1) {
      for (let run = 1; run <= protocol.study1.runsPerArm; run++) for (const arm of arms) jobs.push({ entry, labels: [`${entry.id}.${arm}.run${run}`] });
    } else {
      for (const pair of pairs) jobs.push({ entry, pair, labels: pair.map((arm) => `${entry.id}.${arm}.run1`) });
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { entry, labels, pair } = jobs[next++];
      const target = entry.study === 1 ? path.join(runs, labels[0], "judge.json") : path.join(runs, pairFile(entry.id, pair));
      if (await fs.stat(target).then(() => true, () => false)) continue;
      const results = await Promise.all(labels.map((label) => readRun(runs, label)));
      if (results.some((result) => !result)) continue;
      let record;
      if (entry.study === 1) {
        const repository = cachePath(cache, entry.repository);
        const message = git(repository, ["show", "-s", "--format=%B", entry.fix.commit]);
        const diff = git(repository, ["show", "--format=", entry.fix.commit]);
        const graded = results[0].status === "completed" ? await host(fixPrompt(entry, message, diff, answerOf(results[0])), { model })
          : { verdict: { verdict: "missed", quote: "", notes: "run stopped before an answer" } };
        record = { case: entry.id, label: labels[0], arm: results[0].arm, run: results[0].run, judgeModel: model ?? null, ...graded };
      } else {
        const [a, b] = pairFlip(protocol.seed, entry.id, pair) ? [results[1], results[0]] : results;
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-external-pair-"));
        try {
          const home = path.join(workspace, "home");
          await fs.mkdir(home);
          const { repo } = await materialize(entry, { cache, workspace, home, arm: "standalone", historyDays: protocol.fixtureHistoryDays });
          const graded = await host(pairPrompt(answerOf(a), answerOf(b)), { model, cwd: repo, tools: true });
          record = { case: entry.id, A: a.arm, B: b.arm, judgeModel: model ?? null, ...graded };
        } finally {
          await fs.rm(workspace, { recursive: true, force: true });
        }
      }
      await fs.writeFile(target, JSON.stringify(record, null, 2));
      process.stdout.write(`${JSON.stringify({ case: entry.id, label: record.label ?? path.basename(target), verdict: record.verdict?.verdict ?? record.verdict?.preferred ?? null, error: record.error ?? null })}\n`);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
}

export function mainLoopTokens(stdout) {
  const usage = new Map();
  for (const line of stdout.split("\n")) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === "assistant" && event.message?.id && event.message.usage) usage.set(event.message.id, event.message.usage);
  }
  if (!usage.size) return null;
  return [...usage.values()].reduce((total, entry) => total + (entry.input_tokens ?? 0) + (entry.cache_creation_input_tokens ?? 0)
    + (entry.cache_read_input_tokens ?? 0) + (entry.output_tokens ?? 0), 0);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
};

export async function summarize({ runs, summary, casesFile, arms: armList, pairs: pairList }) {
  const protocol = await loadProtocol();
  const armNames = armList ?? protocol.host.arms;
  const pairs = pairList ?? [["qamap", "standalone"]];
  const cases = await loadCases(casesFile);
  const perCase = [], runRecords = [];
  for (const entry of cases) {
    const arms = {};
    for (const arm of armNames) {
      const count = runsPerArm(protocol, entry);
      const records = [];
      for (let run = 1; run <= count; run++) {
        const label = `${entry.id}.${arm}.run${run}`;
        const result = await readRun(runs, label);
        if (!result) continue;
        const graded = entry.study === 1 ? await fs.readFile(path.join(runs, label, "judge.json"), "utf8").then(JSON.parse, () => undefined) : undefined;
        const commands = result.commands ?? [];
        const transcript = await fs.readFile(path.join(runs, label, "transcript.jsonl"), "utf8").catch(() => "");
        // A run killed at the time limit has no final usage receipt; its main-loop requests
        // still show what it spent, so they are counted as a lower bound and labeled.
        const lowerBound = result.totalTokens === null || result.totalTokens === undefined ? mainLoopTokens(transcript) : null;
        const record = { case: entry.id, study: entry.study, arm, run, status: result.status, totalTokens: result.totalTokens ?? lowerBound,
          tokensSource: lowerBound === null ? "receipt" : "main-loop-lower-bound", requests: result.requests,
          uncachedInputTokens: result.uncachedInputTokens, costUsd: result.costUsd, wallMs: result.wallMs, turns: result.turns,
          executedTests: executedTests(commands), usedQamap: ranQamap(commands),
          movedToBackground: transcript.includes("was moved to the background"),
          endedTurns: transcript.split("\n").filter((line) => { try { return JSON.parse(line).type === "result"; } catch { return false; } }).length,
          engineVersion: result.engineVersion ?? null, verdict: graded?.verdict?.verdict ?? null };
        records.push(record);
        runRecords.push(record);
      }
      arms[arm] = { runs: records.length, medianTokens: median(records.filter((record) => Number.isSafeInteger(record.totalTokens)).map((record) => record.totalTokens)),
        verdicts: records.map((record) => record.verdict) };
    }
    const qualities = {};
    for (const names of entry.study === 1 ? [] : pairs) {
      const pair = await fs.readFile(path.join(runs, pairFile(entry.id, names)), "utf8").then(JSON.parse, () => undefined);
      if (!pair?.verdict) continue;
      const count = (list, kind) => (list ?? []).filter((item) => item.class === kind).length;
      const quality = {};
      for (const side of ["A", "B"]) {
        quality[pair[side]] = Object.fromEntries(["valid", "minor", "incorrect", "unverifiable"].map((kind) => [kind, count(pair.verdict[side], kind)]));
      }
      quality.preferred = pair.verdict.preferred === "tie" ? "tie" : pair[pair.verdict.preferred] ?? null;
      qualities[names.join(":")] = quality;
    }
    const quality = pairList ? qualities : qualities["qamap:standalone"] ?? null;
    perCase.push({ id: entry.id, study: entry.study, repository: entry.repository, pool: entry.pool, pr: entry.pr, files: entry.files, lines: entry.lines, arms, quality });
  }
  const output = { schema: { name: "qamap.external-review-summary", version: 1 }, cases: perCase, runs: runRecords };
  await fs.writeFile(summary, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({ args: rest, options: { cache: { type: "string" }, out: { type: "string" }, engine: { type: "string" },
    runs: { type: "string" }, study: { type: "string" }, case: { type: "string" }, model: { type: "string" }, summary: { type: "string" },
    cases: { type: "string", default: path.join(directory, "cases.json") }, "dry-run": { type: "boolean", default: false },
    candidate: { type: "string" }, arms: { type: "string" }, pairs: { type: "string" } } });
  const arms = values.arms?.split(",");
  const pairs = values.pairs?.split(",").map((pair) => pair.split(":"));
  const outside = (target) => { const relative = path.relative(root, path.resolve(target)); return relative.startsWith("..") || path.isAbsolute(relative); };
  if (command === "select-holdout") {
    if (!values.cache) throw new Error("--cache is required");
    const result = await selectHoldout({ cache: path.resolve(values.cache), casesFile: values.cases });
    process.stdout.write(`${JSON.stringify({ study3: result.cases.length, repositories: result.repositories.map(({ slug, candidates }) => `${slug}:${candidates}`) })}\n`);
  } else if (command === "select") {
    if (!values.cache || !outside(values.cache)) throw new Error("--cache must be a directory outside the repository");
    const result = await select({ cache: path.resolve(values.cache), out: values.out ?? values.cases });
    process.stdout.write(`${JSON.stringify({ repositories: result.repositories.map(({ slug, status }) => `${slug}:${status}`),
      study1: result.study1.cases.length, fallback: result.study1.fallback, study2: result.study2.cases.length })}\n`);
  } else if (command === "run") {
    if (!values.cache || !values.engine || !values.out || !outside(values.out)) throw new Error("--cache, --engine and an --out outside the repository are required");
    await runCases({ cache: path.resolve(values.cache), engines: { qamap: values.engine, ...(values.candidate ? { candidate: values.candidate } : {}) }, arms,
      out: path.resolve(values.out), study: values.study, only: values.case, model: values.model, dryRun: values["dry-run"], casesFile: values.cases });
  } else if (command === "judge") {
    if (!values.cache || !values.runs) throw new Error("--cache and --runs are required");
    await judge({ cache: path.resolve(values.cache), runs: path.resolve(values.runs), model: values.model, casesFile: values.cases, arms, pairs });
  } else if (command === "reanswer") {
    if (!values.runs) throw new Error("--runs is required");
    process.stdout.write(`${JSON.stringify(await reanswer(path.resolve(values.runs)))}\n`);
  } else if (command === "summary") {
    if (!values.runs || !values.summary) throw new Error("--runs and --summary are required");
    await summarize({ runs: path.resolve(values.runs), summary: values.summary, casesFile: values.cases, arms, pairs });
  } else {
    throw new Error("Usage: external-review.mjs select|select-holdout|run|judge|reanswer|summary");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
