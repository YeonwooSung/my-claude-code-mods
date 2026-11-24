# Agent Profiler Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax. Implementation authorized by the user on 2026-11-25. Work is implemented in place; commits are unavailable because the sandbox cannot write Git refs.

**Goal:** `/profile-pane`에 세션 시간 구성·최근 턴별 구성·느린 개별 호출 차트를 추가한다.

**Architecture:** 기존 `attribute()`와 `SummaryCache`를 활용한다. 순수한 차트 모델에서 terminal Raster와 Desktop/VS Code SVG를 생성하며, 좁은 영역·미지원 환경·오류에서는 기존 텍스트 표시를 사용한다.

**Tech Stack:** 기존 TypeScript/TSX, Claude Code mods UI API, Node core test runner, `claude-code/testing`. 추가 의존성 없음.

**Spec:** [설계 초안](../specs/2026-11-25-profiler-charts-design.md). 아래 수치와 UX는 에이전트의 제안이며 사용자 결정으로 간주하지 않는다.

## Global Constraints

- 대상 엔진: 2.1.302와 2.1.329.
- 최근 턴 최대 12개, 느린 개별 호출 최대 5개.
- 패널 너비 40열 미만 또는 본문 높이 8행 미만이면 기존 텍스트 표시.
- Raster 너비는 실제 패널 너비와 512열 이하, SVG 하나는 131072자 이하.
- live 500ms 캐시와 기존 갱신 제한 유지. 상시 타이머·의존성·통신·영속화 추가 없음.
- model / subagent / tool / engine의 배타적 시간 귀속은 기존 구현과 동일.
- 렌더링 중 I/O 없음. mod 단독 배포 유지.

## Review Focus

1. 병렬 호출과 백그라운드 에이전트에서 시간을 중복 합산하지 않는다(Task 1).
2. 비유한 값·0ms·좁은 영역에서 잘못된 Raster/SVG를 반환하지 않는다(Task 2).
3. 라벨의 비밀값·XML 기호·Unicode 때문에 누출이나 깨진 SVG가 발생하지 않는다(Task 2).
4. /clear·reload·세션 전환 뒤 이전 세션 차트를 표시하지 않는다(Task 3).
5. 엔진이 수락한 SVG와 실제 앱 화면 검증을 구분한다(Task 4).

## 파일 구성

| 파일 | 역할 |
|---|---|
| Modify `agent-profiler/hooks/core/analyze.ts` | 기존 집계 루프에서 최근 턴별 구성과 slowest.running 반환 |
| Create `agent-profiler/hooks/core/chart.ts` | 차트 모델, 폭 배분, 라벨 처리, Raster/SVG 데이터 생성 |
| Create `agent-profiler/hooks/chart-view.tsx` | surface 분기와 UI 요소 구성 |
| Modify `agent-profiler/hooks/register.tsx` | 기존 pane에 차트 연결 |
| Modify `agent-profiler/tests/analyze.test.ts`, `cache.test.ts`, `perf.test.ts` | 정확성·캐시·계산량 검증 |
| Create `agent-profiler/tests/chart.test.ts` | UI에 의존하지 않는 차트 데이터 검증 |
| Modify `agent-profiler/tests/adapter.test.ts` | 실제 엔진의 surface·갱신·lifecycle 검증 |
| Modify `agent-profiler/README.md`, root `README.md` | 사용법과 환경별 검증 상태 |
| Modify `agent-profiler/.claude-plugin/plugin.json`, runtime VERSION | 릴리스 버전 일치 |
| Create `docs/verification/2026-11-25-profiler-charts.md` | 실행 명령·버전·화면 검증 결과 |

## Task 1: 정확한 턴별 시간 구성을 생성한다

**Interfaces**

- Consumes: `summarize(s: Snapshot, scope?: Scope): Summary`, `attribute(window, tagged)`.
- Produces: `TurnBreakdown = { id: string; retainedIndex: number; wallMs: number; exclusive: Record<Category, number>; running: boolean }`.
- `Summary.recentTurns: TurnBreakdown[]`를 추가한다. retainedIndex는 해당 scope가 보관한 메인 턴의 1부터 시작하는 순서다. 최근 12개를 오래된 순서대로 반환한다. `scope='turn'`은 최대 1개다.
- `Summary.tools.slowest` 원소에 `running: boolean`을 추가한다. 원본 ToolRec의 end 유무로 계산한다.

- [x] 병렬 구간이 있는 두 턴에서 각 턴의 카테고리 합=wallMs, 전체 합이 기존 결과와 일치하는 실패 테스트를 작성한다.
- [x] 13턴이면 retainedIndex 2~13만 반환하고, turn scope는 마지막 1개만 반환하며, 백그라운드 에이전트는 추가 시간으로 합산되지 않는지 테스트한다. open turn은 snapshot.now까지 증가하고 미완료 slowest는 running인지 확인한다.
- [x] `node --experimental-transform-types --import ./scripts/core-loader.mjs --test agent-profiler/tests/analyze.test.ts`로 미구현 필드 때문에 실패함을 확인한다.
- [x] 기존 mainTurns 루프에서 계산된 part를 재사용해 recentTurns를 만든다. 턴마다 전체 span을 재분석하지 않는다.
- [x] cache.test.ts에서 같은 500ms bucket의 summary 재사용, 다음 bucket의 running 시간 증가, 완료 후 고정, profiler 교체 후 캐시 폐기를 새 필드에도 검증한다.
- [x] analyze/cache/perf 테스트를 실행한다. 기존 20k spans / 2000 turns의 200ms 조건을 유지하며 recentTurns=12와 합계 일치도 확인한다. 통과한 Task 1을 독립 커밋한다.

## Task 2: 숫자 모델과 환경별 차트 렌더러를 구현한다

**Interfaces — `core/chart.ts`**

- `ChartDatum = { label: string; ms: number; category?: Category }`.
- `ChartModel = { totalMs: number; categories: ChartDatum[]; turns: { label: string; totalMs: number; running: boolean; segments: ChartDatum[] }[]; slowest: { label: string; ms: number; running: boolean }[]; droppedTurns: number; incomplete: number }`.
- `chartModel(sum: Summary): ChartModel`: model, tool, subagent, engine 순서. 라벨은 report와 동일한 의미. slowest는 기존 결과에서 최대 5개 사용.
- `allocateCells(values: readonly number[], width: number, scaleMax: number): number[]`: 비유한 값과 음수는 0으로, 폭은 유한 정수 0~512로 정규화한다. 유효한 양수 scaleMax에 대해 `round(width * min(sum(values) / scaleMax, 1))`을 목표 총폭으로 정하고, 각 값의 비율에 따라 최대 나머지 방식으로 배분한다. 같은 나머지는 입력 순서대로 처리한다. 0 이하/비유한 scaleMax 또는 전체 값 0이면 모두 0이다.
- `rasterBars(model: ChartModel, columns: number, maxTurns: number): { columns: number; rows: number; cells: string }`: 차트 행만 담은 packed 셀 데이터. columns는 호출 전에 1~512로 보장한다.
- `svgBars(model: ChartModel, maxTurns: number): { source: string; alt: string }`: 동일한 스케일과 내용의 정적 SVG. 수치·범례·running·누락 표시 포함.

- [x] chart.test.ts에 빈 값·0·NaN·Infinity·음수, 폭 0/1/39/40/512/초과, 나머지 동률, 최대 12턴의 실패 테스트를 작성한다.
- [x] 라벨에 `<>&"`, 줄바꿈, 이모지, 자격증명을 넣고 마스킹 후 XML 이스케이프되며 alt에도 비밀값이 남지 않는지 테스트한다.
- [x] `node --experimental-transform-types --import ./scripts/core-loader.mjs --test agent-profiler/tests/chart.test.ts`로 실패를 확인한 후 순수 함수를 구현한다. DataView로 Raster의 little-endian triplets·크기·문자·색을 검증한다.
- [x] SVG에 script·외부 URL·이벤트 속성이 없고 길이 상한 이내인지, 각 차트의 스케일이 설계와 일치하는지 검증한다.
- [x] chart-view.tsx에 `renderCharts($: EngineInterface, e: RenderInput<'Pane'>, model: ChartModel): RenderElement | undefined`를 구현한다. 함수 안에서 surface를 좁힌 뒤 `$.ui.resolve(e)`를 호출한다. `any`로 요소 유무를 감추지 않는다.
- [x] 높이에 따라 턴 행 수를 줄인다. 40열/8행 기준 미달이면 undefined를 반환해 기존 표시로 복귀한다. terminal은 Raster, desktop/vscode는 Svg를 반환하며 나머지 surface는 텍스트 표시를 사용한다. 범례·running·느린 호출 설명은 문자로도 제공한다.
- [x] 차트 테스트와 `npx tsc -p agent-profiler`를 통과시키고 Task 2를 독립 커밋한다.

## Task 3: 실제 엔진의 pane에 연결한다

**Interfaces**

- Consumes: `cachedSummary()`, `chartModel()`, `renderCharts()`, 기존 `paneLines()`.
- Produces: 기존 `/profile-pane` 안의 차트. `/profile`, `/profile turn`, export 명령 계약 유지.

- [x] adapter.test.ts에 terminal/desktop/vscode pane mount, 너비 39/40과 높이 7/8의 경계, 빈 데이터의 실패 테스트를 작성한다.
- [x] `claude plugin test agent-profiler`로 새 assertion의 실패를 확인한다.
- [x] register.tsx의 pane에서 같은 cached summary로 모델을 만들고 렌더링한다. 차트 생성만 좁게 catch하고 오류 시 기존 paneLines로 복귀한다. 기존 실행 중 항목과 findings를 유지하고 중복 정보는 제거한다.
- [x] main turn/model/tool/complete 이벤트를 주입해 실제 집계와 표시값 일치, in-flight 갱신, StopFailure 후 정지, clear/reload와 세션 교체를 검증한다.
- [x] 다른 requestId의 pane에 개입하지 않는지, export와 도구 전달이 그대로인지, 반복 render에 추가 fs/http/store 호출이 없는지 확인한다.
- [x] invalidate를 stub으로 무력화하지 않고 실제 갱신 경로를 검증한다. drawn()의 자식은 props.children이 아니라 children에 있고 Text key는 유지되지 않을 수 있으므로 그 구조에 맞춰 검사한다.
- [x] 2.1.302와 2.1.329 각각으로 `<binary> plugin test agent-profiler`, `<binary> plugin validate agent-profiler`를 실행하고 결과를 기록한다. Task 3을 독립 커밋한다.

## Task 4: 실제 화면·회귀 검증과 문서를 마무리한다

- [ ] 실제 terminal에서 `claude --plugin-dir ./agent-profiler`로 고정된 읽기·짧은 로컬 처리 작업을 수행하고 `/profile-pane`을 표시한다. 차트와 `/profile` 수치, 폭 변경, 스크롤, Esc와 입력 복귀를 직접 확인한다.
- [ ] 실제 Desktop과 VS Code를 각각 확인하고 앱/확장/엔진 버전을 기록한다. 사용할 수 없는 환경은 미검증으로 남기고 엔진 결과로 대체해 성공을 주장하지 않는다.
- [x] `npm test`, `npm run test:adapters`, `npm run typecheck`, `npm run test:privacy`를 실행하고 종료 코드·건수·실패를 기록한다. 실패가 있으면 원인을 분류하며 무관한 실패도 숨기지 않는다.
- [x] 구현 시점의 manifest/runtime 버전을 확인해 다음 patch로 함께 갱신한다. 현재 0.1.7이면 0.1.8이다. README에 세 차트, 기록 보관 범위, running, 환경별 검증 상태, 텍스트 fallback 조건을 명시한다.
- [x] 검증 기록과 차이를 자체 검토한다. 라벨·alt의 비밀값, 보고서와 차트 수치 일치를 중점 확인하고 Task 4를 독립 커밋한다.

## 실행 순서와 후속 단계

Task 1 → Task 2 → Task 3 → Task 4를 같은 세션에서 순차 구현하는 방식을 제안한다. 집계 타입과 렌더링 타입의 의존성이 강해 처음부터 나눠 작업할 이점이 작다.

Profiler 실제 화면을 평가한 뒤 Context Inspector의 입력 토큰 추이·압축 마커, Time Machine의 분기·테스트 타임라인, 상태 관리 mod의 현재 상태 막대 순서로 별도 계획을 작성한다. 후속 mod는 이 첫 버전의 완료 조건에 포함하지 않는다.

## 실행 결과

- 자동 검증 관련 체크는 완료했다. 각 단계에 함께 적힌 커밋은 아래의 샌드박스 제한으로 생략했다.
- Task 1–3 구현 완료. Task 4 자동 검증과 브라우저 SVG 검토 완료; native 앱 화면은 미검증이다.
- 사용자 요청 범위의 제품 변경을 현재 작업 폴더에 남겼다. `.git` 쓰기 제한으로 task별 커밋은 생성하지 않았다.
- 독립 리뷰 에이전트는 사용량 제한으로 실행되지 못했다. 자체 검토 결과와 검증 범위는 [검증 기록](../../verification/2026-11-25-profiler-charts.md)을 참조한다.

## 계획 자체 검토

- 시간 귀속과 부분 이력은 Task 1, 값 정규화와 렌더링은 Task 2, lifecycle과 fallback은 Task 3, 실제 표시와 회귀는 Task 4에서 검증한다.
- 새 데이터 수집이나 OTLP 형식 변경 작업은 없다.
- 구현 전 확인할 제안은 대상 mod와 첫 버전의 세 차트다. 계획 작성 후 후속 요청으로 구현이 승인되었다.
