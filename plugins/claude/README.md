# QAMap — PR Analysis

QAMap helps review pull requests by gathering the changed code, related tests,
callers and Git history into one bounded local report. Claude uses that evidence
to explain possible regressions and what still needs testing. Missing evidence
stays visible; a static report is not proof that tests passed. This Claude plugin
only analyzes and reads evidence. It does not execute project validation,
generate automation, edit source or configure the project.

Claude plugin version: **0.5.4**. Required CLI: **@ivorycanvas/qamap@0.5.3**.
The plugin revision and the CLI version are independent.

On 42 public pull requests from 12 open-source projects, Claude Code used 44%
fewer tokens with the brief than alone; the blind-graded review preference leaned
slightly to Claude Code alone and was not significant. See the
[measured results](https://github.com/IvoryCanvas/QAMap/blob/main/test/benchmarks/review-host/external/RESULTS.md).
These receipts describe the earlier build that became 0.5.2, not a measurement
of 0.5.3. No new token or review-quality improvement is claimed for this release.
Source, issues and documentation: [IvoryCanvas/QAMap](https://github.com/IvoryCanvas/QAMap).

![QAMap](.claude-plugin/icon.svg)

## Requirements

Use Claude Code with a local checkout, a terminal, Git, Node.js 20 or later, and
the matching CLI: `@ivorycanvas/qamap@0.5.3`. A chat without local repository and
terminal access cannot run this workflow.

This bundle supplies the skill, not the CLI. It has no automatic installer,
dependency lockfile, hook, background service or MCP server. Complete the
[separate CLI setup](https://github.com/IvoryCanvas/QAMap/blob/main/docs/claude-code.md)
before using this plugin. That user setup downloads QAMap and its dependencies
from npm; the installed skill does not install or upgrade packages and does not
run a package-manager launcher. If the required binary is missing or
incompatible, it stops.

Local analysis needs no service credential. The skill does not inspect credential
stores, read secret values or send an existing machine credential to a server.
No API key or authenticated service is declared by the plugin. Developer-only
model benchmarks and their provider clients are outside this bundle.

## Review A Pull Request

Ask Claude to review the current PR with QAMap. For a general review request,
the skill checks consent first and offers QAMap if no choice is recorded.
Installing the plugin does not grant consent. A refusal leaves the repository
unanalyzed by QAMap.

The skill runs `qamap qa brief --require-consent` once and waits for completion.
It reviews that report rather than repeatedly searching the same source. An
explicit request for QAMap can authorize a single run. Lasting preferences are
managed separately by the user; the plugin does not modify those preferences.

The plugin reports suggested checks as a checklist and then stops. It does not
execute a command recommended by the report. Requests to run tests, install
dependencies, generate automation, edit files or change lasting preferences
must use a separate workflow outside this plugin. The advanced CLI execution
guide is not included or loaded by this plugin.

The CLI continues to offer separate execution and configuration features. This
plugin does not invoke them. Its scope is an instruction boundary, not a sandbox
for arbitrary commands the user runs separately.

## Data And Model Use

QAMap reads the selected repository's code, tests, configuration and Git history.
The brief command writes private local reports under the user's `QAMap-reports`
directory by default, or the explicitly selected output directory. Reports may
contain source excerpts and personal data already present in the repository.
Users control report retention and deletion; temporary analysis caches have
separate retention rules in the [privacy notice](PRIVACY.md).

The analysis engine does not upload source or call a model. Claude receives the
returned evidence under the host's data policies and uses model tokens to
interpret it. Savings and complete bug coverage are not guaranteed. The shared
privacy notice also describes broader CLI commands; those execution features
are outside this plugin's analysis-only scope.

[Source](https://github.com/IvoryCanvas/QAMap) | [Support](SUPPORT.md) |
[Security](SECURITY.md) | [Privacy](PRIVACY.md) | [Terms](TERMS.md) | [MIT License](LICENSE)
