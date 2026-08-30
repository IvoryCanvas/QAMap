# QAMap

**English** | [한국어](README.ko.md)

[![CI](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush)
[![npm version](https://img.shields.io/npm/v/@ivorycanvas/qamap.svg)](https://www.npmjs.com/package/@ivorycanvas/qamap)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![QAMap: know what to test before merge](docs/assets/qamap-cover.png)

**Turn a PR diff into an evidence-backed QA plan before merge.**

QAMap is a local-first CLI that reads the current branch, repository structure,
and existing tests. It answers three questions:

- Which behavior and user flows may be affected?
- Which normal, failure, boundary, and state-transition scenarios matter?
- Which changed files, lines, symbols, and commits support each judgment?

QAMap can then route an existing validation command or prepare optional
automation. It does not upload source code or make its own LLM call.

## Install And Run

### Local CLI (Recommended)

With Node.js 20 or newer, run this from the branch you want to review:

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

The command performs read-only static analysis. It does not change project files
or run product tests. For repeat use, other package managers, and local changes,
see the [adoption guide](docs/adoption.md).

### ChatGPT And Codex Plugin

Install the plugin when you want an agent to invoke the same local workflow
during PR review or test planning.

<a href="https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629">
  <img src="docs/assets/openai-plugin-directory-badge.svg" alt="Install QAMap from the OpenAI Plugin Directory" height="64">
</a>

[Plugin installation help](https://learn.chatgpt.com/docs/plugins#install-and-use-a-plugin)

The host agent still uses its own model and permissions. QAMap provides the
local, deterministic repository analysis inside that workflow.

## Read The Result

| Section | What it tells you |
| --- | --- |
| **Change** | Which behavior probably changed. |
| **Verify before merge** | Which scenarios matter before merge. |
| **Evidence** | Which commit and code location support the judgment. |
| **Next** | What can be reviewed, run, or drafted next. |

The default `qa` command creates a plan and remains `not run`. Use `qamap qa run`
only when you want to execute a selected repository command. Use
`qamap e2e draft . --dry-run` to preview optional browser, mobile, API, CLI, or
manual automation.

## See A Real Run

This public fixture changes a subscription renewal flow. QAMap finds the
duplicate-request risk, cites the changed source, and keeps execution marked
`not run`.

![QAMap reads a branch diff and returns an evidence-backed QA summary](docs/assets/qamap-quickstart.gif)

[Open the exact CLI output and first-run walkthrough](docs/quickstart-demo.md).

## How It Works

```txt
commit + diff
    -> affected behavior and flow
    -> risk-based QA scenarios
    -> evidence for every judgment
    -> existing validation or optional automation
```

QAMap follows direct change evidence before broad repository guesses. Missing
Playwright, Maestro, selectors, fixtures, or a test runner does not hide an
important scenario. When evidence is insufficient, QAMap stops instead of
inventing a contract or a passing result.

## Documentation

| Goal | Guide |
| --- | --- |
| Review one branch | [First-run walkthrough](docs/quickstart-demo.md) |
| Adopt QAMap in a team | [Adoption guide](docs/adoption.md) |
| Use QAMap from an agent | [Agent integration](docs/agent-skill.md) |
| Review every command | [Command reference](docs/commands.md) |
| Inspect benchmark evidence | [Benchmarking](docs/benchmarking.md) |

## Limits

QAMap is early and pre-`1.0`. Static analysis cannot know every product decision,
and inferred scenarios still require review. One passing command does not prove
that an entire product passed QA.

## Contributing

False positives, missed risks, and unusable drafts are especially useful. Start
with [CONTRIBUTING.md](CONTRIBUTING.md), and never publish private repository,
customer, or credential data.

[한국어 README](README.ko.md) | [Code of Conduct](CODE_OF_CONDUCT.md) | [MIT License](LICENSE)
