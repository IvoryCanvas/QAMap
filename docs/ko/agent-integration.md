# 에이전트 연동

[한국어 문서 홈](README.md) | [English agent guide](../agent-skill.md)

QAMap은 Codex, ChatGPT, Claude Code 등 특정 제품에 종속된 QA 엔진을 따로
만들지 않습니다. 모든 연동은 같은 로컬 CLI와 versioned `qamap.qa`
계약을 사용합니다.

## OpenAI Plugin Directory

ChatGPT 또는 Codex의 **Plugins**에서 **QAMap**을 검색하고 **+**를 누른 뒤
새 대화를 시작합니다.

- [QAMap 플러그인 열기](https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629)
- [OpenAI 플러그인 설치 안내](https://learn.chatgpt.com/docs/plugins)

플러그인이 저장소를 분석하려면 호스트가 체크아웃된 저장소와 로컬 shell에
접근할 수 있어야 합니다. 웹 전용 대화에서 로컬 저장소 접근 권한이 없으면
같은 분석을 수행할 수 없습니다.

## 범용 agent payload

다른 에이전트는 다음 명령으로 압축된 JSON 계약을 읽을 수 있습니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa --format agent
```

에이전트는 다음 순서로 읽어야 합니다.

1. `execution`: 실제 실행 여부와 상태
2. `route`: 현재 필요한 한 가지 다음 행동
3. `action`: 실행·쓰기·network·승인 경계
4. `intents`와 `flows`: 변경 의도, 시나리오, 영향받는 흐름
5. `requiredEvidence`: 신뢰하기 전에 필요한 근거

## 모노레포 명령 실행 위치

에이전트 출력의 `analysisScope.commandCwd`를 먼저 확인합니다.

- `workspace-root`: 저장소 루트에서 명령을 실행합니다. QAMap이 자동으로 고른 패키지 명령은 `--dir`, `--cwd`, `--prefix` 또는 명시적인 `cd`에 패키지 경로가 이미 포함되어 있습니다.
- `selected-package`: `analysisScope.selectedPath`에서 패키지 로컬 명령을 실행합니다. 사용자가 `--workspace-root`와 함께 패키지를 명시한 경우에 사용됩니다.

이 필드가 없는 이전 v1 출력은 저장소 루트를 기본값으로 사용합니다. 경로를 추측해 `selectedPath`를 두 번 적용하지 않습니다.

## 토큰과 데이터 경계

- QAMap 정적 분석 자체는 추가 LLM 호출을 하지 않습니다.
- QAMap은 분석을 위해 소스 코드를 업로드하지 않습니다.
- QAMap을 호출하고 결과를 해석하는 호스트 에이전트는 자체 모델 토큰을 사용합니다.
- `npx` 일회성 실행은 고정된 npm 패키지를 내려받기 위해 network를 사용할 수 있습니다.

따라서 “zero additional LLM”은 전체 에이전트 세션의 토큰이 0이라는 뜻이
아니라, 반복되는 저장소 분석을 QAMap의 결정론적 로컬 단계가 담당한다는
뜻입니다.

## 안전한 사용 순서

1. 먼저 read-only `qa --format agent`를 실행합니다.
2. 가장 강한 diff 근거가 실제 코드와 맞는지 확인합니다.
3. `route.nextAction` 하나만 선택합니다.
4. repository command 실행이나 파일 생성은 action contract와 사용자 승인을 확인합니다.
5. 생성된 초안과 실행 결과를 구분해서 보고합니다.

문서, 번역 안내, 패키지에 포함되는 문서 목록, 이슈 폼, PR 템플릿만 바뀐
경우 QAMap은 이를 제품 기능 변경으로 간주하지 않습니다. 링크와 명령,
YAML 필드, 라벨·할당자, 필수 PR 섹션을 확인하는 저장소 검증으로 라우팅하며,
실행 가능한 기존 명령을 찾았을 때만 검증 준비 상태를 `ready`로 표시합니다.

QAMap 결과가 일반 코드 검토와 다르면 실제 코드와 실행 근거를 우선합니다.
차이는 false positive, miss, evidence gap, action gap으로 남겨 QAMap의 다음
회귀 fixture로 사용할 수 있습니다.
