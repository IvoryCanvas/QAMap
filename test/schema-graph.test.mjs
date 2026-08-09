import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  formatAgentQaDraft,
  formatMarkdownQaDraft,
  generateE2ePlan,
  generateQaDraft,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

test("routes a newly divergent Django migration graph to exact repository verification", async () => {
  const root = await createDjangoRepository();
  await git(root, ["branch", "feature/inventory-labels"]);

  await writeMigration(root, "inventory", "0002_add_sku", [["inventory", "0001_initial"]]);
  await commitAll(root, "feat: add inventory sku");

  await git(root, ["switch", "feature/inventory-labels"]);
  await writeMigration(root, "inventory", "0003_add_label", [["inventory", "0001_initial"]]);
  await commitAll(root, "feat: add inventory label");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const flow = plan.flows[0];
  const intent = plan.changeAnalysis.intents[0];

  assert.equal(flow?.kind, "schema");
  assert.match(flow?.title ?? "", /divergent inventory migration graph leaves/i);
  assert.equal(flow?.fixtureReadiness.status, "not-needed");
  assert.deepEqual(flow?.entrypoints, []);
  assert.deepEqual(flow?.selectors, []);
  assert.equal(intent?.confidence, "high");
  assert.equal(intent?.scenarios[0]?.priority, "critical");
  assert.ok(intent?.evidence.some((item) =>
    item.kind === "diff" &&
    item.file === "inventory/migrations/0003_add_label.py" &&
    item.startLine === 6 &&
    item.relation === "direct"
  ));
  assert.ok(intent?.evidence.some((item) =>
    item.kind === "source" &&
    item.file === "inventory/migrations/0002_add_sku.py" &&
    item.side === "base" &&
    item.relation === "supporting"
  ));

  const withoutCommand = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const markdown = formatMarkdownQaDraft(withoutCommand);
  assert.equal(withoutCommand.flows[0]?.verificationMode, "schema-graph");
  assert.equal(withoutCommand.route.nextAction, "define-repository-command");
  assert.equal(withoutCommand.execution.status, "not-run");
  assert.match(markdown, /no trusted command is declared/i);
  assert.match(markdown, /changed dependency is reconciled with every target-branch leaf/i);
  assert.doesNotMatch(markdown, /Automation gap:/i);
  assert.doesNotMatch(markdown, /Trace gap: .*flow artifacts/i);
  assert.doesNotMatch(markdown, /No required automation or context gap was detected/i);

  const graphCommand = "python manage.py makemigrations --check --dry-run";
  const qa = await generateQaDraft(root, {
    base: "main",
    head: "HEAD",
    validationCommands: [graphCommand, "pytest"],
  });
  const agent = JSON.parse(formatAgentQaDraft(qa));

  assert.equal(qa.flows[0]?.verificationMode, "schema-graph");
  assert.equal(qa.route.nextAction, "run-repository-command");
  assert.equal(qa.route.command, graphCommand);
  assert.deepEqual(qa.suggestedCommands, [graphCommand]);
  assert.equal(qa.execution.status, "not-run");
  assert.equal(agent.flows[0]?.verificationMode, "schema-graph");
  assert.equal(agent.flows[0]?.scenarioAutomation, undefined);
  assert.equal(agent.intents[0]?.scenarios[0]?.automation, undefined);
  assert.equal(agent.traces[0]?.artifact, undefined);
  assert.equal(agent.execution.status, "not-run");
  assert.equal(agent.automation, undefined);
});

test("does not flag a migration that follows the current target leaf", async () => {
  const root = await createDjangoRepository();
  await writeMigration(root, "inventory", "0002_add_sku", [["inventory", "0001_initial"]]);
  await commitAll(root, "feat: add inventory sku");
  await git(root, ["switch", "-c", "feature/inventory-labels"]);
  await writeMigration(root, "inventory", "0003_add_label", [["inventory", "0002_add_sku"]]);
  await commitAll(root, "feat: add inventory label");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });

  assert.equal(plan.flows.some((flow) => flow.kind === "schema"), false);
  assert.equal(plan.changeAnalysis.intents.some((intent) => /migration graph leaves/i.test(intent.title)), false);
});

test("does not flag a branch that reconnects competing leaves with a merge migration", async () => {
  const root = await createDjangoRepository();
  await git(root, ["branch", "feature/inventory-labels"]);
  await writeMigration(root, "inventory", "0002_add_sku", [["inventory", "0001_initial"]]);
  await commitAll(root, "feat: add inventory sku");

  await git(root, ["switch", "feature/inventory-labels"]);
  await writeMigration(root, "inventory", "0003_add_label", [["inventory", "0001_initial"]]);
  await writeMigration(root, "inventory", "0004_merge_sku_label", [
    ["inventory", "0002_add_sku"],
    ["inventory", "0003_add_label"],
  ]);
  await commitAll(root, "feat: reconcile inventory migrations");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });

  assert.equal(plan.flows.some((flow) => flow.kind === "schema"), false);
});

test("does not apply Django graph rules to a numbered non-Django file tree", async () => {
  const root = await makeTempRepo();
  await initGitRepo(root);
  await mkdir(path.join(root, "inventory/migrations"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Numbered data files\n");
  await writeMigration(root, "inventory", "0001_initial", []);
  await commitAll(root, "base");
  await git(root, ["branch", "-M", "main"]);
  await git(root, ["switch", "-c", "feature/inventory-labels"]);
  await writeMigration(root, "inventory", "0002_add_label", [["inventory", "0001_initial"]]);
  await commitAll(root, "add numbered data file");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });

  assert.equal(plan.flows.some((flow) => flow.kind === "schema"), false);
});

test("detects the same graph conflict from a Django app scoped inside a workspace", async () => {
  const workspaceRoot = await makeTempRepo();
  const appRoot = path.join(workspaceRoot, "services/inventory");
  await initGitRepo(workspaceRoot);
  await mkdir(path.join(appRoot, "migrations"), { recursive: true });
  await writeFile(path.join(workspaceRoot, "manage.py"), "from django.core.management import execute_from_command_line\n");
  await writeFile(path.join(workspaceRoot, "requirements.txt"), "Django==5.1.0\n");
  await writeScopedMigration(appRoot, "0001_initial", []);
  await commitAll(workspaceRoot, "base");
  await git(workspaceRoot, ["branch", "-M", "main"]);
  await git(workspaceRoot, ["branch", "feature/inventory-labels"]);
  await writeScopedMigration(appRoot, "0002_add_sku", [["inventory", "0001_initial"]]);
  await commitAll(workspaceRoot, "feat: add inventory sku");

  await git(workspaceRoot, ["switch", "feature/inventory-labels"]);
  await writeScopedMigration(appRoot, "0003_add_label", [["inventory", "0001_initial"]]);
  await commitAll(workspaceRoot, "feat: add inventory label");

  const plan = await generateE2ePlan(appRoot, {
    workspaceRoot,
    base: "main",
    head: "HEAD",
  });

  assert.equal(plan.flows[0]?.kind, "schema");
  assert.equal(plan.flows[0]?.files[0], "migrations/0003_add_label.py");
  assert.ok(plan.changeAnalysis.intents[0]?.evidence.some((item) =>
    item.file === "migrations/0002_add_sku.py" && item.side === "base"
  ));
});

test("detects a divergent migration added only in the working tree", async () => {
  const root = await createDjangoRepository();
  await git(root, ["branch", "feature/inventory-labels"]);

  await writeMigration(root, "inventory", "0002_add_sku", [["inventory", "0001_initial"]]);
  await commitAll(root, "feat: add inventory sku");

  await git(root, ["switch", "feature/inventory-labels"]);
  await writeMigration(root, "inventory", "0003_add_label", [["inventory", "0001_initial"]]);

  const qa = await generateQaDraft(root, {
    base: "main",
    head: "HEAD",
    includeWorkingTree: true,
  });

  assert.equal(qa.flows[0]?.verificationMode, "schema-graph");
  assert.equal(qa.flows[0]?.changedFiles[0], "inventory/migrations/0003_add_label.py");
  assert.equal(qa.route.nextAction, "define-repository-command");
  assert.equal(qa.execution.status, "not-run");
});

test("agent schema lists every repository verification mode emitted by QAMap", async () => {
  const schema = JSON.parse(await readFile(new URL("../schema/qamap-agent.schema.json", import.meta.url), "utf8"));
  const modes = schema.properties.flows.items.properties.verificationMode.enum;

  assert.ok(modes.includes("schema-graph"));
  assert.ok(modes.includes("transformation-contract"));
});

async function createDjangoRepository() {
  const root = await makeTempRepo();
  await initGitRepo(root);
  await mkdir(path.join(root, "inventory/migrations"), { recursive: true });
  await writeFile(path.join(root, "manage.py"), "from django.core.management import execute_from_command_line\n");
  await writeFile(path.join(root, "requirements.txt"), "Django==5.1.0\n");
  await writeFile(path.join(root, "inventory/migrations/__init__.py"), "");
  await writeMigration(root, "inventory", "0001_initial", []);
  await commitAll(root, "base");
  await git(root, ["branch", "-M", "main"]);
  return root;
}

async function writeMigration(root, app, name, dependencies) {
  return writeMigrationFile(path.join(root, app, "migrations", `${name}.py`), dependencies);
}

async function writeScopedMigration(appRoot, name, dependencies) {
  return writeMigrationFile(path.join(appRoot, "migrations", `${name}.py`), dependencies);
}

async function writeMigrationFile(filePath, dependencies) {
  const tuples = dependencies.map(([dependencyApp, migration]) =>
    `        ("${dependencyApp}", "${migration}"),`
  );
  const content = [
    "from django.db import migrations",
    "",
    "",
    "class Migration(migrations.Migration):",
    "    dependencies = [",
    ...tuples,
    "    ]",
    "",
    "    operations = []",
    "",
  ].join("\n");
  await writeFile(filePath, content);
}

async function makeTempRepo() {
  return mkdtemp(path.join(tmpdir(), "qamap-schema-graph-"));
}

async function initGitRepo(root) {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "qamap@example.invalid"]);
  await git(root, ["config", "user.name", "QAMap Test"]);
}

async function commitAll(root, message) {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
}

async function git(root, args) {
  return execFileAsync("git", args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
}
