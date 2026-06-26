# GitHub Action

CodeWard ships a composite GitHub Action that can run `scan` or branch-aware `review` inside pull request workflows.

The action writes:

- a Markdown report file
- a sticky PR comment body
- an optional suggested domain test plan
- GitHub workflow annotations
- a GitHub step summary

## Pull Request Review

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

Use `fetch-depth: 0` so CodeWard can compare the pull request branch with the base ref.
While CodeWard is pre-release, use `IvoryCanvas/codeward@main`; pin to a version tag after the first release.

## Monorepo Package

```yaml
- uses: IvoryCanvas/codeward@main
  with:
    mode: review
    path: services/offer
    workspace-root: .
    base: ${{ github.event.pull_request.base.sha }}
    head: HEAD
    fail-on: high
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `mode` | `auto` | `auto`, `scan`, or `review`. `auto` uses review mode on pull request events. |
| `path` | `.` | Repository path to scan. |
| `workspace-root` | | Optional monorepo workspace root. |
| `base` | | Base ref or SHA for review mode. |
| `head` | `HEAD` | Head ref or SHA for review mode. |
| `config` | | Optional CodeWard config path. |
| `max-files` | | Optional maximum file count. |
| `fail-on` | `high` | Severity threshold that fails the action. |
| `report-file` | `codeward-report.md` | Markdown report output path. |
| `comment-file` | `codeward-pr-comment.md` | PR comment body output path. |
| `test-plan` | `true` | Append suggested domain tests for changed files. |
| `test-plan-file` | `codeward-test-plan.md` | Markdown test plan output path. |
| `annotations` | `true` | Emit GitHub workflow annotations. |
| `step-summary` | `true` | Append the report to the GitHub step summary. |
| `comment` | `true` | Create or update a sticky pull request comment. |
| `github-token` | | Token for PR comments. Required when `comment` is `true`. |

## Notes

- Set `pull-requests: write` only when PR comments are enabled.
- Set `comment: false` for advisory runs that should only use annotations and step summaries.
- Set `test-plan: false` when the PR comment should contain only CodeWard findings.
- Pass `github-token: ${{ secrets.GITHUB_TOKEN }}` when `comment` is enabled.
- CodeWard still does not execute scanned project code; the action only installs and builds CodeWard itself before scanning the checked-out repository.
