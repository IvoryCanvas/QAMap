#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_SECTIONS = [
  "Summary",
  "Behavioral Contract",
  "Evidence",
  "Checks",
  "Public OSS Check",
  "Review Notes",
];

const CONTENT_SECTIONS = ["Summary", "Behavioral Contract", "Evidence"];
const TITLE_PATTERN = /^(?:Feat|Fix|Test|Docs|Refactor|Style|Chore|Hotfix): \S(?:.*\S)?$/;
const BRANCH_PATTERN = /^(?:feat|fix|test|refactor|style|hotfix|chore|docs)\/[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/;

export function validatePullRequestEvent(event) {
  const pullRequest = event?.pull_request;
  if (!pullRequest) {
    return {
      skipped: false,
      errors: ["The event payload does not contain a pull request."],
    };
  }

  if (pullRequest.draft === true) {
    return { skipped: true, errors: [] };
  }

  const errors = [];
  const title = typeof pullRequest.title === "string" ? pullRequest.title : "";
  const branch = typeof pullRequest.head?.ref === "string" ? pullRequest.head.ref : "";
  const body = typeof pullRequest.body === "string" ? pullRequest.body : "";
  const labels = Array.isArray(pullRequest.labels)
    ? pullRequest.labels
        .map((label) => (typeof label === "string" ? label : label?.name))
        .filter((label) => typeof label === "string")
    : [];

  if (!TITLE_PATTERN.test(title)) {
    errors.push(
      "Use a capitalized Conventional Commit type in the PR title, for example `Feat: add route evidence`.",
    );
  }

  if (!BRANCH_PATTERN.test(branch)) {
    errors.push(
      "Use a documented lowercase branch prefix: feat/, fix/, test/, refactor/, style/, hotfix/, chore/, or docs/.",
    );
  }

  const sections = extractSections(body);
  for (const heading of REQUIRED_SECTIONS) {
    const matchingSections = sections.filter((section) => section.heading === heading);
    if (matchingSections.length === 0) {
      errors.push(`Add the required \`## ${heading}\` section.`);
    } else if (matchingSections.length > 1) {
      errors.push(`Keep exactly one \`## ${heading}\` section.`);
    }
  }

  for (const heading of CONTENT_SECTIONS) {
    const section = sections.find((candidate) => candidate.heading === heading);
    if (section && !hasVisibleContent(section.content)) {
      errors.push(`Describe the pull request in \`## ${heading}\` instead of leaving it empty.`);
    }
  }

  const checks = sections.find((section) => section.heading === "Checks");
  if (checks && countCheckedBoxes(checks.content) === 0) {
    errors.push("Mark at least one completed item in `## Checks`.");
  }

  const publicOss = sections.find((section) => section.heading === "Public OSS Check");
  if (publicOss) {
    const boxes = checkboxStates(publicOss.content);
    if (boxes.length < 3 || boxes.some((checked) => !checked)) {
      errors.push("Complete every checkbox in `## Public OSS Check`.");
    }
  }

  const typeLabels = labels.filter((label) => label.startsWith("type: "));
  if (typeLabels.length !== 1) {
    errors.push("Apply exactly one `type:` label.");
  }
  if (!labels.some((label) => label.startsWith("area: "))) {
    errors.push("Apply at least one `area:` label.");
  }

  return { skipped: false, errors };
}

function extractSections(body) {
  const matches = [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)];
  return matches.map((match, index) => {
    const contentStart = (match.index ?? 0) + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? body.length;
    return {
      heading: match[1],
      content: body.slice(contentStart, contentEnd),
    };
  });
}

function hasVisibleContent(content) {
  return content.replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
}

function checkboxStates(content) {
  return [...content.matchAll(/^\s*-\s+\[([ xX])\]\s+/gm)].map(
    (match) => match[1].toLowerCase() === "x",
  );
}

function countCheckedBoxes(content) {
  return checkboxStates(content).filter(Boolean).length;
}

async function runCli() {
  const eventPath = process.argv[2] ?? process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("Pass the pull request event path or set GITHUB_EVENT_PATH.");
  }

  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = validatePullRequestEvent(event);

  if (result.skipped) {
    console.log("Draft pull request: contribution policy check skipped.");
    return;
  }

  if (result.errors.length > 0) {
    console.error("Pull request contribution policy failed:");
    for (const error of result.errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Pull request contribution policy passed.");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runCli();
}
