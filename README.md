# CodeWard

[![CI](https://github.com/IvoryCanvas/codeward/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/codeward/actions/workflows/ci.yml)

**AI 코딩 에이전트와 그들이 변경하는 코드를 위한 가드레일.**

CodeWard는 AI와 함께 개발할 때 레포지토리를 위험하게 만드는 요소를 점검합니다. 누락된 에이전트 지침, 위험한 MCP 설정, 커밋된 로컬 환경 파일, 위험한 자동화 스크립트, 과도한 워크플로 권한, 약한 검증 신호를 찾아냅니다.

Codex, Claude Code, Cursor, GitHub Copilot coding agent, MCP 기반 도구를 사용하는 팀이 에이전트에게 작업을 맡기거나 PR을 리뷰하기 전에 가볍게 실행할 수 있는 안전 점검 도구입니다.

<details>
<summary>English translation</summary>

**Guardrails for AI coding agents and the code they change.**

CodeWard scans a repository for the things that make AI-assisted development risky: missing agent instructions, unsafe MCP configuration, leaked local env files, dangerous automation scripts, broad workflow permissions, and weak validation signals.

It is designed for teams that use Codex, Claude Code, Cursor, GitHub Copilot coding agent, or MCP-powered tools and want a lightweight safety check before an agent edits the repo or a PR gets reviewed.

</details>

## 왜 만들었나요

AI 코딩 에이전트는 빠르지만, 너무 쉽게 믿게 되는 도구이기도 합니다. 가장 난감한 실패는 명백히 망가진 코드가 아니라, 거의 맞아 보이지만 충분한 맥락과 가드레일 없이 병합되는 코드입니다.

CodeWard는 유지보수자에게 첫 번째 방어선을 제공합니다.

- 위험한 에이전트/MCP 설정 찾기
- 누락되거나 충돌하는 프로젝트 지침 감지
- 과도한 CI 권한과 위험한 스크립트 표시
- 깨끗한 `AGENTS.md` 시작점 생성
- PR에 붙일 Markdown 리포트 생성

## 설치

```sh
pnpm add -D @ivorycanvas/codeward
```

설치 없이 실행할 수도 있습니다.

```sh
pnpm dlx @ivorycanvas/codeward scan .
```

<details>
<summary>npm / Yarn</summary>

```sh
npm install -D @ivorycanvas/codeward
npx @ivorycanvas/codeward scan .
```

```sh
yarn add -D @ivorycanvas/codeward
yarn dlx @ivorycanvas/codeward scan .
```

</details>

## 사용법

현재 레포지토리를 스캔합니다.

```sh
codeward scan .
```

중간 등급 이상의 finding이 있으면 CI를 실패시킵니다.

```sh
codeward scan . --fail-on medium
```

Markdown 리포트를 생성합니다.

```sh
codeward report . --output CODEWARD_REPORT.md
```

에이전트 지침 파일을 생성합니다.

```sh
codeward context . --write AGENTS.md
```

자동화를 위해 JSON으로 출력합니다.

```sh
codeward scan . --json
```

## 현재 검사하는 것

첫 릴리즈는 많은 레포지토리에서 바로 쓸 수 있는 고신호 규칙에 집중합니다.

| Rule | 잡아내는 것 |
| --- | --- |
| `CW001` | 에이전트 지침 파일 누락 |
| `CW002` | 서로 충돌하는 에이전트 지침 |
| `CW003` | 에이전트를 잘못 유도할 수 있는 의심스러운 지침 문구 |
| `CW004` | 위험한 MCP command 설정 |
| `CW005` | MCP config에 포함된 secret-like 값 |
| `CW006` | 누락되었거나 placeholder인 test script |
| `CW007` | GitHub Actions workflow 누락 |
| `CW008` | 커밋된 로컬 environment file |
| `CW009` | publish, push, merge, unsafe shell pipeline을 실행할 수 있는 package script |
| `CW010` | 과도한 workflow permission |
| `CW011` | community health file 누락 |

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
      - uses: pnpm/action-setup@v6
        with:
          version: 10.32.1
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm dlx @ivorycanvas/codeward scan . --fail-on high
```

## 철학

CodeWard는 코드 리뷰, 테스트, threat modeling, branch protection을 대체하지 않습니다. 레포지토리 수준의 AI 위험을 빨리 알아차리게 해주는 작고 선명한 점검 도구입니다.

## 프로젝트 상태

CodeWard는 아직 초기 단계입니다. `1.0` 이전에는 공개 API가 바뀔 수 있지만, 첫 릴리즈부터 실제 레포지토리에서 작고 읽기 쉽고 유용한 도구로 유지하는 것이 목표입니다.

## 기여

이슈와 Pull Request를 환영합니다. 유지보수 권한은 IvoryCanvas 멤버에게만 제공되며, `main`은 보호 브랜치로 운영되어 외부 기여자가 직접 push하거나 merge할 수 없습니다.

[CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), [SECURITY.md](SECURITY.md)를 참고해 주세요.

<details>
<summary>Full English README</summary>

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
pnpm add -D @ivorycanvas/codeward
```

Run it without installing:

```sh
pnpm dlx @ivorycanvas/codeward scan .
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
      - uses: pnpm/action-setup@v6
        with:
          version: 10.32.1
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm dlx @ivorycanvas/codeward scan . --fail-on high
```

## Philosophy

CodeWard is not a replacement for code review, tests, threat modeling, or branch protection. It is a small, sharp check that helps teams notice repo-level AI risks early enough to do something about them.

## Project Status

CodeWard is early. The public API may change before `1.0`, but the project is intended to stay small, readable, and useful in real repositories from the first release.

## Contributing

Issues and pull requests are welcome. Maintainer permissions stay with IvoryCanvas members, and `main` is protected so external contributors cannot push or merge directly.

See [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and [SECURITY.md](SECURITY.md).

</details>
