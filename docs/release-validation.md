# 0.1.0 Release Validation

CodeWard should not publish the first public package only because the package metadata is ready. The first release should prove that the E2E planning workflow is useful across representative repositories without requiring an LLM call.

## Release Bar

CodeWard is ready for `0.1.0` when the commands below produce useful, reviewable output for each representative repository type:

- web app with Playwright-compatible routes and components
- mobile or Expo/React Native app with Maestro-compatible screens
- API or backend service repo with contract-oriented checklist output
- monorepo package scanned with `--workspace-root`
- test-light project with little or no existing E2E coverage
- API-dependent UI flow that needs deterministic mock or fixture data

For each target, record:

- command used
- base/head refs or working-tree mode
- recommended runner
- generated flow language brief quality
- draft readiness summary
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
```

Run these against every representative target repository:

```sh
node dist/cli.js e2e plan <target> --base <base> --head <head> --format markdown
node dist/cli.js e2e plan <target> --base <base> --head <head> --format json
node dist/cli.js e2e draft <target> --base <base> --head <head> --format markdown --output <tmp-output-dir>
node dist/cli.js e2e draft <target> --base <base> --head <head> --format json --output <tmp-output-dir> --force
```

For monorepos, include:

```sh
node dist/cli.js e2e plan <package> --workspace-root <repo-root> --base <base> --head <head> --format markdown
node dist/cli.js e2e draft <package> --workspace-root <repo-root> --base <base> --head <head> --format markdown --output <tmp-output-dir>
```

## Expected Evidence

The E2E plan should show:

- runner recommendation with clear evidence
- bootstrap steps when the project lacks E2E setup
- domain language and candidate user scenarios
- matched `.codeward/domains.yml` or `.codeward/flows.yml` entries when present
- validation matrix rows for fixture, coverage, setup, and testability gaps

The E2E draft should show:

- generated Maestro, Playwright, or manual draft files
- `languageBrief` for each draft file
- `promotionStatus` for each draft file
- `actionItems` grouped by assertion, fixture, selector, runner, validation, or manifest
- `actionSummary` with required and recommended action counts
- Playwright `test.step()` names that read like the product journey

## Stop Conditions

Do not publish `0.1.0` if any representative target shows one of these problems:

- generated flow names are dominated by generic folder names instead of product language
- monorepo package scans report workspace-root paths in generated package-local drafts
- Playwright drafts cannot express dynamic route parameters with fixture placeholders
- API-dependent flows fail to produce fixture or mock readiness actions
- draft Markdown or JSON omits required action items for selector, fixture, setup, or validation gaps
- generated files overwrite existing files without `--force`
- `pnpm pack --dry-run` excludes required runtime files

## Release Notes Checklist

Before publishing, update:

- `README.md` install section
- `CHANGELOG.md`
- GitHub Action release tag notes, if the action is versioned with the package
- package provenance or npm publishing notes
