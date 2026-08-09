# QAMap

[English](README.md) | **한국어**

[![CI](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml/badge.svg)](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@ivorycanvas/qamap.svg)](https://www.npmjs.com/package/@ivorycanvas/qamap)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<a href="https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629">
  <img src="docs/assets/openai-plugin-directory-badge.svg" alt="OpenAI Plugin Directory에서 QAMap 설치" height="64">
</a>

**ChatGPT 또는 Codex에 설치:** **Plugins**에서 **QAMap**을 검색하고
**+**를 누른 뒤 새 대화를 시작하세요.
[QAMap 열기](https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629)
· [설치 안내](https://learn.chatgpt.com/docs/plugins)

![QAMap: 변경이 무엇을 증명해야 하는지 찾습니다](docs/assets/qamap-cover-ko.png)

**병합 전에 이 변경이 무엇을 증명해야 하는지 찾습니다.**

QAMap은 local-first QA CLI입니다. 현재 브랜치, 저장소 구조, 기존 테스트,
diff 근거를 읽고 다음 질문에 답합니다.

1. 어떤 동작이 바뀌었는가?
2. 무엇이 실패할 수 있는가?
3. 병합 전에 무엇을, 왜 검증해야 하는가?
4. 지금 실행할 수 있는 검증이나 E2E 초안은 무엇인가?

QAMap 자체는 클라우드 분석, 소스 업로드, 추가 LLM 호출을 하지 않습니다.
manifest와 테스트 runner도 첫 실행에는 필요하지 않습니다.

## 60초 만에 실행하기

Node.js 20 이상이 필요합니다. 검토하려는 브랜치에서 실행하세요.

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

일반적인 저장소에서는 base branch를 자동으로 찾습니다. 필요한 경우에만
직접 지정하세요.

```sh
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```

전체 판단 근거가 필요한 경우 Markdown 형식을 사용합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa --format markdown
```

## 결과 읽는 방법

| 영역 | 답하는 질문 |
| --- | --- |
| **Change** | 어떤 동작이 바뀌었을 가능성이 있는가? |
| **Verify before merge** | 정상·실패·경계·상태 전환 중 무엇을 확인해야 하는가? |
| **Evidence** | 어떤 커밋, 파일, 줄, 심볼이 판단을 뒷받침하는가? |
| **Next** | 기존 검증을 실행할지, 선택적 초안을 검토할지? |

정적 분석과 실제 QA 실행은 분리됩니다. 제안된 시나리오나 생성된 E2E
초안은 통과한 테스트로 보고되지 않습니다. 외부에서 확인 가능한 결과를
diff가 증명하지 못하면, QAMap은 assertion을 지어내지 않고 근거 부족으로
표시합니다.

## 실제 실행 예시

아래 녹화는 공개 fixture를 사용합니다. QAMap은 중복 요청 위험과 변경
근거를 찾고, 실제 실행 상태는 `not run`으로 유지합니다.

![QAMap이 브랜치 diff를 읽고 근거가 연결된 QA 요약을 만드는 화면](docs/assets/qamap-quickstart.gif)

```txt
QAMap QA
Local static analysis. Product QA was not run.

Change
  Prevent duplicate subscription renewal requests

Verify before merge
  REQUIRED     Subscription becomes visibly active
  RECOMMENDED  Duplicate renewal request is prevented

Evidence
  3/3 scenarios connect to 6 unique diff sources.
  Existing validation: npm run test:e2e (selected, not run)

Next
  Run selected validation: qamap qa run
  Preview E2E draft: qamap e2e draft . --dry-run
```

## 목적별 문서

| 하고 싶은 일 | 시작 문서 |
| --- | --- |
| 한 번 실행하고 결과 이해하기 | [한국어 빠른 시작](docs/ko/quickstart.md) |
| 에이전트 또는 OpenAI 플러그인에서 사용하기 | [한국어 에이전트 연동](docs/ko/agent-integration.md) |
| 반복되는 오해를 저장소 맥락으로 보정하기 | [한국어 verification manifest](docs/ko/manifest.md) |
| 모든 한국어 문서 보기 | [한국어 문서 홈](docs/ko/README.md) |
| 전체 기술 명세 보기 | [English documentation](docs/en/README.md) |
| 문제를 제보하거나 기여하기 | [CONTRIBUTING.md](CONTRIBUTING.md) |

## 분석, 실행, E2E의 차이

| 명령 | 동작 | 프로젝트 코드를 실행하거나 쓰는가? |
| --- | --- | --- |
| `qamap qa` | diff를 동작, 위험, 근거, QA 시나리오에 연결 | 아니요 |
| `qamap qa run` | QAMap이 선택한 기존 저장소 검증 하나를 명시적으로 실행 | 예 |
| `qamap e2e draft . --dry-run` | 선택적 Playwright, Maestro, CLI, API, manual 자동화 초안 미리보기 | 아니요 |

selector, fixture, Playwright, Maestro, 테스트 runner가 없다는 이유로 중요한
QA 시나리오를 숨기지 않습니다. 이 항목들은 자동화 수단이며, 무엇을
검증해야 하는가보다 먼저 오지 않습니다.

## 반복 사용을 위한 짧은 명령

JavaScript 저장소에는 개발 의존성으로 설치할 수 있습니다.

```sh
pnpm add -D @ivorycanvas/qamap
pnpm exec qamap init --scripts
```

이후 다음 명령을 사용합니다.

```sh
pnpm qa          # 커밋된 브랜치 변경
pnpm qa:local    # 아직 커밋하지 않은 변경 포함
pnpm qa:run      # 선택된 기존 검증 실행
pnpm qa:e2e      # 선택적 E2E 초안 미리보기
```

다른 언어의 저장소는 범용 `npx` 명령을 그대로 사용할 수 있습니다.

## 동작 방식

```txt
commit + diff
    -> 변경된 동작과 흐름
    -> 위험과 QA 시나리오 선택
    -> 파일과 줄 단위 판단 근거
    -> 기존 검증 또는 선택적 E2E 초안
```

QAMap은 넓은 저장소 추측보다 직접 변경된 동작을 우선합니다. 공유
컴포넌트 변경은 reverse-import 맥락을 통해 소비 화면으로 연결할 수 있지만,
관련 없는 화면은 범위에서 제외하도록 보수적으로 판단합니다.

## 에이전트와 팀 맥락

에이전트는 같은 판단을 압축된 버전 계약으로 읽을 수 있습니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa --format agent
```

OpenAI Plugin Directory, portable project skill, `qamap init --agent` 모두 같은
로컬 CLI를 호출합니다. 에이전트가 QAMap을 호출하고 해석하는 데 사용하는
호스트 모델 토큰과 QAMap 자체의 추가 LLM 호출이 없다는 사실은 구분해야
합니다.

첫 실행에는 설정이 필요하지 않습니다. 반복적으로 같은 팀 흐름을 잘못
해석할 때만 repo-local QA 맥락을 만들고 사람이 검토하세요.

```sh
npx --yes @ivorycanvas/qamap@latest manifest init
```

## 현재 한계

QAMap은 아직 `1.0` 이전입니다. 정적 분석만으로 모든 제품 판단을 알 수
없으므로 추론된 시나리오는 검토가 필요합니다. 저장소 명령 하나가
통과해도 제품 전체 QA가 통과한 것은 아닙니다.

공개 release gate는 여러 프레임워크, API, CLI, monorepo, testless 저장소,
false positive 대조군, diff trace, 생성된 브라우저 테스트, 패키지, coverage,
private fixture 차단 계약을 포함합니다. 자세한 근거는 영문
[Benchmarking](docs/benchmarking.md) 문서에서 확인할 수 있습니다.

## 기여하기

실제 false positive, 놓친 위험, 사용할 수 없는 초안, 최소화한 실패 저장소가
특히 유용합니다. [CONTRIBUTING.md](CONTRIBUTING.md)에서 시작해 주세요.
공개 제보에는 비공개 저장소, 고객 정보, 사내 경로를 포함하면 안 됩니다.

QAMap은 사람의 리뷰, 실행 가능한 테스트, 보안 도구를 대체하지 않습니다.
변경을 받은 뒤 무엇을 증명해야 하는지 결정하는 반복 작업을 줄입니다.
