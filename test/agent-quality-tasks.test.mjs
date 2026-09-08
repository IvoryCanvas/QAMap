import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSuite } from "../scripts/agent-bench/suite.mjs";
import { judgeSuccess } from "../scripts/agent-bench/judge.mjs";
import { materializeFixtureRepo } from "../scripts/lib/fixture-repo.mjs";
import { createRepositoryEnvironment } from "../scripts/agent-bench/repository-arms.mjs";
import { snapshotEvidenceFixture } from "../scripts/agent-bench/evidence-quality.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await fs.readFile(path.join(root, "agent-repository-bench.config.json"), "utf8"));
const suite = await loadSuite({ repositoryRoot: root, taskIds: config.tasks });

for (const task of suite.tasks) test(`public oracle accepts complete answers and rejects omissions: ${task.id}`, async (t) => {
  const prepared = await materializeFixtureRepo({ fixtureRoot: task.fixtureRoot,
    baseDirs: task.fixture.baseOverlay === "base" ? ["base"] : ["base", task.fixture.baseOverlay],
    commits: [{ dir: task.fixture.headOverlay, message: task.fixture.commitMessage }] });
  t.after(prepared.cleanup);
  const env = await createRepositoryEnvironment(prepared.tempRoot);
  const criterion = task.successCriteria.find((entry) => entry.kind === "qa-evidence");
  const answerPath = path.join(prepared.repositoryRoot, criterion.path);
  const answer = structuredClone(criterion.expected);
  const original = await snapshotEvidenceFixture(prepared.repositoryRoot);
  for (const location of answer.evidence) {
    const source = await fs.readFile(path.join(prepared.repositoryRoot, location.file), "utf8");
    assert.ok(source.split("\n")[location.line - 1]?.trim(), "oracle cites an actual expression or assertion");
  }
  await fs.writeFile(answerPath, JSON.stringify(answer));
  const valid = await judgeSuccess(task.successCriteria, prepared.repositoryRoot, { env });
  assert.equal(await snapshotEvidenceFixture(prepared.repositoryRoot), original);
  assert.equal(valid.success, true, JSON.stringify(valid.checks));
  assert.equal(valid.quality[0].evidenceRecall, 1);
  assert.equal(valid.quality[0].contractCompleteness, 1);
  answer.evidence.pop();
  await fs.writeFile(answerPath, JSON.stringify(answer));
  assert.equal((await judgeSuccess([criterion], prepared.repositoryRoot, { env })).success, false);
  await fs.writeFile(answerPath, JSON.stringify(criterion.expected));
  await fs.appendFile(path.join(prepared.repositoryRoot, "src/profile.mjs"), "// changed by answer\n");
  assert.notEqual(await snapshotEvidenceFixture(prepared.repositoryRoot), original);
  assert.equal((await judgeSuccess(task.successCriteria, prepared.repositoryRoot, { env })).success, false);
});

test("quality answer files are bounded and symlinks are not read", async (t) => {
  const task = suite.tasks[0];
  const prepared = await materializeFixtureRepo({ fixtureRoot: task.fixtureRoot,
    commits: [{ dir: task.fixture.headOverlay, message: task.fixture.commitMessage }] });
  t.after(prepared.cleanup);
  const criterion = task.successCriteria.find((entry) => entry.kind === "qa-evidence");
  const target = path.join(prepared.tempRoot, "outside.json");
  const answer = path.join(prepared.repositoryRoot, criterion.path);
  await fs.writeFile(target, JSON.stringify(criterion.expected));
  await fs.symlink(target, answer);
  assert.equal((await judgeSuccess([criterion], prepared.repositoryRoot)).success, false);
  await fs.unlink(answer);
  await fs.writeFile(answer, " ".repeat(65_537) + JSON.stringify(criterion.expected));
  assert.equal((await judgeSuccess([criterion], prepared.repositoryRoot)).success, false);
});
