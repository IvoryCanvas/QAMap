# Adopting CodeWard

CodeWard works best when teams treat it as a repository preflight check for AI-assisted development, not as a replacement for review or security tooling.

## First Run

Start with a non-blocking scan:

```sh
pnpm dlx @ivorycanvas/codeward scan .
```

For a changed branch, preview the verification plan and draft E2E output before writing files:

```sh
pnpm dlx @ivorycanvas/codeward verify . --base origin/main --head HEAD --pr-body-file pr-body.md
pnpm dlx @ivorycanvas/codeward e2e draft . --base origin/main --head HEAD --dry-run
```

When developing CodeWard itself from source:

```sh
git clone https://github.com/IvoryCanvas/codeward.git
cd codeward
pnpm install
pnpm build
node dist/cli.js scan /path/to/repo
```

## Build A Verification Base

CodeWard works best when the repository becomes the source of truth for verification language, not when every PR starts with a fresh prompt to an external agent.

Start with generated output, then promote only durable knowledge:

- keep generated run history local with `codeward history init .` and `--record-history`
- commit `.codeward/domains.yml` when the team agrees on product/domain names
- commit `.codeward/flows.yml` when the team agrees a journey is important enough to protect repeatedly
- keep draft E2E files reviewable until selectors, fixtures, assertions, and runner config make them real regression coverage

This gives teams a small lifecycle: observe a branch, review the proposed language and flows, promote the stable parts, then let the next branch reuse that context without another LLM call.

## Recommended Rollout

Start advisory, then tighten the gate once the findings are understood.

| Phase | Command | Goal |
| --- | --- | --- |
| 1. Baseline | `codeward scan .` | See current repo-level AI agent risks without blocking work. |
| 2. Doctor | `codeward doctor . --format markdown` | Get an agent-readiness summary by guardrail area. |
| 3. Verify | `codeward verify . --base origin/main --head HEAD --pr-body-file pr-body.md` | Combine review findings, readiness score, suggested domain tests, and next actions. |
| 4. Review | `codeward review . --base origin/main --head HEAD --format markdown` | See new findings introduced by the branch. |
| 5. Test plan | `codeward test-plan . --base origin/main --head HEAD --include-working-tree` | Suggest domain test scenarios for changed and local files. |
| 6. E2E preview | `codeward e2e draft . --base origin/main --head HEAD --dry-run` | Preview generated draft paths, readiness, action items, and blockers before writing files. |
| 7. E2E apply | `codeward e2e draft . --base origin/main --head HEAD` | Write draft files once the preview looks useful enough to review. |
| 8. Eval | `codeward eval . --base origin/main --head HEAD --pr-body-file pr-body.md` | Score intent capture, risk explanation, test evidence, and review size. |
| 9. PR Action | `uses: IvoryCanvas/codeward@main` | Add annotations, a step summary, a test plan, eval, and a sticky PR comment. |
| 10. Report | `codeward report . --output CODEWARD_REPORT.md` | Share a readable audit artifact in a PR or maintainer discussion. |
| 11. High-risk gate | `codeward scan . --fail-on high` | Block obvious risks such as committed env files or unsafe scripts. |
| 12. Medium-risk gate | `codeward scan . --fail-on medium` | Require stronger agent guidance, tests, and workflow permissions. |

## Monorepos

When scanning a package inside a larger workspace, pass the workspace root so CodeWard can separate package-local risks from repository guardrails:

```sh
codeward doctor services/offer --workspace-root . --format markdown
codeward scan services/offer --workspace-root . --json
```

With `--workspace-root`, CodeWard reads package-local files such as `package.json`, `.env.*`, and MCP config from the package path. It reads repo-level guardrails such as `AGENTS.md`, `.github/workflows`, `LICENSE`, `SECURITY.md`, and `CONTRIBUTING.md` from the workspace root.

## What To Fix First

Fix high-severity findings before letting an agent work broadly in the repo.

1. Remove committed local environment files and rotate any exposed secrets.
2. Move publish, push, merge, and destructive scripts out of normal agent workflows.
3. Remove suspicious instruction text or fence it clearly as an example.
4. Narrow GitHub Actions permissions.
5. Add a real test command that agents and reviewers can run consistently.

## CI Guidance

For early rollout, fail only on high-severity findings:

```yaml
name: CodeWard

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  codeward:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: IvoryCanvas/codeward@main
        with:
          mode: review
          base: ${{ github.event.pull_request.base.sha }}
          head: HEAD
          fail-on: high
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

When the repository is stable, consider `--fail-on medium`.

For all inputs, see [github-action.md](github-action.md).

## Change Readiness Eval

For the most useful PR-facing report, start with `verify`:

```sh
codeward verify . --base origin/main --head HEAD --pr-body-file pr-body.md --format markdown
```

Use `codeward eval` when an AI-assisted branch looks plausible but reviewers need a faster way to decide what still needs human attention:

```sh
codeward eval . --base origin/main --head HEAD --pr-body-file pr-body.md --format markdown
```

The eval report scores validation commands, changed-test coverage, intent capture, risk explanation, generated domain test scenarios, and review size. A low score does not mean the code is wrong; it means the branch is expensive or risky to verify.

## Interpreting Findings

CodeWard findings are meant to be explainable. Each finding includes:

- a rule id such as `CW009`
- severity
- file path when available
- message
- recommendation
- short evidence when safe to print

Prefer severity overrides over broad ignores when a rule is useful but too noisy for a specific repository.

```json
{
  "severity": {
    "CW007": "info"
  }
}
```

Use `ignoreRules` only for findings that the team intentionally accepts.
