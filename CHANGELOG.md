# Changelog

## Unreleased

Working scope for the first public `0.1.0` release.

### Added

- Repository guardrail scanning for AI-agent instructions, MCP config, committed local env files, risky scripts, broad workflow permissions, and API contract source-of-truth gaps.
- Text, JSON, Markdown, and SARIF reporting.
- PR-oriented `review`, `eval`, and `verify` commands for branch-aware findings, readiness scoring, validation evidence, and suggested domain tests.
- GitHub Action entrypoint with annotations, step summary, and PR comment output.
- Validation command discovery for JavaScript/TypeScript, Python, Go, Rust, Gradle, and Maven projects.
- E2E planning and draft generation for Playwright, Maestro, and manual checklists.
- Bootstrap planning for projects with little or no E2E history, including required runner setup, first-draft, fixture, selector, and validation steps.
- Domain language, domain manifest, and core-flow manifest support through `.codeward/domains.yml` and `.codeward/flows.yml`.
- Fixture/mock readiness and validation matrix output for generated E2E plans and drafts.
- Local E2E run history snapshots protected by generated `.gitignore` entries.
