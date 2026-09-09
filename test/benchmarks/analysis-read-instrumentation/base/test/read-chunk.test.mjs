import assert from "node:assert/strict";
import test from "node:test";
import { readChunk } from "../src/inspection-tools.mjs";

test("reading preserves the bounded byte prefix", () => {
  const result = readChunk(Buffer.from("sample"), 3, {
    read() {},
    directRead() {},
  });
  assert.equal(result.toString(), "sam");
});
