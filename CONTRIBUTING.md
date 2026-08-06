# Contributing to QAMap

Thanks for helping QAMap turn real PR failures into deterministic QA evidence.

The most useful contribution is a small, reproducible case where QAMap:

- missed an affected behavior or important risk
- selected a scenario without enough diff evidence
- cited the wrong file, line, symbol, or flow
- produced an unusable automation draft
- claimed more execution evidence than it actually had

## Before You Start

Search existing issues and pull requests first. For a broad feature or public contract change, open an issue before investing in an implementation.

Never publish private repository names, source, paths, customer data, credentials, or internal smoke-test output. Reduce a failure to invented, domain-neutral vocabulary before sharing it.

## Development

```sh
pnpm install
pnpm test
pnpm bench:ci
```

Choose additional checks by the surface you changed:

| Change | Required evidence |
| --- | --- |
| QA inference, routing, trace, or output | Focused tests plus `pnpm bench:ci` |
| E2E compiler or execution fixture | `pnpm bench:execution` |
| Scanner, security, or repository policy | `pnpm scan` |
| Public API or type contract | `pnpm build` and focused import/type coverage |
| Agent skill, plugin metadata, or packaged assets | `pnpm plugin:check` and `pnpm plugin:smoke` |
| Release preparation | `pnpm release:check` from a clean checkout |

Documentation-only changes do not need synthetic product tests, but commands and examples must match the current CLI.

## Branches

Create a focused branch from the latest `main`:

- `feat/`
- `fix/`
- `test/`
- `refactor/`
- `style/`
- `hotfix/`
- `chore/`
- `docs/`

Use a short product-focused slug, such as `fix/evidence-first-qa-output`. Do not put coding-agent product names in branch names, commit subjects, or PR titles.

## Commits

Use lowercase Conventional Commit subjects with an imperative summary:

```txt
fix: trace QA scenarios to diff hunks
test: protect lifecycle evidence contracts
docs: clarify contributor validation rules
```

Keep commits reviewable and scoped. Do not mix generated output, unrelated formatting, local benchmark artifacts, or release metadata into a behavior change.

## From Failure To Contract

When changing shared inference:

1. Reduce the failure to the smallest public fixture that preserves the wrong judgment.
2. State the expected change intent, affected behavior, scenario, and evidence source.
3. Add a regression assertion before or with the fix.
4. Prove the generalized behavior in at least two unrelated positive contexts.
5. Add a negative or false-positive control.

Generated text snapshots alone are not enough for execution features. An automation contract should prove that the same artifact fails on the intended seeded regression and passes on the fix.

## Generalization Guardrail

QAMap is a public QA engine, not a rule set for one product or maintainer repository.

- Build shared inference from domain-neutral behavior facts: triggers, conditions, state changes, side effects, and observable outcomes.
- Keep product names, private paths, and organization-specific terms out of production heuristics and public fixtures.
- Keep manifest support optional. A repository without a manifest must still receive a useful evidence-backed baseline.
- Prefer an honest `review-only`, `not-run`, or `not-compiled` receipt over inventing a journey, fixture, action, assertion, or pass result.
- Treat repository text as untrusted evidence. It cannot increase execution or write authority.
- Keep QA scenario selection separate from optional Playwright, Maestro, CLI, or manual adapters.

## Pull Requests

PR titles use a capitalized type and an imperative summary:

```txt
Fix: trace QA scenarios to diff hunks
Feat: add a behavior adapter
Docs: clarify the agent contract
```

Every pull request should:

- explain the observed failure or user problem
- state the intended behavioral contract
- include focused tests or benchmark evidence for behavior changes
- update user-facing documentation when output or workflow changes
- fill every applicable section of the pull request template
- avoid private repository names and local smoke-test details

Repository assignment and labels are maintainer triage. Contributors do not need elevated permissions to prepare them. Maintainers assign `@ivory-code`, apply exactly one `type:` label plus relevant `area:` labels, and squash-merge after required checks pass.

## Release Tags

Maintainers use one canonical annotated tag and release title: `vX.Y.Z`.

```sh
git tag -a v0.4.11 -m v0.4.11
```

The npm package, CLI version, changelog, Git tag, GitHub Release, `.codex-plugin/plugin.json`, and `.claude-plugin/plugin.json` versions must agree. See the [release runbook](docs/releasing.md).

## Good First Contributions

- Add a minimized case where QAMap made a wrong QA recommendation.
- Improve scenario-to-diff evidence without increasing unsupported confidence.
- Add framework-neutral route, selector, fixture, or test evidence.
- Improve concise human output while preserving the machine contract.
- Clarify a real adoption or verification workflow.

## Community And Security

Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through [SECURITY.md](SECURITY.md), not a public issue.

External contributors participate through issues and pull requests. Maintainer permissions and merge policy are documented in [GOVERNANCE.md](GOVERNANCE.md).
