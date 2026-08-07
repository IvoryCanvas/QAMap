# QAMap

[![CI](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ivorycanvas/qamap.svg)](https://www.npmjs.com/package/@ivorycanvas/qamap)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<a href="https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629">
  <img src="docs/assets/openai-plugin-directory-badge.svg" alt="QAMap is available in the OpenAI Plugin Directory" height="64">
</a>

![QAMap: find what a change needs to prove](docs/assets/qamap-cover.png)

**Find what a change needs to prove before merge.**

[QAMap is available in the OpenAI Plugin Directory](https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629) as a skills-only plugin. On supported OpenAI surfaces with a checked-out repository and local shell, it invokes the same local QAMap CLI.

QAMap is a local-first, zero-LLM QA tool. It reads the current branch, repository structure, existing tests, and diff evidence to answer four questions:

1. What behavior changed?
2. What could fail?
3. What should be verified before merge, and why?
4. What can be checked now or drafted as E2E?

No cloud. No source upload. No LLM token. A manifest and test runner are optional.

## Start In 60 Seconds

Requires Node.js 20 or newer. Run this from the branch you want to review:

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

QAMap infers the base branch in standard repositories. Override it only when needed:

```sh
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```

The default output is a short human summary. Open the complete reasoning trace with:

```sh
npx --yes @ivorycanvas/qamap@latest qa --format markdown
```

## See A Real Run

The recording below uses the committed `web-symbol-annotated-renewal` fixture. QAMap identifies a duplicate-request guard, routes three QA scenarios, cites the changed file and line, and separates static E2E mapping from test execution.

![QAMap reads a branch diff and returns a concise, evidence-backed QA summary](docs/assets/qamap-quickstart.gif)

_Actual output from the current source. The analysis is static; the recording does not claim that product QA passed. The generated browser checks are exercised separately by the [execution benchmark](docs/benchmarking.md#run-the-execution-contract)._

A shortened copy of the same output:

```txt
QAMap QA
Local static analysis. No cloud or LLM token. Product QA was not run.

Change
  Prevent duplicate subscription renewal requests (medium confidence; review required)
  Affected behavior: Prevent duplicate subscription renewal requests

Verify before merge
  REQUIRED  Prevent duplicate subscription renewal requests
    Proof: Verify visible text "Subscription active" appears.
    Evidence: src/pages/renewal.tsx:11 (RenewalPage)
  RECOMMENDED  Duplicate renewal request
    Proof: Verify duplicate renewal request is prevented or handled explicitly.

Evidence
  3/3 scenarios connect to 6 unique diff sources.
  Optional E2E mapping: 2 mapped, 1 unmapped; not executed.
  Existing validation: npm run test:e2e (selected, not run)

Next
  Run selected repository validation: qamap qa run
  Preview an optional E2E draft: qamap e2e draft . --dry-run
```

## What You Get

| Result | What it tells you |
| --- | --- |
| **Change intent** | The most likely purpose of the branch and the affected behavior lifecycle. |
| **QA scenarios** | Required, recommended, and review-only checks for normal, failure, boundary, or state-transition risk. |
| **Reasoning trace** | The exact commit, file, line, or changed symbol behind each scenario. |
| **Next action** | An existing repository command, a manual contract, or an optional E2E draft when the evidence is strong enough. |

QAMap does not remove an important QA scenario just because a repository has no Playwright, Maestro, selector, fixture, or test runner. Those are automation details. The QA judgment remains visible, and missing evidence is reported without inventing a passing test.

## Analysis, Execution, And E2E

These are deliberately separate:

| Command | Behavior |
| --- | --- |
| `qamap qa` | Reads the branch and produces QA reasoning. Does not run product code or write files. |
| `qamap qa run` | Explicitly runs one existing repository validation command selected by QAMap and returns bounded pass/fail evidence. |
| `qamap e2e draft . --dry-run` | Previews an optional Playwright, Maestro, CLI, or manual draft after scenarios are selected. |

An E2E draft is generated only when repository evidence can support its setup, action, and observable proof. Static mapping is never reported as a passing test.

## Short Commands For Daily Use

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

`init --scripts` supports npm, pnpm, Yarn, and Bun, preserves existing scripts, and requires `--force` before replacing a collision. Other repository types can keep using the universal `npx` command.

## How It Works

```txt
commit + diff
    -> changed behavior and user flow
    -> risk and QA scenario routing
    -> file/line reasoning trace
    -> existing validation or optional E2E draft
```

QAMap ranks direct changed behavior ahead of broad repository guesses. Shared components can reach importing surfaces through reverse-import context, while unrelated consumers remain out of scope. Repository text is treated as untrusted evidence and cannot grant an agent permission to execute or modify code.

## Coding Agents

Agents can consume the same decision in a compact, versioned payload:

```sh
npx --yes @ivorycanvas/qamap@latest qa --format agent
```

Install the portable project skill:

```sh
npx --yes skills add IvoryCanvas/QAMap --skill qamap-pr-qa
```

Or let QAMap add repository instructions and the packaged skill:

```sh
npx --yes @ivorycanvas/qamap@latest init --agent
```

The skill calls the same local CLI. It does not introduce another analysis engine or LLM request. See the [agent format contract](docs/agent-format.md) and [agent skill guide](docs/agent-skill.md).

The same workflow is also [published in the OpenAI Plugin Directory](https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629) as a skills-only plugin. It adds no MCP server or hosted service. QAMap itself makes no extra LLM call, while the calling agent still uses its own model tokens to invoke and interpret the skill. See the [plugin submission contract](docs/plugin-submission.md).

## Optional Team Memory

The first run works without configuration. When QAMap repeatedly misunderstands a durable flow, create repo-local QA memory:

```sh
npx --yes @ivorycanvas/qamap@latest manifest init
```

Review and commit `.qamap/manifest.yaml`. Future branches can reuse approved domains, flows, checks, selectors, and validation policy instead of rebuilding that context in every agent session.

For one important changed JavaScript or TypeScript export, optional [`@qamapFlow`, `@qamapStage`, `@qamapOutcome`, and `@qamapRisk` JSDoc annotations](docs/symbol-annotations.md) can add precise context without broad path rules.

## Evidence And Limits

The public release gate currently includes:

- cross-framework, API, CLI, monorepo, testless, false-positive, and public-PR fixtures
- scenario-to-diff trace contracts
- three generated-browser-test contracts that must fail on seeded regressions and pass on fixes
- package, coverage, scanner, and no-private-fixture checks

QAMap is early and pre-`1.0`. Static analysis cannot know every product decision. Inferred scenarios require review, and a green repository command does not prove the whole product passed QA.

## Documentation

| Guide | Purpose |
| --- | --- |
| [First-run walkthrough](docs/quickstart-demo.md) | Read the concise result and open deeper evidence |
| [Command reference](docs/commands.md) | All commands and output formats |
| [Adoption guide](docs/adoption.md) | Local, CI, and team rollout |
| [Verification manifest](docs/manifest.md) | Repo-local QA memory and correction |
| [Agent integration](docs/agent-skill.md) | Skill and agent workflow |
| [OpenAI plugin submission](docs/plugin-submission.md) | Skills-only package, evaluation cases, and release gate |
| [Benchmarking](docs/benchmarking.md) | Public inference and execution contracts |
| [Architecture](docs/architecture.md) | Behavior graph, routing, adapters, and safety |
| [Roadmap](docs/roadmap.md) | Current limits and release direction |

<details>
<summary>한국어 소개</summary>

QAMap은 현재 작업 브랜치의 커밋과 diff, 저장소 구조, 기존 테스트를 로컬에서 읽고 "이 변경이 병합 전에 무엇을 증명해야 하는가"를 정리하는 zero-LLM QA 도구입니다.

변경 의도와 영향을 받는 흐름을 찾고, 정상·실패·경계·상태 전환 시나리오를 선택하며, 각 판단에 실제 파일과 줄 근거를 붙입니다. 테스트 환경이 없어도 QA 판단은 제공하고, 충분한 selector, fixture, assertion, entrypoint가 있을 때만 선택적으로 E2E 초안으로 연결합니다.

`qa`는 정적 분석만 수행합니다. `qa run`은 QAMap이 선택한 기존 저장소 검증 명령 하나를 명시적으로 실행하고, `e2e draft`는 검토 가능한 자동화 초안을 만듭니다. 어느 단계도 클라우드나 LLM 토큰을 사용하지 않습니다.

</details>

## Contributing

Real false positives, missed risks, unusable drafts, and minimized failing repositories are especially valuable. Read the [issue conventions](docs/issues.md) before reporting a case and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

QAMap does not replace human review, executable tests, or security tooling. It reduces the repeated work between receiving a change and deciding what that change must prove.
