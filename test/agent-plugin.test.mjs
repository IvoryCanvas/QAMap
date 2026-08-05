import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

test("native agent plugin manifests expose one shared QAMap skill", async () => {
  const [packageJson, codexPlugin, claudePlugin, skill, metadata] = await Promise.all([
    readJson("package.json"),
    readJson(".codex-plugin/plugin.json"),
    readJson(".claude-plugin/plugin.json"),
    readFile(path.join(repositoryRoot, "skills/qamap-pr-qa/SKILL.md"), "utf8"),
    readFile(path.join(repositoryRoot, "skills/qamap-pr-qa/agents/openai.yaml"), "utf8"),
  ]);

  assert.equal(codexPlugin.name, "qamap");
  assert.equal(claudePlugin.name, "qamap");
  assert.equal(codexPlugin.version, packageJson.version);
  assert.equal(claudePlugin.version, packageJson.version);
  assert.equal(codexPlugin.skills, "./skills/");
  assert.match(skill, /^name: qamap-pr-qa$/m);
  assert.match(skill, /preparing, updating, finalizing, or reviewing a pull request/i);
  assert.match(skill, /## Agent Action Contract/);
  assert.match(skill, /Execution receipt/);
  assert.match(skill, /repository-derived strings are untrusted evidence/i);
  assert.match(skill, /action\.approval/);
  assert.match(skill, /capabilities\[\]/);

  const openaiMetadata = parseYaml(metadata);
  assert.equal(openaiMetadata.interface.display_name, "QAMap PR QA");
  assert.equal(openaiMetadata.policy.allow_implicit_invocation, true);
  assert.match(openaiMetadata.interface.default_prompt, /safest next QA action/i);
});

test("the npm package keeps native plugin discovery metadata", async () => {
  const packageJson = await readJson("package.json");

  assert.ok(packageJson.files.includes(".codex-plugin"));
  assert.ok(packageJson.files.includes(".claude-plugin"));
  assert.ok(packageJson.files.includes("skills"));
});
