# CodeWard

[![CI](https://github.com/IvoryCanvas/codeward/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/codeward/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Save setup time before AI agents touch your codebase.**

CodeWard is a no-token preflight and workspace hygiene layer for AI coding agents. It checks a repository before agent work starts, then helps reviewers verify whether AI-assisted changes are safe and reviewable before merge.

It is built around a simple idea: teams should not spend the first 30 minutes of every AI coding session re-explaining project context, safe commands, missing guardrails, and review expectations. CodeWard turns those repeated setup checks into one CLI and GitHub Action.

It is built for teams using Codex, Claude Code, Cursor, GitHub Copilot coding agent, MCP-powered tools, or any workflow where an agent can read, edit, test, commit, or open pull requests.

CodeWard is intentionally small:

- time-saving: it surfaces missing context, risky settings, and validation gaps before agent work becomes review churn
- static by default: it does not execute scanned project code
- no-token by default: it does not call an LLM API
- verification-focused: it tells reviewers what evidence is missing, not how to style code
- domain-aware E2E drafting: it turns branch changes into flow language, draft specs, readiness summaries, and action items
- ecosystem-aware: it suggests validation commands for JavaScript/TypeScript, Python, Go, Rust, Gradle, and Maven projects
- CI-friendly: text, JSON, Markdown, and SARIF output are supported
- explainable: every finding includes a concrete fix

<details>
<summary>한국어 소개</summary>

CodeWard는 AI 코딩 에이전트에게 레포지토리를 맡기기 전에 빠르게 실행하는 사전 점검 CLI입니다.

누락된 에이전트 지침, 위험한 MCP 설정, 커밋된 로컬 환경 파일, 위험한 자동화 스크립트, 과도한 GitHub Actions 권한, 약한 검증 신호를 찾아냅니다.

목표는 거대한 보안 플랫폼이 아니라, 유지보수자가 매번 에이전트에게 프로젝트 맥락과 안전한 검증 방법을 설명하느라 쓰는 시간을 줄여주는 작고 선명한 도구입니다.

</details>

## Why It Matters

AI agents are becoming normal contributors to software projects. They can research a repository, edit files, run commands, and prepare pull requests. The hidden cost is setup time: maintainers repeatedly explain project rules, safe validation commands, risky files, and review expectations before the useful work can begin.

The risky failure mode is not always broken code. It is code that looks plausible, merged through a repository with missing context, broad permissions, unsafe scripts, or weak validation.

CodeWard gives maintainers a quick first line of defense:

- Is there clear guidance for agents?
- Are MCP configs safe enough to inspect?
- Are committed agent settings or hooks able to run risky commands?
- Are API endpoints documented only in prose, without a machine-readable contract source?
- Did a local `.env` file slip into the repo?
- Can package scripts publish, push, merge, or run risky shell pipelines?
- Are workflows using broad permissions or risky triggers?
- Is there a real test command for agent-made changes?
- Does an AI-assisted change explain its intent, risk, and verification evidence?

## Quick Demo

```sh
codeward verify . --base origin/main --head HEAD --pr-body-file pr-body.md
```

Example output from an AI-assisted PR:

```txt
CodeWard Verify
Readiness: 6/12 (needs-work)
Changed files: 5
New findings: 0
Changed risky files: 0

Verification gates:
- WARN Validation commands: package has typecheck/lint/build, but no test command
- FAIL Changed test coverage: source changed without changed tests
- WARN Intent capture: PR template exists, but no intent-rich PR body was detected
- FAIL Risk explanation: domain config changed without risk or rollback context

Suggested domain tests:
- Campaign workflow regression
- User-facing UI states
- Domain configuration and variants

Suggested commands:
- pnpm run typecheck
- pnpm run lint
- pnpm run build
```

For a repository baseline before broad agent use, run:

```sh
codeward scan .
```

```txt
CodeWard 0.1.0
Findings: 6 (high: 3, medium: 2, low: 1, info: 0)

HIGH
- CW003 Suspicious agent instruction text (AGENTS.md)
  Fix: Remove untrusted instruction text or move examples into clearly fenced documentation.
```

## Install

The package metadata is ready for the first npm release, but the public package should wait until release validation covers representative web, mobile, API/service, monorepo, and test-light repositories. See [0.1.0 release validation](docs/release-validation.md) and [E2E output examples](docs/e2e-output-examples.md).

```sh
pnpm dlx @ivorycanvas/codeward scan .
```

Until the npm package is published, run CodeWard from source:

```sh
git clone https://github.com/IvoryCanvas/codeward.git
cd codeward
pnpm install
pnpm build
node dist/cli.js scan /path/to/repo
```

## Commands

| Command | Purpose |
| --- | --- |
| `codeward scan .` | Scan the current repository and print a text report. |
| `codeward scan . --fail-on medium` | Exit with code `1` when findings at or above the threshold exist. |
| `codeward scan . --json` | Print machine-readable JSON for custom automation. |
| `codeward scan . --format sarif --output codeward.sarif` | Generate SARIF for code scanning integrations. |
| `codeward report . --output CODEWARD_REPORT.md` | Generate a Markdown report for PRs or audits. |
| `codeward doctor . --format markdown` | Summarize whether the repo is ready for AI-assisted work. |
| `codeward review . --base origin/main --head HEAD --format markdown` | Show new findings and changed risky files introduced by a branch. |
| `codeward verify . --base origin/main --head HEAD --pr-body-file pr-body.md` | Combine review findings, readiness scoring, domain tests, and next actions. |
| `codeward eval . --base origin/main --head HEAD --pr-body-file pr-body.md` | Score change readiness across intent, risk, tests, and review size. |
| `codeward github-action . --mode review --base origin/main --head HEAD` | Generate GitHub Action annotations, step summary, and PR comment body. |
| `codeward test-plan . --base origin/main --head HEAD --include-working-tree` | Suggest domain test scenarios for changed files. |
| `codeward e2e plan . --base origin/main --head HEAD` | Suggest E2E runner, bootstrap steps, user flows, coverage targets, existing test evidence, and missing testability hooks for changed files. |
| `codeward e2e plan . --base origin/main --head HEAD --record-history` | Save a compact local run snapshot under `.codeward/runs/` while keeping JSON/Markdown output usable. |
| `codeward e2e draft . --base origin/main --head HEAD` | Generate Maestro or Playwright E2E drafts with flow language, readiness summaries, and action items. |
| `codeward flows init .` | Create a starter `.codeward/flows.yml` for team-approved core flow definitions. |
| `codeward flows suggest . --base origin/main --head HEAD` | Generate suggested `.codeward/flows.yml` entries with commit-readiness guidance from changed files and E2E plan context. |
| `codeward domains init .` | Create a starter `.codeward/domains.yml` for shared product/domain language. |
| `codeward domains suggest . --base origin/main --head HEAD` | Generate suggested `.codeward/domains.yml` entries with commit-readiness guidance from changed files and inferred product language. |
| `codeward history init .` | Create local CodeWard history directories and protect generated run history with `.gitignore`. |
| `codeward doctor services/offer --workspace-root .` | Scan a monorepo package while using root guardrails. |
| `codeward context . --write AGENTS.md` | Generate starter agent instructions for the repo. |
| `codeward init .` | Create a starter `codeward.config.json`. |

For monorepos, pass `--workspace-root` when scanning a package. Package-local checks still use the package directory, while repo-level guardrails such as `AGENTS.md`, `.github/workflows`, `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md` are read from the workspace root.

`codeward review` compares a branch against a base ref for PR-style workflows. It separates newly introduced findings from risky files that already had findings on the base branch but were modified again, which helps reviewers notice when a PR touches known-dangerous surfaces such as committed `.env` files, MCP configs, or release scripts.

`codeward verify` is the easiest PR-facing command. It combines `review`, `test-plan`, and `eval` into one report with review findings, readiness gates, suggested domain tests, suggested commands, and next actions.

`codeward test-plan` turns changed file paths into a review-ready domain test checklist. It also discovers common validation commands from `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, Gradle files, and Maven `pom.xml`. Add `--include-working-tree` for local, uncommitted changes while iterating.

`codeward e2e plan` turns changed file paths into a first-pass E2E testing plan. It detects whether a project looks like Expo/React Native, web, or an API/service repo, recommends a runner such as Maestro or Playwright, starts backend services with an API contract checklist, suggests bootstrap steps for repos with little or no test history, suggests domain language for the changed behavior, suggests candidate user flows, adds coverage targets, compares those targets with existing test-suite evidence when tests are present, flags API-dependent flows that need mock or fixture responses, and points out missing stable selectors such as `testID` or `data-testid` before anyone starts writing tests from a blank file.

The plan also includes an execution profile: detected start command, test command, Playwright `baseURL`, mobile app id, runner config files, env fixture files, confidence, and blockers. This keeps generated E2E drafts honest about whether they are runnable candidates or still review-only scaffolds.

When run at a monorepo root, the E2E plan also reports changed app/package targets. This helps a maintainer move from a broad workspace diff to scoped commands such as `codeward e2e plan services/offer --workspace-root . --base origin/main --head HEAD`, where package-specific runner detection and flow naming are usually sharper.

Each candidate flow also includes a flow language brief: actor, trigger, goal, success signal, reviewer question, and edge cases. The brief keeps generated tests tied to product behavior rather than only changed file names.

The bootstrap section answers what must happen before generated drafts can be treated as real regression coverage. For example, a testless web project can get required steps for Playwright setup, first draft generation, stable selector work, fixture/mock data, and missing validation evidence, plus recommended steps for `.codeward/domains.yml`, `.codeward/flows.yml`, and local history recording.

The domain language section is intentionally less implementation-oriented than the raw file list. For example, changes under `src/features/in-app-purchase/` become terms such as `In App Purchase` and scenarios such as `In App Purchase primary journey`. When `.codeward/domains.yml` exists, declared product terms and routes receive higher confidence. When `.codeward/flows.yml` exists, team-approved flow names appear as preferred scenario names.

If `.codeward/domains.yml` exists, `codeward e2e plan` also matches changed files against shared product or domain language:

```yaml
domains:
  - id: billing
    name: Billing
    aliases:
      - checkout
      - subscription
    files:
      - src/features/billing/**
    routes:
      - /billing
    scenarios:
      - title: Billing primary journey
        checks:
          - Start from the normal billing entry point.
          - Complete the primary billing action with realistic data.
```

Run `codeward domains init .` to create a starter domain manifest. Run `codeward domains suggest . --base origin/main --head HEAD` when you want CodeWard to draft manifest entries from the current branch and classify each candidate as `commit-candidate`, `needs-review`, or `low-signal`. Use domains for naming and route hints; use core flows when the team wants to define a durable verification journey.

If `.codeward/flows.yml` exists, `codeward e2e plan` also matches changed files against team-approved core flows. This lets maintainers encode the product or domain flows humans already care about:

```yaml
flows:
  - id: checkout-purchase
    name: Checkout purchase
    priority: critical
    domains:
      - checkout
    files:
      - src/pages/checkout/**
      - src/features/checkout/**
    routes:
      - /checkout
    checks:
      - Complete checkout with a valid payment method.
      - Verify declined payment recovery.
```

Run `codeward flows init .` to create a starter manifest. Run `codeward flows suggest . --base origin/main --head HEAD` when you want CodeWard to draft flow entries from changed files, inferred domain language, routes, and E2E checks, then classify which entries are close enough to review as shared policy. Unlike generated run history, `.codeward/flows.yml` is meant to be reviewed and committed when those flow definitions should become team policy.

Pass `--record-history` when you want CodeWard to keep a compact local snapshot of an E2E plan under `.codeward/runs/`. CodeWard automatically protects `.codeward/runs/`, `.codeward/cache/`, `.codeward/tmp/`, and `.codeward/*.local.json` with `.gitignore` so generated history stays local by default. Shared project policy, such as `codeward.config.json`, `.codeward/domains.yml`, and `.codeward/flows.yml`, remains commit-friendly.

`codeward e2e draft` writes draft files from that plan. Expo and React Native projects get Maestro YAML flows under `.maestro/` by default, web projects get Playwright specs under `tests/e2e/`, and API/service projects get contract checklist drafts until a project-specific API runner is documented. Drafts infer stable selectors such as `testID`, `accessibilityLabel`, `data-testid`, `aria-label`, and visible text where possible. They also carry fixture/mock readiness notes so client flows can be tested with deterministic data before a real server path exists. They keep `TODO` placeholders where selectors, fixtures, assertions, or project-specific launch details are still needed, and existing files are not overwritten unless `--force` is passed.

The draft result is meant to be useful as a PR artifact, not only as generated files. Markdown and JSON output include:

- `languageBrief`: actor, trigger, goal, success signal, reviewer question, and edge cases for each draft file
- `promotionStatus`: whether the draft is a `commit-candidate`, `needs-review`, or `low-signal`
- `runnableStatus`: whether the draft is a `runnable-candidate`, `near-runnable`, or `review-only`
- `actionItems`: required and recommended follow-up work, grouped by assertion, fixture, selector, runner, validation, and manifest
- `actionSummary`: total required/recommended action counts, ready file count, and the most common action categories

See [docs/e2e-output-examples.md](docs/e2e-output-examples.md) for compact examples of web, mobile, API/service, test-light, and monorepo output.

Generated Playwright drafts use the flow language as `test.step()` names so the file reads like the user journey it protects:

```ts
await test.step("Open route /checkout.", async () => {
  await page.goto("/checkout");
});

await test.step("Complete checkout with a valid payment method.", async () => {
  // TODO: Complete checkout with a valid payment method.
  await page.getByTestId("checkout-submit").click();
});
```

`codeward history init` prepares that local storage explicitly without running an analysis. It creates `.codeward/runs/`, `.codeward/cache/`, and `.codeward/tmp/`, then adds the generated-history ignore patterns to `.gitignore` idempotently.

`codeward eval` scores whether a branch has enough validation evidence, changed-test coverage, intent capture, risk explanation, domain verification paths, and reviewable size. In GitHub Actions, CodeWard can read the pull request body from the event payload and append the evaluation to the PR comment.

## What It Checks

The first release focuses on high-signal checks that are useful across many repositories.

| Rule | Severity | What it catches |
| --- | --- | --- |
| `CW001` | medium | Missing agent instruction files. |
| `CW002` | medium | Conflicting agent guidance. |
| `CW003` | high | Suspicious instruction text that can misdirect agents. |
| `CW004` | medium/high | Risky MCP command configuration. |
| `CW005` | high | Secret-like values embedded in MCP config. |
| `CW006` | medium | Missing or placeholder test scripts. |
| `CW007` | low | Missing GitHub Actions workflows. |
| `CW008` | high | Committed local environment files. |
| `CW009` | high | Package scripts that can publish, push, merge, or run unsafe shell pipelines. |
| `CW010` | medium | Broad workflow permissions or risky workflow triggers. |
| `CW011` | low | Missing community health files. |
| `CW012` | medium/high | Risky committed agent settings, hooks, or broad shell permissions. |
| `CW013` | low | API endpoints documented only in prose without a contract source. |

See [docs/rules.md](docs/rules.md) for the rule catalog.
See [docs/ecosystem.md](docs/ecosystem.md) for the agent ecosystem surfaces CodeWard tracks.
See [docs/api-contracts.md](docs/api-contracts.md) for the API contract source-of-truth check.
See [docs/verify.md](docs/verify.md) for the combined PR verification report.
See [docs/eval.md](docs/eval.md) for the change readiness evaluation.

## Configuration

Use `codeward.config.json` or `.codeward.json` to tune repository policy.

```json
{
  "$schema": "https://raw.githubusercontent.com/IvoryCanvas/codeward/main/schema/codeward.schema.json",
  "failOn": "high",
  "ignoreRules": ["CW011"],
  "maxFiles": 2000,
  "validationCommands": ["make test", "make lint"],
  "severity": {
    "CW007": "info"
  }
}
```

See [docs/configuration.md](docs/configuration.md) for details.

## GitHub Actions

CodeWard can run as a lightweight PR check with annotations, a step summary, and a sticky PR comment:

```yaml
name: CodeWard

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  codeward:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: IvoryCanvas/codeward@main
        with:
          mode: review
          base: ${{ github.event.pull_request.base.sha }}
          head: HEAD
          fail-on: high
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

The PR comment can include suggested domain tests and a verification readiness evaluation for changed files. For rollout guidance, see [docs/adoption.md](docs/adoption.md) and [docs/github-action.md](docs/github-action.md).

## Where CodeWard Fits

CodeWard is not trying to replace the larger security ecosystem.

| Tool category | Typical focus | CodeWard focus |
| --- | --- | --- |
| OpenSSF Scorecard | Broad open source security posture. | AI-agent readiness at the repository boundary. |
| Secret scanning | Exposed credentials in code or history. | Secret-like values plus unsafe agent, workflow, and script context. |
| MCP security scanners | Deep analysis of MCP servers, tools, prompts, and skills. | Static repo checks without executing untrusted MCP servers. |
| General linters | Code style, correctness, or framework rules. | Guardrails that affect AI-assisted development safety. |

## Roadmap

CodeWard starts as a local CLI and should stay small enough that maintainers can understand every finding.

Near-term priorities:

- finish the [0.1.0 release validation](docs/release-validation.md) checklist across representative web, mobile, API/service, monorepo, and test-light repositories
- publish a versioned GitHub Action release tag after the first public package is ready
- improve branch-aware `review` changed-line locations
- improve generated domain test plans with framework-specific test skeletons
- refine generated Maestro and Playwright drafts with stronger app-specific selector discovery
- expand `eval` into repository-specific verification manifests and taste rubrics
- continue expanding agent surface detection across Codex, Claude Code, Cursor, Copilot, Gemini, and related tools
- generate rule documentation from scanner metadata

See [docs/roadmap.md](docs/roadmap.md) for more detail.

## Project Status

CodeWard is early and pre-`1.0`. The public API may change, but the project is intended to stay readable, practical, and useful in real repositories from the first release.

## Contributing

Issues and pull requests are welcome. Maintainer permissions stay with IvoryCanvas members, and `main` is protected so external contributors cannot push or merge directly.

Good first contributions include new agent instruction file detectors, better SARIF locations, sample risky repository fixtures, and documentation improvements.

See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [SECURITY.md](SECURITY.md).

## Philosophy

CodeWard does not replace code review, tests, threat modeling, branch protection, or security review. It is a small preflight check that helps teams notice repo-level AI risks early enough to do something about them.
