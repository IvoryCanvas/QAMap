import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
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

function pngDimensions(source) {
  assert.deepEqual(
    [...source.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "brand asset must be a PNG",
  );
  return [source.readUInt32BE(16), source.readUInt32BE(20)];
}

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

test("pull request workflows stay read-only and pin external actions", async () => {
  const workflowDirectory = path.join(repositoryRoot, ".github/workflows");
  const workflowFiles = (await readdir(workflowDirectory)).filter((file) => file.endsWith(".yml"));

  for (const filename of workflowFiles) {
    const source = await readFile(path.join(workflowDirectory, filename), "utf8");
    const workflow = parseYaml(source);

    assert.ok(!source.includes("pull_request_target"), `${filename} must remain safe for fork PRs`);
    if (workflow.on?.pull_request !== undefined) {
      assert.equal(workflow.permissions?.contents, "read", `${filename} needs read-only contents`);
    }

    for (const match of source.matchAll(/^\s*uses:\s*(\S+)/gm)) {
      const action = match[1];
      if (action.startsWith("./")) {
        continue;
      }
      assert.match(
        action,
        /^[^@\s]+@[0-9a-f]{40}$/,
        `${filename} must pin ${action} to a full commit SHA`,
      );
    }
  }
});

test("CI prepares pnpm after Node.js and reuses one compiled build per job", async () => {
  const workflowSource = await readFile(
    path.join(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  const workflow = parseYaml(workflowSource);
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const pnpmVersion = packageJson.packageManager.replace(/^pnpm@/, "");

  for (const jobName of ["test", "execution-benchmark"]) {
    const job = workflow.jobs[jobName];
    const nodeIndex = job.steps.findIndex((step) => step.name === "Set up Node.js");
    const cacheIndex = job.steps.findIndex((step) => step.name === "Restore pnpm caches");
    const pnpmIndex = job.steps.findIndex((step) => step.name === "Set up pnpm");
    const buildCommands = job.steps.filter((step) => step.run === "pnpm build");
    const cacheStep = job.steps[cacheIndex];
    const pnpmStep = job.steps[pnpmIndex];

    assert.ok(
      nodeIndex >= 0 && nodeIndex < cacheIndex && cacheIndex < pnpmIndex,
      `${jobName} must prepare Node.js, restore caches, then enable pnpm`,
    );
    assert.equal(job.steps[nodeIndex].with?.cache, undefined, `${jobName} must not cache pnpm before it exists`);
    assert.match(cacheStep.with.path, /\.cache\/node\/corepack/);
    assert.match(cacheStep.with.path, /\.local\/share\/pnpm\/store/);
    assert.ok(cacheStep.with.key.includes(pnpmVersion), `${jobName} cache key must track the pinned pnpm version`);
    assert.equal(pnpmStep["timeout-minutes"], 2);
    assert.match(pnpmStep.run, /corepack enable pnpm/);
    assert.match(pnpmStep.run, /timeout 30s pnpm --version/);
    assert.match(pnpmStep.run, /for attempt in 1 2 3/);
    assert.equal(buildCommands.length, 1, `${jobName} must compile exactly once`);
  }

  assert.ok(!workflowSource.includes("pnpm/action-setup@"), "CI must avoid the flaky self-installer path");
  assert.equal(workflow.jobs.test["timeout-minutes"], 15);
  assert.equal(workflow.jobs["execution-benchmark"]["timeout-minutes"], 15);
  assert.equal(workflow.jobs["execution-benchmark"].needs, "test");

  const testCommands = workflow.jobs.test.steps.map((step) => step.run).filter(Boolean);
  for (const command of [
    "pnpm test:compiled",
    "pnpm plugin:smoke:compiled",
    "pnpm bench:ci:compiled",
    "pnpm bench:agent:compiled --dry-run --assert",
    "pnpm bench:context:compiled",
    "pnpm scan:compiled",
  ]) {
    assert.ok(testCommands.includes(command), `CI must run ${command} without rebuilding`);
  }
  assert.ok(
    workflow.jobs["execution-benchmark"].steps.some(
      (step) => step.run === "pnpm bench:execution:compiled",
    ),
    "the execution benchmark must reuse its job build",
  );

  for (const [publicScript, compiledScript] of [
    ["test", "test:compiled"],
    ["scan", "scan:compiled"],
    ["plugin:smoke", "plugin:smoke:compiled"],
    ["bench:ci", "bench:ci:compiled"],
    ["bench:agent", "bench:agent:compiled"],
    ["bench:context", "bench:context:compiled"],
    ["bench:execution", "bench:execution:compiled"],
  ]) {
    assert.match(packageJson.scripts[publicScript], /^pnpm build && /);
    assert.ok(packageJson.scripts[compiledScript], `${compiledScript} must expose the no-build command`);
  }
});

test("ready pull requests receive policy and dependency review checks", async () => {
  const policy = parseYaml(
    await readFile(path.join(repositoryRoot, ".github/workflows/pr-policy.yml"), "utf8"),
  );
  const dependencyReview = parseYaml(
    await readFile(path.join(repositoryRoot, ".github/workflows/dependency-review.yml"), "utf8"),
  );

  assert.equal(policy.jobs["contribution-policy"].name, "Contribution policy");
  assert.match(
    policy.jobs["contribution-policy"].steps.at(-1).run,
    /scripts\/check-pr-policy\.mjs/,
  );
  assert.equal(dependencyReview.jobs["dependency-review"].name, "Dependency review");
  assert.equal(
    dependencyReview.jobs["dependency-review"].steps.at(-1).with["fail-on-severity"],
    "high",
  );
});

test("entry-point documentation links resolve inside the repository", async () => {
  for (const relativeDocument of [
    "README.md",
    "README.ko.md",
    "brand/README.md",
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

test("public brand images keep their intended production dimensions", async () => {
  const assets = new Map([
    ["docs/assets/qamap-cover.png", [1600, 800]],
    ["docs/assets/qamap-cover-ko.png", [1600, 800]],
    ["docs/assets/qamap-github-social-preview-1280x640.png", [1280, 640]],
    ["docs/assets/qamap-social-card.png", [1200, 630]],
    ["brand/png/qamap-app-icon-1024.png", [1024, 1024]],
    ["brand/png/qamap-app-icon-512.png", [512, 512]],
    ["brand/png/qamap-app-icon-256.png", [256, 256]],
    ["brand/png/qamap-mark-transparent-1024.png", [1024, 1024]],
    ["brand/png/qamap-mark-transparent-512.png", [512, 512]],
    ["brand/png/qamap-mark-transparent-256.png", [256, 256]],
    ["brand/web/apple-touch-icon-180.png", [180, 180]],
    ["brand/web/favicon-16.png", [16, 16]],
    ["brand/web/favicon-32.png", [32, 32]],
    ["brand/web/favicon-48.png", [48, 48]],
    ["brand/web/qamap-icon-192.png", [192, 192]],
    ["brand/web/qamap-icon-512.png", [512, 512]],
    ["skills/qamap-pr-qa/assets/qamap-logo.png", [512, 512]],
    ["plugin/assets/qamap-plugin-light-256.png", [256, 256]],
    ["plugin/assets/qamap-plugin-dark-256.png", [256, 256]],
    ["plugin/assets/qamap-composer-light-48.png", [48, 48]],
    ["plugin/assets/qamap-composer-dark-48.png", [48, 48]],
  ]);

  for (const [relativePath, expected] of assets) {
    const source = await readFile(path.join(repositoryRoot, relativePath));
    assert.deepEqual(pngDimensions(source), expected, `${relativePath} has the wrong dimensions`);
  }
});

test("editable brand masters stay portable vectors", async () => {
  for (const relativePath of [
    "brand/source/qamap-mark.svg",
    "brand/source/qamap-mark-monochrome.svg",
    "brand/source/qamap-app-icon.svg",
  ]) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    assert.match(source, /<svg\b/);
    assert.doesNotMatch(source, /<(?:image|filter|linearGradient|radialGradient|text)\b/);
  }

  const favicon = await readFile(path.join(repositoryRoot, "brand/web/favicon.ico"));
  assert.deepEqual([...favicon.subarray(0, 4)], [0, 0, 1, 0]);
});

test("directory guidance does not hard-code a stale approved version", async () => {
  const documents = ["docs/plugin-submission.md", "docs/agent-skill.md"];

  for (const relativePath of documents) {
    const source = await readFile(path.join(repositoryRoot, relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /QAMap `\d+\.\d+\.\d+` is currently .*OpenAI Plugin Directory/,
      `${relativePath} must defer the approved version to the public listing`,
    );
    assert.ok(
      source.includes("https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629"),
      `${relativePath} must link to the public listing`,
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
    readme.includes("병합 전에 무엇을 테스트할지 확인하세요."),
    "README.ko.md must open with the current Korean product promise",
  );
  assert.ok(
    cover.includes("병합 전에 무엇을 테스트할지 확인하세요."),
    "the Korean cover must match the README promise",
  );
});

test("public READMEs present local setup before the optional plugin path", async () => {
  const contracts = [
    {
      file: "README.md",
      install: "## Install And Run",
      local: "### Local CLI (Recommended)",
      plugin: "### ChatGPT And Codex Plugin",
      result: "## Read The Result",
      demo: "## See A Real Run",
      how: "## How It Works",
      docs: "## Documentation",
      limits: "## Limits",
      stale: ["## Start Here", "## Daily CLI Use", "## Agents And Team Context"],
    },
    {
      file: "README.ko.md",
      install: "## 설치하고 실행하기",
      local: "### 로컬 CLI (권장)",
      plugin: "### ChatGPT와 Codex 플러그인",
      result: "## 결과 읽는 방법",
      demo: "## 실제 실행 예시",
      how: "## 동작 방식",
      docs: "## 목적별 문서",
      limits: "## 현재 한계",
      stale: ["## 시작하기", "## 반복해서 CLI 사용하기", "## 에이전트와 팀 맥락"],
    },
  ];

  for (const contract of contracts) {
    const source = await readFile(path.join(repositoryRoot, contract.file), "utf8");
    const orderedSections = [
      contract.install,
      contract.local,
      contract.plugin,
      contract.result,
      contract.demo,
      contract.how,
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
    assert.ok(
      source.split("\n").length <= 140,
      `${contract.file} must remain a focused entry point instead of a full reference`,
    );
    for (const staleHeading of contract.stale) {
      assert.ok(
        !source.includes(`\n${staleHeading}\n`),
        `${contract.file} must not keep the old split installation hierarchy`,
      );
    }
  }
});
