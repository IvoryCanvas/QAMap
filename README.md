# CodeWard

[![CI](https://github.com/IvoryCanvas/codeward/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/codeward/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Repo-level preflight checks before AI coding agents touch your code.**

CodeWard scans the repository surface that AI coding agents rely on: agent instructions, MCP configuration, local environment files, package scripts, GitHub Actions permissions, community health files, and validation signals.

It is built for teams using Codex, Claude Code, Cursor, GitHub Copilot coding agent, MCP-powered tools, or any workflow where an agent can read, edit, test, commit, or open pull requests.

CodeWard is intentionally small:

- static by default: it does not execute scanned project code
- repo-focused: it checks the guardrails around the code, not general style
- CI-friendly: text, JSON, Markdown, and SARIF output are supported
- explainable: every finding includes a concrete fix

<details>
<summary>한국어 소개</summary>

CodeWard는 AI 코딩 에이전트에게 레포지토리를 맡기기 전에 빠르게 실행하는 사전 점검 CLI입니다.

누락된 에이전트 지침, 위험한 MCP 설정, 커밋된 로컬 환경 파일, 위험한 자동화 스크립트, 과도한 GitHub Actions 권한, 약한 검증 신호를 찾아냅니다.

목표는 거대한 보안 플랫폼이 아니라, 유지보수자가 PR 리뷰나 에이전트 작업 전에 위험한 레포 상태를 빨리 알아차리게 해주는 작고 선명한 도구입니다.

</details>

## Why It Matters

AI agents are becoming normal contributors to software projects. They can research a repository, edit files, run commands, and prepare pull requests. The risky failure mode is not always broken code. It is code that looks plausible, merged through a repository with missing context, broad permissions, unsafe scripts, or weak validation.

CodeWard gives maintainers a quick first line of defense:

- Is there clear guidance for agents?
- Are MCP configs safe enough to inspect?
- Did a local `.env` file slip into the repo?
- Can package scripts publish, push, merge, or run risky shell pipelines?
- Are workflows using broad permissions or risky triggers?
- Is there a real test command for agent-made changes?

## Quick Demo

```sh
codeward scan .
```

Example output from a risky repository:

```txt
CodeWard 0.1.0
Findings: 6 (high: 3, medium: 2, low: 1, info: 0)

HIGH
- CW003 Suspicious agent instruction text (AGENTS.md)
  Instruction file contains text that matches a suspicious instruction override pattern.
  Fix: Remove untrusted instruction text or move examples into clearly fenced documentation that agents should not follow.

- CW009 Risky package script (package.json)
  The "release" script can publish, push, or merge changes.
  Fix: Keep publish, push, merge, and destructive scripts outside default agent workflows or gate them with maintainer-only release processes.

- CW008 Committed environment file (.env)
  A local environment file appears to be present in the repository.
  Fix: Remove committed environment files, rotate any exposed secrets, and keep only safe examples such as .env.example.
```

For a readiness view, use `doctor`:

```sh
codeward doctor .
```

```txt
CodeWard Doctor
Agent readiness: High risk

Guardrail areas:
- [review] Agent instructions: Agent guidance needs attention before broad agent use. (CW003)
- [review] Validation: Agents do not have a clear default validation command. (CW006)
- [review] Repository automation: Local environment files or risky scripts need maintainer review. (CW008, CW009)
```

## Install

The package metadata is ready for the first npm release:

```sh
pnpm dlx @ivorycanvas/codeward scan .
```

Until the npm package is published, run CodeWard from source:

```sh
git clone https://github.com/IvoryCanvas/codeward.git
cd codeward
pnpm install
pnpm build
node dist/cli.js scan /path/to/repo
```

## Commands

| Command | Purpose |
| --- | --- |
| `codeward scan .` | Scan the current repository and print a text report. |
| `codeward scan . --fail-on medium` | Exit with code `1` when findings at or above the threshold exist. |
| `codeward scan . --json` | Print machine-readable JSON for custom automation. |
| `codeward scan . --format sarif --output codeward.sarif` | Generate SARIF for code scanning integrations. |
| `codeward report . --output CODEWARD_REPORT.md` | Generate a Markdown report for PRs or audits. |
| `codeward doctor .` | Summarize whether the repo is ready for AI-assisted work. |
| `codeward context . --write AGENTS.md` | Generate starter agent instructions for the repo. |
| `codeward init .` | Create a starter `codeward.config.json`. |

## What It Checks

The first release focuses on high-signal checks that are useful across many repositories.

| Rule | Severity | What it catches |
| --- | --- | --- |
| `CW001` | medium | Missing agent instruction files. |
| `CW002` | medium | Conflicting agent guidance. |
| `CW003` | high | Suspicious instruction text that can misdirect agents. |
| `CW004` | medium/high | Risky MCP command configuration. |
| `CW005` | high | Secret-like values embedded in MCP config. |
| `CW006` | medium | Missing or placeholder test scripts. |
| `CW007` | low | Missing GitHub Actions workflows. |
| `CW008` | high | Committed local environment files. |
| `CW009` | high | Package scripts that can publish, push, merge, or run unsafe shell pipelines. |
| `CW010` | medium | Broad workflow permissions or risky workflow triggers. |
| `CW011` | low | Missing community health files. |

See [docs/rules.md](docs/rules.md) for the rule catalog.

## Configuration

Use `codeward.config.json` or `.codeward.json` to tune repository policy.

```json
{
  "$schema": "https://raw.githubusercontent.com/IvoryCanvas/codeward/main/schema/codeward.schema.json",
  "failOn": "high",
  "ignoreRules": ["CW011"],
  "maxFiles": 2000,
  "severity": {
    "CW007": "info"
  }
}
```

See [docs/configuration.md](docs/configuration.md) for details.

## GitHub Actions

After the npm package is published, CodeWard can run as a lightweight CI gate:

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
      - uses: pnpm/action-setup@v6
        with:
          version: 10.32.1
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm dlx @ivorycanvas/codeward scan . --fail-on high
```

For rollout guidance, see [docs/adoption.md](docs/adoption.md).

## Where CodeWard Fits

CodeWard is not trying to replace the larger security ecosystem.

| Tool category | Typical focus | CodeWard focus |
| --- | --- | --- |
| OpenSSF Scorecard | Broad open source security posture. | AI-agent readiness at the repository boundary. |
| Secret scanning | Exposed credentials in code or history. | Secret-like values plus unsafe agent, workflow, and script context. |
| MCP security scanners | Deep analysis of MCP servers, tools, prompts, and skills. | Static repo checks without executing untrusted MCP servers. |
| General linters | Code style, correctness, or framework rules. | Guardrails that affect AI-assisted development safety. |

## Roadmap

CodeWard starts as a local CLI and should stay small enough that maintainers can understand every finding.

Near-term priorities:

- publish the first npm package
- add a GitHub Action wrapper with PR annotations
- add branch-aware `review` output for PR risk
- expand agent instruction detection across Codex, Claude Code, Cursor, Copilot, Gemini, and related surfaces
- generate rule documentation from scanner metadata

See [docs/roadmap.md](docs/roadmap.md) for more detail.

## Project Status

CodeWard is early and pre-`1.0`. The public API may change, but the project is intended to stay readable, practical, and useful in real repositories from the first release.

## Contributing

Issues and pull requests are welcome. Maintainer permissions stay with IvoryCanvas members, and `main` is protected so external contributors cannot push or merge directly.

Good first contributions include new agent instruction file detectors, better SARIF locations, sample risky repository fixtures, and documentation improvements.

See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [SECURITY.md](SECURITY.md).

## Philosophy

CodeWard does not replace code review, tests, threat modeling, branch protection, or security review. It is a small preflight check that helps teams notice repo-level AI risks early enough to do something about them.
