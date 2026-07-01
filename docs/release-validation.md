# 0.2.0 Release Validation

CodeWard should not publish a new minor version only because the CLI commands work in fixtures. The `0.2.0` release should prove that the verification manifest loop is useful across representative repositories without requiring an LLM call.

## Release Bar

CodeWard is ready for `0.2.0` when the commands below produce useful, reviewable output for each representative repository type:

- repository baseline generation with `.codeward/manifest.yaml`
- manifest validation that catches stale or ambiguous team verification policy
- branch-level manifest explanation with clear update paths
- manifest-driven E2E drafts that use declared routes and checks before heuristic candidates
- web app with Playwright-compatible routes and components
- mobile or Expo/React Native app with Maestro-compatible screens
- API or backend service repo with contract-oriented checklist output
- CLI package with command-oriented checklist output
- monorepo package scanned with `--workspace-root`
- monorepo root that points reviewers to changed app/package targets
- test-light project with little or no existing E2E coverage
- API-dependent UI flow that needs deterministic mock or fixture data
- evidence-only branches where only tests, docs, or generated output changed

For each target, record:

- command used
- base/head refs or working-tree mode
- recommended runner
- generated flow language brief quality
- draft readiness summary
- draft self-check status and blockers
- required and recommended draft action items
- previewed or generated file paths
- manual notes about false positives, missing context, or weak selectors

## Required Commands

Run these from a clean checkout of CodeWard before any release candidate:

```sh
pnpm run release:check
```

`release:check` expands to the required local suite: `pnpm test`, `pnpm scan`, `git diff --check`, coverage thresholds, and `pnpm pack --dry-run`. If a release candidate fails, run the individual command directly to inspect the failure.

Run the npm publish preview after the local release gate passes:

```sh
npm publish --dry-run --access public
```

Run these against every representative target repository:

```sh
node dist/cli.js e2e plan <target> --base <base> --head <head> --format markdown
node dist/cli.js e2e plan <target> --base <base> --head <head> --format json
node dist/cli.js e2e draft <target> --base <base> --head <head> --output <tmp-output-dir> --dry-run
node dist/cli.js e2e draft <target> --base <base> --head <head> --output <tmp-output-dir>
node dist/cli.js e2e draft <target> --base <base> --head <head> --output <tmp-output-dir> --force --json
node dist/cli.js manifest init <target> --write <tmp-manifest-file> --force --format json
node dist/cli.js manifest validate <target> --format markdown
node dist/cli.js manifest explain <target> --base <base> --head <head> --format markdown
```

For monorepos, include:

```sh
node dist/cli.js e2e plan <package> --workspace-root <repo-root> --base <base> --head <head> --format markdown
node dist/cli.js e2e draft <package> --workspace-root <repo-root> --base <base> --head <head> --output <tmp-output-dir> --dry-run
node dist/cli.js e2e draft <package> --workspace-root <repo-root> --base <base> --head <head> --output <tmp-output-dir>
```

## Expected Evidence

The E2E plan should show:

- runner recommendation with clear evidence
- execution profile with start command, test command, base URL or app id when discoverable, confidence, and blockers
- runner setup proposal with install commands, explicit `codeward e2e setup` acceptance command, files to create/update, and next commands when the repo lacks an E2E runner
- setup output that reports the first generated changed-flow draft file after the accepted runner setup is applied
- bootstrap steps when the project lacks E2E setup
- domain language and candidate user scenarios
- matched `.codeward/domains.yml` or `.codeward/flows.yml` entries when present
- validation matrix rows for fixture, coverage, setup, and testability gaps

The E2E draft should show:

- `verification-manifest` as the draft source when a matched manifest flow is strong enough
- manifest evidence comments inside generated drafts
- manifest checks converted into draft steps or coverage notes
- previewed or generated Maestro, Playwright, or manual draft files
- `dryRun` mode and `preview` file status when `--dry-run` is used
- `languageBrief` for each draft file
- `promotionStatus` for each draft file
- `runnableStatus` and execution blockers for each draft file
- `selfCheck` status, summary, command, warnings, and blockers for each generated draft file
- `actionItems` grouped by assertion, fixture, selector, runner, validation, or manifest
- `actionSummary` with required and recommended action counts
- `readinessSummary` with score, level, self-check counts, TODO counts, execution blocker counts, and top blockers
- Playwright `test.step()` names that read like the product journey

The manifest commands should show:

- generated `$schema` pointing at `schema/codeward-manifest.schema.json`
- domains with narrow enough path patterns to explain matches
- flows with anchors and checks that can shape generated drafts
- `manifest validate` status, issue counts, and concrete recommendations
- `manifest explain` matches with confidence, entry route, required checks, evidence path, and update path

## Current Fixture Evidence Matrix

The matrix below is public, fixture-backed evidence from the repository test suite. It is not a substitute for final manual validation against real projects, but it proves the release bar with reproducible scenarios that can run in CI without an LLM call.

| Target | Fixture-backed coverage | Expected output |
| --- | --- | --- |
| Verification manifest loop | `manifest init creates a baseline verification manifest`; `manifest init keeps Expo app file domains specific`; `manifest matches explain e2e and verify recommendations`; `manifest validate reports missing and stale manifest policy` | Generated `.codeward/manifest.yaml` includes `$schema`, domains, flows, anchors, checks, runner, source, and confidence; validator reports missing/stale/duplicate policy; explain output maps branch changes to manifest domains/flows/checks; E2E drafts prefer `verification-manifest` sources with manifest evidence and required checks. |
| Web app with Playwright routes | `generateE2ePlan matches committed core flow definitions`; `generateE2eDraft uses web selectors in Playwright specs`; `generateE2eDraft dry run previews files without writing drafts`; `generateE2eDraft asserts changed HTML success copy in Playwright specs`; `generateE2ePlan captures Playwright execution profile and self-check blockers`; `generateE2ePlan infers Playwright base URLs from dev scripts`; `generateE2eDraft supports Next app router route groups and concrete route hints`; `generateE2ePlan reads React Router object route paths`; `generateE2eDraft fills dynamic route params from concrete route hints`; `generateE2eDraft emits runnable Playwright role and input actions` | `Web` project profile, `playwright` runner, core-flow names such as `Checkout purchase`, route-aware Playwright drafts, dry-run preview status without filesystem writes, stable selector hints, changed HTML success copy assertions, execution profile, dev-script base URL hints, opt-in Playwright setup proposal, Next App Router route groups, React Router object paths, dynamic route params, draft self-check status, action items, and validation gaps. |
| Expo / React Native mobile app | `generateE2ePlan recommends mobile flows for Expo changes`; `generateE2ePlan detects Maestro app ids from app config files`; `generateE2eDraft scopes entrypoint hints to each domain scenario`; `generateE2eDraft names changed component actions before generic primary journeys` | `Expo / React Native` project profile, `maestro` runner, app id and launch command hints from `app.json` or `app.config.*`, Maestro YAML drafts, `testID`/`accessibilityLabel` selector hints, action-specific scenario names such as `Offer Content URL Submit`, and mobile setup actions. |
| API or backend service | `generateE2ePlan detects API service projects and suggests contract checklists`; `generateE2ePlan detects Django service apps from a workspace root`; `generateE2ePlan names versioned API service paths with domain language`; `generateE2ePlan uses matched core flow names for API service contracts` | `API / service` project profile, manual contract checklist, Django/FastAPI-style service signals when present, domain-aware titles such as `Offer API contract`, API consumer actor, endpoint/handler/service-path trigger, service start/test command hints, and contract failure coverage. |
| CLI package | `generateE2ePlan detects CLI packages and suggests command verification checklists` | `CLI` project profile from `package.json` bin entries, manual command verification checklist, CLI user or maintainer actor language, command invocation trigger, stdout/stderr/generated-file/exit-code success signal, valid and invalid argument coverage, and no required API fixture action unless the changed command path explicitly exposes network or fixture evidence. |
| Design tokens and data catalogs | `generateE2ePlan detects design token packages and suggests artifact validation`; `generateE2ePlan detects data catalog repositories and suggests catalog verification` | `Design tokens` and `Data catalog` project profiles, manual artifact/catalog checklist, token or catalog actor language, schema/generated output/consumer fixture coverage, fixture readiness marked not needed for API mocks, and validation matrix rows that do not require browser/device selectors. |
| Monorepo root and package targeting | `generateE2ePlan surfaces package-scoped targets for monorepo root changes`; `generateE2ePlan matches workspace core flows for package scans`; `generateTestPlan scopes monorepo changes to the requested package` | Root plans list changed app/package targets with package names, project type, runner, and scoped commands; package scans keep package-local changed files, workspace-level `.codeward/flows.yml` matches, package-local generated drafts, and no leaked workspace path prefixes in package drafts. |
| Release and package metadata | `generateE2ePlan avoids turning release metadata into domain journeys`; `generateE2ePlan keeps package release metadata out of product workflows`; `generateE2ePlan treats agent and repo metadata as configuration, not product journeys` | Changelog, changeset, release manifest, package version, and repo metadata changes produce maintainer/release-operator configuration verification flows instead of product journeys or user-facing E2E drafts. |
| Test-light project | `generateE2ePlan builds a bootstrap plan for projects without tests`; `generateE2ePlan infers Playwright base URLs from dev scripts`; `generateE2eDraft creates a fallback smoke draft without changed files` | Required bootstrap steps for runner setup, opt-in `codeward e2e setup`, generated setup output that includes the first changed-flow draft file, fixture/mock data, testability, and validation evidence before generated drafts are treated as regression coverage. |
| API-dependent UI flow | `generateE2ePlan flags missing mock fixtures for API-dependent UI flows` | Playwright-compatible UI flow plus fixture/mock readiness actions, inferred endpoint hints, and route-fulfillment scaffold slots for success, empty, unauthorized, timeout, and server-error responses. |
| Existing test evidence | `generateE2ePlan evaluates existing test suite coverage evidence`; `generateE2ePlan keeps generic test filenames from overmatching unrelated services` | Coverage evidence rows that distinguish covered, partial, and missing targets without matching unrelated generic test filenames. |
| Evidence-only changes | `generateE2ePlan treats test-only changes as evidence verification, not product journeys`; `generateE2ePlan treats docs-only changes as documentation verification`; `generateE2ePlan treats generated-only changes as generated artifact verification` | Test-only, docs-only, and generated-output-only branches produce maintainer-oriented evidence checklists instead of product journeys inferred from filenames such as `admin-primary-journey.spec.ts` or generated API clients. |

See [E2E output examples](e2e-output-examples.md) for the kind of plan and draft snippets users should see from the `0.2.0` release.

## Latest PR Validation Snapshot

Last verified on 2026-07-01 on PR #70 after adding the verification manifest baseline, `manifest validate`, `manifest explain`, manifest-driven draft shaping, and Expo direct `app/*.tsx` baseline fixes:

| Check | Result |
| --- | --- |
| `pnpm test` | 84 tests passed. |
| `pnpm scan` | 0 findings. |
| `git diff --check` | Passed. |
| `pnpm pack --dry-run` | Passed; tarball includes `dist`, `docs`, `schema`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`. |
| Coverage threshold | Passed the 80% line, branch, and function gates; latest runs remain above 85% line, 82% branch, and 93% function coverage. |
| `pnpm run release:check` | Passed as the single local release gate for this PR state. |
| `npm publish --dry-run --access public` | Passed for `@ivorycanvas/codeward@0.2.0`; tarball includes `schema/codeward-manifest.schema.json` and `docs/manifest.md`. |

## Real Repository Smoke Snapshot

The latest smoke run used private representative repositories and wrote draft output only under `/tmp/codeward-preview-*`. The smoke commands did not run `e2e setup` or write generated files into the target repositories. The table records public-safe target shapes rather than private repository names.

| Target shape | Base/head mode | Result | Follow-up signal |
| --- | --- | --- | --- |
| Expo / React Native manifest baseline | `manifest init` wrote only to `/tmp/codeward-mood-note-manifest.yaml` | Generated 9 domains, 8 flows, 8 anchors, and 16 checks without changing the target repo. Direct `app/*.tsx` screens now produce specific paths such as `app/EmotionChatPage.tsx`; `+not-found.tsx` is not promoted as a product domain. | Good 0.2.0 signal for baseline quality. Remaining work is richer screen/route semantics and selector-specific checks. |
| Web monorepo package | Package scan with `--workspace-root`, feature branch compared with `main`, working tree included | Detected `web`, recommended Playwright, inferred a concrete route, produced changed-flow specs, and correctly blocked promotion because Playwright config, deterministic fixture/mock data, selector evidence, and validation evidence were missing. | Flow naming improved, but docs/design-only files can still create low-signal drafts that should be filtered or demoted. |
| Expo / React Native app | Feature branch compared with `develop`, working tree included | Detected `expo-react-native`, recommended Maestro, found an existing Jest suite, produced multiple near-runnable YAML drafts, and gave useful blockers for missing Maestro directory plus missing stable mobile selectors. | Strongest current real-repo result; remaining gap is selector and app-specific setup quality. |
| Nuxt / Vue web app with existing Playwright tests | `origin/develop` to `HEAD`, working tree included | Detected `web`, recommended Playwright, recognized existing test evidence, and blocked draft promotion because no Playwright config or runnable route/screen entrypoint was inferred. | Test-only or generated-test changes can still produce generic smoke draft names; CodeWard should better distinguish changed tests from changed product behavior. |
| Django-style API service | `origin/develop` to `HEAD`, working tree included | Detected `api-service`, selected manual output, found a large pytest suite, generated API contract and configuration checklists with zero TODOs, and avoided browser/device runner assumptions. | Good service classification; fixture readiness should become more endpoint-specific. |
| Design token repository | `main` to `HEAD`, working tree included | Detected `design-tokens`, selected manual output, avoided browser/device selector requirements, and produced review-only artifact validation output. | Docs-only or style-only changes may still surface content/theme wording instead of token artifact language. |
| Taxonomy / data catalog repository | `main` to `HEAD`, working tree included | Detected `data-catalog`, selected manual output, avoided API mock requirements, and produced review-only checklist output with no TODOs. | Catalog-specific changes are handled, but docs/config-only changes should be labeled more explicitly as low-signal. |

Interpretation: the `0.2.0` release should be described as a planner that removes blank-page verification work by combining static analysis with repo-local manifest memory. The smoke results are useful, but they also show that many real repositories will start at `review-only` or `near-runnable` until teams add runner config, selectors, fixtures, validation evidence, and durable manifests.

## Ongoing Validation Notes

The release candidate has passed the fixture-backed suite, package dry-run, npm publish dry-run, and representative private-repository smoke checks recorded above. For future patch releases, record only public-safe notes in this document or in release notes:

- whether the generated flow names match the team's domain language
- whether the recommended runner is plausible
- whether generated drafts identify the right actor, trigger, success signal, and edge cases
- whether action items are concrete enough for a developer to convert into runnable tests
- whether false positives are caused by missing manifests, weak selectors, or unsupported project structure
- whether test-only, docs-only, or generated-output-only changes are clearly demoted instead of being presented as product journeys

## Stop Conditions

Do not publish `0.2.0` if any representative target shows one of these problems:

- generated flow names are dominated by generic folder names instead of product language
- test-only or docs-only changes are presented as confident product journeys without low-signal wording
- execution profiles hide missing start commands, base URLs, app ids, or runner config needed to run generated drafts
- draft self-checks fail to report unresolved placeholder locators, route params, missing runner structure, or TODO-heavy generated files
- monorepo package scans report workspace-root paths in generated package-local drafts
- Playwright drafts cannot express dynamic route parameters with fixture placeholders
- API-dependent flows fail to produce fixture or mock readiness actions or concrete endpoint-based mock scaffold slots
- manifest baselines are dominated by broad catch-all paths such as `app/**` when file-specific screen paths are available
- manifest recommendations do not show why they happened or which manifest path to update
- draft Markdown or JSON omits required action items for selector, fixture, setup, or validation gaps
- generated files overwrite existing files without `--force`
- `pnpm pack --dry-run` excludes required runtime files

## Release Notes Checklist

For every publish candidate, update or confirm:

- `README.md` install section
- README and adoption docs for the working-base / verification-base positioning
- `CHANGELOG.md`
- [release runbook](releasing.md)
- GitHub Action release tag notes, if the action is versioned with the package
- package provenance or npm publishing notes
