# CodeWard Eval

`codeward eval` scores whether a branch is ready for human review in an AI-assisted workflow.

It does not try to prove that the code is correct. Instead, it checks whether reviewers have enough evidence to trust, challenge, and verify the change without absorbing unnecessary cognitive load.

## Usage

```sh
codeward eval . --base origin/main --head HEAD --format markdown
codeward eval . --base origin/main --head HEAD --pr-body-file pr-body.md
codeward eval services/offer --workspace-root . --base origin/main --head HEAD --include-working-tree
```

The GitHub Action can append the same report to the PR comment. On pull request events it reads the PR body from `GITHUB_EVENT_PATH`.

## Gates

Each gate is scored from `0` to `2`.

| Gate | What it checks |
| --- | --- |
| Validation commands | The package exposes a real test command and supporting commands such as typecheck, lint, build, or e2e. |
| Changed test coverage | Source changes are paired with changed test files, or at least a runnable test command exists. |
| Intent capture | The PR body, decision docs, or PR template capture the problem, rationale, context, alternatives, or tradeoffs. |
| Risk explanation | Risky surfaces such as config, workflows, API contracts, auth, billing, migrations, and env files include risk or rollback context. |
| Domain test plan | Changed files can be mapped to focused domain verification scenarios. |
| Review size | The branch is small enough to review without unnecessary verification tax. |

## Ratings

| Rating | Meaning |
| --- | --- |
| `strong` | The branch has clear verification evidence and should be easy to review. |
| `ready` | The branch is probably reviewable, with some follow-up still useful. |
| `needs-work` | Reviewers should ask for more tests, context, risk notes, or a smaller diff. |
| `high-risk` | The branch is expensive or risky to verify; add evidence before relying on it. |

## Why This Exists

AI-assisted code often looks plausible before it is truly understood. That creates verification tax, cognitive debt, and intent debt:

- verification tax: humans must spend extra time proving the generated result is safe
- cognitive debt: reviewers receive more code than they can meaningfully understand
- intent debt: the reason for a change disappears into a prompt or chat session

`codeward eval` turns those risks into a small, static, explainable checklist that can run locally or in CI.
