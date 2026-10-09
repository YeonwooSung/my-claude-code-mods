# Context Inspector — 설계 스펙

- 상태: 승인됨 (2026-10-10)
- 대상: Claude Code mods API (타입 선언 2.1.292, 기본 활성화 2.1.287+)
- 위치: `context-inspector/` (이 저장소 = 마켓플레이스, agent-profiler와 나란히)

## 1. 목적

장시간 세션에서 컨텍스트가 무엇으로 차 있는지, 왜 같은 정보가 다시 들어오는지,
컴팩션이 무엇을 잃었는지를 사용자가 한눈에 보게 한다.

1. **점유 분석** — 살아 있는(현재 윈도우에 남은) 항목을 종류·도구·대상(파일)별로 집계한다.
2. **재읽기 분석** — 같은 파일을 다시 읽은 이유를 분류하고, 순수 낭비를 ≈토큰으로 보인다.
3. **유사 출력 탐지** — 정확히 같거나 거의 같은 도구 출력의 클러스터를 찾는다.
4. **컴팩션 전/후 비교** — 주요 엔티티(편집 파일, 읽은 파일, 오류, 사용자 요구)의 보존률.
5. **효율 지표** — 턴별 컨텍스트 증가량 대비 코드 수정 라인 수.
6. **추천** — 위 분석에서 나온 규칙 기반 추천, 각 항목에 근거와 ≈절감량.

### 비목표

- 컨텍스트를 바꾸지 않는다. 관찰 + 추천만 한다(측정이 측정 대상을 바꾸면 분석이 거짓말이 된다).
  모든 훅은 `next(e)`를 그대로 반환하고, `session.compact`도 `await next(e)` 결과를 그대로 넘긴다.
- 모델 내부의 토큰별 점유율·주의(attention)는 주장하지 않는다.
- 임베딩 기반 의미 유사도는 v1에 없다. 유사도는 **어휘 기반 LSH(SimHash)** 이며 보고서에 그렇게 적는다.
- 원문 텍스트를 저장하지 않는다. 해시·크기·대상(경로/명령)만 보관한다.

## 2. 핵심 원칙: 관찰 가능성 등급

| 등급 | 뜻 | 예 |
|---|---|---|
| measured | API가 보고한 값 | `turn.step` stop 청크의 usage(input + cache_read + cache_creation) |
| observed | 엔진이 넘긴 원자료에서 직접 계산 | 행의 문자 수, 해시, 컴팩션 전/후 메시지 집합 |
| estimated | 추정 | 행별 토큰 수(문자 수 기반, 측정값으로 보정), 엔진의 `/context` breakdown |

보고서의 토큰 수는 항목 단위면 항상 `≈`를 붙인다. 측정값(요청 입력 토큰)은 `≈` 없이 표시한다.

### 토큰 추정과 보정

- 기본: `estTokens = ceil(chars / 4)`.
- 보정 계수 `k`: 같은 컨텍스트(main 또는 agentId)에서 연속한 두 요청의 측정 입력 토큰 차이 Δ와
  그 사이 추가된 항목들의 `estTokens` 합 S로 `k = clamp(ΣΔ / ΣS, 0.5, 2.0)`.
  컴팩션이 끼거나 Δ ≤ 0 인 구간과 S < 200 인 구간은 버린다. 표본이 없으면 `k = 1`.
- 보고서 값 = `round(estTokens × k)`. 보고서 머리에 `k`와 표본 수를 표시한다.

## 3. 사용하는 이벤트와 호출 (2.1.292 타입 선언으로 확인)

| 이벤트 / 호출 | 용도 |
|---|---|
| `session.append` | 대화에 들어오는 모든 행. `door`(`tool-result`, `prompt`, `response`, `attachment`, `hook-context`, ...), `uuid`, `agentId`, `origin`(`kind: 'tool'`이면 `tool` 이름), `message.content`(ApiContentBlock[]; `tool_result` 블록의 `tool_use_id`, `content`) |
| `tool.call` | `tool_use_id` ↔ 도구 이름·입력(file_path, offset/limit, command, pattern, Edit의 old/new_string, Write의 content). 입력만 기록하고 `next(e)` 반환 |
| `turn.step` | 스트리밍 훅. stop 청크의 usage로 측정 입력 토큰. `agentId`로 컨텍스트 구분 |
| `turn.start` / `turn.complete` | 메인 턴 경계(턴 번호) |
| `session.compact` | `trigger`가 `precompute`이면 무시. 그 외: `e.messages`(전)와 `await next(e)`의 `messages`(후), `tokensBefore/After`. 후 메시지 중 `handle`이 있는 것은 유지된 원 메시지 |
| `$.session.messages()` | 로드 시 1회 백필(리로드 복구) |
| `$.session.usage()` | 상태줄의 `context.percent`; 명령 실행 시에만 `{ breakdown: 'summary' }`로 고정 오버헤드(시스템 프롬프트, MCP 스키마, 메모리 파일, 스킬) |
| `session.start` / `command.register` / `command.run` / `ui.render` / `$.ui.status` / `$.ui.toast` / `$.fs.write` / `$.env.get` | UI·명령·내보내기 |

`session.append`는 원문을 볼 수 있는 유일한 지점이므로, 해시·SimHash·엔티티 추출은 여기서 동기적으로 하고 원문은 버린다.

## 4. 아키텍처

agent-profiler와 같은 구조: **순수 코어 + 얇은 어댑터**.

```
context-inspector/
  .claude-plugin/plugin.json      # userConfig: outputDir, toastAdvice
  hooks/hooks.json                # { "modules": ["./register.tsx"] }
  hooks/register.tsx              # 어댑터: 이벤트 → Ledger 호출, 명령, UI, 내보내기
  hooks/core/
    types.ts                      # ContextItem, ReadInfo, EditInfo, CompactionRec, Ledger 스냅샷
    text.ts                       # 블록 → 텍스트, 정규화, 문자 수
    hash.ts                       # fnv1a64(정확 해시), simhash64, hamming
    tokens.ts                     # 추정과 보정 계수
    ledger.ts                     # 상태 기계(항목, 턴, 컨텍스트별 live 집합, 컴팩션 epoch)
    entities.ts                   # 컴팩션 비교용 엔티티 추출
    lines.ts                      # Edit/Write 변경 라인 수
    analyze/occupancy.ts
    analyze/rereads.ts
    analyze/similar.ts
    analyze/compaction.ts
    analyze/efficiency.ts
    advice.ts                     # 규칙 기반 추천
    report.ts                     # 텍스트 보고서, 상태줄, 패널 줄
    export.ts                     # JSONL 직렬화(원문 없음, 대상 redaction)
    format.ts, redact.ts          # agent-profiler에서 복사(플러그인 간 모듈 공유 불가)
  tests/*.test.ts
  README.md
```

### 4.1 Ledger (상태 기계)

`ContextItem`:

```
{ seq, uuid, ctx: 'main' | agentId, turn, door, tool?, toolUseId?,
  target?: { kind: 'file'|'command'|'pattern'|'url'|'agent'|'other', value, range? },
  chars, est, hash, simhash?, epoch, live, isError?, backfilled? }
```

- 항목은 `session.append` 한 행 = 하나. `tool_result` 블록이 여러 개인 행은 블록마다 하나.
- `target`은 `tool.call`에서 미리 받은 입력을 `toolUseId`로 조인해 만든다
  (Read/Edit/Write/NotebookEdit → file, Bash → command, Grep/Glob → pattern, WebFetch → url, Agent → agent).
- `simhash`는 문자 수 ≥ 200 인 tool-result에만. 해시 입력은 앞 256 KiB로 자른다.
- `live`: 컨텍스트의 현재 epoch에 남은 항목. 컴팩션 시 4.4 규칙으로 갱신.
- 편집 기록 `EditInfo { ctx, turn, seq, path, linesChanged }`는 `tool.call`(Edit/MultiEdit/Write/NotebookEdit)이 성공한 뒤 기록한다.
- 측정 입력 토큰 표본 `{ ctx, turn, seq, inputTokens, epoch }`은 `turn.step` stop 청크마다.
- 상한: 항목 20,000개. 넘치면 가장 오래된 **non-live** 항목부터 버리고 `dropped`를 센다.
  live 항목은 버리지 않는다(점유 분석이 틀어지므로); 그래도 넘치면 가장 오래된 것부터 버리고 `droppedLive`를 센다.
- `version` 카운터: 변경마다 증가, 요약 캐시 키.

### 4.2 재읽기 분류 (analyze/rereads.ts)

같은 ctx에서 같은 경로의 Read 결과 항목 R(이전 Read P가 있을 때):

| 분류 | 조건 | 낭비로 셈 |
|---|---|---|
| `unchanged-live` | P가 아직 live, P와 R 사이 그 경로 편집 없음, 범위 동일, 해시 동일 | 예 (R의 ≈토큰 전부) |
| `after-edit` | P와 R 사이 그 경로 편집 있음 | 아니오 |
| `after-compaction` | P가 R 시점에 non-live(컴팩션으로 빠짐), 편집 없음 | 별도 집계("컴팩션 유발") |
| `different-range` | 범위(offset/limit)가 다름 | 아니오 |
| `changed-externally` | 편집 없음, 범위 동일, 해시 다름 | 아니오 |

분류는 다음 순서로 처음 맞는 것: different-range → after-edit → after-compaction → changed-externally → unchanged-live.
P는 같은 경로·같은 범위의 가장 최근 Read(범위가 다른 것만 있으면 가장 최근 Read).

### 4.3 유사 출력 (analyze/similar.ts)

- 정확 중복: 같은 `hash`, tool-result, 문자 수 ≥ 200.
- 근사 중복: 단어 3-shingle의 64비트 SimHash, 해밍 거리 ≤ 3, 정확 중복 아님.
- 클러스터: union-find. 64비트를 16비트 4블록으로 나눈 밴드 버킷으로 후보만 비교(대략 O(n)).
  해밍 ≤ 3이면 4블록 중 최소 하나가 같으므로(비둘기집) 누락 없음.
- 클러스터 낭비 ≈ 클러스터 합계 − 가장 큰 항목(live 항목 기준).
- 정규화: 연속 공백 축약, 숫자 런은 `#`로(타이밍·카운터가 다른 테스트 출력도 묶이도록).

### 4.4 컴팩션 비교 (analyze/compaction.ts, ledger)

`session.compact`(trigger ≠ precompute):

1. 전: `e.messages`에서 엔티티 추출 — 편집 파일(Edit/Write 등 toolUses의 file_path), 읽은 파일, 오류(isError 결과의 첫 줄 앞 120자),
   사용자 요구(사용자 메시지에서 길이 ≥ 4 인 식별자형 토큰: 경로, `snake_case`, `camelCase`, 백틱 안 문자열; 최대 50개).
2. `const r = await next(e)`. `r.skip`이면 기록하지 않고 r 반환.
3. 후: `r.messages`의 text + toolUses input/text + toolResults text를 합친 문자열에서 각 엔티티가 등장하는지(경로는 basename도 허용).
4. live 갱신: 후 메시지 중 `handle`이 있는 메시지에 남은 `tool_use_id` 집합 K. 해당 ctx의 live 항목 중
   `toolUseId ∈ K`인 것만 live 유지, 나머지(및 toolUseId 없는 항목)는 non-live. epoch 증가.
   요약 메시지(handle 없는)는 새 항목 `door: 'compaction'`으로 추가(문자 수 기준).
5. `CompactionRec { ctx, trigger, at turn, tokensBefore?, tokensAfter?, entities: {type, value, kept}[], keptItems, droppedItems }`.
6. 후속: 이후 `after-compaction` 재읽기 중 이 컴팩션에서 잃은 파일을 다시 읽은 것의 ≈토큰을 "재유입 비용"으로 연결.

훅은 실패해도 `r`을 그대로 반환한다(분석 코드는 try/catch).

### 4.5 효율 (analyze/efficiency.ts)

메인 턴별:
- `growth` = 그 턴 마지막 측정 입력 토큰 − 이전 턴 마지막 측정 입력 토큰(같은 epoch일 때만; 컴팩션이 끼면 `n/a`).
- `linesChanged` = 그 턴의 EditInfo 합. Edit: old/new를 줄로 나눠 공통 접두·접미 줄을 뺀 나머지 줄 수의 합(삭제 + 추가).
  MultiEdit: 각 edit 합. Write: content 줄 수. NotebookEdit: new_source 줄 수.
- `tokensPerLine` = growth / linesChanged (lines = 0이면 표시 `—`, 그 턴은 "탐색 턴").
- 세션 합계와 중앙값. 탐색은 정당하므로 경고가 아니라 정보로 표시.

### 4.6 추천 (advice.ts)

각 추천 `{ id, severity: 'high'|'medium'|'low', title, evidence, savings≈ }`. 규칙:

| id | 조건 | 추천 |
|---|---|---|
| `reread-unchanged` | unchanged-live 낭비 ≥ 2,000≈ 또는 같은 파일 3회 이상 | 이미 컨텍스트에 있는 내용; 필요한 부분만 Grep/offset |
| `large-read` | 단일 Read ≥ 8,000≈, offset/limit 없음 | offset/limit 또는 Grep으로 범위 좁히기 |
| `large-bash` | 단일 Bash 결과 ≥ 5,000≈ | `| tail -n`, `-q`, 필터로 출력 줄이기 |
| `repeated-output` | 유사 클러스터 크기 ≥ 3 또는 낭비 ≥ 3,000≈ | 실패 테스트만 다시 돌리기 등 범위 좁히기 |
| `compaction-lost-edits` | 컴팩션에서 편집 파일 엔티티를 잃음 | `/compact <지시>`로 보존할 것 명시, 또는 계획을 파일로 |
| `compaction-reflow` | after-compaction 재읽기 ≥ 5,000≈ | 위와 동일, 핵심 파일 요약을 지시에 포함 |
| `agent-verbose` | Agent 결과 ≥ 4,000≈ | 서브에이전트에 요약 길이 제한 지시 |
| `mcp-unused` | breakdown의 MCP 서버 스키마 ≥ 3,000≈ 이고 세션 중 그 서버 도구 호출 0 | 서버 비활성화/지연 로딩 고려 |
| `memory-large` | breakdown 메모리 파일 하나 ≥ 4,000≈ | CLAUDE.md 다듬기 |

`mcp-unused`, `memory-large`는 breakdown이 있을 때(명령 실행 시)만. 심각도: savings ≥ 10,000≈ high, ≥ 3,000≈ medium, 그 외 low.
토스트: userConfig `toastAdvice`(기본 true)이면 high 추천이 처음 생길 때 세션당 1회.

## 5. UI와 명령

- `/context-inspect [overview|occupants|rereads|similar|compactions|efficiency|advice] [--agents]`
  — 텍스트 보고서(모든 환경에서 동작; VS Code 패널은 mod 그림을 표시하지 않으므로 기본 출력).
  기본은 overview(각 섹션 상위 3개 + 추천). 기본 범위는 main; `--agents`면 서브에이전트 컨텍스트도.
- `/context-pane` — `$.ui.open({ id: 'context-inspector' })` 패널, 버전 변경 시 갱신.
- 상태줄: `ctx 62% · waste≈8.1k` (percent는 `$.session.usage()`, 없으면 생략; waste = unchanged-live + 유사 클러스터 낭비, 중복 계산 제외).
  턴 완료 시와 컴팩션 후에만 갱신(`$.clock.after(0)`로 합침).
- `/context-export` — `<outputDir>/<sessionId>/context-<loadId>.jsonl`. 한 줄에 하나:
  `{"type":"item"|"edit"|"sample"|"compaction"|"summary", ...}`. 원문 없음, 대상의 command/url은 redact 후 200자로 자름.
  outputDir 기본: `$.env.get('HOME')/.claude/context-inspector`. 4 MiB를 넘으면 여러 파일(`-<n>`)로 나눈다.

## 6. 오류 처리 — 인스펙터는 세션을 절대 방해하지 않는다

- 모든 훅은 `next(e)`를 그대로 반환. 분석·기록은 try/catch로 감싸고 실패는 무시(디버그 로그 한 줄).
- `tool.call`, `session.append`, `session.compact`에 `.catch(($, e, next) => next(e))`.
- `session.compact`: `next(e)` 호출은 정확히 한 번, 결과는 변형 없이 반환.
- 리로드: `session.start`에서 상태 초기화 후 `$.session.messages()` 백필(항목 `backfilled: true`, 턴/시간 정보 없음, 모두 live로 간주).
  백필 실패는 무시.
- 성능: `session.append` 경로는 O(행 길이). 요약은 version 캐시. 항목 20k에서 요약 < 200 ms.

## 7. 테스트

- 코어 단위 테스트(픽스처 대화): 텍스트 추출, 해시/SimHash/해밍, 토큰 보정, ledger 조인·live 갱신·상한,
  재읽기 5분류, 유사 클러스터(정확/근사/밴드 누락 없음), 엔티티 추출·보존 판정, 변경 라인 수, 효율, 추천 규칙, 보고서, export redaction.
- 어댑터 테스트(`claude plugin test`): 훅이 next 결과를 그대로 반환, 명령 등록·실행, compact 결과 무변형.
- 성능 테스트: 항목 20k 요약 시간.
- 타입 검사: `tsc -p context-inspector --noEmit`(타입 선언은 gitignore된 `.claude-plugin/types/`).

## 8. Review Focus (스펙이 함의하지만 놓치기 쉬운 입력)

1. `tool_result.content`가 문자열이 아니라 블록 배열(이미지 포함)인 경우 — 텍스트만 세고 이미지는 고정 추정(1,500≈)으로.
2. `tool.call` 없이 도착한 tool-result(백필, 서브에이전트, 알 수 없는 id) — target 없이 기록, 재읽기에서 제외.
3. 서브에이전트 컴팩션(`e.agentId`) — 그 ctx의 live 집합만 갱신.
4. `next(e)`가 skip을 반환하거나 throw — 상태 변경 없음, 결과/예외 그대로 전파.
5. 매우 큰 단일 출력(수 MB) — 해시는 256 KiB 절단, 문자 수는 전체.

## 9. 실행 환경별 동작

agent-profiler와 동일: 터미널은 상태줄·패널·토스트·명령 모두, VS Code 채팅 패널은 훅과 명령 텍스트 출력만.
`claude -p`에서는 명령·UI 없이 기록만(내보내기는 `/context-export` 대신 session.end 시 자동 저장하지 않음 — v1).
