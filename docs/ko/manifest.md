# Verification Manifest

[한국어 문서 홈](README.md) | [English manifest reference](../manifest.md)

manifest는 첫 실행에 필수가 아닙니다. QAMap이 반복해서 같은 핵심 흐름을
잘못 해석할 때, 팀이 검토한 QA 맥락을 저장소에 남기는 선택적 보정
수단입니다.

## 언제 만드는가

- 중요한 사용자 흐름의 이름과 진입 경로를 반복해서 놓칠 때
- 어떤 변경에 어떤 검증 명령을 신뢰하는지 팀 기준이 있을 때
- selector, fixture, 실패 조건처럼 저장소 코드만으로 확정하기 어려운 계약이 있을 때
- 한 번의 사람 보정을 이후 PR에서도 재사용하고 싶을 때

## 기본 브랜치에서 초안 만들기

공유 기준은 최신 default branch에서 생성합니다. QAMap은 사용자의 branch를
자동으로 바꾸지 않습니다.

```sh
git switch main
git pull --ff-only
npx --yes @ivorycanvas/qamap@latest manifest init
```

생성된 `.qamap/manifest.yaml`은 바로 정답으로 취급하지 않습니다. 사람이
domain, flow, check, anchor, validation command를 검토한 뒤 커밋합니다.

## 검증하고 현재 PR에 연결하기

```sh
npx --yes @ivorycanvas/qamap@latest manifest validate
npx --yes @ivorycanvas/qamap@latest manifest explain . --base origin/main --head HEAD
```

`manifest explain`은 현재 변경과 연결된 flow와 check, 그리고 판단이 틀렸을
때 수정할 정확한 manifest 경로를 보여줍니다.

## 유지 원칙

- 자동 생성 결과를 팀 정책으로 바로 승격하지 않습니다.
- 제품별 임시 예외보다 여러 PR에서 유지될 핵심 흐름만 기록합니다.
- QAMap이 틀렸을 때 전체 파일을 다시 만들지 말고 안내된 항목만 보정합니다.
- manifest 변경도 일반 코드처럼 리뷰와 검증을 거칩니다.
- 비밀값, 고객 데이터, 개인 환경 경로를 기록하지 않습니다.

상세 schema와 필드 예시는 영문 [Verification manifest](../manifest.md)를
기준으로 합니다.
