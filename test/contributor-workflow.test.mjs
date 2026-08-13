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

test("public plugin guidance links directly to the official installation steps", async () => {
  const installationUrl =
    "https://learn.chatgpt.com/docs/plugins#install-and-use-a-plugin";

  for (const relativeDocument of [
    "README.md",
    "README.ko.md",
    "docs/ko/agent-integration.md",
  ]) {
    const source = await readFile(path.join(repositoryRoot, relativeDocument), "utf8");
    assert.ok(
      source.includes(installationUrl),
      `${relativeDocument} must link directly to the official plugin installation steps`,
    );
    assert.ok(
      !source.includes("https://learn.chatgpt.com/docs/plugins)"),
      `${relativeDocument} must not send readers to the general Plugins overview`,
    );
  }
});

test("the Korean entry point uses natural copy and portable Markdown", async () => {
  const readme = await readFile(path.join(repositoryRoot, "README.ko.md"), "utf8");
  const cover = await readFile(
    path.join(repositoryRoot, "docs/assets/qamap-cover-ko.svg"),
    "utf8",
  );

  for (const source of [readme, cover]) {
    assert.ok(
      !source.includes("변경이 무엇을 증명해야 하는지"),
      "the old translated slogan must not return",
    );
  }
  for (const rawHtml of ["<a ", "<img ", "<details>", "<summary>"]) {
    assert.ok(
      !readme.includes(rawHtml),
      `README.ko.md must use portable Markdown instead of ${rawHtml.trim()}`,
    );
  }
  assert.ok(
    readme.includes("이 PR에서 꼭 확인해야 할 부분을 찾아줍니다."),
    "README.ko.md must open with the current Korean product promise",
  );
  assert.ok(
    cover.includes("이 PR에서 꼭 확인해야 할 부분을 찾아줍니다."),
    "the Korean cover must match the README promise",
  );
});

test("public READMEs present local setup before the optional plugin path", async () => {
  const contracts = [
    {
      file: "README.md",
      install: "## Install And Run",
      local: "### Local CLI (Recommended)",
      package: "#### Install For Repeat Use",
      plugin: "### ChatGPT And Codex Plugin",
      result: "## Read The Result",
      demo: "## See A Real Run",
      daily: "## Daily CLI Use",
      analysis: "## Analysis, Execution, And E2E",
      how: "## How It Works",
      agents: "## Agents And Team Context",
      docs: "## Documentation",
      limits: "## Limits",
      stale: ["## Run The CLI In 60 Seconds", "## Install For Repeat Use"],
    },
    {
      file: "README.ko.md",
      install: "## 설치하고 실행하기",
      local: "### 로컬 CLI (권장)",
      package: "#### 반복 사용을 위해 프로젝트에 설치",
      plugin: "### ChatGPT·Codex 플러그인",
      result: "## 결과 읽는 방법",
      demo: "## 실제 실행 예시",
      daily: "## 반복해서 CLI 사용하기",
      analysis: "## 분석, 실행, E2E의 차이",
      how: "## 동작 방식",
      agents: "## 에이전트와 팀 맥락",
      docs: "## 목적별 문서",
      limits: "## 현재 한계",
      stale: ["## 60초 만에 실행하기", "## 반복 사용을 위한 설치"],
    },
  ];

  for (const contract of contracts) {
    const source = await readFile(path.join(repositoryRoot, contract.file), "utf8");
    const orderedSections = [
      contract.install,
      contract.local,
      contract.package,
      contract.plugin,
      contract.result,
      contract.demo,
      contract.daily,
      contract.analysis,
      contract.how,
      contract.agents,
      contract.docs,
      contract.limits,
    ].map((heading) => source.indexOf(heading));

    assert.ok(
      orderedSections.every((position) => position >= 0),
      `${contract.file} must include every setup entry point`,
    );
    assert.deepEqual(
      [...orderedSections].sort((left, right) => left - right),
      orderedSections,
      `${contract.file} must present local setup before the plugin and result guide`,
    );
    for (const staleHeading of contract.stale) {
      assert.ok(
        !source.includes(`\n${staleHeading}\n`),
        `${contract.file} must not keep the old split installation hierarchy`,
      );
    }
  }
});
