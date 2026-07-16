# Release Validation

## Unreleased (0.4.5 candidate) - 2026-07-16

Validated as a traceable-reasoning, cross-domain precision, and repository-evidence ownership candidate. QAMap now exposes one inspectable path from diff evidence to affected behavior, risk, routed QA scenario, optional artifact, and explicit non-execution. It also keeps QA routing separate from draft-mapping gaps, rejects unrelated package mocks, and maps a diff-added UI action to its observable state result:

| Gate | Current result |
| --- | --- |
| `pnpm release:check` | Passed end to end without changing the package version |
| `pnpm test` | 180/180 passing |
| `pnpm scan` | 0 findings |
| `pnpm bench:ci` | 16/16 synthetic PR targets pass across web, mobile, API, shared-component, configuration, state-transition, and test-only changes; public trace fixtures reject missing scenario paths and untraceable required scenarios |
| Coverage | Lines 88.64%, branches 85.22%, functions 95.91% |
| Change Intent coverage | Lines 98.61%, branches 91.41%, functions 99.47% |
| QA trace coverage | Lines 98.26%, branches 92.13%, functions 96.77% |
| Reasoning path | Stable IDs connect diff source -> evidence-linked lifecycle -> risk -> routing -> optional draft; partial and review-only paths retain their gaps instead of being promoted |
| Product execution honesty | Human output says `not run` and `not executed`; agent output carries `execution: { status: "not-run", performed: false, scope: "static-analysis-and-draft-mapping" }` |
| Judgment precision | Persisted dates do not imply scheduling, structured metadata does not imply browser routing, local services do not imply API fixtures, and report counts come from the emitted reasoning traces |
| UI state handoff | A diff-added action selector compiles to the interaction step and repository-observed stable state copy becomes the assertion and user-facing success signal |
| Generated action integrity | Implementation-shaped setter stages cannot compile as a second user interaction; the public record-pinning target requires exactly one mapped action and one observable assertion |
| Workspace evidence ownership | A domain-neutral multi-app fixture keeps a changed asset and same-workspace endpoint evidence with the owning behavior flow while rejecting an unrelated sibling-app mock and unrelated same-app API client |
| Package preview | `pnpm pack --dry-run` passes; the package version intentionally remains unchanged until release preparation |

Human Markdown, full JSON, compact agent JSON, and generated Playwright, Maestro, or manual drafts now share the same trace ID. This keeps the reasoning layer separate from the artifact while letting a reviewer move from generated code back to the exact change, inferred consequence, and risk that caused it to exist. A `traceable` result means the reasoning provenance is connected; it never means the target product was launched or the scenario passed.

The workspace fixture models a generic multi-application repository rather than a maintainer product. It changes a user action, supporting asset, and endpoint in one application, places a similarly named mock in another application, and changes an unrelated API client in the same application. The regression contract requires natural action language, one behavior flow instead of an asset-only duplicate, usable selector evidence, relevant fixture guidance, no filename-fabricated server URL, and an explicit non-execution receipt.

The state-transition fixture models a framework-level interaction rather than a product domain: a branch adds a stable action control and conditional visible result. The benchmark requires the action selector, exact state copy, route, reasoning traces, and scenario-to-draft receipts to survive together. It also caps the primary draft at one mapped action, preventing an internal state setter from becoming a duplicate click. A unit-level negative set separately proves that date validation, structured `destination` data, ordinary local services, and substring selector matches do not fabricate unrelated QA or fixture requirements.

Machine automation values remain `compiled`, `partial`, `not-compiled`, and `review-only` for the additive v1 contract. They now have unambiguous human labels: fully mapped, partially mapped, not mapped, and review only. These values describe whether a selected scenario could be expressed as a draft; they never mean the target application ran or passed.

## 0.4.4 - 2026-07-15

Validated as a cross-framework evidence, honest-draft, and repeat-use UX patch. QAMap recovers conservative change intent from connected diff behavior even when commit text is not descriptive, maps React and Vue conditional states to changed actions and observable outcomes, keeps unsupported outcomes review-only, and can install short collision-safe package scripts for everyday branch and working-tree QA:

| Gate | Current result |
| --- | --- |
| `pnpm release:check` | Passed end to end |
| `pnpm test` | 166/166 passing |
| `pnpm scan` | 0 findings |
| `pnpm bench:ci` | 15/15 synthetic PR targets pass; React and Vue conditional-state positives recover actions/outcomes while a presentation-only negative control rejects behavioral state QA |
| Coverage | Lines 88.32%, branches 84.69%, functions 95.53% |
| Change Intent coverage | Lines 97.40%, branches 91.15%, functions 99.30% |
| Short-command initializer | Lines 100%, branches 97.14%, functions 100%; npm, pnpm, Yarn, Bun, collisions, force replacement, malformed metadata, idempotency, and CLI entry are covered |
| Agent payload | Global output stays below 4KB; complex web and mobile lifecycle fixtures retain intent/scenario/flow context in 3,172 and 3,133 bytes instead of falling back to an empty emergency summary |
| One-off repository safety | The documented npm execution command left an isolated repository's `package.json` hash unchanged and created no lockfile or package-manager metadata |
| Skill compatibility | The public repository was discovered by the `skills` CLI and `qamap-pr-qa` installed as a project skill in an isolated home/project |
| Package preview | `pnpm pack --dry-run` and `npm pack --dry-run` pass for `@ivorycanvas/qamap@0.4.4`; 137 files, 928.3 kB packed |

The React and Vue fixtures are not product-specific framework rules. They express equivalent conditional user behavior through different syntax, while the negative control proves that a presentation condition alone cannot create lifecycle QA. Benchmarks materialize temporary Git repositories, do not install fixture dependencies, and do not execute fixture applications.

Low-confidence diff-only intent remains review-required and recommended. Located lines alone do not promote it to a required blocker. When a repository exposes a stable action and observable failure outcome, QAMap can still compile a separate Playwright failure scenario; when an outcome is absent, the draft emits `test.fixme` rather than treating the clicked control or document body as proof of success.

Repeat-use setup is explicit and repository-local: `qamap init --scripts` adds `qa`, `qa:local`, and `qa:e2e` only to JavaScript package metadata, preserves conflicting script names unless `--force` is passed, and reports the package-specific install command when QAMap is not yet a dependency. The `qa` report also states whether working-tree changes were included so the two analysis scopes cannot be confused.

## 0.4.3 - 2026-07-14

Validated as an evidence-routed QA-to-automation patch. Intent-backed scenarios are selected from exact diff evidence before an adapter is chosen, and every selected scenario carries a receipt that states whether its setup, action, and assertion were compiled, partially mapped, left uncompiled, or retained for review only:

| Gate | Current result |
| --- | --- |
| `pnpm release:check` | Passed end to end |
| `pnpm test` | 148/148 passing |
| `pnpm scan` | 0 findings |
| `pnpm bench:ci` | 12/12 synthetic PR targets pass; both lifecycle fixtures preserve 4/4 exact diff traces and 4/4 scenario automation receipts |
| Coverage | Lines 87.64%, branches 84.19%, functions 95.32% |
| Required QA honesty | Required scenarios that are only partially mapped or not compiled lower readiness and remain explicit blockers instead of being hidden behind a syntactically valid draft |
| Failure-path safety | A positive fixture compiles repository-backed failure setup, action, and outcome evidence; a negative control proves an unrelated stable selector is not reused |
| Package preview | `pnpm pack --dry-run` and `npm publish --dry-run --access public` pass for `@ivorycanvas/qamap@0.4.3`; 134 files, 914.2 kB packed |

This patch does not add product-specific payment, order, or upload rules. The shared engine ranks scenarios from runner-independent evidence relations and only compiles a failure path when the repository exposes a compatible endpoint boundary, related action selector, and observable outcome. Review-only and incomplete mappings remain visible to humans and agents rather than being presented as runnable E2E coverage.

## 0.4.2 - 2026-07-13

Validated as an automation-readiness honesty patch. Benchmark contracts now fail when QAMap finds a plausible flow but emits a draft that cannot be tried, and generated Playwright failure paths require a repository-observed endpoint, stable action, and visible failure outcome before QAMap writes executable steps:

| Gate | Current result |
| --- | --- |
| `pnpm release:check` | Passed end to end |
| `pnpm test` | 146/146 passing |
| `pnpm scan` | 0 findings |
| `pnpm bench:ci` | 12/12 synthetic PR targets pass; readiness, runnable-candidate, self-check, TODO, review-only, and execution-blocker contracts are enforced |
| Coverage | Lines 87.53%, branches 84.18%, functions 95.22% |
| Existing Playwright golden | Improved from `needs-work 67` with one blocker to `near-runnable 97`, one runnable candidate, and zero execution blockers |
| Honest weak-draft handling | Testless checkout and shared-component fixtures remain `needs-work 48` because missing execution facts and body-only assertions are not promoted to runnable evidence |
| Package preview | `pnpm pack --dry-run` and `npm publish --dry-run --access public` pass for `@ivorycanvas/qamap@0.4.2`; 129 files, 828.8 kB packed |

This patch does not claim that all generated E2E files are green in their target applications. It makes that gap measurable: repository validation guidance no longer masquerades as a generated-file execution blocker, body-only smoke assertions remain warnings, and only evidence-backed failure flows compile into Playwright actions and assertions.

## 0.4.1 - 2026-07-13

Validated as an evidence-first QA patch. A proposed scenario now exposes the commit or exact base/head diff file, line, symbol, hunk, and direct/supporting/contextual relation that caused it. Removed guards remain visible as base-side critical evidence, contextual-only scenarios cannot become critical, and runner adoption remains an explicit step after review:

| Gate | Current result |
| --- | --- |
| `pnpm release:check` | Passed end to end |
| `pnpm test` | 146/146 passing |
| `pnpm scan` | 0 findings |
| `pnpm bench:ci` | 12/12 synthetic PR targets pass; web and mobile lifecycle scenarios both retain 4/4 exact diff traces |
| Coverage | Lines 87.49%, branches 83.99%, functions 95.20% |
| Agent payload | Evidence-rich lifecycle fixtures are 5,288 and 5,659 bytes; a large real mobile branch compacts from 10,873 to 8,111 bytes while disclosing omitted counts |
| Package preview | `pnpm pack --dry-run` and `npm publish --dry-run --access public` pass for `@ivorycanvas/qamap@0.4.1`; 129 files, 825.5 kB packed |
| Read-only repository smoke | A large mobile branch and a web workspace branch were rechecked after base-side evidence and output compaction; both target worktrees remained unchanged |

The large mobile branch retained zero untraced critical scenarios. A removed release guard was tied to its exact base-side line and translated into local/development/QA/production configuration checks rather than an unrelated user-authorization scenario. Its agent payload reports 44 total intents, 2 retained intents, and 42 omitted intents within 8,111 bytes. The release-shaped web branch still had no behavior-bearing commit intent and therefore emitted four broader review-only flows with zero critical scenarios; this remains an explicit precision limit rather than promoted confidence.

## 0.4.0 - 2026-07-12

Validated as the first intent-first QA design release. The release contract starts with behavior-bearing commits and diff evidence, reconstructs an ordered behavior lifecycle, proposes runner-independent QA scenarios, and only then compiles an optional automation draft:

| Gate | Current result |
| --- | --- |
| `pnpm test` | 139/139 passing |
| `pnpm bench:ci` | 12/12 synthetic PR targets pass; dedicated web and mobile lifecycle targets require commit intent, ordered lifecycle phases, failure/boundary/state QA, observable success text, and commit-backed Behavior Graph evidence |
| Coverage | Lines 86.80%, branches 83.37%, functions 94.86% |
| Change Intent coverage | Lines 94.76%, branches 88.57%, functions 98.04% |
| `npm publish --dry-run --access public` | Passed for `@ivorycanvas/qamap@0.4.0`; 129 files, 813.8 kB packed |
| Intent-first output | Markdown, JSON, agent output, Behavior Graph, and generated drafts preserve confidence, commit evidence, lifecycle, and QA scenarios before automation-adapter guidance |
| Read-only safety | Public regression coverage uses synthetic repositories; optional local smoke validation runs from temporary copies and does not modify target repositories |

## 0.3.5 - 2026-07-11

Validated as a manifest-feedback reliability patch:

| Gate | Current result |
| --- | --- |
| `pnpm test` | 127/127 passing |
| `pnpm bench:ci` | Eight public PR fixtures pass; API and reverse-import fixtures also generate an external base manifest and require a manifest-backed head flow |
| Coverage | Lines 86.09%, branches 83.18%, functions 94.66% |
| `npm publish --dry-run --access public` | Passed for `@ivorycanvas/qamap@0.3.5`; 115 files, 772.8 kB packed |
| API manifest baseline | Common server modules produce manual contract flows with API anchors and success/failure checks |
| Domain fallback | Domain-only matches preserve manifest provenance without claiming unrelated files or inventing manifest checks |
| Privacy | Public changes use synthetic fixtures; private smoke output remains outside the repository |

## 0.3.4 - 2026-07-10

Validated before publishing `0.3.4` with a committed, CI-enforced recommendation contract instead of relying only on private smoke repositories:

| Gate | Current result |
| --- | --- |
| `pnpm test` | 124/124 passing |
| `pnpm bench:ci` | Eight public PR fixtures pass runner, flow naming, file reach, selector/evidence, command, generic-title, blank-action, and agent payload requirements |
| Coverage | Lines 86.19%, branches 83.37%, functions 94.87% |
| Reverse import fixture | Shared component change reaches and names the consuming checkout page |
| API service fixture | Backend route changes produce an API contract, not a browser UI journey |
| Agent contract | Real output validates against `schema/qamap-agent.schema.json` and stays below the 4KB fixture limit |
| Verification-only regressions | Native config changes use existing build commands without fabricated journeys; changed Maestro files are returned as existing evidence without duplicate drafts or selector/fixture noise |

## 0.3.3 - 2026-07-05

Validated before publishing `0.3.3` (at-a-glance qa verdict, diff-anchored action naming incl. button/link text and logic-only fallbacks, observed-response assertions with diff-derived status bounds, Vue bound-attribute/i18n selector fixes):

| Gate | Result |
| --- | --- |
| `pnpm test` | 103/103 passing |
| `pnpm scan` (self-scan) | 0 findings |
| Coverage thresholds (lines/branches/functions >= 80) | Passing |
| `pnpm bench` against the four pinned local benchmark targets | Runner choice 4/4, labeled must-reach recall 9/9, blank actions 0, no metric regressions vs the 0.3.2 baseline |
| README demo repository | Flow names and recorded demo unchanged |


## 0.3.2 - 2026-07-04

Validated before publishing `0.3.2` (reverse import graph, diff-anchored steps and names, workspace-member project detection, Python service classification, start-here CLI guide):

| Gate | Result |
| --- | --- |
| `pnpm test` | 100/100 passing |
| `pnpm scan` (self-scan) | 0 findings |
| Coverage thresholds (lines/branches/functions >= 80) | Passing |
| `pnpm bench` against four pinned local benchmark repositories covering common stack shapes (monorepo, API server, mobile, legacy web) | Runner choice 4/4, labeled must-reach recall 9/9, blank actions 0, no metric regressions vs the previous baseline |
| README demo | Real recorded run; the generated starter spec passes against the demo app |

Historical validation notes for earlier releases follow below.

# 0.2.1 Patch Release Validation (historical)

QAMap should not publish a patch or minor version only because the CLI commands work in fixtures. The `0.2.1` release should prove that the manifest-backed QA skill flow is useful across representative repositories without requiring an LLM call.

## Release Bar

QAMap is ready for the next public release when the commands below produce useful, reviewable output for each representative repository type:

- manifest-free `qamap qa` output that works as a PR comment/checklist draft
- packaged `skills/qamap-pr-qa/SKILL.md` template included in the npm tarball
- repository baseline generation with `.qamap/manifest.yaml`
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
- inferred change intent, confidence, commit evidence, and review requirement
- lifecycle and runner-independent QA scenario quality
- selected automation adapter
- generated flow language brief quality
- draft readiness summary
- draft self-check status and blockers
- required and recommended draft action items
- previewed or generated file paths
- manual notes about false positives, missing context, or weak selectors

## Required Commands

Run these from a clean checkout of QAMap before any release candidate:

```sh
pnpm run release:check
```

`release:check` expands to the required local suite: `pnpm test`, `pnpm scan`, `pnpm bench:ci`, `git diff --check`, coverage thresholds, and `pnpm pack --dry-run`. If a release candidate fails, run the individual command directly to inspect the failure.

Run the npm publish preview after the local release gate passes:

```sh
npm publish --dry-run --access public
```

Run these against every representative target repository:

```sh
node dist/cli.js e2e plan <target> --base <base> --head <head> --format markdown
node dist/cli.js e2e plan <target> --base <base> --head <head> --format json
node dist/cli.js qa <target> --base <base> --head <head> --format markdown
node dist/cli.js qa <target> --base <base> --head <head> --format json
node dist/cli.js e2e draft <target> --base <base> --head <head> --output <tmp-output-dir> --dry-run
node dist/cli.js qa <target> --manifest <tmp-manifest-file> --base <base> --head <head> --format markdown
node dist/cli.js e2e draft <target> --manifest <tmp-manifest-file> --base <base> --head <head> --dry-run
node dist/cli.js e2e draft <target> --base <base> --head <head> --output <tmp-output-dir>
node dist/cli.js e2e draft <target> --base <base> --head <head> --output <tmp-output-dir> --force --json
node dist/cli.js manifest init <target> --write <tmp-manifest-file> --force --format json
node dist/cli.js manifest validate <target> --manifest <tmp-manifest-file> --format markdown
node dist/cli.js manifest validate <target> --format markdown
node dist/cli.js manifest context <target> --format markdown
node dist/cli.js manifest explain <target> --manifest <tmp-manifest-file> --base <base> --head <head> --format markdown
node dist/cli.js manifest explain <target> --base <base> --head <head> --format markdown
```

For monorepos, include:

```sh
node dist/cli.js e2e plan <package> --workspace-root <repo-root> --base <base> --head <head> --format markdown
node dist/cli.js qa <package> --workspace-root <repo-root> --base <base> --head <head> --format markdown
node dist/cli.js e2e draft <package> --workspace-root <repo-root> --base <base> --head <head> --output <tmp-output-dir> --dry-run
node dist/cli.js e2e draft <package> --workspace-root <repo-root> --base <base> --head <head> --output <tmp-output-dir>
```

## Expected Evidence

The E2E plan should show:

- change intent with commit and diff evidence, confidence, and review requirement
- ordered behavior lifecycle and concrete primary, failure, boundary, and state-transition QA scenarios
- automation adapter selection after the runner-independent QA sections
- execution profile with start command, test command, base URL or app id when discoverable, confidence, and blockers
- runner setup proposal with install commands, explicit `qamap e2e setup` acceptance command, files to create/update, and next commands when the repo lacks an E2E runner
- setup output that reports the first generated changed-flow draft file after the accepted runner setup is applied
- bootstrap steps when the project lacks E2E setup
- domain language and candidate user scenarios
- matched `.qamap/domains.yml` or `.qamap/flows.yml` entries when present
- validation matrix rows for fixture, coverage, setup, and testability gaps

The E2E draft should show:

- intent evidence, lifecycle, and QA scenario comments inside generated artifacts
- `verification-manifest` as the draft source when a matched manifest flow is strong enough
- manifest evidence comments inside generated drafts
- external `--manifest <file>` previews that let teams test generated manifest quality without writing `.qamap/manifest.yaml` into target repos
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

The QA draft should show:

- no-write PR comment/checklist output from `qamap qa`
- no cloud and no LLM token positioning in the output
- change intent and lifecycle before automation setup
- primary, failure, boundary, and state-transition QA scenarios when evidence supports them
- affected flow language with changed files and reviewer question
- suggested E2E or manual checklist path
- automation adapter inherited from the E2E planner
- missing fixture, selector, assertion, runner, validation, or manifest evidence
- PR checklist items that can be pasted into a pull request
- optional manifest repair path when a manifest-backed recommendation is wrong

The packaged skill template should show:

- a concise `SKILL.md` with valid frontmatter
- a default `qamap qa` command for PR finalization
- monorepo scoped command guidance
- clear warning that QAMap output is QA planning evidence, not proof that QA passed
- manifest repair guidance for wrong or broad recommendations

The manifest commands should show:

- generated `$schema` pointing at `schema/qamap-manifest.schema.json`
- domains with narrow enough path patterns to explain matches
- flows with anchors and checks that can shape generated drafts
- `manifest validate` status, issue counts, and concrete recommendations
- `manifest explain` matches with confidence, entry route, required checks, evidence path, and update path

## Golden Demo Acceptance Bar

The public demo must prove the product shape, not only command execution. Before promoting a release, run or update a small demo where a realistic PR diff produces a concrete E2E starting point:

- The output names the affected product feature and user flow in domain language.
- The output shows the behavior-bearing commit evidence, confidence, and review requirement behind the inferred intent.
- The output orders trigger, condition, action, state change, side effect, and observable outcome before selecting a runner.
- The output proposes concrete primary, failure, boundary, and state-transition QA where evidence supports them.
- The output names the draft file that would be created or previewed.
- The draft includes route or screen entry, realistic actions, and at least one meaningful assertion.
- The report explains why the test was recommended from changed files and manifest evidence.
- The report names the manifest path to update if the recommendation is wrong.
- Remaining gaps are specific, such as auth fixture, API mock, stable selector, runner config, or validation command.
- The demo makes clear when output is `--dry-run`, `review-only`, `near-runnable`, or `runnable-candidate`.

Avoid demos that only say broad phrases such as "fixture needed", "selector missing", or "Listing flow recommended" without showing why those gaps matter for the changed behavior.

## Current Fixture Evidence Matrix

The matrix below is public, fixture-backed evidence from the repository test suite. It is not a substitute for final manual validation against real projects, but it proves the release bar with reproducible scenarios that can run in CI without an LLM call.

| Target | Fixture-backed coverage | Expected output |
| --- | --- | --- |
| Commit intent and lifecycle | `change intent clusters related commits into one evidence-backed lifecycle`; `change intent keeps unrelated feature commits separate`; `change intent ignores release-only commit metadata`; `E2E planning promotes commit intent before runner-specific draft generation` | Related feature commits become one evidence-backed intent; unrelated features remain separate; release-only changes do not become product intent; lifecycle and QA scenarios appear before Playwright or Maestro compilation; generic `primary journey` and `smoke flow` titles are suppressed when evidence supports a concrete name. |
| Manifest-free QA skill entrypoint | `qa command emits a PR comment draft without requiring a manifest` | `qamap qa` works without `.qamap/manifest.yaml`, emits a local-first PR QA draft, names affected flow, changed files, suggested E2E/checklist path, missing evidence, PR checklist, agent handoff, and says manifest is optional upgrade rather than a first-use gate. |
| Packaged PR QA skill template | `package metadata includes the portable PR QA skill template` | npm package metadata includes `skills`, and `skills/qamap-pr-qa/SKILL.md` contains the local PR QA workflow, `qamap qa` command, and manifest repair guidance. |
| Verification manifest loop | `manifest init creates a baseline verification manifest`; `manifest init keeps Expo app file domains specific`; `manifest init captures advisory instruction context`; `manifest bootstrap produces concrete PR E2E draft from repo QA memory`; `e2e draft can use an external verification manifest for read-only adoption preview`; `manifest matches explain e2e and verify recommendations`; `manifest validate reports missing and stale manifest policy` | Generated `.qamap/manifest.yaml` includes `$schema`, domains, flows, anchors, checks, runner, source, and confidence; context preview reports repo-local instruction sources, role summaries, validation commands, safety rules, and diagnostics; validator reports missing/stale/duplicate policy; explain output maps branch changes to manifest domains/flows/checks; E2E drafts prefer `verification-manifest` sources with manifest evidence, route entry, detected input/action selectors, required checks, and manifest repair paths; external manifests can be passed with `--manifest` for read-only adoption smoke tests. |
| Web app with Playwright routes | `generateE2ePlan matches committed core flow definitions`; `generateE2eDraft uses web selectors in Playwright specs`; `generateE2eDraft dry run previews files without writing drafts`; `generateE2eDraft asserts changed HTML success copy in Playwright specs`; `generateE2ePlan captures Playwright execution profile and self-check blockers`; `generateE2ePlan infers Playwright base URLs from dev scripts`; `generateE2eDraft supports Next app router route groups and concrete route hints`; `generateE2ePlan reads React Router object route paths`; `generateE2eDraft fills dynamic route params from concrete route hints`; `generateE2eDraft emits runnable Playwright role and input actions` | `Web` project profile, Playwright output adapter, intent-backed or core-flow names, route-aware drafts, dry-run preview status without filesystem writes, stable selector hints, changed HTML success copy assertions, execution profile, dev-script base URL hints, opt-in setup proposal, route groups, object paths, dynamic params, draft self-check status, action items, and validation gaps. |
| Expo / React Native mobile app | `generateE2ePlan recommends mobile flows for Expo changes`; `generateE2ePlan detects Maestro app ids from app config files`; `generateE2eDraft scopes entrypoint hints to each domain scenario`; `generateE2eDraft names changed component actions before generic primary journeys` | `Expo / React Native` project profile, Maestro output adapter, app id and launch command hints from `app.json` or `app.config.*`, YAML drafts, `testID`/`accessibilityLabel` selector hints, and mobile setup actions after runner-independent QA intent. |
| API or backend service | `generateE2ePlan detects API service projects and suggests contract checklists`; `generateE2ePlan detects Django service apps from a workspace root`; `generateE2ePlan names versioned API service paths with domain language`; `generateE2ePlan uses matched core flow names for API service contracts` | `API / service` project profile, manual contract checklist, Django/FastAPI-style service signals when present, domain-aware titles such as `Listing API contract`, API consumer actor, endpoint/handler/service-path trigger, service start/test command hints, and contract failure coverage. |
| CLI package | `generateE2ePlan detects CLI packages and suggests command verification checklists` | `CLI` project profile from `package.json` bin entries, manual command verification checklist, CLI user or maintainer actor language, command invocation trigger, stdout/stderr/generated-file/exit-code success signal, valid and invalid argument coverage, and no required API fixture action unless the changed command path explicitly exposes network or fixture evidence. |
| Design tokens and data catalogs | `generateE2ePlan detects design token packages and suggests artifact validation`; `generateE2ePlan detects data catalog repositories and suggests catalog verification` | `Design tokens` and `Data catalog` project profiles, manual artifact/catalog checklist, token or catalog actor language, schema/generated output/consumer fixture coverage, fixture readiness marked not needed for API mocks, and validation matrix rows that do not require browser/device selectors. |
| Monorepo root and package targeting | `generateE2ePlan surfaces package-scoped targets for monorepo root changes`; `generateE2ePlan matches workspace core flows for package scans`; `generateTestPlan scopes monorepo changes to the requested package` | Root plans list changed app/package targets with package names, project type, runner, and scoped commands; package scans keep package-local changed files, workspace-level `.qamap/flows.yml` matches, package-local generated drafts, and no leaked workspace path prefixes in package drafts. |
| Release and package metadata | `generateE2ePlan avoids turning release metadata into domain journeys`; `generateE2ePlan keeps package release metadata out of product workflows`; `generateE2ePlan treats agent and repo metadata as configuration, not product journeys` | Changelog, changeset, release manifest, package version, and repo metadata changes produce maintainer/release-operator configuration verification flows instead of product journeys or user-facing E2E drafts. |
| Test-light project | `generateE2ePlan builds a bootstrap plan for projects without tests`; `generateE2ePlan infers Playwright base URLs from dev scripts`; `generateE2eDraft creates a fallback smoke draft without changed files` | Required bootstrap steps for runner setup, opt-in `qamap e2e setup`, generated setup output that includes the first changed-flow draft file, fixture/mock data, testability, and validation evidence before generated drafts are treated as regression coverage. |
| API-dependent UI flow | `generateE2ePlan flags missing mock fixtures for API-dependent UI flows` | Playwright-compatible UI flow plus fixture/mock readiness actions, inferred endpoint hints, and route-fulfillment scaffold slots for success, empty, unauthorized, timeout, and server-error responses. |
| Existing test evidence | `generateE2ePlan evaluates existing test suite coverage evidence`; `generateE2ePlan keeps generic test filenames from overmatching unrelated services` | Coverage evidence rows that distinguish covered, partial, and missing targets without matching unrelated generic test filenames. |
| Evidence-only changes | `generateE2ePlan treats test-only changes as evidence verification, not product journeys`; `generateE2ePlan treats docs-only changes as documentation verification`; `generateE2ePlan treats generated-only changes as generated artifact verification` | Test-only, docs-only, and generated-output-only branches produce maintainer-oriented evidence checklists instead of product journeys inferred from filenames such as `admin-primary-journey.spec.ts` or generated API clients. |

See [E2E output examples](e2e-output-examples.md) for the kind of plan and draft snippets users should see from the current release.

## Private Smoke Protocol

Private repositories may be used as local, read-only diagnostics, but their raw output is never release documentation or fixture input. Write manifests and drafts only to an operating-system temp directory, compare target `git status` before and after, and retain no repository names, paths, flow titles, source excerpts, or domain vocabulary in commits or pull requests. Reduce every confirmed defect to a minimal synthetic fixture before it enters the public suite.

## Ongoing Validation Notes

The release candidate must pass the fixture-backed suite, package dry-run, and read-only smoke protocol. Record only public synthetic evidence in this document or in release notes:

- whether the generated flow names match the team's domain language
- whether commit evidence supports the inferred intent and lifecycle
- whether the automation adapter is plausible without being mistaken for the product value
- whether generated drafts identify the right actor, trigger, success signal, and edge cases
- whether action items are concrete enough for a developer to convert into runnable tests
- whether false positives are caused by missing manifests, weak selectors, or unsupported project structure
- whether test-only, docs-only, or generated-output-only changes are clearly demoted instead of being presented as product journeys

## Stop Conditions

Do not publish the current candidate if any representative target shows one of these problems:

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
