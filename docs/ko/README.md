# QAMap 한국어 문서

[English](../en/README.md) | **한국어**

QAMap을 처음 실행하고 결과를 판단하는 데 필요한 핵심 문서를 한국어로
제공합니다. 세부 스키마와 내부 구조처럼 유지보수 범위가 큰 기술 명세는
영문 원문을 기준으로 하며, 한국어 문서에서 해당 원문을 직접 연결합니다.

## 처음 시작하기

| 하고 싶은 일 | 문서 |
| --- | --- |
| 설치 없이 한 번 실행하고 결과 이해하기 | [빠른 시작](quickstart.md) |
| Codex, ChatGPT 또는 다른 에이전트에서 사용하기 | [에이전트 연동](agent-integration.md) |
| 반복되는 오해를 저장소 맥락으로 보정하기 | [Verification manifest](manifest.md) |
| 제품 개요부터 다시 보기 | [한국어 README](../../README.ko.md) |

## 명령 빠른 찾기

```sh
npx --yes @ivorycanvas/qamap@latest qa
npx --yes @ivorycanvas/qamap@latest qa --format markdown
npx --yes @ivorycanvas/qamap@latest qa --format agent
```

| 목적 | 영문 상세 명세 |
| --- | --- |
| 모든 CLI 옵션 | [Command reference](../commands.md) |
| 출력 JSON 계약 | [Agent format](../agent-format.md) |
| E2E 초안 사례 | [E2E output examples](../e2e-output-examples.md) |
| 공개 검증 기준 | [Benchmarking](../benchmarking.md) |
| 현재 로드맵 | [Roadmap](../roadmap.md) |

## 번역 원칙

- 명령, 파일 경로, schema 필드명은 번역하지 않습니다.
- `not-run`, `passed`, `failed`, `blocked` 실행 상태를 원문 그대로 보존합니다.
- 한국어 문서의 제품 주장과 명령은 영문 기준 문서 및 현재 릴리스와 함께 검증합니다.
- 번역이 뒤처졌을 때는 영문 기술 명세를 우선합니다.
