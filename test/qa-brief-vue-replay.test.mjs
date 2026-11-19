import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const base = "9638524427ab50b420e58102ae79ef3bc6c5ab6f";
const head = "908c6ad05e1c76ae690d2e50f3bd28278af07e22";
const file = "packages/runtime-core/src/components/Suspense.ts";

test("temporary verification: replay the landed Vue PR with both complete source trees", { timeout: 120_000 }, async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "qamap-vue-replay-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const run = async (command, args, env = process.env) => (await exec(command, args, { cwd, env, timeout: 45_000 })).stdout;
  const git = (...args) => run("git", args);
  await git("init", "-q");
  await git("fetch", "-q", "--no-tags", "--depth=2", "https://github.com/vuejs/core.git", head);
  assert.equal((await git("rev-parse", "FETCH_HEAD")).trim(), head);
  assert.equal((await git("rev-parse", "FETCH_HEAD^")).trim(), base);
  await git("checkout", "-q", "--detach", head);
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const timings = [];
  const sizes = [];
  const hashes = [];
  let observation;
  for (let sample = 0; sample < 3; sample++) {
    const started = performance.now();
    const brief = await run(process.execPath, [cli, "qa", "brief", ".", "--base", base, "--head", head],
      { ...process.env, QAMAP_REPOSITORY_CACHE: "off" });
    timings.push(Math.round(performance.now() - started));
    sizes.push(Buffer.byteLength(brief));
    hashes.push(createHash("sha256").update(brief).digest("hex"));
    observation = brief.split("\n").find(line => line.includes("Observation: New pending flag isFallbackMountPending"));
    assert.ok(observation, "the standard brief must include the deferred-state question");
    for (const line of [258, 277, 300, 327, 677, 678, 907]) {
      assert.ok(observation.includes(`${file}:${line}`), `missing Vue source evidence at ${file}:${line}`);
    }
    assert.match(brief, /if \(activeBranch && !suspense\.isFallbackMountPending\)/);
    assert.match(brief, /Transition\.spec\.ts/);
    assert.match(brief, /expect\(unmountSpy\)\.toBeCalledTimes\(1\)/);
  }
  assert.equal(new Set(hashes).size, 1);
  t.diagnostic(JSON.stringify({ observation, timings, sizes, sha256: hashes[0],
    baseTree: (await git("rev-parse", base + "^{tree}")).trim(),
    headTree: (await git("rev-parse", head + "^{tree}")).trim() }));
});
