# QAMap

[![CI](https://github.com/IvoryCanvas/qamap/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/qamap/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ivorycanvas%2Fqamap.svg)](https://www.npmjs.com/package/@ivorycanvas/qamap)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A local-first QA skill for AI-generated PRs. QAMap turns a PR diff into affected flows, missing evidence, and E2E drafts. No cloud. No LLM token.**

QAMap is a local-first CLI that reads git changes, project structure, runner signals, selectors, and optional repo QA memory, then returns a PR-ready QA draft: which user flow may be affected, which runner fits, what E2E or checklist should exist, and what evidence is still missing before merge.

It is built for the moment when a reviewer asks: "This PR looks plausible, but which user flow could it break, and what should we test before merge?"

QAMap does not call an LLM API, upload source code, or require a service account. It runs in the repository you already have.

The core loop is intentionally simple:

```txt
PR diff
  -> qamap qa

QAMap output
  -> PR comment draft + E2E/checklist draft + missing evidence

Optional team memory
  -> .qamap/manifest.yaml
  -> better future PR recommendations
```

## Install & Quick Start

Requires Node.js 20 or newer.

Run QAMap once without adding a dependency:

```sh
pnpm dlx @ivorycanvas/qamap qa . --base origin/main --head HEAD
```

That first command is intentionally manifest-free. It previews a PR comment/checklist that names the affected flow, recommended runner, draft file, missing fixture/selector/assertion evidence, and validation command.

Handing the result to a coding agent instead of a human? Use the compact agent format (see [For Coding Agents](#for-coding-agents)):

```sh
pnpm dlx @ivorycanvas/qamap qa . --base origin/main --head HEAD --format agent
```

Install QAMap in a repository when you want a repeatable project command:

```sh
pnpm add -D @ivorycanvas/qamap
pnpm exec qamap qa . --base origin/main --head HEAD
```

Generate a Markdown artifact that an agent or reviewer can paste into a PR:

```sh
pnpm exec qamap qa . --base origin/main --head HEAD --output QAMAP_QA.md
```

When you are ready to create actual draft test files instead of a PR comment preview:

```sh
pnpm exec qamap e2e draft . --base origin/main --head HEAD --dry-run
pnpm exec qamap e2e draft . --base origin/main --head HEAD
```

Optional accuracy upgrade: create repo-local QA memory from the default branch and review it. Matching is anchor-path based today — a flow claims a PR only when changed files or routes hit its listed anchors — so add shared components to a flow's `anchors` when changes to them should map to that flow:

```sh
git switch main
pnpm exec qamap manifest context .
pnpm exec qamap manifest init .
git add .qamap/manifest.yaml
git commit -m "Add QAMap verification manifest"
```

Preview adoption without writing a manifest into the target repository:

```sh
pnpm exec qamap manifest init . --write /tmp/qamap-manifest.yaml
pnpm exec qamap qa . --manifest /tmp/qamap-manifest.yaml --base origin/main --head HEAD
```

Use the lower-level scanner when you want repository guardrail findings:

```sh
pnpm exec qamap scan .
```

## 30-Second PR Demo

![QAMap: zero tests to a passing E2E in three commands](docs/assets/qamap-30s-demo.gif)

This is a real, unedited recording against the published `@ivorycanvas/qamap` package on a small Next.js app with **zero committed tests**: `qamap qa` names the affected flow and the bootstrap plan, `qamap e2e setup` writes the Playwright config and starter spec, and `npm run test:e2e` finishes with `1 passed`. First-run assertions are smoke checks — the point is a runnable starting point, not finished coverage.

Try the same loop on your own branch:

```sh
pnpm dlx @ivorycanvas/qamap qa . --base origin/main --head HEAD
```

QAMap reads the changed files and project signals:

```txt
Input
- git diff: origin/main...HEAD
- project structure: package.json, routes, test config, selectors
- optional team context: .qamap/manifest.yaml, CONTEXT.md, ADRs, goals, QA runbooks
```

Then it returns reviewable verification work:

```txt
Output
- PR comment/checklist draft for this branch
- changed domain language and candidate user flows
- recommended E2E runner or manual checklist
- draft Playwright, Maestro, CLI, API, or manual test files
- readiness status: runnable-candidate, near-runnable, or review-only
- blockers such as missing runner config, selectors, fixtures, or assertions
```

Trimmed real `qamap qa` output for a small Next.js notes-page change in a repository with no tests and no manifest (full output also lists validation gaps and a PR checklist):

```txt
# QAMap QA Draft

> Local-first PR QA skill output. No cloud. No LLM token. Manifest is optional, not required for first use.

## Summary

- Project: Web
- Recommended runner: Playwright
- Manifest: not found; using repo signals and PR diff only
- Readiness: needs-work (54/100)
- Draft flows: 1

## First E2E Draft Bootstrap

QAMap did not find committed test files for this target. The next step is to
create the first runnable starter draft, not to stop at a checklist.

- Recommended first runner: Playwright
- Create command: `qamap e2e setup . --runner playwright`
- Install command: `npm install -D @playwright/test`
- Draft files QAMap can create:
  - `playwright.config.ts`
  - `tests/e2e/notes-primary-journey.spec.ts`

## PR Comment Draft

### Affected Flow

- Notes primary journey (domain-language)
  - User journey: User -> Open route /notes. -> Protect Notes primary journey
    by fill Write A Note with realistic data.
  - Changed files: `app/notes/page.tsx`
  - Why: Primary entrypoint inferred as route /notes [high] (app/notes/page.tsx).
```

Accepting that bootstrap with `qamap e2e setup . --runner playwright` writes a working `playwright.config.ts` and this starter spec — real locators from the changed JSX, and honest smoke assertions instead of placeholder failures:

```ts
await test.step("Open route /notes.", async () => {
  await page.goto("/notes");
});

await test.step("Fill Write A Note with realistic data.", async () => {
  await page.getByPlaceholder("Write a note").fill("QAMap sample value");
});

await test.step("Activate the main Notes action using Add Note.", async () => {
  await page.getByTestId("add-note").click();
});

await test.step("Confirm the visible result, saved state, navigation, or event that proves Notes worked.", async () => {
  await expect(page.getByText("Notes")).toBeVisible();
});
```

This exact starter spec passes against the demo app on the first run (`1 passed (1.3s)` under chromium). First-run assertions are smoke checks against detected text and selectors; the draft also carries the coverage targets a human (or the team's agent) should turn into real domain assertions before promoting the spec to required CI evidence.

See [docs/quickstart-demo.md](docs/quickstart-demo.md) for a compact walkthrough, [docs/agent-skill.md](docs/agent-skill.md) for agent handoff usage, [docs/manifest.md](docs/manifest.md) for the verification manifest loop, and [docs/e2e-output-examples.md](docs/e2e-output-examples.md) for more output shapes.

## For Coding Agents

Stop re-explaining the same QA context to your agent on every PR. QAMap answers "what should this branch prove before merge?" locally, deterministically, and without spending a single LLM token on repo exploration:

```sh
qamap qa . --base origin/main --head HEAD --format agent
```

`--format agent` returns one minified JSON object (`schema: qamap.qa`, about 2 KB for a typical small PR) with the affected flows, draft paths and runnable status, required evidence, bootstrap blockers, PR checklist, and validation commands — the decision content of the full report at a fraction of the context cost.

Three integration points ship with the package:

- `skills/qamap-pr-qa/SKILL.md` — a portable agent skill template: any local agent workflow that reads reusable instructions can run QAMap as its final QA pass before PR handoff.
- `qamap context . --write AGENTS.md` — generated agent instructions now include a Pre-PR QA section, so agents working in the repo learn to run `qamap qa` on their own.
- `--output` — write the qa report to a file an agent or reviewer can paste into the PR body.

Treat QAMap output as QA planning evidence, not proof that browser, device, or manual QA passed — the output says so itself.

## Why This Is Different

Recorders such as browser or mobile test studios are useful when you already know the flow to exercise. QAMap starts one step earlier: it asks what the PR changed, which repo-owned QA memory applies, and what test artifact should exist before merge.

A good QAMap result should answer:

- which product flow changed
- which manifest domain, flow, and checks caused the recommendation
- which draft test file was generated or previewed
- which success, failure, edge, contract, or visual cases the draft covers
- which selector, fixture, auth, runner, or validation gaps still block trusted regression evidence
- which manifest path to edit when the recommendation is wrong

That is the product bet: one human correction to the repo-local manifest should improve future PR recommendations without another LLM prompt.

You do not need a manifest to start. Without one, QAMap uses the PR diff, package signals, routes, selectors, runner config, and existing tests. Add a manifest only when the team wants durable QA language that improves future recommendations.

## What QAMap Is For

QAMap is intentionally small:

- time-saving: it surfaces missing context, risky settings, and validation gaps before agent work becomes review churn
- static by default: it does not execute scanned project code
- no-token by default: it does not call an LLM API
- verification-focused: it tells reviewers what evidence is missing, not how to style code
- PR QA skill output: `qamap qa` turns a branch into a PR-ready affected-flow summary, suggested E2E/checklist draft, missing evidence list, and copyable checklist
- packaged agent skill: `skills/qamap-pr-qa/SKILL.md` gives coding agents a compact PR QA workflow for running QAMap before handoff
- domain-aware E2E drafting: it turns branch changes into flow language, draft specs, readiness summaries, and action items
- repo-local verification base: shared manifests can be committed, while generated run history stays ignored by default
- context-aware baseline generation: manifest init can use repo-local context, ADRs, goals, agent instructions, harness files, skills, and runbooks as advisory bootstrap signals
- harness/skill role hints: instruction-derived context is classified as agent skill, harness config, workflow lifecycle, verification rubric, safety policy, release policy, or test runner context
- ecosystem-aware: it suggests validation commands for JavaScript/TypeScript, Python, Go, Rust, Gradle, and Maven projects
- CI-friendly: text, JSON, Markdown, and SARIF output are supported
- explainable: every finding includes a concrete fix

It is built for teams using AI coding agents, MCP-powered tools, or any workflow where an agent can read, edit, test, commit, or open pull requests.

For PR verification, QAMap treats the repository itself as the working base: committed manifests hold durable team language, ignored local history holds generated run observations, and the current branch diff supplies what changed now.

<details>
<summary>한국어 소개</summary>

QAMap는 AI 코딩 에이전트가 만든 PR을 리뷰하기 전에 로컬에서 실행하는 QA 초안 CLI입니다.

PR diff와 repo 구조를 읽고 어떤 사용자 플로우가 영향받았는지, 어떤 E2E 또는 체크리스트가 필요한지, fixture/selector/assertion/runner/validation 근거 중 무엇이 부족한지 정리합니다. 클라우드나 LLM 토큰을 쓰지 않습니다.

```sh
pnpm dlx @ivorycanvas/qamap qa . --base origin/main --head HEAD
```

에이전트에게 넘길 때는 `--format agent`를 붙이면 같은 판단 내용을 약 2KB의 JSON으로 받을 수 있어, 매 세션 repo 탐색에 토큰을 쓰지 않아도 됩니다.

목표는 거대한 QA 플랫폼이 아니라, 유지보수자가 매번 에이전트에게 프로젝트 맥락과 검증 방법을 다시 설명하느라 쓰는 시간을 줄여주는 작고 선명한 도구입니다. Manifest 없이 바로 시작하고, 반복해서 틀리는 추천은 `.qamap/manifest.yaml`에 팀의 QA 언어로 보정해 향후 PR 추천을 개선합니다.

</details>

## Quick Commands

```sh
pnpm exec qamap qa . --base origin/main --head HEAD
pnpm exec qamap qa . --base origin/main --head HEAD --format agent
pnpm exec qamap qa . --manifest /tmp/qamap-manifest.yaml --base origin/main --head HEAD --output QAMAP_QA.md
pnpm exec qamap scan .
pnpm exec qamap verify . --base origin/main --head HEAD --pr-body-file pr-body.md
pnpm exec qamap manifest context .
pnpm exec qamap manifest init .
pnpm exec qamap manifest validate .
pnpm exec qamap manifest explain . --base origin/main --head HEAD
pnpm exec qamap e2e draft . --base origin/main --head HEAD --dry-run
```

Use `pnpm dlx @ivorycanvas/qamap ...` for one-off runs without installing QAMap into the target repository.

## Repository Guardrails (Secondary Layer)

The QA draft loop above is the core product. QAMap also ships a static guardrails scanner as a secondary layer for repositories that let agents work broadly: it checks agent instructions, MCP configs, committed env files, risky package scripts, workflow permissions, and validation signals before agent work becomes review churn.

For a repository baseline before broad agent use, run:

```sh
qamap scan .
```

```txt
Findings: 6 (high: 3, medium: 2, low: 1, info: 0)

HIGH
- QM003 Suspicious agent instruction text (AGENTS.md)
  Fix: Remove untrusted instruction text or move examples into clearly fenced documentation.
```

See the rule table below and [docs/rules.md](docs/rules.md) for what the scanner checks.

When developing QAMap from source:

```sh
git clone https://github.com/IvoryCanvas/qamap.git
cd qamap
pnpm install
pnpm build
node dist/cli.js scan /path/to/repo
```

QAMap `0.2.x` is a local-first PR verification planner with a repository-level verification manifest loop, not a finished automatic QA bot. A good result is a clear answer to "what should this branch prove before merge?", plus manifest-backed E2E, fixture, selector, and validation work that a developer can turn into real regression coverage. Many first drafts will correctly report `review-only` or `near-runnable` until the project adds runner config, stable selectors, deterministic fixtures, or team-owned manifest entries.

## What QAMap Produces

On a changed branch, QAMap tries to produce reviewable verification artifacts instead of only saying "write more tests":

- a branch-aware verification plan that names the changed domain, actor, trigger, goal, success signal, and edge cases
- draft Playwright, Maestro, CLI command, or manual checklist files when the repository shape supports them
- a repo-level verification manifest loop where humans correct durable flows once and later PRs get sharper route/check/test draft suggestions
- a runner setup proposal that explains why Playwright or Maestro fits the changed surface and which files/commands would be created if the team accepts it
- readiness evidence that explains missing runner config, selectors, fixture data, assertions, validation commands, or flow manifests
- repo-local suggestions for `.qamap/domains.yml`, `.qamap/flows.yml`, and ignored `.qamap/runs/` history so teams can improve the next run without spending LLM tokens

That means QAMap is most valuable when it becomes the team's verification base: humans define the durable language and critical flows once, QAMap reuses that base on each PR, and generated observations stay local unless the team intentionally promotes them into shared policy.

## Commands

| Command | Purpose |
| --- | --- |
| `qamap scan .` | Scan the current repository and print a text report. |
| `qamap scan . --fail-on medium` | Exit with code `1` when findings at or above the threshold exist. |
| `qamap scan . --json` | Print machine-readable JSON for custom automation. |
| `qamap scan . --format sarif --output qamap.sarif` | Generate SARIF for code scanning integrations. |
| `qamap report . --output QAMAP_REPORT.md` | Generate a Markdown report for PRs or audits. |
| `qamap doctor . --format markdown` | Summarize whether the repo is ready for AI-assisted work. |
| `qamap review . --base origin/main --head HEAD --format markdown` | Show new findings and changed risky files introduced by a branch. |
| `qamap verify . --base origin/main --head HEAD --pr-body-file pr-body.md` | Combine review findings, readiness scoring, domain tests, and next actions. |
| `qamap eval . --base origin/main --head HEAD --pr-body-file pr-body.md` | Score change readiness across intent, risk, tests, and review size. |
| `qamap github-action . --mode review --base origin/main --head HEAD` | Generate GitHub Action annotations, step summary, and PR comment body. |
| `qamap test-plan . --base origin/main --head HEAD --include-working-tree` | Suggest domain test scenarios for changed files. |
| `qamap e2e plan . --base origin/main --head HEAD` | Suggest E2E runner, bootstrap steps, user flows, coverage targets, existing test evidence, and missing testability hooks for changed files. |
| `qamap e2e plan . --base origin/main --head HEAD --record-history` | Save a compact local run snapshot under `.qamap/runs/` while keeping JSON/Markdown output usable. |
| `qamap e2e setup . --runner playwright` | Explicitly apply the accepted runner setup and create the first changed-flow E2E draft without overwriting existing files. |
| `qamap e2e draft . --base origin/main --head HEAD --dry-run` | Preview generated Maestro, Playwright, or manual E2E drafts without writing files. |
| `qamap e2e draft . --base origin/main --head HEAD` | Write generated Maestro, Playwright, or manual E2E drafts with flow language, readiness summaries, and action items. |
| `qamap manifest init .` | Create a baseline `.qamap/manifest.yaml` with inferred domains, flows, anchors, checks, source, and confidence. |
| `qamap manifest validate .` | Check whether `.qamap/manifest.yaml` is present, parseable, anchored to real files, and ready to shape PR evidence. |
| `qamap manifest context .` | Preview repo-local context sources, role classifications, validation commands, safety rules, and manifest repair diagnostics. |
| `qamap manifest explain . --base origin/main --head HEAD` | Explain which manifest domains, flows, and checks match the current branch and which manifest path to edit if the match is wrong. |
| `qamap flows init .` | Create a starter `.qamap/flows.yml` for team-approved core flow definitions. |
| `qamap flows suggest . --base origin/main --head HEAD` | Generate suggested `.qamap/flows.yml` entries with commit-readiness guidance from changed files and E2E plan context. |
| `qamap domains init .` | Create a starter `.qamap/domains.yml` for shared product/domain language. |
| `qamap domains suggest . --base origin/main --head HEAD` | Generate suggested `.qamap/domains.yml` entries with commit-readiness guidance from changed files and inferred product language. |
| `qamap history init .` | Create local QAMap history directories and protect generated run history with `.gitignore`. |
| `qamap doctor services/listing --workspace-root .` | Scan a monorepo package while using root guardrails. |
| `qamap context . --write AGENTS.md` | Generate starter agent instructions for the repo. |
| `qamap init .` | Create a starter `qamap.config.json`. |

For monorepos, pass `--workspace-root` when scanning a package. Package-local checks still use the package directory, while repo-level guardrails such as `AGENTS.md`, `.github/workflows`, `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md` are read from the workspace root.

`qamap review` compares a branch against a base ref for PR-style workflows. It separates newly introduced findings from risky files that already had findings on the base branch but were modified again, which helps reviewers notice when a PR touches known-dangerous surfaces such as committed `.env` files, MCP configs, or release scripts.

`qamap verify` is the easiest PR-facing command. It combines `review`, `test-plan`, and `eval` into one report with review findings, readiness gates, suggested domain tests, suggested commands, and next actions.

`qamap test-plan` turns changed file paths into a review-ready domain test checklist. It also discovers common validation commands from `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, Gradle files, and Maven `pom.xml`. Add `--include-working-tree` for local, uncommitted changes while iterating.

`qamap e2e plan` turns changed file paths into a first-pass E2E testing plan. It detects whether a project looks like Expo/React Native, web, API/service, or CLI package, recommends a runner such as Maestro or Playwright, starts backend services with an API contract checklist, starts executable packages with a CLI command verification checklist, suggests bootstrap steps for repos with little or no test history, suggests domain language for the changed behavior, suggests candidate user flows, adds coverage targets, compares those targets with existing test-suite evidence when tests are present, flags API-dependent flows that need mock or fixture responses, and points out missing stable selectors such as `testID` or `data-testid` before anyone starts writing tests from a blank file.

The plan also includes an execution profile: detected start command, test command, Playwright `baseURL`, mobile app id, runner config files, env fixture files, confidence, and blockers. This keeps generated E2E drafts honest about whether they are runnable candidates or still review-only scaffolds.

When a repository does not already have the selected E2E runner, the plan includes a runner setup proposal instead of silently changing the project. The proposal explains why the runner fits the changed surface, which package command installs the library, which config/script files would be created, and the explicit acceptance command such as `qamap e2e setup . --runner playwright`.

`qamap e2e setup` is the opt-in apply step. For Playwright it can create `playwright.config.ts`, `tests/e2e/`, a `test:e2e` script, and the first changed-flow Playwright spec. For Maestro it can create `.maestro/`, `.maestro/README.md`, a `test:e2e` script, and the first changed-flow YAML draft. Existing draft files are skipped unless `--force` is passed. It does not run package installation automatically; it prints the install command so teams can keep dependency policy under review.

When run at a monorepo root, the E2E plan also reports changed app/package targets. This helps a maintainer move from a broad workspace diff to scoped commands such as `qamap e2e plan services/listing --workspace-root . --base origin/main --head HEAD`, where package-specific runner detection and flow naming are usually sharper.

Each candidate flow also includes a flow language brief: actor, trigger, goal, success signal, reviewer question, and edge cases. The brief keeps generated tests tied to product behavior rather than only changed file names.

The bootstrap section answers what must happen before generated drafts can be treated as real regression coverage. For example, a testless web project can get required steps for Playwright setup, first draft generation, stable selector work, fixture/mock data, and missing validation evidence, plus recommended steps for `.qamap/manifest.yaml`, `.qamap/domains.yml`, `.qamap/flows.yml`, and local history recording.

Run `qamap manifest init .` to create a baseline verification manifest. QAMap infers domains, flows, route/component anchors, checks, runner hints, source, and confidence from the current checkout.

> **Important:** create the shared team baseline from the repository's default branch, after pulling the latest changes. QAMap does not silently switch branches or rewrite the repository state, so running `manifest init` from a feature branch creates a feature-branch snapshot, not the team's default QA map.

```sh
git switch main
git pull
qamap manifest context .
qamap manifest init . --write .qamap/manifest.yaml
```

`qamap manifest context .` is a read-only preview of the repo-local knowledge QAMap can see before writing the manifest. It reports context sources such as `CONTEXT.md`, ADRs, goals, runbooks, agent instructions, harness files, and skills, then shows role classifications, validation commands, safety rules, and diagnostics for stale or missing context.

After the baseline is committed, feature branches should usually run `manifest explain`, `e2e plan`, or `e2e draft` against the PR base such as `origin/main`. The manifest is not meant to be perfect on the first run. It is meant to start the feedback loop: QAMap recommends E2E work from the manifest, shows why a recommendation happened, and points to the manifest path to edit when the recommendation is wrong.

Generated manifests include a `$schema` reference to `schema/qamap-manifest.schema.json`, so teams can validate and edit `.qamap/manifest.yaml` with a documented contract. See [docs/manifest.md](docs/manifest.md) for the full field guide and adoption workflow.

Use `qamap manifest validate .` before treating the manifest as shared team policy. It reports missing manifests, invalid YAML/schema shape, duplicate ids, missing domain paths, stale anchor files, suspicious route hints, and low-confidence inferred entries that should be reviewed.

Use `qamap manifest explain . --base origin/main --head HEAD` when you want to understand one branch. It reads the git diff, lists the matched manifest domains/flows/checks, shows the declared entry route and required checks, and names the exact manifest path to update if the recommendation is wrong.

When `.qamap/manifest.yaml` exists, `qamap verify`, `qamap e2e plan`, and `qamap e2e draft` include a Manifest Recommendations section:

```txt
Why this was recommended:
- Changed files match anchors for the Bundle Submission Complete flow.

Manifest evidence:
- .qamap/manifest.yaml > flows.bundle-submission-complete.anchors

Next actions:
- Draft or review E2E coverage for the Bundle Submission Complete flow.
- Cover the declared checks: Submit media link successfully; Show validation error for invalid media link.

If this is wrong:
- Update .qamap/manifest.yaml > flows.bundle-submission-complete.anchors

Repair hints:
- If these files do not belong to this flow, update .qamap/manifest.yaml > flows.bundle-submission-complete.anchors.
- If the recommended assertions feel vague, rewrite .qamap/manifest.yaml > flows.bundle-submission-complete.checks in team language.
```

When a matched manifest flow has an entry route and checks, `qamap e2e draft` promotes it ahead of heuristic candidates. The generated Playwright, Maestro, or manual draft carries the manifest evidence, uses the manifest route as an entrypoint when possible, and turns manifest checks into draft steps and required coverage notes. If a check includes concrete hints such as `[data-testid=coupon-input]`, `with WELCOME10`, or optional `selector`, `value`, and `steps` fields, QAMap uses those facts before falling back to fuzzy selector inference. This is the core cost-saving loop: humans fix durable QA context once, then future PRs start from a stronger draft instead of a blank test file.

The domain language section is intentionally less implementation-oriented than the raw file list. For example, changes under `src/features/in-app-purchase/` become terms such as `In App Purchase` and scenarios such as `In App Purchase primary journey`. When a changed component or service file names a concrete behavior, QAMap should prefer that behavior before the generic primary journey: `src/features/listing/components/MediaLinkSubmitModal.tsx` can become `Listing Media Link Submit`, and the generated draft file can become `.maestro/listing-media-link-submit.yaml`. When `.qamap/domains.yml` exists, declared product terms and routes receive higher confidence. When `.qamap/flows.yml` exists, team-approved flow names appear as preferred scenario names.

If `.qamap/domains.yml` exists, `qamap e2e plan` also matches changed files against shared product or domain language:

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

Run `qamap domains init .` to create a starter domain manifest. Run `qamap domains suggest . --base origin/main --head HEAD` when you want QAMap to draft manifest entries from the current branch and classify each candidate as `commit-candidate`, `needs-review`, or `low-signal`. Use domains for naming and route hints; use core flows when the team wants to define a durable verification journey.

If `.qamap/flows.yml` exists, `qamap e2e plan` also matches changed files against team-approved core flows. This lets maintainers encode the product or domain flows humans already care about:

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

Run `qamap flows init .` to create a starter manifest. Run `qamap flows suggest . --base origin/main --head HEAD` when you want QAMap to draft flow entries from changed files, inferred domain language, routes, and E2E checks, then classify which entries are close enough to review as shared policy. Unlike generated run history, `.qamap/flows.yml` is meant to be reviewed and committed when those flow definitions should become team policy.

Pass `--record-history` when you want QAMap to keep a compact local snapshot of an E2E plan under `.qamap/runs/`. QAMap automatically protects `.qamap/runs/`, `.qamap/cache/`, `.qamap/tmp/`, and `.qamap/*.local.json` with `.gitignore` so generated history stays local by default. Shared project policy, such as `qamap.config.json`, `.qamap/domains.yml`, and `.qamap/flows.yml`, remains commit-friendly.

`qamap e2e draft --dry-run` previews the same draft analysis without creating directories or files. Use it first when evaluating a new repository or PR. The output still includes planned file paths, self-checks, readiness status, action items, starter-code gaps, and execution blockers.

`qamap e2e draft` writes draft files from that plan. Expo and React Native projects get Maestro YAML flows under `.maestro/` by default, web projects get Playwright specs under `tests/e2e/`, API/service projects get contract checklist drafts, and CLI packages get command verification checklists until a project-specific runner is documented. For web apps, QAMap recognizes common Next.js, React Router, Vite, Vue/Nuxt, Svelte, Remix, Astro, and Angular signals. It can infer routes from Next Pages Router files, Next App Router files such as `src/app/(group)/products/[id]/page.tsx`, React Router `path` objects, links, and imperative navigation calls. Drafts infer stable selectors such as `testID`, `accessibilityLabel`, `data-testid`, `aria-label`, placeholder text, role-based buttons or links, and visible text where possible. They also carry fixture/mock readiness notes and inferred API endpoint hints. Client-only flows may get sample Playwright response scaffolds, but endpoints changed by the PR are observed rather than intercepted with synthetic responses so the generated draft does not hide the contract under test. When selectors or route params are incomplete, QAMap now prefers runnable starter code with safe smoke assertions and sample params over non-executable placeholder locators. Existing files are not overwritten unless `--force` is passed.

The draft result is meant to be useful as a PR artifact, not only as generated files. Markdown and JSON output include:

- `languageBrief`: actor, trigger, goal, success signal, reviewer question, and edge cases for each draft file
- `promotionStatus`: whether the draft is a `commit-candidate`, `needs-review`, or `low-signal`
- `runnableStatus`: whether the draft is a `runnable-candidate`, `near-runnable`, or `review-only`
- `selfCheck`: static runner checks for generated draft structure, unresolved placeholders, starter-code quality, and the execution profile
- `status`: whether the file was `preview`ed by `--dry-run`, `created`, or `skipped`
- `actionItems`: required and recommended follow-up work, grouped by assertion, fixture, selector, runner, validation, and manifest
- `actionSummary`: total required/recommended action counts, ready file count, and the most common action categories
- `readinessSummary`: an overall 0-100 score, readiness level, self-check counts, starter-code gaps, execution blocker counts, and top blockers

See [docs/e2e-output-examples.md](docs/e2e-output-examples.md) for compact examples of web, mobile, API/service, CLI, test-light, and monorepo output.

Generated Playwright drafts use the flow language as `test.step()` names so the file reads like the user journey it protects:

```ts
await test.step("Open route /checkout.", async () => {
  await page.goto("/checkout");
});

await test.step("Complete checkout with a valid payment method.", async () => {
  // Step intent: Complete checkout with a valid payment method.
  await page.getByTestId("checkout-submit").click();
});

await test.step("Fill profile email.", async () => {
  // Step intent: Fill profile email.
  await page.getByPlaceholder("Profile email").fill("qamap@example.com");
});
```

`qamap history init` prepares that local storage explicitly without running an analysis. It creates `.qamap/runs/`, `.qamap/cache/`, and `.qamap/tmp/`, then adds the generated-history ignore patterns to `.gitignore` idempotently.

`qamap eval` scores whether a branch has enough validation evidence, changed-test coverage, intent capture, risk explanation, domain verification paths, and reviewable size. In GitHub Actions, QAMap can read the pull request body from the event payload and append the evaluation to the PR comment.

## What It Checks

The first release focuses on high-signal checks that are useful across many repositories.

| Rule | Severity | What it catches |
| --- | --- | --- |
| `QM001` | medium | Missing agent instruction files. |
| `QM002` | medium | Conflicting agent guidance. |
| `QM003` | high | Suspicious instruction text that can misdirect agents. |
| `QM004` | medium/high | Risky MCP command configuration. |
| `QM005` | high | Secret-like values embedded in MCP config. |
| `QM006` | medium | Missing or placeholder test scripts. |
| `QM007` | low | Missing GitHub Actions workflows. |
| `QM008` | high | Committed local environment files. |
| `QM009` | high | Package scripts that can publish, push, merge, or run unsafe shell pipelines. |
| `QM010` | medium | Broad workflow permissions or risky workflow triggers. |
| `QM011` | low | Missing community health files. |
| `QM012` | medium/high | Risky committed agent settings, hooks, or broad shell permissions. |
| `QM013` | low | API endpoints documented only in prose without a contract source. |

See [docs/rules.md](docs/rules.md) for the rule catalog.
See [docs/ecosystem.md](docs/ecosystem.md) for the agent ecosystem surfaces QAMap tracks.
See [docs/api-contracts.md](docs/api-contracts.md) for the API contract source-of-truth check.
See [docs/verify.md](docs/verify.md) for the combined PR verification report.
See [docs/eval.md](docs/eval.md) for the change readiness evaluation.
See [docs/releasing.md](docs/releasing.md) for the npm release runbook.

## Configuration

Use `qamap.config.json` or `.qamap.json` to tune repository policy.

```json
{
  "$schema": "https://raw.githubusercontent.com/IvoryCanvas/qamap/main/schema/qamap.schema.json",
  "failOn": "high",
  "ignoreRules": ["QM011"],
  "maxFiles": 2000,
  "validationCommands": ["make test", "make lint"],
  "severity": {
    "QM007": "info"
  }
}
```

See [docs/configuration.md](docs/configuration.md) for details.

## GitHub Actions

QAMap can run as a lightweight PR check with annotations, a step summary, and a sticky PR comment:

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

The PR comment can include suggested domain tests and a verification readiness evaluation for changed files. For rollout guidance, see [docs/adoption.md](docs/adoption.md) and [docs/github-action.md](docs/github-action.md).

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

## Roadmap

QAMap starts as a local CLI and should stay small enough that maintainers can understand every finding.

Near-term priorities:

- keep the [release validation](docs/release-validation.md) checklist current across representative manifest, web, mobile, API/service, CLI, monorepo, and test-light repositories
- keep the [release runbook](docs/releasing.md) aligned with the npm package and GitHub Action release process
- publish a versioned GitHub Action release tag after the first public package is ready
- improve branch-aware `review` changed-line locations
- improve generated domain test plans with framework-specific test skeletons
- refine generated Maestro and Playwright drafts with stronger app-specific selector discovery and self-check loops
- expand `eval` into repository-specific verification manifests and taste rubrics
- continue expanding agent surface detection across Codex, Claude Code, Cursor, Copilot, Gemini, and related tools
- generate rule documentation from scanner metadata

See [docs/roadmap.md](docs/roadmap.md) for more detail.

## Project Status

QAMap is early and pre-`1.0`. The public API may change, but the project is intended to stay readable, practical, and useful in real repositories from the first release.

## Contributing

Issues and pull requests are welcome. Maintainer permissions stay with IvoryCanvas members, and `main` is protected so external contributors cannot push or merge directly.

Good first contributions include new agent instruction file detectors, better SARIF locations, sample risky repository fixtures, and documentation improvements.

See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [SECURITY.md](SECURITY.md).

## Philosophy

QAMap does not replace code review, tests, threat modeling, branch protection, or security review. It is a small preflight check that helps teams notice repo-level AI risks early enough to do something about them.
