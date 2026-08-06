import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  agentRecoveryReportMaxAgeMs,
  cleanupStaleAgentRecoveryReports,
  writeAgentRecoveryReport,
} from "../dist/agent-report.js";

test("agent recovery reports remove only stale QAMap files", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qamap-agent-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const now = Date.now();
  const stale = path.join(directory, "qamap-qa-agent-full-stale.json");
  const fresh = path.join(directory, "qamap-qa-agent-full-fresh.json");
  const unrelated = path.join(directory, "other-agent-full-stale.json");
  await Promise.all([
    writeFile(stale, "{}"),
    writeFile(fresh, "{}"),
    writeFile(unrelated, "{}"),
  ]);
  const oldTime = new Date(now - agentRecoveryReportMaxAgeMs - 1_000);
  await Promise.all([
    utimes(stale, oldTime, oldTime),
    utimes(unrelated, oldTime, oldTime),
  ]);

  const removed = cleanupStaleAgentRecoveryReports(directory, now);

  assert.deepEqual(removed, [stale]);
  await assert.rejects(stat(stale), { code: "ENOENT" });
  assert.equal((await stat(fresh)).isFile(), true);
  assert.equal((await stat(unrelated)).isFile(), true);
});

test("agent recovery reports are written with owner-only permissions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qamap-agent-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const reportPath = path.join(directory, "qamap-qa-agent-full-current.json");
  writeAgentRecoveryReport(reportPath, "{\"schema\":\"qamap.qa\"}\n");

  assert.equal(await readFile(reportPath, "utf8"), "{\"schema\":\"qamap.qa\"}\n");
  if (process.platform !== "win32") {
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
  }
});

test("agent recovery reports never overwrite an existing path", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qamap-agent-report-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const reportPath = path.join(directory, "qamap-qa-agent-full-existing.json");
  await writeFile(reportPath, "existing");

  assert.throws(
    () => writeAgentRecoveryReport(reportPath, "replacement"),
    { code: "EEXIST" },
  );
  assert.equal(await readFile(reportPath, "utf8"), "existing");
});
