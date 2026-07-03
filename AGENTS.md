# QAMap Agent Instructions

These instructions apply to the whole repository.

## Working Rules

- Keep changes small, reviewable, and focused on the requested behavior.
- Prefer zero-runtime-dependency implementations unless a dependency removes meaningful complexity.
- Do not commit generated output from `dist/`, coverage, local reports, or environment files.
- Never create or suggest branches with a `codex/` prefix. Use `feat/`, `fix/`, `refactor/`, `style/`, `hotfix/`, `chore/`, or `docs/`.

## Validation

- Run `pnpm test` before proposing a merge.
- Run `pnpm scan` when changing scanner behavior, security rules, or repository policy docs.

## Repository Boundaries

- Do not push directly to `main`.
- Do not merge pull requests unless you are an IvoryCanvas maintainer with repository write access.
- External contributions should arrive through pull requests and pass CI before review.
