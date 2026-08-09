# QAMap 빠른 시작

[한국어 문서 홈](README.md) | [English walkthrough](../quickstart-demo.md)

## 1. 검토할 브랜치에서 실행하기

Node.js 20 이상이 설치된 로컬 저장소에서 실행합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

QAMap은 일반적인 저장소에서 base branch를 자동으로 찾습니다. 자동 판정이
맞지 않을 때만 명시합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```

아직 커밋하지 않은 변경까지 포함하려면 다음 옵션을 사용합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa --include-working-tree
```

## 2. 첫 화면에서 확인할 것

1. **Change:** 현재 PR의 주요 변경 의도가 맞는지 확인합니다.
2. **Verify before merge:** 정상·실패·경계·상태 전환 시나리오가 실제 변경과 연결되는지 확인합니다.
3. **Evidence:** 각 판단에 변경 파일과 줄 근거가 있는지 확인합니다.
4. **Next:** 기존 검증 실행과 선택적 E2E 초안 중 무엇이 선택됐는지 확인합니다.

판단이 너무 넓거나 근거가 약하면 전체 Markdown trace를 엽니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa --format markdown
```

## 3. 실행 상태 구분하기

- `not-run`: QAMap이 정적 분석과 라우팅만 수행했습니다.
- `passed`: 명시적으로 실행한 저장소 명령이 성공했습니다.
- `failed`: 실행한 저장소 명령이 실패했습니다.
- `blocked`: 실행 조건이나 안전 경계 때문에 명령을 수행하지 못했습니다.

`qa` 결과에 테스트 코드나 명령이 보여도 실행된 것이 아닙니다. 실제 기존
검증 하나를 실행하려면 action contract를 확인한 뒤 명시적으로 실행합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa run
```

이 통과 결과는 선택된 명령만 증명하며, 모든 제품 시나리오의 성공을
의미하지 않습니다.

## 4. 테스트 환경이 없는 저장소

테스트 runner가 없어도 QAMap은 변경 동작과 필요한 QA 시나리오를 먼저
제시합니다. runner 설치는 자동으로 수행하지 않으며, E2E 초안은 다음과
같이 미리 볼 수 있습니다.

```sh
npx --yes @ivorycanvas/qamap@latest e2e draft . --dry-run
```

초안이 유용하려면 route, action, assertion이 실제 저장소 근거와 맞는지
검토해야 합니다. 생성되었다는 사실만으로 회귀 테스트가 완성된 것은
아닙니다.
