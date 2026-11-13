import assert from "node:assert/strict";
import test from "node:test";
import { controlFlowQuestions } from "../dist/qa-review-questions.js";

function questions(base, head, file = "src/helper.mjs") {
  const before = base.split("\n"), after = head.split("\n");
  return controlFlowQuestions(file, [{ oldStart: 1, newStart: 1, newCount: after.length,
    lines: [...before.map(line => `-${line}`), ...after.map(line => `+${line}`)] }], after);
}

test("a removed return guard asks about the affected input without inventing its expected value", () => {
  const result = questions("export function remaining(value) {\n  if (value < 0) return 0;\n  return value;\n}",
    "export function remaining(value) {\n  return value;\n}");
  assert.equal(result.length, 1);
  assert.match(result[0].observation, /src\/helper.mjs:2 \(base\): if \(value < 0\)/);
  assert.match(result[0].question, /inputs matching this base guard still return/);
  assert.match(result[0].next, /reviewed policy.*source and input -> expected result/);
  assert.doesNotMatch(result[0].question, /must return 0|bug|passed/);
});

test("an unrelated TypeScript method retains a rewritten error guard and its class owner", () => {
  const result = questions("class Gateway { send(allowed: boolean) { if (!allowed) { throw new Error('blocked'); } return 1; } }",
    "class Gateway { send(allowed: boolean) { if (allowed === false) { throw new Error('blocked'); } return 1; } }", "src/gateway.ts");
  assert.equal(result.length, 1);
  assert.match(result[0].question, /still raise an error/);
  assert.match(result[0].observation, /if \(!allowed\)/);
});

test("moving an unchanged guard inside its named owner does not claim its condition changed", () => {
  const base = "function remaining(value) {\n if (value < 0) return 0;\n const note = 1;\n return value;\n}";
  const head = "function remaining(value) {\n const note = 1;\n if (value < 0) return 0;\n return value;\n}";
  assert.deepEqual(questions(base, head), []);
});

test("a same-text guard in a different function cannot cancel a removed guard", () => {
  const base = "function allowance(value) { if (value < 0) return 0; return value; }\nfunction label(value) { return value; }";
  const head = "function allowance(value) { return value; }\nfunction label(value) { if (value < 0) return 0; return value; }";
  const result = questions(base, head);
  assert.equal(result.length, 1);
  assert.match(result[0].key.join(" "), /allowance/);
});

test("new throws cite the head and ask for caller-visible behavior rather than assuming recovery", () => {
  const result = questions("function parseValue(value) { return value; }",
    "function parseValue(value) {\n if (value === null) throw new Error('missing');\n return value;\n}");
  assert.equal(result.length, 1);
  assert.match(result[0].observation, /src\/helper.mjs:2 \(head\): throw new Error/);
  assert.match(result[0].question, /caller-visible outcome/);
  assert.match(result[0].next, /callers and their error handling/);
});

test("strings, comments, nested conditional exits, anonymous callbacks and unsupported languages remain unclaimed", () => {
  for (const [before, after, file] of [
    ["const example = 'if (value) return 0';", "const example = '';", "src/example.mjs"],
    ["// if (value) return 0", "// example", "src/example.ts"],
    ["function nested(value) { if (value) { if (other) return 0; } return 1; }", "function nested(value) { if (other) return 0; return 1; }", "src/example.mjs"],
    ["items.map(value => { if (value < 0) return 0; return value; });", "items.map(value => value);", "src/example.mjs"],
    ["def select(value):\n if value: return 1", "def select(value):\n return 1", "src/example.py"],
  ]) {
    assert.deepEqual(questions(before, after, file), []);
  }
  assert.deepEqual(questions("function nested(value) { if (value) { log(value); } return 1; }",
    "function nested(value) { log(value); return 1; }"), []);
});

test("parse failures and inconsistent hunks do not produce a policy question", () => {
  assert.deepEqual(questions("function bad( { if (value) return 0;", "function bad( { return 1;"), []);
  assert.deepEqual(controlFlowQuestions("src/test.mjs", [{ oldStart: 1, newStart: 1, newCount: 1,
    lines: ["-if (value) return 0;", "+different text"] }], ["actual head"]), []);
});

test("control-flow questions are capped per file", () => {
  const base = Array.from({ length: 5 }, (_, i) => `function guard${i}(value) { if (value < 0) return 0; return value; }`).join("\n");
  const head = Array.from({ length: 5 }, (_, i) => `function guard${i}(value) { return value; }`).join("\n");
  assert.equal(questions(base, head).length, 2);
});
