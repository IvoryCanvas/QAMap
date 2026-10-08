# QAMap

QAMap helps review pull requests by gathering the changed code, related tests,
callers and Git history into one bounded local report. Claude uses that evidence
to explain possible regressions and what still needs testing. Missing evidence
stays visible; a static report is not proof that tests passed.

On 42 public pull requests from 12 open-source projects, Claude Code used 44%
fewer tokens with the brief than alone; the blind-graded review preference leaned
slightly to Claude Code alone and was not significant. See the
[measured results](https://github.com/IvoryCanvas/QAMap/blob/main/test/benchmarks/review-host/external/RESULTS.md).
Source, issues and documentation: [IvoryCanvas/QAMap](https://github.com/IvoryCanvas/QAMap).

![QAMap](.claude-plugin/icon.svg)

## Requirements

Use Claude Code with a local checkout, a terminal, Git, Node.js 20 or later, and
the matching CLI: `@ivorycanvas/qamap@0.5.1`. A chat without local repository and
terminal access cannot run this workflow.

This bundle supplies the skill, not the CLI. It has no automatic installer,
dependency lockfile, hook, background service or MCP server. With the user's
permission, install the CLI separately:

```sh
npm install -g @ivorycanvas/qamap@0.5.1
```

Installation downloads QAMap and its dependencies from the npm registry under
the package manager's network and authentication settings. The plugin does not
ask for an API key or read a credential store. It does not bundle the project's
developer-only model benchmarks or their provider clients.

## Review A Pull Request

Ask Claude to review the current PR with QAMap. For a general review request,
the skill checks consent first and offers QAMap if no choice is recorded.
Installing the plugin does not grant consent. A refusal leaves the repository
unanalyzed by QAMap.

The skill runs `qamap qa brief --require-consent` once and waits for completion.
It reviews that report rather than repeatedly searching the same source. An
explicit request for QAMap can authorize a single run. Lasting preferences are
managed with `qamap consent grant` or `qamap consent grant --global`, and removed
with `qamap consent revoke` or `qamap consent revoke --global`.

Test execution, dependency installation, source edits and automation require
separate permission. The [advanced workflow](skills/qamap-pr-qa/references/advanced-workflow.md)
documents these optional commands, including version-pinned downloads. They
are not automatic follow-ups to a review.

## Data And Model Use

QAMap reads the selected repository's code, tests, configuration and Git history.
The brief command writes private local reports under the user's `QAMap-reports`
directory by default, or the explicitly selected output directory. Reports may
contain source excerpts and personal data already present in the repository.
Users control report retention and deletion; temporary analysis caches have
separate retention rules in the [privacy notice](PRIVACY.md).

The analysis engine does not upload source or call a model. Claude receives the
returned evidence under the host's data policies and uses model tokens to
interpret it. Savings and complete bug coverage are not guaranteed. An approved
repository test command may have its own network access and side effects.

[Source](https://github.com/IvoryCanvas/QAMap) | [Support](SUPPORT.md) |
[Security](SECURITY.md) | [Privacy](PRIVACY.md) | [Terms](TERMS.md) | [MIT License](LICENSE)
