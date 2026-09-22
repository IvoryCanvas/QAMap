import assert from "node:assert/strict";
import test from "node:test";
import { packReviewText, unpackReviewText } from "../dist/qa-evidence-pack.js";

function textRecords(count = 80) {
  return "Evidence only. Tests not-run.\n" + Array.from({ length: count }, (_, i) =>
    `FILE "src/entry-${i}.ts"\n1|export const entry${i} = value => value + ${i % 7};\n2|// context\n`).join("\n");
}

test("lossless tables preserve every independent file, value, and source line", () => {
  const text = textRecords();
  const packed = packReviewText(text);
  assert.ok(packed);
  assert.equal(unpackReviewText(packed), text);
  assert.ok(Buffer.byteLength(JSON.stringify(packed)) < Buffer.byteLength(text) / 2);
  assert.ok(packed.tables.some(table => table.rows.length > 1));
});

test("similar code never loses exceptional operators, identifiers or expectations", () => {
  const text = textRecords().replace("value + 2;", "value - 29;")
    .replace("entry39 = value => value + 4", "entry39 = value => other + 999")
    .replace("entry57 =", "checkOther =");
  assert.equal(unpackReviewText(packReviewText(text)), text);
});

test("tables keep Unicode, escapes, control text, empty lines and literal slot-like text", () => {
  const text = textRecords().replace("// context", "// 한글 \\\" {0} $1 \t") + "\n\nno final newline";
  assert.equal(unpackReviewText(packReviewText(text)), text);
  assert.equal(packReviewText(""), undefined);
  assert.equal(packReviewText("small\n"), undefined);
  assert.equal(packReviewText("x".repeat(1024 * 1024 + 1)), undefined);
});

test("irregular groups fall back to literal records without losing differences", () => {
  const text = Array.from({ length: 20 }, (_, i) =>
    Array.from({ length: 20 }, (_, j) => `${i * (j + 1)}`).join("-") + "\n").join("") + textRecords();
  const packed = packReviewText(text);
  assert.ok(packed.tables.some(table => Array.isArray(table.at) && table.at.length === 1 && table.rows[0].length === 0));
  assert.equal(unpackReviewText(packed), text);
});

test("corrupt, missing and repeated table records fail closed", () => {
  const packed = packReviewText(textRecords());
  const mutate = action => { const value = structuredClone(packed); action(value); return value; };
  assert.throws(() => unpackReviewText(mutate(p => p.tables.pop())), /Missing/);
  assert.throws(() => unpackReviewText(mutate(p => p.tables.push(p.tables[0]))), /Invalid review text record/);
  assert.throws(() => unpackReviewText(mutate(p => p.tables[0].rows.push([]))), /Invalid review text table/);
  assert.throws(() => unpackReviewText(mutate(p => p.tables[0].parts.push(99))), /Invalid review text column/);
  assert.throws(() => unpackReviewText(mutate(p => p.tables[0].parts.push("changed"))), /integrity/);
  assert.throws(() => unpackReviewText(mutate(p => p.bytes++)), /integrity/);
  assert.throws(() => unpackReviewText(mutate(p => p.tables[0].at = [-1])), /Invalid review text record/);
});
