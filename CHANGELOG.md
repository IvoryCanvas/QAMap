# Changelog

## Unreleased

No changes yet.

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
- Domain language, domain manifest, and core-flow manifest support through `.codeward/domains.yml` and `.codeward/flows.yml`.
- Change-aware `domains suggest` and `flows suggest` commands that draft manifest entries from branch context before teams commit durable policy.
- Manifest suggestion promotion plans that classify candidates as `commit-candidate`, `needs-review`, or `low-signal`.
- Fixture/mock readiness and validation matrix output for generated E2E plans and drafts.
- API-dependent Playwright draft scaffolds with endpoint hints and `page.route(...).fulfill(...)` mock slots.
- Next.js App Router, Next Pages Router, React Router route-object, link, and navigation route inference, including dynamic route parameter placeholders or concrete route hints when available.
- `codeward e2e draft --dry-run` to preview planned files, readiness, action items, self-checks, and blockers without writing draft files.
- Design token and data catalog project profiles that produce artifact/catalog validation checklists instead of browser or device journeys.
- Local E2E run history snapshots protected by generated `.gitignore` entries.
- `coverage` and `release:check` scripts for the final local release gate.
- README and adoption guidance for repo-local verification bases, shared domain/flow manifests, and ignored generated run history.
- More conservative data-catalog and config/content E2E planning heuristics so generic package schemas or release docs do not create catalog journeys or API fixture blockers.
