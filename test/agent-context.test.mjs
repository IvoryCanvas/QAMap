import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  buildAgentContextContract,
  compareAgentContextContracts,
} from "../dist/agent-context.js";
import { repositoryNamespace } from "../dist/git-context.js";

const execFileAsync = promisify(execFile);

function contextInput(overrides = {}) {
  return {
    repository: {
      id: "repo:example",
      project: "web",
      runner: "playwright",
      analysisScope: {
        mode: "repository-root",
        candidates: [
          { path: "apps/store", packageName: "store", project: "web", runner: "playwright" },
          { path: "packages/shared", packageName: "shared", project: "node", runner: "manual" },
        ],
      },
      testSuite: { present: true, files: 12 },
    },
    manifest: {
      version: 1,
      context: {
        instructionFiles: [],
        validationCommands: ["pnpm test"],
        safetyRules: ["Do not call production services."],
        source: { kind: "declared", confidence: "high", from: ["team review", "runbook"] },
      },
      domains: [{
        id: "checkout",
        name: "Checkout",
        paths: ["src/checkout/**"],
        criticality: "high",
        source: { kind: "declared", confidence: "high", from: ["team review", "domain map"] },
      }],
      flows: [{
        id: "submit-order",
        domain: "checkout",
        name: "Submit order",
        entry: { route: "/checkout", source: "declared" },
        runner: "playwright",
        anchors: [{
          kind: "route",
          route: "/checkout",
          source: "declared",
          confidence: "high",
        }],
        checks: [{ id: "success", title: "Order is accepted", type: "success" }],
        source: { kind: "declared", confidence: "high", from: ["team review", "flow review"] },
      }],
    },
    validationCommands: ["pnpm test"],
    delta: {
      base: "main",
      baseSource: "explicit",
      head: "HEAD",
      includeWorkingTree: false,
      changedFiles: ["src/checkout/submit.ts"],
      intents: [{ id: "intent:submit-order" }],
      traces: [{ id: "trace:submit-order" }],
      flows: [{ title: "Submit order" }],
      execution: { status: "not-run", performed: false },
    },
    ...overrides,
  };
}

test("stable context identity is deterministic across ordering and volatile metadata", () => {
  const first = buildAgentContextContract(contextInput());
  const reordered = contextInput();
  reordered.repository.analysisScope.candidates.reverse();
  reordered.manifest.domains[0].paths = ["src/checkout/**"];
  reordered.manifest.context.source.from.reverse();
  reordered.manifest.domains[0].source.from.reverse();
  reordered.manifest.flows[0].source.from.reverse();
  reordered.validationCommands = ["pnpm test", "pnpm test"];
  reordered.delta.head = "feature/another-change";
  reordered.delta.changedFiles = ["src/checkout/retry.ts"];
  reordered.delta.intents = [{ id: "intent:retry-order" }];
  reordered.delta.execution = {
    status: "passed",
    performed: true,
    generatedAt: "2099-01-01T00:00:00.000Z",
    nonce: "different-run",
    recoveryPath: "/tmp/another-report.json",
  };
  const second = buildAgentContextContract(reordered);

  assert.equal(second.stable.id, first.stable.id);
  assert.deepEqual(second.stable.blocks, first.stable.blocks);
  assert.notEqual(second.delta.id, first.delta.id);
});

test("validation and behavior changes invalidate only their owning stable block", () => {
  const initialInput = contextInput();
  const initial = buildAgentContextContract(initialInput);

  const validationInput = structuredClone(initialInput);
  validationInput.manifest.context.validationCommands.push("pnpm lint");
  const validation = buildAgentContextContract(validationInput);
  assert.deepEqual(compareAgentContextContracts(initial, validation), {
    reused: ["repository", "manifest", "behavior"],
    invalidated: [{
      kind: "validation",
      previousId: initial.stable.blocks.find((block) => block.kind === "validation").id,
      currentId: validation.stable.blocks.find((block) => block.kind === "validation").id,
    }],
  });

  const behaviorInput = structuredClone(initialInput);
  behaviorInput.manifest.flows[0].checks[0].title = "Order confirmation is visible";
  const behavior = buildAgentContextContract(behaviorInput);
  assert.deepEqual(compareAgentContextContracts(initial, behavior), {
    reused: ["repository", "manifest", "validation"],
    invalidated: [{
      kind: "behavior",
      previousId: initial.stable.blocks.find((block) => block.kind === "behavior").id,
      currentId: behavior.stable.blocks.find((block) => block.kind === "behavior").id,
    }],
  });
});

test("unrelated repositories do not share the stable repository identity", () => {
  const first = buildAgentContextContract(contextInput());
  const unrelatedInput = contextInput();
  unrelatedInput.repository.id = "repo:unrelated";
  const unrelated = buildAgentContextContract(unrelatedInput);
  const comparison = compareAgentContextContracts(first, unrelated);

  assert.notEqual(unrelated.stable.id, first.stable.id);
  assert.deepEqual(comparison.reused, ["manifest", "validation", "behavior"]);
  assert.deepEqual(comparison.invalidated.map((item) => item.kind), ["repository"]);
});

test("repository identity is opaque and stable across equivalent remote URL forms", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qamap-context-repository-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["remote", "add", "origin", "https://github.com/example/context-repo.git"], {
    cwd: root,
  });
  const httpsIdentity = await repositoryNamespace(root);

  await execFileAsync("git", ["remote", "set-url", "origin", "git@github.com:example/context-repo.git"], {
    cwd: root,
  });
  const sshIdentity = await repositoryNamespace(root);

  assert.equal(sshIdentity, httpsIdentity);
  assert.match(httpsIdentity, /^repo:[a-f0-9]{64}$/u);
  assert.doesNotMatch(httpsIdentity, /github|example|context-repo/iu);
});

test("full context details stay out of compact handoffs unless requested", () => {
  const compact = buildAgentContextContract(contextInput());
  const full = buildAgentContextContract(contextInput(), { includeDetails: true });

  assert.equal(compact.stable.blocks.some((block) => "data" in block), false);
  assert.equal("data" in compact.delta, false);
  assert.equal(full.stable.blocks.every((block) => "data" in block), true);
  assert.equal("data" in full.delta, true);
  assert.equal(full.stable.id, compact.stable.id);
  assert.equal(full.delta.id, compact.delta.id);
});
