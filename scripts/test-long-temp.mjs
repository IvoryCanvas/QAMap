// Exercise the actual bounded-report contracts with a long platform temp path.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), "qamap-long-temp-"));
try {
  const target = path.join(temporary, "bounded-report-path-".repeat(8));
  await mkdir(target);
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "test/qa-handoff.test.mjs"], {
      cwd: root, env: { ...process.env, TMPDIR: target }, stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
