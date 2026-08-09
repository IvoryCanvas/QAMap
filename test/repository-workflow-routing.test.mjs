import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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

test("routes localized and packaged documentation to repository documentation verification", async () => {
  const root = await makeTempRepo();
  await initGitRepo(root);
  await writeJson(path.join(root, "package.json"), {
    name: "documentation-tool",
    version: "1.0.0",
    files: ["README.md", "docs"],
    scripts: {
      test: "node --test",
      "test:docs": "node --test test/docs-contract.test.mjs",
    },
  });
  await writeProjectFile(root, "README.md", "# Documentation Tool\n\n[English guide](docs/en/README.md)\n");
  await writeProjectFile(root, "CHANGELOG.md", "# Changelog\n");
  await writeProjectFile(root, "docs/en/README.md", "# English guide\n\nRun `npm test`.\n");
  await writeProjectFile(
    root,
    "test/docs-contract.test.mjs",
    'import test from "node:test";\ntest("documentation links resolve", () => {});\n',
  );
  await commitAll(root, "chore: initialize documentation");

  await git(root, ["switch", "-c", "docs/localized-guides"]);
  await writeJson(path.join(root, "package.json"), {
    name: "documentation-tool",
    version: "1.0.0",
    files: ["README.md", "README.ko.md", "docs"],
    scripts: {
      test: "node --test",
      "test:docs": "node --test test/docs-contract.test.mjs",
    },
  });
  await writeProjectFile(
    root,
    "README.md",
    "# Documentation Tool\n\n[English guide](docs/en/README.md) | [한국어](README.ko.md)\n",
  );
  await writeProjectFile(root, "README.ko.md", "# 문서 도구\n\n[한국어 안내](docs/ko/README.md)\n");
  await writeProjectFile(root, "docs/ko/README.md", "# 한국어 안내\n\n`npm test`를 실행하세요.\n");
  await writeProjectFile(root, "docs/assets/cover-ko.svg", "<svg><title>한국어 문서</title></svg>\n");
  await writeProjectFile(root, "CHANGELOG.md", "# Changelog\n\n- Add localized documentation.\n");
  await writeProjectFile(
    root,
    "test/docs-contract.test.mjs",
    [
      'import test from "node:test";',
      'test("documentation links resolve", () => {});',
      'test("localized documentation is packaged", () => {});',
      "",
    ].join("\n"),
  );
  await commitAll(root, "docs: add localized documentation paths");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const agent = JSON.parse(formatAgentQaDraft(qa));
  const markdown = formatMarkdownQaDraft(qa);

  assert.equal(plan.changeAnalysis.intents.length, 1);
  assert.match(plan.changeAnalysis.intents[0]?.title ?? "", /repository documentation/i);
  assert.equal(plan.changeAnalysis.intents[0]?.evidence[0]?.file, "README.ko.md");
  assert.notEqual(plan.changeAnalysis.intents[0]?.evidence[0]?.file, "CHANGELOG.md");
  assert.ok(plan.changeAnalysis.intents[0]?.evidence.some((item) =>
    item.file === "README.ko.md" && item.sourceRole === "documentation" && item.startLine !== undefined
  ));
  assert.deepEqual(plan.flows.map((flow) => flow.kind), ["documentation"]);
  assert.match(plan.flows[0]?.title ?? "", /repository documentation verification/i);
  assert.ok(plan.flows[0]?.files.includes("README.ko.md"));
  assert.ok(plan.flows[0]?.files.includes("docs/ko/README.md"));
  assert.ok(plan.flows[0]?.files.includes("package.json"));
  assert.equal(qa.flows[0]?.verificationMode, "documentation");
  assert.equal(qa.execution.status, "not-run");
  assert.equal(qa.readiness.level, "ready");
  assert.equal(qa.readiness.score, 100);
  assert.match(qa.route.command ?? qa.suggestedCommands[0] ?? "", /docs-contract|test:docs/i);
  assert.equal(agent.automation, undefined);
  assert.doesNotMatch(markdown, /clean install|app launch|endpoint|authentication|response shape/i);
});

test("routes issue forms and pull request templates to repository workflow verification", async () => {
  const root = await makeTempRepo();
  await initGitRepo(root);
  await writeJson(path.join(root, "package.json"), {
    name: "workflow-tool",
    version: "1.0.0",
    scripts: {
      test: "node --test",
      "test:workflow": "node --test test/workflow-contract.test.mjs",
    },
  });
  await writeProjectFile(root, ".github/ISSUE_TEMPLATE/bug.yml", "name: Bug\nlabels: [bug]\n");
  await writeProjectFile(root, ".github/pull_request_template.md", "## Summary\n");
  await writeProjectFile(
    root,
    "test/workflow-contract.test.mjs",
    'import test from "node:test";\ntest("repository templates parse", () => {});\n',
  );
  await commitAll(root, "chore: initialize contribution workflow");

  await git(root, ["switch", "-c", "docs/contribution-contract"]);
  await writeProjectFile(
    root,
    ".github/ISSUE_TEMPLATE/bug.yml",
    "name: Bug\nlabels: [type: fix]\nassignees: [maintainer]\nbody:\n  - type: textarea\n    validations:\n      required: true\n",
  );
  await writeProjectFile(
    root,
    ".github/pull_request_template.md",
    "## Summary\n\n## Behavioral Contract\n\n## Evidence\n",
  );
  await writeProjectFile(
    root,
    "test/workflow-contract.test.mjs",
    [
      'import test from "node:test";',
      'test("repository templates parse", () => {});',
      'test("required fields and sections stay present", () => {});',
      "",
    ].join("\n"),
  );
  await commitAll(root, "docs: clarify contribution contracts");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const markdown = formatMarkdownQaDraft(qa);

  assert.equal(plan.changeAnalysis.intents.length, 1);
  assert.match(plan.changeAnalysis.intents[0]?.title ?? "", /repository contribution workflow/i);
  assert.ok(plan.changeAnalysis.intents[0]?.evidence.some((item) =>
    item.file === ".github/ISSUE_TEMPLATE/bug.yml" && item.sourceRole === "repository-workflow"
  ));
  assert.deepEqual(plan.flows.map((flow) => flow.kind), ["documentation"]);
  assert.match(plan.flows[0]?.title ?? "", /repository workflow documentation verification/i);
  assert.match(plan.flows[0]?.steps.join("\n") ?? "", /YAML|required fields|labels|assignees/i);
  assert.match(plan.flows[0]?.steps.join("\n") ?? "", /pull request template|required sections/i);
  assert.equal(qa.flows[0]?.verificationMode, "documentation");
  assert.match(qa.route.command ?? qa.suggestedCommands[0] ?? "", /workflow-contract|test:workflow/i);
  assert.doesNotMatch(markdown, /clean install|app launch|endpoint|authentication|response shape/i);
});

test("keeps a real API handler change in product contract QA", async () => {
  const root = await makeTempRepo();
  await initGitRepo(root);
  await writeJson(path.join(root, "package.json"), {
    name: "orders-api",
    version: "1.0.0",
    dependencies: { express: "^5.0.0" },
  });
  await writeProjectFile(
    root,
    "src/routes/orders.ts",
    "export function getOrders(_request, response) { return response.status(200).json({ orders: [] }); }\n",
  );
  await writeProjectFile(root, "README.md", "# Orders API\n");
  await commitAll(root, "feat: add orders endpoint");

  await git(root, ["switch", "-c", "feat/order-filter"]);
  await writeProjectFile(
    root,
    "src/routes/orders.ts",
    "export function getOrders(request, response) { return response.status(200).json({ orders: [], status: request.query.status }); }\n",
  );
  await writeProjectFile(root, "README.md", "# Orders API\n\nSupports the status filter.\n");
  await commitAll(root, "feat: filter orders by status");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });

  assert.equal(plan.flows.some((flow) => flow.kind === "api"), true);
  assert.equal(plan.flows.every((flow) => flow.kind === "documentation"), false);
  assert.ok(plan.changeAnalysis.intents.some((intent) => intent.files.includes("src/routes/orders.ts")));
});

async function makeTempRepo() {
  return mkdtemp(path.join(tmpdir(), "qamap-repository-workflow-"));
}

async function initGitRepo(root) {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "tests@example.test"]);
  await git(root, ["config", "user.name", "QAMap Tests"]);
  await git(root, ["branch", "-M", "main"]);
}

async function commitAll(root, message) {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeProjectFile(root, relativePath, contents) {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function git(root, args) {
  await execFileAsync("git", args, { cwd: root });
}
