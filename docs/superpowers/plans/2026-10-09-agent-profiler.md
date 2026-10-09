# Agent Profiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code 세션의 시간을 모델 대기 / 툴 / 서브에이전트 / 엔진으로 분해해 실시간으로 보여주고, OTLP로 내보내는 mod를 만든다.

**Architecture:** 얇은 어댑터(`hooks/register.tsx`)가 mods API 이벤트를 받아, 시각을 붙여 순수 TypeScript 상태 기계(`hooks/core/profiler.ts`)에 넘긴다.
분석(`analyze.ts`), 표현(`report.ts`), 내보내기(`otlp.ts`)는 모두 `Snapshot`을 입력으로 받는 순수 함수다. 그래서 `claude plugin test`로 시각을 주입해 결정적으로 검증할 수 있다.

**Tech Stack:** Claude Code mods API(2.1.292), TypeScript(엔진이 직접 로드하므로 빌드 없음), `claude plugin test` / `claude plugin validate`.

**Spec:** `docs/superpowers/specs/2026-10-09-agent-profiler-design.md`

## Global Constraints

- 런타임은 Claude Code의 hooks 환경이다. DOM도 Node도 없고, 외부 패키지를 쓸 수 없다. 플러그인 파일 사이의 `import` 선언만 허용되고 `import()`는 쓸 수 없다. 관례로 상대 경로에 `.ts` 확장자를 붙인다.
- `$` 사용 규칙: 항상 `$.noun.method(...)` 형태로 쓴다. `$`는 최상위 함수에만 넘긴다. `on()`의 이벤트 이름은 문자열 리터럴이어야 한다.
- 프로파일러는 세션을 절대 방해하지 않는다. 기록 코드는 `safe()`로 감싸고, 이벤트 결과는 바꾸지 않고 그대로 반환한다.
- 테스트 실행: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`. 이 빌드에서는 플래그가 있어야 테스트 러너가 켜진다.
- 검증: `claude plugin validate agent-profiler`가 `✔`로 끝나야 한다.
- 리포트·UI 문자열은 영어로 쓴다(공개 mod).
- 버전 상수 `VERSION = '0.1.0'`은 `plugin.json`의 version과 같아야 한다.

## Review Focus

1. **한 tool_use_id에 PostToolUse가 tool.call 복귀보다 먼저 오거나, 툴이 시작되기 전에 오는 경우.** exec_ms가 사라지면 안 된다. → Task 2 `PostToolUse may arrive before…` 테스트.
2. **이미 바뀐 turn을 다른 컨텍스트로 옮기는 경우.** turn.start가 서브에이전트 루프에서도 불려 main 컨텍스트를 오염시킬 수 있다. → Task 2 `a subagent turn first announced…` 테스트.
3. **범위를 나눠 읽는 Read(offset/limit)를 반복 읽기로 오탐하는 경우.** → Task 4 `paged reads are not redundant` 테스트.
4. **끝나지 않은 span(인터럽트, 실행 중인 Bash).** 리포트 시점의 now로 잘려야 하고, 음수 시간이 나오면 안 된다. → Task 4 `turn scope… open spans are cut at now` 테스트.
5. **툴 결과 패스스루.** deny나 에러 결과가 프로파일러를 거치면서 바뀌면 안 된다. → Task 7 `tool.call passes the answer through unchanged` 테스트.

---

### Task 1: 스캐폴드, 공통 타입, 결정적 ID

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `agent-profiler/.claude-plugin/plugin.json`
- Create: `agent-profiler/hooks/hooks.json`
- Create: `agent-profiler/hooks/register.tsx` (임시: 빈 register)
- Create: `agent-profiler/hooks/core/types.ts`
- Create: `agent-profiler/hooks/core/format.ts`
- Create: `agent-profiler/hooks/core/ids.ts`
- Test: `agent-profiler/tests/ids.test.ts`

**Interfaces:**
- Produces: `fnv1a64(text: string): string`, `spanId(kind: string, key: string): string`, `traceIdFromSession(sessionId: string): string`
- Produces: `fmtMs(ms)`, `pct(part, whole)`, `clip(text, n)`, `bar(share, width?)`, `fmtCount(n)`
- Produces (types.ts): `Usage`, `ToolInputSummary`, `TurnRec`, `StepRec`, `ToolRec`, `AgentRec`, `Snapshot`, `Outcome`

- [ ] **Step 1: 매니페스트와 마켓플레이스 작성**

`.claude-plugin/marketplace.json`
```json
{
  "name": "my-claude-code-mods",
  "owner": { "name": "YeonwooSung" },
  "plugins": [
    {
      "name": "agent-profiler",
      "source": "./agent-profiler",
      "description": "Execution profiler for Claude Code: model wait vs tools vs subagents, live, with OTLP export"
    }
  ]
}
```

`agent-profiler/.claude-plugin/plugin.json`
```json
{
  "name": "agent-profiler",
  "version": "0.1.0",
  "description": "Execution profiler for Claude Code: model wait vs tools vs subagents, live, with OTLP export",
  "author": { "name": "YeonwooSung" },
  "userConfig": {
    "otlpEndpoint": {
      "type": "string",
      "title": "OTLP/HTTP endpoint",
      "description": "Base URL of an OTLP/HTTP collector, e.g. http://localhost:4318 (empty: write files only)",
      "default": ""
    },
    "outputDir": {
      "type": "string",
      "title": "Trace directory",
      "description": "Where <session>.otlp.json files are written (empty: ~/.claude/agent-profiler)",
      "default": ""
    }
  }
}
```

`agent-profiler/hooks/hooks.json`
```json
{ "description": "Agent Profiler hooks module", "modules": ["./register.tsx"] }
```

`agent-profiler/hooks/register.tsx` (Task 7에서 교체)
```tsx
import type { Register } from 'claude-code'

export const register: Register = () => {}
```

- [ ] **Step 2: 공통 타입과 포맷 헬퍼 작성**

`agent-profiler/hooks/core/types.ts`
```ts
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model?: string
}

export type ToolInputSummary = {
  command?: string
  description?: string
  path?: string
  range?: string
  pattern?: string
  subagentType?: string
}

export type TurnRec = { id: string; ctx: string; start: number; end?: number; reason?: string; prompt: string }

export type StepRec = {
  id: string
  ctx: string
  turnId: string
  index: number
  model: string
  effort?: string
  start: number
  firstContent?: number
  thinkFirst?: number
  thinkLast?: number
  outFirst?: number
  end?: number
  usage?: Usage
  stopReason?: string
}

export type ToolRec = {
  id: string
  ctx: string
  turnId?: string
  tool: string
  input: ToolInputSummary
  start: number
  end?: number
  execMs?: number
  decision?: string
  isError?: boolean
  denied?: boolean
  launchedAgentId?: string
  launchedAsync?: boolean
}

export type AgentRec = { id: string; agentType: string; start: number; end?: number; parentToolId?: string }

export type Snapshot = {
  sessionId: string
  now: number
  turns: TurnRec[]
  steps: StepRec[]
  tools: ToolRec[]
  agents: AgentRec[]
  dropped: number
}

export type Outcome = { denied: boolean; isError: boolean; launchedAgentId?: string; launchedAsync?: boolean }
```

`agent-profiler/hooks/core/format.ts`
```ts
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1_000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

export function pct(part: number, whole: number): string {
  // part * 100 first: (6050 / 10000) * 100 is 60.49999… in floating point.
  return whole > 0 ? `${Math.round((part * 100) / whole)}%` : '0%'
}

export function clip(text: string, n: number): string {
  const line = text.replace(/[\r\n\t]+/g, ' ')
  return line.length <= n ? line : `${line.slice(0, Math.max(0, n - 1))}…`
}

export function bar(share: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function fmtCount(n: number): string {
  return n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n)
}
```

- [ ] **Step 3: 실패하는 ID 테스트 작성**

`agent-profiler/tests/ids.test.ts`
```ts
import { expect, test } from 'claude-code/testing'

import { fnv1a64, spanId, traceIdFromSession } from '../hooks/core/ids.ts'

test('fnv1a64 matches the reference vectors', () => {
  expect(fnv1a64('')).toBe('cbf29ce484222325')
  expect(fnv1a64('a')).toBe('af63dc4c8601ec8c')
})

test('span ids are deterministic, kind-scoped and 16 hex digits', () => {
  expect(spanId('tool', 'x')).toBe(spanId('tool', 'x'))
  expect(spanId('tool', 'x')).not.toBe(spanId('step', 'x'))
  expect(spanId('tool', 'x')).toMatch(/^[0-9a-f]{16}$/)
})

test('trace id is the session uuid without dashes, or a hash otherwise', () => {
  expect(traceIdFromSession('8201ea2b-079a-467e-9ef6-a14e37417dde')).toBe('8201ea2b079a467e9ef6a14e37417dde')
  expect(traceIdFromSession('unknown')).toMatch(/^[0-9a-f]{32}$/)
})
```

- [ ] **Step 4: 실패 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: FAIL. `../hooks/core/ids.ts`를 찾을 수 없다.

- [ ] **Step 5: ids.ts 구현**

`agent-profiler/hooks/core/ids.ts`
```ts
const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK = 0xffffffffffffffffn

export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME) & MASK
  }
  return hash.toString(16).padStart(16, '0')
}

// OTLP rejects an all-zero span id.
export function spanId(kind: string, key: string): string {
  const id = fnv1a64(`${kind}:${key}`)
  return id === '0000000000000000' ? '0000000000000001' : id
}

export function traceIdFromSession(sessionId: string): string {
  const hex = sessionId.replace(/-/g, '').toLowerCase()
  if (/^[0-9a-f]{32}$/.test(hex) && !/^0+$/.test(hex)) return hex
  return fnv1a64(`trace:${sessionId}`) + fnv1a64(`trace2:${sessionId}`)
}
```

- [ ] **Step 6: 통과 확인과 검증**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test && claude plugin validate .`
Expected: 3 pass. Validate는 `✔`로 끝난다.

- [ ] **Step 7: Commit**

```bash
git add .claude-plugin agent-profiler
git commit -m "feat(agent-profiler): scaffold mod, shared types and deterministic ids"
```

---

### Task 2: Profiler 상태 기계

**Files:**
- Create: `agent-profiler/hooks/core/profiler.ts`
- Test: `agent-profiler/tests/profiler.test.ts`

**Interfaces:**
- Consumes: Task 1의 `types.ts`
- Produces:
  - `MAIN = 'main'`, `isAgentTool(tool: string): boolean`, `toolLabel(tool: ToolRec): string`
  - `summarizeInput(tool: string, input: Record<string, unknown>): ToolInputSummary`
  - `toolOutcome(answer: unknown): Outcome`
  - `type RunningItem = { kind: 'model' | 'tool' | 'agent'; label: string; ctx: string; ms: number }`
  - `class Profiler(sessionId = 'unknown', maxSpans = 20_000)` with `turnStart(t, turnId, prompt?, ctx?)`,
    `turnComplete(t, turnId, reason?)`, `stepStart(t, {turnId,index,model,effort?,agentId?}): string`,
    `stepChunk(t, stepId, kind)`, `stepUsage(stepId, usage, stopReason?)`, `stepEnd(t, stepId)`,
    `toolStart(t, {id,tool,agentId?,input})`, `toolCheck(id, decision)`, `toolDuration(id, ms)`,
    `toolEnd(t, id, outcome)`, `subagentStart(t, agentId, agentType)`, `subagentStop(t, agentId)`,
    `running(now): RunningItem[]`, `snapshot(now): Snapshot`, `readonly sessionId`

- [ ] **Step 1: 실패하는 테스트 작성**

`agent-profiler/tests/profiler.test.ts`
```ts
import { expect, test } from 'claude-code/testing'

import { Profiler, summarizeInput, toolOutcome } from '../hooks/core/profiler.ts'

const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, model: 'm' }
const ok = { denied: false, isError: false }

test('a turn with one request and one tool', () => {
  const p = new Profiler('s')
  p.turnStart(0, 't1', 'fix it')
  const step = p.stepStart(10, { turnId: 't1', index: 0, model: 'm' })
  p.stepChunk(15, step, 'engine')
  p.stepChunk(300, step, 'thinking')
  p.stepChunk(900, step, 'thinking')
  p.stepChunk(1000, step, 'tool')
  p.stepChunk(1100, step, 'stop')
  p.stepUsage(step, usage, 'tool_use')
  p.stepEnd(1100, step)
  p.toolStart(1200, { id: 'toolu_1', tool: 'Bash', input: { command: 'npm test' } })
  p.toolDuration('toolu_1', 4000)
  p.toolEnd(5300, 'toolu_1', ok)
  p.turnComplete(6000, 't1', 'answer')
  const s = p.snapshot(7000)
  expect(s.turns).toEqual([{ id: 't1', ctx: 'main', start: 0, end: 6000, reason: 'answer', prompt: 'fix it' }])
  expect(s.steps[0]).toEqual({
    id: 't1#0', ctx: 'main', turnId: 't1', index: 0, model: 'm', start: 10,
    firstContent: 300, thinkFirst: 300, thinkLast: 900, outFirst: 1000, end: 1100, usage, stopReason: 'tool_use',
  })
  expect(s.tools[0].turnId).toBe('t1')
  expect(s.tools[0].execMs).toBe(4000)
  expect(s.tools[0].end).toBe(5300)
})

test('PostToolUse may arrive before tool.call returns, or before the tool is seen', () => {
  const p = new Profiler('s')
  p.toolDuration('a', 50)
  p.toolStart(0, { id: 'a', tool: 'Read', input: { path: '/x' } })
  p.toolEnd(60, 'a', ok)
  p.toolStart(100, { id: 'b', tool: 'Read', input: { path: '/y' } })
  p.toolDuration('b', 7)
  p.toolEnd(110, 'b', ok)
  const s = p.snapshot(200)
  expect(s.tools.map(t => t.execMs)).toEqual([50, 7])
})

test('subagent work attaches to the agent context and its Agent tool', () => {
  const p = new Profiler('s')
  p.turnStart(0, 't1')
  p.toolStart(10, { id: 'toolu_agent', tool: 'Agent', input: { subagentType: 'Explore' } })
  p.subagentStart(12, 'ag1', 'Explore')
  p.toolEnd(14, 'toolu_agent', { denied: false, isError: false, launchedAgentId: 'ag1', launchedAsync: true })
  const step = p.stepStart(20, { turnId: 'sub-t', index: 0, model: 'h', agentId: 'ag1' })
  p.stepEnd(40, step)
  p.toolStart(50, { id: 'toolu_r', tool: 'Read', agentId: 'ag1', input: { path: '/a' } })
  p.toolEnd(60, 'toolu_r', ok)
  p.subagentStop(100, 'ag1')
  const s = p.snapshot(200)
  expect(s.agents[0]).toEqual({ id: 'ag1', agentType: 'Explore', start: 12, end: 100, parentToolId: 'toolu_agent' })
  expect(s.tools.find(t => t.id === 'toolu_r')?.ctx).toBe('ag1')
  expect(s.tools.find(t => t.id === 'toolu_r')?.turnId).toBe('sub-t')
  expect(s.turns.find(t => t.id === 'sub-t')).toEqual({ id: 'sub-t', ctx: 'ag1', start: 20, end: 100, reason: 'agent-stop', prompt: '' })
  expect(p.running(200)).toEqual([])
})

test('a subagent turn first announced by turn.start moves out of the main context', () => {
  const p = new Profiler('s')
  p.turnStart(0, 'main-t')
  p.turnStart(5, 'sub-t')
  p.stepStart(6, { turnId: 'sub-t', index: 0, model: 'h', agentId: 'ag1' })
  p.toolStart(7, { id: 'x', tool: 'Read', input: {} })
  const s = p.snapshot(8)
  expect(s.tools[0].turnId).toBe('main-t')
  expect(s.turns.find(t => t.id === 'sub-t')?.ctx).toBe('ag1')
})

test('retried steps get distinct ids; open spans show as running, longest first', () => {
  const p = new Profiler('s')
  const a = p.stepStart(0, { turnId: 't', index: 0, model: 'm' })
  const b = p.stepStart(5, { turnId: 't', index: 0, model: 'm' })
  expect([a, b]).toEqual(['t#0', 't#0.1'])
  p.toolStart(1, { id: 'b1', tool: 'Bash', input: { command: 'sleep 9' } })
  expect(p.running(1001).map(r => r.label)).toEqual(['model m', 'Bash sleep 9', 'model m'])
})

test('finished spans are dropped past the cap and counted', () => {
  const p = new Profiler('s', 10)
  for (let i = 0; i < 12; i += 1) {
    p.toolStart(i, { id: `t${i}`, tool: 'Read', input: {} })
    p.toolEnd(i + 1, `t${i}`, ok)
  }
  const s = p.snapshot(100)
  expect(s.tools.length).toBe(10)
  expect(s.dropped).toBe(2)
})

test('summarizeInput and toolOutcome read the engine shapes', () => {
  expect(summarizeInput('Bash', { command: 'ls', description: 'list' })).toEqual({ command: 'ls', description: 'list' })
  expect(summarizeInput('Read', { file_path: '/a', offset: 10, limit: 5 })).toEqual({ path: '/a', range: '10:5' })
  expect(summarizeInput('Read', { file_path: '/a' })).toEqual({ path: '/a' })
  expect(summarizeInput('Grep', { pattern: 'x', path: 'src' })).toEqual({ pattern: 'x', path: 'src' })
  expect(summarizeInput('Agent', { subagent_type: 'Explore', description: 'look' })).toEqual({ subagentType: 'Explore', description: 'look' })
  expect(toolOutcome({ result: { status: 'async_launched', agentId: 'ag' } })).toEqual({ denied: false, isError: false, launchedAgentId: 'ag', launchedAsync: true })
  expect(toolOutcome({ deny: 'no' })).toEqual({ denied: true, isError: false, launchedAgentId: undefined, launchedAsync: false })
  expect(toolOutcome(undefined)).toEqual({ denied: false, isError: false, launchedAgentId: undefined, launchedAsync: false })
})
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: FAIL. `profiler.ts`를 찾을 수 없다.

- [ ] **Step 3: profiler.ts 구현**

`agent-profiler/hooks/core/profiler.ts`
```ts
import type { AgentRec, Outcome, Snapshot, StepRec, ToolInputSummary, ToolRec, TurnRec, Usage } from './types.ts'

export const MAIN = 'main'

export type RunningItem = { kind: 'model' | 'tool' | 'agent'; label: string; ctx: string; ms: number }

export function isAgentTool(tool: string): boolean {
  return tool === 'Agent' || tool === 'Task'
}

export function toolLabel(tool: ToolRec): string {
  const detail = tool.input.command ?? tool.input.path ?? tool.input.pattern ?? tool.input.subagentType ?? ''
  return detail ? `${tool.tool} ${detail}` : tool.tool
}

function text(value: unknown, n: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, n) : undefined
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

export function summarizeInput(tool: string, input: Record<string, unknown>): ToolInputSummary {
  switch (tool) {
    case 'Bash':
      return defined({ command: text(input.command, 512), description: text(input.description, 120) })
    case 'Read': {
      const paged = input.offset !== undefined || input.limit !== undefined
      return defined({ path: text(input.file_path, 512), range: paged ? `${input.offset ?? ''}:${input.limit ?? ''}` : undefined })
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return defined({ path: text(input.file_path, 512) })
    case 'NotebookEdit':
      return defined({ path: text(input.notebook_path, 512) })
    case 'Glob':
    case 'Grep':
      return defined({ pattern: text(input.pattern, 200), path: text(input.path, 512) })
    case 'Agent':
    case 'Task':
      return defined({ subagentType: text(input.subagent_type, 80), description: text(input.description, 120) })
    default:
      return {}
  }
}

export function toolOutcome(answer: unknown): Outcome {
  const value = (answer ?? {}) as { deny?: unknown; isError?: unknown; result?: unknown }
  const result = (value.result ?? {}) as { agentId?: unknown; status?: unknown }
  return {
    denied: typeof value.deny === 'string',
    isError: value.isError === true,
    launchedAgentId: typeof result.agentId === 'string' ? result.agentId : undefined,
    launchedAsync: result.status === 'async_launched',
  }
}

export class Profiler {
  readonly sessionId: string
  private readonly maxSpans: number
  private readonly turns = new Map<string, TurnRec>()
  private readonly steps = new Map<string, StepRec>()
  private readonly tools = new Map<string, ToolRec>()
  private readonly agents = new Map<string, AgentRec>()
  private readonly openTurns = new Map<string, string[]>()
  private readonly pendingExec = new Map<string, number>()
  private dropped = 0

  constructor(sessionId = 'unknown', maxSpans = 20_000) {
    this.sessionId = sessionId
    this.maxSpans = maxSpans
  }

  turnStart(t: number, turnId: string, prompt = '', ctx = MAIN): void {
    if (this.turns.has(turnId)) return
    this.turns.set(turnId, { id: turnId, ctx, start: t, prompt: prompt.slice(0, 120) })
    this.stack(ctx).push(turnId)
  }

  turnComplete(t: number, turnId: string, reason?: string): void {
    const turn = this.turns.get(turnId)
    if (!turn) return
    if (turn.end === undefined) turn.end = t
    if (reason !== undefined) turn.reason = reason
    this.unstack(turn.ctx, turnId)
  }

  stepStart(t: number, args: { turnId: string; index: number; model: string; effort?: string | number; agentId?: string }): string {
    const ctx = args.agentId ?? MAIN
    const turn = this.turns.get(args.turnId)
    if (!turn) {
      this.turnStart(t, args.turnId, '', ctx)
    } else if (turn.ctx !== ctx) {
      // The engine may raise turn.start for a subagent's loop too; the step tells us whose turn it is.
      this.unstack(turn.ctx, turn.id)
      turn.ctx = ctx
      if (turn.end === undefined) this.stack(ctx).push(turn.id)
    }
    let id = `${args.turnId}#${args.index}`
    for (let n = 1; this.steps.has(id); n += 1) id = `${args.turnId}#${args.index}.${n}`
    const step: StepRec = { id, ctx, turnId: args.turnId, index: args.index, model: args.model, start: t }
    if (args.effort !== undefined) step.effort = String(args.effort)
    this.steps.set(id, step)
    this.trim()
    return id
  }

  stepChunk(t: number, stepId: string, kind: string): void {
    const step = this.steps.get(stepId)
    if (!step || step.end !== undefined || kind === 'engine' || kind === 'stop') return
    if (step.firstContent === undefined) step.firstContent = t
    if (kind === 'thinking') {
      if (step.thinkFirst === undefined) step.thinkFirst = t
      step.thinkLast = t
    } else if (step.outFirst === undefined) {
      step.outFirst = t
    }
  }

  stepUsage(stepId: string, usage: Usage | null | undefined, stopReason?: string | null): void {
    const step = this.steps.get(stepId)
    if (!step) return
    if (usage) step.usage = { ...usage }
    if (stopReason) step.stopReason = stopReason
  }

  stepEnd(t: number, stepId: string): void {
    const step = this.steps.get(stepId)
    if (step && step.end === undefined) step.end = t
  }

  toolStart(t: number, args: { id: string; tool: string; agentId?: string; input: ToolInputSummary }): void {
    if (this.tools.has(args.id)) return
    const ctx = args.agentId ?? MAIN
    const tool: ToolRec = { id: args.id, ctx, tool: args.tool, input: args.input, start: t }
    const turnId = this.currentTurn(ctx)
    if (turnId !== undefined) tool.turnId = turnId
    const exec = this.pendingExec.get(args.id)
    if (exec !== undefined) {
      tool.execMs = exec
      this.pendingExec.delete(args.id)
    }
    this.tools.set(args.id, tool)
    this.trim()
  }

  toolCheck(id: string, decision: string): void {
    const tool = this.tools.get(id)
    if (tool) tool.decision = decision
  }

  toolDuration(id: string, ms: unknown): void {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return
    const tool = this.tools.get(id)
    if (tool) tool.execMs = ms
    else if (this.pendingExec.size < 1_000) this.pendingExec.set(id, ms)
  }

  toolEnd(t: number, id: string, outcome: Outcome): void {
    const tool = this.tools.get(id)
    if (!tool || tool.end !== undefined) return
    tool.end = t
    tool.denied = outcome.denied
    tool.isError = outcome.isError
    if (outcome.launchedAgentId) {
      tool.launchedAgentId = outcome.launchedAgentId
      tool.launchedAsync = outcome.launchedAsync
      const agent = this.agents.get(outcome.launchedAgentId)
      if (agent) agent.parentToolId = id
    }
  }

  subagentStart(t: number, agentId: string, agentType: string): void {
    if (this.agents.has(agentId)) return
    const claimed = new Set([...this.agents.values()].map(agent => agent.parentToolId))
    let parent: ToolRec | undefined
    for (const tool of this.tools.values()) {
      if (!isAgentTool(tool.tool) || claimed.has(tool.id)) continue
      if (tool.launchedAgentId !== undefined && tool.launchedAgentId !== agentId) continue
      if (tool.end !== undefined && t - tool.end > 2_000) continue
      if (!parent || tool.start > parent.start) parent = tool
    }
    const agent: AgentRec = { id: agentId, agentType, start: t }
    if (parent) agent.parentToolId = parent.id
    this.agents.set(agentId, agent)
  }

  subagentStop(t: number, agentId: string): void {
    const agent = this.agents.get(agentId)
    if (!agent) return
    if (agent.end === undefined) agent.end = t
    for (const turnId of [...(this.openTurns.get(agentId) ?? [])]) this.turnComplete(t, turnId, 'agent-stop')
  }

  running(now: number): RunningItem[] {
    const items: RunningItem[] = []
    for (const step of this.steps.values()) {
      if (step.end === undefined) items.push({ kind: 'model', label: `model ${step.model}`, ctx: step.ctx, ms: now - step.start })
    }
    for (const tool of this.tools.values()) {
      if (tool.end === undefined) items.push({ kind: 'tool', label: toolLabel(tool), ctx: tool.ctx, ms: now - tool.start })
    }
    for (const agent of this.agents.values()) {
      if (agent.end === undefined) items.push({ kind: 'agent', label: `agent ${agent.agentType}`, ctx: agent.id, ms: now - agent.start })
    }
    return items.sort((a, b) => b.ms - a.ms)
  }

  snapshot(now: number): Snapshot {
    return {
      sessionId: this.sessionId,
      now,
      turns: [...this.turns.values()].map(turn => ({ ...turn })),
      steps: [...this.steps.values()].map(step => ({ ...step, ...(step.usage ? { usage: { ...step.usage } } : {}) })),
      tools: [...this.tools.values()].map(tool => ({ ...tool, input: { ...tool.input } })),
      agents: [...this.agents.values()].map(agent => ({ ...agent })),
      dropped: this.dropped,
    }
  }

  private currentTurn(ctx: string): string | undefined {
    const open = this.openTurns.get(ctx)
    return open && open.length > 0 ? open[open.length - 1] : undefined
  }

  private stack(ctx: string): string[] {
    let open = this.openTurns.get(ctx)
    if (!open) {
      open = []
      this.openTurns.set(ctx, open)
    }
    return open
  }

  private unstack(ctx: string, turnId: string): void {
    const open = this.openTurns.get(ctx)
    const at = open ? open.indexOf(turnId) : -1
    if (open && at >= 0) open.splice(at, 1)
  }

  private trim(): void {
    if (this.steps.size + this.tools.size <= this.maxSpans) return
    const target = Math.floor(this.maxSpans * 0.9)
    this.evict(this.steps, target)
    this.evict(this.tools, target)
  }

  private evict<T extends { end?: number }>(map: Map<string, T>, target: number): void {
    for (const [id, rec] of map) {
      if (this.steps.size + this.tools.size <= target) return
      if (rec.end === undefined) continue
      map.delete(id)
      this.dropped += 1
    }
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: 이전 테스트 포함 모두 pass.

- [ ] **Step 5: Commit**

```bash
git add agent-profiler/hooks/core/profiler.ts agent-profiler/tests/profiler.test.ts
git commit -m "feat(agent-profiler): event state machine for turns, requests, tools and subagents"
```

---

### Task 3: Bash 명령 분류 (👤 사용자 기여 지점)

**Files:**
- Create: `agent-profiler/hooks/core/classify.ts`
- Test: `agent-profiler/tests/classify.test.ts`

**Interfaces:**
- Produces: `type BashCategory = 'test' | 'build' | 'install' | 'git' | 'search' | 'other'`, `classifyCommand(command: string): BashCategory`

`cd web && npm test`처럼 여러 명령을 이은 경우의 정책은 사용자가 정한다(실행 단계에서 TODO로 남겨 요청).
아래는 참조 구현이다. 세그먼트별로 분류한 뒤 가장 "비싼" 범주를 고르며, 우선순위는 test > build > install > git > search > other.

- [ ] **Step 1: 실패하는 테스트 작성**

`agent-profiler/tests/classify.test.ts`
```ts
import { expect, test } from 'claude-code/testing'

import { classifyCommand } from '../hooks/core/classify.ts'

test('common runners and tools', () => {
  expect(classifyCommand('npm test')).toBe('test')
  expect(classifyCommand('pnpm run test -- --watch=false')).toBe('test')
  expect(classifyCommand('pytest -x tests/')).toBe('test')
  expect(classifyCommand('go test ./...')).toBe('test')
  expect(classifyCommand('cargo test')).toBe('test')
  expect(classifyCommand('npm install')).toBe('install')
  expect(classifyCommand('pip install -r requirements.txt')).toBe('install')
  expect(classifyCommand('npm run build')).toBe('build')
  expect(classifyCommand('tsc -p .')).toBe('build')
  expect(classifyCommand('git status')).toBe('git')
  expect(classifyCommand('gh pr view 12')).toBe('git')
  expect(classifyCommand('rg foo src')).toBe('search')
  expect(classifyCommand('echo hi')).toBe('other')
  expect(classifyCommand('')).toBe('other')
})

test('compound commands take the most expensive segment', () => {
  expect(classifyCommand('cd web && npm test')).toBe('test')
  expect(classifyCommand('cd web && git diff')).toBe('git')
  expect(classifyCommand('npm ci && npm test')).toBe('test')
  expect(classifyCommand('ls | grep foo')).toBe('search')
})
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: FAIL. `classify.ts`를 찾을 수 없다.

- [ ] **Step 3: classify.ts 구현**

`agent-profiler/hooks/core/classify.ts`
```ts
export type BashCategory = 'test' | 'build' | 'install' | 'git' | 'search' | 'other'

const RULES: [BashCategory, RegExp][] = [
  ['test', /\b(jest|vitest|mocha|pytest|tox|nox|rspec|phpunit|ctest|cypress\s+run|playwright\s+test)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(go|cargo|deno|bun|dotnet|mix|swift)\s+test\b|\bnode\s+--test\b|\b(gradlew?|mvn)\b.*\btest\b|\bmake\s+(test|check)\b|\bclaude\s+plugin\s+test\b/],
  ['install', /\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci)\b|\bpip3?\s+install\b|\buv\s+(pip|sync|add)\b|\bpoetry\s+(install|add)\b|\bbrew\s+install\b|\bapt(-get)?\s+install\b|\bcargo\s+(add|install|fetch)\b|\bgo\s+(get|mod\s+download)\b|\bbundle\s+install\b/],
  ['build', /\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|^\s*(tsc|webpack|esbuild|rollup|make|cmake|ninja|bazel)\b|\bvite\s+build\b|\b(cargo|go|swift|dotnet)\s+build\b|\b(gradlew?|mvn)\b|\bdocker\s+build\b/],
  ['git', /^\s*(git|gh)\b/],
  ['search', /^\s*(rg|grep|ag|ack|find|fd|ls|tree|cat|head|tail|wc)\b/],
]

const RANK: BashCategory[] = ['test', 'build', 'install', 'git', 'search', 'other']

function classifySegment(segment: string): BashCategory {
  return RULES.find(([, pattern]) => pattern.test(segment))?.[0] ?? 'other'
}

export function classifyCommand(command: string): BashCategory {
  const segments = command.split(/&&|\|\||;|\|/).map(s => s.trim()).filter(Boolean)
  let best: BashCategory = 'other'
  for (const segment of segments) {
    const category = classifySegment(segment)
    if (RANK.indexOf(category) < RANK.indexOf(best)) best = category
  }
  return best
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: 모두 pass.

- [ ] **Step 5: Commit**

```bash
git add agent-profiler/hooks/core/classify.ts agent-profiler/tests/classify.test.ts
git commit -m "feat(agent-profiler): classify Bash commands into test/build/install/git/search"
```

---

### Task 4: Analyzer

**Files:**
- Create: `agent-profiler/hooks/core/analyze.ts`
- Create: `agent-profiler/tests/fixtures.ts`
- Test: `agent-profiler/tests/analyze.test.ts`

**Interfaces:**
- Consumes: `Profiler`, `MAIN`, `isAgentTool`, `toolLabel` (Task 2), `classifyCommand`/`BashCategory` (Task 3), `fmtMs`/`pct`/`clip` (Task 1)
- Produces:
  - `type Interval = [number, number]`, `type Category = 'model' | 'subagent' | 'tool' | 'engine'`, `type Scope = 'session' | 'turn'`
  - `unionLength(intervals: Interval[]): number`
  - `attribute(window: Interval, tagged: { cat: Category; iv: Interval }[]): Record<Category, number>`
  - `type Summary` (아래 코드 참조)
  - `summarize(s: Snapshot, scope?: Scope): Summary`
  - fixtures: `ok`, `session(): Profiler`, `withSubagent(): Profiler`

- [ ] **Step 1: 공유 fixture 작성**

`agent-profiler/tests/fixtures.ts`
```ts
import { Profiler } from '../hooks/core/profiler.ts'

export const ok = { denied: false, isError: false }

// One 10s turn: 2 model requests (3s), Read, npm test behind an approval prompt (6s), re-reads of /a.ts.
export function session(): Profiler {
  const p = new Profiler('s')
  p.turnStart(0, 't1', 'fix the tests')
  let step = p.stepStart(0, { turnId: 't1', index: 0, model: 'm' })
  p.stepChunk(1000, step, 'text')
  p.stepUsage(step, { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'tool_use')
  p.stepEnd(2000, step)
  p.toolStart(2000, { id: 'r1', tool: 'Read', input: { path: '/a.ts' } })
  p.toolDuration('r1', 10)
  p.toolEnd(2010, 'r1', ok)
  p.toolStart(2010, { id: 'b1', tool: 'Bash', input: { command: 'npm test' } })
  p.toolCheck('b1', 'ask')
  p.toolDuration('b1', 5000)
  p.toolEnd(8010, 'b1', ok)
  step = p.stepStart(8010, { turnId: 't1', index: 1, model: 'm' })
  p.stepChunk(8510, step, 'text')
  p.stepEnd(9010, step)
  p.toolStart(9010, { id: 'r2', tool: 'Read', input: { path: '/a.ts' } })
  p.toolEnd(9020, 'r2', ok)
  p.toolStart(9020, { id: 'r3', tool: 'Read', input: { path: '/a.ts' } })
  p.toolEnd(9030, 'r3', ok)
  p.toolStart(9030, { id: 'e1', tool: 'Edit', input: { path: '/a.ts' } })
  p.toolEnd(9040, 'e1', ok)
  p.toolStart(9040, { id: 'r4', tool: 'Read', input: { path: '/a.ts' } })
  p.toolEnd(9050, 'r4', ok)
  p.turnComplete(10_000, 't1', 'answer')
  return p
}

// One 1s turn whose main loop waits on a blocking Explore subagent (100–910ms).
export function withSubagent(): Profiler {
  const p = new Profiler('s')
  p.turnStart(0, 't1')
  p.toolStart(100, { id: 'ag', tool: 'Agent', input: { subagentType: 'Explore' } })
  p.subagentStart(110, 'a1', 'Explore')
  const step = p.stepStart(120, { turnId: 'st', index: 0, model: 'h', agentId: 'a1' })
  p.stepEnd(620, step)
  p.toolStart(620, { id: 'g', tool: 'Grep', agentId: 'a1', input: { pattern: 'x' } })
  p.toolEnd(820, 'g', ok)
  p.subagentStop(900, 'a1')
  p.toolEnd(910, 'ag', { denied: false, isError: false, launchedAgentId: 'a1', launchedAsync: false })
  p.turnComplete(1000, 't1', 'answer')
  return p
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`agent-profiler/tests/analyze.test.ts`
```ts
import { expect, test } from 'claude-code/testing'

import { attribute, summarize, unionLength } from '../hooks/core/analyze.ts'
import { Profiler } from '../hooks/core/profiler.ts'
import { ok, session, withSubagent } from './fixtures.ts'

test('unionLength merges overlapping and touching intervals', () => {
  expect(unionLength([[0, 10], [5, 15], [20, 30], [30, 31]])).toBe(26)
  expect(unionLength([])).toBe(0)
})

test('attribute: model wins overlaps, gaps are engine, shares sum to the window', () => {
  expect(attribute([0, 100], [{ cat: 'model', iv: [10, 50] }, { cat: 'tool', iv: [40, 80] }])).toEqual({ model: 40, subagent: 0, tool: 30, engine: 30 })
})

test('summarize a session', () => {
  const sum = summarize(session().snapshot(20_000))
  expect(sum.wallMs).toBe(10_000)
  expect(sum.exclusive).toEqual({ model: 3000, subagent: 0, tool: 6050, engine: 950 })
  expect(sum.model.requests).toBe(2)
  expect(sum.model.ttftAvg).toBe(750)
  expect(sum.model.ttftP95).toBe(1000)
  expect(sum.model.outputMs).toBe(1500)
  expect(sum.model.tokensPerSec).toBe(100)
  expect(sum.tools.calls).toBe(6)
  expect(sum.tools.execMs).toBe(5050)
  expect(sum.tools.permissionMs).toBe(1000)
  expect(sum.tools.overheadMs).toBe(0)
  expect(sum.bash.byCategory).toEqual([{ category: 'test', calls: 1, ms: 5000 }])
  expect(sum.bash.testShare).toBe(0.5)
  expect(sum.reads).toEqual([{ path: '/a.ts', reads: 4, redundant: 2 }])
  expect(sum.findings.length).toBe(3)
  expect(sum.incomplete).toBe(0)
})

test('turn scope counts only the last turn; open spans are cut at now', () => {
  const p = session()
  p.turnStart(20_000, 't2')
  p.toolStart(20_100, { id: 'b2', tool: 'Bash', input: { command: 'sleep 100' } })
  const sum = summarize(p.snapshot(21_000), 'turn')
  expect(sum.turns).toBe(1)
  expect(sum.wallMs).toBe(1000)
  expect(sum.exclusive).toEqual({ model: 0, subagent: 0, tool: 900, engine: 100 })
  expect(sum.incomplete).toBe(2)
})

test('paged reads are not redundant', () => {
  const p = new Profiler('s')
  p.turnStart(0, 't')
  p.toolStart(1, { id: 'a', tool: 'Read', input: { path: '/big', range: '0:100' } })
  p.toolEnd(2, 'a', ok)
  p.toolStart(3, { id: 'b', tool: 'Read', input: { path: '/big', range: '100:100' } })
  p.toolEnd(4, 'b', ok)
  p.turnComplete(5, 't')
  expect(summarize(p.snapshot(10)).reads).toEqual([{ path: '/big', reads: 2, redundant: 0 }])
})

test('a blocking subagent counts as subagent time and is broken down', () => {
  const sum = summarize(withSubagent().snapshot(2000))
  expect(sum.exclusive).toEqual({ model: 0, subagent: 810, tool: 0, engine: 190 })
  expect(sum.agents).toEqual([{ id: 'a1', agentType: 'Explore', wallMs: 790, modelMs: 500, toolMs: 200, requests: 1, tools: 1, blocking: true, done: true }])
  expect(sum.tools.calls).toBe(1)
  expect(sum.model.requests).toBe(1)
})

test('turn scope follows subagents launched in that turn', () => {
  const sum = summarize(withSubagent().snapshot(2000), 'turn')
  expect(sum.agents.map(a => a.id)).toEqual(['a1'])
  expect(sum.tools.calls).toBe(1)
})
```

- [ ] **Step 3: 실패 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: FAIL. `analyze.ts`를 찾을 수 없다.

- [ ] **Step 4: analyze.ts 구현**

`agent-profiler/hooks/core/analyze.ts`
```ts
import { classifyCommand, type BashCategory } from './classify.ts'
import { clip, fmtMs, pct } from './format.ts'
import { MAIN, isAgentTool, toolLabel } from './profiler.ts'
import type { Snapshot, ToolRec } from './types.ts'

export type Interval = [number, number]
export type Category = 'model' | 'subagent' | 'tool' | 'engine'
export type Scope = 'session' | 'turn'

export type Summary = {
  scope: Scope
  turns: number
  wallMs: number
  exclusive: Record<Category, number>
  model: {
    requests: number
    ttftAvg: number
    ttftP95: number
    thinkingMs: number
    outputMs: number
    inputTokens: number
    cacheReadTokens: number
    outputTokens: number
    tokensPerSec: number | null
  }
  tools: {
    calls: number
    sumMs: number
    unionMs: number
    execMs: number
    permissionMs: number
    overheadMs: number
    errors: number
    denied: number
    byTool: { tool: string; calls: number; ms: number }[]
    slowest: { tool: string; label: string; ms: number; waitMs: number; ctx: string }[]
  }
  bash: { byCategory: { category: BashCategory; calls: number; ms: number }[]; testMs: number; testShare: number }
  reads: { path: string; reads: number; redundant: number }[]
  agents: { id: string; agentType: string; wallMs: number; modelMs: number; toolMs: number; requests: number; tools: number; blocking: boolean; done: boolean }[]
  findings: string[]
  incomplete: number
  dropped: number
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const PRIORITY: Category[] = ['model', 'subagent', 'tool']

export function unionLength(intervals: Interval[]): number {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  let total = 0
  let start = 0
  let end = -Infinity
  for (const [a, b] of sorted) {
    if (a > end) {
      if (end > start) total += end - start
      start = a
      end = b
    } else if (b > end) {
      end = b
    }
  }
  if (end > start) total += end - start
  return total
}

// Splits a window into elementary segments and gives each to the highest-priority category active in it.
export function attribute(window: Interval, tagged: { cat: Category; iv: Interval }[]): Record<Category, number> {
  const out: Record<Category, number> = { model: 0, subagent: 0, tool: 0, engine: 0 }
  const [w0, w1] = window
  if (w1 <= w0) return out
  const clipped = tagged
    .map(x => ({ cat: x.cat, a: Math.max(w0, x.iv[0]), b: Math.min(w1, x.iv[1]) }))
    .filter(x => x.b > x.a)
  const cuts = [...new Set([w0, w1, ...clipped.flatMap(x => [x.a, x.b])])].sort((a, b) => a - b)
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const a = cuts[i]
    const b = cuts[i + 1]
    const active = new Set(clipped.filter(x => x.a <= a && x.b >= b).map(x => x.cat))
    out[PRIORITY.find(cat => active.has(cat)) ?? 'engine'] += b - a
  }
  return out
}

function scopeAgents(s: Snapshot, mainTools: ToolRec[], scope: Scope): Set<string> {
  if (scope === 'session') return new Set(s.agents.map(a => a.id))
  const toolIds = new Set(mainTools.map(t => t.id))
  const ids = new Set<string>()
  for (let grew = true; grew; ) {
    grew = false
    for (const agent of s.agents) {
      if (ids.has(agent.id) || !agent.parentToolId) continue
      const parent = s.tools.find(t => t.id === agent.parentToolId)
      if (toolIds.has(agent.parentToolId) || (parent && ids.has(parent.ctx))) {
        ids.add(agent.id)
        grew = true
      }
    }
  }
  return ids
}

export function summarize(s: Snapshot, scope: Scope = 'session'): Summary {
  const end = (x: { end?: number }) => x.end ?? s.now
  let mainTurns = s.turns.filter(t => t.ctx === MAIN).sort((a, b) => a.start - b.start)
  if (scope === 'turn') mainTurns = mainTurns.slice(-1)
  const turnIds = new Set(mainTurns.map(t => t.id))
  const inScope = (turnId: string | undefined) => scope === 'session' || (turnId !== undefined && turnIds.has(turnId))
  const mainTools = s.tools.filter(t => t.ctx === MAIN && inScope(t.turnId))
  const agentIds = scopeAgents(s, mainTools, scope)
  const steps = s.steps.filter(x => (x.ctx === MAIN ? inScope(x.turnId) : agentIds.has(x.ctx)))
  const tools = [...mainTools, ...s.tools.filter(x => x.ctx !== MAIN && agentIds.has(x.ctx))]
  const agents = s.agents.filter(a => agentIds.has(a.id))

  const exclusive: Record<Category, number> = { model: 0, subagent: 0, tool: 0, engine: 0 }
  let wallMs = 0
  for (const turn of mainTurns) {
    const window: Interval = [turn.start, end(turn)]
    wallMs += window[1] - window[0]
    const tagged = [
      ...steps.filter(x => x.ctx === MAIN && x.turnId === turn.id).map(x => ({ cat: 'model' as Category, iv: [x.start, end(x)] as Interval })),
      ...mainTools
        .filter(x => x.turnId === turn.id)
        .map(x => ({ cat: (isAgentTool(x.tool) && x.launchedAsync !== true ? 'subagent' : 'tool') as Category, iv: [x.start, end(x)] as Interval })),
    ]
    const part = attribute(window, tagged)
    for (const cat of Object.keys(part) as Category[]) exclusive[cat] += part[cat]
  }

  const ttfts = steps.filter(x => x.firstContent !== undefined).map(x => (x.firstContent as number) - x.start).sort((a, b) => a - b)
  let thinkingMs = 0
  let outputMs = 0
  let inputTokens = 0
  let cacheReadTokens = 0
  let outputTokens = 0
  let streamMs = 0
  for (const x of steps) {
    if (x.thinkFirst !== undefined && x.thinkLast !== undefined) thinkingMs += x.thinkLast - x.thinkFirst
    if (x.outFirst !== undefined) outputMs += end(x) - x.outFirst
    if (x.usage) {
      inputTokens += x.usage.input_tokens + x.usage.cache_read_input_tokens + x.usage.cache_creation_input_tokens
      cacheReadTokens += x.usage.cache_read_input_tokens
      outputTokens += x.usage.output_tokens
      if (x.firstContent !== undefined) streamMs += end(x) - x.firstContent
    }
  }

  const plain = tools.filter(x => !isAgentTool(x.tool))
  const timed = plain.map(x => {
    const wall = end(x) - x.start
    const exec = x.execMs !== undefined ? Math.min(x.execMs, wall) : wall
    return { x, wall, exec, wait: Math.max(0, wall - exec) }
  })
  let execMs = 0
  let permissionMs = 0
  let overheadMs = 0
  let sumMs = 0
  const byTool = new Map<string, { tool: string; calls: number; ms: number }>()
  const byCategory = new Map<BashCategory, { category: BashCategory; calls: number; ms: number }>()
  for (const { x, wall, exec, wait } of timed) {
    sumMs += wall
    execMs += exec
    if (x.decision === 'ask') permissionMs += wait
    else overheadMs += wait
    const row = byTool.get(x.tool) ?? { tool: x.tool, calls: 0, ms: 0 }
    row.calls += 1
    row.ms += wall
    byTool.set(x.tool, row)
    if (x.tool === 'Bash') {
      const category = classifyCommand(x.input.command ?? '')
      const cat = byCategory.get(category) ?? { category, calls: 0, ms: 0 }
      cat.calls += 1
      cat.ms += exec
      byCategory.set(category, cat)
    }
  }
  const testMs = byCategory.get('test')?.ms ?? 0

  const seen = new Map<string, { path: string; reads: number; redundant: number; ranges: Set<string> }>()
  for (const x of [...tools].sort((a, b) => a.start - b.start)) {
    const path = x.input.path
    if (!path) continue
    if (x.tool === 'Read') {
      const row = seen.get(path) ?? { path, reads: 0, redundant: 0, ranges: new Set<string>() }
      const range = x.input.range ?? ''
      if (row.ranges.has(range)) row.redundant += 1
      row.ranges.add(range)
      row.reads += 1
      seen.set(path, row)
    } else if (WRITE_TOOLS.has(x.tool)) {
      seen.get(path)?.ranges.clear()
    }
  }

  const summary: Summary = {
    scope,
    turns: mainTurns.length,
    wallMs,
    exclusive,
    model: {
      requests: steps.length,
      ttftAvg: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0,
      ttftP95: ttfts.length ? ttfts[Math.max(0, Math.ceil(ttfts.length * 0.95) - 1)] : 0,
      thinkingMs,
      outputMs,
      inputTokens,
      cacheReadTokens,
      outputTokens,
      tokensPerSec: streamMs > 0 && outputTokens > 0 ? outputTokens / (streamMs / 1_000) : null,
    },
    tools: {
      calls: plain.length,
      sumMs,
      unionMs: unionLength(plain.map(x => [x.start, end(x)] as Interval)),
      execMs,
      permissionMs,
      overheadMs,
      errors: plain.filter(x => x.isError).length,
      denied: plain.filter(x => x.denied).length,
      byTool: [...byTool.values()].sort((a, b) => b.ms - a.ms),
      slowest: [...timed]
        .sort((a, b) => b.wall - a.wall)
        .slice(0, 5)
        .map(({ x, wall, wait }) => ({ tool: x.tool, label: toolLabel(x), ms: wall, waitMs: wait, ctx: x.ctx })),
    },
    bash: { byCategory: [...byCategory.values()].sort((a, b) => b.ms - a.ms), testMs, testShare: wallMs > 0 ? testMs / wallMs : 0 },
    reads: [...seen.values()]
      .filter(r => r.reads >= 2)
      .sort((a, b) => b.redundant - a.redundant || b.reads - a.reads)
      .slice(0, 10)
      .map(({ path, reads, redundant }) => ({ path, reads, redundant })),
    agents: agents
      .map(agent => {
        const parent = agent.parentToolId ? s.tools.find(t => t.id === agent.parentToolId) : undefined
        const own = (x: { ctx: string }) => x.ctx === agent.id
        return {
          id: agent.id,
          agentType: agent.agentType,
          wallMs: end(agent) - agent.start,
          modelMs: unionLength(s.steps.filter(own).map(x => [x.start, end(x)] as Interval)),
          toolMs: unionLength(s.tools.filter(own).map(x => [x.start, end(x)] as Interval)),
          requests: s.steps.filter(own).length,
          tools: s.tools.filter(own).length,
          blocking: parent !== undefined && parent.launchedAsync !== true,
          done: agent.end !== undefined,
        }
      })
      .sort((a, b) => b.wallMs - a.wallMs),
    findings: [],
    incomplete: [...mainTurns, ...steps, ...tools, ...agents].filter(x => x.end === undefined).length,
    dropped: s.dropped,
  }
  summary.findings = buildFindings(summary)
  return summary
}

function buildFindings(sum: Summary): string[] {
  const wall = sum.wallMs
  const out: string[] = []
  if (wall < 1_000) return out
  if (sum.exclusive.model / wall >= 0.7) {
    out.push(`Waiting for the model is ${pct(sum.exclusive.model, wall)} of agent time (TTFT p95 ${fmtMs(sum.model.ttftP95)}); tools are not the bottleneck.`)
  }
  if (sum.bash.testShare >= 0.25) {
    const runs = sum.bash.byCategory.find(c => c.category === 'test')?.calls ?? 0
    out.push(`Tests took ${pct(sum.bash.testMs, wall)} of agent time (${fmtMs(sum.bash.testMs)} over ${runs} run(s)).`)
  }
  if (sum.tools.permissionMs / wall >= 0.2) {
    out.push(`Waiting for approval took ${pct(sum.tools.permissionMs, wall)} (${fmtMs(sum.tools.permissionMs)}); allow rules for repeated commands would remove it.`)
  }
  for (const r of sum.reads) {
    if (r.redundant >= 2) out.push(`${clip(r.path, 80)} was read ${r.reads}× (${r.redundant}× with no edit in between).`)
  }
  for (const a of sum.agents) {
    if (a.blocking && a.wallMs / wall >= 0.5) out.push(`Subagent ${a.agentType} blocked the main loop for ${pct(a.wallMs, wall)} (${fmtMs(a.wallMs)}).`)
  }
  const top = sum.tools.slowest[0]
  if (top && top.ms / wall >= 0.3) out.push(`One call took ${pct(top.ms, wall)}: ${clip(top.label, 60)} (${fmtMs(top.ms)}).`)
  if (sum.exclusive.engine / wall >= 0.25) {
    out.push(`${pct(sum.exclusive.engine, wall)} of the time is outside model requests and tools (hooks, context building, compaction).`)
  }
  return out
}
```

- [ ] **Step 5: 통과 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: 모두 pass.

- [ ] **Step 6: Commit**

```bash
git add agent-profiler/hooks/core/analyze.ts agent-profiler/tests/fixtures.ts agent-profiler/tests/analyze.test.ts
git commit -m "feat(agent-profiler): exclusive time attribution, tool/model stats, reads, subagents, findings"
```

---

### Task 5: 리포트, 상태줄, Pane 행

**Files:**
- Create: `agent-profiler/hooks/core/report.ts`
- Test: `agent-profiler/tests/report.test.ts`

**Interfaces:**
- Consumes: `Summary`, `Category` (Task 4), `RunningItem` (Task 2), format 헬퍼 (Task 1)
- Produces: `renderReport(sum: Summary): string`, `statusLine(sum: Summary, running: RunningItem[]): string`,
  `type PaneLine = { text: string; bold?: boolean; dim?: boolean }`, `paneLines(sum, running, width: number): PaneLine[]`

- [ ] **Step 1: 실패하는 테스트 작성**

`agent-profiler/tests/report.test.ts`
```ts
import { expect, test } from 'claude-code/testing'

import { summarize } from '../hooks/core/analyze.ts'
import { Profiler } from '../hooks/core/profiler.ts'
import { paneLines, renderReport, statusLine } from '../hooks/core/report.ts'
import { session } from './fixtures.ts'

test('report names categories, the slow call, re-reads and the observability legend', () => {
  const text = renderReport(summarize(session().snapshot(20_000)))
  expect(text).toContain('1 turn(s)')
  expect(text).toContain('Model response wait')
  expect(text).toContain('npm test')
  expect(text).toContain('/a.ts')
  expect(text).toContain('Findings')
  expect(text).toContain("not the model's internal compute time")
})

test('an empty session says so', () => {
  expect(renderReport(summarize(new Profiler('s').snapshot(0)))).toContain('No turns recorded yet.')
})

test('status line shows shares and the longest running call', () => {
  const p = session()
  p.toolStart(20_000, { id: 'x', tool: 'Bash', input: { command: 'pytest' } })
  expect(statusLine(summarize(p.snapshot(23_000)), p.running(23_000))).toBe('⏱ model 30% · tools 61% · ▶ Bash pytest 3.0s')
})

test('pane lines start with the total and stay within the width', () => {
  const lines = paneLines(summarize(session().snapshot(20_000)), [], 40)
  expect(lines[0]).toEqual({ text: '10.0s agent time · 1 turn(s)', bold: true })
  expect(lines.every(line => line.text.length <= 80)).toBe(true)
})
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: FAIL. `report.ts`를 찾을 수 없다.

- [ ] **Step 3: report.ts 구현**

`agent-profiler/hooks/core/report.ts`
```ts
import type { Category, Summary } from './analyze.ts'
import { bar, clip, fmtCount, fmtMs, pct } from './format.ts'
import type { RunningItem } from './profiler.ts'

const ORDER: Category[] = ['model', 'tool', 'subagent', 'engine']
const LABEL: Record<Category, string> = {
  model: 'Model response wait',
  tool: 'Tools',
  subagent: 'Subagents (blocking)',
  engine: 'Engine/other (inferred)',
}
const SHORT: Record<Category, string> = { model: 'model', tool: 'tools', subagent: 'subagents', engine: 'engine/other' }

export type PaneLine = { text: string; bold?: boolean; dim?: boolean }

export function renderReport(sum: Summary): string {
  const wall = sum.wallMs
  const lines = [`Agent Profiler · ${sum.scope === 'turn' ? 'last turn' : 'session'} · ${sum.turns} turn(s) · ${fmtMs(wall)} agent time`]
  if (sum.turns === 0) {
    lines.push('No turns recorded yet.')
    return lines.join('\n')
  }
  lines.push('', 'Where the time went (exclusive; adds up to agent time)')
  for (const cat of ORDER) {
    const ms = sum.exclusive[cat]
    lines.push(`  ${LABEL[cat].padEnd(24)} ${fmtMs(ms).padStart(7)} ${pct(ms, wall).padStart(4)}  ${bar(wall ? ms / wall : 0)}`)
  }

  const m = sum.model
  lines.push(
    '',
    `Model requests [observed] ${m.requests} · TTFT avg ${fmtMs(m.ttftAvg)} / p95 ${fmtMs(m.ttftP95)} · thinking stream ${fmtMs(m.thinkingMs)} · output stream ${fmtMs(m.outputMs)}`,
    `  tokens [reported] in ${fmtCount(m.inputTokens)} (cache read ${fmtCount(m.cacheReadTokens)}) · out ${fmtCount(m.outputTokens)}${m.tokensPerSec === null ? '' : ` · ${Math.round(m.tokensPerSec)} tok/s`}`,
  )

  const t = sum.tools
  const parallel = t.unionMs > 0 ? (t.sumMs / t.unionMs).toFixed(1) : '1.0'
  lines.push(
    '',
    `Tools ${t.calls} call(s) · exec ${fmtMs(t.execMs)} [measured] · approval wait ${fmtMs(t.permissionMs)} · overhead ${fmtMs(t.overheadMs)} [inferred] · parallelism ${parallel}×${t.errors ? ` · ${t.errors} error(s)` : ''}${t.denied ? ` · ${t.denied} denied` : ''}`,
  )
  for (const row of t.slowest) {
    const wait = row.waitMs >= 1_000 ? ` (wait ${fmtMs(row.waitMs)})` : ''
    const where = row.ctx === 'main' ? '' : ` [agent ${row.ctx.slice(0, 8)}]`
    lines.push(`  ${fmtMs(row.ms).padStart(7)}  ${clip(row.label, 70)}${wait}${where}`)
  }

  if (sum.bash.byCategory.length) {
    lines.push('', 'Bash by category [measured]')
    for (const row of sum.bash.byCategory) lines.push(`  ${row.category.padEnd(8)} ${fmtMs(row.ms).padStart(7)}  ${row.calls}×`)
  }
  if (sum.reads.length) {
    lines.push('', 'Files read more than once')
    for (const row of sum.reads) lines.push(`  ${String(row.reads).padStart(3)}×  ${clip(row.path, 70)}${row.redundant ? ` (${row.redundant}× unchanged)` : ''}`)
  }
  if (sum.agents.length) {
    lines.push('', 'Subagents')
    for (const a of sum.agents) {
      lines.push(`  ${fmtMs(a.wallMs).padStart(7)}  ${a.agentType} ${a.blocking ? 'blocking' : 'background'} · model ${fmtMs(a.modelMs)} · tools ${fmtMs(a.toolMs)} · ${a.requests} req / ${a.tools} tool(s)${a.done ? '' : ' · running'}`)
    }
  }
  if (sum.findings.length) {
    lines.push('', 'Findings')
    for (const finding of sum.findings) lines.push(`  • ${finding}`)
  }
  lines.push(
    '',
    'observed = timed by this mod at event boundaries · measured = timed by Claude Code · reported = API usage · inferred = remainder.',
    "Model time is how long the agent waited for the response, not the model's internal compute time.",
  )
  if (sum.incomplete || sum.dropped) lines.push(`${sum.incomplete} span(s) still open${sum.dropped ? ` · ${sum.dropped} old span(s) dropped` : ''}.`)
  return lines.join('\n')
}

export function statusLine(sum: Summary, running: RunningItem[]): string {
  const wall = sum.wallMs
  const parts = [`⏱ model ${pct(sum.exclusive.model, wall)}`, `tools ${pct(sum.exclusive.tool, wall)}`]
  if (sum.exclusive.subagent > 0) parts.push(`agents ${pct(sum.exclusive.subagent, wall)}`)
  const top = running.find(item => item.kind !== 'agent') ?? running[0]
  if (top && top.ms >= 1_000) parts.push(`▶ ${clip(top.label, 40)} ${fmtMs(top.ms)}`)
  return parts.join(' · ')
}

export function paneLines(sum: Summary, running: RunningItem[], width: number): PaneLine[] {
  const w = Math.max(30, width)
  const out: PaneLine[] = [{ text: `${fmtMs(sum.wallMs)} agent time · ${sum.turns} turn(s)`, bold: true }]
  for (const cat of ORDER) {
    const share = sum.wallMs ? sum.exclusive[cat] / sum.wallMs : 0
    out.push({ text: `${SHORT[cat].padEnd(12)} ${bar(share, Math.min(20, w - 20))} ${pct(sum.exclusive[cat], sum.wallMs).padStart(4)}` })
  }
  out.push({ text: '' }, { text: 'Running', bold: true })
  if (running.length === 0) out.push({ text: '  idle', dim: true })
  for (const item of running.slice(0, 5)) out.push({ text: clip(`  ${fmtMs(item.ms).padStart(6)} ${item.label}`, w) })
  out.push({ text: '' }, { text: 'Slowest tools', bold: true })
  for (const row of sum.tools.slowest) out.push({ text: clip(`  ${fmtMs(row.ms).padStart(6)} ${row.label}`, w) })
  if (sum.findings.length) {
    out.push({ text: '' }, { text: 'Findings', bold: true })
    for (const finding of sum.findings.slice(0, 4)) out.push({ text: clip(`• ${finding}`, w * 2) })
  }
  return out
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: 모두 pass.

- [ ] **Step 5: Commit**

```bash
git add agent-profiler/hooks/core/report.ts agent-profiler/tests/report.test.ts
git commit -m "feat(agent-profiler): text report, status line and pane rows"
```

---

### Task 6: OTLP Exporter

**Files:**
- Create: `agent-profiler/hooks/core/otlp.ts`
- Test: `agent-profiler/tests/otlp.test.ts`

**Interfaces:**
- Consumes: `spanId`, `traceIdFromSession` (Task 1), `MAIN`, `isAgentTool` (Task 2), `classifyCommand` (Task 3)
- Produces: `toOtlp(s: Snapshot, version: string): OtlpRequest`, `nanos(ms: number): string`, types `OtlpSpan`, `OtlpRequest`

- [ ] **Step 1: 실패하는 테스트 작성**

`agent-profiler/tests/otlp.test.ts`
```ts
import { expect, test } from 'claude-code/testing'

import { traceIdFromSession } from '../hooks/core/ids.ts'
import { toOtlp } from '../hooks/core/otlp.ts'
import { session, withSubagent } from './fixtures.ts'

function spansOf(p: ReturnType<typeof session>) {
  return toOtlp(p.snapshot(20_000), '0.1.0').resourceSpans[0].scopeSpans[0].spans
}

test('spans form a tree under the session root', () => {
  const spans = spansOf(session())
  const named = (name: string) => spans.filter(s => s.name === name)
  const root = named('claude-code session')[0]
  expect(root.parentSpanId).toBeUndefined()
  expect(root.traceId).toBe(traceIdFromSession('s'))
  const turn = named('turn')[0]
  expect(turn.parentSpanId).toBe(root.spanId)
  expect(named('chat m').length).toBe(2)
  expect(named('chat m').every(s => s.parentSpanId === turn.spanId)).toBe(true)
  expect(named('model.ttft').length).toBe(2)
  const bash = named('execute_tool Bash')[0]
  expect(bash.parentSpanId).toBe(turn.spanId)
  expect(bash.startTimeUnixNano).toBe('2010000000')
  expect(bash.attributes).toContainEqual({ key: 'agent_profiler.bash.category', value: { stringValue: 'test' } })
  expect(bash.attributes).toContainEqual({ key: 'agent_profiler.exec_ms', value: { intValue: '5000' } })
  expect(named('tool.approval_wait')[0].parentSpanId).toBe(bash.spanId)
  expect(named('tool.exec').length).toBe(2)
})

test('exports are deterministic', () => {
  expect(JSON.stringify(spansOf(session()))).toBe(JSON.stringify(spansOf(session())))
})

test('a subagent hangs under its Agent tool, its work under the subagent', () => {
  const spans = spansOf(withSubagent())
  const named = (name: string) => spans.find(s => s.name === name)
  const agentTool = named('execute_tool Agent')
  const agent = named('invoke_agent Explore')
  expect(agent?.parentSpanId).toBe(agentTool?.spanId)
  expect(named('chat h')?.parentSpanId).toBe(agent?.spanId)
  expect(named('execute_tool Grep')?.parentSpanId).toBe(agent?.spanId)
  expect(spans.some(s => s.name === 'turn' && s.parentSpanId === agent?.spanId)).toBe(false)
})
```

- [ ] **Step 2: 실패 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: FAIL. `otlp.ts`를 찾을 수 없다.

- [ ] **Step 3: otlp.ts 구현**

`agent-profiler/hooks/core/otlp.ts`
```ts
import { classifyCommand } from './classify.ts'
import { spanId, traceIdFromSession } from './ids.ts'
import { MAIN, isAgentTool } from './profiler.ts'
import type { Snapshot } from './types.ts'

type AttrValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean }
export type OtlpAttr = { key: string; value: AttrValue }
export type OtlpSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttr[]
  status: { code: number; message?: string }
}
export type OtlpRequest = {
  resourceSpans: { resource: { attributes: OtlpAttr[] }; scopeSpans: { scope: { name: string; version: string }; spans: OtlpSpan[] }[] }[]
}
type Attrs = Record<string, string | number | boolean | undefined>

const INTERNAL = 1
const CLIENT = 3
const STATUS_OK = 1
const STATUS_ERROR = 2

export function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString()
}

function attrs(values: Attrs): OtlpAttr[] {
  const out: OtlpAttr[] = []
  for (const [key, v] of Object.entries(values)) {
    if (v === undefined || v === '') continue
    if (typeof v === 'string') out.push({ key, value: { stringValue: v } })
    else if (typeof v === 'boolean') out.push({ key, value: { boolValue: v } })
    else if (Number.isInteger(v)) out.push({ key, value: { intValue: String(v) } })
    else out.push({ key, value: { doubleValue: v } })
  }
  return out
}

export function toOtlp(s: Snapshot, version: string): OtlpRequest {
  const traceId = traceIdFromSession(s.sessionId)
  const spans: OtlpSpan[] = []
  const end = (x: { end?: number }) => x.end ?? s.now
  const open = (x: { end?: number }) => (x.end === undefined ? true : undefined)
  const add = (kind: string, key: string, name: string, parent: string | undefined, start: number, stop: number, values: Attrs, extra: { spanKind?: number; error?: string } = {}): string => {
    const id = spanId(kind, key)
    spans.push({
      traceId,
      spanId: id,
      ...(parent ? { parentSpanId: parent } : {}),
      name,
      kind: extra.spanKind ?? INTERNAL,
      startTimeUnixNano: nanos(start),
      endTimeUnixNano: nanos(Math.max(start, stop)),
      attributes: attrs(values),
      status: extra.error ? { code: STATUS_ERROR, message: extra.error } : { code: STATUS_OK },
    })
    return id
  }

  const sessionStart = [...s.turns, ...s.steps, ...s.tools, ...s.agents].reduce((min, x) => Math.min(min, x.start), s.now)
  const root = add('session', s.sessionId, 'claude-code session', undefined, sessionStart, s.now, {
    'session.id': s.sessionId,
    'agent_profiler.observability': 'observed',
  })

  const turnSpans = new Map<string, string>()
  for (const t of s.turns) {
    if (t.ctx !== MAIN) continue
    turnSpans.set(t.id, add('turn', t.id, 'turn', root, t.start, end(t), {
      'agent_profiler.category': 'turn',
      'agent_profiler.observability': 'observed',
      'agent_profiler.turn.reason': t.reason,
      'agent_profiler.turn.prompt': t.prompt,
      'agent_profiler.incomplete': open(t),
    }))
  }

  // Span ids are deterministic, so parents can be named before they are emitted.
  const agents = new Set(s.agents.map(a => a.id))
  const tools = new Map(s.tools.map(t => [t.id, t]))
  const parentOf = (ctx: string, turnId?: string): string =>
    ctx === MAIN ? (turnId !== undefined ? turnSpans.get(turnId) : undefined) ?? root : agents.has(ctx) ? spanId('agent', ctx) : root

  for (const a of s.agents) {
    const parentTool = a.parentToolId ? tools.get(a.parentToolId) : undefined
    add('agent', a.id, `invoke_agent ${a.agentType}`, parentTool ? spanId('tool', parentTool.id) : root, a.start, end(a), {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.id': a.id,
      'gen_ai.agent.name': a.agentType,
      'agent_profiler.category': 'subagent',
      'agent_profiler.observability': 'observed',
      'agent_profiler.async': parentTool ? parentTool.launchedAsync === true : undefined,
      'agent_profiler.incomplete': open(a),
    })
  }

  for (const x of s.steps) {
    const ttft = x.firstContent !== undefined ? x.firstContent - x.start : undefined
    const id = add('step', x.id, `chat ${x.model}`, parentOf(x.ctx, x.turnId), x.start, end(x), {
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': x.model,
      'gen_ai.response.model': x.usage?.model,
      'gen_ai.usage.input_tokens': x.usage?.input_tokens,
      'gen_ai.usage.output_tokens': x.usage?.output_tokens,
      'gen_ai.response.finish_reasons': x.stopReason,
      'gen_ai.agent.id': x.ctx === MAIN ? undefined : x.ctx,
      'agent_profiler.usage.cache_read_input_tokens': x.usage?.cache_read_input_tokens,
      'agent_profiler.usage.cache_creation_input_tokens': x.usage?.cache_creation_input_tokens,
      'agent_profiler.effort': x.effort,
      'agent_profiler.ttft_ms': ttft,
      'agent_profiler.category': 'model',
      'agent_profiler.observability': 'observed',
      'agent_profiler.incomplete': open(x),
    }, { spanKind: CLIENT })
    if (x.firstContent !== undefined) {
      add('step.ttft', x.id, 'model.ttft', id, x.start, x.firstContent, {
        'agent_profiler.observability': 'observed',
        'agent_profiler.note': 'network + queueing + prefill, not separable from the client',
      })
    }
    if (x.thinkFirst !== undefined && x.thinkLast !== undefined) {
      add('step.thinking', x.id, 'model.thinking_stream', id, x.thinkFirst, x.thinkLast, { 'agent_profiler.observability': 'observed' })
    }
    if (x.outFirst !== undefined) {
      add('step.output', x.id, 'model.output_stream', id, x.outFirst, end(x), { 'agent_profiler.observability': 'observed' })
    }
  }

  for (const x of s.tools) {
    const wall = end(x) - x.start
    const exec = x.execMs !== undefined ? Math.min(x.execMs, wall) : undefined
    const wait = exec !== undefined ? wall - exec : undefined
    const id = add('tool', x.id, `execute_tool ${x.tool}`, parentOf(x.ctx, x.turnId), x.start, end(x), {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': x.tool,
      'gen_ai.tool.call.id': x.id,
      'gen_ai.agent.id': x.ctx === MAIN ? undefined : x.ctx,
      'agent_profiler.category': isAgentTool(x.tool) ? 'subagent' : 'tool',
      'agent_profiler.observability': 'observed',
      'agent_profiler.exec_ms': exec,
      'agent_profiler.wait_ms': wait,
      'agent_profiler.permission': x.decision,
      'agent_profiler.fs.path': x.input.path,
      'agent_profiler.fs.range': x.input.range,
      'agent_profiler.search.pattern': x.input.pattern,
      'agent_profiler.bash.command': x.input.command,
      'agent_profiler.bash.category': x.tool === 'Bash' ? classifyCommand(x.input.command ?? '') : undefined,
      'agent_profiler.launched_agent': x.launchedAgentId,
      'agent_profiler.incomplete': open(x),
    }, { error: x.denied ? 'denied' : x.isError ? 'tool error' : undefined })
    if (exec !== undefined && wait !== undefined && x.end !== undefined) {
      if (wait > 0) {
        add('tool.wait', x.id, x.decision === 'ask' ? 'tool.approval_wait' : 'tool.overhead', id, x.start, x.start + wait, {
          'agent_profiler.observability': 'inferred',
        })
      }
      add('tool.exec', x.id, 'tool.exec', id, x.start + wait, x.end, { 'agent_profiler.observability': 'measured' })
    }
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ 'service.name': 'claude-code', 'session.id': s.sessionId, 'agent_profiler.version': version }) },
        scopeSpans: [{ scope: { name: 'agent-profiler', version }, spans }],
      },
    ],
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: 모두 pass.

- [ ] **Step 5: Commit**

```bash
git add agent-profiler/hooks/core/otlp.ts agent-profiler/tests/otlp.test.ts
git commit -m "feat(agent-profiler): OTLP/JSON export with deterministic span tree"
```

---

### Task 7: 어댑터 (register.tsx): 이벤트, 명령, Pane, 상태줄, 자동 저장

**Files:**
- Modify: `agent-profiler/hooks/register.tsx` (전체 교체)
- Test: `agent-profiler/tests/adapter.test.ts`

**Interfaces:**
- Consumes: 위 모든 core 모듈
- Produces: 명령 `/profile [turn]`, `/profile-pane`, `/profile-export`. Pane id `agent-profiler`. 파일 `<outputDir>/<sessionId>.otlp.json`

- [ ] **Step 1: 실패하는 통합 테스트 작성**

`agent-profiler/tests/adapter.test.ts`
```ts
import { expect, test } from 'claude-code/testing'

test('/profile reports tool calls the mod observed', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  on('classic.PostToolUse', () => ({}))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.start({ text: 'run the tests', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'toolu_1' })
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: {}, tool_use_id: 'toolu_1', duration_ms: 5 } as never)
  await $.turn.complete({ turnId: 't1', reason: 'answer' } as never)
  const answer = await $.command.run({ command: 'profile', args: '' })
  expect(answer.text).toContain('1 turn(s)')
  expect(answer.text).toContain('Bash npm test')
})

test('tool.call passes the answer through unchanged', async ($, on) => {
  on('tool.call', () => ({ deny: 'nope' }))
  const denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'toolu_2' })
  expect(denied.deny).toBe('nope')
})

test('turn.step chunks reach the caller unchanged', async ($, on) => {
  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'hm' }
    yield { kind: 'text', index: 1, text: 'hi' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: 't9', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
  })
  const kinds: string[] = []
  for await (const chunk of $.turn.step({ turnId: 't9', index: 0, model: 'm', messageCount: 1 })) kinds.push(chunk.kind)
  expect(kinds).toEqual(['thinking', 'text', 'stop'])
})
```

`$.turn.start` / `$.turn.complete`를 테스트 kit에서 호출할 수 없으면(구현 시 확인), 첫 테스트에서 그 두 줄과 `'1 turn(s)'` 단언을 지우고 `'Bash npm test'` 단언만 남긴다. 턴 경계는 Task 2·4 단위 테스트가 이미 검증한다.

- [ ] **Step 2: 실패 확인**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`
Expected: 첫 테스트 FAIL. `/profile` 명령에 답하는 훅이 없다.

- [ ] **Step 3: register.tsx 구현**

`agent-profiler/hooks/register.tsx`
```tsx
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { summarize } from './core/analyze.ts'
import { toOtlp } from './core/otlp.ts'
import { Profiler, summarizeInput, toolOutcome } from './core/profiler.ts'
import { paneLines, renderReport, statusLine } from './core/report.ts'

const VERSION = '0.1.0'
const PANE = 'agent-profiler'

let profiler = new Profiler()
let lastPaint = 0
let anonymous = 0

// Recording must never break the session: every bookkeeping step goes through here.
function safe(fn: () => void): void {
  try {
    fn()
  } catch {
    // dropped on purpose
  }
}

function paint($: EngineInterface, force = false): void {
  const now = Date.now()
  if (!force && now - lastPaint < 500) return
  lastPaint = now
  safe(() => {
    $.ui.status(statusLine(summarize(profiler.snapshot(now)), profiler.running(now)))
    $.ui.invalidate('ui.render')
  })
}

async function persist($: EngineInterface, options: PluginOptions, send: boolean): Promise<string> {
  const body = JSON.stringify(toOtlp(profiler.snapshot(Date.now()), VERSION))
  const home = (await $.env.get('HOME')) ?? '.'
  const dir = (String(options.outputDir ?? '').trim() || '~/.claude/agent-profiler').replace(/^~(?=\/|$)/, home)
  const path = `${dir}/${profiler.sessionId}.otlp.json`
  await $.fs.write(path, body)
  const notes = [`wrote ${path}`]
  const endpoint = String(options.otlpEndpoint ?? '').trim().replace(/\/+$/, '')
  if (send && endpoint) {
    const answer = await $.http.fetch(`${endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    notes.push(answer.ok ? `sent to ${endpoint}` : `${endpoint} answered ${answer.status}`)
  }
  return notes.join(' · ')
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    try {
      profiler = new Profiler(await $.session.id())
    } catch {
      profiler = new Profiler()
    }
    await $.command.register({ name: 'profile', description: "Show where this session's time went (model wait, tools, subagents, tests, re-reads); 'turn' for the last turn" })
    await $.command.register({ name: 'profile-pane', description: 'Open the live Agent Profiler pane' })
    await $.command.register({ name: 'profile-export', description: "Write this session's trace as OTLP JSON and send it to the configured endpoint" })
    $.clock.every(1_000, () => {
      if (profiler.running(Date.now()).length > 0) paint($, true)
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const t = Date.now()
    try {
      const id = await $.session.id()
      if (id !== profiler.sessionId) profiler = new Profiler(id) // a /clear starts a new session id
    } catch {
      // keep the current profiler
    }
    safe(() => profiler.turnStart(t, e.turnId, e.text))
    paint($, true)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    safe(() => profiler.turnComplete(Date.now(), e.turnId, e.reason))
    paint($, true)
    $.clock.after(0, () => {
      persist($, options, true).catch(() => $.ui.status('agent-profiler: could not save the trace'))
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let id = ''
    safe(() => {
      id = profiler.stepStart(Date.now(), { turnId: e.turnId, index: e.index, model: e.model, effort: e.effort, agentId: e.agentId })
    })
    paint($)
    try {
      for await (const chunk of next(e)) {
        safe(() => {
          profiler.stepChunk(Date.now(), id, chunk.kind)
          if (chunk.kind === 'stop') profiler.stepUsage(id, chunk.usage, chunk.stopReason)
        })
        yield chunk
      }
    } finally {
      safe(() => profiler.stepEnd(Date.now(), id))
      paint($)
    }
  })

  on('tool.call', async ($, e, next) => {
    anonymous += 1
    const id = e.tool_use_id ?? `anonymous-${anonymous}`
    const tool = String(e.tool)
    safe(() => profiler.toolStart(Date.now(), { id, tool, agentId: e.agentId, input: summarizeInput(tool, e as unknown as Record<string, unknown>) }))
    paint($)
    try {
      const answer = await next(e)
      safe(() => profiler.toolEnd(Date.now(), id, toolOutcome(answer)))
      return answer
    } catch (error) {
      safe(() => profiler.toolEnd(Date.now(), id, { denied: false, isError: true }))
      throw error
    } finally {
      paint($)
    }
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (id !== undefined) safe(() => profiler.toolCheck(id, verdict.decision))
    return verdict
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    safe(() => profiler.toolDuration(e.tool_use_id, e.duration_ms))
    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    safe(() => profiler.toolDuration(e.tool_use_id, e.duration_ms))
    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    safe(() => profiler.subagentStart(Date.now(), e.agent_id, e.agent_type))
    paint($, true)
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    safe(() => profiler.subagentStop(Date.now(), e.agent_id))
    paint($, true)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await persist($, options, true)
    } catch {
      // nothing left to tell
    }
    return next(e)
  })

  on('command.run', { command: 'profile' }, async ($, e) => {
    const scope = e.args.trim() === 'turn' ? 'turn' : 'session'
    return { text: renderReport(summarize(profiler.snapshot(Date.now()), scope)) }
  })

  on('command.run', { command: 'profile-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agent Profiler' })
    return { text: 'Agent Profiler pane opened (shown in the terminal and the desktop app).' }
  })

  on('command.run', { command: 'profile-export' }, async $ => {
    try {
      return { text: await persist($, options, true) }
    } catch (error) {
      return { text: `export failed: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const now = Date.now()
    const lines = paneLines(summarize(profiler.snapshot(now)), profiler.running(now), e.props.bodyColumns ?? 60)
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text bold={line.bold} dimColor={line.dim}>
            {line.text || ' '}
          </Text>
        ))}
      </Box>
    )
  })
}
```

- [ ] **Step 4: 통과 확인, validate**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test && claude plugin validate .`
Expected: 모두 pass. validate의 `hooks:` 줄에 다음이 보인다.
session.start, turn.start, turn.complete, turn.step, tool.call, tool.check, classic.PostToolUse, classic.PostToolUseFailure,
classic.SubagentStart, classic.SubagentStop, session.end, command.run{…} ×3, ui.render{component=Pane,requestId=agent-profiler}.
`calls:`에는 $.session.id, $.command.register, $.clock.every, $.clock.after, $.ui.status, $.ui.invalidate, $.ui.open, $.ui.resolve, $.env.get, $.fs.write, $.http.fetch가 보인다.
타입 오류가 나면 `.claude-plugin/types/claude-code/index.d.ts`에서 해당 이름을 grep해 맞춘다.

- [ ] **Step 5: Commit**

```bash
git add agent-profiler/hooks/register.tsx agent-profiler/tests/adapter.test.ts
git commit -m "feat(agent-profiler): wire engine events, /profile commands, live pane and auto export"
```

---

### Task 8: 실제 세션 E2E, 문서, Jaeger 예제

**Files:**
- Create: `agent-profiler/README.md`
- Create: `agent-profiler/examples/jaeger/docker-compose.yml`
- Modify: `README.md` (저장소 루트: mod 목록)

- [ ] **Step 1: 이 세션에 hot reload로 연결**

```bash
mkdir -p ~/.claude/dev-mods/<session-id>
ln -s "$PWD/agent-profiler" ~/.claude/dev-mods/<session-id>/agent-profiler
```
"Enable hot reloading for this session?"에 사용자가 `Enable for this session`을 고르면 턴이 끝날 때 로드된다.
그 뒤 `/profile`을 실행해 실제 출력을 확인한다. 아니면 터미널에서 `claude --plugin-dir ./agent-profiler`로 확인한다.

- [ ] **Step 2: 실세션 프로브로 결합 지점 검증**

```bash
claude -p "Read README.md, run 'sleep 1' with Bash, then spawn a general-purpose subagent that lists the files here. Then finish." \
  --plugin-dir ./agent-profiler --model claude-haiku-4-5-20251001 --allowedTools "Read,Bash,Agent" < /dev/null
ls -la ~/.claude/agent-profiler/
```
Expected: `<sessionId>.otlp.json`이 생긴다. 파일을 python으로 열어 확인할 것:
(a) `chat` span이 1개 이상이고 `model.ttft`가 있다.
(b) `execute_tool Bash`에 `exec_ms`가 있다.
(c) `invoke_agent` span의 부모가 `execute_tool Agent`이다.
(d) 서브에이전트의 `chat` span 부모가 `invoke_agent`이다.
(e) turn.start가 서브에이전트에도 불리는지 본다. `turn` span 수와 main 턴 수를 비교한다.
어긋나면 superpowers:systematic-debugging으로 원인을 찾는다.

- [ ] **Step 3: Jaeger 예제 작성**

`agent-profiler/examples/jaeger/docker-compose.yml`
```yaml
services:
  jaeger:
    image: jaegertracing/all-in-one:latest
    environment:
      COLLECTOR_OTLP_ENABLED: "true"
    ports:
      - "16686:16686" # UI
      - "4318:4318"   # OTLP/HTTP
```
Docker가 있으면 `docker compose -f agent-profiler/examples/jaeger/docker-compose.yml up -d`를 띄운다.
그다음 `curl -sS -X POST -H 'content-type: application/json' --data @~/.claude/agent-profiler/<id>.otlp.json http://localhost:4318/v1/traces`로 보내고,
`curl -s 'http://localhost:16686/api/traces/<traceId>'`로 span 수를 확인한다. Docker가 없으면 이 단계를 건너뛰고 그렇다고 보고한다.

- [ ] **Step 4: README 작성**

`agent-profiler/README.md`에 넣을 섹션:
- 무엇을 보여주는가: 시간 범주 표, 관찰 가능성 등급 표(스펙 §2를 그대로 옮긴다).
- 설치: `/plugin install agent-profiler --marketplace YeonwooSung/my-claude-code-mods`. 개발 중에는 `claude --plugin-dir ./agent-profiler`.
- 명령: `/profile`, `/profile turn`, `/profile-pane`, `/profile-export`.
- 설정: `otlpEndpoint`, `outputDir`(`/plugin` 설정 메뉴 또는 settings `pluginConfigs`).
- Jaeger / Tempo 연동: compose 예제, curl로 파일 전송, Tempo는 OTLP/HTTP 4318 엔드포인트를 그대로 쓴다.
- 환경별 동작 표(스펙 §8).
- 한계: 모델 내부 시간은 분해할 수 없다. Bash로 수정한 파일은 반복 읽기 판정에 보이지 않는다. hot reload하면 메모리 상태가 초기화된다. 검증 버전은 Claude Code 2.1.292이다.
- 테스트: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test`.

루트 `README.md`에 mod 목록 한 줄을 추가한다.

- [ ] **Step 5: 최종 검증과 Commit**

Run: `cd agent-profiler && CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test && claude plugin validate . && cd .. && claude plugin validate .`
Expected: 모두 pass. 마켓플레이스 validate도 `✔`.

```bash
git add README.md agent-profiler/README.md agent-profiler/examples
git commit -m "docs(agent-profiler): README, Jaeger example"
```
