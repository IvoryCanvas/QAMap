# QAMap

[![CI](https://github.com/IvoryCanvas/qamap/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/qamap/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ivorycanvas/qamap.svg)](https://www.npmjs.com/package/@ivorycanvas/qamap)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A local, zero-LLM PR QA designer. QAMap turns commit intent and code diffs into evidence-backed behavior lifecycles, missing QA, and deterministic automation drafts. No cloud. No source upload. No token.**

QAMap reads commit subjects and bodies, git changes, project structure, selectors, existing tests, and optional repo QA memory, then answers the question every reviewer asks: *"What behavior did this PR intend to change, how does that behavior move through the product, and what should we verify before merge?"* Playwright, Maestro, and manual checklists are output adapters after that judgment, not the product recommendation itself.

```txt
PR commits + diff
  -> qamap qa
  -> change intent + behavior lifecycle + QA scenarios + missing evidence
  -> optional Playwright / Maestro / manual draft

Optional team memory (.qamap/manifest.yaml)
  -> sharper recommendations on every future PR
```

## 30-Second Demo

![QAMap: zero tests to a passing E2E in three commands](docs/assets/qamap-30s-demo.gif)

A real, unedited recording on a Next.js app with **zero committed tests**: `qamap qa` names the affected flow, `qamap e2e setup` writes the Playwright config and a starter spec, and `npm run test:e2e` finishes with `1 passed`. First-run assertions are smoke checks — the point is a runnable starting point, not finished coverage.

Every report opens with intent and behavior before automation tooling (trimmed output):

```txt
## At a Glance

- Change intent: Submit checkout and persist the confirmed order [high]
- Behavior lifecycle: trigger: submit checkout -> side-effect: create order -> observable-outcome: show order confirmation
- Affected behavior: Submit checkout and persist the confirmed order
- Verify before merge: the confirmed order is visible and survives re-entry
- Evidence found: changed file src/pages/checkout/index.tsx; route: /checkout (high); web-test-id: checkout-submit (...)
- Proposed draft: `tests/e2e/checkout-submit.spec.ts` (near runnable)
- Missing before trust: Add deterministic fixture or mock data for /api/checkout (...)
- Automation adapter: Playwright
```

## Install & Quick Start

Requires Node.js 20 or newer. Inside a repository whose default branch is `origin/main` (or `main`), the base is inferred automatically:

```sh
pnpm dlx @ivorycanvas/qamap qa            # what should this branch prove before merge?
pnpm dlx @ivorycanvas/qamap e2e setup . --runner playwright   # no tests yet? create config + starter spec
pnpm dlx @ivorycanvas/qamap manifest init # optional: save reviewed team QA memory for sharper future runs
```

Pass `--base <ref> --head <ref>` for anything non-standard. Run bare `qamap` for a start-here guide, `qamap help` for the full reference, and see the [command reference](docs/commands.md) for every command and output shape.

## For Coding Agents

Stop re-explaining the same QA context to your agent on every PR:

```sh
qamap qa --format agent
```

One minified JSON object (`schema: qamap.qa`) with change intents, lifecycle stages, QA scenarios, affected flows, required evidence, and draft paths. It carries the decision content of the full report at a fraction of the context cost. The shape is a documented, versioned contract: [agent format contract](docs/agent-format.md). To make agents run this themselves, run `qamap init --agent` once: it adds a Pre-PR QA section to `AGENTS.md` and installs the packaged skill ([skills/qamap-pr-qa/SKILL.md](skills/qamap-pr-qa/SKILL.md)) into `.claude/skills/`. Details: [agent skill guide](docs/agent-skill.md).

## Why QAMap

- **Intent and lifecycle before runner choice.** QAMap groups behavior-bearing commits, connects them to diff symbols, and proposes success, failure, boundary, and state-transition QA before selecting an automation adapter.
- **Judgment first, generation second.** Deciding *what deserves testing* for a given change is the missing layer. QAMap makes that judgment statically, deterministically, and locally for free.
- **The repo remembers.** Team QA knowledge lives in `.qamap/manifest.yaml`, reviewed once and reused on every PR — instead of re-prompting an agent each session.
- **Honest output.** Drafts state what blocks them from being trusted; changed endpoints are observed, never mocked away; generated specs never assert what cannot pass. Configuration, docs, generated artifacts, and changed tests stay in verification mode instead of fabricating a product-journey E2E.

Positioning against recorders, LLM test generation, and impact-analysis tools: [where QAMap fits](docs/adoption.md#where-qamap-fits).

<details>
<summary>한국어 소개</summary>

QAMap는 PR을 리뷰하기 전에 로컬에서 실행하는 zero-LLM QA 설계 CLI입니다.

PR 커밋 의도와 diff, repo 구조를 읽고 변경 의도, 기능 생명주기, 정상·실패·경계·상태 전환 QA, 부족한 fixture/selector/assertion 근거를 정리합니다. 그 다음 기존 테스트 환경에 맞춰 Playwright, Maestro 또는 수동 체크리스트 초안을 제시합니다. 클라우드나 LLM 토큰을 쓰지 않습니다.

```sh
pnpm dlx @ivorycanvas/qamap qa . --base origin/main --head HEAD
```

에이전트에게 넘길 때는 `--format agent`를 붙이면 같은 판단 내용을 압축된 JSON으로 받을 수 있어, 매 세션 repo 탐색에 토큰을 반복해서 쓰지 않아도 됩니다.

목표는 거대한 QA 플랫폼이 아니라, 유지보수자가 매번 에이전트에게 프로젝트 맥락과 검증 방법을 다시 설명하느라 쓰는 시간을 줄여주는 작고 선명한 도구입니다. Manifest 없이 바로 시작하고, 반복해서 틀리는 추천은 `.qamap/manifest.yaml`에 팀의 QA 언어로 보정해 향후 PR 추천을 개선합니다.

</details>

## Documentation

| Guide | What it covers |
| --- | --- |
| [Command reference](docs/commands.md) | Every command, outputs, and the E2E draft pipeline in depth |
| [Quick start walkthrough](docs/quickstart-demo.md) | The 30-second demo, step by step |
| [Verification manifest](docs/manifest.md) | Repo-local QA memory: schema, init, explain, repair loop |
| [Adoption & rollout](docs/adoption.md) | First run to CI gate, plus positioning |
| [Agent skill guide](docs/agent-skill.md) | Using QAMap from coding-agent workflows |
| [Agent format contract](docs/agent-format.md) | The versioned `--format agent` JSON shape and stability policy |
| [Repository guardrails](docs/guardrails.md) | The optional static scanner and its rules |
| [Configuration](docs/configuration.md) | `qamap.config.json` policy options |
| [GitHub Action](docs/github-action.md) | PR annotations, summaries, and comments in CI |
| [Benchmarking](docs/benchmarking.md) | Scoring output quality against pinned repositories |
| [Architecture](docs/architecture.md) | Behavior Graph, adapter boundaries, execution safety, and migration order |
| [Roadmap](docs/roadmap.md) | Where this is going |

## Project Status

QAMap is early and pre-`1.0`; the public API may change. Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). QAMap does not replace review, tests, or security tooling; it removes the blank-page work that makes teams skip good verification. AI-assisted PRs are an important use case, not a requirement.
