import assert from "node:assert/strict";
import test from "node:test";
import { changeSignals } from "../dist/qa-brief.js";

function hunk(removed, added, oldStart = 20, newStart = 30) {
  return {
    header: "",
    oldStart,
    newStart,
    newCount: added.length,
    lines: [...removed.map(line => "-" + line), ...added.map(line => "+" + line)],
  };
}

function briefSignals(minimal, path = "src/queue.ts") {
  return changeSignals({ path, hunks: { minimal } }) ?? "";
}

test("a review signal identifies a new in-place array insertion and its previous copy", () => {
  assert.match(briefSignals([hunk(["rows = [...rows, next];"], ["rows.push(next);"])]),
    /replaces a copy of rows at base 20 with push on the existing value at head 30\. Check retained array references and repeat calls/);

  const [before, after] = [
    "entry.tags = entry.tags ? [PLACEHOLDER, ...entry.tags] : [PLACEHOLDER];",
    "if (entry.tags) entry.tags.unshift(PLACEHOLDER);",
  ].map(line => line.replaceAll("PLACEHOLDER", "$" + "{key}"));
  assert.match(briefSignals([hunk([before], [after])]),
    /replaces a copy of entry\.tags at base 20 with unshift on the existing value at head 30/);
});

test("the in-place array signal requires a unique matching replacement in the same hunk", () => {
  const original = ["rows = [...rows, next];"];
  const controls = [
    [hunk(original, ["otherRows.push(next);"])],
    [hunk(original, ["rows.unshift(next);"])],
    [hunk(original, ["rows.push(other);"])],
    [hunk(original, ["if (enabled) rows.push(next);"])],
    [hunk(original, ["// rows.push(next);"])],
    [hunk(original, ["'rows.push(next);'"])],
    [hunk(original, ["rows.push(next);", "rows.push(next);"])],
    [hunk(original, original)],
    [hunk(original, []), hunk([], ["rows.push(next);"], 40, 50)],
  ];
  for (const control of controls) assert.doesNotMatch(briefSignals(control), /replaces a copy/);
  assert.doesNotMatch(briefSignals([hunk(original, ["rows.push(next);"])], "queue.txt"), /replaces a copy/);
});
