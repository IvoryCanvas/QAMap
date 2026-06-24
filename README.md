# CodeWard

[![CI](https://github.com/IvoryCanvas/codeward/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/codeward/actions/workflows/ci.yml)

**Guardrails for AI coding agents and the code they change.**

CodeWard scans a repository for the things that make AI-assisted development risky: missing agent instructions, unsafe MCP configuration, leaked local env files, dangerous automation scripts, broad workflow permissions, and weak validation signals.

It is designed for teams that use Codex, Claude Code, Cursor, GitHub Copilot coding agent, or MCP-powered tools and want a lightweight safety check before an agent edits the repo or a PR gets reviewed.

## Why CodeWard Exists

AI coding agents are fast, but they are also easy to over-trust. The awkward failure mode is not obviously broken code; it is code that is almost right, merged through a workflow that had too little context and too few guardrails.

CodeWard gives maintainers a simple first line of defense:

- find risky agent and MCP setup
- detect missing project instructions
- flag broad CI permissions and unsafe scripts
- generate a clean `AGENTS.md` starter
- produce a Markdown report for pull requests

## Install

```sh
npm install -D @ivorycanvas/codeward
```

Run it without installing:

```sh
npx @ivorycanvas/codeward scan .
```

## Usage

Scan the current repository:

```sh
codeward scan .
```

Fail CI when medium-or-higher findings are present:

```sh
codeward scan . --fail-on medium
```

Generate a Markdown report:

```sh
codeward report . --output CODEWARD_REPORT.md
```

Generate agent instructions:

```sh
codeward context . --write AGENTS.md
```

Print JSON for custom automation:

```sh
codeward scan . --json
```

## What It Checks Today

CodeWard's first release focuses on high-signal checks that are useful across many repositories:

| Rule | What it catches |
| --- | --- |
| `CW001` | Missing agent instruction files |
| `CW002` | Conflicting agent guidance |
| `CW003` | Suspicious instruction text that can misdirect agents |
| `CW004` | Risky MCP command configuration |
| `CW005` | Secret-like values embedded in MCP config |
| `CW006` | Missing or placeholder test scripts |
| `CW007` | Missing GitHub Actions workflows |
| `CW008` | Committed local environment files |
| `CW009` | Package scripts that can publish, push, merge, or run unsafe shell pipelines |
| `CW010` | Broad workflow permissions |
| `CW011` | Missing community health files |

## GitHub Actions

```yaml
name: CodeWard

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: 24
      - run: npm ci
      - run: npx @ivorycanvas/codeward scan . --fail-on high
```

## Philosophy

CodeWard is not a replacement for code review, tests, threat modeling, or branch protection. It is a small, sharp check that helps teams notice repo-level AI risks early enough to do something about them.

## Project Status

CodeWard is early. The public API may change before `1.0`, but the project is intended to stay small, readable, and useful in real repositories from the first release.

## Contributing

Issues and pull requests are welcome. Maintainer permissions stay with IvoryCanvas members, and `main` is protected so external contributors cannot push or merge directly.

See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [SECURITY.md](SECURITY.md).
