# Agent Profiler — 설계 스펙

- 날짜: 2026-10-09 (rev.2 — 설정 훅 방식에서 Claude Code **mod**(함수 훅) 방식으로 전환)
- 상태: Draft (리뷰 대기)
- 대상: Claude Code ≥ 2.1.287 (2.1.292에서 검증). mods API는 early access이므로 릴리스마다 `.claude-plugin/types/`를 다시 확인한다.

## 1. 목적

Claude Code 세션이 "왜 오래 걸리는지"를 시간 범주별로 분해해 실시간으로 보여주는 mod.

| 질문 | 답하는 지표 |
|---|---|
| 모델 응답이 느린가? | 요청별 `model.request` 시간, TTFT, thinking/출력 스트림 시간, 토큰/초 |
| Bash 명령이 느린가? | 명령별 실행 시간 Top N, 범주(test/build/install/git/…)별 합계 |
| 같은 파일을 반복해서 읽는가? | 경로별 Read 횟수, "중간 수정 없는 재읽기" 횟수 |
| 서브에이전트가 병목인가? | 에이전트별 wall time·내부 분해, 부모를 블로킹했는지 여부 |
| 테스트가 시간을 다 쓰는가? | `test` 범주 Bash의 합계와 에이전트 시간 대비 비율 |

Agent → Tool → Filesystem → Subagent 관계를 span 트리로 재구성하고, OpenTelemetry(OTLP/JSON)로 내보내
Jaeger / Grafana Tempo에서 볼 수 있게 한다.

### 비목표
- 모델 서버 내부(큐잉/prefill/디코딩/GPU) 시간의 분해. 원리적으로 관찰할 수 없다.
- 비용 계산, 자체 웹 UI(OTLP 백엔드가 대신한다).
- hot reload를 넘어서는 세션 데이터 복원. reload되면 메모리 상태가 초기화되고, 디스크 스냅샷만 남는다.

## 2. 핵심 원칙: 관찰 가능성 등급

모든 span과 지표에는 출처를 `agent_profiler.observability`로 표기한다. "추론 시간"이라는 말은 쓰지 않는다.

| 등급 | 의미 | 예 |
|---|---|---|
| `measured` | 엔진이 직접 측정해 넘긴 값 | `classic.PostToolUse.duration_ms` (툴 실행 시간) |
| `observed` | mod가 프로세스 안에서 이벤트 경계 시각으로 잰 구간 | `turn.step` 송신→첫 청크→종료, `tool.call` 진입→복귀 |
| `reported` | API가 보고한 값 | `usage.output_tokens`, cache read/creation 토큰 |
| `inferred` | 위 값들로 계산한 잔여 구간 | 툴 대기 = wall − exec, 엔진 오버헤드 = 턴 − (요청 ∪ 툴) |

### 시간 범주 (한 컨텍스트 = 메인 루프 또는 서브에이전트 루프)

```
turn (turn.start → turn.complete)                                    observed
├─ model.request (turn.step: next 호출 → 스트림 종료)                 observed
│   ├─ ttft            : 송신 → 첫 청크     (네트워크+큐잉+prefill, 분리 불가)
│   ├─ thinking.stream : 첫 thinking 청크 → 마지막 thinking 청크
│   └─ output.stream   : 첫 text/tool 청크 → 종료
│   + usage(토큰)                                                     reported
├─ tool (tool.call: 진입 → next 복귀)                                 observed
│   ├─ exec    = duration_ms                                          measured
│   └─ wait    = wall − exec                                          inferred
│        tool.check 판정이 'ask'면 approval wait(사용자 또는 auto 모드 분류기), 아니면 tool.overhead
├─ subagent (classic.SubagentStart → classic.SubagentStop)            observed
│   └─ (재귀) model.request / tool
└─ engine.overhead = 턴 − (model.request ∪ tool ∪ 블로킹 subagent)     inferred
     (컨텍스트 구성, 훅, 압축 등 요청과 툴 사이의 클라이언트 처리)
idle: turn.complete → 다음 turn.start (에이전트 시간에서 제외)
```

TTFT와 스트림 시간도 "모델이 계산한 시간"이 아니라 클라이언트에서 관찰한 응답 대기 시간이다.
리포트와 span 속성에 이 점을 명시한다. 엔진의 재시도(retry)는 한 `turn.step` 안에 흡수되므로 그 요청의 TTFT가 늘어난 것으로 보인다.

## 3. 사용하는 이벤트 (2.1.292 타입 선언과 프로브로 확인)

| 이벤트 | 용도 | 주요 필드 |
|---|---|---|
| `session.start` | 명령 등록, 세션 ID 확보(`$.session.id()`) | `surface`, `isInteractive` |
| `turn.start` / `turn.complete` | 턴 경계 | `turnId`, `reason`, `usage` |
| `turn.step` (async generator) | 모델 요청 span, 청크 종류별 첫/마지막 시각 | `turnId`, `index`, `model`, `effort`, `agentId?`, 청크 `kind`, stop 청크의 `usage` |
| `tool.call` | 툴 span(권한 프롬프트 포함 wall) | `tool`, `tool_use_id`, `agentId?`, 툴 인자, 결과 `isError`·`text` |
| `tool.check` | 권한 판정 기록(`next(e)`로 판정만 읽음) | `tool_use_id`, `decision` |
| `classic.PostToolUse` / `classic.PostToolUseFailure` | 엔진 측정 실행 시간 | `tool_use_id`, `duration_ms` |
| `classic.SubagentStart` / `classic.SubagentStop` | 서브에이전트 수명 | `agent_id`, `agent_type` |
| `session.end` | 최종 스냅샷과 export | `reason` |

Agent 툴은 비동기(`status: async_launched`)일 수 있다. 이 경우 툴 span은 수 ms로 끝나고, 서브에이전트 span이
부모 턴이 끝난 뒤에도 이어진다. Agent 툴 결과의 `agentId`로 툴 span과 서브에이전트 span을 잇는다. 연결되지 않으면
같은 루프에서 SubagentStart 시점에 열려 있던 Agent 툴 span으로 대체한다.

## 4. 아키텍처

```
Claude Code 엔진 (in-process)
  │ turn.* / tool.* / classic.*
  ▼
hooks/register.tsx ── 어댑터: 이벤트 → Profiler 메서드 호출(시각은 Date.now())
  │                    UI: Pane, 상태줄 / 명령: /profile, /profile-pane, /profile-export
  ▼
hooks/core/  (순수 TypeScript, $ 없음 → 단위 테스트 가능)
  profiler.ts  상태 기계: 이벤트 → span 레코드
  analyze.ts   범주 합계, 병렬성, Bash 범주, 반복 읽기, 서브에이전트, findings
  classify.ts  classifyCommand(cmd) → test|build|install|git|search|other
  report.ts    Markdown 리포트(명령 출력), 짧은 상태줄 문자열, Pane 행
  otlp.ts      span → OTLP/JSON ExportTraceServiceRequest
  ids.ts       결정적 ID(FNV-1a 64bit)
```

### 4.1 Profiler (상태 기계)
- 입력 메서드는 모두 명시적 시각 `t`(ms)를 받는다. 테스트에서 시간을 주입하기 위해서다.
  `turnStart`, `turnComplete`, `stepStart`, `stepChunk(kind)`, `stepEnd(usage)`, `toolStart`, `toolCheck`,
  `toolEnd`, `toolDuration`, `subagentStart`, `subagentStop`.
- 컨텍스트 키: `agentId ?? 'main'`. 턴은 `turnId`로, 요청은 `turnId#index`로, 툴은 `tool_use_id`로 식별한다.
- `classic.PostToolUse`와 `tool.call` 복귀는 순서가 보장되지 않으므로 `tool_use_id` 기준으로 병합한다.
- 메모리 상한: 요청+툴 span 20,000개. 넘으면 끝난 span을 오래된 것부터 90%까지 버리고, 버린 개수를 리포트에 표시한다.
- 끝나지 않은 span(인터럽트·reload)은 `status=incomplete`로 표시하고, 리포트 시점의 `now`로 잘라 계산한다.

### 4.2 Analyzer
- 범주 합계: model.request(ttft/thinking/output), tool.exec, tool.overhead, permission.wait, engine.overhead, subagent wall.
- 병렬성: 툴 시간 합 대비 툴 구간 합집합.
- Bash: `classifyCommand`로 범주별 합계와 명령 Top N(명령은 80자로 자른다).
- 반복 읽기: 경로별 Read 횟수. 같은 경로·같은 범위(offset/limit)를 Write/Edit/MultiEdit/NotebookEdit 없이 다시 Read하면 `redundant`.
  큰 파일을 범위별로 나눠 읽는 것은 반복으로 세지 않는다.
  Bash로 수정한 파일은 보이지 않는다(리포트에 명시).
- 서브에이전트: 에이전트별 wall·요청·툴 시간, `blocking`(동기 Agent 호출) 여부.
- Findings: 임계값 규칙. 예: 테스트 ≥ 25%, 같은 파일 수정 없이 3회 이상 재읽기, 모델 대기 ≥ 70%,
  권한 대기 ≥ 20%, 블로킹 서브에이전트가 턴의 50% 이상.

### 4.3 UI와 명령
- `/profile [all|turn]`: Markdown 리포트를 명령 출력으로 반환한다. VS Code 채팅 패널과 `-p`에서도 보이는 유일한 출력이다.
- `/profile-pane`: 터미널/데스크톱에서 실시간 Pane을 연다(진행 중인 요청·툴, 범주 막대, 최근 findings).
- 상태줄 `$.ui.status`: `⏱ model 61% · tools 28% · ▶ Bash npm test 14s` 형태. 다시 그리기는 최대 2회/초로 제한한다.
- `/profile-export`: OTLP JSON 파일을 쓰고, 엔드포인트가 설정돼 있으면 POST한다. 결과 경로와 상태를 반환한다.

### 4.4 Export
- OTLP/JSON. HTTP는 `POST {endpoint}/v1/traces`, `Content-Type: application/json`, `$.http.fetch` 사용.
- `traceId` = 세션 UUID에서 `-` 제거(32hex). `spanId` = FNV-1a 64(종류+키)(16hex). 결정적이므로 같은 세션을 다시 보내면 같은 span이 된다.
- Resource: `service.name=claude-code`, `session.id`, `agent_profiler.version`.
- 속성: GenAI semconv 우선(`gen_ai.operation.name`=`chat`|`execute_tool`|`invoke_agent`, `gen_ai.request.model`,
  `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.agent.id`, `gen_ai.usage.input_tokens`/`output_tokens`),
  나머지는 `agent_profiler.*`(`observability`, `category`, `exec_ms`, `wait_ms`, `ttft_ms`, `fs.path`, `bash.category`, `permission`).
- 하위 단계(ttft/thinking/output, exec/wait)는 각각 자식 span으로 만든다. Jaeger 타임라인에서 바로 보이게 하기 위해서다.
- 서브에이전트 span은 비동기라도 Agent 툴 span의 자식으로 둔다. OTel은 부모보다 오래 사는 자식을 허용한다.
- 자동 저장: `turn.complete`와 `session.end`마다 `<outputDir>/<sessionId>.otlp.json`을 덮어쓴다. `otlpEndpoint`가 있으면 POST도 한다(실패는 무시하고 상태줄에 한 번 표시).
- `userConfig`: `otlpEndpoint`(기본 ""), `outputDir`(기본 `~/.claude/agent-profiler`).

## 5. 오류 처리 — 프로파일러는 세션을 절대 방해하지 않는다
- 모든 관찰 훅은 기록 코드를 `safe()`(try/catch)로 감싸고 항상 `next(e)`의 결과를 그대로 반환한다.
- `tool.call`에는 `.catch(($, e, next) => next(e))`를 단다. `next`를 이미 불렀다면 settle된 값을 재생하므로 툴이 두 번 실행되지 않는다.
- `turn.step` 제너레이터는 모든 청크를 변경 없이 그대로 `yield`하고, 기록만 `safe()`로 감싼다.
- `tool.check`는 `next(e)`의 판정을 그대로 반환한다(판정을 바꾸지 않는다).
- 파일·HTTP 실패는 삼키고 상태줄에 한 번만 표시한다.

## 6. 테스트
- `claude plugin test`(`tests/*.test.ts`). core 모듈은 순수 함수라 시각을 주입해 결정적으로 검증한다.
  - profiler: 턴/요청/툴 페어링, 병렬 툴, `PostToolUse`가 먼저 오는 경우, 권한 ask, 비동기·동기 서브에이전트, 미완료 span.
  - analyze: 범주 합계 불변식(합 ≤ 턴), 반복 읽기, Bash 범주, findings 임계값.
  - otlp: 구조, 결정적 ID, parentSpanId 관계, 서브에이전트 link.
- 통합 테스트: `$.tool.call`과 `$.command.run('profile')`으로 어댑터를 검증한다.
- 정적 검사: `claude plugin validate`, `tsc -p`.
- 수동 E2E: 이 세션에서 hot reload로 로드해 `/profile` 출력을 확인하고, Jaeger로 export해 트리를 확인한다.

## 7. 디렉터리 (저장소 = 마켓플레이스)
```
.claude-plugin/marketplace.json          # plugins: [{ name: "agent-profiler", source: "./agent-profiler" }]
agent-profiler/
  .claude-plugin/plugin.json             # userConfig 포함
  hooks/hooks.json                       # { "modules": ["./register.tsx"] }
  hooks/register.tsx
  hooks/core/{types,ids,profiler,analyze,classify,report,otlp}.ts
  tests/*.test.ts
  examples/jaeger/docker-compose.yml
  README.md
```
개발 중에는 이 세션의 mods 폴더(`~/.claude/dev-mods/<session>/agent-profiler`)에 저장소 폴더를 심볼릭 링크로 연결해 hot reload한다.
설치: `/plugin install agent-profiler --marketplace YeonwooSung/my-claude-code-mods`.

## 8. 실행 환경별 동작
| 환경 | 훅·기록·export | Pane/상태줄 | `/profile` 텍스트 |
|---|---|---|---|
| 터미널 `claude` | ✔ | ✔ | ✔ |
| Desktop Code 탭 | ✔ | ✔ | ✔ |
| VS Code 채팅 패널 | ✔ | ✘ (그리기가 표시되지 않음) | ✔ |
| `claude -p` / SDK | ✔ | ✘ | ✔ |
