# QAMap

[English](README.md) | **한국어**

[![CI](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/IvoryCanvas/QAMap/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush)
[![npm version](https://img.shields.io/npm/v/@ivorycanvas/qamap.svg)](https://www.npmjs.com/package/@ivorycanvas/qamap)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![QAMap: 병합 전에 무엇을 테스트할지 확인하세요.](docs/assets/qamap-cover-ko.png)

**PR을 병합하기 전에 확인할 내용을 코드 근거와 함께 정리합니다.**

QAMap은 현재 브랜치의 커밋과 diff, 저장소 구조, 기존 테스트를 로컬에서
분석하는 CLI입니다. 다음 세 가지 질문에 답합니다.

- 어떤 기능과 사용자 흐름이 영향을 받을 수 있는가?
- 정상, 실패, 경계 조건, 상태 변화 중 무엇을 확인해야 하는가?
- 각 판단은 어떤 파일, 줄, 심볼, 커밋을 근거로 하는가?

QA 항목을 정리한 뒤에는 저장소에 이미 있는 검증 명령이나 선택적인 자동화
초안으로 이어갈 수 있습니다. 소스 코드를 외부로 보내거나 QAMap 자체가
LLM을 호출하지는 않습니다.

## 설치하고 실행하기

### 로컬 CLI (권장)

Node.js 20 이상이 설치되어 있다면 확인할 브랜치에서 실행하세요.

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

이 명령은 코드를 읽기만 합니다. 프로젝트 파일을 바꾸거나 제품 테스트를
실행하지 않습니다. 반복 사용, 다른 패키지 매니저, 커밋하지 않은 변경을
분석하는 방법은 [도입 가이드](docs/adoption.md)에서 확인할 수 있습니다.

### ChatGPT와 Codex 플러그인

PR 리뷰나 테스트 계획을 세울 때 에이전트가 같은 로컬 분석을 실행하도록
하려면 공개 플러그인을 설치하세요.

[![OpenAI 플러그인 디렉터리에서 QAMap 설치](docs/assets/openai-plugin-directory-badge.svg)](https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629)

[플러그인 설치 방법](https://learn.chatgpt.com/docs/plugins#install-and-use-a-plugin)

호스트 에이전트는 자체 모델과 권한을 사용합니다. QAMap은 그 과정에서
저장소를 로컬의 일관된 규칙으로 분석하는 역할을 맡습니다.

## 결과 읽는 방법

| 항목 | 알 수 있는 내용 |
| --- | --- |
| **변경** | 어떤 기능이나 동작이 달라졌는지 |
| **병합 전 확인** | 어떤 시나리오를 확인해야 하는지 |
| **근거** | 어떤 커밋과 코드 위치에서 판단했는지 |
| **다음 단계** | 무엇을 검토하거나 실행하거나 초안으로 만들 수 있는지 |

기본 `qa` 명령은 계획만 만들며 실행 상태는 `not run`입니다. QAMap이 고른
저장소 명령을 실제로 실행할 때만 `qamap qa run`을 사용합니다. 브라우저,
모바일, API, CLI 또는 수동 자동화 초안은 `qamap e2e draft . --dry-run`으로
미리 볼 수 있습니다.

## 실제 실행 예시

공개 예제 저장소의 구독 갱신 흐름을 수정한 상황입니다. QAMap은 중복 요청
위험과 관련 코드 위치를 찾고, 실행 상태는 `not run`으로 남깁니다.

![QAMap이 브랜치 변경을 읽고 근거가 연결된 QA 요약을 만드는 모습](docs/assets/qamap-quickstart.gif)

[실제 CLI 출력과 첫 실행 과정을 자세히 보기](docs/ko/quickstart.md)

## 동작 방식

```txt
커밋과 diff
    -> 영향을 받는 기능과 흐름
    -> 위험에 맞는 QA 시나리오
    -> 각 판단의 코드 근거
    -> 기존 검증 명령 또는 선택적 자동화
```

QAMap은 넓은 추측보다 실제 변경 근거를 먼저 봅니다. Playwright, Maestro,
selector, fixture, 테스트 실행 환경이 없다고 해서 중요한 시나리오를 숨기지
않습니다. 근거가 부족하면 계약이나 성공 결과를 임의로 만들지 않고 멈춥니다.

## 목적별 문서

| 목적 | 문서 |
| --- | --- |
| 브랜치 하나를 처음 분석하기 | [한국어 빠른 시작](docs/ko/quickstart.md) |
| 팀에서 반복해서 사용하기 | [도입 가이드](docs/adoption.md) |
| 에이전트와 함께 사용하기 | [한국어 에이전트 연동](docs/ko/agent-integration.md) |
| 전체 명령 확인하기 | [명령어 안내](docs/commands.md) |
| 벤치마크 근거 확인하기 | [벤치마크](docs/benchmarking.md) |

## 현재 한계

QAMap은 아직 `1.0` 이전 단계입니다. 추론한 동작 흐름은 근거를 갖춘 검토용
초안이지 제품 명세가 아닙니다. 관찰한 동작이 의도인지 결함인지는 사람이
판단해야 하며, 하나의 검증 명령이 통과했다고 해서 제품 전체의 QA가 끝난
것도 아닙니다.

## 기여하기

잘못된 판단, 놓친 위험, 사용할 수 없는 초안을 환영합니다.
[CONTRIBUTING.md](CONTRIBUTING.md)에서 시작해 주세요. 비공개 저장소, 고객
정보, 인증 정보는 공개 이슈나 재현 자료에 포함하면 안 됩니다.

[English README](README.md) | [행동 강령](CODE_OF_CONDUCT.md) | [MIT 라이선스](LICENSE)
