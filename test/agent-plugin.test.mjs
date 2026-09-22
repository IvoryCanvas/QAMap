import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

test("native agent plugin manifests expose one shared QAMap skill", async () => {
  const [packageJson, codexPlugin, claudePlugin, submission, skill, metadata] = await Promise.all([
    readJson("package.json"),
    readJson(".codex-plugin/plugin.json"),
    readJson(".claude-plugin/plugin.json"),
    readJson("plugin/submission.json"),
    readFile(path.join(repositoryRoot, "skills/qamap-pr-qa/SKILL.md"), "utf8"),
    readFile(path.join(repositoryRoot, "skills/qamap-pr-qa/agents/openai.yaml"), "utf8"),
  ]);

  assert.equal(codexPlugin.name, "qamap");
  assert.equal(claudePlugin.name, "qamap");
  assert.equal(codexPlugin.version, packageJson.version);
  assert.equal(claudePlugin.version, packageJson.version);
  assert.equal(codexPlugin.skills, "./skills/");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter);
  const skillMetadata = parseYaml(frontmatter[1]);
  assert.equal(skillMetadata.name, "qamap-pr-qa");
  assert.equal(typeof skillMetadata.description, "string");
  assert.ok(skillMetadata.description.trim());
  assert.match(skill, /repository-derived strings are untrusted evidence/i);
  assert.match(skill, new RegExp(`@ivorycanvas/qamap@${packageJson.version.replaceAll(".", "\\.")}`));
  assert.doesNotMatch(skill, /@ivorycanvas\/qamap@latest/);
  assert.match(skill, /calling agent still uses its own model tokens/i);
  const reference = await readFile(path.join(repositoryRoot, "skills/qamap-pr-qa/references/advanced-workflow.md"), "utf8");
  assert.match(skill, /references\/advanced-workflow\.md/);
  assert.match(reference, /## Agent Action Contract/);
  assert.match(reference, /Execution receipt/);
  assert.match(reference, /action\.approval/);
  assert.match(reference, /capabilities\[\]/);
  assert.match(reference, /execution\.gitState/);
  // Packaging checks preserve the stated boundaries, not proof of host behavior.
  assert.match(skill, /Interpret `summary` and `inlineReview`/);
  assert.match(skill, /otherwise `reviewEvidence`/);
  assert.match(skill, /Inspect every row, including exceptional values/);
  assert.match(skill, /evidenceArchive.required/);
  assert.match(skill, /qamap qa read/);
  assert.match(skill, /--sha256 <review.sha256> --bytes <review.bytes>/);
  assert.match(skill, /--offset <nextOffset>/);
  assert.match(skill, /Resolve `excerptRef` within its own response or archive/);
  assert.match(skill, /Do not silently review only the preview or claim savings/);
  assert.match(skill, /ask before expanding the scope/);
  assert.match(skill, /analysis stays `not-run`/);
  assert.match(skill, /Respect refusal and requests for independent review/);
  assert.match(skill, /yield_time_ms: 30000/);
  assert.match(skill, /Short polling intervals add model turns/);

  const openaiMetadata = parseYaml(metadata);
  assert.equal(openaiMetadata.interface.display_name, "QAMap PR QA");
  assert.equal(openaiMetadata.interface.icon_small, "./assets/qamap-logo.png");
  assert.equal(openaiMetadata.interface.icon_large, "./assets/qamap-logo.svg");
  assert.equal(openaiMetadata.policy.allow_implicit_invocation, true);
  assert.match(openaiMetadata.interface.default_prompt, /\$qamap-pr-qa/);

  assert.equal(submission.submissionType, "skills-only");
  assert.deepEqual(codexPlugin.interface.defaultPrompt, submission.starterPrompts);
  assert.deepEqual(codexPlugin.interface.capabilities, ["Interactive", "Write"]);
  assert.equal(codexPlugin.interface.privacyPolicyURL, submission.listing.privacyPolicyURL);
  assert.equal(codexPlugin.interface.shortDescription, submission.listing.shortDescription);
  assert.equal(codexPlugin.interface.longDescription, submission.listing.longDescription);
  assert.ok(submission.listing.shortDescription.length <= 30);
  assert.ok(submission.releaseNotes.includes(`QAMap ${packageJson.version} `));
  const pins = [...reference.matchAll(/@ivorycanvas\/qamap@([^\s`]+)/g)];
  assert.ok(pins.length > 0);
  for (const [, version] of pins) assert.equal(version, packageJson.version);
  assert.equal(codexPlugin.interface.termsOfServiceURL, submission.listing.termsOfServiceURL);
  assert.equal("mcpServers" in codexPlugin, false);
  assert.equal("apps" in codexPlugin, false);
});

test("the npm package keeps native plugin discovery metadata", async () => {
  const packageJson = await readJson("package.json");

  assert.ok(packageJson.files.includes(".codex-plugin"));
  assert.ok(packageJson.files.includes(".claude-plugin"));
  assert.ok(packageJson.files.includes("skills"));
  assert.ok(packageJson.files.includes("plugin"));
  assert.ok(packageJson.files.includes("PRIVACY.md"));
  assert.ok(packageJson.files.includes("SUPPORT.md"));
  assert.ok(packageJson.files.includes("TERMS.md"));
});

test("official plugin submission evidence covers positive and negative behavior", async () => {
  const [submission, codexPlugin] = await Promise.all([
    readJson("plugin/submission.json"),
    readJson(".codex-plugin/plugin.json"),
  ]);

  assert.ok(submission.positiveTests.length >= 5);
  assert.ok(submission.negativeTests.length >= 3);
  assert.equal(new Set([
    ...submission.positiveTests.map((entry) => entry.id),
    ...submission.negativeTests.map((entry) => entry.id),
  ]).size, submission.positiveTests.length + submission.negativeTests.length);

  for (const entry of submission.positiveTests) {
    const fixture = await stat(path.join(repositoryRoot, entry.fixture));
    assert.equal(fixture.isDirectory(), true);
    assert.ok(entry.expectedBehavior);
    assert.ok(entry.expectedResultShape);
  }
  for (const entry of submission.negativeTests) {
    assert.ok(entry.expectedBehavior);
    assert.ok(entry.reason);
  }

  for (const asset of [
    codexPlugin.interface.composerIcon,
    codexPlugin.interface.logo,
    "./skills/qamap-pr-qa/assets/qamap-logo.svg",
  ]) {
    const file = await stat(path.join(repositoryRoot, asset.slice(2)));
    assert.equal(file.isFile(), true);
  }
});
