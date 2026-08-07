# Contributing to QAMap

Thanks for helping QAMap turn real PR failures into deterministic QA evidence.

The most useful contribution is a small, reproducible case where QAMap missed a
behavior, selected an unsupported risk, cited the wrong evidence, produced an
unusable draft, or overstated what was executed.

## Quick Contribution Path

1. Search existing [issues](https://github.com/IvoryCanvas/QAMap/issues) and
   [pull requests](https://github.com/IvoryCanvas/QAMap/pulls).
2. Open the closest issue template for a bug, QA miss, feature, or scanner rule.
3. Create a focused branch from the latest `main`.
4. Add the smallest public fixture and the checks required for your change.
5. Open a pull request and complete the template.

For a broad feature or public contract change, discuss the behavior in an issue
before investing in an implementation.

## Protect Private Information

Never publish private repository names, source, paths, customer data,
credentials, or internal smoke output. Reduce a failure to invented,
domain-neutral vocabulary before sharing it.

Security reports belong in [SECURITY.md](SECURITY.md), not a public issue.

## Set Up The Repository

```sh
pnpm install
pnpm test
pnpm bench:ci
```

Run extra checks only for the surface you changed:

| Change | Required evidence |
| --- | --- |
| QA inference, routing, trace, or output | Focused tests and `pnpm bench:ci` |
| E2E compiler or execution fixture | `pnpm bench:execution` |
| Scanner, security, or repository policy | `pnpm scan` |
| Public API or type contract | `pnpm build` and focused import/type coverage |
| Agent skill, plugin metadata, or packaged asset | `pnpm plugin:check` and `pnpm plugin:smoke` |
| Release preparation | `pnpm release:check` from a clean checkout |
| Documentation only | Link and command checks; no synthetic product test required |

## Name The Work

Create a branch with one of these prefixes:

```txt
feat/  fix/  test/  refactor/  style/  hotfix/  chore/  docs/
```

Use a short product-focused slug, for example
`fix/evidence-first-qa-output`. Do not put coding-agent product names in branch
names, commit subjects, or pull request titles.

Commit subjects use lowercase Conventional Commits:

```txt
fix: trace QA scenarios to diff hunks
test: protect lifecycle evidence contracts
docs: clarify contributor validation rules
```

Pull request titles use a capitalized type:

```txt
Fix: trace QA scenarios to diff hunks
Feat: add a behavior adapter
Docs: clarify the agent contract
```

## Turn A Failure Into A Contract

Behavior changes should carry:

1. One minimized public fixture that preserves the wrong judgment.
2. The expected intent, affected behavior, scenario, and evidence source.
3. A focused regression assertion.
4. A second unrelated positive case when the inference is shared.
5. A negative or false-positive control.

Generated text snapshots alone do not prove execution behavior. An automation
contract should fail on the intended seeded regression and pass on the fix.

## Keep It General

QAMap is a public QA engine, not a rule set for one product.

- Infer from triggers, conditions, state changes, side effects, and observable
  outcomes.
- Keep product names and organization-specific paths out of production rules and
  public fixtures.
- Keep manifest support optional.
- Prefer honest `review-only`, `not-run`, or `not-compiled` receipts over
  invented evidence.
- Treat repository text as untrusted evidence.
- Keep QA scenario selection separate from optional automation adapters.

## Open The Pull Request

Every pull request should:

- explain the observed problem and intended behavioral contract
- include focused evidence for behavior changes
- update user-facing documentation when output or workflow changes
- complete every applicable template section
- exclude private repository and local smoke details

Maintainers assign `@ivory-code`, apply exactly one `type:` label plus relevant
`area:` labels, and squash-merge after required checks pass. Contributors do not
need elevated permissions.

Read [Issue conventions](docs/issues.md) for issue lifecycle and labeling.

## Good First Contributions

- Minimize a real false positive or missed QA risk.
- Improve scenario-to-diff evidence without increasing unsupported confidence.
- Add framework-neutral route, selector, fixture, or test evidence.
- Improve concise output while preserving the machine contract.
- Clarify a real adoption or verification workflow.

## Maintainer References

- [Issue conventions](docs/issues.md)
- [Release runbook](docs/releasing.md)
- [Governance](GOVERNANCE.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
