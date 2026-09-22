const source = (...lines) => lines.join("\n") + "\n";
const prelude = ["import assert from 'node:assert/strict';", "import test from 'node:test';"];
const anchor = (id, file, text, role = "implementation") => ({ id, file, text, role });

export const cases = [
  {
    id: "rounded-invoice-chain", kind: "regression", tier: "confirmation",
    message: "refactor: simplify invoice rounding",
    rationale: "An unchanged consumer and a distant transformed expectation must survive together.",
    base: {
      "src/cents.mjs": source("export function cents(amount) {", "  return Math.round(amount * 100);", "}"),
      "src/invoice.mjs": source("import { cents as rounded } from './cents.mjs';",
        "export function invoice(amount) {", "  return rounded(amount) / 100;", "}"),
      "test/invoice.test.mjs": source(...prelude, "import { invoice } from '../src/invoice.mjs';",
        "test('invoice preserves nearest cent', () => {", "  const actual = invoice(1.239);",
        "  const printable = actual.toFixed(2);",
        ...Array.from({ length: 16 }, (_, i) => `  const unrelated${i} = ${i};`),
        "  assert.equal(unrelated0, 0);", "  assert.equal(printable, '1.24');", "});"),
    },
    head: { "src/cents.mjs": source("export function cents(amount) {", "  return Math.floor(amount * 100);", "}") },
    failingTests: ["invoice preserves nearest cent"],
    anchors: [anchor("rounding", "src/cents.mjs", "  return Math.floor(amount * 100);"),
      anchor("consumer", "src/invoice.mjs", "  return rounded(amount) / 100;", "consumer"),
      anchor("invocation", "test/invoice.test.mjs", "  const actual = invoice(1.239);", "assertion"),
      anchor("transformation", "test/invoice.test.mjs", "  const printable = actual.toFixed(2);", "assertion"),
      anchor("expectation", "test/invoice.test.mjs", "  assert.equal(printable, '1.24');", "assertion")],
  },
  {
    id: "two-removed-guards", kind: "regression", tier: "confirmation",
    message: "refactor: simplify reservation checks",
    rationale: "Two deletion sites in one declaration must not collapse to the first site.",
    base: {
      "src/reserve.mjs": source("export function reserve(state) {", "  if (!state.active) return false;",
        "  const activeSeen = state.active;", ...Array.from({ length: 16 }, (_, i) => `  const metric${i} = ${i};`),
        "  if (state.balance < 1) return false;", "  state.balance -= 1;", "  return true;", "}"),
      "test/reserve.test.mjs": source(...prelude, "import { reserve } from '../src/reserve.mjs';",
        "test('inactive reservation denied', () => {", "  assert.equal(reserve({ active: false, balance: 2 }), false);", "});",
        "test('empty reservation denied', () => {", "  assert.equal(reserve({ active: true, balance: 0 }), false);", "});"),
    },
    head: {}, failingTests: ["inactive reservation denied", "empty reservation denied"],
    anchors: [anchor("first-boundary", "src/reserve.mjs", "  const activeSeen = state.active;"),
      anchor("second-boundary", "src/reserve.mjs", "  state.balance -= 1;"),
      anchor("inactive", "test/reserve.test.mjs", "  assert.equal(reserve({ active: false, balance: 2 }), false);", "assertion"),
      anchor("empty", "test/reserve.test.mjs", "  assert.equal(reserve({ active: true, balance: 0 }), false);", "assertion")],
  },
  {
    id: "independent-equivalent-control", kind: "negative-control", tier: "confirmation",
    message: "refactor: simplify independent display helpers",
    rationale: "Two changed implementations are not automatically two defects.",
    base: {
      "src/label.mjs": source("export function label(value) {", "  return value.trim();", "}"),
      "src/enabled.mjs": source("export function enabled(value) {", "  return Boolean(value);", "}"),
      "test/control.test.mjs": source(...prelude, "import { label } from '../src/label.mjs';",
        "import { enabled } from '../src/enabled.mjs';",
        "test('label trims whitespace', () => {", "  assert.equal(label(' x '), 'x');", "});",
        "test('empty value remains disabled', () => {", "  assert.equal(enabled(''), false);", "});"),
    },
    head: {
      "src/label.mjs": source("export function label(value) {", "  const result = value.trim();", "  return result;", "}"),
      "src/enabled.mjs": source("export function enabled(value) {", "  return !!value;", "}"),
    },
    failingTests: [],
    anchors: [anchor("label", "src/label.mjs", "  const result = value.trim();"),
      anchor("returned-label", "src/label.mjs", "  return result;"),
      anchor("enabled", "src/enabled.mjs", "  return !!value;"),
      anchor("label-expectation", "test/control.test.mjs", "  assert.equal(label(' x '), 'x');", "assertion"),
      anchor("enabled-expectation", "test/control.test.mjs", "  assert.equal(enabled(''), false);", "assertion")],
  },
];
const deletion = cases.find(entry => entry.id === "two-removed-guards");
deletion.head["src/reserve.mjs"] = deletion.base["src/reserve.mjs"]
  .replace("  if (!state.active) return false;\n", "").replace("  if (state.balance < 1) return false;\n", "");
for (const entry of cases) {
  entry.base["package.json.fixture"] = JSON.stringify({ name: "confirmation-fixture", private: true, type: "module",
    scripts: { test: "node --test test/*.test.mjs" } }) + "\n";
  const files = { ...entry.base, ...entry.head };
  entry.anchors = entry.anchors.map(item => {
    const matches = files[item.file].split("\n").flatMap((text, index) => text === item.text ? [index + 1] : []);
    if (matches.length !== 1) throw new Error(`Ambiguous oracle: ${entry.id}/${item.id}`);
    return { ...item, line: matches[0] };
  });
}
