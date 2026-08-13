# QAMap 한국어 문서

[English](../en/README.md) | **한국어**

처음 실행하는 방법부터 결과를 읽고 팀의 QA 기준을 보완하는 방법까지,
QAMap을 사용하는 데 필요한 내용을 한국어로 정리했습니다. 세부 명령과
출력 형식은 영문 기술 문서에 연결해 두었습니다.

## 처음 시작하기

| 하고 싶은 일 | 문서 |
| --- | --- |
| 설치하지 않고 한 번 실행해 보기 | [빠른 시작](quickstart.md) |
| Codex, ChatGPT 또는 다른 에이전트에서 사용하기 | [에이전트 연동](agent-integration.md) |
| 반복되는 오해를 저장소별 QA 기준으로 보완하기 | [Manifest 안내](manifest.md) |
| 제품 개요부터 다시 보기 | [한국어 README](../../README.ko.md) |

## 자주 쓰는 명령

```sh
npx --yes @ivorycanvas/qamap@latest qa
npx --yes @ivorycanvas/qamap@latest qa --format markdown
npx --yes @ivorycanvas/qamap@latest qa --format agent
```

| 더 자세히 보고 싶은 내용 | 영문 기술 문서 |
| --- | --- |
| 모든 CLI 옵션 | [명령어 목록](../commands.md) |
| 에이전트용 JSON 출력 형식 | [Agent format](../agent-format.md) |
| E2E 초안 예시 | [E2E output examples](../e2e-output-examples.md) |
| 공개 검증 범위와 결과 | [Benchmarking](../benchmarking.md) |
| 앞으로의 계획 | [Roadmap](../roadmap.md) |

## 문서 표기 기준

- 명령, 파일 경로, JSON 필드명은 실제 출력과 같게 적습니다.
- `not-run`, `passed`, `failed`, `blocked`는 실행 상태를 구분하는 값이므로
  번역하지 않습니다.
- 한국어 문서는 처음 사용하는 흐름과 판단 기준을 설명하고, 전체 옵션과
  파일 형식은 영문 기술 문서에서 관리합니다.
