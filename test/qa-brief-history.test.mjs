import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots = [];
after(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
const original = "export function amount(value) {\n  return value;\n}\n";

async function fixture({ intermediate, copies = 1, head = original.replace("return value;", "return Math.max(0, value);") } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-brief-history-"));
  roots.push(directory);
  const root = path.join(directory, "repo");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", NO_COLOR: "1" };
  const git = (...args) => exec("git", args, { cwd: root, env });
  const writeSource = text => Promise.all(Array.from({ length: copies }, (_, index) =>
    fs.writeFile(path.join(root, index ? "src/copy-" + index + ".mjs" : "src/amount.mjs"), text)));
  await git("init", "-qb", "main");
  await writeSource(original);
  await git("add", ".");
  await git("commit", "-qm", "fixture baseline");
  if (intermediate) {
    await writeSource(intermediate);
    await git("commit", "-qam", "fixture intermediate");
  }
  await git("switch", "-qc", "fixture/change");
  await writeSource(head);
  await git("commit", "-qam", "fix: bound the returned value");
  const run = async (hook = {}) => {
    const { stdout, stderr } = await exec(process.execPath, [cli, "qa", "brief", root, "--base", "main",
      "--output", path.join(directory, "reports")], { cwd: root, env: { ...env, ...hook }, timeout: 15000 });
    assert.equal(stderr, "");
    assert.ok(Buffer.byteLength(stdout) <= 24000);
    assert.match(stdout, /Static analysis only: no tests were run, no LLM was called\./);
    return stdout;
  };
  return { directory, root, git, run };
}

// Intercept only the child's history blame. All other Git and analysis calls
// remain real; the delayed child exercises Node's actual process timeout.
async function faultHook(directory, mode) {
  const log = path.join(directory, "history-calls.jsonl");
  const hook = path.join(directory, "history-hook.mjs");
  await fs.writeFile(hook, [
    "import cp from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { promisify } from 'node:util';",
    "import { appendFileSync } from 'node:fs';",
    "const original = cp.execFile;",
    "const log = " + JSON.stringify(log) + ";",
    "const action = " + JSON.stringify(mode === "delay" ? "setTimeout(() => {}, 2500)" : "process.exit(42)") + ";",
    "function wrapped(command, args, options, callback) {",
    "  if (command === 'git' && args.includes('blame')) {",
    "    appendFileSync(log, JSON.stringify({ args, timeout: options.timeout, killSignal: options.killSignal, noLazyFetch: options.env?.GIT_NO_LAZY_FETCH }) + '\\n');",
    "    return original(process.execPath, ['-e', action], options, callback);",
    "  }",
    "  return original(command, args, options, callback);",
    "}",
    "wrapped[promisify.custom] = (command, args, options) => new Promise((resolve, reject) => {",
    "  wrapped(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));",
    "});",
    "cp.execFile = wrapped;",
    "syncBuiltinESMExports();",
  ].join("\n"));
  return { env: { NODE_OPTIONS: (process.env.NODE_OPTIONS ?? "") + " --import=" + pathToFileURL(hook).href },
    calls: async () => (await fs.readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
}

test("a slow history lookup is killed while the brief retains the changed code and explicit uncertainty", async () => {
  const { directory, run } = await fixture();
  const hook = await faultHook(directory, "delay");
  const output = await run(hook.env);
  assert.match(output, /-2\|  return value;\n\+2\|  return Math.max\(0, value\);/);
  assert.match(output, /History evidence is incomplete: time limit reached/);
  assert.doesNotMatch(output, /history: \d+ removed/);
  const calls = await hook.calls();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].timeout > 0 && calls[0].timeout <= 1000);
  assert.equal(calls[0].killSignal, "SIGKILL");
  assert.ok(calls[0].args.includes("--no-lazy-fetch"));
  assert.equal(calls[0].noLazyFetch, "1");
});

test("a failed history command is reported as incomplete evidence rather than an absent history", async () => {
  const { directory, run } = await fixture();
  const hook = await faultHook(directory, "failure");
  const output = await run(hook.env);
  assert.match(output, /History evidence is incomplete: local Git data unavailable or command failed/);
  assert.match(output, /\+2\|  return Math.max\(0, value\);/);
});

test("multiple slow files share one history time budget instead of each starting another budget", async () => {
  const { directory, run } = await fixture({ copies: 4 });
  const hook = await faultHook(directory, "delay");
  const output = await run(hook.env);
  const calls = await hook.calls();
  assert.ok(calls.length > 0 && calls.length < 4, "the shared deadline must stop later optional history commands");
  assert.ok(calls.reduce((sum, call) => sum + call.timeout, 0) <= 3000);
  assert.match(output, /History evidence is incomplete: time limit reached/);
  assert.match(output, /\+2\|  return Math.max\(0, value\);/);
});

test("an addition-only change does not request optional blame or report missing history", async () => {
  const { directory, run } = await fixture({ head: original + "export const capacity = 8;\n" });
  const hook = await faultHook(directory, "failure");
  const output = await run(hook.env);
  await assert.rejects(hook.calls(), { code: "ENOENT" });
  assert.doesNotMatch(output, /History evidence is incomplete/);
});

test("missing parent blobs in a partial clone do not trigger a remote history fetch", async () => {
  const intermediate = original + "// A local annotation.\n";
  const { root, git, run } = await fixture({ intermediate,
    head: intermediate.replace("return value;", "return Math.max(0, value);") });
  let requests = 0;
  const server = http.createServer((_request, response) => { requests++; response.writeHead(404); response.end(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await git("config", "remote.origin.url", "http://127.0.0.1:" + server.address().port + "/fixture.git");
    await git("config", "remote.origin.promisor", "true");
    await git("config", "remote.origin.partialclonefilter", "blob:none");
    const blob = (await git("rev-parse", "main^:src/amount.mjs")).stdout.trim();
    await fs.rm(path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const output = await run();
    assert.equal(requests, 0, "optional history must not request missing objects from the remote");
    assert.match(output, /History evidence is incomplete: local Git data unavailable or command failed/);
    assert.match(output, /\+2\|  return Math.max\(0, value\);/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
