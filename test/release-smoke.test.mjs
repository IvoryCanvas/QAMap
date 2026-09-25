import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { publishedSmokeVersion, runReleaseSmoke } from "../scripts/release-smoke.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

test("release smoke supplies a manifest, stays static, and cleans up offline", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-release-smoke-test-"));
  try {
    const { version } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const report = await runReleaseSmoke({ cli: path.join(root, "dist/cli.js"), version, tempDirectory: temporary });
    assert.equal(publishedSmokeVersion, "0.5.0");
    assert.equal(report.source, "local-cli", "offline evidence must not claim a published-package smoke");
    assert.equal(report.status, "passed");
    assert.deepEqual(report.execution, { status: "not-run", performed: false });
    assert.ok(report.checks.includes("manifest-validate"));
    assert.ok(report.checks.includes("draft-dry-run-no-writes"));
    assert.deepEqual(await fs.readdir(temporary), []);
    assert.doesNotMatch(JSON.stringify(report), /\/Users\/|\/tmp\/|\/var\/folders\//);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("release smoke rejects floating versions and cleans fixture on command failure", async () => {
  await assert.rejects(runReleaseSmoke({ version: "latest" }), /exact release version/);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-release-smoke-failure-"));
  try {
    await assert.rejects(runReleaseSmoke({ cli: path.join(temporary, "missing.js"), tempDirectory: temporary }));
    assert.deepEqual(await fs.readdir(temporary), []);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
