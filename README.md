# QAMap

[![CI](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ivorycanvas/qamap.svg)](https://www.npmjs.com/package/@ivorycanvas/qamap)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![QAMap: local PR QA design from commits and diffs](docs/assets/qamap-cover.png)

**Find what a PR needs to prove before merge.**

QAMap is a **local-first, zero-LLM QA router**. It reads commits, code diffs, repository structure, selectors, and existing tests to infer changed behavior and route evidence-backed QA scenarios.

**It does not begin with "use Playwright" or "add a fixture."** It first explains what changed, what should be verified, why each scenario was selected, and whether deterministic automation can compile it safely.

No cloud. No source upload. No LLM token.

```txt
commit + diff -> behavior lifecycle -> QA routing -> QA trace -> optional automation
                 trigger / state /      required       why this     Playwright
                 outcome                recommended    scenario     Maestro
                                        review-only    exists       manual
```

## See It Work

This is the current CLI running against the committed, manifest-free React state-transition fixture. The recording shows real deterministic output: QAMap identifies the change, exposes the reasoning path, and writes the Playwright draft shown at the end. It does **not** launch the fixture application or claim that product QA passed.

![QAMap reads a PR diff, routes QA scenarios, and reports E2E automation readiness](docs/assets/qamap-30s-demo.gif)

_Recorded from the current source against `test/benchmarks/web-react-record-pinning`; no hand-written or simulated result blocks._

## Quick Start

Requires Node.js 20 or newer. Run one read-only command from a feature branch:

```sh
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```

The base branch is inferred in standard repositories, so this is usually enough:

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

A manifest and test runner are **not required** for the first run.

`qa` performs static analysis and draft mapping only. It does not launch the target application or claim that product QA passed.

For repeat use in a JavaScript repository, install QAMap once and add short package scripts:

```sh
pnpm add -D @ivorycanvas/qamap
pnpm exec qamap init --scripts
```

After that, the everyday workflow is deliberately small:

```sh
pnpm qa          # committed changes on the current branch
pnpm qa:local    # also include uncommitted local changes
pnpm qa:e2e      # preview an E2E draft without writing files
```

`init --scripts` detects npm, pnpm, Yarn, or Bun, preserves unrelated scripts, and never replaces a name collision unless `--force` is explicit. Non-JavaScript repositories keep using the universal `qamap qa` command directly.

## What You Get

QAMap keeps QA selection and test generation as two separate decisions:

| Decision | Meaning |
| --- | --- |
| **Behavior inference** | Connect commit intent and changed symbols into a trigger, condition, state change, side effect, and observable outcome. |
| **Scenario routing** | Mark each scenario `required`, `recommended`, or `review-only`, with the exact diff hunk or commit that supports it. |
| **QA reasoning trace** | Give every scenario a stable ID that connects diff line -> affected lifecycle -> risk -> routing decision -> optional draft, while keeping execution explicitly `not-run`. |
| **Automation receipt** | Report whether the selected scenario is fully, partially, or not mapped into a draft, including the missing selector, fixture, entrypoint, or assertion evidence. Machine output keeps the compatible values `compiled`, `partial`, and `not-compiled`; none of them means a test ran or passed. |

Trimmed real output from the same demo:

```txt
Product QA execution: not run; static analysis and draft mapping only
Change intent: Pin a workspace record and show it first [high]
Verify before merge: does the changed flow produce visible text
  "Pinned record appears first"?
Scenario routing: 1 required, 1 recommended, 0 review-only
E2E draft mapping: 1 fully mapped, 1 not mapped; no tests executed
Reasoning trace: 2/2 scenarios traced

QA reasoning trace: trace:ab8f9b137d27 [traceable]
  Diff evidence: src/pages/records.tsx:15, symbol setPinned
  Risk: the changed behavior may not reach its intended observable outcome
  QA scenario: [required] Pin a workspace record and show it first
  Expected proof: visible text "Pinned record appears first" appears
  Optional artifact: tests/e2e/pin-a-workspace-record-and-show-it-first.spec.ts
                     fully mapped (not executed), steps 1/1, assertions 1/1
  Execution: not run
```

The resulting primary Playwright path is repository-backed rather than a generic body-visible smoke test:

```ts
await page.goto("/records");
await page.getByTestId("pin-record").click();
await expect(page.getByText("Pinned record appears first")).toBeVisible();
```

This distinction is deliberate: a scenario can deserve QA without QAMap pretending it already has enough evidence to generate a trustworthy E2E test. Static draft mapping answers whether QAMap could express the scenario; only a separate, explicit execution can produce pass or fail evidence.

## From Judgment to E2E

After a reviewer accepts a routed scenario, preview an automation draft:

```sh
npx --yes @ivorycanvas/qamap@latest e2e draft . --base origin/main --head HEAD --dry-run
```

QAMap uses the repository's existing setup when possible. Playwright, Maestro, or manual output is an adapter chosen **after** QA routing, not a framework recommendation made just because a web or mobile project was detected.

Generated drafts remain review-only until their sources, selectors, fixtures, assertions, and validation command are confirmed.

## Optional Team Memory

First-run inference works without configuration. If QAMap repeatedly uses the wrong product language or misses a durable flow, initialize repo-local QA memory:

```sh
npx --yes @ivorycanvas/qamap@latest manifest init
```

Review and commit `.qamap/manifest.yaml`. Future PRs reuse the team's domains, flows, checks, routes, selectors, and validation policy instead of rebuilding that context in every agent session.

## For Coding Agents

Give an agent the same decisions in a versioned JSON contract under 4 KB:

```sh
npx --yes @ivorycanvas/qamap@latest qa --format agent
```

Install the portable project skill so compatible agents can call QAMap before review:

```sh
npx --yes skills add IvoryCanvas/QAMap --skill qamap-pr-qa
```

Or run `qamap init --agent` to add the repo instructions and packaged skill. See the [agent format contract](docs/agent-format.md) and [agent skill guide](docs/agent-skill.md).

## Why QAMap

- **Evidence over guesses.** Every routed scenario carries commit or line-level diff provenance.
- **Traceable consequences.** The optional test draft points back to the same stable trace that explains the changed behavior and risk.
- **Judgment before generation.** QAMap decides what deserves verification before choosing a runner.
- **Honest automation.** Missing evidence lowers readiness instead of becoming a fake smoke test or guaranteed-failing assertion.
- **Local and deterministic.** The same repository state produces the same result without uploading code or spending tokens.
- **Manifest optional.** Start immediately, then promote reviewed team knowledge only when it improves future PRs.

Positioning against recorders, LLM test generation, and impact-analysis tools: [where QAMap fits](docs/adoption.md#where-qamap-fits).

<details>
<summary>한국어 소개</summary>

QAMap은 PR 변경사항을 로컬에서 읽고, 이번 변경이 무엇을 증명해야 하는지 정리하는 zero-LLM QA 라우터입니다.

커밋과 diff에서 변경 의도와 기능 흐름을 추적하고, 정상·실패·경계·상태 전환 시나리오를 `required`, `recommended`, `review-only`로 구분합니다. 각 판단에는 실제 diff 근거가 붙으며, E2E로 안전하게 옮길 수 있는지 여부도 별도로 알려줍니다.

Playwright나 Maestro를 먼저 권하는 것이 목적이 아닙니다. **무엇을 테스트해야 하는지 먼저 판단하고**, 충분한 selector, fixture, assertion, entrypoint가 있을 때만 자동화 초안으로 연결하는 것이 목표입니다.

클라우드나 LLM 토큰을 사용하지 않으며 manifest 없이 시작할 수 있습니다. 반복해서 틀리는 추천은 `.qamap/manifest.yaml`에 팀의 QA 언어로 보정해 이후 PR에서 재사용합니다.

</details>

## Documentation

| Guide | What it covers |
| --- | --- |
| [Quick start walkthrough](docs/quickstart-demo.md) | First run and output walkthrough |
| [Command reference](docs/commands.md) | Commands, formats, and E2E draft pipeline |
| [Verification manifest](docs/manifest.md) | Repo-local QA memory and correction loop |
| [Adoption & rollout](docs/adoption.md) | Local use, CI adoption, and positioning |
| [Agent integration](docs/agent-skill.md) | Skill installation and agent workflow |
| [Benchmarking](docs/benchmarking.md) | Pinned cross-framework regression cases |
| [Architecture](docs/architecture.md) | Behavior graph, routing, adapters, and safety |
| [Roadmap](docs/roadmap.md) | Current limits and planned direction |

## Project Status

QAMap is early and pre-`1.0`; the public API may change. Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

QAMap does not replace human review, executable tests, or security tooling. It reduces the repeated blank-page work between receiving a PR and deciding what that PR must prove.
