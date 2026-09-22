const source = (...lines) => `${lines.join("\n")}\n`;
const tests = (imports, ...lines) => source(
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  ...imports,
  ...lines,
);
const anchor = (id, file, text, role) => ({ id, file, text, role });
const manifest = JSON.stringify({ name: "report-evidence-fixture", private: true,
  type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2) + "\n";

// Oracles stay outside the repositories shown to QAMap or a future reviewer.
export const cases = [
  {
    id: "shared-capacity", kind: "regression", message: "refactor: simplify remaining capacity",
    rationale: "The changed shared function and both distinct package consumers are review obligations.",
    base: {
      "packages/capacity/capacity.mjs": source("export function remaining(limit, used) {", "  return Math.max(0, limit - used);", "}"),
      "packages/capacity/index.mjs": source("export { remaining } from './capacity.mjs';"),
      "packages/panel/count.mjs": source("import { remaining } from '../capacity/index.mjs';", "export function visibleSlots(limit, used) {", "  return remaining(limit, used);", "}"),
      "packages/queue/batch.mjs": source("import { remaining } from '../capacity/index.mjs';", "export function batchSize(limit, used) {", "  return remaining(limit, used);", "}"),
      "test/capacity.test.mjs": tests(["import { remaining } from '../packages/capacity/index.mjs';"],
        "test('capacity never becomes negative', () => {", "  assert.equal(remaining(2, 3), 0);", "});"),
      "test/panel.test.mjs": tests(["import { visibleSlots } from '../packages/panel/count.mjs';"],
        "test('panel preserves zero available slots', () => {", "  assert.equal(visibleSlots(2, 3), 0);", "});"),
      "test/queue.test.mjs": tests(["import { batchSize } from '../packages/queue/batch.mjs';"],
        "test('queue preserves an empty batch', () => {", "  assert.equal(batchSize(2, 3), 0);", "});"),
    },
    head: { "packages/capacity/capacity.mjs": source("export function remaining(limit, used) {", "  return limit - used;", "}") },
    failingTests: ["capacity never becomes negative", "panel preserves zero available slots", "queue preserves an empty batch"],
    anchors: [
      anchor("changed-return", "packages/capacity/capacity.mjs", "  return limit - used;", "implementation"),
      anchor("panel-consumer", "packages/panel/count.mjs", "  return remaining(limit, used);", "consumer"),
      anchor("queue-consumer", "packages/queue/batch.mjs", "  return remaining(limit, used);", "consumer"),
      anchor("shared-assertion", "test/capacity.test.mjs", "  assert.equal(remaining(2, 3), 0);", "assertion"),
      anchor("panel-assertion", "test/panel.test.mjs", "  assert.equal(visibleSlots(2, 3), 0);", "assertion"),
      anchor("queue-assertion", "test/queue.test.mjs", "  assert.equal(batchSize(2, 3), 0);", "assertion"),
    ],
  },
  {
    id: "separated-predicate", kind: "regression", message: "refactor: normalize submission fields",
    rationale: "An early harmless edit must not hide a later changed authorization predicate in the same function.",
    base: {
      "src/submission.mjs": source(
        "export function mayPublish(record) {", "  const normalized = {",
        "    title: record.title.trim(),", "    category: record.category ?? 'general',",
        "    tags: [...new Set(record.tags ?? [])],", "    attachments: record.attachments ?? [],",
        "    reviewed: record.reviewed === true,", "    archived: record.archived === true,", "  };",
        "  const hasTitle = normalized.title.length > 0;",
        "  const hasCategory = normalized.category.length > 0;",
        "  const tagsFit = normalized.tags.length <= 5;",
        "  const attachmentsFit = normalized.attachments.length <= 3;",
        "  const isActive = !normalized.archived;",
        "  const isComplete = hasTitle && hasCategory && tagsFit && attachmentsFit && isActive;",
        "  return isComplete && normalized.reviewed;", "}"),
      "test/submission.test.mjs": tests(["import { mayPublish } from '../src/submission.mjs';"],
        "test('unreviewed submission cannot be published', () => {",
        "  assert.equal(mayPublish({ title: 'note', reviewed: false }), false);", "});"),
    },
    head: {},
    failingTests: ["unreviewed submission cannot be published"],
    anchors: [
      anchor("changed-predicate", "src/submission.mjs", "  return isComplete || normalized.reviewed;", "implementation"),
      anchor("reviewed-source", "src/submission.mjs", "    reviewed: record.reviewed === true,", "implementation"),
      anchor("unreviewed-assertion", "test/submission.test.mjs", "  assert.equal(mayPublish({ title: 'note', reviewed: false }), false);", "assertion"),
    ],
  },
  {
    id: "independent-changes", kind: "regression", message: "refactor: simplify workspace helpers",
    rationale: "Three independent regressions must not compete away each other's evidence in a two-path summary.",
    base: {
      "src/access.mjs": source("export function mayRemove(role) {", "  return role === 'owner';", "}"),
      "src/retry.mjs": source("export function delay(attempt) {", "  return Math.min(1000 * 2 ** attempt, 8000);", "}"),
      "src/cursor.mjs": source("export function hasNext(cursor) {", "  return cursor !== null;", "}"),
      "test/access.test.mjs": tests(["import { mayRemove } from '../src/access.mjs';"],
        "test('member cannot remove a workspace', () => {", "  assert.equal(mayRemove('member'), false);", "});"),
      "test/retry.test.mjs": tests(["import { delay } from '../src/retry.mjs';"],
        "test('first retry waits one second', () => {", "  assert.equal(delay(0), 1000);", "});"),
      "test/cursor.test.mjs": tests(["import { hasNext } from '../src/cursor.mjs';"],
        "test('zero remains a valid next cursor', () => {", "  assert.equal(hasNext(0), true);", "});"),
      "docs/notes.md": source("# Workspace helpers", "Helpers retain the existing contracts."),
    },
    head: {
      "src/access.mjs": source("export function mayRemove(role) {", "  return role !== 'guest';", "}"),
      "src/retry.mjs": source("export function delay(attempt) {", "  return Math.max(1000 * 2 ** attempt, 8000);", "}"),
      "src/cursor.mjs": source("export function hasNext(cursor) {", "  return Boolean(cursor);", "}"),
      "docs/notes.md": source("# Workspace utilities", "Helpers retain the existing contracts."),
    },
    failingTests: ["member cannot remove a workspace", "first retry waits one second", "zero remains a valid next cursor"],
    anchors: [
      anchor("access-expression", "src/access.mjs", "  return role !== 'guest';", "implementation"),
      anchor("access-assertion", "test/access.test.mjs", "  assert.equal(mayRemove('member'), false);", "assertion"),
      anchor("delay-expression", "src/retry.mjs", "  return Math.max(1000 * 2 ** attempt, 8000);", "implementation"),
      anchor("delay-assertion", "test/retry.test.mjs", "  assert.equal(delay(0), 1000);", "assertion"),
      anchor("cursor-expression", "src/cursor.mjs", "  return Boolean(cursor);", "implementation"),
      anchor("cursor-assertion", "test/cursor.test.mjs", "  assert.equal(hasNext(0), true);", "assertion"),
    ],
  },
  {
    id: "async-recovery", kind: "regression", message: "refactor: streamline synchronization",
    rationale: "The request failure and pending-state cleanup must both remain visible.",
    base: {
      "src/synchronize.mjs": source("export async function synchronize(state, transport) {", "  state.pending = true;",
        "  try {", "    state.value = await transport();", "    return state.value;", "  } finally {", "    state.pending = false;", "  }", "}"),
      "test/synchronize.test.mjs": tests(["import { synchronize } from '../src/synchronize.mjs';"],
        "test('failed request releases pending state', async () => {", "  const state = { pending: false, value: null };",
        "  const transport = async () => { throw new Error('offline'); };",
        "  await assert.rejects(synchronize(state, transport), /offline/);", "  assert.equal(state.pending, false);", "});"),
    },
    head: { "src/synchronize.mjs": source("export async function synchronize(state, transport) {", "  state.pending = true;",
      "  state.value = await transport();", "  state.pending = false;", "  return state.value;", "}") },
    failingTests: ["failed request releases pending state"],
    anchors: [
      anchor("await", "src/synchronize.mjs", "  state.value = await transport();", "implementation"),
      anchor("cleanup-after-await", "src/synchronize.mjs", "  state.pending = false;", "implementation"),
      anchor("failure", "test/synchronize.test.mjs", "  const transport = async () => { throw new Error('offline'); };", "assertion"),
      anchor("rejected-call", "test/synchronize.test.mjs", "  await assert.rejects(synchronize(state, transport), /offline/);", "assertion"),
      anchor("cleanup-assertion", "test/synchronize.test.mjs", "  assert.equal(state.pending, false);", "assertion"),
    ],
  },
  {
    id: "equivalent-nullish-check", kind: "negative-control", message: "refactor: shorten nullish check",
    rationale: "Passing controls are not universal bug-free proofs. Both implementation and unchanged expectations must be provided without claiming executed QA.",
    base: {
      "src/present.mjs": source("export function isPresent(value) {", "  return value !== null && value !== undefined;", "}"),
      "test/present.test.mjs": tests(["import { isPresent } from '../src/present.mjs';"],
        "test('null and undefined remain absent', () => {", "  for (const value of [null, undefined]) assert.equal(isPresent(value), false);", "});",
        "test('falsy values remain present', () => {", "  for (const value of [0, false, '']) assert.equal(isPresent(value), true);", "});"),
    },
    head: { "src/present.mjs": source("export function isPresent(value) {", "  return value != null;", "}") },
    failingTests: [],
    anchors: [
      anchor("equivalent-expression", "src/present.mjs", "  return value != null;", "implementation"),
      anchor("nullish-assertion", "test/present.test.mjs", "  for (const value of [null, undefined]) assert.equal(isPresent(value), false);", "assertion"),
      anchor("falsy-assertion", "test/present.test.mjs", "  for (const value of [0, false, '']) assert.equal(isPresent(value), true);", "assertion"),
    ],
  },
  {
    id: "runtime-module-choice", kind: "uncertainty", message: "feat: select formatter at runtime",
    rationale: "A passing example module cannot establish which module a production caller selects.",
    base: {
      "src/load.mjs": source("export async function loadFormatter(moduleId) {", "  const selected = await import('./plain.mjs');", "  return selected.format;", "}"),
      "src/plain.mjs": source("export const format = value => String(value);"),
      "test/load.test.mjs": tests(["import { loadFormatter } from '../src/load.mjs';"],
        "test('explicit plain formatter works', async () => {", "  const format = await loadFormatter('./plain.mjs');", "  assert.equal(format(12), '12');", "});"),
    },
    head: { "src/load.mjs": source("export async function loadFormatter(moduleId) {", "  const selected = await import(moduleId);", "  return selected.format;", "}") },
    failingTests: [],
    anchors: [
      anchor("runtime-import", "src/load.mjs", "  const selected = await import(moduleId);", "implementation"),
      anchor("selected-member", "src/load.mjs", "  return selected.format;", "implementation"),
      anchor("explicit-example", "test/load.test.mjs", "  const format = await loadFormatter('./plain.mjs');", "assertion"),
      anchor("example-assertion", "test/load.test.mjs", "  assert.equal(format(12), '12');", "assertion"),
    ],
    requiredGap: { file: "src/load.mjs", reason: "runtime-module-loading" },
  },
];

const predicate = cases.find(entry => entry.id === "separated-predicate");
predicate.head["src/submission.mjs"] = predicate.base["src/submission.mjs"]
  .replace("record.title.trim(),", "record.title.trim().toLowerCase(),")
  .replace("isComplete && normalized.reviewed", "isComplete || normalized.reviewed");

for (const entry of cases) {
  entry.base = { "package.json.fixture": manifest, ...entry.base };
  const head = { ...entry.base, ...entry.head };
  entry.anchors = entry.anchors.map(item => {
    const lines = head[item.file].split("\n");
    const matches = lines.flatMap((text, index) => text === item.text ? [index + 1] : []);
    if (matches.length !== 1) throw new Error(`Ambiguous oracle: ${entry.id}/${item.id}`);
    return { ...item, line: matches[0] };
  });
}
