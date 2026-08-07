# Issue Conventions

QAMap issues turn observed failures and proposed behavior into reproducible
public contracts. They are not work diaries.

## Pick The Right Template

| Situation | Template |
| --- | --- |
| CLI crash, incorrect output, or compatibility problem | **Bug report** |
| Missed behavior, false positive, wrong evidence, or unusable draft | **QA miss or false positive** |
| New user-facing capability or workflow | **Feature request** |
| New scanner or repository-policy rule | **Scanner rule request** |
| Vulnerability or sensitive security concern | Follow [SECURITY.md](../SECURITY.md) |

Search existing issues first. Remove private source, repository names, paths,
customer data, credentials, and internal output.

## What A Useful Issue Contains

A reporter only needs to provide four things:

1. **Problem:** the incorrect or missing user-visible judgment.
2. **Minimal reproduction:** a safe fixture, diff shape, or public repository.
3. **Actual result:** the relevant QAMap output and execution state.
4. **Expected behavior:** what QAMap should infer, cite, route, or refuse to
   claim.

Maintainers can refine acceptance criteria. Exact files, symbols, hunks,
commands, and `not-run | passed | failed | blocked` states are more useful than
broad descriptions.

## Titles

Use a capitalized type and a product outcome:

```txt
Fix: select the nearest changed package
Feat: trace asynchronous lifecycle risks
Docs: clarify repository validation receipts
```

Allowed types are `Fix`, `Feat`, `Docs`, `Test`, `Refactor`, `Chore`, and
`Hotfix`. Do not name the editor, model, assistant, bot, or generation tool used
to prepare the issue.

## Assignment And Labels

Maintainer-created issues are assigned to `@ivory-code`.

Apply exactly one type label:

```txt
type: fix
type: feat
type: docs
type: test
type: refactor
type: chore
type: hotfix
```

Add only relevant `area:` labels. Labels should help routing, not repeat the
title. External contributors can leave assignment and final labels to
maintainers.

## Durable Progress Updates

Comment only when the update leaves reusable evidence:

- **Reproduced:** link the minimized case and state actual versus expected.
- **Implementation ready:** link the pull request and summarize its contract.
- **Verified:** list exact checks and results.

Close implementation issues through the pull request with `Closes #<issue>`.
Avoid minute-by-minute activity, local paths, private smoke output, generated-by
signatures, and non-human co-author trailers.

## Pull Request Linkage

One pull request may close multiple issues only when they share one behavioral
contract. The pull request should explain the generalized fix and preserve the
same acceptance evidence.
