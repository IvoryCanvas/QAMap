import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { generateQaDraft } from "../dist/qa.js";
import { buildQaBrief } from "../dist/qa-brief.js";

test("shallow boundary commits cannot attach unrelated QA focus to the current diff", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-shallow-intent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  const commit = message => { git("add", "."); git("commit", "-qm", message); return git("rev-parse", "HEAD"); };
  git("init", "-qb", "main");
  await put("src/value.ts", "export function value(input: number) {\n  return input;\n}\n");
  commit("chore: baseline");
  await put("src/panel.ts", "export const label = 'ready';\n");
  const boundary = commit("fix: validate accounts and show notifications");
  git("branch", "fix/value");
  await put("src/panel.ts", "export const label = 'waiting';\n");
  const base = commit("fix: update panel label");
  git("switch", "fix/value");
  await put("src/value.ts", "export function value(input: number) {\n  return Math.max(0, input);\n}\n");
  commit("fix: return a nonnegative value");
  git("merge", "--no-ff", "main", "-m", "Merge main");
  const options = { base: "main", head: "HEAD", automaticWorkspaceScope: false };
  const complete = await generateQaDraft(root, options);
  assert.ok(complete.changeAnalysis.intents.some(intent => /nonnegative/.test(intent.title)));
  assert.ok(!complete.changeAnalysis.intents.some(intent => /accounts|notifications/i.test(intent.title)));
  // Two fetch boundaries make an old target commit appear in base..head as a
  // synthetic root whose file list includes every file in its tree.
  await writeFile(path.join(root, ".git/shallow"), `${base}\n${boundary}\n`);
  const shallow = await generateQaDraft(root, options);
  assert.ok(shallow.changeAnalysis.intents.some(intent => /nonnegative/.test(intent.title)));
  assert.ok(!shallow.changeAnalysis.intents.some(intent => /accounts|notifications/i.test(intent.title)),
    "an unknown parent must not turn the entire tree into changed behavior evidence");
  assert.ok(shallow.changeAnalysis.diagnostics.some(message => /shallow.*boundary/i.test(message)));
  const brief = await buildQaBrief(shallow);
  assert.match(brief, /== Unknowns ==[\s\S]*shallow.*boundary/i);
  assert.doesNotMatch(brief.split("== What to verify")[1]?.split("== Unknowns")[0] ?? "", /accounts|notifications/i);
  assert.equal(shallow.execution.status, "not-run");
});
