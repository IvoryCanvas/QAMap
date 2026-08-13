# QAMap 빠른 시작

[한국어 문서 홈](README.md) | [English walkthrough](../quickstart-demo.md)

## 1. 확인할 브랜치에서 실행하기

Node.js 20 이상이 설치된 환경에서 저장소를 열고 다음 명령을 실행합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa
```

대부분의 저장소에서는 비교할 기준 브랜치를 자동으로 찾습니다. 자동으로
고른 브랜치가 맞지 않을 때만 직접 지정하세요.

```sh
npx --yes @ivorycanvas/qamap@latest qa . --base origin/main --head HEAD
```

아직 커밋하지 않은 변경도 함께 확인하려면 다음 옵션을 사용합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa --include-working-tree
```

## 2. 첫 결과에서 확인할 것

1. **Change:** QAMap이 이해한 주요 변경 내용이 실제 작업과 맞는지 봅니다.
2. **Verify before merge:** 정상 동작뿐 아니라 실패, 경계값, 상태 변화에서
   확인할 항목이 이번 변경과 연결되는지 봅니다.
3. **Evidence:** 각 판단이 실제 변경 파일과 코드 위치를 가리키는지 봅니다.
4. **Next:** 지금 실행할 수 있는 검증과 추가로 검토할 초안을 확인합니다.

범위가 너무 넓거나 판단 근거를 더 보고 싶다면 Markdown 형식으로
출력하세요.

```sh
npx --yes @ivorycanvas/qamap@latest qa --format markdown
```

## 3. 분석과 실행을 구분하기

- `not-run`: 코드 변경을 분석했지만 테스트 명령은 실행하지 않았습니다.
- `passed`: 사용자가 명시적으로 실행한 저장소 명령이 성공했습니다.
- `failed`: 실행한 저장소 명령이 실패했습니다.
- `blocked`: 필요한 환경이나 안전 조건을 충족하지 못해 실행하지 않았습니다.

`qa` 결과에 테스트 명령이나 초안이 보여도 실행된 것은 아닙니다. QAMap이
고른 기존 검증 명령 하나를 실제로 실행하려면 실행 조건을 먼저 확인한 뒤
다음 명령을 사용합니다.

```sh
npx --yes @ivorycanvas/qamap@latest qa run
```

명령이 통과해도 그 명령의 범위만 확인된 것입니다. 제품의 모든 기능이
정상이라는 뜻은 아닙니다.

## 4. 테스트 환경이 없는 저장소

테스트 도구가 없어도 QAMap은 달라진 동작과 병합 전에 확인할 QA 항목을
먼저 정리합니다. 테스트 도구를 임의로 설치하지 않으며, 자동화 가능한
근거가 있으면 E2E 초안을 다음 명령으로 미리 볼 수 있습니다.

```sh
npx --yes @ivorycanvas/qamap@latest e2e draft . --dry-run
```

초안의 시작 화면, 사용자 동작, 확인할 결과가 실제 저장소 코드와 맞는지
검토하세요. 초안이 만들어졌다는 사실만으로 회귀 테스트가 완성되거나
실행된 것은 아닙니다.
