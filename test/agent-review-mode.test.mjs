import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { initAgentSetup } from "../dist/agent-init.js";

const exec = promisify(execFile);
test("report review preference is opt-in, persistent, reversible and confined to its managed section", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-review-preference-"));
  const file = path.join(root, "AGENTS.md");
  const read = () => fs.readFile(file, "utf8");
  try {
    const original = "# Personal instructions\nKeep existing guidance.\n";
    await fs.writeFile(file, original);
    await initAgentSetup(root);
    assert.doesNotMatch(await read(), /qamap:review-mode:report/);
    await initAgentSetup(root, { reviewMode: "report" });
    const approved = await read();
    assert.ok(approved.startsWith(original));
    assert.match(approved, /qamap:review-mode:report/);
    assert.match(approved, /Do not ask again/);
    assert.match(approved, /qamap qa report \. --base origin\/main --head HEAD --handoff/);
    assert.match(approved, /Tests stay `not-run`/);
    assert.match(approved, /yield_time_ms: 30000/);
    assert.match(approved, /Short polling intervals add model turns/);
    await initAgentSetup(root);
    assert.equal(await read(), approved);
    await initAgentSetup(root, { reviewMode: "ask" });
    assert.doesNotMatch(await read(), /qamap:review-mode:report/);
    assert.ok((await read()).startsWith(original));
    await assert.rejects(initAgentSetup(root, { reviewMode: "automatic" }), /Invalid review mode/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("CLI review preference requires explicit init --agent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-review-cli-"));
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  try {
    for (const args of [["qa", root, "--review-mode", "report"], ["init", root, "--review-mode", "report"],
      ["init", root, "--agent", "--review-mode", "invalid"]]) {
      await assert.rejects(exec(process.execPath, [cli, ...args]), error => /review-mode/.test(error.stderr));
      assert.deepEqual(await fs.readdir(root), []);
    }
    await exec(process.execPath, [cli, "init", root, "--agent", "--review-mode", "report"]);
    assert.match(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), /qamap:review-mode:report/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
