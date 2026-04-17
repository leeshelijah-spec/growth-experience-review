# Growth Experience Review (G.E.R)

[English README](./README.md)

### *"이 '이야기'는 내가 바이브코딩의 길을 걷기 시작한 이야기."*

Growth Experience Review는 Codex 아카이브 세션을 주간 단위로 분석해 6개 평가축 점수, 내부 점수, A~E 등급, 대표 타입, `Reversed` 경고 상태를 함께 보여주는 리포트와 대시보드를 생성합니다.

## 개요

- 평가축은 6개로 고정됩니다.
  - `명확성`
  - `맥락 제공력`
  - `절차 설계력`
  - `검증성`
  - `복구력`
  - `회고 지속성`
- 각 축은 `0-100` 내부 점수로 계산되고, 다시 `A-E` 표시 등급으로 변환됩니다.
- 대표 타입은 자유 서술이 아니라 규칙 기반으로 판정됩니다.
- `Reversed`는 별도 타입이 아니라, 현재 타입 위에 겹쳐지는 경고 상태입니다.

## 고정 타입 6개(타로 카드 기반)

- `Fool`: 시도와 탐색이 많고 방향을 찾는 탐색형
- `Magician`: 요청을 실제 결과물로 전환하는 실행형
- `Chariot`: 속도와 드라이브가 강한 추진형
- `Hermit`: 분석과 회고, 깊은 검토가 강한 성찰형
- `Hierophant`: 규칙, 기준, 프로세스화를 만드는 체계화형
- `Star`: 장기 개선, 방향성, 회복, 누적 발전을 중시하는 성장지향형

타입은 항상 해당 주차의 주된 작업 스타일만 요약합니다. 타입을 뒤집어 12개로 확장하지 않습니다.

## Reversed 의미

- `Reversed`는 별도 타입이 아닙니다.
- 구조적 문제, 접근 방식 재설계 필요, 같은 방식 유지 시 리스크 확대 가능성을 나타내는 경고 상태입니다.
- 결과는 항상 `타입 + Reversed 여부 + 판정 근거` 조합으로 해석합니다.

예시:

- `Magician`
- `Magician (Reversed)`

## 규칙 수정 위치

- 평가축 이름, 설명, 등급 기준, 점수 구간:
  - [config/ratings.json](./config/ratings.json)
- 6개 타입 목록, 타입 설명, 우선순위, 타입 판정 규칙:
  - [config/profile-rules.json](./config/profile-rules.json)
- `Reversed` 설명과 발생 조건:
  - [config/profile-rules.json](./config/profile-rules.json)
- 공통 판정 엔진:
  - [scripts/lib/evaluation-config.mjs](./scripts/lib/evaluation-config.mjs)

## 출력 구조

- 주간 리포트 생성:
  - [scripts/generate-weekly-review.mjs](./scripts/generate-weekly-review.mjs)
- HTML 대시보드 생성:
  - [scripts/build-dashboard.mjs](./scripts/build-dashboard.mjs)
- 생성물:
  - [generated/reports/LATEST.md](./generated/reports/LATEST.md)
  - [generated/reports/TIMELINE.md](./generated/reports/TIMELINE.md)
  - [generated/reports/index.html](./generated/reports/index.html)
  - [generated/reports/weekly](./generated/reports/weekly)

## 대시보드 구성 메모

- 상단 카드에서 대표 타입과 `Reversed` 경고 상태를 분리해서 보여줍니다.
- 대표 타입에 따라 페이지 전체 톤이 바뀝니다.
- 레이더 차트 축 라벨에 마우스를 올리면 현재 등급 기준의 판정 기준이 툴팁으로 표시됩니다.
- 레이더 툴팁 박스는 차트 중앙에 고정되며, 본문 글씨를 확대해 빠르게 읽을 수 있도록 조정했습니다.
- 자세히보기 모달은 리포트를 대시보드 친화적인 순서와 표 형태로 다시 구성합니다.
- 타입 기준 참고는 주간 리포트마다 반복하지 않고, 메인 화면의 별도 팝업에서 확인합니다.
- 주간 리포트는 이제 `명확성`, `맥락 제공력`, `검증성`, `복구력` 4축에 대해 구조 판정 요약을 추가하면서도 기존 6축 표 형식은 유지합니다.

## 최신 업데이트

- `2026-04-17`: [구조 판정 레이어 1차 적용](./docs/feature-updates/2026-04-17.md)

## 실행 방법

```powershell
npm run export
npm run report
npm run dashboard
```

한 번에 실행:

```powershell
npm run weekly
```

Windows에서 더블클릭 실행:

```powershell
run-weekly-review.cmd
```

- 성공 시 대시보드(`generated/reports/index.html`)가 기본 브라우저로 자동 실행됩니다.
- 자동 실행 없이 리포트만 만들려면 `run-weekly-review.cmd --no-open`을 사용합니다.

## 검증 방법

1. `npm run report`
2. `npm run dashboard`
3. 아래 항목을 확인합니다.

- 모든 주차의 대표 타입이 6개 중 하나인지
- `Reversed`가 별도 경고 상태로만 표시되는지
- 리포트에 타입 판정 근거와 Reversed 판정 근거가 함께 들어가는지
- 리포트에 4축 구조 판정 요약 표가 추가되고, 구조 규칙이 발동하면 보정 결과가 함께 표시되는지
- 대시보드에서 타입, 경고 상태, 근거가 시각적으로 분리되어 보이는지
- 타임라인과 주차 비교가 계속 동작하는지

## 변경 이력

- 2026-04-10까지의 변경 사항은 [CHANGELOG.md](./CHANGELOG.md)에서 날짜별로 확인할 수 있습니다.

## 감사의 인사
- 아이디어의 출발점이 된 [fivetaku/vibe-sunsang](https://github.com/fivetaku/vibe-sunsang)에 감사를 전합니다.
