import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatTextQaDraft, generateQaDraft } from "../dist/qa.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("public README demos are generated from the current QA engine", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-readme-demo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "qamap@example.test");
  git(root, "config", "user.name", "QAMap Test");

  await write(root, "package.json", JSON.stringify({
    scripts: { dev: "vite", "test:e2e": "playwright test" },
    dependencies: {
      react: "19.0.0",
      vite: "7.0.0",
      "@playwright/test": "1.56.0",
    },
  }));
  await write(
    root,
    "playwright.config.ts",
    "export default { use: { baseURL: 'http://127.0.0.1:4173' } };\n",
  );
  await write(root, "src/pages/renewal.tsx", renewalSource(false));
  commit(root, "benchmark baseline");
  git(root, "switch", "-c", "fix/renewal-duplicate");
  await write(root, "src/pages/renewal.tsx", renewalSource(true));
  commit(root, "fix: prevent duplicate subscription renewal requests");

  const result = await generateQaDraft(root, { base: "main", head: "HEAD" });
  const actual = formatTextQaDraft(result).trimEnd();

  for (const [file, heading] of [
    ["README.md", "## See A Real Run"],
    ["README.ko.md", "## 실제 실행 예시"],
  ]) {
    const source = await readFile(path.join(repositoryRoot, file), "utf8");
    assert.equal(extractTextBlock(source, heading), actual, `${file} demo drifted from the QA engine`);
  }
});

function renewalSource(withDuplicateGuard) {
  return [
    "/**",
    " * @qamapFlow subscription-renewal",
    " * @qamapStage action Renew the subscription",
    " * @qamapOutcome Subscription status becomes active",
    " * @qamapRisk Duplicate renewal request",
    " */",
    "export default function RenewalPage() {",
    "  const [status, setStatus] = useState('idle');",
    "  const [renewing, setRenewing] = useState(false);",
    "  async function renew() {",
    withDuplicateGuard ? "    if (renewing) return;" : "",
    "    setRenewing(true);",
    "    await renewSubscription();",
    "    setStatus('active');",
    "  }",
    "  return <main>",
    "    <button data-testid=\"renew-subscription\" onClick={renew}>Renew subscription</button>",
    "    {status === 'active' ? <p>Subscription active</p> : null}",
    "  </main>;",
    "}",
    "async function renewSubscription() {",
    "  const response = await fetch('/api/subscriptions/renew', { method: 'POST' });",
    "  if (!response.ok) throw new Error('Could not renew subscription');",
    "  return response.json();",
    "}",
    "",
  ].filter(Boolean).join("\n");
}

function extractTextBlock(source, heading) {
  const section = source.slice(source.indexOf(heading) + heading.length);
  const match = section.match(/```txt\n([\s\S]*?)\n```/);
  assert.ok(match, `${heading} must contain a txt code block`);
  return match[1];
}

async function write(root, file, content) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
}

function git(root, ...args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}
