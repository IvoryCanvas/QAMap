# Adopting CodeWard

CodeWard works best when teams treat it as a repository preflight check for AI-assisted development, not as a replacement for review or security tooling.

## First Run

Until the first npm package is published, run CodeWard from a local checkout:

```sh
git clone https://github.com/IvoryCanvas/codeward.git
cd codeward
pnpm install
pnpm build
node dist/cli.js scan /path/to/repo
```

After the package is published:

```sh
pnpm dlx @ivorycanvas/codeward scan .
```

## Recommended Rollout

Start advisory, then tighten the gate once the findings are understood.

| Phase | Command | Goal |
| --- | --- | --- |
| 1. Baseline | `codeward scan .` | See current repo-level AI agent risks without blocking work. |
| 2. Doctor | `codeward doctor . --format markdown` | Get an agent-readiness summary by guardrail area. |
| 3. Review | `codeward review . --base origin/main --head HEAD --format markdown` | See new findings introduced by the branch. |
| 4. Test plan | `codeward test-plan . --base origin/main --head HEAD --include-working-tree` | Suggest domain test scenarios for changed and local files. |
| 5. PR Action | `uses: IvoryCanvas/codeward@main` | Add annotations, a step summary, a test plan, and a sticky PR comment. |
| 6. Report | `codeward report . --output CODEWARD_REPORT.md` | Share a readable audit artifact in a PR or maintainer discussion. |
| 7. High-risk gate | `codeward scan . --fail-on high` | Block obvious risks such as committed env files or unsafe scripts. |
| 8. Medium-risk gate | `codeward scan . --fail-on medium` | Require stronger agent guidance, tests, and workflow permissions. |

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
