import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { generateQaDraft } from "../dist/index.js";

const execFileAsync = promisify(execFile);

test("working-tree test contracts recover weak product intent without neighboring surfaces", async (t) => {
  const root = await makeRepo(t);
  await writeProjectFile(
    root,
    "package.json",
    `${JSON.stringify({
      name: "preferences-app",
      scripts: { test: "node --test" },
      dependencies: { react: "19.0.0" },
    }, null, 2)}\n`,
  );
  await writeProjectFile(
    root,
    "src/preferences/PreferenceStatus.tsx",
    "export function PreferenceStatus() { return <p>Preference unavailable</p>; }\n",
  );
  await writeProjectFile(
    root,
    "src/preferences/PreferenceStatus.test.mjs",
    [
      "import { PreferenceStatus } from './PreferenceStatus';",
      "",
      "it('shows an unavailable preference', () => expect(PreferenceStatus).toBeDefined());",
      "",
    ].join("\n"),
  );
  await writeProjectFile(
    root,
    "src/account/PreferenceHistory.tsx",
    "export function PreferenceHistory() { return <p>Saved preference history</p>; }\n",
  );
  await commitAll(root, "chore: initialize preferences");

  await writeProjectFile(
    root,
    "src/preferences/PreferenceStatus.tsx",
    [
      "export function PreferenceStatus({ isRestored }) {",
      "  return <p>{isRestored ? 'Preference restored' : 'Preference unavailable'}</p>;",
      "}",
      "",
    ].join("\n"),
  );
  await writeProjectFile(
    root,
    "src/preferences/PreferenceStatus.test.mjs",
    [
      "import { PreferenceStatus } from './PreferenceStatus';",
      "",
      "it('shows an unavailable preference', () => expect(PreferenceStatus).toBeDefined());",
      "it('shows the saved preference after reload', () => expect(PreferenceStatus).toBeDefined());",
      "",
    ].join("\n"),
  );

  const qa = await generateQaDraft(root, {
    base: "main",
    head: "HEAD",
    includeWorkingTree: true,
  });
  const intent = qa.changeAnalysis.intents.find((item) =>
    item.files.includes("src/preferences/PreferenceStatus.tsx")
  );

  assert.deepEqual(qa.currentDelta?.files, [
    "src/preferences/PreferenceStatus.test.mjs",
    "src/preferences/PreferenceStatus.tsx",
  ]);
  assert.ok(intent, JSON.stringify(qa.changeAnalysis, null, 2));
  assert.equal(intent.confidence, "low");
  assert.equal(intent.reviewRequired, true);
  assert.deepEqual(intent.commits, []);
  assert.ok(intent.files.includes("src/preferences/PreferenceStatus.test.mjs"));
  assert.equal(
    intent.lifecycle.some((stage) =>
      stage.evidence.some((item) => item.symbol === "changed-test-assertion")
    ),
    false,
  );
  assert.ok(intent.lifecycle.some((stage) =>
    stage.kind === "observable-outcome" && /shows the saved preference after reload/i.test(stage.label)
  ));
  const primaryScenario = intent.scenarios.find((scenario) => scenario.kind === "primary");
  assert.deepEqual(primaryScenario?.assertions, [
    'Verify visible text "Preference restored" appears.',
    "Verify the changed test contract: shows the saved preference after reload.",
  ], JSON.stringify({ lifecycle: intent.lifecycle, scenarios: intent.scenarios }, null, 2));
  assert.equal(
    qa.changeAnalysis.intents.some((item) => item.files.includes("src/account/PreferenceHistory.tsx")),
    false,
  );
  assert.equal(
    qa.flows.some((flow) => flow.changedFiles.includes("src/account/PreferenceHistory.tsx")),
    false,
  );
  assert.match(
    qa.route.command ?? "",
    /PreferenceStatus\.test\.mjs/,
    JSON.stringify({ route: qa.route, suggestedCommands: qa.suggestedCommands, flows: qa.flows }, null, 2),
  );
  assert.equal(qa.execution.status, "not-run");
});

async function makeRepo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-working-tree-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "tests@example.test"]);
  await git(root, ["config", "user.name", "QAMap Tests"]);
  await git(root, ["branch", "-M", "main"]);
  return root;
}

async function writeProjectFile(root, relativePath, contents) {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function commitAll(root, message) {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}
