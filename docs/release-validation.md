# 0.1.0 Release Validation

CodeWard should not publish the first public package only because the package metadata is ready. The first release should prove that the E2E planning workflow is useful across representative repositories without requiring an LLM call.

## Release Bar

CodeWard is ready for `0.1.0` when the commands below produce useful, reviewable output for each representative repository type:

- web app with Playwright-compatible routes and components
- mobile or Expo/React Native app with Maestro-compatible screens
- API or backend service repo with contract-oriented checklist output
- monorepo package scanned with `--workspace-root`
- monorepo root that points reviewers to changed app/package targets
- test-light project with little or no existing E2E coverage
- API-dependent UI flow that needs deterministic mock or fixture data

For each target, record:

- command used
- base/head refs or working-tree mode
- recommended runner
- generated flow language brief quality
- draft readiness summary
- draft self-check status and blockers
- required and recommended draft action items
- generated file paths
- manual notes about false positives, missing context, or weak selectors

## Required Commands

Run these from a clean checkout of CodeWard before any release candidate:

```sh
pnpm test
pnpm scan
git diff --check
pnpm pack --dry-run
node --test --experimental-test-coverage --test-coverage-include='dist/**/*.js' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 test/*.test.mjs
```

Run these against every representative target repository:

```sh
node dist/cli.js e2e plan <target> --base <base> --head <head> --format markdown
node dist/cli.js e2e plan <target> --base <base> --head <head> --format json
node dist/cli.js e2e draft <target> --base <base> --head <head> --output <tmp-output-dir>
node dist/cli.js e2e draft <target> --base <base> --head <head> --output <tmp-output-dir> --force --json
```

For monorepos, include:

```sh
node dist/cli.js e2e plan <package> --workspace-root <repo-root> --base <base> --head <head> --format markdown
node dist/cli.js e2e draft <package> --workspace-root <repo-root> --base <base> --head <head> --output <tmp-output-dir>
```

## Expected Evidence

The E2E plan should show:

- runner recommendation with clear evidence
- execution profile with start command, test command, base URL or app id when discoverable, confidence, and blockers
- bootstrap steps when the project lacks E2E setup
- domain language and candidate user scenarios
- matched `.codeward/domains.yml` or `.codeward/flows.yml` entries when present
- validation matrix rows for fixture, coverage, setup, and testability gaps

The E2E draft should show:

- generated Maestro, Playwright, or manual draft files
- `languageBrief` for each draft file
- `promotionStatus` for each draft file
- `runnableStatus` and execution blockers for each draft file
- `selfCheck` status, summary, command, warnings, and blockers for each generated draft file
- `actionItems` grouped by assertion, fixture, selector, runner, validation, or manifest
- `actionSummary` with required and recommended action counts
- `readinessSummary` with score, level, self-check counts, TODO counts, execution blocker counts, and top blockers
- Playwright `test.step()` names that read like the product journey

## Current Fixture Evidence Matrix

The matrix below is public, fixture-backed evidence from the repository test suite. It is not a substitute for final manual validation against real projects, but it proves the release bar with reproducible scenarios that can run in CI without an LLM call.

| Target | Fixture-backed coverage | Expected output |
| --- | --- | --- |
| Web app with Playwright routes | `generateE2ePlan matches committed core flow definitions`; `generateE2eDraft uses web selectors in Playwright specs`; `generateE2ePlan captures Playwright execution profile and self-check blockers`; `generateE2ePlan infers Playwright base URLs from dev scripts`; `generateE2eDraft supports Next app router route groups and concrete route hints`; `generateE2ePlan reads React Router object route paths`; `generateE2eDraft fills dynamic route params from concrete route hints`; `generateE2eDraft emits runnable Playwright role and input actions` | `Web` project profile, `playwright` runner, core-flow names such as `Checkout purchase`, route-aware Playwright drafts, stable selector hints, execution profile, dev-script base URL hints, Next App Router route groups, React Router object paths, dynamic route params, draft self-check status, action items, and validation gaps. |
| Expo / React Native mobile app | `generateE2ePlan recommends mobile flows for Expo changes`; `generateE2ePlan detects Maestro app ids from app config files`; `generateE2eDraft scopes entrypoint hints to each domain scenario` | `Expo / React Native` project profile, `maestro` runner, app id and launch command hints from `app.json` or `app.config.*`, Maestro YAML drafts, `testID`/`accessibilityLabel` selector hints, and mobile setup actions. |
| API or backend service | `generateE2ePlan detects API service projects and suggests contract checklists`; `generateE2ePlan detects Django service apps from a workspace root`; `generateE2ePlan names versioned API service paths with domain language`; `generateE2ePlan uses matched core flow names for API service contracts` | `API / service` project profile, manual contract checklist, Django/FastAPI-style service signals when present, domain-aware titles such as `Offer API contract`, API consumer actor, endpoint/handler/service-path trigger, service start/test command hints, and contract failure coverage. |
| Design tokens and data catalogs | `generateE2ePlan detects design token packages and suggests artifact validation`; `generateE2ePlan detects data catalog repositories and suggests catalog verification` | `Design tokens` and `Data catalog` project profiles, manual artifact/catalog checklist, token or catalog actor language, schema/generated output/consumer fixture coverage, fixture readiness marked not needed for API mocks, and validation matrix rows that do not require browser/device selectors. |
| Monorepo root and package targeting | `generateE2ePlan surfaces package-scoped targets for monorepo root changes`; `generateE2ePlan matches workspace core flows for package scans`; `generateTestPlan scopes monorepo changes to the requested package` | Root plans list changed app/package targets with package names, project type, runner, and scoped commands; package scans keep package-local changed files, workspace-level `.codeward/flows.yml` matches, package-local generated drafts, and no leaked workspace path prefixes in package drafts. |
| Release and package metadata | `generateE2ePlan avoids turning release metadata into domain journeys`; `generateE2ePlan keeps package release metadata out of product workflows`; `generateE2ePlan treats agent and repo metadata as configuration, not product journeys` | Changelog, changeset, release manifest, package version, and repo metadata changes produce maintainer/release-operator configuration verification flows instead of product journeys or user-facing E2E drafts. |
| Test-light project | `generateE2ePlan builds a bootstrap plan for projects without tests`; `generateE2eDraft creates a fallback smoke draft without changed files` | Required bootstrap steps for runner setup, first draft generation, fixture/mock data, testability, and validation evidence before generated drafts are treated as regression coverage. |
| API-dependent UI flow | `generateE2ePlan flags missing mock fixtures for API-dependent UI flows` | Playwright-compatible UI flow plus fixture/mock readiness actions, inferred endpoint hints, and route-fulfillment scaffold slots for success, empty, unauthorized, timeout, and server-error responses. |
| Existing test evidence | `generateE2ePlan evaluates existing test suite coverage evidence`; `generateE2ePlan keeps generic test filenames from overmatching unrelated services` | Coverage evidence rows that distinguish covered, partial, and missing targets without matching unrelated generic test filenames. |

See [E2E output examples](e2e-output-examples.md) for the kind of plan and draft snippets users should see before `0.1.0`.

## Latest Main Validation Snapshot

Last verified on 2026-07-01 after merging the E2E mock scaffold and route inference work:

| Check | Result |
| --- | --- |
| `pnpm test` | 69 tests passed. |
| `pnpm scan` | 0 findings. |
| `git diff --check` | Passed. |
| `pnpm pack --dry-run` | Passed; tarball includes `dist`, `docs`, `schema`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`. |
| Coverage threshold | Passed with lines 84.79%, branches 82.19%, functions 93.31%. |

## Real Repository Smoke Snapshot

The latest smoke run used private representative repositories and wrote draft output only under `/tmp/codeward-0.1.0-smoke-*`. Target repository `git status --short --branch` output was identical before and after every run. The table records public-safe target shapes rather than private repository names.

| Target shape | Base/head mode | Result |
| --- | --- | --- |
| Private Expo app branch | Feature branch compared with `origin/main` | Detected `expo-react-native`, recommended Maestro, produced 4 drafts, and classified drafts as `near-runnable`. Blockers were useful: missing Maestro flow directory, missing stable `testID`/`accessibilityLabel`, and missing validation evidence. |
| Private monorepo Next package | Package scan with `--workspace-root`, recent commit range | Detected `web`, recommended Playwright, produced 1 draft, and surfaced review-only status because Playwright config, deterministic fixture/mock data, and validation evidence were missing. |
| Private Nuxt/Vue app | Recent commit range | Detected `web`, recommended Playwright, produced 2 drafts, and identified missing Playwright config, unresolved placeholders, and selector/testability work. |
| Private Expo proof-of-concept app | Feature branch compared with `origin/main` | Detected `expo-react-native`, recommended Maestro with high execution confidence, produced 4 drafts, and correctly highlighted missing stable mobile selectors. |
| Private design token repository | Recent commit range | Detected `design-tokens`, produced a manual design token artifact checklist, and avoided browser/device selector requirements. |
| Private taxonomy/catalog repository | Recent commit range | Detected `data-catalog`, produced manual taxonomy catalog verification checklists, and avoided API mock requirements. |

Interpretation: the first public release should be described as a planner that removes blank-page verification work. The smoke results are useful, but they also show that many real repositories will start at `review-only` or `near-runnable` until teams add runner config, selectors, fixtures, validation evidence, and durable manifests.

## Remaining 0.1.0 Validation Work

Before publishing the package, run the fixture-backed suite plus at least one representative real project per row above. Record only public-safe notes in this document or in release notes:

- whether the generated flow names match the team's domain language
- whether the recommended runner is plausible
- whether generated drafts identify the right actor, trigger, success signal, and edge cases
- whether action items are concrete enough for a developer to convert into runnable tests
- whether false positives are caused by missing manifests, weak selectors, or unsupported project structure

## Stop Conditions

Do not publish `0.1.0` if any representative target shows one of these problems:

- generated flow names are dominated by generic folder names instead of product language
- execution profiles hide missing start commands, base URLs, app ids, or runner config needed to run generated drafts
- draft self-checks fail to report unresolved placeholder locators, route params, missing runner structure, or TODO-heavy generated files
- monorepo package scans report workspace-root paths in generated package-local drafts
- Playwright drafts cannot express dynamic route parameters with fixture placeholders
- API-dependent flows fail to produce fixture or mock readiness actions or concrete endpoint-based mock scaffold slots
- draft Markdown or JSON omits required action items for selector, fixture, setup, or validation gaps
- generated files overwrite existing files without `--force`
- `pnpm pack --dry-run` excludes required runtime files

## Release Notes Checklist

Before publishing, update:

- `README.md` install section
- `CHANGELOG.md`
- GitHub Action release tag notes, if the action is versioned with the package
- package provenance or npm publishing notes
