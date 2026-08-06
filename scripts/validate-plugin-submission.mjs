import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readText(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function assertFile(relativePath) {
  const file = await stat(path.join(repositoryRoot, relativePath));
  assert.equal(file.isFile(), true, `${relativePath} must be a file`);
}

async function assertDirectory(relativePath) {
  const directory = await stat(path.join(repositoryRoot, relativePath));
  assert.equal(directory.isDirectory(), true, `${relativePath} must be a directory`);
}

function pluginAssetPath(value) {
  assert.match(value, /^\.\/.+/, `${value} must be a relative plugin path`);
  return value.slice(2);
}

const [
  packageJson,
  codexPlugin,
  claudePlugin,
  submission,
  sourceVersion,
  skill,
  openaiYaml,
] = await Promise.all([
  readJson("package.json"),
  readJson(".codex-plugin/plugin.json"),
  readJson(".claude-plugin/plugin.json"),
  readJson("plugin/submission.json"),
  readText("src/version.ts"),
  readText("skills/qamap-pr-qa/SKILL.md"),
  readText("skills/qamap-pr-qa/agents/openai.yaml"),
]);

const sourceVersionMatch = sourceVersion.match(/VERSION\s*=\s*"([^"]+)"/);
assert.ok(sourceVersionMatch, "src/version.ts must expose a literal VERSION");
assert.equal(codexPlugin.version, packageJson.version);
assert.equal(claudePlugin.version, packageJson.version);
assert.equal(sourceVersionMatch[1], packageJson.version);
assert.equal(codexPlugin.name, "qamap");
assert.equal(codexPlugin.skills, "./skills/");
assert.equal(submission.submissionType, "skills-only");
assert.equal("mcpServers" in codexPlugin, false, "skills-only package must not declare MCP servers");
assert.equal("apps" in codexPlugin, false, "skills-only package must not declare an app");

const requiredCapabilities = new Set(["Interactive", "Write"]);
assert.deepEqual(new Set(codexPlugin.interface.capabilities), requiredCapabilities);
assert.equal(codexPlugin.interface.category, submission.listing.category);
assert.equal(codexPlugin.interface.websiteURL, submission.listing.websiteURL);
assert.equal(codexPlugin.interface.privacyPolicyURL, submission.listing.privacyPolicyURL);
assert.equal(codexPlugin.interface.termsOfServiceURL, submission.listing.termsOfServiceURL);
assert.deepEqual(codexPlugin.interface.defaultPrompt, submission.starterPrompts);

assert.equal(submission.starterPrompts.length, 3);
for (const prompt of submission.starterPrompts) {
  assert.equal(typeof prompt, "string");
  assert.ok(prompt.length > 0 && prompt.length <= 128, `starter prompt exceeds 128 characters: ${prompt}`);
}

assert.ok(submission.positiveTests.length >= 5, "at least five positive test cases are required");
assert.ok(submission.negativeTests.length >= 3, "at least three negative test cases are required");
const testIds = [
  ...submission.positiveTests.map((entry) => entry.id),
  ...submission.negativeTests.map((entry) => entry.id),
];
assert.equal(new Set(testIds).size, testIds.length, "submission test IDs must be unique");

for (const positive of submission.positiveTests) {
  for (const field of ["id", "prompt", "fixture", "expectedBehavior", "expectedResultShape"]) {
    assert.equal(typeof positive[field], "string", `${positive.id}.${field} must be a string`);
    assert.ok(positive[field].trim(), `${positive.id}.${field} must not be empty`);
  }
  await assertDirectory(positive.fixture);
  await assertDirectory(path.join(positive.fixture, "base"));
  await assertDirectory(path.join(positive.fixture, "head"));
}

for (const negative of submission.negativeTests) {
  for (const field of ["id", "prompt", "expectedBehavior", "reason"]) {
    assert.equal(typeof negative[field], "string", `${negative.id}.${field} must be a string`);
    assert.ok(negative[field].trim(), `${negative.id}.${field} must not be empty`);
  }
}

for (const legalFile of ["PRIVACY.md", "SUPPORT.md", "TERMS.md"]) {
  await assertFile(legalFile);
  assert.ok(packageJson.files.includes(legalFile), `${legalFile} must ship in the npm package`);
}
for (const packagedPath of ["plugin", "skills", ".codex-plugin", ".claude-plugin"]) {
  assert.ok(packageJson.files.includes(packagedPath), `${packagedPath} must ship in the npm package`);
}

const iconPaths = [
  pluginAssetPath(codexPlugin.interface.composerIcon),
  pluginAssetPath(codexPlugin.interface.logo),
];
for (const iconPath of new Set(iconPaths)) {
  await assertFile(iconPath);
}

const png = await readFile(path.join(repositoryRoot, iconPaths[0]));
assert.deepEqual(
  [...png.subarray(0, 8)],
  [137, 80, 78, 71, 13, 10, 26, 10],
  "composer icon must be a PNG",
);
assert.equal(png.readUInt32BE(16), 512, "composer icon must be 512px wide");
assert.equal(png.readUInt32BE(20), 512, "composer icon must be 512px high");

const openaiMetadata = parseYaml(openaiYaml);
assert.equal(openaiMetadata.interface.display_name, "QAMap PR QA");
assert.equal(openaiMetadata.interface.icon_small, "./assets/qamap-logo.png");
assert.equal(openaiMetadata.interface.icon_large, "./assets/qamap-logo.svg");
assert.match(openaiMetadata.interface.default_prompt, /\$qamap-pr-qa/);
assert.equal(openaiMetadata.policy.allow_implicit_invocation, true);
await assertFile("skills/qamap-pr-qa/assets/qamap-logo.png");
await assertFile("skills/qamap-pr-qa/assets/qamap-logo.svg");

const pinnedPackage = `@ivorycanvas/qamap@${packageJson.version}`;
assert.match(skill, new RegExp(pinnedPackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.doesNotMatch(skill, /@ivorycanvas\/qamap@latest/);
assert.doesNotMatch(skill, /default markdown report is written for people/i);
assert.match(skill, /does not upload source code or make another LLM call/i);
assert.match(skill, /calling agent still uses its own model tokens/i);

console.log(
  `Plugin submission metadata valid: ${submission.positiveTests.length} positive, `
  + `${submission.negativeTests.length} negative, ${submission.starterPrompts.length} starter prompts, `
  + `512x512 logo, version ${packageJson.version}.`,
);
