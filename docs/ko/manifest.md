# 저장소별 QA 기준 파일

[한국어 문서 홈](README.md) | [English manifest reference](../manifest.md)

Manifest는 처음 실행할 때 필요하지 않습니다. QAMap이 같은 핵심 흐름을
반복해서 잘못 이해할 때, 팀이 확인한 QA 기준을 저장소에 남겨 다음
분석부터 참고하게 하는 선택 기능입니다.

## 언제 만들면 좋은가

- 중요한 사용자 흐름의 이름이나 시작 지점을 반복해서 놓칠 때
- 변경 종류에 따라 어떤 검증 명령을 믿을지 팀 기준이 있을 때
- 화면 요소 식별자, 테스트 데이터, 실패 조건처럼 코드만으로 확정하기
  어려운 기준이 있을 때
- 한 번 바로잡은 내용을 이후 PR에서도 다시 사용하고 싶을 때

## 기본 브랜치에서 초안 만들기

팀이 함께 사용할 기준은 최신 기본 브랜치에서 만듭니다. QAMap이 사용자의
브랜치를 자동으로 바꾸지는 않습니다.

```sh
git switch main
git pull --ff-only
npx --yes @ivorycanvas/qamap@latest manifest init
```

생성된 `.qamap/manifest.yaml`을 바로 정답으로 취급하지 마세요. 도메인,
사용자 흐름, 확인 항목, 코드 연결점, 검증 명령이 실제 프로젝트와 맞는지
사람이 검토한 뒤 커밋합니다.

## 파일 확인하고 현재 PR에 연결하기

```sh
npx --yes @ivorycanvas/qamap@latest manifest validate
npx --yes @ivorycanvas/qamap@latest manifest explain . --base origin/main --head HEAD
```

`manifest explain`은 현재 변경과 연결된 사용자 흐름과 확인 항목을 보여줍니다.
판단이 틀렸다면 어느 설정을 고쳐야 하는지도 정확한 경로로 안내합니다.

## 유지할 때 지킬 원칙

- 자동 생성 결과를 검토 없이 팀 규칙으로 사용하지 않습니다.
- 한 번만 필요한 예외보다 여러 PR에서 계속 쓰일 핵심 흐름을 기록합니다.
- QAMap이 틀렸을 때 파일 전체를 다시 만들지 말고 안내된 항목만 고칩니다.
- Manifest 변경도 일반 코드처럼 리뷰하고 검증합니다.
- 비밀값, 고객 데이터, 개인 PC의 경로를 기록하지 않습니다.

전체 필드와 작성 예시는 영문 [Manifest 기술 문서](../manifest.md)에서
확인할 수 있습니다.
