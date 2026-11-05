import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { stateCacheSignals } from "../dist/qa-brief-state.js";

const directory = mkdtempSync(path.join(os.tmpdir(), "qamap-state-relevance-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const source = (...rows) => `${rows.join("\n")}\n`;

// These fixtures exercise static evidence with real git hunks. Their state
// functions, loaders and cache operations are never executed.
function signals(before, head) {
  writeFileSync(path.join(directory, "before.ts"), before);
  writeFileSync(path.join(directory, "head.ts"), head);
  let diff;
  try {
    diff = execFileSync("git", ["--no-pager", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv",
      "--unified=3", "--", "before.ts", "head.ts"], { cwd: directory, encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1) throw error;
    diff = error.stdout;
  }
  const hunks = [];
  for (const row of diff.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (match) hunks.push({ oldStart: Number(match[1]), oldCount: Number(match[2] ?? 1),
      newStart: Number(match[3]), newCount: Number(match[4] ?? 1), lines: [] });
    else if (hunks.length && /^[ +\-]/.test(row)) hunks.at(-1).lines.push(row);
  }
  assert.ok(hunks.length, "the fixture must produce a nonempty git diff");
  for (const hunk of hunks) {
    assert.equal(hunk.lines.filter(row => !row.startsWith("-")).length, hunk.newCount);
    assert.equal(hunk.lines.filter(row => !row.startsWith("+")).length, hunk.oldCount);
  }
  return stateCacheSignals("fixture.ts", hunks, head.replace(/\n$/, "").split("\n")).join("\n");
}

const switched = source("function advance(job, other) {", "  switch (job.phase) {", "    case 'idle':",
  "      job.phase = 'running';", "      break;", "  }", "}");
const unrelatedSelector = switched.replace("switch (job.phase)", "switch (other.phase)");

test("switch selector replacement retains the removed same-binding relation with base coordinates", () => {
  const output = signals(switched, unrelatedSelector);
  assert.match(output, /state draft removed: `job.phase` "idle" -> "running"/);
  assert.match(output, /base guard 3, base write 4, base selector 2/);
  assert.match(output, /review replacement/);
  assert.doesNotMatch(output, /write was deleted|state draft:|proves|invalid transition/);
});

test("changing only the switch selector can establish a positioned same-binding draft", () => {
  const output = signals(unrelatedSelector, switched);
  assert.match(output, /state draft: `job.phase` "idle" -> "running" \(guard 3, write 4, selector 2\)/);
  assert.doesNotMatch(output, /state draft removed:/);
});

test("a multiline switch selector suffix is part of the removed relation evidence", () => {
  const before = switched.replace("switch (job.phase)", "switch (job\n    .phase)");
  const output = signals(before, before.replace("    .phase)", "    .other)"));
  assert.match(output, /state draft removed: `job.phase`/);
  assert.match(output, /base guard 4, base write 5, base selector 2/);
});

test("equivalent parenthesized switch selectors do not manufacture a removed relation", () => {
  const output = signals(switched, switched.replace("switch (job.phase)", "switch ((job.phase))"));
  assert.match(output, /state draft: `job.phase`/);
  assert.doesNotMatch(output, /state draft removed:/);
});

test("switch selectors unrelated to the written binding establish no relation on either side", () => {
  assert.doesNotMatch(signals(unrelatedSelector, unrelatedSelector.replace("other.phase", "other.mode")), /state draft/);
});

test("a selector change in another function does not make an existing relation relevant", () => {
  const before = switched + source("function inspect(other) {", "  switch (other.mode) {", "    case 'open': show();", "  }", "}");
  assert.doesNotMatch(signals(before, before.replace("switch (other.mode)", "switch (other.phase)")), /state draft/);
});

const guarded = source("async function advance(phase) {", "  if (phase === 'idle') {", "    phase = 'running';", "  }", "}");

test("replacing a guard literal retains both the current and removed base relation", () => {
  const output = signals(guarded, guarded.replace("=== 'idle'", "=== 'paused'"));
  assert.match(output, /state draft: `phase` "paused" -> "running" \(guard 2, write 3\)/);
  assert.match(output, /state draft removed: `phase` "idle" -> "running" \(base guard 2, base write 3\)/);
  assert.equal((output.match(/state draft(?: removed)?:/g) ?? []).length, 2);
  assert.doesNotMatch(output, /write was deleted|always reaches|invalid transition/);
});

test("a boolean guard replacement retains its old literal relation", () => {
  const before = source("function enable(ready) {", "  if (ready === false) {", "    ready = true;", "  }", "}");
  const output = signals(before, before.replace("=== false", "=== true"));
  assert.match(output, /state draft: `ready` true -> true/);
  assert.match(output, /state draft removed: `ready` false -> true/);
});

for (const [description, condition] of [
  ["quote spelling", 'phase === "idle"'],
  ["comparison direction", "'idle' === phase"],
  ["whitespace", "phase  ===  'idle'"],
]) {
  test(`equivalent guard ${description} does not duplicate a removed relation`, () => {
    const output = signals(guarded, guarded.replace("phase === 'idle'", condition));
    assert.match(output, /state draft: `phase` "idle" -> "running"/);
    assert.doesNotMatch(output, /state draft removed:/);
  });
}

test("uncertainty changes do not present a surviving literal relation as removed", () => {
  const output = signals(guarded, guarded.replace("    phase = 'running';", "    await pause();\n    phase = 'running';"));
  assert.match(output, /state draft unresolved:.*await at 3/);
  assert.doesNotMatch(output, /state draft removed:/);
});

test("guard replacement does not confuse same-named bindings in different functions", () => {
  const before = guarded + guarded.replace("advance(phase)", "resume(phase)");
  const output = signals(before, before.replace("=== 'idle'", "=== 'paused'"));
  assert.match(output, /state draft:.*paused.*guard 2, write 3/);
  assert.match(output, /state draft removed:.*idle.*base guard 2, base write 3/);
  assert.doesNotMatch(output, /guard 7|write 8/);
});

test("replaced relations stay within the existing two-state-hint budget", () => {
  const before = guarded + guarded.replace("advance(phase)", "resume(phase)") + guarded.replace("advance(phase)", "restart(phase)");
  const output = signals(before, before.replaceAll("=== 'idle'", "=== 'paused'"));
  assert.equal((output.match(/state draft(?: removed)?:/g) ?? []).length, 2);
});

const cleared = source("const memo = new Map();", "async function read(owner, id) {", "  memo.clear();",
  "  const hit = memo.get(id);", "  const value = fetchRecord(owner, id);", "  memo.set(id, value);", "}");
const beforeRead = statement => cleared.replace("  const hit", `  ${statement}\n  const hit`);

test("await inserted between unchanged direct clear and read retains a positioned scope question", () => {
  const output = signals(cleared, beforeRead("await pause();"));
  assert.match(output, /shared Map scope: `memo`.*key read 5, write 7.*omits value inputs `owner`/);
  assert.match(output, /clear 3, await 4/);
  assert.match(output, /review key scope/);
  assert.doesNotMatch(output, /data leak|unsafe cache|proved safe/);
});

test("a same-function conditional await still prevents trusting the direct reset gap", () => {
  const output = signals(cleared, beforeRead("if (pending) await pause();"));
  assert.match(output, /shared Map scope:.*omits value inputs `owner`/);
  assert.match(output, /clear 3, await 4/);
});

test("reset-gap relevance also retains omitted image rendering inputs", () => {
  const before = source("const previews = new Map();", "async function render(theme, size) {", "  previews.clear();",
    "  const hit = previews.get(size);", "  const image = buildPreview(theme, size);", "  previews.set(size, image);", "}");
  const head = before.replace("  const hit", "  await frame();\n  const hit");
  const output = signals(before, head);
  assert.match(output, /shared Map scope: `previews`.*omits value inputs `theme`/);
  assert.match(output, /clear 3, await 4/);
});

for (const [description, head] of [
  ["before the clear", cleared.replace("  memo.clear();", "  await pause();\n  memo.clear();")],
  ["after the read", cleared.replace("  const value", "  await pause();\n  const value")],
  ["inside another function", beforeRead("later(async () => { await pause(); });")],
  ["followed by another effective clear", beforeRead("await pause();\n  memo.clear();")],
]) {
  test(`an await ${description} does not invalidate an effective direct reset`, () => {
    assert.doesNotMatch(signals(cleared, head), /shared Map scope:/);
  });
}

test("an arbitrary await is not scope relevance without a direct clear for that Map", () => {
  const before = cleared.replace("  memo.clear();\n", "");
  const head = before.replace("  const hit", "  await pause();\n  const hit");
  assert.doesNotMatch(signals(before, head), /shared Map scope:/);
});

test("a clear of another Map does not connect an otherwise unrelated await", () => {
  const before = cleared.replace("const memo = new Map();", "const memo = new Map();\nconst other = new Map();").replace("  memo.clear();", "  other.clear();");
  assert.doesNotMatch(signals(before, before.replace("  const hit", "  await pause();\n  const hit")), /shared Map scope:/);
});

test("a direct clear in another function does not connect an unrelated await", () => {
  const before = cleared.replace("  memo.clear();\n", "") + source("async function reset() {", "  memo.clear();", "}");
  const head = before.replace("  memo.clear();", "  memo.clear();\n  await pause();");
  assert.doesNotMatch(signals(before, head), /shared Map scope:/);
});

test("only the latest direct clear contributes await gap relevance", () => {
  const before = beforeRead("await first();\n  memo.clear();\n  await last();");
  const head = before.replace("  await first();", "  await extra();\n  await first();");
  assert.doesNotMatch(signals(before, head), /shared Map scope:/);
});

test("removing the last reset gap restores suppression without asserting cache safety", () => {
  assert.doesNotMatch(signals(beforeRead("await pause();"), cleared), /shared Map scope:/);
});
