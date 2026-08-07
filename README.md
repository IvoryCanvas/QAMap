# QAMap

[![CI](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ivorycanvas/qamap.svg)](https://www.npmjs.com/package/@ivorycanvas/qamap)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<a href="https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629">
  <img src="docs/assets/openai-plugin-directory-badge.svg" alt="QAMap is available in the OpenAI Plugin Directory" height="64">
</a>

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

## Start In 60 Seconds

Requires Node.js 20 or newer. Run this from the branch you want to review:

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

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
| Browse all documentation | [Documentation map](docs/README.md) |

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

## Daily Commands

Install QAMap once in a JavaScript repository:

```sh
pnpm add -D @ivorycanvas/qamap
pnpm exec qamap init --scripts
```

Then use:

```sh
pnpm qa          # committed branch changes
pnpm qa:local    # include uncommitted changes
pnpm qa:run      # run the selected existing validation
pnpm qa:e2e      # preview the optional E2E draft
```

Other repository types can keep using the universal `npx` command.

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

<details>
<summary>한국어 소개</summary>

QAMap은 현재 작업 브랜치의 커밋과 diff, 저장소 구조, 기존 테스트를
로컬에서 읽고 "이 변경이 병합 전에 무엇을 증명해야 하는가"를 정리하는
QA 도구입니다.

변경 의도와 영향을 받는 흐름을 찾고, 정상·실패·경계·상태 전환
시나리오를 선택하며, 각 판단에 실제 파일과 줄 근거를 붙입니다. 테스트
환경이 없어도 QA 판단은 제공하고, 충분한 실행 근거가 있을 때만 기존
검증이나 선택적 E2E 초안으로 연결합니다.

`qa`는 정적 분석만 수행합니다. `qa run`은 선택된 기존 저장소 명령을
명시적으로 실행하고, `e2e draft`는 검토 가능한 자동화 초안을 만듭니다.

</details>

## Contributing

Real false positives, missed risks, unusable drafts, and minimized failing
repositories are especially valuable. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); public reports must not contain private
repository or customer information.

QAMap does not replace human review, executable tests, or security tooling. It
reduces the repeated work between receiving a change and deciding what that
change must prove.
