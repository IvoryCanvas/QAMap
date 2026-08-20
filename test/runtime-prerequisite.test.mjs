import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  formatAgentQaDraft,
  formatTextQaDraft,
  generateE2ePlan,
  generateQaDraft,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

test("routes a reused context consumer with a bypassed provider to runtime verification", async () => {
  const root = await createProviderRepository({ baselineMockTest: true });
  await writeProjectFile(
    root,
    "pages/public-preview.tsx",
    [
      'import { WorkspacePanel } from "../src/components/WorkspacePanel";',
      "",
      "function PublicPreviewPage() {",
      "  return <main><h1>Public preview</h1><WorkspacePanel /></main>;",
      "}",
      "",
      "PublicPreviewPage.publicPage = true;",
      "export default PublicPreviewPage;",
      "",
    ].join("\n"),
  );
  await writeProjectFile(
    root,
    "test/public-preview.test.tsx",
    [
      'import { vi } from "vitest";',
      'vi.mock("../src/components/WorkspacePanel", () => ({',
      "  WorkspacePanel: () => <section>Workspace preview</section>,",
      "}));",
      'test("renders the public preview route", () => { expect(true).toBe(true); });',
      "",
    ].join("\n"),
  );
  await commitAll(root, "feat: add public workspace preview");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });
  const intent = plan.changeAnalysis.intents.find((candidate) =>
    candidate.keywords.includes("runtime-prerequisite")
  );

  assert.ok(intent, "expected a runtime prerequisite intent");
  assert.equal(intent.confidence, "high");
  assert.equal(intent.reviewRequired, false);
  assert.equal(intent.scenarios[0]?.priority, "critical");
  assert.match(intent.scenarios[0]?.title ?? "", /required workspace provider context/i);
  assert.match(intent.scenarios[0]?.setup.join("\n") ?? "", /production app wrapper/i);
  assert.match(intent.scenarios[0]?.assertions.join("\n") ?? "", /first visible state/i);
  assert.ok(intent.evidence.some((item) =>
    item.kind === "diff" &&
    item.file === "pages/public-preview.tsx" &&
    item.relation === "direct" &&
    item.startLine === 1
  ));
  assert.ok(intent.evidence.some((item) =>
    item.kind === "source" &&
    item.file === "src/context/WorkspaceContext.tsx" &&
    item.relation === "supporting" &&
    /WorkspaceProvider/.test(item.value)
  ));
  assert.ok(intent.evidence.some((item) =>
    item.kind === "source" &&
    item.file === "pages/_app.tsx" &&
    item.relation === "supporting" &&
    /publicPage/.test(item.value)
  ));
  assert.ok(plan.flows.some((flow) =>
    flow.intentId === intent.id &&
    flow.entrypoints.some((entrypoint) => entrypoint.value === "/public-preview")
  ));

  const qa = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const agent = JSON.parse(formatAgentQaDraft(qa));
  const text = formatTextQaDraft(qa);
  assert.equal(qa.execution.status, "not-run");
  assert.equal(qa.route.basis, "optional-automation");
  assert.notEqual(qa.route.command, "npm test -- test/public-preview.test.tsx");
  assert.equal(qa.flows[0]?.existingEvidencePaths.includes("test/public-preview.test.tsx"), false);
  assert.equal(
    qa.suggestedCommands.some((command) => command.includes("test/public-preview.test.tsx")),
    false,
  );
  assert.ok(qa.missingEvidence.some((item) =>
    item.priority === "required" &&
    /mocks src\/components\/WorkspacePanel\.tsx/.test(item.detail)
  ));
  assert.match(qa.prChecklist[0] ?? "", /with src\/components\/WorkspacePanel\.tsx unmocked/i);
  assert.equal(
    qa.agentHandoff.some((item) => /test\/public-preview\.test\.tsx/.test(item)),
    false,
  );
  assert.equal(agent.intents.some((candidate) =>
    candidate.scenarios.some((scenario) => /required workspace provider/i.test(scenario.title))
  ), true, JSON.stringify({
    bytes: Buffer.byteLength(formatAgentQaDraft(qa)),
    compaction: agent.compaction,
    intents: agent.intents,
  }));
  assert.doesNotMatch(text, /Existing validation .*npm test/);
  assert.doesNotMatch(text, /Run selected repository validation/);
  assert.match(text, /Supplemental validation: npm test \(available, not selected for this QA route\)/);
  assert.match(text, /Review the selected scenarios before choosing an execution step/);
});

test("does not report a missing provider when the changed route wraps the consumer", async () => {
  const root = await createProviderRepository();
  await writeProjectFile(
    root,
    "pages/public-preview.tsx",
    [
      'import { WorkspacePanel } from "../src/components/WorkspacePanel";',
      'import { WorkspaceProvider } from "../src/context/WorkspaceContext";',
      "",
      "function PublicPreviewPage() {",
      "  return <WorkspaceProvider><WorkspacePanel /></WorkspaceProvider>;",
      "}",
      "",
      "PublicPreviewPage.publicPage = true;",
      "export default PublicPreviewPage;",
      "",
    ].join("\n"),
  );
  await commitAll(root, "feat: add self-contained public preview");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });

  assert.equal(
    plan.changeAnalysis.intents.some((intent) => intent.keywords.includes("runtime-prerequisite")),
    false,
  );
});

test("does not infer a provider gap without an explicit fail-fast context contract", async () => {
  const root = await createProviderRepository({ failFast: false });
  await writeProjectFile(
    root,
    "pages/public-preview.tsx",
    [
      'import { WorkspacePanel } from "../src/components/WorkspacePanel";',
      "function PublicPreviewPage() { return <WorkspacePanel />; }",
      "PublicPreviewPage.publicPage = true;",
      "export default PublicPreviewPage;",
      "",
    ].join("\n"),
  );
  await commitAll(root, "feat: add public workspace preview");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });

  assert.equal(
    plan.changeAnalysis.intents.some((intent) => intent.keywords.includes("runtime-prerequisite")),
    false,
  );
});

test("does not report a provider gap when the app wrapper provides it unconditionally", async () => {
  const root = await createProviderRepository({ unconditionalProvider: true });
  await writeProjectFile(
    root,
    "pages/public-preview.tsx",
    [
      'import { WorkspacePanel } from "../src/components/WorkspacePanel";',
      "function PublicPreviewPage() { return <WorkspacePanel />; }",
      "PublicPreviewPage.publicPage = true;",
      "export default PublicPreviewPage;",
      "",
    ].join("\n"),
  );
  await commitAll(root, "feat: add public workspace preview");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });

  assert.equal(
    plan.changeAnalysis.intents.some((intent) => intent.keywords.includes("runtime-prerequisite")),
    false,
  );
});

test("does not report a provider gap when the marked wrapper branch provides it", async () => {
  const root = await createProviderRepository({ providerInsideMarkedBranch: true });
  await writeProjectFile(
    root,
    "pages/public-preview.tsx",
    [
      'import { WorkspacePanel } from "../src/components/WorkspacePanel";',
      "function PublicPreviewPage() { return <WorkspacePanel />; }",
      "PublicPreviewPage.publicPage = true;",
      "export default PublicPreviewPage;",
      "",
    ].join("\n"),
  );
  await commitAll(root, "feat: add public workspace preview");

  const plan = await generateE2ePlan(root, { base: "main", head: "HEAD" });

  assert.equal(
    plan.changeAnalysis.intents.some((intent) => intent.keywords.includes("runtime-prerequisite")),
    false,
  );
});

async function createProviderRepository(options = {}) {
  const root = await makeTempRepo();
  await initGitRepo(root);
  await writeProjectFile(
    root,
    "package.json",
    JSON.stringify({
      name: "provider-fixture",
      private: true,
      scripts: { test: "vitest run" },
      dependencies: { next: "15.0.0", react: "19.0.0" },
      devDependencies: { vitest: "3.0.0" },
    }),
  );
  await writeProjectFile(
    root,
    "src/context/WorkspaceContext.tsx",
    options.failFast === false
      ? [
          'import { createContext, useContext } from "react";',
          'const WorkspaceContext = createContext({ name: "Guest" });',
          "export function WorkspaceProvider({ children }) {",
          '  return <WorkspaceContext.Provider value={{ name: "Demo" }}>{children}</WorkspaceContext.Provider>;',
          "}",
          "export function useWorkspace() { return useContext(WorkspaceContext); }",
          "",
        ].join("\n")
      : [
          'import { createContext, useContext } from "react";',
          "const WorkspaceContext = createContext(null);",
          "export function WorkspaceProvider({ children }) {",
          '  return <WorkspaceContext.Provider value={{ name: "Demo" }}>{children}</WorkspaceContext.Provider>;',
          "}",
          "export function useWorkspace() {",
          "  const context = useContext(WorkspaceContext);",
          "  if (!context) {",
          '    throw new Error("useWorkspace must be used within WorkspaceProvider");',
          "  }",
          "  return context;",
          "}",
          "",
        ].join("\n"),
  );
  await writeProjectFile(
    root,
    "src/components/WorkspacePanel.tsx",
    [
      'import { useWorkspace } from "../context/WorkspaceContext";',
      "export function WorkspacePanel() {",
      "  const workspace = useWorkspace();",
      "  return <section>Workspace: {workspace.name}</section>;",
      "}",
      "",
    ].join("\n"),
  );
  await writeProjectFile(
    root,
    "pages/_app.tsx",
    options.providerInsideMarkedBranch
      ? [
          'import { WorkspaceProvider } from "../src/context/WorkspaceContext";',
          "export default function App({ Component, pageProps }) {",
          "  if (Component.publicPage) {",
          "    return (",
          "      <WorkspaceProvider>",
          "        <Component {...pageProps} />",
          "      </WorkspaceProvider>",
          "    );",
          "  }",
          "  return <Component {...pageProps} />;",
          "}",
          "",
        ].join("\n")
      : options.unconditionalProvider
      ? [
          'import { WorkspaceProvider } from "../src/context/WorkspaceContext";',
          "export default function App({ Component, pageProps }) {",
          "  return <WorkspaceProvider><Component {...pageProps} /></WorkspaceProvider>;",
          "}",
          "",
        ].join("\n")
      : [
          'import { WorkspaceProvider } from "../src/context/WorkspaceContext";',
          "export default function App({ Component, pageProps }) {",
          "  if (Component.publicPage) {",
          "    return <Component {...pageProps} />;",
          "  }",
          "  return <WorkspaceProvider><Component {...pageProps} /></WorkspaceProvider>;",
          "}",
          "",
        ].join("\n"),
  );
  await writeProjectFile(
    root,
    "pages/dashboard.tsx",
    [
      'import { WorkspacePanel } from "../src/components/WorkspacePanel";',
      "export default function DashboardPage() { return <WorkspacePanel />; }",
      "",
    ].join("\n"),
  );
  if (options.baselineMockTest) {
    await writeProjectFile(
      root,
      "test/public-preview.test.tsx",
      [
        'import { vi } from "vitest";',
        'vi.mock("../src/components/WorkspacePanel", () => ({',
        "  WorkspacePanel: () => <section>Workspace preview</section>,",
        "}));",
        'test("renders a mocked panel", () => { expect(true).toBe(true); });',
        "",
      ].join("\n"),
    );
  }
  await commitAll(root, "base");
  await git(root, ["branch", "-M", "main"]);
  await git(root, ["switch", "-c", "feature/public-preview"]);
  return root;
}

async function makeTempRepo() {
  return mkdtemp(path.join(tmpdir(), "qamap-runtime-prerequisite-"));
}

async function initGitRepo(root) {
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "QAMap Test"]);
  await git(root, ["config", "user.email", "test@example.com"]);
}

async function writeProjectFile(root, relativePath, content) {
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), content);
}

async function commitAll(root, message) {
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", message]);
}

async function git(root, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout.trim();
}
