const source = (...lines) => `${lines.join("\n")}\n`;
const tests = (imports, ...lines) => source("import assert from 'node:assert/strict';",
  "import test from 'node:test';", ...imports, ...lines);
const anchor = (id, file, text, role = "implementation") => ({ id, file, text, role });
const manifest = JSON.stringify({ name: "extended-evidence-fixture", private: true,
  type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2) + "\n";

export const cases = [
  {
    id: "aliased-export", kind: "regression", tier: "ordinary",
    message: "refactor: simplify item allowance",
    rationale: "Renamed import and export bindings must still connect a consumer to its existing expectation.",
    base: {
      "src/limit.mjs": source("export function allowance(count) {", "  return Math.max(0, count);", "}"),
      "src/index.mjs": source("export { allowance as available } from './limit.mjs';"),
      "src/view.mjs": source("import { available as slots } from './index.mjs';",
        "export function visible(count) {", "  return slots(count);", "}"),
      "test/view.test.mjs": tests(["import { visible } from '../src/view.mjs';"],
        "test('view never shows negative allowance', () => {", "  assert.equal(visible(-1), 0);", "});"),
    },
    head: { "src/limit.mjs": source("export function allowance(count) {", "  return count;", "}") },
    failingTests: ["view never shows negative allowance"],
    anchors: [anchor("changed-limit", "src/limit.mjs", "  return count;"),
      anchor("aliased-consumer", "src/view.mjs", "  return slots(count);", "consumer"),
      anchor("view-expectation", "test/view.test.mjs", "  assert.equal(visible(-1), 0);", "assertion")],
  },
  {
    id: "distant-assertion", kind: "regression", tier: "ordinary",
    message: "refactor: adjust item total",
    rationale: "The test invocation is not the assertion; the expected value remains necessary even after intervening setup.",
    base: {
      "src/total.mjs": source("export function total(items) {", "  return items.length;", "}"),
      "test/total.test.mjs": tests(["import { total } from '../src/total.mjs';"],
        "test('total counts every item', () => {", "  const observed = total(['a', 'b']);",
        ...Array.from({ length: 12 }, (_, i) => `  const note${i} = 'fixture-${i}';`),
        "  assert.equal(observed, 2);", "});"),
    },
    head: { "src/total.mjs": source("export function total(items) {", "  return items.length + 1;", "}") },
    failingTests: ["total counts every item"],
    anchors: [anchor("changed-total", "src/total.mjs", "  return items.length + 1;"),
      anchor("test-invocation", "test/total.test.mjs", "  const observed = total(['a', 'b']);", "assertion"),
      anchor("distant-expectation", "test/total.test.mjs", "  assert.equal(observed, 2);", "assertion")],
  },
  {
    id: "deletion-only-guard", kind: "regression", tier: "ordinary",
    message: "refactor: remove redundant transfer guard",
    rationale: "A deletion-only authorization change needs the surviving side effect and its expectation, not just a declaration header.",
    base: {
      "src/transfer.mjs": source("export function transfer(state) {",
        ...Array.from({ length: 10 }, (_, i) => `  const metric${i} = ${i};`),
        "  if (!state.allowed) return false;", "  state.completed = true;", "  return true;", "}"),
      "test/transfer.test.mjs": tests(["import { transfer } from '../src/transfer.mjs';"],
        "test('disallowed transfer leaves state unchanged', () => {",
        "  const state = { allowed: false, completed: false };", "  assert.equal(transfer(state), false);",
        "  assert.equal(state.completed, false);", "});"),
    },
    head: {}, failingTests: ["disallowed transfer leaves state unchanged"],
    anchors: [anchor("unguarded-side-effect", "src/transfer.mjs", "  state.completed = true;"),
      anchor("transfer-expectation", "test/transfer.test.mjs", "  assert.equal(transfer(state), false);", "assertion"),
      anchor("unchanged-state", "test/transfer.test.mjs", "  assert.equal(state.completed, false);", "assertion")],
  },
  {
    id: "multiline-guard", kind: "regression", tier: "ordinary",
    message: "refactor: simplify visibility check",
    rationale: "A changed boolean operator must be shown with both operands and the existing denial expectation.",
    base: {
      "src/visibility.mjs": source("export function visible(record) {", "  return (", "    record.enabled",
        "    &&", "    record.confirmed", "  );", "}"),
      "test/visibility.test.mjs": tests(["import { visible } from '../src/visibility.mjs';"],
        "test('enabled but unconfirmed remains hidden', () => {",
        "  assert.equal(visible({ enabled: true, confirmed: false }), false);", "});"),
    },
    head: { "src/visibility.mjs": source("export function visible(record) {", "  return (", "    record.enabled",
      "    ||", "    record.confirmed", "  );", "}") },
    failingTests: ["enabled but unconfirmed remains hidden"],
    anchors: [anchor("operator", "src/visibility.mjs", "    ||"),
      anchor("first-operand", "src/visibility.mjs", "    record.enabled"),
      anchor("second-operand", "src/visibility.mjs", "    record.confirmed"),
      anchor("denial", "test/visibility.test.mjs", "  assert.equal(visible({ enabled: true, confirmed: false }), false);", "assertion")],
  },
  {
    id: "exception-propagation", kind: "regression", tier: "ordinary",
    message: "refactor: handle load failures locally",
    rationale: "A swallowed exception must retain the thrown test value and rejected-promise contract.",
    base: {
      "src/read.mjs": source("export async function read(transport) {", "  return await transport();", "}"),
      "test/read.test.mjs": tests(["import { read } from '../src/read.mjs';"],
        "test('load failures propagate to the caller', async () => {",
        "  const transport = async () => { throw new Error('unavailable'); };",
        "  await assert.rejects(read(transport), /unavailable/);", "});"),
    },
    head: { "src/read.mjs": source("export async function read(transport) {", "  try {",
      "    return await transport();", "  } catch {", "    return null;", "  }", "}") },
    failingTests: ["load failures propagate to the caller"],
    anchors: [anchor("swallowed-failure", "src/read.mjs", "    return null;"),
      anchor("rejected-transport", "test/read.test.mjs", "  const transport = async () => { throw new Error('unavailable'); };", "assertion"),
      anchor("rejection-contract", "test/read.test.mjs", "  await assert.rejects(read(transport), /unavailable/);", "assertion")],
  },
  {
    id: "constant-return-control", kind: "negative-control", tier: "ordinary",
    message: "refactor: name the empty label",
    rationale: "An equivalent local-constant refactor remains a control; evidence availability is not a semantic no-bug verdict.",
    base: {
      "src/label.mjs": source("export function emptyLabel() {", "  return 'None';", "}"),
      "test/label.test.mjs": tests(["import { emptyLabel } from '../src/label.mjs';"],
        "test('empty label remains stable', () => {", "  assert.equal(emptyLabel(), 'None');", "});"),
    },
    head: { "src/label.mjs": source("export function emptyLabel() {", "  const label = 'None';", "  return label;", "}") },
    failingTests: [],
    anchors: [anchor("literal", "src/label.mjs", "  const label = 'None';"),
      anchor("returned-label", "src/label.mjs", "  return label;"),
      anchor("label-expectation", "test/label.test.mjs", "  assert.equal(emptyLabel(), 'None');", "assertion")],
  },
  {
    id: "runtime-policy-choice", kind: "uncertainty", tier: "ordinary",
    message: "feat: choose validation policy dynamically",
    rationale: "A passing explicit policy example must not erase an unknown runtime-selected module.",
    base: {
      "src/select.mjs": source("export async function selectPolicy(moduleName) {",
        "  const policy = await import('./policy.mjs');", "  return policy.accept;", "}"),
      "src/policy.mjs": source("export const accept = value => value >= 0;"),
      "test/select.test.mjs": tests(["import { selectPolicy } from '../src/select.mjs';"],
        "test('explicit policy example rejects negatives', async () => {",
        "  const accept = await selectPolicy('./policy.mjs');", "  assert.equal(accept(-1), false);", "});"),
    },
    head: { "src/select.mjs": source("export async function selectPolicy(moduleName) {",
      "  const policy = await import(moduleName);", "  return policy.accept;", "}") },
    failingTests: [],
    requiredGap: { file: "src/select.mjs", reason: "runtime-module-loading" },
    anchors: [anchor("dynamic-policy", "src/select.mjs", "  const policy = await import(moduleName);"),
      anchor("explicit-policy", "test/select.test.mjs", "  const accept = await selectPolicy('./policy.mjs');", "assertion"),
      anchor("policy-expectation", "test/select.test.mjs", "  assert.equal(accept(-1), false);", "assertion")],
  },
];

const deletion = cases.find(entry => entry.id === "deletion-only-guard");
deletion.head["src/transfer.mjs"] = deletion.base["src/transfer.mjs"].replace("  if (!state.allowed) return false;\n", "");

function independentChanges(count, noise) {
  const entry = { id: `independent-${count}-files-${noise}`, kind: "regression", tier: "scale",
    message: "refactor: streamline independent calculations",
    rationale: "Every independent changed contract remains required even when the repository or diff is large.",
    base: {}, head: {}, anchors: [], failingTests: [] };
  for (let i = 0; i < count; i++) {
    const name = `calculation${i}`, file = `src/${name}.mjs`, testFile = `test/${name}.test.mjs`;
    const title = `calculation ${i} keeps its lower bound`;
    entry.base[file] = source(`export function ${name}(value) {`, "  return Math.max(0, value);", "}");
    entry.head[file] = source(`export function ${name}(value) {`, "  return value;", "}");
    entry.base[testFile] = tests([`import { ${name} } from '../${file}';`],
      `test('${title}', () => {`, `  assert.equal(${name}(-1), 0);`, "});");
    entry.anchors.push(anchor(`${name}-source`, file, "  return value;"),
      anchor(`${name}-assertion`, testFile, `  assert.equal(${name}(-1), 0);`, "assertion"));
    entry.failingTests.push(title);
  }
  for (let i = 0; i < noise; i++) entry.base[`src/unrelated/value${i}.mjs`] = source(`export const value${i} = ${i};`);
  return entry;
}
cases.push(independentChanges(1, 1200), independentChanges(12, 40));

const fanout = { id: "shared-twelve-consumers", kind: "regression", tier: "scale",
  message: "refactor: simplify shared charge calculation",
  rationale: "All declared consumer expectations matter; a truthful omitted count is not evidence for an omitted consumer.",
  base: { "src/charge.mjs": source("export function charge(value) {", "  return Math.max(0, value);", "}") },
  head: { "src/charge.mjs": source("export function charge(value) {", "  return value;", "}") },
  anchors: [anchor("charge-source", "src/charge.mjs", "  return value;")], failingTests: [] };
for (let i = 0; i < 12; i++) {
  const file = `src/consumer${i}.mjs`, testFile = `test/consumer${i}.test.mjs`, name = `consumer${i}`;
  const title = `consumer ${i} retains a nonnegative charge`;
  fanout.base[file] = source("import { charge } from './charge.mjs';", `export function ${name}(value) {`, "  return charge(value);", "}");
  fanout.base[testFile] = tests([`import { ${name} } from '../${file}';`], `test('${title}', () => {`,
    `  assert.equal(${name}(-1), 0);`, "});");
  fanout.anchors.push(anchor(`${name}-call`, file, "  return charge(value);", "consumer"),
    anchor(`${name}-assertion`, testFile, `  assert.equal(${name}(-1), 0);`, "assertion"));
  fanout.failingTests.push(title);
}
cases.push(fanout);

for (const entry of cases) {
  entry.base = { "package.json.fixture": manifest, ...entry.base };
  const files = { ...entry.base, ...entry.head };
  entry.anchors = entry.anchors.map(item => {
    const matches = files[item.file].split("\n").flatMap((text, index) => text === item.text ? [index + 1] : []);
    if (matches.length !== 1) throw new Error(`Ambiguous oracle: ${entry.id}/${item.id}`);
    return { ...item, line: matches[0] };
  });
}
