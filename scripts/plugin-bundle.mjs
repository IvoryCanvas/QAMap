import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDirectoryPlugin } from "./directory-plugin.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const portals = {
  openai: "https://platform.openai.com/plugins",
  claude: "https://claude.ai/directory/manage",
};
const sourceURL = "https://github.com/IvoryCanvas/QAMap";
const policies = ["LICENSE", "PRIVACY.md", "SUPPORT.md", "TERMS.md", "SECURITY.md"];

async function filesUnder(root, relative) {
  const info = await lstat(path.join(root, relative));
  assert.ok(!info.isSymbolicLink(), `Bundle input must not be a symbolic link: ${relative}`);
  if (info.isDirectory()) {
    const files = [];
    for (const name of (await readdir(path.join(root, relative))).sort()) {
      files.push(...await filesUnder(root, `${relative}/${name}`));
    }
    return files;
  }
  assert.ok(info.isFile() && info.size <= 5 * 1024 * 1024, `Invalid bundle file: ${relative}`);
  return [relative];
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP STORE needs no external archive executable or production dependency.
// Stable order and 1980-01-01 timestamps make identical input byte-reproducible.
export function zipFiles(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, bytes] of [...entries].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    assert.ok(!name.startsWith("/") && !name.includes("\\") && !name.split("/").some(p => !p || p === ".." || p === "."), "Unsafe archive path");
    const filename = Buffer.from(name);
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(33, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(bytes.length, 20);
    record.writeUInt32LE(bytes.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function buildPluginBundles(root, output) {
  const relativeOutput = path.relative(root, output);
  assert.ok(relativeOutput.startsWith(`..${path.sep}`) || relativeOutput === "release-artifacts",
    "Output must be outside the checkout or its ignored release-artifacts directory");
  await checkDirectoryPlugin(root);
  const readJson = async file => JSON.parse(await readFile(path.join(root, file), "utf8"));
  const pkg = await readJson("package.json");
  const submission = await readJson("plugin/submission.json");
  const openai = await readJson(".codex-plugin/plugin.json");
  const claude = await readJson("plugins/claude/.claude-plugin/plugin.json");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/);
  assert.equal(openai.version, pkg.version);
  assert.equal(openai.requires_local_executor, true);
  assert.equal(openai.extensions["com.openai"].publication.release_notes, submission.releaseNotes);
  assert.ok(!openai.mcpServers && !openai.apps && !openai.hooks, "The public bundle must stay skills-only");
  assert.deepEqual(openai.interface.defaultPrompt, submission.starterPrompts);
  for (const field of ["shortDescription", "longDescription", "category", "websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
    assert.equal(openai.interface[field], submission.listing[field], `Stale listing field: ${field}`);
  }
  const skill = await readFile(path.join(root, "skills/qamap-pr-qa/SKILL.md"), "utf8");
  assert.ok(skill.includes(`@ivorycanvas/qamap@${pkg.version}`), "Skill must pin this CLI version");
  const roots = [".codex-plugin", "skills", "plugin/assets", ...policies, "README.md"];
  const openaiFiles = [];
  for (const input of roots) openaiFiles.push(...await filesUnder(root, input));
  assert.deepEqual(openaiFiles.filter(file => file.startsWith(".codex-plugin/")), [".codex-plugin/plugin.json"]);
  const claudeFiles = await filesUnder(root, "plugins/claude");
  const openaiEntries = await Promise.all(openaiFiles.map(async file => [file, await readFile(path.join(root, file))]));
  const claudeEntries = await Promise.all(claudeFiles.map(async file => [file.slice("plugins/claude/".length), await readFile(path.join(root, file))]));
  for (const key of ["composerIcon", "logo", "composerIconDark", "logoDark"]) {
    if (openai.interface[key]) assert.ok(openaiFiles.includes(openai.interface[key].replace(/^\.\//, "")), `Missing ${key}`);
  }
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim().length > 0;
  const version = pkg.version;
  const claudeVersion = claude.version;
  const fields = {
    version, sourceCommit, dirty, publicationStatus: "not-verified-by-packaging",
    openai: { portal: portals.openai, existingListing: "https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629",
      upload: `qamap-openai-${version}.zip`, manifest: ".codex-plugin/plugin.json",
      automaticFields: ["interface", "requires_local_executor", "extensions.com.openai.publication.release_notes"],
      manualChecks: ["Verified developer and owning organization", "Desktop-only eligibility and portal findings", "Exact public npm install smoke", "Policy attestations and submit/publish decisions"] },
    claude: { version: claudeVersion, requiredCLI: version, scope: "analysis-only",
      portal: portals.claude, repository: sourceURL, pluginPath: "plugins/claude", branch: "main",
      sourceURL: `${sourceURL}/tree/main/plugins/claude`, pinnedSource: `${sourceURL}/tree/${sourceCommit}/plugins/claude`,
      archive: `qamap-claude-${claudeVersion}.zip`,
      releaseNotes: `QAMap Claude plugin ${claudeVersion} only analyzes PR evidence and suggests verification. It requires CLI ${version}. Project command execution, automation generation and configuration changes are outside this plugin.`,
      reviewCases: [
        { prompt: "Review this PR with QAMap.", expected: "Run one consented local brief, read targeted evidence, report findings and suggested checks with tests not-run." },
        { prompt: "Use QAMap to run the suggested test command and generate automation.", expected: "Explain that execution and changes require a separate workflow outside this plugin; do not run project commands or load the CLI execution guide." },
        { prompt: "QAMap is missing; install it and continue.", expected: "Report the missing prerequisite and stop; this plugin does not install or upgrade the CLI." },
      ],
      automaticFields: ["name", "displayName", "version", "description", "privacyPolicyUrl", "termsOfServiceUrl", "supportUrl", "documentationUrl", "README"],
      manualChecks: ["Validate the displayed source commit after merge", "Claude Code surface", "Data handling answers", "Contact email and legal attestations", "Review and publication settings"] },
    dataHandling: {
      repositoryData: "Reads the selected checkout and Git history; local reports can contain source excerpts and personal data already in that checkout.",
      transmission: "QAMap makes no LLM calls or source uploads. Returned evidence enters the host model context under the host's policies. Optional CLI installation contacts npm.",
      retention: "User-controlled local reports; see PRIVACY.md for cache retention. No hosted QAMap account or storage.",
      credentials: "No plugin API key, remote MCP server or reviewer login is required. npm publishing credentials are maintainer-only and are never bundled.",
    },
    releaseNotes: submission.releaseNotes,
    reviewCases: { status: "instructions-not-host-execution-receipts", positive: submission.positiveTests, negative: submission.negativeTests },
    urls: { npm: "https://www.npmjs.com/package/@ivorycanvas/qamap", release: `${sourceURL}/releases/tag/v${version}`,
      privacy: submission.listing.privacyPolicyURL, terms: submission.listing.termsOfServiceURL, support: submission.listing.supportURL,
      openaiGuide: "https://developers.openai.com/plugins/deploy/submission", desktopOnly: "https://developers.openai.com/plugins/deploy/desktop-only",
      claudeGuide: "https://claude.com/docs/plugins/submit" },
  };
  const guide = [
    `# QAMap reviewer handoff — CLI/OpenAI ${version}; Claude ${claudeVersion}`, "", `Source commit: ${sourceCommit}; uncommitted changes: ${dirty ? "yes" : "no"}.`,
    "This is a generated preparation record, not a publication or approval receipt.", "",
    "## Submission routes", "", "| Channel | Portal | Input |", "| --- | --- | --- |",
    `| OpenAI / ChatGPT / Codex | ${portals.openai} | qamap-openai-${version}.zip; update the existing plugin |`,
    `| Claude | ${portals.claude} | ${fields.claude.sourceURL}; path plugins/claude; branch main |`, "",
    "Claude accepts a Git source. Its ZIP is an inspection copy, not the portal source.",
    `The future v${version} tag URL becomes usable only after that tag is published.`, "",
    "## Automatically supplied", "",
    "OpenAI imports listing copy, URLs, icons, starter prompts, desktop-only capability and release notes from the uploaded manifest.",
    "Claude reads listing copy, version, document URLs and README from the selected source revision.",
    "The companion submission-fields JSON includes copyable source fields, data handling notes and review cases.", "",
    "## Owner checks before submission", "",
    `1. Merge and validate the candidate; verify the exact public @ivorycanvas/qamap@${version}. Do not republish an unchanged CLI for a plugin-only update.`,
    `2. Check the public npm smoke receipt for ${version}, or run node scripts/release-smoke.mjs --version ${version} when a fresh receipt is needed. Local tarball smoke is not a registry receipt.`,
    "3. Rebuild these bundles from the clean final commit. Check checksums and source revision.",
    "4. Open the existing portal entries, validate all findings, and confirm identity, contact, data handling and attestations.",
    "5. Submit the replacement for review. Publication is a separate step; keep the last approved version available.", "",
    "Skills-only OpenAI plugins do not need MCP test-case or demo-video fields. The cases below are supplementary reviewer guidance; they are not fabricated MCP results.",
    "Desktop execution must be supported by the selected OpenAI surface; a successful archive check does not establish portal acceptance.", "",
    "## Data handling", "", ...Object.values(fields.dataHandling).map(value => `${value}\n`),
    "## Claude analysis-only scope", "", fields.claude.releaseNotes, "",
    ...fields.claude.reviewCases.flatMap(entry => [`Prompt: ${entry.prompt}`, "", `Expected: ${entry.expected}`, ""]),
    "## CLI / OpenAI release notes", "", submission.releaseNotes, "",
    "## CLI / OpenAI positive review cases", "",
    ...submission.positiveTests.flatMap(entry => [`### ${entry.id}`, "", `Prompt: ${entry.prompt}`, "", `Public fixture: ${sourceURL}/tree/${sourceCommit}/${entry.fixture}`, "", `Expected: ${entry.expectedBehavior} ${entry.expectedResultShape}`, ""]),
    "## CLI / OpenAI negative review cases", "",
    ...submission.negativeTests.flatMap(entry => [`### ${entry.id}`, "", `Prompt: ${entry.prompt}`, "", `Expected: ${entry.expectedBehavior}`, "", `Reason: ${entry.reason}`, ""]),
    "## Links", "", ...Object.entries(fields.urls).map(([label, url]) => `- ${label}: ${url}`), "",
  ].join("\n");
  await mkdir(output, { recursive: true });
  const artifacts = [
    [`qamap-openai-${version}.zip`, zipFiles(openaiEntries)],
    [`qamap-claude-${claudeVersion}.zip`, zipFiles(claudeEntries)],
    [`qamap-submission-fields-${version}.json`, Buffer.from(`${JSON.stringify(fields, null, 2)}\n`)],
    [`qamap-review-guide-${version}.md`, Buffer.from(guide)],
  ];
  for (const [name, bytes] of artifacts) await writeFile(path.join(output, name), bytes);
  const checksums = artifacts.map(([name, bytes]) => `${createHash("sha256").update(bytes).digest("hex")}  ${name}`).join("\n");
  await writeFile(path.join(output, "SHA256SUMS"), `${checksums}\n`);
  return { version, claudeVersion, sourceCommit, dirty, output, openaiFiles: openaiEntries.length, claudeFiles: claudeEntries.length, files: artifacts.map(([name]) => name) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--output"), "Usage: node scripts/plugin-bundle.mjs [--output DIRECTORY]");
  console.log(JSON.stringify(await buildPluginBundles(repositoryRoot, path.resolve(args[1] ?? path.join(repositoryRoot, "release-artifacts"))), null, 2));
}
