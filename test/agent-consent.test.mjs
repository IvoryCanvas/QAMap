import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { initAgentSetup } from "../dist/agent-init.js";
import { grantConsent, readConsentStatus, revokeConsent } from "../dist/agent-consent.js";

const exec = promisify(execFile);
const cli = new URL("../dist/cli.js", import.meta.url).pathname;

async function workspace() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qamap-consent-"));
  const root = path.join(directory, "repo");
  const claude = path.join(directory, "claude");
  const codex = path.join(directory, "codex");
  await fs.mkdir(root);
  return { directory, root, claude, codex, env: { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex } };
}

test("project consent toggles only the managed AGENTS.md section and an explicit ask overrides user-level consent", async () => {
  const { directory, root, claude, env } = await workspace();
  try {
    const agents = path.join(root, "AGENTS.md");
    const original = "# Team rules\nKeep this line.\n";
    await fs.writeFile(agents, original);
    await fs.mkdir(claude);
    assert.equal((await readConsentStatus(root, env)).project, "not-configured");
    assert.equal((await readConsentStatus(root, env)).effective, "ask");

    await grantConsent(root, { env });
    let content = await fs.readFile(agents, "utf8");
    assert.ok(content.startsWith(original));
    assert.match(content, /qamap:review-mode:report/);
    assert.match(content, /Do not ask again/);
    assert.match(content, /qamap consent revoke/);
    assert.equal((await readConsentStatus(root, env)).effective, "automatic");

    await revokeConsent(root, { env });
    content = await fs.readFile(agents, "utf8");
    assert.ok(content.startsWith(original));
    assert.doesNotMatch(content, /qamap:review-mode:report/);
    assert.match(content, /qamap:review-mode:ask/);
    assert.match(content, /even when a user-level QAMap consent exists/);
    assert.match(content, /Offer three answers/);

    // The project's explicit ask stays in force when user-level consent is granted.
    await grantConsent(root, { global: true, env });
    const status = await readConsentStatus(root, env);
    assert.equal(status.project, "ask");
    assert.ok(status.user.find((target) => target.host === "Claude Code").granted);
    assert.equal(status.effective, "ask");

    // Re-running setup without a mode keeps the recorded choice; --review-mode ask restores the default.
    await initAgentSetup(root);
    assert.match(await fs.readFile(agents, "utf8"), /qamap:review-mode:ask/);
    await initAgentSetup(root, { reviewMode: "ask" });
    assert.doesNotMatch(await fs.readFile(agents, "utf8"), /qamap:review-mode:(ask|report)/);
    assert.equal((await readConsentStatus(root, env)).effective, "automatic");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("default project instructions defer to user-level consent and offer to record a choice", async () => {
  const { directory, root, claude, env } = await workspace();
  try {
    await initAgentSetup(root);
    const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.doesNotMatch(agents, /qamap:review-mode:(ask|report)/);
    assert.match(agents, /including a user-level QAMap consent/);
    assert.match(agents, /consent grant/);
    assert.equal((await readConsentStatus(root, env)).project, "default");
    await fs.mkdir(claude);
    await grantConsent(root, { global: true, env });
    assert.equal((await readConsentStatus(root, env)).effective, "automatic");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("user-level consent is written only for configured hosts, preserves other guidance and is fully revocable", async () => {
  const { directory, root, claude, codex, env } = await workspace();
  try {
    await assert.rejects(grantConsent(root, { global: true, env }), /No supported host configuration directory/);
    await fs.mkdir(claude);
    await fs.mkdir(codex);
    const personal = "Personal rule.\n";
    await fs.writeFile(path.join(claude, "CLAUDE.md"), personal);

    const granted = await grantConsent(root, { global: true, env });
    assert.deepEqual(granted.files.map((file) => file.status), ["updated", "created"]);
    const claudeFile = await fs.readFile(path.join(claude, "CLAUDE.md"), "utf8");
    assert.ok(claudeFile.startsWith(personal));
    assert.match(claudeFile, /qamap:consent:start[\s\S]*do not ask first[\s\S]*qamap qa brief[\s\S]*Tests stay `not-run`[\s\S]*qamap:consent:end/);
    assert.match(await fs.readFile(path.join(codex, "AGENTS.md"), "utf8"), /qamap:consent:start/);
    assert.deepEqual((await grantConsent(root, { global: true, env })).files.map((file) => file.status), ["unchanged", "unchanged"]);

    const revoked = await revokeConsent(root, { global: true, env });
    assert.deepEqual(revoked.files.map((file) => file.status), ["updated", "updated"]);
    assert.equal(await fs.readFile(path.join(claude, "CLAUDE.md"), "utf8"), personal);
    await assert.rejects(fs.access(path.join(codex, "AGENTS.md")), "a file that held only the consent is removed");
    assert.deepEqual(await fs.readdir(root), [], "user-level consent does not touch the repository");
    assert.deepEqual((await revokeConsent(root, { global: true, env })).files.map((file) => file.status), ["unchanged", "unchanged"]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("CLI consent command reports both scopes and rejects unknown actions and options", async () => {
  const { directory, root } = await workspace();
  const home = path.join(directory, "home");
  await fs.mkdir(path.join(home, ".claude"), { recursive: true });
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "" };
  const run = (...args) => exec(process.execPath, [cli, "consent", ...args], { env });
  try {
    for (const args of [["enable", root], ["grant", root, "--yes"], ["status", root, "--global"], ["grant", root, root]]) {
      await assert.rejects(run(...args), (error) => /consent/.test(error.stderr));
    }
    assert.deepEqual(await fs.readdir(root), []);
    assert.match((await run("status", root)).stdout, /Effective in this project: ask before running QAMap/);
    await run("grant", root, "--global");
    const { stdout } = await run("status", root);
    assert.match(stdout, /Claude Code \(.*CLAUDE\.md\): automatic/);
    assert.match(stdout, /Codex \(.*AGENTS\.md\): host not configured/);
    assert.match(stdout, /Effective in this project: run QAMap for PR review without asking/);
    await run("revoke", root, "--global");
    assert.match((await run("status", root)).stdout, /Effective in this project: ask before running QAMap/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
