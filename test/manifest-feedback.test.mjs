import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  generateE2ePlan,
  generateQaDraft,
  loadVerificationManifest,
  matchVerificationManifest,
  writeVerificationManifestBaseline,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);

test("manifest init creates reusable API contract flows", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-manifest-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/services"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "sample-api-service",
      private: true,
      dependencies: { fastify: "5.0.0" },
      scripts: { test: "node --test" },
    }),
  );
  await writeFile(
    path.join(root, "src/services/sample-service.ts"),
    [
      "export async function listSamples() {",
      "  return { items: [] };",
      "}",
      "",
    ].join("\n"),
  );

  const result = await writeVerificationManifestBaseline(root);
  const apiFlow = result.manifest.flows.find((flow) => flow.anchors.some((anchor) => anchor.kind === "api"));
  assert.ok(apiFlow, "expected an API contract flow in the generated baseline");
  assert.equal(apiFlow.runner, "manual");
  assert.equal(apiFlow.anchors[0].path, "src/services/sample-service.ts");
  assert.deepEqual(apiFlow.checks.map((check) => check.type), ["contract", "failure"]);

  const manifest = await loadVerificationManifest(root);
  const matches = matchVerificationManifest(manifest, [{ status: "M", path: "src/services/sample-service.ts" }]);
  assert.equal(matches.filter((match) => match.kind === "flow").length, 1);
  assert.equal(matches.filter((match) => match.kind === "check").length, 2);
});

test("manifest init keeps generic service modules out of API flows without server evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-manifest-library-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/services"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "sample-library", private: true }),
  );
  await writeFile(
    path.join(root, "src/services/sample-service.ts"),
    "export function formatSample() { return 'sample'; }\n",
  );

  const result = await writeVerificationManifestBaseline(root);
  assert.equal(result.manifest.flows.some((flow) => flow.anchors.some((anchor) => anchor.kind === "api")), false);
});

test("domain-only manifest matches preserve manifest provenance in QA drafts", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "qamap-manifest-domain-"));
  const root = path.join(tempRoot, "repo");
  const manifestPath = path.join(tempRoot, "manifest.yaml");
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/services/sample/api"), { recursive: true });
  await mkdir(path.join(root, "src/services/sample/store"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "sample-package",
      private: true,
      scripts: { test: "node --test" },
    }),
  );
  const recordPath = path.join(root, "src/services/sample/recordService.ts");
  const clientPath = path.join(root, "src/services/sample/api/client.ts");
  const statePath = path.join(root, "src/services/sample/store/sessionState.ts");
  await writeFile(recordPath, "export const record = () => true;\n");
  await writeFile(clientPath, "export const endpoint = '/sample';\n");
  await writeFile(statePath, "export const sessionState = new Map();\n");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "test@qamap.local"]);
  await git(root, ["config", "user.name", "QAMap Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "baseline"]);
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      domains: [
        {
          id: "sample",
          name: "Sample",
          paths: ["src/services/sample/**"],
          criticality: "medium",
          source: { kind: "declared", confidence: "high", from: ["team-review"] },
        },
      ],
      flows: [],
    }),
  );
  await git(root, ["switch", "-c", "feature/change"]);
  await writeFile(recordPath, "export const record = () => 'changed';\n");
  await writeFile(clientPath, "export const endpoint = '/sample/v2';\n");
  await writeFile(statePath, "export const sessionState = new Map([['ready', true]]);\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "change sample page"]);

  const options = { base: "main", head: "HEAD", manifestPath };
  const plan = await generateE2ePlan(root, options);
  assert.equal(plan.verificationManifestMatches.filter((match) => match.kind === "domain").length, 1);
  assert.equal(plan.verificationManifestMatches.filter((match) => match.kind === "flow").length, 0);
  assert.ok(plan.flows.length >= 2);
  assert.ok(plan.behaviorGraph.adapters.some((adapter) => adapter.id === "qamap.verification-manifest" && adapter.status === "used"));
  assert.equal(plan.behaviorGraph.summary.byKind.domain, 1);
  assert.ok(
    plan.behaviorGraph.nodes.some(
      (node) => node.kind === "domain" && node.evidence.some((evidence) => evidence.kind === "manifest"),
    ),
  );

  const qa = await generateQaDraft(root, options);
  assert.equal(qa.flows.length, plan.flows.length);
  assert.equal(qa.flows.filter((flow) => flow.source === "manifest-backed").length, 1);
});

async function git(cwd, args) {
  await execFileAsync("git", args, { cwd });
}
