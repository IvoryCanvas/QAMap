# Changelog

## Unreleased

### Added

- The `--format agent` output is now a documented, versioned contract. A machine-readable JSON Schema ships at `schema/qamap-agent.schema.json`, the field-by-field spec with a stability policy lives at `docs/agent-format.md` (within `qamap.qa` version 1, fields are only ever added — never removed or retyped; breaking changes bump `schema.version`), and the test suite validates real CLI output against the published schema so the contract cannot drift silently.
- `qamap manifest init` now reports how many files it scanned and warns explicitly when the scan stopped at the `--max-files` cap (with the exact rerun command), instead of silently producing an empty-looking baseline on large repositories. The JSON result carries a `scan` block (`files`, `maxFiles`, `truncated`), and `manifest validate`'s "No domains" advice now points at `--max-files` instead of circularly suggesting the same `manifest init` run that produced the empty manifest.
- Manifest validation commands now come from ground truth first: verification-shaped `package.json` scripts (`test`, `lint`, `typecheck`, `check`, `e2e`, `coverage`, `build`, …, invoked via the detected package manager) and a detected pytest setup (`pytest.ini`, `conftest.py`, `[tool.pytest]`) are listed ahead of commands found in instruction docs. Scripts that block, open a UI, or mutate state (`test:watch`, `test:debug`, `e2e:open`, `test:update`, `lint:fix`, npm-init placeholder tests) are excluded, while segment lookalikes such as `test:server`, `e2e:device`, and `check:fixtures` survive.
- `manifest init` now derives domains from Django-style backend structure: an app directory carrying two or more framework markers (`models`, `views`, `urls`, `serializers`, `forms`, `admin`, `apps`, `tasks`) becomes a product domain. Only Python files count as markers (a Rails `app/models/user.rb` fabricates nothing), apps are recognized at any nesting depth (`backend/orders/models.py`), and a Django-derived domain merges into a same-id domain from the JS pass instead of duplicating it. A Django monolith that previously produced an empty manifest now yields its real app areas.
- Manifest flow selection is ranked instead of alphabetical: navigable routes score above component matches, product-signal paths (login, signup, payment, checkout, orders, onboarding, …) get a boost, flows are interleaved across domains so one large area cannot fill every slot, and generic UI plumbing (bare or `Confirm`/`Error`/`Logger`-style modals and views, icon sets, `constants/`/`hooks/` files) no longer becomes a flow. Route inference maps the repo root correctly (`pages/index.*` and `app/page.*` → `/`), rewrites Nuxt-style dynamic segments (`_orderId` → `:orderId`), and excludes HTTP handlers from UI flows: `pages/api/**`, `app/api/**`, and App Router `route.*` files anywhere.
- Manifest anchors and checks got concrete: component anchors carry the real exported identifier (parsed from the source, omitted when unresolvable) instead of a humanized guess, and the happy-path check picks up a `data-testid` observed in the flow's source as its selector. `.vue`/`.svelte` files are now readable by the project walk, so Vue single-file components get the same treatment.
- Manifest domains stopped pretending: structural directory names (`components`, `hooks`, `providers`, `navigations`, `layout`, `styles`, …) are no longer domains, the candidate search continues past structural directory segments to the first product-shaped one (but never descends into a file basename unless the file sits directly under the route directory, so colocated `components/`/`hooks/`/`utils/` files cannot mint garbage domains), `pages/api`/`app/api` trees are never domains, child path globs already covered by a parent are dropped, and `criticality` is inferred (revenue/identity areas → `high`, internal design tooling → `low`) instead of a flat `medium`.
- Manifest runner inference reads dependency keys across every collected `package.json` (workspace members included) instead of raw root text: `react` in a description or an `eslint-plugin-react` entry no longer forces `playwright`, and an `app.json` only counts as mobile evidence when it has a top-level `expo` key.

- Reports are colorized when printed to an interactive terminal: headings, the At a Glance keys, status words and stage labels, priority tags, and inline commands get ANSI styling with zero dependencies. Files written with `--output`, pipes, CI logs, and machine formats (`json`, `agent`, `sarif`) are byte-identical to before; the standard `NO_COLOR` and `FORCE_COLOR` environment variables are honored.
- Mock/fixture file detection now matches whole name tokens instead of substrings, and a bare `handler` filename no longer counts as mock evidence outside mock-style directories. Files like `useSeedlingCatalog.ts` or `errorHandler.ts` stop being misreported as fixtures, which also stops branches from being marked `ready` on the strength of ordinary source files.
- Fixture guidance now names the concrete thing to do instead of assigning homework. QAMap statically reads the contents of discovered mock/fixture/seed files (up to 24 per plan) and extracts exports, handled routes (MSW, Mirage, express-style, Playwright `route(...)`), and response keys. Next actions become instructions like `Extend src/mocks/handlers.ts (already handles /api/invoices) to also cover /api/payments/summary` or `Reuse src/services/demoSeedService.ts (exports demoSeedService) to build a deterministic response for /api/sentiments/current`; missing-fixture guidance names the affected endpoints; generated Playwright mock bodies reuse the response keys observed in the matched fixture file instead of the `ok: true` placeholder; and fixture action-item titles carry the endpoints so the compact agent format keeps the target. Matched insights are exposed as an optional `mockInsights` array on `fixtureReadiness` in JSON output.
- `qamap init --agent` gives agent onboarding a single command: it adds a marked `Pre-PR QA (QAMap)` section to `AGENTS.md` (created if missing, appended if present, refreshed in place on re-runs without touching surrounding content), installs the packaged skill to `.claude/skills/qamap-pr-qa/SKILL.md`, and creates a starter `qamap.config.json` when none exists. Every step is idempotent, and a locally modified skill copy is never replaced without `--force`.
- Korean action labels now qualify for flow and scenario naming: labels like `저장하기` or `신청하기` (36 common action stems, with `~하기/~합니다`-style endings) name the journey the same way English action words do, draft filenames keep Hangul instead of collapsing to an empty slug, and Korean submit-like labels drive `Submit` steps. This closes the known limit noted in 0.3.3.

### Changed

- The project file walk skips mobile vendor/derived trees (`Pods`, `.expo`, `.gradle`, `DerivedData`, `Carthage`). On React Native and Expo repositories these directories could exhaust the capped alphabetical scan before it ever reached `src/`, which made `manifest init` produce zero domains and zero flows.
- Manifest context extraction got precision-first rules: bare command lines in instruction docs only count inside fenced code blocks (prose sentences that start with a tool name are no longer "commands"), commands containing commas, parentheses, or Hangul prose are rejected, redundant `a && b` compounds are dropped when both halves are already listed, and safety rules are only harvested from prose prohibition/obligation lines — code blocks, CI YAML fragments, mermaid edges, and topic words like `커밋`/`token` alone no longer produce fake team rules.
- Build-output directories (`out/`, `.output/`, `storybook-static/`, `__generated__/`) are excluded from manifest domain/flow inference, so exported build artifacts with hashed filenames no longer surface as product-domain key paths.
- Human reports now describe draft readiness as a stage on a fixed four-step journey (`Stage: setup needed (1 of 4) — readiness 0/100`) instead of a verdict (`Readiness: blocked (0/100)`), and the blocked-level recommendation says "keep these drafts review-only and start with X" instead of "do not treat these drafts as runnable". A fresh repository reads as being at the start of a path, not as failing. Machine formats are unchanged: `readiness.level` keeps the `blocked`/`needs-work`/`near-runnable`/`ready` values, and the stage-to-level mapping is documented in `docs/commands.md`.
- Slimmed the README from ~640 lines to ~100: it now carries only the demo, quick start, agent usage, positioning, and a documentation index. The full command reference moved to `docs/commands.md`, the guardrails scanner section to `docs/guardrails.md`, and positioning tables into `docs/adoption.md`.

## 0.3.3 - 2026-07-05

### Changed

- When a diff changes only logic or styles on a surface (no labeled elements added), the journey is now named after the surface's primary action-bearing control ("Invoices Send" instead of "Invoices primary journey"). Diffs that add labeled elements keep the existing diff-derived naming, so previously named flows are unaffected. A few common action verbs (send, share, export, download, print) were added to the action vocabulary. Known limit: non-English control labels do not yet qualify as action names.

### Fixed

- Vue bound attributes (`:aria-label="t('nav.search')"`, `v-bind` expressions) are no longer mistaken for literal selector values, and dotted i18n-key tokens (`menu.items.search`) are rejected as selector text, so Vue single-file components stop producing locators that can never match rendered UI.

### Changed

- Observed changed-endpoint responses are now asserted, not just collected: every observed response must stay below a status ceiling derived from the handler's added code (below 400 when the diff only shows success statuses, below 500 otherwise), response-shape keys from the changed handler are emitted as promotion hints, and zero observations warn instead of failing.

- Diff-added action names are also read from button and link inner text (`<button>Apply coupon</button>`), not only from attribute labels, so flows changed by copy-level edits get named after the action instead of "primary journey".

- `qamap qa` now opens with an At a Glance section — the affected flows in one line, the single next command to run, and the one or two blocking evidence items — before the detailed report. Execution blockers already covered by a required action are no longer repeated, required items sort before recommended ones, and the missing-evidence list is capped with a summary line.

## 0.3.2 - 2026-07-04

### Added

- Added a reverse import graph: when only shared components, hooks, or library files change, QAMap now follows imports (2 hops, tsconfig paths and workspace package names included) to the pages and screens that consume them, generates the consuming surface's UI flow with the import chain as evidence, and matches verification/flow/domain manifests through the same expansion.
- Draft steps and assertions now prefer selectors and labels that the diff itself introduced: added `aria-label`/`data-testid`/`testID`/placeholder values rank first when binding actions, gated by step intent so added status copy becomes an assertion target rather than a click target. Selectors carry an `addedInDiff` marker in JSON output.
- Domain scenarios are named after the action the diff introduced when an added element label makes one clear (for example "Checkout Submit" instead of "Checkout primary journey"), and labels carrying an action word win over plain field labels.
- Added `scripts/bench.mjs` (`pnpm bench`): a read-only benchmark runner that scores plan/qa output against pinned repositories, with runner-accuracy, must-reach recall, import-propagation, diff-anchoring, blank-action, and generic-title metrics; documented in `docs/benchmarking.md`.

### Changed

- Running `qamap` with no arguments now prints a short "start here" guide (the three core commands and when to use them) instead of the full usage wall; the full reference moved to `qamap help` and stays on `--help`.
- The README demo is a real, unedited terminal recording of the zero-tests-to-passing-E2E loop against the published package, replacing the earlier staged walkthrough.
- Fixtures, documentation examples, and CLI usage samples were standardized on a clearly invented demo vocabulary so examples cannot be mistaken for any real product.

### Fixed

- Monorepo roots without framework dependencies of their own (turbo/pnpm/yarn workspaces where apps live under `apps/`, `services/`, or `packages/`) are no longer classified as unknown/manual: project detection aggregates workspace member dependencies, with per-member evidence, so a frontend monorepo gets a web/Playwright recommendation at the root.
- Django-style Python service files with prefixed names (`views_summary.py`) or inside service module directories (`views/report_export.py`) are now classified as service sources, so backend changes join API contract flows instead of disappearing from the plan.
- Draft steps no longer emit blank actions for non-Latin UI labels: Korean (and any Unicode) placeholder, aria-label, and button text now survives step naming, with a selector-kind fallback when a label is symbol-only.
- Domain scenario names no longer duplicate the "primary journey" suffix.

## 0.3.1 - 2026-07-03

### Fixed

- Removed the stale animated README demo that still showed the previous project name and `.codeward/flows.yml` manifest path.
- Kept the public demo text-first until a fresh recording can show the current `@ivorycanvas/qamap` package, `.qamap/manifest.yaml`, and real CLI output.

## 0.3.0 - 2026-07-03

### Added

- Bound manifest check hints to generated Playwright draft steps, so declared selectors, values, and routes in check text shape executable actions instead of fuzzy keyword matches.
- Added changed-endpoint observation scaffolds: endpoints implemented by files in the diff are observed with real responses in drafts instead of being auto-mocked with placeholder bodies.
- Added `qamap qa --format agent`: a compact single-line JSON summary (`schema: qamap.qa` v1) with affected flows, required evidence, bootstrap blockers, PR checklist, and validation commands, sized for coding-agent context windows.
- Generated agent context (`qamap context`) now includes a Pre-PR QA section that tells agents to run `qamap qa` before opening a pull request.

### Changed

- Renamed the project, npm package, CLI binary, config files, manifest directory, schema files, rule ids, and docs from the previous project name to QAMap (`@ivorycanvas/qamap` on npm, `qamap` as the CLI binary, `qamap.config.json`, `.qamap/`, `QM###` rule ids) to avoid a naming collision with an unrelated existing product.
- Generated draft files are excluded from test-suite evidence, so readiness scores no longer rise just because the tool wrote its own unexecuted drafts into the repository.

## 0.2.1 - 2026-07-03

### Added

- Added advisory context capture to `qamap manifest init`, including `CONTEXT.md`, ADRs, goal documents, agent instruction files, and QA/test/release runbooks as manifest context sources.
- Added inferred manifest `context.validationCommands` and `context.safetyRules` so teams can see which repo-local instructions shaped the baseline without treating them as product truth.
- Added `qamap manifest context` as a read-only preview for repo-local context sources, role summaries, validation commands, safety rules, and context repair diagnostics.
- Added next-action and repair-hint guidance to manifest recommendations so `verify`, `e2e plan`, `e2e draft`, and `manifest explain` show how to turn a recommendation into reusable repo policy.
- Added role classification for repo-local harness, skill, instruction, and runbook files so manifest context can distinguish agent skills, harness config, workflow lifecycle, verification rubric, safety policy, release policy, and test runner hints.
- Added a manifest bootstrap PoC path where repo-local context filenames such as ADRs can sharpen inferred flow names, then matched PR changes can produce concrete Playwright draft actions from detected input and submit selectors.
- Added `--manifest <file>` support to manifest validation/explanation, `verify`, and E2E plan/draft commands so teams can preview an external generated manifest without writing it into the target repository.
- Added `qamap qa` as a manifest-free local QA skill entrypoint that turns a PR diff into a PR comment/checklist draft with affected flow, recommended runner, suggested E2E/checklist path, missing evidence, and agent handoff guidance.
- Added a packaged `skills/qamap-pr-qa/SKILL.md` template so local agent workflows can run QAMap before PR handoff without requiring users to rewrite the workflow prompt.

### Changed

- Refined README, quick start, roadmap, and release validation docs around the sharper product thesis: repo-local QA manifest plus PR-to-E2E draft, rather than generic test generation.
- Expanded manifest docs and quick-start examples to show the full default-branch manifest baseline, PR explanation, E2E draft, and manifest repair loop.
- Documented a read-only adoption preview flow using `manifest init --write /tmp/qamap-manifest.yaml` plus `e2e draft --manifest /tmp/qamap-manifest.yaml`.
- Repositioned README and quick-start docs so first use starts with `qamap qa`, while `.qamap/manifest.yaml` is presented as an optional accuracy upgrade rather than a setup gate.
- Included `skills` in the npm package file list so the PR QA skill template ships with the CLI package.

## 0.2.0 - 2026-07-01

### Added

- Added `qamap manifest init` to create a baseline `.qamap/manifest.yaml` with inferred domains, flows, anchors, checks, runner hints, source, and confidence.
- Added `qamap manifest validate` to check manifest presence, schema shape, duplicate ids, stale anchors, route hints, and low-confidence inferred entries.
- Added `qamap manifest explain` to show which manifest domains, flows, and checks match a branch and which manifest path should be corrected when a recommendation is wrong.
- Added `schema/qamap-manifest.schema.json` and `$schema` output in generated manifests for editor validation and a documented manifest contract.
- Added verification manifest matches to `e2e plan`, `e2e draft`, and `verify` output so recommendations explain why they were made and which manifest path to update when they are wrong.
- Promoted matched verification manifest flows into generated E2E drafts so declared entry routes and checks shape Playwright, Maestro, and manual draft content before heuristic candidates.

### Changed

- Improved Expo direct `app/*.tsx` manifest baselines so screen domains use specific file paths and special files such as `+not-found.tsx` are not promoted as product domains.
- Updated release, configuration, and E2E output documentation around the 0.2.0 manifest feedback loop.

## 0.1.1 - 2026-07-01

Documentation and launch polish release.

### Changed

- Refreshed the README first screen with `Install & Quick Start`, npm install commands, and clearer local-first/no-LLM-token positioning.
- Added a 30-second demo GIF and quick start walkthrough showing how a checkout-form PR becomes a domain-aware Playwright draft.
- Updated npm package metadata keywords and description to match the PR verification and E2E draft generation positioning.

## 0.1.0 - 2026-07-01

Initial public release.

### Added

- Repository guardrail scanning for AI-agent instructions, MCP config, committed local env files, risky scripts, broad workflow permissions, and API contract source-of-truth gaps.
- Text, JSON, Markdown, and SARIF reporting.
- PR-oriented `review`, `eval`, and `verify` commands for branch-aware findings, readiness scoring, validation evidence, and suggested domain tests.
- GitHub Action entrypoint with annotations, step summary, and PR comment output.
- Validation command discovery for JavaScript/TypeScript, Python, Go, Rust, Gradle, and Maven projects.
- E2E planning and draft generation for Playwright, Maestro, and manual checklists.
- CLI package detection that produces command verification checklists for valid arguments, failure paths, stdout/stderr, generated files, and exit codes instead of browser/device journeys.
- Bootstrap planning for projects with little or no E2E history, including required runner setup, first-draft, fixture, selector, and validation steps.
- Execution profiles, draft self-checks, readiness summaries, and action items that distinguish `runnable-candidate`, `near-runnable`, and `review-only` drafts.
- Domain language, domain manifest, and core-flow manifest support through `.qamap/domains.yml` and `.qamap/flows.yml`.
- Change-aware `domains suggest` and `flows suggest` commands that draft manifest entries from branch context before teams commit durable policy.
- Manifest suggestion promotion plans that classify candidates as `commit-candidate`, `needs-review`, or `low-signal`.
- Fixture/mock readiness and validation matrix output for generated E2E plans and drafts.
- API-dependent Playwright draft scaffolds with endpoint hints and `page.route(...).fulfill(...)` mock slots.
- Next.js App Router, Next Pages Router, React Router route-object, link, and navigation route inference, including dynamic route parameter placeholders or concrete route hints when available.
- `qamap e2e draft --dry-run` to preview planned files, readiness, action items, self-checks, and blockers without writing draft files.
- Design token and data catalog project profiles that produce artifact/catalog validation checklists instead of browser or device journeys.
- Local E2E run history snapshots protected by generated `.gitignore` entries.
- `coverage` and `release:check` scripts for the final local release gate.
- README and adoption guidance for repo-local verification bases, shared domain/flow manifests, and ignored generated run history.
- More conservative data-catalog and config/content E2E planning heuristics so generic package schemas or release docs do not create catalog journeys or API fixture blockers.
