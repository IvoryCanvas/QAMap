# Issue Conventions

QAMap issues turn observed failures and proposed behavior into public, reproducible contracts. They are not work diaries.

## Before Opening An Issue

Search open issues and pull requests first. Remove private repository names, paths, source, customer data, credentials, and internal output. Reproduce the behavior with invented, domain-neutral names whenever possible.

Security reports belong in [SECURITY.md](../SECURITY.md), not the public issue tracker.

## Titles

Use a capitalized type followed by an imperative outcome:

```txt
Fix: select the nearest changed package
Feat: trace asynchronous lifecycle risks
Docs: clarify repository validation receipts
```

Use `Fix`, `Feat`, `Docs`, `Test`, `Refactor`, or `Chore`. Describe the product outcome, not the implementation session or the tool used to write it.

## Required Structure

Every implementation issue should make these sections answerable:

1. **Problem**: the incorrect or missing user-visible judgment.
2. **Minimal reproduction**: a safe fixture, diff shape, or public repository.
3. **Actual result**: the concise QAMap output that demonstrates the problem.
4. **Expected contract**: what QAMap should infer, route, cite, or refuse to claim.
5. **Acceptance criteria**: positive cases, unrelated positive contexts, negative controls, and required validation.

Prefer exact file, symbol, hunk, command, and execution-state evidence over screenshots or broad descriptions.

## Assignment And Labels

Maintainer-created issues are assigned to `@ivory-code`.

Apply exactly one type label:

- `type: fix`
- `type: feat`
- `type: docs`
- `type: test`
- `type: refactor`
- `type: chore`
- `type: hotfix`

Add only the relevant area labels, such as `area: qa-planning`, `area: validation`, `area: review`, `area: e2e`, or `area: manifest`. Avoid labels that merely repeat the title.

## Progress Updates

Add a public comment only when it leaves durable evidence:

- **Reproduced**: link the minimized fixture and state the observed versus expected result.
- **Implementation ready**: link the pull request and summarize the behavioral contract it changes.
- **Verified**: list the exact checks and results, then close through the pull request with `Closes #<issue>`.

Do not post minute-by-minute activity, local filesystem paths, private smoke-test details, or editor and generation provenance.

Keep public metadata product-focused. Do not add model, assistant, bot, or automation
names to issue titles, bodies, comments, branch names, commit subjects, or pull
request titles. Do not add generated-by signatures or co-author trailers for tools
that are not human contributors.

## Pull Request Linkage

One pull request may close multiple tightly related issues when they share one behavioral contract. Otherwise keep the change focused. The pull request body should name the issue, explain the generalized fix, and preserve the same acceptance evidence.
