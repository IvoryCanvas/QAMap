import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { armOrder, causes, changeSize, executedTests, loadProtocol, mainLoopTokens, materialize, pairFile, pairPrompt, parseLog, ranQamap, sessionAnswer } from "../scripts/agent-bench/external-review.mjs";

const protocol = await loadProtocol();
const commit = (subject, message = "") => ({ subject, message: `${subject}\n\n${message}` });

test("the registered protocol fixes repositories, windows and limits before selection", () => {
  assert.equal(protocol.repositories.length, 12);
  assert.deepEqual([...new Set(protocol.repositories.map((entry) => entry.pool))].sort(), ["go", "python", "typescript"]);
  assert.deepEqual(protocol.study1.introWindow, ["2026-07-01", "2026-09-20"]);
  assert.equal(protocol.package, "@ivorycanvas/qamap@0.5.1");
  assert.deepEqual(protocol.host.arms, ["standalone", "qamap"]);
});

test("a fix names its cause only through a causal phrase near the pull request number", () => {
  assert.deepEqual(causes(commit("fix: restore empty state (#90)", "Regression from #71."), protocol), ["71"]);
  assert.deepEqual(causes(commit("Fix upload retry (#12)", "#7 introduced a double retry."), protocol), ["7"]);
  assert.deepEqual(causes(commit("fix(api): keep order (#44)", "Broken by #44 itself? No: caused by #40."), protocol), ["40"]);
  assert.deepEqual(causes(commit("feat: new page (#5)", "regression from #3"), protocol), []);
  assert.deepEqual(causes(commit("fix: typo (#6)", "follow-up to #3"), protocol), []);
  assert.deepEqual(causes(commit('Revert "fix: x (#9)" (#10)', "regression from #9"), protocol), []);
});

test("change size ignores lockfiles and never treats tests as source", () => {
  const size = changeSize(["10\t2\tsrc/app.ts", "400\t0\tpnpm-lock.yaml", "5\t5\tsrc/app.test.ts", "3\t0\tpkg/server_test.go",
    "-\t-\tassets/logo.png", "7\t1\tapi/handler.go"].join("\n"), protocol);
  assert.equal(size.files, 6);
  assert.equal(size.lines, 33);
  assert.deepEqual(size.sourceFiles, ["src/app.ts", "api/handler.go"]);
  assert.ok(!size.nonTestFiles.includes("src/app.test.ts"));
});

test("test execution counts a command word, not a test file passed to grep or find", () => {
  assert.equal(executedTests(["grep -rn retry src/app.test.ts", "find . -name '*_test.go'", "git diff main...HEAD -- test/"]), false);
  assert.equal(executedTests(["cd web && pnpm test -- app"]), true);
  assert.equal(executedTests(["go test ./..."]), true);
  assert.equal(executedTests(["CI=1 npx vitest run"]), true);
  assert.equal(executedTests(["python -m pytest -q"]), true);
  assert.equal(executedTests(["npm install"]), true);
  assert.equal(executedTests(["test -f ~/.claude/CLAUDE.md && echo exists"]), false);
  assert.equal(executedTests(['grep -n "raises_for_ref\\|pytest.raises(Undefined" tests/test_tools.py']), false);
  assert.equal(executedTests(["GITEA_UNSAFE=true go test ./services/..."]), true);
  assert.equal(executedTests(["pip install -q pytest-timeout"]), true);
  assert.equal(executedTests(["timeout 300 go test ./services/gitdiff/..."]), true);
  assert.equal(executedTests(['su testuser -c "cd /repo && timeout 300 go test ./services/..."']), true);
  assert.equal(executedTests(["bash -lc 'npm ci && npm test'"]), true);
  assert.equal(executedTests(["sudo -E npx vitest run"]), true);
  assert.equal(executedTests(["timeout 60 git diff main...HEAD -- test/"]), false);
  assert.equal(executedTests(['bash -c "grep -rn \"go test\" Makefile"']), false);
});

test("QAMap use counts the command word, not a temporary directory named after it", () => {
  assert.equal(ranQamap(["qamap qa brief --require-consent"]), true);
  assert.equal(ranQamap(["npx --yes @ivorycanvas/qamap@0.5.1 qa brief"]), true);
  assert.equal(ranQamap(["git diff main...HEAD > /tmp/claude-0/-tmp-qamap-external-x/diff.txt"]), false);
  assert.equal(ranQamap(["grep -rn foo /tmp/qamap-external-abc/repo/src"]), false);
});

test("pairwise grading keeps both reviews verbatim", () => {
  const prompt = pairPrompt("first review", "second review");
  assert.ok(prompt.includes("REVIEW A:\n<<<\nfirst review\n>>>"));
  assert.ok(prompt.includes("REVIEW B:\n<<<\nsecond review\n>>>"));
});

test("a fixture holds the reviewed change and nothing merged after it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-external-test-"));
  try {
    const source = path.join(directory, "source");
    await fs.mkdir(source);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(directory, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Maintainer",
      GIT_AUTHOR_EMAIL: "maintainer@example.test", GIT_COMMITTER_NAME: "Maintainer", GIT_COMMITTER_EMAIL: "maintainer@example.test" };
    const git = (...args) => execFileSync("git", args, { cwd: source, env }).toString().trim();
    const change = async (file, text, subject, date) => {
      await fs.writeFile(path.join(source, file), text);
      git("add", "-A");
      execFileSync("git", ["commit", "-q", "-m", subject], { cwd: source, env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    const parent = await change("app.js", "export const limit = 1;\n", "feat: add limit (#1)", "2026-07-01T00:00:00Z");
    const reviewed = await change("app.js", "export const limit = 2;\n", "refactor: raise limit (#2)", "2026-07-02T00:00:00Z");
    const fix = await change("app.js", "export const limit = 1;\n", "fix: restore limit (#3)\n\nRegression from #2.", "2026-07-03T00:00:00Z");
    const cache = path.join(directory, "cache");
    await fs.mkdir(cache);
    execFileSync("git", ["clone", "-q", "--bare", source, path.join(cache, "owner__repo")], { env });
    execFileSync("git", ["config", "uploadpack.allowReachableSHA1InWant", "true"], { cwd: path.join(cache, "owner__repo") });
    const log = parseLog(execFileSync("git", ["log", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%cI%x1f%s%x1f%B%x1e"], { cwd: source }).toString());
    assert.deepEqual(log.map((entry) => entry.sha), [fix, reviewed, parent]);
    assert.equal(log[1].parents[0], parent);

    const workspace = path.join(directory, "workspace");
    const home = path.join(directory, "home");
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    const entry = { repository: "owner/repo", commit: reviewed, parent, committedAt: "2026-07-02T00:00:00.000Z", fix: { commit: fix } };
    const { repo, base } = await materialize(entry, { cache, workspace, home, arm: "standalone" });
    const inRepo = (...args) => execFileSync("git", args, { cwd: repo }).toString().trim();
    assert.equal(base, parent);
    assert.equal(inRepo("log", "-1", "--format=%s|%an", "HEAD"), "refactor: raise limit (#2)|Maintainer");
    assert.equal(await fs.readFile(path.join(repo, "app.js"), "utf8"), "export const limit = 2;\n");
    assert.ok(!inRepo("rev-list", "--all").includes(fix));
    assert.equal(inRepo("remote"), "");
    assert.equal(inRepo("tag"), "");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a session answer keeps every ended turn, so a late acknowledgement cannot replace the review", () => {
  const stdout = [
    JSON.stringify({ type: "result", subtype: "success", result: "Waiting for the report." }),
    JSON.stringify({ type: "assistant", message: { content: [] } }),
    JSON.stringify({ type: "result", subtype: "success", result: "## Review\nFinding 1" }),
    JSON.stringify({ type: "result", subtype: "success", result: "That monitor was a leftover." }),
  ].join("\n");
  assert.equal(sessionAnswer(stdout), "Waiting for the report.\n\n## Review\nFinding 1\n\nThat monitor was a leftover.");
});

test("the re-measurement rotates three arms and keeps the first pair's file name", () => {
  const arms = protocol.rerun.arms;
  assert.deepEqual(arms, ["standalone", "qamap", "candidate"]);
  const firsts = [0, 1, 2].map((index) => armOrder(arms, index, 1)[0]);
  assert.deepEqual([...firsts].sort(), [...arms].sort());
  assert.deepEqual([...armOrder(arms, 4, 1)].sort(), [...arms].sort());
  assert.equal(pairFile("s2-x-1", ["qamap", "standalone"]), "s2-x-1.pair.json");
  assert.equal(pairFile("s2-x-1", ["candidate", "standalone"]), "s2-x-1.pair-candidate-standalone.json");
  assert.deepEqual(protocol.rerun.study3.window, ["2026-09-21", "2026-10-04"]);
  assert.deepEqual(protocol.rerun2.arms, arms);
  assert.deepEqual(protocol.rerun2.pairs, protocol.rerun.pairs);
});

test("a run killed before its usage receipt counts its main-loop requests once each", () => {
  const usage = (input, read) => ({ input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: read, output_tokens: 1 });
  const stdout = [
    JSON.stringify({ type: "assistant", message: { id: "m1", usage: usage(10, 100) } }),
    JSON.stringify({ type: "assistant", message: { id: "m1", usage: usage(10, 100) } }),
    JSON.stringify({ type: "assistant", message: { id: "m2", usage: usage(5, 200) } }),
  ].join("\n");
  assert.equal(mainLoopTokens(stdout), 317);
  assert.equal(mainLoopTokens(""), null);
});
