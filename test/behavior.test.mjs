import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeBehaviorGraph,
  createBehaviorEdge,
  createBehaviorNodeId,
  createInferredFlowBehaviorAdapter,
} from "../dist/behavior.js";
import { generateE2ePlan } from "../dist/e2e.js";

const baseContext = {
  root: "/tmp/qamap-behavior-fixture",
  base: "main",
  head: "HEAD",
  projectType: "web",
  surface: "web",
  runner: "playwright",
  changedFiles: [{ status: "M", path: "src/pages/checkout.tsx" }],
};

test("behavior graph is deterministic and keeps impact provenance", async () => {
  const adapter = createInferredFlowBehaviorAdapter({
    flows: [
      {
        kind: "ui",
        title: "Checkout submit flow",
        reason: "The changed page owns the visible submit action.",
        files: ["src/pages/checkout.tsx", "src/components/SubmitButton.tsx"],
        steps: ["Open the checkout page.", "Submit the form.", "Verify the confirmation is visible."],
        entrypoints: [
          { kind: "route", value: "/checkout", file: "src/pages/checkout.tsx", confidence: "high" },
        ],
        selectors: [
          {
            kind: "web-test-id",
            value: "checkout-submit",
            file: "src/pages/checkout.tsx",
            addedInDiff: true,
          },
        ],
        coverage: [
          {
            title: "Primary success path",
            priority: "critical",
            reason: "A visible completion signal is required.",
            checks: ["Verify the confirmation is visible."],
          },
        ],
        fixtureStatus: "ready",
        fixtureFiles: ["src/mocks/handlers.ts"],
      },
    ],
  });

  const first = await analyzeBehaviorGraph(baseContext, [adapter]);
  const second = await analyzeBehaviorGraph(baseContext, [adapter]);

  assert.deepEqual(first, second);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.adapters[0].status, "used");
  assert.equal(first.summary.byKind.flow, 1);
  assert.equal(first.summary.byKind.surface, 1);
  assert.equal(first.summary.byKind.fixture, 1);
  assert.equal(first.summary.byKind.locator, 1);
  assert.ok(first.summary.byKind.action >= 2);
  assert.ok(first.summary.byKind.assertion >= 1);

  const source = first.nodes.find((node) => node.kind === "source" && node.label === "src/pages/checkout.tsx");
  assert.deepEqual(source?.impact, { kind: "direct", changedFiles: ["src/pages/checkout.tsx"] });
  const ids = new Set(first.nodes.map((node) => node.id));
  assert.ok(first.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
});

test("behavior adapter failures are isolated and dangling edges are removed", async () => {
  const sourceId = createBehaviorNodeId("source", "src/index.ts");
  const healthyAdapter = {
    id: "adapter.healthy",
    version: "1",
    detect: () => ({ confidence: "high", reason: "fixture", evidence: ["src/index.ts"] }),
    analyze: () => ({
      nodes: [
        {
          id: sourceId,
          kind: "source",
          label: "src/index.ts",
          confidence: "high",
          evidence: [{ kind: "source", value: "src/index.ts", file: "src/index.ts" }],
        },
      ],
      edges: [createBehaviorEdge("impacts", sourceId, "flow:missing", "high")],
      diagnostics: [{ severity: "info", message: "synthetic adapter note" }],
    }),
  };
  const failingAdapter = {
    id: "adapter.failing",
    version: "1",
    detect: () => ({ confidence: "medium", reason: "fixture", evidence: [] }),
    analyze: () => {
      throw new Error("synthetic analyzer failure");
    },
  };
  const skippedAdapter = {
    id: "adapter.skipped",
    version: "1",
    detect: () => ({ confidence: "none", reason: "not applicable", evidence: [] }),
    analyze: () => ({ nodes: [], edges: [] }),
  };

  const graph = await analyzeBehaviorGraph(baseContext, [skippedAdapter, healthyAdapter, failingAdapter]);

  assert.deepEqual(
    graph.adapters.map((adapter) => [adapter.id, adapter.status]),
    [
      ["adapter.failing", "failed"],
      ["adapter.healthy", "used"],
      ["adapter.skipped", "skipped"],
    ],
  );
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.edges.length, 0);
  assert.ok(graph.diagnostics.some((diagnostic) => /synthetic analyzer failure/.test(diagnostic.message)));
  assert.ok(
    graph.diagnostics.some(
      (diagnostic) => diagnostic.adapterId === "adapter.healthy" && diagnostic.message === "synthetic adapter note",
    ),
  );
  assert.ok(graph.diagnostics.some((diagnostic) => /endpoint nodes were missing/.test(diagnostic.message)));
});

test("E2E planning exposes a behavior graph for a real branch diff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-behavior-integration-"));
  try {
    await mkdir(path.join(root, "src", "pages"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        scripts: { dev: "next dev", test: "node --test" },
        dependencies: { next: "15.0.0", react: "19.0.0" },
      }),
    );
    await writeFile(
      path.join(root, "src", "pages", "checkout.tsx"),
      "export default function Checkout() { return <button>Submit</button>; }\n",
    );
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "qamap@example.test");
    git(root, "config", "user.name", "QAMap Test");
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    git(root, "switch", "-c", "feat/checkout-submit");
    await writeFile(
      path.join(root, "src", "pages", "checkout.tsx"),
      "export default function Checkout() { return <button data-testid=\"checkout-submit\">Submit</button>; }\n",
    );
    git(root, "add", ".");
    git(root, "commit", "-m", "change checkout submit");

    const first = await generateE2ePlan(root, { base: "main", head: "HEAD" });
    const second = await generateE2ePlan(root, { base: "main", head: "HEAD" });

    assert.ok(first.flows.length > 0);
    assert.ok(first.flows.every((flow) => typeof flow.kind === "string"));
    assert.equal(first.behaviorGraph.surface, "web");
    assert.equal(first.behaviorGraph.summary.byKind.flow, first.flows.length);
    assert.ok(first.behaviorGraph.summary.byKind.surface >= 1);
    assert.ok(first.behaviorGraph.summary.byKind.locator >= 1);
    assert.ok(
      first.behaviorGraph.nodes.some(
        (node) => node.kind === "source" && node.label === "src/pages/checkout.tsx" && node.impact?.kind === "direct",
      ),
    );
    assert.deepEqual(
      first.behaviorGraph.nodes.map((node) => node.id),
      second.behaviorGraph.nodes.map((node) => node.id),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
