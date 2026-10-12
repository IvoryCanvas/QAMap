import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIRED_SECTIONS, validatePullRequestEvent } from "../scripts/check-pr-policy.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/check-pr-policy.mjs", import.meta.url));

const validBody = `## Summary

Add a deterministic contribution policy check.

## Behavioral Contract

Ready pull requests report every policy violation in one run.

## Evidence

Closes #265.

## Checks

- [x] Focused regression test
- [ ] \`pnpm test\`

## Public OSS Check

- [x] No private repository data is included.
- [x] Shared inference coverage is present or not applicable.
- [x] User-facing claims match actual behavior.

## Review Notes

Other checks are not applicable.
`;

function eventWith(overrides = {}) {
  const pullRequest = {
    draft: false,
    title: "Feat: enforce pull request contribution policy",
    body: validBody,
    head: { ref: "feat/contribution-policy-ci" },
    labels: [{ name: "type: feat" }, { name: "area: github-action" }],
    ...overrides,
  };
  return { pull_request: pullRequest };
}

test("accepts a ready pull request that follows the contribution contract", () => {
  assert.deepEqual(validatePullRequestEvent(eventWith()), { skipped: false, errors: [], notes: [] });
});

test("allows an incomplete draft without weakening ready pull request policy", () => {
  assert.deepEqual(
    validatePullRequestEvent(
      eventWith({ draft: true, title: "work in progress", body: "", labels: [] }),
    ),
    { skipped: true, errors: [], notes: [] },
  );
});

test("reports title and branch violations together", () => {
  const result = validatePullRequestEvent(
    eventWith({ title: "feat: lowercase type", head: { ref: "feature/unsupported" } }),
  );

  assert.equal(result.errors.length, 2);
  assert.match(result.errors[0], /PR title/);
  assert.match(result.errors[1], /branch prefix/);
});

test("requires every template section with visible core evidence", () => {
  const body = validBody
    .replace("Add a deterministic contribution policy check.", "<!-- empty -->")
    .replace("## Evidence\n\nCloses #265.\n\n", "");
  const result = validatePullRequestEvent(eventWith({ body }));

  assert.ok(result.errors.some((error) => error.includes("`## Evidence`")));
  assert.ok(result.errors.some((error) => error.includes("`## Summary`")));
});

test("requires completed validation and public OSS confirmations", () => {
  const body = validBody.replaceAll("[x]", "[ ]");
  const result = validatePullRequestEvent(eventWith({ body }));

  assert.ok(result.errors.some((error) => error.includes("`## Checks`")));
  assert.ok(result.errors.some((error) => error.includes("`## Public OSS Check`")));
});

test("requires one type label and at least one area label", () => {
  const result = validatePullRequestEvent(
    eventWith({ labels: [{ name: "type: feat" }, { name: "type: test" }] }),
  );

  assert.ok(result.errors.some((error) => error.includes("exactly one `type:`")));
  assert.ok(result.errors.some((error) => error.includes("at least one `area:`")));
});

test("a pull request from a fork gets label and branch rules as notes", () => {
  const fork = {
    head: { ref: "patch-1", repo: { full_name: "contributor/QAMap" } },
    base: { repo: { full_name: "IvoryCanvas/QAMap" } },
    labels: [],
  };
  const result = validatePullRequestEvent(eventWith(fork));

  assert.deepEqual(result.errors, []);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /maintainer applies the `type:` and `area:` labels/);

  const deletedFork = validatePullRequestEvent(eventWith({ ...fork, head: { ref: "patch-1", repo: null } }));
  assert.deepEqual(deletedFork.errors, []);

  const labeled = validatePullRequestEvent(
    eventWith({ ...fork, labels: [{ name: "type: fix" }, { name: "area: review" }] }),
  );
  assert.deepEqual(labeled, { skipped: false, errors: [], notes: [] });
});

test("a fork pull request still needs the title and template", () => {
  const result = validatePullRequestEvent(eventWith({
    title: "fix typo",
    body: validBody.replaceAll("[x]", "[ ]"),
    head: { ref: "patch-1", repo: { full_name: "contributor/QAMap" } },
    base: { repo: { full_name: "IvoryCanvas/QAMap" } },
    labels: [],
  }));

  assert.ok(result.errors.some((error) => error.includes("PR title")));
  assert.ok(result.errors.some((error) => error.includes("`## Checks`")));
  assert.ok(result.errors.some((error) => error.includes("`## Public OSS Check`")));
  assert.ok(!result.errors.some((error) => /branch prefix|label/.test(error)));
});

test("a same-repository pull request keeps the branch and label rules", () => {
  const result = validatePullRequestEvent(eventWith({
    head: { ref: "patch-1", repo: { full_name: "IvoryCanvas/QAMap" } },
    base: { repo: { full_name: "IvoryCanvas/QAMap" } },
    labels: [],
  }));

  assert.ok(result.errors.some((error) => error.includes("branch prefix")));
  assert.ok(result.errors.some((error) => error.includes("exactly one `type:`")));
  assert.deepEqual(result.notes, []);
});

test("fails closed when the event is not a pull request", () => {
  const result = validatePullRequestEvent({});

  assert.equal(result.skipped, false);
  assert.match(result.errors[0], /does not contain a pull request/);
});

test("the CLI reads a GitHub event file and returns its policy result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qamap-pr-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, "event.json");
  await writeFile(eventPath, JSON.stringify(eventWith()), "utf8");

  const result = spawnSync(process.execPath, [scriptPath, eventPath], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /contribution policy passed/);
});

test("the CLI passes a fork pull request without labels and prints the note", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qamap-pr-policy-fork-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, "event.json");
  await writeFile(eventPath, JSON.stringify(eventWith({
    head: { ref: "main", repo: { full_name: "contributor/QAMap" } },
    base: { repo: { full_name: "IvoryCanvas/QAMap" } },
    labels: [],
  })), "utf8");

  const result = spawnSync(process.execPath, [scriptPath, eventPath], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Note: A maintainer applies/);
  assert.match(result.stdout, /contribution policy passed/);
});

test("the CLI exits non-zero with actionable errors for an invalid ready PR", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "qamap-pr-policy-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const eventPath = path.join(root, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify(eventWith({ title: "feat: invalid title", labels: [] })),
    "utf8",
  );

  const result = spawnSync(process.execPath, [scriptPath, eventPath], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /contribution policy failed/);
  assert.match(result.stderr, /PR title/);
  assert.match(result.stderr, /exactly one `type:` label/);
  assert.match(result.stderr, /at least one `area:` label/);
});

test("the validator and pull request template share the same required headings", () => {
  assert.deepEqual(REQUIRED_SECTIONS, [
    "Summary",
    "Behavioral Contract",
    "Evidence",
    "Checks",
    "Public OSS Check",
    "Review Notes",
  ]);
});
