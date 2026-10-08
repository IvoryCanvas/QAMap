# QAMap In Claude Code

[한국어](ko/claude-code.md) | [Documentation](README.md)

The Claude Code plugin supplies the review skill. The QAMap CLI gathers local
evidence; Claude interprets it. You need a local checkout, Git, a terminal and
Node.js 20 or newer. A web-only chat without local repository and terminal access
cannot run this workflow. Support on Cowork or ordinary Claude chat is not claimed.

## Install The Plugin

Install from this repository's plugin marketplace in Claude Code:

```txt
/plugin marketplace add IvoryCanvas/QAMap
/plugin install qamap@ivorycanvas
```

The marketplace serves the plugin in `plugins/claude` on the default branch.
Confirm with `/plugin` that the plugin is enabled. The [official installation guide](https://code.claude.com/docs/en/discover-plugins)
covers marketplace commands for your Claude Code version.

QAMap is also in the [Claude plugin directory](https://claude.com/marketplace/plugins):
search for **QAMap** by **IvoryCanvas** and use the installation action on the
listing. Account-enabled plugins sync into signed-in terminal sessions on Claude
Code 2.1.273 or newer. Use one of the two sources, not both, so only one copy of
the skill is active.

## Install The Matching CLI

The plugin does not bundle the CLI or install it automatically. With your
permission, install the version required by its skill. The 0.5.1 skill requires:

```sh
npm install -g @ivorycanvas/qamap@0.5.1
qamap --version
```

Installation downloads packages from npm. No model-provider API key is required
by QAMap. npm authentication, if needed for your environment, is handled by the
package manager. A later npm release does not update the installed plugin.

## Review A PR

From the branch you want to review, ask Claude:

```txt
Check this PR for bugs.
```

With no recorded choice, the skill offers QAMap and waits for your answer: this
time only, always, or not now. Installation is not consent. A refusal leaves the
change unanalyzed by QAMap. You can also request QAMap explicitly for one review.

After consent, the skill runs the brief once, waits for completion, and reviews
its diff, tests, callers, QA focus and unknowns. The default command checks
recorded consent before analysis:

```sh
qamap qa brief --require-consent
```

For a one-time request, the skill may omit that flag after your explicit consent.
To manage an ongoing preference yourself, choose the command for the scope and
action you want; do not run every line as a setup sequence:

```sh
qamap consent grant
qamap consent grant --global
qamap consent status
qamap consent revoke
qamap consent revoke --global
```

`grant` applies to this project; `--global` applies to supported user instructions.
These choices do not authorize test runs, edits or installations. Tests remain
`not-run` until a separately authorized command is actually executed.

## Without A Directory Install

After installing the CLI, opt in to project setup with:

```sh
qamap init --agent .
```

This adds QAMap's marked instructions, project skills and starter configuration
while preserving existing content. It is a project setup alternative, not a
directory plugin installation. It still asks before analysis. See
[agent integration](agent-skill.md) for saved preferences and other hosts.

## Tokens, Reports And Updates

QAMap's analysis makes no model call and does not upload source. Claude still
uses tokens for skill loading, invocation and interpretation. Extra model turns
to check completion add usage; elapsed waiting time alone does not. Returned
source excerpts enter the host's context under its data policies.
One brief avoids repeated discovery but does not guarantee token savings or
complete bug coverage. [Measurements and limits](release-validation.md) are
separate from directory approval.

The brief saves full reports locally under `~/QAMap-reports/qa-*` by default.
Reports may contain private source or data already in the repository. You control
retention and sharing; saving a report does not mean tests passed.

npm, OpenAI and Claude directory versions update independently. Confirm the
plugin's required CLI version after an update. See the
[Claude submission runbook](claude-plugin-submission.md) for maintainer updates.
