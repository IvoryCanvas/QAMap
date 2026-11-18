# QAMap 도입 가이드

[English](../adoption.md) | [한국어 문서](README.md)

먼저 변경이 있는 브랜치 하나에서 브리프가 유용한지 확인하세요. Manifest나
설정 파일 없이 시작할 수 있으며, 팀의 반복 사용이 필요할 때만 설정을 추가합니다.

새 질문과 분석 범위 보완은 배포 전 소스 변경입니다. 기존 배포본의 출력은
아래 설명과 일부 다를 수 있습니다.

## 처음 실행하기

기준 브랜치와 리뷰할 브랜치를 지정합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa brief . --base origin/main --head HEAD
```

커밋하지 않은 수정과 미추적 파일도 포함하려면 다음과 같이 실행합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa brief . --base origin/main --include-working-tree
```

`base`는 PR이 들어갈 브랜치입니다. 다른 기준이면 `origin/main`을 해당 ref로
바꿉니다. 브리프의 비교 범위와 `Not fully shown`을 확인하고, 생략된 diff는
안내된 Git 명령으로 읽어야 합니다. 현재 파일을 읽는 것만으로 삭제된 코드를
복구할 수는 없습니다.

브리프에서 볼 내용은 다음과 같습니다.

| 항목 | 확인할 내용 |
| --- | --- |
| Changes | 줄 번호가 붙은 변경과 기존 코드의 구분 |
| References | 변경 선언의 테스트·호출자·호출자의 테스트 근거 |
| What to verify | 실제 변경에 맞는 검증 항목과 기대 결과 |
| Open review questions | 코드로 확정하지 못한 의도·정책과 다음 확인 방법 |
| Unknowns / Not fully shown | 추적하지 못했거나 출력 한도 때문에 생략한 근거 |

사람이 읽는 QA 계획이 필요하면 `qa`를 사용합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```

정적 분석은 테스트 실행 결과가 아닙니다. 테스트 이름과 단언을 찾았어도
해당 코드가 실행됐거나 통과했다고 표시하지 않습니다. 예상 동작은 검토된
정책 출처와 사람의 판단으로 확인하고, 검증은 별도로 실행해야 합니다.

## 에이전트와 사용하기

CLI를 설치한 뒤 저장소에 리뷰 설정을 추가할 수 있습니다.

```sh
npm install -g @ivorycanvas/qamap
qamap init --agent
```

이 명령은 `AGENTS.md`의 QAMap 항목, 스킬 파일과 설정 파일을 씁니다.
변경을 검토한 뒤 기본 브랜치에 커밋하면 다른 PR에서 재사용할 수 있습니다.
에이전트에는 “QAMap으로 이 PR을 리뷰해 주세요”라고 요청합니다.

에이전트의 동의 확인 경로는 다음과 같습니다.

```sh
qamap qa brief --require-consent
```

기록된 동의가 없으면 분석하지 않고 안내만 반환합니다. 설치만으로 분석에
동의한 것은 아닙니다. 반복 사용 동의, 테스트 실행, 의존성 설치도 서로 다른
선택입니다. 자세한 내용은 [에이전트 연동](agent-integration.md)을 참고하세요.

| 환경 | 안내 |
| --- | --- |
| ChatGPT·Codex 플러그인 | [OpenAI QAMap 목록](https://chatgpt.com/plugins/plugins_6a752ca134a481919b90c45c09ab1629) |
| Claude Code | [설치와 제출 경로](claude-code.md) |
| 플러그인 없이 사용 | 로컬 CLI와 `qamap init --agent` |

호스트에는 로컬 체크아웃과 터미널 접근이 필요합니다. 플러그인이 요구하는
CLI 버전과 해당 배포 경로의 설치 안내를 확인하세요. QAMap의 분석 자체는
모델을 호출하지 않지만, 호스트가 브리프를 요청하고 읽는 데는 토큰을 사용합니다.
절감률이나 리뷰 품질은 [측정 결과와 한계](../release-validation.md)를 함께 봅니다.

## 팀에서 반복 사용하기

기존 테스트 명령은 유지하면서 반복 실행용 스크립트를 추가할 수 있습니다.

```sh
pnpm add -D @ivorycanvas/qamap
pnpm exec qamap init --scripts
pnpm qa
pnpm qa:local
```

`qa`는 커밋된 브랜치 변경을, `qa:local`은 작업트리 변경도 분석합니다.
기존 스크립트 이름은 명시적으로 덮어쓰기를 선택하지 않으면 유지합니다.

검토된 팀의 정책을 재사용하려면 기본 브랜치에서 선택적으로 시작합니다.

```sh
qamap manifest init .
```

생성된 `.qamap/manifest.yaml`을 검토하고, 오래 유지할 동작·기대 결과·검증
출처만 팀의 기준으로 승격하세요. QAMap의 추측을 자동으로 업무 정책에 넣지
않습니다. [Manifest 안내](manifest.md)를 참고하세요.

## 추가 기능은 필요할 때 선택하기

| 목적 | 명령 |
| --- | --- |
| 자동화 초안 미리보기 | `qamap e2e draft . --base origin/main --head HEAD --dry-run` |
| 검토한 초안 쓰기 | `qamap e2e draft . --base origin/main --head HEAD` |
| 종합 검증 보고서 | `qamap verify . --base origin/main --head HEAD --pr-body-file pr-body.md` |
| 저장소 안전성 점검 | `qamap scan .` |
| 하위 패키지 안전성 점검 | `qamap scan services/listing --workspace-root . --json` |

초안 미리보기와 파일 쓰기는 구분됩니다. 초안은 실제 선택자·픽스처·단언·러너
설정이 확인되기 전에는 실행된 회귀 테스트가 아닙니다. 처음에는 결과를
참고용으로 보고, 원인과 조치를 이해한 규칙부터 CI에 적용하는 것이 좋습니다.

모노레포의 `qa brief`는 선택한 하위 디렉터리의 diff를 좁혀 읽으며, 호출자와
테스트 참조는 저장소 범위에서 찾을 수 있습니다. 일반 `scan`·`doctor`의
패키지·저장소 경계에는 `--workspace-root`를 명시합니다.

전체 옵션과 CI 예시는 [영문 도입 가이드](../adoption.md),
[명령어 안내](../commands.md), [GitHub Action](../github-action.md)을 참고하세요.
