import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

for (const mixed of [false, true]) test(`omitted untracked evidence has an executable recovery command (${mixed ? "mixed" : "untracked only"})`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-untracked-recovery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }));
  const root = path.join(directory, "repo");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", NO_COLOR: "1" };
  const git = (...args) => exec("git", args, { cwd: root, env });
  await git("init", "-qb", "main");
  await fs.writeFile(path.join(root, "src/tracked.mjs"), "export const tracked = 1;\n");
  await git("add", ".");
  await git("commit", "-qm", "chore: baseline");
  await git("switch", "-qc", "fix/fixture");
  if (mixed) await fs.writeFile(path.join(root, "src/tracked.mjs"), "export const tracked = 2;\n");
  const file = "src/untracked 'quote' $literal.mjs";
  const source = "export function total() {\n  let result = 0;\n" +
    Array.from({ length: 600 }, (_, index) => `  result += ${index};`).join("\n") +
    "\n  return result; // recovery-final-marker\n}\n";
  await fs.writeFile(path.join(root, file), source);
  const before = (await git("status", "--porcelain")).stdout;
  const { stdout: brief } = await exec(process.execPath, [cli, "qa", "brief", root, "--base", "main",
    "--include-working-tree", "--max-bytes", "4000", "--output", path.join(directory, "reports")], { cwd: root, env });
  assert.ok(Buffer.byteLength(brief) <= 4000);
  assert.match(brief, /== Not fully shown/);
  const recovery = /^- Show untracked files with: (.+)$/m.exec(brief)?.[1];
  assert.ok(recovery, "normal git diff cannot recover an untracked file");
  const shown = await exec("sh", ["-c", recovery], { cwd: root, env }).catch(error => error);
  assert.equal(shown.code, 1, "no-index reports differences with exit code 1");
  assert.match(shown.stdout, /recovery-final-marker/);
  const expected = await git("diff", "--no-index", "--", "/dev/null", file).catch(error => error);
  assert.equal(shown.stdout, expected.stdout, "the printed shell quoting must preserve the exact untracked filename");
  assert.match(brief, /exit code 1/);
  const tracked = /^- Show them with: (.+)$/m.exec(brief)?.[1];
  if (!mixed) assert.equal(tracked, undefined, "an untracked-only omission must not suggest an empty tracked diff");
  if (tracked) assert.ok(!tracked.includes("untracked"));
  assert.equal((await git("status", "--porcelain")).stdout, before);
});
