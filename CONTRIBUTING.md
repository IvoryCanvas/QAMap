# Contributing to QAMap

Thanks for helping QAMap turn real PR failures into deterministic QA evidence.

## Development

```sh
pnpm install
pnpm test
pnpm bench:ci
```

Use `pnpm scan` when changing scanner, security, or repository-policy behavior. Run `pnpm release:check` before a release PR.

## Branches

Create a focused branch from the latest `main` with one of these prefixes:

- `feat/`
- `fix/`
- `refactor/`
- `style/`
- `hotfix/`
- `chore/`
- `docs/`

Use a short, product-focused slug such as `fix/evidence-first-qa-output`. Do not put coding-agent product names in branch names, commit subjects, or PR titles.

## Commits

Use lowercase Conventional Commit subjects with an imperative summary:

```txt
fix: trace QA scenarios to diff hunks
test: protect lifecycle evidence contracts
docs: document contributor metadata rules
```

Keep commits reviewable and scoped. Do not mix generated output, unrelated formatting, or local benchmark artifacts into a product change.

## Pull Requests

PR titles use a capitalized type and an imperative summary:

```txt
Fix: trace QA scenarios to diff hunks
Feat: add a behavior adapter
Docs: clarify the agent contract
```

Every PR should:

- fill every applicable section of the pull request template
- assign `@ivory-code` when repository permissions allow; a maintainer will apply the assignment otherwise
- use exactly one type label, such as `type: fix`, `type: feature`, or `type: docs`
- add only the relevant area labels, such as `area: qa-planning`, `area: validation`, `area: manifest`, or `area: e2e`
- include focused tests or benchmark contracts for behavior changes
- update user-facing documentation when output or workflow behavior changes
- keep private repository names and local smoke-test output out of public PR bodies and fixtures

Maintainers squash-merge after required CI checks pass. The squash commit should preserve the PR's Conventional Commit meaning and must not introduce unrelated metadata.

## Release Tags

Maintainers use one canonical annotated tag and release title: `vX.Y.Z`.

```sh
git tag -a v0.4.1 -m v0.4.1
```

Do not add a product name, subtitle, or alternate version tag. Package versions, the CLI version constant, the changelog, Git tag, and GitHub Release must agree.

## Good First Contributions

- Add a minimized PR fixture where QAMap made a wrong QA recommendation.
- Improve scenario-to-diff evidence without inventing confidence.
- Add framework-specific route, selector, fixture, or test evidence.
- Improve agent output while preserving the documented schema contract.
- Clarify a real-world adoption or verification workflow.

## Maintainer Permissions

External contributors can open issues and pull requests. Push, merge, label, assignment, tag, and release permissions are reserved for IvoryCanvas maintainers and organization members with explicit repository access.

The `main` branch is expected to require pull requests and passing CI before merge.
