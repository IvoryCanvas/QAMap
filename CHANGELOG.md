# Changelog

## Unreleased

## 0.3.0 - 2026-07-03

### Added

- Bound manifest check hints to generated Playwright draft steps, so declared selectors, values, and routes in check text shape executable actions instead of fuzzy keyword matches.
- Added changed-endpoint observation scaffolds: endpoints implemented by files in the diff are observed with real responses in drafts instead of being auto-mocked with placeholder bodies.
- Added `qamap qa --format agent`: a compact single-line JSON summary (`schema: qamap.qa` v1) with affected flows, required evidence, bootstrap blockers, PR checklist, and validation commands, sized for coding-agent context windows.
- Generated agent context (`qamap context`) now includes a Pre-PR QA section that tells agents to run `qamap qa` before opening a pull request.

### Changed

- Renamed the project, package, CLI binary, config files, manifest directory, schema files, rule ids, and docs from the previous project name to QAMap (`qamap` on npm, `qamap.config.json`, `.qamap/`, `QM###` rule ids) to avoid a naming collision with an unrelated existing product.
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
