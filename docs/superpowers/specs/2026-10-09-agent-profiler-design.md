# Agent Profiler — 설계 스펙

- 날짜: 2026-10-09
- 상태: Draft (리뷰 대기)
- 대상: Claude Code 2.1.x 플러그인

## 1. 목적

Claude Code 세션이 "왜 오래 걸리는지"를 시간 범주별로 분해해 보여주는 실행 프로파일러.
다음 질문에 근거 있는 숫자로 답한다.

| 질문 | 답하는 지표 |
|---|---|
| 모델 응답이 느린가? | `model.wait` 합계/비율, 요청당 thinking 시간·출력 토큰 |
| Bash 명령이 느린가? | 명령별 `tool.exec` Top N, 범주(test/build/install/git/…)별 합계 |
| 같은 파일을 반복해서 읽는가? | 경로별 Read 횟수, "중간 수정 없는 재읽기" 횟수와 바이트 |
| 서브에이전트가 병목인가? | 에이전트별 wall time, 부모를 블로킹했는지 여부, 내부 분해 |
| 테스트가 시간을 다 쓰는가? | `test` 범주 Bash의 합계와 세션 대비 비율 |

추가로 Agent → Tool → Filesystem → Subagent 관계를 span 트리로 재구성하고
OpenTelemetry(OTLP/JSON)로 내보내 Jaeger / Grafana Tempo에서 볼 수 있게 한다.

### 비목표
- 모델 내부 추론(prefill/decoding/GPU) 시간 측정 — 원리적으로 관찰 불가.
- Claude Code 프로세스 내부 계측(monkey-patch 등). 공식 hook + transcript만 사용.
- 비용 계산, 웹 UI. (OTLP 백엔드가 UI를 대신한다)

## 2. 핵심 원칙: 관찰 가능성 등급

모든 span과 지표는 `agent_profiler.observability` 속성으로 출처와 신뢰도를 명시한다.
"추론 시간"이라는 말은 쓰지 않는다.

| 등급 | 의미 | 예 |
|---|---|---|
| `measured` | Claude Code가 직접 측정해 hook에 넘긴 값 | `PostToolUse.duration_ms` |
| `observed` | 프로파일러가 hook 타임스탬프로 외부에서 관찰한 구간 | Pre→Post wall time, turn 경계 |
| `reported` | transcript에 기록된 클라이언트 측 값 | `thinkingDurationMs`, `usage.*_tokens` |
| `inferred` | 위 값들로부터 계산한 잔여 구간 | `model.wait` = 턴 − (툴 ∪ 서브에이전트) |

### 시간 범주

```
turn (UserPromptSubmit → Stop)                          observed
├─ model.wait  : 툴이 돌지 않는 모든 구간                  inferred
│   = 네트워크 + 큐잉 + prefill + 디코딩 + 클라이언트 처리
│   └─ (참고) thinking stream 시간, 토큰 수                 reported
├─ tool span   : PreToolUse → PostToolUse(Failure)          observed
│   ├─ tool.exec      = duration_ms                         measured
│   └─ tool.overhead  = wall − duration_ms                  inferred
│        (hook 실행, 스케줄링; PermissionRequest가 있었으면
│         permission.wait 로 재분류 → 사용자 시간)
└─ subagent    : SubagentStart → SubagentStop               observed
     └─ (재귀) model.wait / tool span
user.idle      : Stop → 다음 UserPromptSubmit (에이전트 시간에서 제외)
```

`model.wait`는 "모델이 생각한 시간"이 아니라 "에이전트가 모델 응답을 기다린 시간"이다.
리포트에는 이 구간에 대해 transcript의 `thinkingDurationMs`와 출력 토큰 수를 함께 보여주되,
그 값도 클라이언트가 스트림을 받은 시간(`reported`)일 뿐 서버 계산 시간이 아님을 표기한다.

## 3. 검증된 데이터 소스 (2.1.292에서 프로브로 확인)

Hook 입력 공통: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `hook_event_name`.
서브에이전트 내부에서 발생한 이벤트에는 `agent_id`, `agent_type`이 붙는다.

| 이벤트 | 사용 필드 |
|---|---|
| `SessionStart` / `SessionEnd` | `source`, `reason` |
| `UserPromptSubmit` | `prompt_id`, `prompt` (앞부분만 저장; `<task-notification>` 여부 판정) |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | `tool_use_id`, `duration_ms`, `tool_response` (요약만) |
| `PostToolUseFailure` | `tool_use_id`, `duration_ms`, `error`, `is_interrupt` |
| `PermissionRequest` | `tool_use_id` (있을 경우) — 사용자 대기 플래그 |
| `SubagentStart` | `agent_id`, `agent_type` |
| `SubagentStop` | `agent_id`, `agent_transcript_path` |
| `Stop` | `background_tasks` |
| `PreCompact` | 압축 구간 표시 |

Agent 툴 → 서브에이전트 연결: `PostToolUse(Agent).tool_response.agentId`.
Agent 툴은 비동기(`status: async_launched`)일 수 있다. 이 경우 툴 span은 수 ms로 끝나고
실제 작업은 서브에이전트 span에 있으며, 부모 턴이 끝난 뒤 `<task-notification>` 프롬프트로 결과가 돌아온다.

Transcript(`*.jsonl`, 서브에이전트는 `<session>/subagents/agent-<id>.jsonl`)의 assistant 엔트리:
`timestamp`, `requestId`, `thinkingDurationMs`, `message.usage`
(`input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`).
같은 `requestId`의 블록들을 하나의 모델 요청으로 묶는다.

## 4. 아키텍처

```
Claude Code ──hook(stdin JSON)──▶ record.mjs ──append──▶ ~/.claude/agent-profiler/events/<session>.jsonl
                                                                   │
                           transcript.jsonl ──(선택: enrich)──┐      │
                                                              ▼      ▼
                                         agent-profiler CLI: load → buildTrace → analyze
                                               ├─ report   (터미널 요약)
                                               ├─ watch    (실시간 tail)
                                               └─ export   (OTLP/JSON 파일 또는 HTTP POST)
```

- 런타임: Node.js ≥ 18, 외부 의존성 0 (ESM). 플러그인 설치만으로 동작.
- 배치: 이 저장소를 플러그인 마켓플레이스로 만들고 `plugins/agent-profiler/`에 둔다.

### 4.1 Recorder (`scripts/record.mjs`)
- 모든 hook 이벤트에 등록. `"async": true`로 등록해 에이전트를 블로킹하지 않는다
  (지원되지 않는 버전이면 동기 실행. 실행 시간은 수십 ms).
- stdin JSON을 읽고 `ts = Date.now()`(수신 시각)를 붙인다.
- 페이로드를 축약한다. `tool_response` 원문은 저장하지 않고 요약만 남긴다:
  Read는 경로·바이트·라인 수, Bash는 stdout/stderr 길이·interrupted 여부, Agent는 `agentId`·`status`.
  `tool_input`은 문자열 필드를 512자로 자른다. 프롬프트는 120자까지만 남긴다.
- 한 줄 JSON으로 append. stdout에는 아무것도 쓰지 않는다
  (UserPromptSubmit/SessionStart의 stdout은 모델 컨텍스트에 주입되므로).
- 오류가 나도 항상 exit 0. 실패는 `recorder-errors.log`에 기록.
- `AGENT_PROFILER_DISABLE=1`이면 즉시 종료.

### 4.2 Trace builder (`lib/trace.mjs`, 순수 함수)
입력: 정렬된 이벤트 배열 (+ 선택적 transcript 요청 목록). 출력: span 트리.

1. `session` 루트 span: 첫 이벤트 → SessionEnd(없으면 마지막 이벤트).
2. `turn` span: `UserPromptSubmit` → 같은 `prompt_id`의 `Stop`. 태그 `trigger=user|task-notification`.
3. `tool` span: `tool_use_id`로 Pre/Post 페어링. 부모는 `agent_id`가 있으면 해당 subagent span, 없으면 현재 turn.
   Post가 없으면(인터럽트·세션 종료) `status=incomplete`, 끝 시각은 다음 이벤트.
4. `subagent` span: `SubagentStart` → `SubagentStop`(`agent_id`). 부모는 Agent tool span이며,
   비동기면 부모 turn span 아래에 두고 Agent tool span으로의 OTel link를 추가한다.
5. `model.wait` span: 각 컨텍스트(turn 또는 subagent)의 구간에서 직속 자식 tool/subagent 구간의
   합집합을 뺀 나머지 구간마다 하나씩 생성. 병렬 툴 호출도 정확히 처리된다.
   transcript가 있으면 해당 구간에 끝나는 모델 요청(`requestId`)의 토큰·thinking 시간을 속성으로 붙인다.
6. Filesystem: Read/Write/Edit/MultiEdit/NotebookEdit/Glob/Grep span에 `fs.path`·`fs.op` 속성을 붙인다.
   별도 span을 만들지 않고 분석 단계에서 경로별로 집계한다.

### 4.3 Analyzer (`lib/analyze.mjs`)
- 범주별 합계: `model.wait`, `tool.exec`, `tool.overhead`, `permission.wait`, `user.idle`, subagent wall.
- 병렬성: 툴 시간 합 대비 툴 wall time 합집합.
- Bash 분류: `classifyCommand(cmd) → test|build|install|git|search|other`. 범주별 합계와 명령 Top N.
- 반복 읽기: 경로별 Read 횟수. 같은 경로에 Write/Edit가 없는 사이의 재Read를 `redundant`로 집계(바이트 포함).
- 서브에이전트: 에이전트별 wall, 내부 분해, `blocking`(동기 Agent 호출) 여부.
- Findings: 규칙 기반 경고 목록. 예: "테스트가 에이전트 시간의 42%", "src/app.ts를 수정 없이 5회 재읽음",
  "model.wait 비율 78% — 대부분 모델 대기".

### 4.4 Exporter (`lib/otlp.mjs`)
- OTLP/JSON(`ExportTraceServiceRequest`)을 생성한다. HTTP는 `POST {endpoint}/v1/traces`, `Content-Type: application/json`.
- `traceId` = session UUID 32hex. `spanId` = `sha256(종류+키)`의 앞 16hex라 결정적이고,
  재전송해도 같은 span이 된다.
- Resource: `service.name=claude-code`, `session.id`, `agent_profiler.version`.
- 속성: GenAI semconv를 우선 쓰고(`gen_ai.operation.name`=`chat`|`execute_tool`|`invoke_agent`,
  `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.agent.id`, `gen_ai.usage.input_tokens`/`output_tokens`),
  나머지는 `agent_profiler.*`(`observability`, `category`, `exec_ms`, `overhead_ms`, `fs.path`, `bash.category`).
- 자동 전송: `AGENT_PROFILER_OTLP_ENDPOINT`가 설정되면 `Stop`/`SessionEnd` hook에서 해당 세션 전체를 다시 export한다
  (결정적 spanId라 중복 없이 갱신됨).

### 4.5 CLI (`bin/agent-profiler.mjs`)
```
agent-profiler list                         # 기록된 세션 목록
agent-profiler report [session|--latest]    # 터미널 리포트 (--json 지원)
agent-profiler watch  [session|--latest]    # 이벤트 파일 tail, 진행 중인 툴과 누적 분해 갱신
agent-profiler export [session] --out f.json | --endpoint http://localhost:4318
```
세션 인자는 UUID 접두사 매칭을 허용한다.

### 4.6 Claude Code 통합
- `/agent-profiler:profile` 명령: 현재 세션(`--latest` + cwd 매칭)의 report를 실행해 결과를 보여준다.
- `/agent-profiler:export` 명령: OTLP 내보내기.
- `examples/jaeger/docker-compose.yml`: Jaeger all-in-one(OTLP 4318, UI 16686).

## 5. 오류 처리
- Recorder: 어떤 경우에도 Claude Code를 방해하지 않는다. exit 0, stdout 없음, 타임아웃 5s.
- 깨진 JSONL 라인은 건너뛰고 경고 수를 리포트에 표기한다.
- 페어링 실패(고아 Post, 끝나지 않은 Pre/Subagent)는 `incomplete`로 표시하고 계산에서 구간을 보수적으로 자른다.
- transcript가 없거나 형식이 바뀌면 enrichment를 건너뛴다(핵심 기능은 hook 로그만으로 동작).
- OTLP 전송 실패는 stderr 경고 후 exit 1(CLI), hook에서는 무시하고 로그만 남긴다.

## 6. 테스트
- `node --test`. 프로브로 얻은 실제 이벤트 시퀀스를 축약한 fixture를 사용한다.
- 단위: 페어링, 합집합 기반 `model.wait`, 병렬 툴, 비동기 서브에이전트, 미완료 span, 반복 읽기, 명령 분류.
- OTLP: 스키마 형태와 결정적 ID를 검증하고, 부모-자식 관계가 traceId/parentSpanId로 보존되는지 확인한다.
- Recorder: stdin → 파일 append, 축약, stdout이 비어 있음을 확인한다.
- 수동 E2E: `claude -p`로 프로브 세션을 돌린 뒤 report와 Jaeger 업로드를 확인한다.

## 7. 디렉터리
```
.claude-plugin/marketplace.json
plugins/agent-profiler/
  .claude-plugin/plugin.json
  hooks/hooks.json
  commands/profile.md, export.md
  scripts/record.mjs
  bin/agent-profiler.mjs
  lib/{store,events,transcript,trace,analyze,report,otlp,classify}.mjs
  test/*.test.mjs, test/fixtures/*.jsonl
  examples/jaeger/docker-compose.yml
  README.md
```

## 8. 열린 결정 (기본값으로 진행)
- 저장 위치: `~/.claude/agent-profiler/` (`AGENT_PROFILER_DIR`로 변경 가능).
- 보존 정책: 자동 삭제 없음. `agent-profiler prune --days N`은 추후.
- 프롬프트·명령 원문 저장 범위: 프롬프트 120자, 명령 512자. 민감 정보 마스킹은 범위 밖이다(README에 명시).
