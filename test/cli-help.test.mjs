import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repositoryRoot, "dist/cli.js");

function runCli(...args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

test("default help teaches the small QA workflow before advanced commands", () => {
  const output = runCli("--help");

  for (const command of [
    "qamap qa [path]",
    "qamap qa run [path]",
    "qamap e2e draft [path] --dry-run",
    "qamap manifest init [path]",
    "qamap init --agent [path]",
    "qamap help --all",
  ]) {
    assert.match(output, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(output, /qamap scan \[path\]/);
  assert.doesNotMatch(output, /qamap flows suggest/);
});

test("full help preserves advanced and compatibility commands", () => {
  const output = runCli("help", "--all");

  assert.match(output, /qamap scan \[path\]/);
  assert.match(output, /qamap verify \[path\]/);
  assert.match(output, /qamap e2e run <scenario-id> \[path\]/);
  assert.match(output, /qamap flows suggest \[path\]/);
  assert.match(output, /qamap domains suggest \[path\]/);
});

test("QA help explains the analysis and execution boundary", () => {
  const output = runCli("qa", "--help");

  assert.match(output, /maps diff -> affected behavior -> risk -> scenario -> evidence/);
  assert.match(output, /Product QA and generated drafts remain marked not run/);
  assert.match(output, /executes only the selected existing\s+repository command/);
});

test("e2e help states the run execution boundary", () => {
  const output = runCli("e2e", "--help");

  assert.match(output, /qamap e2e run <scenario-id> \[path\]/);
  assert.match(output, /Without a configured\s+executor or declared fixtures the receipt is blocked and nothing runs/);
});
