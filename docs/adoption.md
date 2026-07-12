# Adopting QAMap

QAMap works best when teams treat it as the local QA design pass for any PR, not as a replacement for review or security tooling.

## First Run

Start with the PR QA draft on a changed branch — no manifest, no config:

```sh
pnpm dlx @ivorycanvas/qamap qa . --base origin/main --head HEAD
```

For coding agents, request the compact machine-readable summary instead:

```sh
pnpm dlx @ivorycanvas/qamap qa . --base origin/main --head HEAD --format agent
```

First confirm the inferred commit intent, lifecycle, confidence, and runner-independent QA scenarios. When that judgment looks useful, preview and then write the adapter-specific draft files:

```sh
pnpm dlx @ivorycanvas/qamap e2e draft . --base origin/main --head HEAD --dry-run
pnpm dlx @ivorycanvas/qamap e2e draft . --base origin/main --head HEAD
```

For a combined PR verification report with readiness gates, add `verify`:

```sh
pnpm dlx @ivorycanvas/qamap verify . --base origin/main --head HEAD --pr-body-file pr-body.md
```

When developing QAMap itself from source:

```sh
git clone https://github.com/IvoryCanvas/qamap.git
cd qamap
pnpm install
pnpm build
node dist/cli.js scan /path/to/repo
```

## Build A Verification Base

QAMap works best when the repository becomes the source of truth for verification language, not when every PR starts with a fresh prompt to an external agent.

Start with generated output, then promote only durable knowledge:

- keep generated run history local with `qamap history init .` and `--record-history`
- commit `.qamap/domains.yml` when the team agrees on product/domain names
- commit `.qamap/flows.yml` when the team agrees a journey is important enough to protect repeatedly
- keep draft E2E files reviewable until selectors, fixtures, assertions, and runner config make them real regression coverage

This gives teams a small lifecycle: observe a branch, review the proposed language and flows, promote the stable parts, then let the next branch reuse that context without another LLM call.

## Recommended Rollout

Start advisory, then tighten the gate once the findings are understood.

| Phase | Command | Goal |
| --- | --- | --- |
| 1. PR QA design | `qamap qa . --base origin/main --head HEAD` | Get commit-backed intent, behavior lifecycle, QA scenarios, affected flows, and missing evidence. |
| 2. Agent handoff | `qamap qa . --base origin/main --head HEAD --format agent` | Give coding agents the same intent and scenario evidence as compact JSON instead of a long report. |
| 3. E2E preview | `qamap e2e draft . --base origin/main --head HEAD --dry-run` | Preview generated draft paths, readiness, action items, and blockers before writing files. |
| 4. E2E apply | `qamap e2e draft . --base origin/main --head HEAD` | Write draft files once the preview looks useful enough to review. |
| 5. QA memory | `qamap manifest init .` (from the default branch) | Create `.qamap/manifest.yaml` so future PR recommendations reuse reviewed team QA language. |
| 6. Verify | `qamap verify . --base origin/main --head HEAD --pr-body-file pr-body.md` | Combine review findings, readiness score, suggested domain tests, and next actions. |
| 7. PR Action | `uses: IvoryCanvas/qamap@main` | Add annotations, a step summary, a test plan, eval, and a sticky PR comment. |
| 8. Guardrail baseline | `qamap scan .` | See repo-level AI agent risks (guardrails layer) without blocking work. |
| 9. High-risk gate | `qamap scan . --fail-on high` | Block obvious risks such as committed env files or unsafe scripts. |
| 10. Medium-risk gate | `qamap scan . --fail-on medium` | Require stronger agent guidance, tests, and workflow permissions. |

`doctor`, `review`, `test-plan`, `eval`, and `report` remain available for teams that want the individual reports behind `verify`.

## Monorepos

When scanning a package inside a larger workspace, pass the workspace root so QAMap can separate package-local risks from repository guardrails:

```sh
qamap doctor services/listing --workspace-root . --format markdown
qamap scan services/listing --workspace-root . --json
```

With `--workspace-root`, QAMap reads package-local files such as `package.json`, `.env.*`, and MCP config from the package path. It reads repo-level guardrails such as `AGENTS.md`, `.github/workflows`, `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md` from the workspace root.

## What To Fix First

Fix high-severity findings before letting an agent work broadly in the repo.

1. Remove committed local environment files and rotate any exposed secrets.
2. Move publish, push, merge, and destructive scripts out of normal agent workflows.
3. Remove suspicious instruction text or fence it clearly as an example.
4. Narrow GitHub Actions permissions.
5. Add a real test command that agents and reviewers can run consistently.

## CI Guidance

For early rollout, fail only on high-severity findings:

```yaml
name: QAMap

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  qamap:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: IvoryCanvas/qamap@main
        with:
          mode: review
          base: ${{ github.event.pull_request.base.sha }}
          head: HEAD
          fail-on: high
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

When the repository is stable, consider `--fail-on medium`.

For all inputs, see [github-action.md](github-action.md).

## Change Readiness Eval

For the most useful PR-facing report, start with `verify`:

```sh
qamap verify . --base origin/main --head HEAD --pr-body-file pr-body.md --format markdown
```

Use `qamap eval` when an AI-assisted branch looks plausible but reviewers need a faster way to decide what still needs human attention:

```sh
qamap eval . --base origin/main --head HEAD --pr-body-file pr-body.md --format markdown
```

The eval report scores validation commands, changed-test coverage, intent capture, risk explanation, generated domain test scenarios, and review size. A low score does not mean the code is wrong; it means the branch is expensive or risky to verify.

## Interpreting Findings

QAMap findings are meant to be explainable. Each finding includes:

- a rule id such as `QM009`
- severity
- file path when available
- message
- recommendation
- short evidence when safe to print

Prefer severity overrides over broad ignores when a rule is useful but too noisy for a specific repository.

```json
{
  "severity": {
    "QM007": "info"
  }
}
```

Use `ignoreRules` only for findings that the team intentionally accepts.

## Where QAMap Fits

On the QA side, QAMap starts one step earlier than test-writing tools — it decides what a PR must prove before anyone records, generates, or writes a test:

| Tool category | Typical focus | QAMap focus |
| --- | --- | --- |
| Test recorders and studios | Turning a known flow into a script by watching you run it. | Deciding which flow a PR affects and what evidence is missing, before recording starts. |
| LLM test generation | Spending model tokens to write test code from source. | Free, deterministic PR-to-QA mapping; drafts are starter scaffolds an agent or human finishes. |
| Re-prompting an agent per PR | Re-deriving repo QA context in every session. | Repo-owned QA memory (`.qamap/manifest.yaml`) plus a compact `--format agent` handoff. |
| Change-impact test selection | Choosing which existing unit/CI tests to run. | Naming the user-facing flow and E2E/checklist work that should exist at all. |

On the guardrails side, QAMap is not trying to replace the larger security ecosystem:

| Tool category | Typical focus | QAMap focus |
| --- | --- | --- |
| OpenSSF Scorecard | Broad open source security posture. | AI-agent readiness at the repository boundary. |
| Secret scanning | Exposed credentials in code or history. | Secret-like values plus unsafe agent, workflow, and script context. |
| MCP security scanners | Deep analysis of MCP servers, tools, prompts, and skills. | Static repo checks without executing untrusted MCP servers. |
| General linters | Code style, correctness, or framework rules. | Guardrails that affect AI-assisted development safety. |


## Why This Is Different From Recorders And Generators

Recorders such as browser or mobile test studios are useful when you already know the flow to exercise. QAMap starts one step earlier: it asks what the PR commits intended to change, which lifecycle and risk axes follow from the diff, which repo-owned QA memory applies, and what test artifact should exist before merge.

A good QAMap result should answer:

- which commit-backed behavior intent changed, with confidence and review requirements
- which trigger, condition, action, state change, side effect, and observable outcome form its lifecycle
- which primary, failure, boundary, and state-transition QA scenarios follow from that lifecycle
- which manifest domain, flow, and checks caused the recommendation
- which draft test file was generated or previewed
- which success, failure, edge, contract, or visual cases the draft covers
- which selector, fixture, auth, runner, or validation gaps still block trusted regression evidence
- which manifest path to edit when the recommendation is wrong

That is the product bet: one human correction to the repo-local manifest should improve future PR recommendations without another LLM prompt.

You do not need a manifest to start. Without one, QAMap uses commit subjects and bodies, the PR diff, package signals, routes, selectors, runner config, and existing tests. Add a manifest only when the team wants durable QA language that improves future recommendations.

## What QAMap Is For

QAMap is intentionally small:

- time-saving: it surfaces missing context, risky settings, and validation gaps before agent work becomes review churn
- static by default: it does not execute scanned project code
- no-token by default: it does not call an LLM API
- verification-focused: it tells reviewers what evidence is missing, not how to style code
- PR QA skill output: `qamap qa` turns a branch into change intent, behavior lifecycle, QA scenarios, affected-flow evidence, optional automation drafts, and a copyable checklist
- packaged agent skill: `skills/qamap-pr-qa/SKILL.md` gives coding agents a compact PR QA workflow for running QAMap before handoff
- intent-aware E2E drafting: it derives runner-independent QA first, then compiles the selected path into Playwright, Maestro, or manual artifacts
- repo-local verification base: shared manifests can be committed, while generated run history stays ignored by default
- context-aware baseline generation: manifest init can use repo-local context, ADRs, goals, agent instructions, harness files, skills, and runbooks as advisory bootstrap signals
- harness/skill role hints: instruction-derived context is classified as agent skill, harness config, workflow lifecycle, verification rubric, safety policy, release policy, or test runner context
- ecosystem-aware: it suggests validation commands for JavaScript/TypeScript, Python, Go, Rust, Gradle, and Maven projects
- CI-friendly: text, JSON, Markdown, and SARIF output are supported
- explainable: every finding includes a concrete fix

It is built for teams using AI coding agents, MCP-powered tools, or any workflow where an agent can read, edit, test, commit, or open pull requests.

For PR verification, QAMap treats the repository itself as the working base: committed manifests hold durable team language, ignored local history holds generated run observations, and the current branch diff supplies what changed now.

