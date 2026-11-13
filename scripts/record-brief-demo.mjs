// Reproduce the README's real brief output; rendering needs Python + Pillow.
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { materializeFixtureRepo } from "./lib/fixture-repo.mjs";
import { cases } from "../test/benchmarks/report-only-evidence/cases.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const staging = await mkdtemp(path.join(os.tmpdir(), "qamap-brief-demo-"));
let fixture;
try {
  const entry = cases.find(item => item.id === "shared-capacity");
  for (const [phase, files] of [["base", entry.base], ["head", entry.head]]) {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(staging, phase, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
  fixture = await materializeFixtureRepo({ fixtureRoot: staging,
    commits: [{ dir: "head", message: entry.message }],
    git: (cwd, args) => exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_DATE: "2026-11-13T00:00:00Z", GIT_COMMITTER_DATE: "2026-11-13T00:00:00Z" } }),
  });
  const { stdout } = await exec(process.execPath, [path.join(root, "dist/cli.js"), "qa", "brief", "--base", "main",
    "--output", path.join(staging, "reports")], { cwd: fixture.repositoryRoot, env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 128 * 1024 });
  const output = path.join(root, "docs/assets/qamap-brief-demo.txt");
  await writeFile(output, `$ qamap qa brief --base main\n${stdout}`);
  await exec("python3", [path.join(root, "scripts/render-brief-demo.py"), output,
    path.join(root, "docs/assets/qamap-brief-demo.gif")]);
  process.stdout.write("Recorded the public shared-capacity fixture; playback timing is illustrative.\n");
} finally {
  await fixture?.cleanup();
  await rm(staging, { recursive: true, force: true });
}
