# Command Reference

Every QAMap command, with what it produces and when to reach for it. For the shortest path, see the [README](../README.md) quick start; for rollout order, see [adoption](adoption.md).

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

## Reading The Output

Human-facing reports (`text` and `markdown` formats) open with an **At a Glance** section: affected behavior, the reviewer question to answer before merge, concrete repository evidence, the proposed draft path, the next command, and the one or two missing trust requirements. When printed to an interactive terminal the report is colorized (headings, statuses, priority tags, inline commands); files written with `--output`, pipes, CI logs, and the machine formats (`json`, `agent`, `sarif`) are always plain. The standard `NO_COLOR` and `FORCE_COLOR` environment variables are honored.

Draft readiness is reported as a **stage on a fixed four-step journey**, for example `Stage: setup needed (1 of 4) — readiness 0/100`. A fresh repository usually starts at stage 1 — that is the expected starting point, not a failure. Each stage maps to a stable `readiness.level` value in the `json` and `agent` formats, which keeps machine output unchanged:

| Stage line | JSON `readiness.level` | Meaning |
| --- | --- | --- |
| `setup needed (1 of 4)` | `blocked` | Drafts describe the flow but need runner config or other required setup before they can run. |
| `draft in progress (2 of 4)` | `needs-work` | Drafts exist; close the required action items to make them runnable. |
| `almost runnable (3 of 4)` | `near-runnable` | Run the drafts locally and clear the remaining review items. |
| `ready to run (4 of 4)` | `ready` | Drafts are ready to try as local regression evidence. |


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
| `qamap qa . --base origin/main --head HEAD` | One-command PR QA: affected flows, missing QA evidence, a PR checklist, and E2E starter drafts, opening with At a Glance. |
| `qamap qa . --base origin/main --head HEAD --format agent` | The same decision content as one ~2-4KB JSON line for coding agents — a versioned contract documented in [docs/agent-format.md](agent-format.md). |
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
| `qamap init --agent .` | One-command agent onboarding: add a marked QAMap Pre-PR QA section to `AGENTS.md`, install the packaged skill to `.claude/skills/qamap-pr-qa/SKILL.md`, and create `qamap.config.json` if missing. Idempotent; existing `AGENTS.md` content is preserved. |

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

The scan reads up to 2,500 files by default (alphabetically, skipping vendor trees such as `node_modules`, `Pods`, `.gradle`, and build output). The init summary reports how many files were scanned, and warns when the scan stopped at the cap — on very large repositories rerun with `--max-files` so domains and flows are inferred from the whole project.

Validation commands come from two sources, ground truth first: `package.json` scripts whose names look like verification (`test`, `lint`, `typecheck`, `check`, `e2e`, `coverage`, `build`, …) plus a detected pytest setup, then commands found in instruction docs — inline code spans (like a `pnpm test` mentioned in a sentence) anywhere, and bare command lines only when they sit inside fenced code blocks. Prose sentences that merely mention a tool name are not treated as commands. Scripts that block, open a UI, or mutate state (`test:watch`, `e2e:open`, `test:update`, `lint:fix`, …) are excluded. Safety rules are only harvested from prose lines that state a prohibition or obligation (`never …`, `do not …`, `절대/금지 …`); code blocks, CI YAML, and diagram fragments inside instruction docs are ignored.

> **Important:** create the shared team baseline from the repository's default branch, after pulling the latest changes. QAMap does not silently switch branches or rewrite the repository state, so running `manifest init` from a feature branch creates a feature-branch snapshot, not the team's default QA map.

```sh
git switch main
git pull
qamap manifest context .
qamap manifest init . --write .qamap/manifest.yaml
```

`qamap manifest context .` is a read-only preview of the repo-local knowledge QAMap can see before writing the manifest. It reports context sources such as `CONTEXT.md`, ADRs, goals, runbooks, agent instructions, harness files, and skills under agent directories (`.claude/`, `.codex/`, `.agent-core/`, `.github/instructions/`), then shows role classifications, validation commands, safety rules, and diagnostics for stale or missing context.

After the baseline is committed, feature branches should usually run `manifest explain`, `e2e plan`, or `e2e draft` against the PR base such as `origin/main`. The manifest is not meant to be perfect on the first run. It is meant to start the feedback loop: QAMap recommends E2E work from the manifest, shows why a recommendation happened, and points to the manifest path to edit when the recommendation is wrong.

Generated manifests include a `$schema` reference to `schema/qamap-manifest.schema.json`, so teams can validate and edit `.qamap/manifest.yaml` with a documented contract. See [docs/manifest.md](manifest.md) for the full field guide and adoption workflow.

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

Flow and scenario names prefer what the diff itself introduced: an added `aria-label`/`data-testid`/`testID`/placeholder value or button/link inner text with an action word names the journey ("Checkout Apply Coupon" instead of "Checkout primary journey"). Korean action labels qualify the same way — `저장하기` and 35 other common stems, with `~하기/~합니다`-style endings normalized — and draft filenames keep Hangul. When a diff changes only logic or styles (no labeled elements added), the surface's primary action-bearing control names the journey instead.

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

`qamap e2e draft` writes draft files from that plan. Expo and React Native projects get Maestro YAML flows under `.maestro/` by default, web projects get Playwright specs under `tests/e2e/`, API/service projects get contract checklist drafts, and CLI packages get command verification checklists until a project-specific runner is documented. For web apps, QAMap recognizes common Next.js, React Router, Vite, Vue/Nuxt, Svelte, Remix, Astro, and Angular signals. It can infer routes from Next Pages Router files, Next App Router files such as `src/app/(group)/products/[id]/page.tsx`, React Router `path` objects, links, and imperative navigation calls. Drafts infer stable selectors such as `testID`, `accessibilityLabel`, `data-testid`, `aria-label`, placeholder text, role-based buttons or links, and visible text where possible. They also carry fixture/mock readiness notes and inferred API endpoint hints. When the repository already contains mock, fixture, or seed files, QAMap statically reads their contents and turns the fixture guidance into named instructions — which handler file to extend for which uncovered endpoint, or which exported mock data to reuse — and exposes the matched files as `mockInsights` on `fixtureReadiness` in JSON output. Client-only flows may get sample Playwright response scaffolds whose bodies reuse the response keys observed in the matched fixture file, but endpoints changed by the PR are observed rather than intercepted with synthetic responses so the generated draft does not hide the contract under test. When selectors or route params are incomplete, QAMap now prefers runnable starter code with safe smoke assertions and sample params over non-executable placeholder locators. Existing files are not overwritten unless `--force` is passed.

The draft result is meant to be useful as a PR artifact, not only as generated files. Markdown and JSON output include:

- `languageBrief`: actor, trigger, goal, success signal, reviewer question, and edge cases for each draft file
- `promotionStatus`: whether the draft is a `commit-candidate`, `needs-review`, or `low-signal`
- `runnableStatus`: whether the draft is a `runnable-candidate`, `near-runnable`, or `review-only`
- selectors carry `addedInDiff: true` when the value was introduced by the diff itself, so agents can bind actions to what the change added
- `selfCheck`: static runner checks for generated draft structure, unresolved placeholders, starter-code quality, and the execution profile
- `status`: whether the file was `preview`ed by `--dry-run`, `created`, or `skipped`
- `actionItems`: required and recommended follow-up work, grouped by assertion, fixture, selector, runner, validation, and manifest
- `actionSummary`: total required/recommended action counts, ready file count, and the most common action categories
- `readinessSummary`: an overall 0-100 score, readiness level, self-check counts, starter-code gaps, execution blocker counts, and top blockers

See [docs/e2e-output-examples.md](e2e-output-examples.md) for compact examples of web, mobile, API/service, CLI, test-light, and monorepo output.

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
