import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const issueTemplateDirectory = path.join(repositoryRoot, ".github/ISSUE_TEMPLATE");

const issueTemplates = [
  "bug_report.yml",
  "feature_request.yml",
  "qa_miss.yml",
  "rule_request.yml",
];

test("issue forms preserve the public contribution contract", async () => {
  for (const filename of issueTemplates) {
    const source = await readFile(path.join(issueTemplateDirectory, filename), "utf8");
    const form = parseYaml(source);

    assert.ok(form.name, `${filename} needs a name`);
    assert.ok(form.description, `${filename} needs a description`);
    assert.match(form.title, /^(Fix|Feat): /);
    assert.deepEqual(form.assignees, ["ivory-code"]);
    assert.equal(
      form.labels.filter((label) => label.startsWith("type: ")).length,
      1,
      `${filename} must declare exactly one type label`,
    );
    assert.ok(
      form.body.some((field) => field.validations?.required === true),
      `${filename} needs at least one required field`,
    );
  }
});

test("the issue chooser routes private reports away from blank issues", async () => {
  const source = await readFile(path.join(issueTemplateDirectory, "config.yml"), "utf8");
  const config = parseYaml(source);

  assert.equal(config.blank_issues_enabled, false);
  assert.ok(
    config.contact_links.some(
      (link) =>
        link.name === "Security report" &&
        link.url === "https://github.com/IvoryCanvas/QAMap/security/advisories/new",
    ),
  );
});

test("the pull request template asks for behavior and evidence", async () => {
  const template = await readFile(
    path.join(repositoryRoot, ".github/pull_request_template.md"),
    "utf8",
  );

  for (const heading of [
    "## Summary",
    "## Behavioral Contract",
    "## Evidence",
    "## Checks",
    "## Public OSS Check",
    "## Review Notes",
  ]) {
    assert.match(template, new RegExp(`^${heading}$`, "m"));
  }
});

test("entry-point documentation links resolve inside the repository", async () => {
  for (const relativeDocument of [
    "README.md",
    "README.ko.md",
    "CONTRIBUTING.md",
    "docs/README.md",
    "docs/en/README.md",
    "docs/ko/README.md",
    "docs/ko/quickstart.md",
    "docs/ko/agent-integration.md",
    "docs/ko/manifest.md",
    "docs/issues.md",
  ]) {
    const absoluteDocument = path.join(repositoryRoot, relativeDocument);
    const source = await readFile(absoluteDocument, "utf8");
    const links = [...source.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);

    for (const rawTarget of links) {
      const target = rawTarget.replace(/^<|>$/g, "").split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) {
        continue;
      }

      const resolved = path.resolve(path.dirname(absoluteDocument), decodeURIComponent(target));
      const linkedFile = await stat(resolved);
      assert.ok(
        linkedFile.isFile() || linkedFile.isDirectory(),
        `${relativeDocument} links to missing path ${target}`,
      );
    }
  }
});
