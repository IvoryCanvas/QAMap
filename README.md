# QAMap

**English** | [한국어](README.ko.md)

[![CI](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ivorycanvas/qamap.svg)](https://www.npmjs.com/package/@ivorycanvas/qamap)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<a href="https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629">
  <img src="docs/assets/openai-plugin-directory-badge.svg" alt="Install QAMap from the OpenAI Plugin Directory" height="64">
</a>

**Install in ChatGPT or Codex:** open **Plugins**, search for **QAMap**, select
**+**, then start a new chat. [Open QAMap](https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629)
· [Official installation steps](https://learn.chatgpt.com/docs/plugins#install-and-use-a-plugin)

![QAMap: find what a change needs to prove](docs/assets/qamap-cover.png)

**Find what a change needs to prove before merge.**

QAMap is a local-first QA CLI. It reads the current branch, repository structure,
existing tests, and diff evidence to answer:

1. What behavior changed?
2. What could fail?
3. What should be verified before merge, and why?
4. What can be checked now or drafted as E2E?

QAMap itself makes no cloud analysis, source upload, or additional LLM call. A
manifest and test runner are optional.

## Run The CLI In 60 Seconds

QAMap requires Node.js 20 or newer. Use an
[actively supported Node.js LTS release](https://nodejs.org/en/about/previous-releases)
when possible; Node.js 20 remains package-compatible but is upstream EOL. The
same QAMap command works on every compatible Node.js version.

Run this from the branch you want to review. It works regardless of whether the
repository uses npm, pnpm, Yarn, or Bun, and it does not add QAMap to the
project's dependencies:

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

<details>
<summary>Validated Node.js lines</summary>

The published `0.4.13` package completed an install and real `qa` smoke on these
lines on 2026-08-11. The install command is the same for every line.

| Node.js | Smoke | Guidance |
| --- | --- | --- |
| 20 | Passed | Package-compatible, but upstream EOL; upgrade for security fixes |
| 22 | Passed | Supported LTS at the time of validation |
| 24 | Passed | Supported LTS at the time of validation |
| 26 | Passed | Current release at the time of validation; prefer LTS for production |

See the [release validation receipt](docs/release-validation.md#unreleased---2026-08-11)
for exact versions and package-manager coverage.

</details>

QAMap infers the base branch in standard repositories. Override it only when
needed:

```sh
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```

The default output is concise. Open the complete reasoning trace with:

```sh
npx --yes @ivorycanvas/qamap@latest qa --format markdown
```

## Read The Result

| Section | Question it answers |
| --- | --- |
| **Change** | What behavior probably changed? |
| **Verify before merge** | Which normal, failure, boundary, or state-transition checks matter? |
| **Evidence** | Which commit, file, line, or symbol supports each judgment? |
| **Next** | Is there an existing command to run or an optional draft to preview? |

QAMap keeps static reasoning and executed QA separate. A proposed scenario or E2E
draft is never reported as a passing test.

For supported runtime contracts, QAMap can trace a changed entry point through
local imports to a required provider. A test that mocks away that prerequisite
is disclosed as incomplete evidence instead of being promoted as proof.

Cleanup-only commits remain visible as provenance but do not become standalone
QA requirements. Unrelated issue tags and lifecycle stages stay separate. When
the changed source does not prove an externally observable result, QAMap reports
that proof gap instead of turning a commit title or function name into an
assertion.

## See A Real Run

This recording uses a committed public fixture. QAMap finds a duplicate-request
guard, routes the relevant scenarios, cites changed lines, and leaves execution
marked `not run`.

![QAMap reads a branch diff and returns a concise, evidence-backed QA summary](docs/assets/qamap-quickstart.gif)

<details>
<summary>Open the shortened terminal output</summary>

```txt
QAMap QA
Local static analysis. Product QA was not run.

Change
  Prevent duplicate subscription renewal requests

Verify before merge
  REQUIRED     Subscription becomes visibly active
  RECOMMENDED  Duplicate renewal request is prevented

Evidence
  3/3 scenarios connect to 6 unique diff sources.
  Existing validation: npm run test:e2e (selected, not run)

Next
  Run selected validation: qamap qa run
  Preview E2E draft: qamap e2e draft . --dry-run
```

</details>

The generated browser checks are exercised separately by the
[execution benchmark](docs/benchmarking.md#run-the-execution-contract).

## Choose Your Path

| Goal | Start here |
| --- | --- |
| Review one branch | [First-run walkthrough](docs/quickstart-demo.md) |
| Use QAMap every day | [Adoption guide](docs/adoption.md) |
| Use QAMap from an agent | [Agent integration](docs/agent-skill.md) |
| Correct repeated misunderstandings | [Verification manifest](docs/manifest.md) |
| Understand every command | [Command reference](docs/commands.md) |
| Contribute a fix or failure case | [Contributing](CONTRIBUTING.md) |
| Browse all documentation | [English documentation](docs/en/README.md) |

Most users only need the first two rows.

## Analysis, Execution, And E2E

| Command | What it does | Writes or runs project code? |
| --- | --- | --- |
| `qamap qa` | Maps the diff to behavior, risk, evidence, and QA scenarios. | No |
| `qamap qa run` | Runs one existing repository validation selected by QAMap. | Yes, explicitly |
| `qamap e2e draft . --dry-run` | Previews optional Playwright, Maestro, CLI, API, or manual automation. | No |

QAMap does not hide an important QA scenario because a repository lacks a
selector, fixture, Playwright, Maestro, or test runner. Those are automation
details. Missing evidence remains visible instead of becoming a fabricated pass.

## Install For Repeat Use

The one-off `npx` command above is the safest first run because it leaves the
repository's dependency files unchanged. To pin QAMap in a JavaScript project,
use the repository's package manager:

| Package manager | Install | Add the short scripts |
| --- | --- | --- |
| npm | `npm install --save-dev @ivorycanvas/qamap` | `npm exec -- qamap init --scripts` |
| pnpm | `pnpm add --save-dev @ivorycanvas/qamap` | `pnpm exec qamap init --scripts` |
| Yarn 1 or newer | `yarn add --dev @ivorycanvas/qamap` | `yarn qamap init --scripts` |
| Bun | `bun add --dev @ivorycanvas/qamap` | `bun run qamap init --scripts` |

`init --scripts` adds `qa`, `qa:local`, `qa:run`, and `qa:e2e`. Run the same
script with the syntax your project already uses:

```sh
npm run qa       # npm
pnpm qa          # pnpm
yarn qa          # Yarn
bun run qa       # Bun
```

Replace `qa` with `qa:local` to include uncommitted changes, `qa:run` to run the
selected existing validation, or `qa:e2e` to preview the optional E2E draft.
Non-JavaScript repositories can keep using the universal `npx` command.

<details>
<summary>Package-manager-specific one-off commands</summary>

These commands also work without adding QAMap as a project dependency:

```sh
pnpm dlx @ivorycanvas/qamap@latest qa
yarn dlx @ivorycanvas/qamap@latest qa  # Yarn 2+
bunx @ivorycanvas/qamap@latest qa
```

Yarn Classic users can use the universal `npx` command or install QAMap in the
project. Corepack-managed package managers may add or update the repository's
`packageManager` metadata; use the `npx` first run when a no-write check matters.

</details>

## How It Works

```txt
commit + diff
    -> changed behavior and flow
    -> risk and QA scenario routing
    -> file and line reasoning trace
    -> existing validation or optional E2E draft
```

QAMap ranks direct changed behavior ahead of broad repository guesses. Shared
components can reach importing surfaces through reverse-import context, while
unrelated consumers remain out of scope.

## Agents And Team Context

Agents can consume the same decision in a compact, versioned payload:

```sh
npx --yes @ivorycanvas/qamap@latest qa --format agent
```

Install the portable project skill with `skills add`, use `qamap init --agent`,
or install the published
[OpenAI Plugin Directory](https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629)
version. Every path calls the same local CLI. See
[Agent integration](docs/agent-skill.md).

The first run needs no configuration. If QAMap repeatedly misunderstands a
durable team flow, create and review repo-local QA context:

```sh
npx --yes @ivorycanvas/qamap@latest manifest init
```

See [Verification manifest](docs/manifest.md) before committing
`.qamap/manifest.yaml`.

## Limits

QAMap is early and pre-`1.0`. Static analysis cannot know every product decision.
Inferred scenarios require review, and one green repository command does not
prove that the whole product passed QA.

The public release gate includes cross-framework, API, CLI, monorepo, testless,
false-positive, scenario-to-diff trace, generated-browser-test, package, coverage,
and no-private-fixture contracts. See [Benchmarking](docs/benchmarking.md) for
the exact evidence.

## Other Languages

- [한국어 README](README.ko.md)
- [한국어 문서](docs/ko/README.md)

## Contributing

Real false positives, missed risks, unusable drafts, and minimized failing
repositories are especially valuable. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); public reports must not contain private
repository or customer information.

QAMap does not replace human review, executable tests, or security tooling. It
reduces the repeated work between receiving a change and deciding what that
change must prove.
