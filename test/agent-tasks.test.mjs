import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LOCAL_CRITERIA_KINDS } from "../scripts/agent-bench/judge.mjs";
import { loadSuite, validateSchema } from "../scripts/agent-bench/suite.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suiteRoot = path.join(root, "test", "agent-tasks");

test("every committed agent task validates, reuses a public fixture, and judges success locally", async () => {
  const config = JSON.parse(await readFile(path.join(root, "agent-bench.config.json"), "utf8"));
  const entries = await readdir(suiteRoot, { withFileTypes: true });
  const taskDirectories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(taskDirectories, [...config.tasks].sort());
  assert.deepEqual(config.arms, ["generic", "qamap"]);
  assert.equal(config.runs >= 3, true, "the committed contract records at least three runs");

  const suite = await loadSuite({ repositoryRoot: root, taskIds: config.tasks });
  assert.equal(suite.tasks.length, 3);
  assert.match(suite.sha256, /^[a-f0-9]{64}$/);

  for (const task of suite.tasks) {
    assert.equal(task.dir, path.join(suiteRoot, task.id));
    assert.match(task.fixture.path, /^test\/benchmarks\/[a-z0-9-]+$/);
    assert.equal((await stat(task.fixtureRoot)).isDirectory(), true);
    for (const overlay of ["base", task.fixture.baseOverlay, task.fixture.headOverlay]) {
      assert.equal((await stat(path.join(task.fixtureRoot, overlay))).isDirectory(), true);
    }
    assert.equal(task.successCriteria.length > 0, true);
    for (const criterion of task.successCriteria) {
      assert.equal(LOCAL_CRITERIA_KINDS.includes(criterion.kind), true, `${task.id} uses ${criterion.kind}`);
      assert.doesNotMatch(JSON.stringify(criterion), /^\/|\/tmp|\/var\/folders|\.\./);
    }
    assert.equal(task.successCriteria.some((criterion) => criterion.kind === "json-path-equals"), true);
    assert.equal(
      task.successCriteria.some((criterion) =>
        criterion.kind === "command-exit" && criterion.command.join(" ").startsWith("git diff --quiet HEAD")
      ),
      true,
      `${task.id} must prove that product source stayed untouched`,
    );
    assert.equal(typeof task.firstAuthoring, "boolean");
    assert.doesNotMatch(task.prompt, /\/tmp|\/var\/folders|sk-/);
    for (const input of task.inputs ?? []) {
      assert.equal((await stat(path.join(task.dir, input.from))).isFile(), true);
    }
  }

  const byId = new Map(suite.tasks.map((task) => [task.id, task]));
  assert.equal(byId.get("reproduce-regression").firstAuthoring, true);
  assert.equal(byId.get("verify-copy-against-spec").inputs[0].to, "docs/shipping-status-copy.md");
  assert.equal(byId.get("reverify-after-fix").fixture.baseOverlay, "regression");
  assert.equal(byId.get("reverify-after-fix").firstAuthoring, false);
});

test("the task schema rejects non-local success criteria, unknown fields, and escaping paths", async () => {
  const schema = JSON.parse(await readFile(path.join(suiteRoot, "schema.json"), "utf8"));
  const valid = JSON.parse(await readFile(path.join(suiteRoot, "reproduce-regression", "task.json"), "utf8"));
  assert.deepEqual(validateSchema(valid, schema), []);

  const proseJudged = structuredClone(valid);
  proseJudged.successCriteria.push({ kind: "model-judgement", prompt: "Did the agent explain the bug?" });
  assert.equal(validateSchema(proseJudged, schema).length > 0, true);

  const unknownField = structuredClone(valid);
  unknownField.judgeByProse = true;
  assert.match(validateSchema(unknownField, schema).join("\n"), /judgeByProse is not allowed/);

  const privateFixture = structuredClone(valid);
  privateFixture.fixture.path = "../private-repository";
  assert.match(validateSchema(privateFixture, schema).join("\n"), /fixture\.path must match/);

  const escapingCriterion = structuredClone(valid);
  escapingCriterion.successCriteria[0] = { kind: "file-exists", path: "../outside.txt" };
  assert.equal(validateSchema(escapingCriterion, schema).length > 0, true);

  const missingTurns = structuredClone(valid);
  delete missingTurns.maxTurns;
  assert.match(validateSchema(missingTurns, schema).join("\n"), /maxTurns is required/);

  await assert.rejects(
    loadSuite({ repositoryRoot: root, taskIds: ["does-not-exist"] }),
    /ENOENT|not a directory/,
  );
});
