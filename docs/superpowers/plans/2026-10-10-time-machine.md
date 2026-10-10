# Agent Time Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod that records every tool call as a step on a branching timeline, snapshots the working tree after mutating steps in a shadow git repository, and lets the user inspect, diff, explain (edit → test failure), restore, branch, compare and re-run steps.

**Architecture:** A pure core (`hooks/core/`: types, store, tools, testparse, timeline, causality, compare, render) holds all logic and is unit-tested. `hooks/git.ts` wraps a shadow git repo behind an injected `Runner`, unit-tested with a fake runner. `hooks/register.tsx` is the adapter: it forwards events to the core, runs git through `$.process.run`, persists the timeline as JSONL chunks, and answers `/tm` commands.

**Tech Stack:** TypeScript mods API (types 2.1.292), `claude-code/testing`, git (host binary), no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-time-machine-design.md` (§11 overrides earlier sections where they conflict).

## Global Constraints

- Mod folder: `time-machine/` at the repo root, beside `agent-profiler/` and `context-inspector/`.
- Every hook relays `next(e)`'s result unchanged; recording, git and file writes never throw out of a hook (try/catch). `tool.call` and `session.end` get `.catch(($, e, next) => next(e))` (replay-safe in this API).
- Snapshots: shadow git at `<storeDir>/<projectKey>/shadow.git` (bare), work tree = session root, per-session index `<storeDir>/<projectKey>/index/<sessionId>`, refs `refs/tm/<sessionId>/<branch>`, identity `time-machine <tm@local>`. Never touch the user's `.git`; ignored files are never snapshotted or restored.
- Baseline is taken when git is first needed (spec §11.1). All Bash is snapshotted unless `skipSearchBash` (spec §11.2). Snapshots go off for root `/` or HOME, a baseline over 5,000 ms, or any git failure; the reason is shown.
- Stored inputs: engine keys `tool`, `tool_use_id`, `agentId` dropped; strings redacted, cut at 4,096 chars with `…(+N chars, #hash)`. Result head: first 2,048 chars, redacted. Changed-file lists keep 200 entries plus a total.
- Restore and branch apply only with `--yes`; the current state is snapshotted first; after applying, a user-role note is appended to the conversation. Restore is a user command only.
- Tests run with the 2.1.292 binary: `CLAUDE292=~/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude`, `"$CLAUDE292" plugin test time-machine` from the repo root. The test runner's `$` has no `process`, so real git is exercised only in the Task 8 E2E run.
- Type check: `npx -y -p typescript@5 tsc -p time-machine --noEmit` (types copied into the gitignored `time-machine/.claude-plugin/types/`). Validate: `"$CLAUDE292" plugin validate time-machine`.
- Imports use explicit `.ts` extensions. Commit trailer exactly: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A Bash command that both fails tests and writes files (e.g. a test run that regenerates snapshots) — it gets a snapshot and a TestRun on the same step (Task 7 adapter flow, Task 4 causality test covers a failing step that also changed files).
2. Restoring to a step that has no snapshot of its own (a Read) — the nearest earlier snapshot along its ancestry is used (Task 3 `snapshotAt` test).
3. A branch created from step n while later steps exist on main — `path('main')` keeps main's steps, `path(b1)` contains main's steps up to n then b1's (Task 3 test).
4. Persisted records written across a chunk roll in one batch — both chunk files get their final bodies (Task 1 ChunkWriter test, Task 7 `persist` writes every touched chunk).
5. git missing or failing — the session continues, `/tm` still renders the timeline with "snapshots off: …" and restore says so (Task 7 adapter tests run exactly this path because the test runner has no `$.process`).

---

### Task 1: Scaffold, types and storage primitives

**Files:**
- Create: `time-machine/.claude-plugin/plugin.json`, `time-machine/hooks/hooks.json`, `time-machine/hooks/register.tsx` (stub), `time-machine/tsconfig.json`
- Modify: `.gitignore` (one entry)
- Create: `time-machine/hooks/core/types.ts`, `time-machine/hooks/core/hash.ts`, `time-machine/hooks/core/store.ts`
- Copy: `agent-profiler/hooks/core/redact.ts` → `time-machine/hooks/core/redact.ts`; `agent-profiler/hooks/core/classify.ts` → `time-machine/hooks/core/classify.ts`; `agent-profiler/tests/classify.test.ts` → `time-machine/tests/classify.test.ts`
- Test: `time-machine/tests/store.test.ts`

**Interfaces:**
- Produces: all types in types.ts (`FileChange`, `SnapshotRef`, `TestFailure`, `TestRun`, `StepKind`, `StepResult`, `Step`, `TurnRec`, `ModelRec`, `BranchRec`, `SessionRec`, `Rec`); `hash32(text, seed?)`, `contentHash(text)`; `CHUNK_BYTES`, `projectKey(root)`, `chunkName(loadId, i)`, `class ChunkWriter(loadId, max?)` with `add(rec): { name, body }`, `parseChunks(files): Rec[]`; `redactSecrets(text)`; `classifyCommand(command): BashCategory`.

- [ ] **Step 1: Scaffold**

`time-machine/.claude-plugin/plugin.json`:

```json
{
  "name": "time-machine",
  "version": "0.1.0",
  "description": "Agent Time Machine: a branching timeline of tool calls with shadow-git snapshots — inspect, diff, explain test failures, restore, branch, compare, re-run",
  "author": { "name": "YeonwooSung" },
  "userConfig": {
    "storeDir": {
      "type": "string",
      "title": "Store directory",
      "description": "Where snapshots and timelines are kept, one folder per project (empty: ~/.claude/time-machine)",
      "default": ""
    },
    "retentionDays": {
      "type": "number",
      "title": "Keep sessions for (days)",
      "description": "Recorded sessions older than this are deleted at session start, at most once a day (0 keeps everything)",
      "default": 14
    },
    "recordModelOutput": {
      "type": "boolean",
      "title": "Record model text",
      "description": "Store the model's response text and the prompt head with each turn (off: lengths and hashes only)",
      "default": false
    },
    "skipSearchBash": {
      "type": "boolean",
      "title": "Skip snapshots after search commands",
      "description": "Do not snapshot after Bash commands classified as search (rg, grep, ls, cat …); off snapshots every Bash, since a redirect can still write",
      "default": false
    }
  }
}
```

`time-machine/hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

`time-machine/hooks/register.tsx` (stub; Task 7 replaces it):

```tsx
import type { Register } from 'claude-code'

export const register: Register = () => {}
```

`time-machine/tsconfig.json`: identical to `context-inspector/tsconfig.json` (copy it).

Append to `.gitignore`:

```
time-machine/.claude-plugin/types/
```

Copy files:

```bash
cp -R agent-profiler/.claude-plugin/types time-machine/.claude-plugin/types
cp context-inspector/tsconfig.json time-machine/tsconfig.json
cp agent-profiler/hooks/core/redact.ts time-machine/hooks/core/redact.ts
cp agent-profiler/hooks/core/classify.ts time-machine/hooks/core/classify.ts
mkdir -p time-machine/tests && cp agent-profiler/tests/classify.test.ts time-machine/tests/classify.test.ts
```

- [ ] **Step 2: Write types.ts and hash.ts**

`time-machine/hooks/core/types.ts`:

```ts
export type FileChange = { status: string; path: string }

export type SnapshotRef = {
  commit: string
  // False when the tree matched the previous snapshot: `commit` is that snapshot.
  changed: boolean
  // The first 200 changed files; `filesTotal` counts all of them.
  files: FileChange[]
  filesTotal: number
  ms: number
  // Another mutating tool was still running when this snapshot was taken.
  concurrent?: boolean
}

export type TestFailure = { name: string; file?: string; line?: number }

export type TestRun = {
  framework: string
  ok: boolean
  passed?: number
  failed?: number
  errors?: number
  skipped?: number
  failures: TestFailure[]
  locations: { file: string; line: number }[]
  // Path-like tokens anywhere in the whole output, for causality.
  paths: string[]
}

export type StepKind = 'baseline' | 'tool' | 'external' | 'restore'

export type StepResult = { isError: boolean; denied: boolean; chars: number; hash: string; head: string }

export type Step = {
  n: number
  id: string
  turn: number
  agentId?: string
  branch: string
  parent: number
  tool: string
  kind: StepKind
  input: Record<string, unknown>
  // The stored input was cut or redacted, so it cannot be replayed from the log alone.
  inputLossy?: boolean
  target?: string
  startedAt: number
  endedAt?: number
  result?: StepResult
  snapshot?: SnapshotRef
  test?: TestRun
  rerunOf?: number
}

export type TurnRec = { n: number; at: number; prompt: { chars: number; hash: string; head?: string } }

export type ModelRec = {
  turn: number
  index: number
  agentId?: string
  model: string
  stopReason: string
  usage: unknown
  text: { chars: number; hash: string; body?: string }
  toolUses: { id: string; tool: string }[]
}

export type BranchRec = { name: string; fromStep: number; at: number }

export type SessionRec = { sessionId: string; root: string; startedAt: number; loadId: string }

export type Rec =
  | ({ type: 'session' } & SessionRec)
  | ({ type: 'turn' } & TurnRec)
  | ({ type: 'step' } & Step)
  | ({ type: 'model' } & ModelRec)
  | ({ type: 'branch' } & BranchRec)
```

`time-machine/hooks/core/hash.ts`:

```ts
// FNV-1a over UTF-16 code units with a murmur3 finalizer; `seed` picks an independent function.
export function hash32(text: string, seed = 0): number {
  let h = (0x811c9dc5 ^ seed) >>> 0
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')

export function contentHash(text: string): string {
  return hex(hash32(text, 0)) + hex(hash32(text, 0x9747b28c))
}
```

- [ ] **Step 3: Write the failing store test**

`time-machine/tests/store.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { contentHash } from '../hooks/core/hash.ts'
import { ChunkWriter, chunkName, parseChunks, projectKey } from '../hooks/core/store.ts'

test('contentHash is 16 hex digits and content-dependent', () => {
  expect(contentHash('a')).toMatch(/^[0-9a-f]{16}$/)
  expect(contentHash('a')).toBe(contentHash('a'))
  expect(contentHash('a')).not.toBe(contentHash('b'))
})

test('projectKey is stable, sanitized and path-specific', () => {
  expect(projectKey('/Users/u/my app')).toMatch(/^my_app-[0-9a-f]{8}$/)
  expect(projectKey('/Users/u/my app/')).toBe(projectKey('/Users/u/my app'))
  expect(projectKey('/a/x')).not.toBe(projectKey('/b/x'))
  expect(projectKey('/')).toMatch(/^root-[0-9a-f]{8}$/)
})

test('chunk names sort in write order', () => {
  expect(chunkName('lz1', 2)).toBe('lz1-0002.jsonl')
})

test('ChunkWriter rewrites the current chunk whole and rolls past the limit', () => {
  const w = new ChunkWriter('abc', 120)
  const r1 = w.add({ type: 'branch', name: 'main', fromStep: 0, at: 1 })
  expect(r1.name).toBe('abc-0001.jsonl')
  const r2 = w.add({ type: 'branch', name: 'b1', fromStep: 2, at: 3 })
  expect(r2.name).toBe('abc-0001.jsonl')
  expect(r2.body.trim().split('\n').length).toBe(2)
  const r3 = w.add({ type: 'branch', name: 'b2', fromStep: 4, at: 5 })
  expect(r3.name).toBe('abc-0002.jsonl')
  expect(r3.body.trim().split('\n').length).toBe(1)
  expect(r3.body.endsWith('\n')).toBe(true)
})

test('parseChunks reads chunks in name order and skips garbage', () => {
  const recs = parseChunks([
    { name: 'b-0001.jsonl', text: '{"type":"branch","name":"x","fromStep":1,"at":2}\n' },
    { name: 'a-0002.jsonl', text: 'not json\n{"type":"turn","n":2,"at":5,"prompt":{"chars":1,"hash":"h"}}\n\n' },
    { name: 'a-0001.jsonl', text: '{"type":"turn","n":1,"at":1,"prompt":{"chars":1,"hash":"h"}}\n{"no":"type"}\n' },
    { name: 'meta.json', text: '{"type":"turn"}' },
  ])
  expect(recs.map(r => r.type)).toEqual(['turn', 'turn', 'branch'])
  expect(recs.map(r => ('n' in r ? r.n : 'name' in r ? r.name : ''))).toEqual([1, 2, 'x'])
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `"$CLAUDE292" plugin test time-machine`
Expected: classify tests PASS; store test FAILS (store.ts missing).

- [ ] **Step 5: Implement store.ts**

`time-machine/hooks/core/store.ts`:

```ts
import { hash32 } from './hash.ts'
import type { Rec } from './types.ts'

// One timeline file stays under this; `$.fs.write` rewrites a file whole, so smaller chunks write less.
export const CHUNK_BYTES = 1024 * 1024

// `<last path segment>-<8 hex of the whole path>`: readable, and distinct for same-named folders.
export function projectKey(root: string): string {
  const trimmed = root.replace(/\/+$/, '') || '/'
  const last = trimmed.split('/').filter(Boolean).at(-1) ?? 'root'
  return `${last.replace(/[^\w.-]/g, '_')}-${hash32(trimmed).toString(16).padStart(8, '0')}`
}

export function chunkName(loadId: string, index: number): string {
  return `${loadId}-${String(index).padStart(4, '0')}.jsonl`
}

const encoder = new TextEncoder()

// One module load's records. The host has no append, so each add returns the current chunk's whole
// body to write; past `max` bytes the next record starts a new chunk.
export class ChunkWriter {
  private lines: string[] = []
  private bytes = 0
  private index = 1

  constructor(
    readonly loadId: string,
    readonly max = CHUNK_BYTES,
  ) {}

  add(rec: Rec): { name: string; body: string } {
    const line = JSON.stringify(rec)
    const size = encoder.encode(line).length + 1
    if (this.lines.length > 0 && this.bytes + size > this.max) {
      this.index += 1
      this.lines = []
      this.bytes = 0
    }
    this.lines.push(line)
    this.bytes += size
    return { name: chunkName(this.loadId, this.index), body: `${this.lines.join('\n')}\n` }
  }
}

// A session's chunks in write order (load id, then chunk number); lines that are not records are skipped.
export function parseChunks(files: readonly { name: string; text: string }[]): Rec[] {
  const out: Rec[] = []
  const chunks = files.filter(f => f.name.endsWith('.jsonl')).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const file of chunks) {
    for (const line of file.text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const rec = JSON.parse(line) as Rec
        if (rec && typeof rec === 'object' && typeof rec.type === 'string') out.push(rec)
      } catch {
        // a torn or foreign line
      }
    }
  }
  return out
}
```

- [ ] **Step 6: Run tests, type check, validate, commit**

Run: `"$CLAUDE292" plugin test time-machine && npx -y -p typescript@5 tsc -p time-machine --noEmit && "$CLAUDE292" plugin validate time-machine`
Expected: all PASS; tsc silent; validate passes.

```bash
git add .gitignore time-machine
git commit -m "feat(time-machine): scaffold, types and timeline storage primitives

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tool classification and test-output parsing

**Files:**
- Create: `time-machine/hooks/core/tools.ts`, `time-machine/hooks/core/testparse.ts`
- Test: `time-machine/tests/tools.test.ts`, `time-machine/tests/testparse.test.ts`

**Interfaces:**
- Consumes: `classifyCommand`, `redactSecrets`, `contentHash`, types.
- Produces: tools.ts — `MUTATING_TOOLS`, `READ_ONLY_TOOLS`, `INPUT_STRING_MAX = 4096`, `RESULT_HEAD_MAX = 2048`, `isMutating(tool, input, skipSearchBash = false)`, `relPath(root, path)`, `targetOf(tool, input, root)`, `summarizeInput(input): { input, lossy }`, `callInput(input)`, `resultText(answer)`, `summarizeResult(answer): StepResult`. testparse.ts — `parseTestOutput(text, isError): TestRun`, `sameFile(a, b)`.

- [ ] **Step 1: Write the failing tests**

`time-machine/tests/tools.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { callInput, isMutating, relPath, resultText, summarizeInput, summarizeResult, targetOf } from '../hooks/core/tools.ts'

test('mutating tools: edits, every Bash by default, unknown and MCP tools', () => {
  expect(isMutating('Edit', {})).toBe(true)
  expect(isMutating('Write', {})).toBe(true)
  expect(isMutating('Read', {})).toBe(false)
  expect(isMutating('Grep', {})).toBe(false)
  expect(isMutating('Bash', { command: 'rg foo' })).toBe(true)
  expect(isMutating('Bash', { command: 'rg foo' }, true)).toBe(false)
  expect(isMutating('Bash', { command: 'npm test' }, true)).toBe(true)
  expect(isMutating('mcp__db__write', {})).toBe(true)
})

test('targets are root-relative paths, redacted commands, patterns', () => {
  expect(relPath('/r', '/r/src/a.py')).toBe('src/a.py')
  expect(relPath('/r/', '/other/a.py')).toBe('/other/a.py')
  expect(targetOf('Edit', { file_path: '/r/auth.py' }, '/r')).toBe('auth.py')
  expect(targetOf('NotebookEdit', { notebook_path: '/r/n.ipynb' }, '/r')).toBe('n.ipynb')
  expect(targetOf('Grep', { pattern: 'JWT' }, '/r')).toBe('JWT')
  const bash = targetOf('Bash', { command: 'curl -H "Authorization: Bearer abc123" https://x' }, '/r')!
  expect(bash).not.toContain('abc123')
  expect(targetOf('TodoWrite', {}, '/r')).toBeUndefined()
})

test('summarizeInput drops engine keys, cuts long strings, flags lossy input', () => {
  const plain = summarizeInput({ tool: 'Edit', tool_use_id: 't', agentId: 'a', file_path: '/r/a.py', old_string: 'x', new_string: 'y' })
  expect(plain).toEqual({ input: { file_path: '/r/a.py', old_string: 'x', new_string: 'y' }, lossy: false })
  const long = summarizeInput({ content: 'z'.repeat(5_000) })
  expect(String(long.input.content).startsWith('z'.repeat(4_096) + '…(+904 chars, #')).toBe(true)
  expect(long.lossy).toBe(true)
  expect(summarizeInput({ command: 'export API_KEY=sekret' }).lossy).toBe(true)
  expect(callInput({ tool: 'Bash', tool_use_id: 't', command: 'ls' })).toEqual({ command: 'ls' })
})

test('results: text, deny, error, redacted head', () => {
  expect(resultText({ text: 'hi' })).toBe('hi')
  expect(resultText({ deny: 'no' })).toBe('no')
  expect(summarizeResult({ deny: 'no' })).toEqual({ isError: true, denied: true, chars: 2, hash: expect.any(String), head: 'no' })
  const r = summarizeResult({ isError: true, text: `TOKEN=abc ${'x'.repeat(3_000)}` })
  expect(r.isError).toBe(true)
  expect(r.head.length).toBeLessThanOrEqual(2_048 + 20)
  expect(r.head).not.toContain('abc')
  expect(r.chars).toBe(3_010)
})
```

`time-machine/tests/testparse.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { parseTestOutput, sameFile } from '../hooks/core/testparse.ts'

const PYTEST = `============================= test session starts ==============================
collected 15 items

tests/test_auth.py F..F                                                  [ 26%]
tests/test_mw.py F                                                       [ 33%]

=================================== FAILURES ===================================
__________________________________ test_login __________________________________

    def test_login():
>       assert login("a", "b")
E       AssertionError

tests/test_auth.py:12: AssertionError
=========================== short test summary info ============================
FAILED tests/test_auth.py::test_login - AssertionError
FAILED tests/test_auth.py::test_logout - KeyError: 'jwt'
FAILED tests/test_mw.py::test_mw
========================= 3 failed, 12 passed in 0.42s =========================`

test('pytest: counts, failures with file and line, locations, paths', () => {
  const t = parseTestOutput(PYTEST, true)
  expect(t.framework).toBe('pytest')
  expect([t.failed, t.passed, t.ok]).toEqual([3, 12, false])
  expect(t.failures[0]).toEqual({ name: 'tests/test_auth.py::test_login', file: 'tests/test_auth.py', line: 12 })
  expect(t.failures.map(f => f.name)).toEqual(['tests/test_auth.py::test_login', 'tests/test_auth.py::test_logout', 'tests/test_mw.py::test_mw'])
  expect(t.locations).toContainEqual({ file: 'tests/test_auth.py', line: 12 })
  expect(t.paths).toContain('tests/test_mw.py')
  const ok = parseTestOutput('12 passed in 0.10s', false)
  expect([ok.framework, ok.passed, ok.ok]).toEqual(['pytest', 12, true])
})

test('jest and vitest', () => {
  const jest = parseTestOutput(
    `FAIL src/auth.test.ts\n  ● auth › logs in\n\n    expect(received).toBe(expected)\n\n      at Object.<anonymous> (src/auth.test.ts:14:20)\n\nTests:       1 failed, 4 passed, 5 total`,
    true,
  )
  expect([jest.framework, jest.failed, jest.passed]).toEqual(['jest', 1, 4])
  expect(jest.failures).toEqual([{ name: 'auth › logs in' }])
  expect(jest.locations).toContainEqual({ file: 'src/auth.test.ts', line: 14 })
  const vitest = parseTestOutput(
    ` FAIL  src/a.test.ts > math > adds\nAssertionError: expected 2 to be 3\n ❯ src/a.test.ts:5:17\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)`,
    true,
  )
  expect([vitest.framework, vitest.failed, vitest.passed]).toEqual(['vitest', 1, 2])
  expect(vitest.failures).toEqual([{ name: 'src/a.test.ts > math > adds', file: 'src/a.test.ts', line: 5 }])
})

test('cargo, go and node:test', () => {
  const cargo = parseTestOutput(
    `running 2 tests\ntest tests::adds ... FAILED\n\nfailures:\n\n---- tests::adds stdout ----\nthread 'tests::adds' panicked at src/lib.rs:10:9:\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s`,
    true,
  )
  expect([cargo.framework, cargo.failed, cargo.passed, cargo.failures[0]?.name]).toEqual(['cargo', 1, 1, 'tests::adds'])
  expect(cargo.locations).toContainEqual({ file: 'src/lib.rs', line: 10 })
  const go = parseTestOutput(`--- FAIL: TestAdd (0.00s)\n    math_test.go:9: got 2, want 3\n--- PASS: TestSub (0.00s)\nFAIL\nFAIL\texample.com/m\t0.002s`, true)
  expect([go.framework, go.failed, go.passed, go.failures[0]?.name]).toEqual(['go', 1, 1, 'TestAdd'])
  expect(go.locations).toContainEqual({ file: 'math_test.go', line: 9 })
  const node = parseTestOutput(
    `not ok 1 - adds\n  ---\n  location: '/tmp/x/a.test.js:1:65'\n  ...\nok 2 - ok\n1..2\n# tests 2\n# pass 1\n# fail 1`,
    true,
  )
  expect([node.framework, node.failed, node.passed, node.failures[0]?.name]).toEqual(['node:test', 1, 1, 'adds'])
  expect(node.locations).toContainEqual({ file: '/tmp/x/a.test.js', line: 1 })
})

test('unknown output falls back to the error flag; vendor paths are ignored', () => {
  expect(parseTestOutput('boom', true)).toEqual({ framework: 'unknown', ok: false, failures: [], locations: [], paths: [] })
  expect(parseTestOutput('all good', false).ok).toBe(true)
  const t = parseTestOutput('at f (node_modules/x/index.js:3:1)\nat g (src/app.js:7:2)', true)
  expect(t.locations).toEqual([{ file: 'src/app.js', line: 7 }])
  expect(t.paths).toEqual(['src/app.js'])
})

test('sameFile matches relative, absolute and ./ spellings by path suffix', () => {
  expect(sameFile('tests/a.py', '/repo/tests/a.py')).toBe(true)
  expect(sameFile('./src/a.ts', 'src/a.ts')).toBe(true)
  expect(sameFile('a.py', 'data.py')).toBe(false)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `"$CLAUDE292" plugin test time-machine`
Expected: tools/testparse tests FAIL (modules missing).

- [ ] **Step 3: Implement tools.ts**

`time-machine/hooks/core/tools.ts`:

```ts
import { classifyCommand } from './classify.ts'
import { contentHash } from './hash.ts'
import { redactSecrets } from './redact.ts'
import type { StepResult } from './types.ts'

export const MUTATING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash'])
export const READ_ONLY_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent', 'ToolSearch', 'Skill',
  'SendMessage', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'BashOutput', 'KillShell',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'NotebookRead',
])
export const INPUT_STRING_MAX = 4096
export const RESULT_HEAD_MAX = 2048
const ENGINE_KEYS = new Set(['tool', 'tool_use_id', 'agentId'])

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

// Unknown and MCP tools count as mutating: a snapshot that finds nothing changed costs one tree hash.
// Every Bash counts unless asked otherwise: a "search" command can still write through a redirect.
export function isMutating(tool: string, input: Record<string, unknown>, skipSearchBash = false): boolean {
  if (tool === 'Bash') return !skipSearchBash || classifyCommand(str(input.command) ?? '') !== 'search'
  if (MUTATING_TOOLS.has(tool)) return true
  return !READ_ONLY_TOOLS.has(tool)
}

export function relPath(root: string, path: string): string {
  const base = root.replace(/\/+$/, '')
  return base !== '' && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path
}

export function targetOf(tool: string, input: Record<string, unknown>, root: string): string | undefined {
  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const path = str(input.file_path)
      return path ? relPath(root, path) : undefined
    }
    case 'NotebookEdit': {
      const path = str(input.notebook_path)
      return path ? relPath(root, path) : undefined
    }
    case 'Bash': {
      const command = str(input.command)
      return command ? redactSecrets(command).replace(/\s+/g, ' ').trim().slice(0, 120) : undefined
    }
    case 'Grep':
    case 'Glob':
      return str(input.pattern)
    case 'WebFetch':
      return str(input.url)
    case 'WebSearch':
      return str(input.query)
    case 'Agent':
    case 'Task':
      return str(input.subagent_type) ?? str(input.description)
    default:
      return undefined
  }
}

// The input as stored: engine keys dropped, secrets masked, long strings cut (the snapshot holds the files).
export function summarizeInput(input: Record<string, unknown>): { input: Record<string, unknown>; lossy: boolean } {
  let lossy = false
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      const masked = redactSecrets(value)
      if (masked !== value) lossy = true
      if (masked.length <= INPUT_STRING_MAX) return masked
      lossy = true
      return `${masked.slice(0, INPUT_STRING_MAX)}…(+${masked.length - INPUT_STRING_MAX} chars, #${contentHash(value)})`
    }
    if (Array.isArray(value)) return depth > 4 ? '[…]' : value.map(v => walk(v, depth + 1))
    if (value && typeof value === 'object') {
      if (depth > 4) return '{…}'
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, depth + 1)]))
    }
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) if (!ENGINE_KEYS.has(key)) out[key] = walk(value, 0)
  return { input: out, lossy }
}

// The input exactly as the tool got it, engine keys aside: what a rerun passes back.
export function callInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !ENGINE_KEYS.has(key)))
}

export function resultText(answer: unknown): string {
  const a = (answer ?? {}) as Record<string, unknown>
  if (typeof a.text === 'string') return a.text
  if (typeof a.deny === 'string') return a.deny
  return ''
}

export function summarizeResult(answer: unknown): StepResult {
  const a = (answer ?? {}) as Record<string, unknown>
  const denied = typeof a.deny === 'string'
  const text = resultText(answer)
  return {
    isError: denied || a.isError === true,
    denied,
    chars: text.length,
    hash: contentHash(text),
    head: redactSecrets(text.slice(0, RESULT_HEAD_MAX)),
  }
}
```

- [ ] **Step 4: Implement testparse.ts**

`time-machine/hooks/core/testparse.ts`:

```ts
import type { TestFailure, TestRun } from './types.ts'

const MAX_FAILURES = 50
const MAX_LOCATIONS = 100
const MAX_PATHS = 200
const EXT = String.raw`(?:py|[cm]?[jt]sx?|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|exs?)`
const FILE = String.raw`(?:\.{0,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.${EXT}`
const PATH_TOKEN = new RegExp(String.raw`${FILE}\b`, 'g')
const LOCATION = new RegExp(String.raw`(${FILE})(?::|", line )(\d+)`, 'g')
const VENDOR = /node_modules|site-packages|dist-packages|\/lib\/python|<frozen|^internal\/|\/rustc\//

type Counts = Pick<TestRun, 'passed' | 'failed' | 'errors' | 'skipped'>
type Found = Counts & { framework: string; failures: TestFailure[] }

function count(text: string, re: RegExp): Counts {
  const c: Counts = {}
  for (const m of text.matchAll(re)) {
    const n = Number(m[1])
    const word = (m[2] ?? '').toLowerCase()
    if (word.startsWith('pass')) c.passed = (c.passed ?? 0) + n
    else if (word.startsWith('fail')) c.failed = (c.failed ?? 0) + n
    else if (word.startsWith('error')) c.errors = (c.errors ?? 0) + n
    else if (word.startsWith('skip') || word.startsWith('ignored')) c.skipped = (c.skipped ?? 0) + n
  }
  return c
}

function parseCargo(text: string): Found | undefined {
  const results = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)]
  if (results.length === 0) return undefined
  return {
    framework: 'cargo',
    passed: results.reduce((s, m) => s + Number(m[1]), 0),
    failed: results.reduce((s, m) => s + Number(m[2]), 0),
    failures: [...text.matchAll(/^---- (\S+) stdout ----$/gm)].map(m => ({ name: m[1]! })),
  }
}

function parsePytest(text: string): Found | undefined {
  const summary = /(?:^|=+ )((?:\d+ (?:failed|passed|skipped|errors?|xfailed|xpassed|deselected|warnings?|rerun)(?:, )?)+) in [\d.]+s/m.exec(text)
  const lines = [...text.matchAll(/^(?:FAILED|ERROR) (\S+?)(?:::(\S+))?(?: - .*)?$/gm)]
  if (!summary && lines.length === 0) return undefined
  return {
    framework: 'pytest',
    ...count(summary?.[1] ?? '', /(\d+) (passed|failed|errors?|skipped)\b/g),
    failures: lines.map(m => ({ name: m[2] ? `${m[1]}::${m[2]}` : m[1]!, file: m[1]! })),
  }
}

function parseJest(text: string): Found | undefined {
  const jest = /^Tests:\s+(.+)$/m.exec(text)
  const vitest = jest ? undefined : /^\s*Tests\s+(.+?)\s*(?:\(\d+\))?\s*$/m.exec(text)
  const line = jest?.[1] ?? vitest?.[1]
  if (line === undefined) return undefined
  const failures: TestFailure[] = []
  for (const m of text.matchAll(/^\s*● (.+?)\s*$/gm)) if (!/^Console\b/.test(m[1]!)) failures.push({ name: m[1]! })
  for (const m of text.matchAll(/^\s*(?:FAIL|×|✗)\s+(\S+\.[cm]?[jt]sx?)\s+>\s+(.+?)\s*$/gm)) failures.push({ name: `${m[1]} > ${m[2]}`, file: m[1]! })
  return { framework: jest ? 'jest' : 'vitest', ...count(line, /(\d+) (passed|failed|skipped)\b/g), failures }
}

function parseGo(text: string): Found | undefined {
  const fails = [...text.matchAll(/^\s*--- FAIL: (\S+)/gm)]
  const passes = [...text.matchAll(/^\s*--- PASS: /gm)]
  if (fails.length === 0 && passes.length === 0 && !/^(?:ok|FAIL)\s+\S+\s+[\d.]+s/m.test(text)) return undefined
  return {
    framework: 'go',
    failed: fails.length,
    ...(passes.length > 0 ? { passed: passes.length } : {}),
    failures: fails.map(m => ({ name: m[1]! })),
  }
}

function parseNodeTest(text: string): Found | undefined {
  const pass = /^# pass (\d+)$/m.exec(text)
  const fail = /^# fail (\d+)$/m.exec(text)
  if (!pass && !fail) return undefined
  return {
    framework: 'node:test',
    ...(pass ? { passed: Number(pass[1]) } : {}),
    ...(fail ? { failed: Number(fail[1]) } : {}),
    failures: [...text.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => ({ name: m[1]!.trim() })),
  }
}

export function sameFile(a: string, b: string): boolean {
  const x = a.replace(/^\.\//, '')
  const y = b.replace(/^\.\//, '')
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

function locationsOf(text: string): { file: string; line: number }[] {
  const out: { file: string; line: number }[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(LOCATION)) {
    const file = m[1]!
    const key = `${file}:${m[2]}`
    if (VENDOR.test(file) || seen.has(key)) continue
    seen.add(key)
    out.push({ file, line: Number(m[2]) })
    if (out.length >= MAX_LOCATIONS) break
  }
  return out
}

function pathsOf(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(PATH_TOKEN)) {
    if (VENDOR.test(m[0])) continue
    out.add(m[0])
    if (out.size >= MAX_PATHS) break
  }
  return [...out]
}

// What a test command's output says: framework, counts, failing tests and where they point.
export function parseTestOutput(text: string, isError: boolean): TestRun {
  const found = parseCargo(text) ?? parsePytest(text) ?? parseJest(text) ?? parseGo(text) ?? parseNodeTest(text)
  const locations = locationsOf(text)
  const failures = (found?.failures ?? []).slice(0, MAX_FAILURES).map(f => ({ ...f }))
  for (const loc of locations) {
    const failure = failures.find(f => f.file !== undefined && f.line === undefined && sameFile(f.file, loc.file))
    if (failure) failure.line = loc.line
  }
  const run: TestRun = {
    framework: found?.framework ?? 'unknown',
    ok: !isError && (found?.failed ?? 0) === 0 && (found?.errors ?? 0) === 0,
    failures,
    locations,
    paths: pathsOf(text),
  }
  if (found?.passed !== undefined) run.passed = found.passed
  if (found?.failed !== undefined) run.failed = found.failed
  if (found?.errors !== undefined) run.errors = found.errors
  if (found?.skipped !== undefined) run.skipped = found.skipped
  return run
}
```

Note the key order of `run` (framework, ok, failures, locations, paths, then counts): the unknown-output test compares with `toEqual`, which ignores key order, so either order passes.

- [ ] **Step 5: Run tests and type check**

Run: `"$CLAUDE292" plugin test time-machine && npx -y -p typescript@5 tsc -p time-machine --noEmit`
Expected: all PASS; tsc silent. If one parser assertion fails on a sample, fix the regex (not the sample) and say which in the report.

- [ ] **Step 6: Commit**

```bash
git add time-machine
git commit -m "feat(time-machine): tool classification, input/result summaries, test-output parsers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Timeline recorder

**Files:**
- Create: `time-machine/hooks/core/timeline.ts`
- Test: `time-machine/tests/timeline.test.ts`

**Interfaces:**
- Consumes: types, `contentHash`.
- Produces: `type BeginArgs`; `class Recorder(session: SessionRec)` with `version`, `branch`, `turn`, `session`, `turns`, `models`, `branches: Map<string, BranchRec>`, `size`, `drain(): Rec[]`, `get(n)`, `all()`, `baseline(at, snapshot?)`, `startTurn(at, text, keepHead?)`, `begin(args): Step`, `finish(step, at, extra?)`, `addModel(rec)`, `head(branch): number`, `fork(name, fromStep, at): BranchRec`, `nextBranchName()`, `path(branch?): Step[]`, `snapshotAt(n): Step | undefined`, `lastSnapshot(branch?)`, `static fromRecords(recs): Recorder | undefined`.

- [ ] **Step 1: Write the failing test**

`time-machine/tests/timeline.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { Recorder } from '../hooks/core/timeline.ts'
import type { SnapshotRef } from '../hooks/core/types.ts'

const session = { sessionId: 's1', root: '/r', startedAt: 1, loadId: 'L' }
const snap = (commit: string, path = 'a.py'): SnapshotRef => ({ commit, changed: true, files: [{ status: 'M', path }], filesTotal: 1, ms: 5 })

function sample(): Recorder {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c0', changed: true, files: [], filesTotal: 3, ms: 9 })
  r.startTurn(2, 'fix auth')
  for (const [tool, target, s] of [
    ['Read', 'auth.py', undefined],
    ['Grep', 'JWT', undefined],
    ['Edit', 'auth.py', snap('c3', 'auth.py')],
    ['Bash', 'pytest', undefined],
  ] as const) {
    const step = r.begin({ id: `t-${tool}`, tool, target, at: 3 })
    r.finish(step, 4, s ? { snapshot: s } : {})
  }
  return r
}

test('steps are numbered from 1 after the baseline, each parented to the one before', () => {
  const r = sample()
  expect(r.all().map(s => [s.n, s.parent, s.tool])).toEqual([
    [0, 0, 'baseline'],
    [1, 0, 'Read'],
    [2, 1, 'Grep'],
    [3, 2, 'Edit'],
    [4, 3, 'Bash'],
  ])
  expect(r.get(3)!.turn).toBe(1)
  expect(r.path().map(s => s.n)).toEqual([0, 1, 2, 3, 4])
})

test('drain hands each record out once, steps only when finished', () => {
  const r = new Recorder(session)
  expect(r.drain().map(x => x.type)).toEqual(['session'])
  const step = r.begin({ id: 'x', tool: 'Read', at: 1 })
  expect(r.drain()).toEqual([])
  r.finish(step, 2, { result: { isError: false, denied: false, chars: 1, hash: 'h', head: 'x' } })
  const out = r.drain()
  expect(out.length).toBe(1)
  expect(out[0]).toMatchObject({ type: 'step', n: 1, endedAt: 2 })
  expect(r.drain()).toEqual([])
})

test('snapshotAt walks back along the ancestry to the nearest snapshot', () => {
  const r = sample()
  expect(r.snapshotAt(4)!.n).toBe(3)
  expect(r.snapshotAt(2)!.n).toBe(0)
  expect(r.lastSnapshot()!.snapshot!.commit).toBe('c3')
  expect(r.snapshotAt(99)).toBeUndefined()
})

test('a fork grows from a step; each branch path keeps its own history', () => {
  const r = sample()
  expect(r.nextBranchName()).toBe('b1')
  r.fork('b1', 2, 5)
  const s = r.begin({ id: 'x', tool: 'Edit', target: 'mw.py', at: 6 })
  r.finish(s, 7, { snapshot: snap('c5', 'mw.py') })
  expect([s.n, s.parent, s.branch]).toEqual([5, 2, 'b1'])
  expect(r.path('b1').map(x => x.n)).toEqual([0, 1, 2, 5])
  expect(r.path('main').map(x => x.n)).toEqual([0, 1, 2, 3, 4])
  expect(r.head('main')).toBe(4)
  expect(() => r.fork('b1', 1, 8)).toThrow()
  expect(() => r.fork('b9', 42, 8)).toThrow()
  expect(r.nextBranchName()).toBe('b2')
})

test('turns count up; the prompt head is kept only when asked', () => {
  const r = new Recorder(session)
  expect(r.startTurn(1, 'hello').prompt).toEqual({ chars: 5, hash: expect.any(String) })
  expect(r.startTurn(2, 'x'.repeat(300), true).prompt.head).toBe('x'.repeat(200))
  expect(r.turn).toBe(2)
})

test('fromRecords rebuilds steps, branches, the current branch, turns and numbering', () => {
  const r = sample()
  r.fork('b1', 2, 5)
  r.finish(r.begin({ id: 'y', tool: 'Write', target: 'n.py', at: 6 }), 7, { snapshot: snap('c5', 'n.py') })
  r.addModel({ turn: 1, index: 0, model: 'm', stopReason: 'end_turn', usage: null, text: { chars: 1, hash: 'h' }, toolUses: [] })
  const back = Recorder.fromRecords(r.drain())!
  expect(back.all().map(s => [s.n, s.branch])).toEqual(r.all().map(s => [s.n, s.branch]))
  expect(back.branch).toBe('b1')
  expect(back.turn).toBe(1)
  expect(back.models.length).toBe(1)
  expect(back.drain()).toEqual([])
  expect(back.begin({ id: 'z', tool: 'Read', at: 9 }).n).toBe(6)
  expect(Recorder.fromRecords([])).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `"$CLAUDE292" plugin test time-machine`
Expected: timeline test FAILS (module missing).

- [ ] **Step 3: Implement timeline.ts**

`time-machine/hooks/core/timeline.ts`:

```ts
import { contentHash } from './hash.ts'
import type { BranchRec, ModelRec, Rec, SessionRec, SnapshotRef, Step, StepKind, StepResult, TestRun, TurnRec } from './types.ts'

export type BeginArgs = {
  id: string
  tool: string
  kind?: StepKind
  agentId?: string
  input?: Record<string, unknown>
  inputLossy?: boolean
  target?: string
  at: number
  rerunOf?: number
}

// The session's steps as a tree: each step points at its parent, each branch at the step it grew from.
export class Recorder {
  version = 0
  branch = 'main'
  turn = 0
  readonly turns: TurnRec[] = []
  readonly models: ModelRec[] = []
  readonly branches = new Map<string, BranchRec>([['main', { name: 'main', fromStep: 0, at: 0 }]])
  private steps = new Map<number, Step>()
  private order: number[] = []
  private nextN = 1
  private out: Rec[] = []

  constructor(readonly session: SessionRec) {
    this.out.push({ type: 'session', ...session })
  }

  // Records not yet written out, oldest first; each is handed out once.
  drain(): Rec[] {
    const out = this.out
    this.out = []
    return out
  }

  get size(): number {
    return this.order.length
  }

  get(n: number): Step | undefined {
    return this.steps.get(n)
  }

  all(): Step[] {
    return this.order.map(n => this.steps.get(n)!)
  }

  baseline(at: number, snapshot?: SnapshotRef): Step {
    const step: Step = { n: 0, id: 'baseline', turn: this.turn, branch: 'main', parent: 0, tool: 'baseline', kind: 'baseline', input: {}, startedAt: at, endedAt: at }
    if (snapshot) step.snapshot = snapshot
    this.put(step)
    this.emit(step)
    return step
  }

  startTurn(at: number, text: string, keepHead = false): TurnRec {
    this.turn += 1
    const rec: TurnRec = { n: this.turn, at, prompt: { chars: text.length, hash: contentHash(text) } }
    if (keepHead) rec.prompt.head = text.slice(0, 200)
    this.turns.push(rec)
    this.out.push({ type: 'turn', ...rec })
    this.version += 1
    return rec
  }

  begin(a: BeginArgs): Step {
    const step: Step = {
      n: this.nextN,
      id: a.id,
      turn: this.turn,
      branch: this.branch,
      parent: this.head(this.branch),
      tool: a.tool,
      kind: a.kind ?? 'tool',
      input: a.input ?? {},
      startedAt: a.at,
    }
    this.nextN += 1
    if (a.agentId !== undefined) step.agentId = a.agentId
    if (a.inputLossy) step.inputLossy = true
    if (a.target !== undefined) step.target = a.target
    if (a.rerunOf !== undefined) step.rerunOf = a.rerunOf
    this.put(step)
    return step
  }

  // The step is complete: written out once, with whatever it gathered.
  finish(step: Step, at: number, extra: { result?: StepResult; snapshot?: SnapshotRef; test?: TestRun } = {}): void {
    step.endedAt = at
    if (extra.result) step.result = extra.result
    if (extra.snapshot) step.snapshot = extra.snapshot
    if (extra.test) step.test = extra.test
    this.emit(step)
  }

  addModel(rec: ModelRec): void {
    this.models.push(rec)
    this.out.push({ type: 'model', ...rec })
    this.version += 1
  }

  // The newest step on `branch`, else the step the branch grew from.
  head(branch: string): number {
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const step = this.steps.get(this.order[i]!)!
      if (step.branch === branch && step.kind !== 'baseline') return step.n
    }
    return this.branches.get(branch)?.fromStep ?? 0
  }

  fork(name: string, fromStep: number, at: number): BranchRec {
    if (this.branches.has(name)) throw new Error(`branch '${name}' already exists`)
    if (!this.steps.has(fromStep)) throw new Error(`no step ${fromStep}`)
    const rec: BranchRec = { name, fromStep, at }
    this.branches.set(name, rec)
    this.branch = name
    this.out.push({ type: 'branch', ...rec })
    this.version += 1
    return rec
  }

  nextBranchName(): string {
    let k = 1
    while (this.branches.has(`b${k}`)) k += 1
    return `b${k}`
  }

  // From the start to the head of `branch` along parents: a branch includes the history it grew from.
  path(branch = this.branch): Step[] {
    const out: Step[] = []
    const seen = new Set<number>()
    let n: number | undefined = this.head(branch)
    while (n !== undefined && !seen.has(n)) {
      seen.add(n)
      const step = this.steps.get(n)
      if (!step) break
      out.push(step)
      n = step.kind === 'baseline' || step.n === step.parent ? undefined : step.parent
    }
    return out.reverse()
  }

  // The nearest step at or before `n`, along its own ancestry, that holds a snapshot.
  snapshotAt(n: number): Step | undefined {
    const seen = new Set<number>()
    let step = this.steps.get(n)
    while (step && !seen.has(step.n)) {
      seen.add(step.n)
      if (step.snapshot) return step
      if (step.kind === 'baseline') return undefined
      step = this.steps.get(step.parent)
    }
    return undefined
  }

  lastSnapshot(branch = this.branch): Step | undefined {
    return this.snapshotAt(this.head(branch))
  }

  // A recorder rebuilt from its own records (a reload); later records of a step replace earlier ones.
  static fromRecords(recs: readonly Rec[]): Recorder | undefined {
    const first = recs.find(r => r.type === 'session')
    if (!first || first.type !== 'session') return undefined
    const { type: _type, ...session } = first
    const r = new Recorder(session)
    r.out = []
    for (const rec of recs) {
      if (rec.type === 'step') {
        const { type: _t, ...step } = rec
        r.put(step)
        r.nextN = Math.max(r.nextN, step.n + 1)
      } else if (rec.type === 'turn') {
        const { type: _t, ...turn } = rec
        r.turns.push(turn)
        r.turn = Math.max(r.turn, turn.n)
      } else if (rec.type === 'model') {
        const { type: _t, ...model } = rec
        r.models.push(model)
      } else if (rec.type === 'branch') {
        const { type: _t, ...branch } = rec
        r.branches.set(branch.name, branch)
        r.branch = branch.name
      }
    }
    r.order.sort((a, b) => a - b)
    return r
  }

  private put(step: Step): void {
    if (!this.steps.has(step.n)) this.order.push(step.n)
    this.steps.set(step.n, step)
    this.version += 1
  }

  private emit(step: Step): void {
    this.out.push({ type: 'step', ...step })
    this.version += 1
  }
}
```

Note: `fromRecords` uses `branch` records to restore the current branch, but a restore without branching keeps the current branch, which no record marks; the last `branch` record is the current branch because only `fork` changes it.

- [ ] **Step 4: Run tests, type check, commit**

Run: `"$CLAUDE292" plugin test time-machine && npx -y -p typescript@5 tsc -p time-machine --noEmit`
Expected: all PASS; tsc silent. (If tsc flags the unused `_type`/`_t` bindings, keep them: `noUnusedLocals` is not set; if your tsc config does flag them, destructure differently without changing behavior.)

```bash
git add time-machine
git commit -m "feat(time-machine): branching timeline recorder with record round-trip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Causality and comparison

**Files:**
- Create: `time-machine/hooks/core/causality.ts`, `time-machine/hooks/core/compare.ts`
- Test: `time-machine/tests/analysis.test.ts`

**Interfaces:**
- Consumes: types, `sameFile`, `Recorder` (tests), `contentHash`, `redactSecrets`, `RESULT_HEAD_MAX`.
- Produces: causality.ts — `type Suspect = { path; score; reasons: string[]; steps: number[] }`, `type Why = { run: Step; base?: Step; suspects: Suspect[]; fixedBy?: { run: Step; files: string[]; steps: number[] }; improved?: { run: Step; from: number; to: number } }`, `changesBetween(path, fromIdx, toIdx): Map<string, number[]>`, `why(path, runN?): Why | undefined`. compare.ts — `keyOf(step)`, `lcsPairs(a, b)`, `type Compared`, `compare(pathA, pathB): Compared`, `type OutputComparison`, `compareOutputs(was, nowText, wasTest?, nowTest?)`.

- [ ] **Step 1: Write the failing test**

`time-machine/tests/analysis.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { changesBetween, why } from '../hooks/core/causality.ts'
import { compare, compareOutputs, keyOf, lcsPairs } from '../hooks/core/compare.ts'
import { contentHash } from '../hooks/core/hash.ts'
import { Recorder } from '../hooks/core/timeline.ts'
import type { SnapshotRef, TestRun } from '../hooks/core/types.ts'

const session = { sessionId: 's1', root: '/r', startedAt: 1, loadId: 'L' }
const snap = (commit: string, ...paths: string[]): SnapshotRef => ({ commit, changed: true, files: paths.map(path => ({ status: 'M', path })), filesTotal: paths.length, ms: 5 })
const failing = (failed: number, paths: string[], locations: { file: string; line: number }[] = []): TestRun => ({ framework: 'pytest', ok: false, failed, passed: 12, failures: [{ name: 'tests/test_auth.py::test_login', file: 'tests/test_auth.py' }], locations, paths })
const passing: TestRun = { framework: 'pytest', ok: true, passed: 15, failures: [], locations: [], paths: [] }

// The spec's example: ① Read ② Grep ③ Edit auth.py ④ pytest ✗ ⑤ Edit middleware.py ⑥ pytest ✓
function session184(): Recorder {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c0', changed: true, files: [], filesTotal: 9, ms: 9 })
  const add = (tool: string, target: string, extra: { snapshot?: SnapshotRef; test?: TestRun } = {}): void => {
    r.finish(r.begin({ id: `${tool}-${target}`, tool, target, at: 2 }), 3, extra)
  }
  add('Read', 'auth.py')
  add('Grep', 'JWT')
  add('Edit', 'auth.py', { snapshot: snap('c3', 'auth.py') })
  add('Edit', 'utils.py', { snapshot: snap('c4', 'utils.py') })
  add('Bash', 'pytest', { test: failing(3, ['tests/test_auth.py', 'auth.py'], [{ file: 'auth.py', line: 12 }]) })
  add('Edit', 'middleware.py', { snapshot: snap('c6', 'middleware.py') })
  add('Bash', 'pytest', { test: passing })
  return r
}

test('changesBetween collects files changed after one index up to another, with their steps', () => {
  const path = session184().path()
  expect([...changesBetween(path, 0, 5).entries()]).toEqual([
    ['auth.py', [3]],
    ['utils.py', [4]],
  ])
})

test('why: suspects ranked by mention in the failure output, then recency; fixed-by names the edit in between', () => {
  const w = why(session184().path())!
  expect(w.run.n).toBe(5)
  expect(w.base!.n).toBe(0)
  expect(w.suspects.map(s => s.path)).toEqual(['auth.py', 'utils.py'])
  expect(w.suspects[0]!.reasons).toContain('named in the failure output')
  expect(w.suspects[0]!.reasons).toContain('a failure location points into it')
  expect(w.suspects[0]!.steps).toEqual([3])
  expect(w.suspects[0]!.score).toBeGreaterThan(w.suspects[1]!.score)
  expect(w.fixedBy).toEqual({ run: expect.objectContaining({ n: 7 }), files: ['middleware.py'], steps: [6] })
})

test('why: the base is the last passing run before; improved when failures drop; undefined without runs', () => {
  const r = new Recorder(session)
  r.baseline(1)
  const add = (tool: string, target: string, extra: { snapshot?: SnapshotRef; test?: TestRun } = {}): void => {
    r.finish(r.begin({ id: `${tool}-${target}-${r.size}`, tool, target, at: 2 }), 3, extra)
  }
  add('Edit', 'a.py', { snapshot: snap('c1', 'a.py') })
  add('Bash', 'pytest', { test: passing })
  add('Edit', 'b.py', { snapshot: snap('c3', 'b.py') })
  add('Bash', 'pytest', { test: failing(3, []) })
  add('Edit', 'b.py', { snapshot: snap('c5', 'b.py') })
  add('Bash', 'pytest', { test: failing(1, []) })
  const w = why(r.path(), 4)!
  expect(w.base!.n).toBe(2)
  expect(w.suspects.map(s => s.path)).toEqual(['b.py'])
  expect(w.improved).toEqual({ run: expect.objectContaining({ n: 6 }), from: 3, to: 1 })
  expect(w.fixedBy).toBeUndefined()
  expect(why(new Recorder(session).path())).toBeUndefined()
})

test('lcsPairs and compare: shared prefix, divergence, steps only on each side, last tests', () => {
  expect(lcsPairs(['a', 'b', 'c', 'd'], ['a', 'c', 'd', 'e'])).toEqual([
    [0, 0],
    [2, 1],
    [3, 2],
  ])
  const r = session184()
  r.fork('b1', 3, 9)
  r.finish(r.begin({ id: 'x', tool: 'Edit', target: 'middleware.py', at: 10 }), 11, { snapshot: snap('c9', 'middleware.py') })
  r.finish(r.begin({ id: 'y', tool: 'Bash', target: 'pytest', at: 12 }), 13, { test: passing })
  const c = compare(r.path('main'), r.path('b1'))
  expect(c.common).toBe(3)
  expect(keyOf(c.divergeA!)).toBe('Edit utils.py')
  expect(keyOf(c.divergeB!)).toBe('Edit middleware.py')
  expect(c.onlyA.map(keyOf)).toEqual(['Edit utils.py', 'Bash pytest'])
  expect(c.onlyB.map(keyOf)).toEqual([])
  expect(c.lastTestA!.n).toBe(7)
  expect(c.lastTestB!.test!.ok).toBe(true)
})

test('compareOutputs: identical by hash, else line differences on the first 2 KiB', () => {
  const was = { isError: false, denied: false, chars: 7, hash: contentHash('a\nb\nc'), head: 'a\nb\nc' }
  expect(compareOutputs(was, 'a\nb\nc').identical).toBe(true)
  const c = compareOutputs(was, 'a\nB\nc\nd', undefined, passing)
  expect([c.identical, c.addedCount, c.removedCount]).toEqual([false, 2, 1])
  expect(c.added).toEqual(['B', 'd'])
  expect(c.removed).toEqual(['b'])
  expect(c.now).toBe(passing)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `"$CLAUDE292" plugin test time-machine`
Expected: analysis test FAILS (modules missing).

- [ ] **Step 3: Implement causality.ts**

`time-machine/hooks/core/causality.ts`:

```ts
import { sameFile } from './testparse.ts'
import type { Step, TestRun } from './types.ts'

export type Suspect = { path: string; score: number; reasons: string[]; steps: number[] }
export type Why = {
  run: Step
  base?: Step
  suspects: Suspect[]
  fixedBy?: { run: Step; files: string[]; steps: number[] }
  improved?: { run: Step; from: number; to: number }
}

const MAX_SUSPECTS = 5
const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path
const isRun = (step: Step): step is Step & { test: TestRun } => step.test !== undefined

// Files that snapshots after path[fromIdx] up to path[toIdx] changed, each with the steps that changed it.
export function changesBetween(path: readonly Step[], fromIdx: number, toIdx: number): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (let i = Math.max(0, fromIdx + 1); i <= toIdx && i < path.length; i += 1) {
    const step = path[i]!
    if (!step.snapshot?.changed || step.kind === 'baseline') continue
    for (const file of step.snapshot.files) {
      const steps = out.get(file.path) ?? []
      steps.push(step.n)
      out.set(file.path, steps)
    }
  }
  return out
}

// Inferred, not proof: a file the failure output names outranks one it does not; recent and repeated
// changes rank higher among equals.
function rank(path: readonly Step[], changes: Map<string, number[]>, test: TestRun, baseIdx: number, runIdx: number): Suspect[] {
  const position = new Map(path.map((step, i) => [step.n, i]))
  const span = Math.max(1, runIdx - baseIdx)
  const suspects: Suspect[] = []
  for (const [file, steps] of changes) {
    const reasons: string[] = []
    let score = 0
    if (test.failures.some(f => f.file !== undefined && sameFile(f.file, file)) || test.paths.some(p => sameFile(p, file))) {
      score += 100
      reasons.push('named in the failure output')
    } else if (test.paths.some(p => basename(p) === basename(file))) {
      score += 60
      reasons.push('its file name appears in the failure output')
    }
    if (test.locations.some(l => sameFile(l.file, file))) {
      score += 50
      reasons.push('a failure location points into it')
    }
    const last = steps[steps.length - 1]!
    score += Math.round((20 * ((position.get(last) ?? baseIdx) - baseIdx)) / span)
    reasons.push(`last changed at step ${last}`)
    score += Math.min(10, 2 * steps.length)
    if (steps.length > 1) reasons.push(`changed ${steps.length} times`)
    suspects.push({ path: file, score, reasons, steps })
  }
  return suspects.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1)).slice(0, MAX_SUSPECTS)
}

// For the test run `runN` (default: the last failing one on the path): what changed since the last
// passing run, ranked; which later edits made it pass; whether a later run failed less.
export function why(path: readonly Step[], runN?: number): Why | undefined {
  const runs = path.flatMap((step, i) => (isRun(step) ? [{ step, i }] : []))
  const target = runN === undefined ? [...runs].reverse().find(r => !r.step.test.ok) : runs.find(r => r.step.n === runN)
  if (!target) return undefined
  const { step: run, i: runIdx } = target
  const okBefore = [...runs].reverse().find(r => r.i < runIdx && r.step.test.ok)
  const baseIdx = okBefore ? okBefore.i : path[0]?.kind === 'baseline' ? 0 : -1
  const out: Why = { run, suspects: [] }
  const base = baseIdx >= 0 ? path[baseIdx] : undefined
  if (base) out.base = base
  if (!run.test.ok) out.suspects = rank(path, changesBetween(path, baseIdx, runIdx), run.test, baseIdx, runIdx)
  const later = runs.filter(r => r.i > runIdx)
  const fixed = later.find(r => r.step.test.ok)
  if (!run.test.ok && fixed) {
    const changes = changesBetween(path, runIdx, fixed.i)
    out.fixedBy = { run: fixed.step, files: [...changes.keys()], steps: [...new Set([...changes.values()].flat())].sort((a, b) => a - b) }
  }
  const before = run.test.failed
  const fewer = before === undefined ? undefined : later.find(r => r.step.test.failed !== undefined && r.step.test.failed < before && !r.step.test.ok)
  if (fewer && before !== undefined) out.improved = { run: fewer.step, from: before, to: fewer.step.test.failed! }
  return out
}
```

- [ ] **Step 4: Implement compare.ts**

`time-machine/hooks/core/compare.ts`:

```ts
import { contentHash } from './hash.ts'
import { redactSecrets } from './redact.ts'
import { RESULT_HEAD_MAX } from './tools.ts'
import type { Step, StepResult, TestRun } from './types.ts'

const MAX_STEPS = 500
const SAMPLES = 3

export const keyOf = (step: Step): string => (step.target ? `${step.tool} ${step.target}` : step.tool)

// Index pairs of a longest common subsequence.
export function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i += 1
    else j += 1
  }
  return pairs
}

export type Compared = {
  // Leading steps with the same tool and target on both paths.
  common: number
  // Steps matched (same key) after the shared start.
  matched: number
  divergeA?: Step
  divergeB?: Step
  onlyA: Step[]
  onlyB: Step[]
  lastTestA?: Step
  lastTestB?: Step
}

export function compare(pathA: readonly Step[], pathB: readonly Step[]): Compared {
  const a = pathA.filter(s => s.kind !== 'baseline').slice(-MAX_STEPS)
  const b = pathB.filter(s => s.kind !== 'baseline').slice(-MAX_STEPS)
  const ka = a.map(keyOf)
  const kb = b.map(keyOf)
  let common = 0
  while (common < ka.length && common < kb.length && ka[common] === kb[common]) common += 1
  const pairs = lcsPairs(ka.slice(common), kb.slice(common))
  const inA = new Set(pairs.map(p => p[0] + common))
  const inB = new Set(pairs.map(p => p[1] + common))
  const out: Compared = {
    common,
    matched: pairs.length,
    onlyA: a.filter((_, i) => i >= common && !inA.has(i)),
    onlyB: b.filter((_, i) => i >= common && !inB.has(i)),
  }
  if (a[common]) out.divergeA = a[common]
  if (b[common]) out.divergeB = b[common]
  const lastA = [...a].reverse().find(s => s.test)
  const lastB = [...b].reverse().find(s => s.test)
  if (lastA) out.lastTestA = lastA
  if (lastB) out.lastTestB = lastB
  return out
}

export type OutputComparison = {
  identical: boolean
  addedCount: number
  removedCount: number
  added: string[]
  removed: string[]
  was?: TestRun
  now?: TestRun
}

// Same hash: identical. Otherwise a line multiset difference over the first 2 KiB of each (redacted alike).
export function compareOutputs(was: StepResult | undefined, nowText: string, wasTest?: TestRun, nowTest?: TestRun): OutputComparison {
  const identical = was !== undefined && was.hash === contentHash(nowText)
  const before = new Map<string, number>()
  for (const line of (was?.head ?? '').split('\n')) before.set(line, (before.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of redactSecrets(nowText.slice(0, RESULT_HEAD_MAX)).split('\n')) {
    const left = before.get(line) ?? 0
    if (left > 0) before.set(line, left - 1)
    else added.push(line)
  }
  const removed = [...before.entries()].flatMap(([line, k]) => Array.from({ length: k }, () => line))
  const out: OutputComparison = {
    identical,
    addedCount: identical ? 0 : added.length,
    removedCount: identical ? 0 : removed.length,
    added: identical ? [] : added.slice(0, SAMPLES),
    removed: identical ? [] : removed.slice(0, SAMPLES),
  }
  if (wasTest) out.was = wasTest
  if (nowTest) out.now = nowTest
  return out
}
```

- [ ] **Step 5: Run tests, type check, commit**

Run: `"$CLAUDE292" plugin test time-machine && npx -y -p typescript@5 tsc -p time-machine --noEmit`
Expected: all PASS; tsc silent.

```bash
git add time-machine
git commit -m "feat(time-machine): edit-to-failure causality and path/output comparison

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Rendering

**Files:**
- Create: `time-machine/hooks/core/render.ts`
- Test: `time-machine/tests/render.test.ts`

**Interfaces:**
- Consumes: `Recorder`, `Why`, `Compared`, `OutputComparison`, `keyOf`, types.
- Produces: `circled(n)`, `testSummary(t)`, `filesSummary(files, total, n?)`, `label(step)`, `notes(step)`, `avg(xs)`, `type TimelineOptions`, `renderTimeline(rec, o?)`, `renderStep(step)`, `renderWhy(w, labels?)`, `renderCompare(nameA, nameB, c, stat?)`, `renderRerun(step, cmp, where)`, `renderRestorePlan(step, target, files, applied, branch?)`, `renderSessions(rows)`, `statusLine(rec, snapMs, off?)`.

- [ ] **Step 1: Write the failing test**

`time-machine/tests/render.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { why } from '../hooks/core/causality.ts'
import { compare, compareOutputs } from '../hooks/core/compare.ts'
import { circled, renderCompare, renderRerun, renderRestorePlan, renderSessions, renderStep, renderTimeline, renderWhy, statusLine, testSummary } from '../hooks/core/render.ts'
import { Recorder } from '../hooks/core/timeline.ts'
import type { SnapshotRef, TestRun } from '../hooks/core/types.ts'

const session = { sessionId: '8201ea2b-079a', root: '/r', startedAt: 1, loadId: 'L' }
const snap = (commit: string, ...paths: string[]): SnapshotRef => ({ commit, changed: true, files: paths.map(path => ({ status: 'M', path })), filesTotal: paths.length, ms: 41 })
const failed: TestRun = { framework: 'pytest', ok: false, failed: 3, passed: 12, failures: [{ name: 'tests/test_auth.py::test_login', file: 'tests/test_auth.py', line: 12 }], locations: [{ file: 'auth.py', line: 12 }], paths: ['auth.py'] }
const passed: TestRun = { framework: 'pytest', ok: true, passed: 12, failures: [], locations: [], paths: [] }

function example(): Recorder {
  const r = new Recorder(session)
  r.baseline(1, { commit: 'c000000000', changed: true, files: [], filesTotal: 9, ms: 30 })
  const add = (tool: string, target: string, extra: { snapshot?: SnapshotRef; test?: TestRun } = {}): void => {
    r.finish(r.begin({ id: `${tool}${r.size}`, tool, target, input: { file_path: `/r/${target}` }, at: 10 }), 52, extra)
  }
  add('Read', 'auth.py')
  add('Grep', 'JWT')
  add('Edit', 'auth.py', { snapshot: snap('3a4f1c2aaaa', 'auth.py') })
  add('Bash', 'pytest', { test: failed })
  add('Edit', 'middleware.py', { snapshot: snap('9bd0e11bbbb', 'middleware.py') })
  add('Bash', 'pytest', { test: passed })
  return r
}

test('circled numbers and test summaries', () => {
  expect([circled(0), circled(1), circled(20), circled(21)]).toEqual(['⓪', '①', '⑳', '(21)'])
  expect(testSummary(failed)).toBe('✗ 3 failed, 12 passed')
  expect(testSummary({ framework: 'unknown', ok: true, failures: [], locations: [], paths: [] })).toBe('✓ passed')
})

test('the timeline draws the session as a tree with snapshots and test results under their steps', () => {
  const text = renderTimeline(example(), { snapMs: [41, 41] })
  const lines = text.split('\n')
  expect(lines[0]).toBe('Session 8201ea2b · branch main · 6 step(s) · 2 snapshot(s), avg 41ms')
  expect(text).toContain('├── ① Read auth.py')
  expect(text).toContain('├── ③ Edit auth.py\n│       └── snapshot 3a4f1c2 · M auth.py')
  expect(text).toContain('├── ④ Bash pytest\n│       └── ✗ 3 failed, 12 passed')
  expect(lines.at(-2)).toBe('└── ⑥ Bash pytest')
  expect(lines.at(-1)).toBe('        └── ✓ 12 passed')
})

test('branches are marked where they start; snapshots-off and empty sessions say so', () => {
  const r = example()
  r.fork('b1', 4, 60)
  r.finish(r.begin({ id: 'z', tool: 'Edit', target: 'auth.py', at: 61 }), 62, { snapshot: snap('aaaaaaa1', 'auth.py') })
  expect(renderTimeline(r)).toContain('│  ⑂ branch b1 (from ④)\n└── ⑦ Edit auth.py')
  const off = renderTimeline(new Recorder(session), { off: 'git unavailable' })
  expect(off).toContain('snapshots off: git unavailable')
  expect(off).toContain('No tool calls recorded yet.')
})

test('step detail shows input, result head, snapshot files and failures', () => {
  const r = example()
  const text = renderStep(r.get(4)!)
  expect(text.split('\n')[0]).toBe('④ Bash pytest')
  expect(text).toContain('input:\n  file_path: /r/pytest')
  expect(text).toContain('test (pytest): ✗ 3 failed, 12 passed')
  expect(text).toContain('  ✗ tests/test_auth.py::test_login (tests/test_auth.py:12)')
  expect(renderStep(r.get(3)!)).toContain('snapshot: 3a4f1c2aaaa · 41ms\n  M auth.py')
})

test('why, compare, rerun, restore plan, sessions and the status line', () => {
  const r = example()
  const w = renderWhy(why(r.path())!, n => (r.get(n) ? `${circled(n)} ${r.get(n)!.tool} ${r.get(n)!.target}` : undefined))
  expect(w).toContain('Why did ④ Bash pytest fail? ✗ 3 failed, 12 passed (pytest)')
  expect(w).toContain('1. auth.py')
  expect(w).toContain('Fixed by: ⑤ Edit middleware.py → ⑥ Bash pytest ✓ 12 passed')
  expect(w).toContain('inferred')
  r.fork('b1', 3, 60)
  r.finish(r.begin({ id: 'z', tool: 'Edit', target: 'utils.py', at: 61 }), 62, { snapshot: snap('aaaaaaa1', 'utils.py') })
  const c = renderCompare('main', 'b1', compare(r.path('main'), r.path('b1')), ' auth.py | 2 +-')
  expect(c).toContain('Shared start: 3 step(s)')
  expect(c).toContain('Diverged at: main ④ Bash pytest · b1 ⑦ Edit utils.py')
  expect(c).toContain(' auth.py | 2 +-')
  const was = r.get(4)!
  const rerun = renderRerun(was, compareOutputs(was.result, 'x', was.test, passed), 'here, against the current files')
  expect(rerun).toContain('Rerun of ④ Bash pytest (here, against the current files)')
  expect(rerun).toContain('Test: ✗ 3 failed, 12 passed → ✓ 12 passed')
  const plan = renderRestorePlan(r.get(3)!, r.get(3)!, [{ status: 'M', path: 'auth.py' }, { status: 'D', path: 'new.txt' }], false)
  expect(plan).toContain('2 file(s) would change')
  expect(plan).toContain('  D new.txt')
  expect(plan).toContain('/tm restore 3 --yes')
  expect(renderRestorePlan(r.get(3)!, r.get(3)!, [], true, 'b2')).toContain("branch 'b2'")
  expect(renderSessions([{ id: 'abc', startedAt: 0, current: true }])).toContain('abc (this session)')
  expect(statusLine(r, [40, 42])).toBe('tm ⑦ · 3 snaps · 41ms')
  expect(statusLine(r, [], 'git unavailable')).toBe('tm ⑦ · snapshots off')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `"$CLAUDE292" plugin test time-machine`
Expected: render test FAILS (module missing).

- [ ] **Step 3: Implement render.ts**

`time-machine/hooks/core/render.ts`:

```ts
import type { Why } from './causality.ts'
import { keyOf, type Compared, type OutputComparison } from './compare.ts'
import type { Recorder } from './timeline.ts'
import type { FileChange, Step, TestRun } from './types.ts'

const clip = (text: string, n: number): string => {
  const line = text.replace(/[\r\n\t]+/g, ' ')
  return line.length <= n ? line : `${line.slice(0, Math.max(0, n - 1))}…`
}

export function circled(n: number): string {
  if (n === 0) return '⓪'
  if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1)
  return `(${n})`
}

export function testSummary(t: TestRun): string {
  const parts: string[] = []
  if (t.failed) parts.push(`${t.failed} failed`)
  if (t.errors) parts.push(`${t.errors} error(s)`)
  if (t.passed !== undefined) parts.push(`${t.passed} passed`)
  if (parts.length === 0) parts.push(t.ok ? 'passed' : 'failed')
  return `${t.ok ? '✓' : '✗'} ${parts.join(', ')}`
}

export function filesSummary(files: readonly FileChange[], total: number, n = 3): string {
  const head = files.slice(0, n).map(f => `${f.status} ${f.path}`).join(', ')
  return total > n ? `${head} +${total - n}` : head
}

export function label(step: Step): string {
  if (step.kind === 'baseline') return 'baseline'
  if (step.kind === 'external') return 'external change'
  if (step.kind === 'restore') return `restore → ${circled(Number(step.input.to))}`
  return keyOf(step)
}

// The sub-lines under a step: test outcome or error, the snapshot it took, a rerun marker.
export function notes(step: Step): string[] {
  const out: string[] = []
  if (step.test) out.push(testSummary(step.test))
  else if (step.result?.denied) out.push('⊘ denied')
  else if (step.result?.isError) out.push('✗ error')
  if (step.kind === 'baseline') out.push(step.snapshot ? `snapshot ${step.snapshot.commit.slice(0, 7)} · ${step.snapshot.filesTotal} file(s)` : 'no snapshot')
  else if (step.snapshot?.changed)
    out.push(`snapshot ${step.snapshot.commit.slice(0, 7)} · ${filesSummary(step.snapshot.files, step.snapshot.filesTotal)}${step.snapshot.concurrent ? ' (concurrent)' : ''}`)
  if (step.rerunOf !== undefined) out.push(`rerun of ${circled(step.rerunOf)}`)
  return out
}

export function avg(xs: readonly number[]): number | undefined {
  return xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined
}

export type TimelineOptions = { all?: boolean; branch?: string; limit?: number; off?: string; snapMs?: readonly number[] }

export function renderTimeline(rec: Recorder, o: TimelineOptions = {}): string {
  const branch = o.branch ?? rec.branch
  const steps = o.all ? rec.all() : rec.path(branch)
  const shown = o.all ? steps : steps.slice(-(o.limit ?? 30))
  const count = rec.all().filter(s => s.kind !== 'baseline').length
  const snaps = rec.all().filter(s => s.kind !== 'baseline' && s.snapshot?.changed).length
  const mean = avg(o.snapMs ?? [])
  const lines = [`Session ${rec.session.sessionId.slice(0, 8)} · branch ${branch} · ${count} step(s) · ${snaps} snapshot(s)${mean !== undefined ? `, avg ${mean}ms` : ''}`]
  if (o.off) lines.push(`snapshots off: ${o.off}`)
  if (shown.every(s => s.kind === 'baseline')) return [...lines, '', 'No tool calls recorded yet.'].join('\n')
  if (steps.length > shown.length) lines.push(`(${steps.length - shown.length} earlier step(s) hidden; /tm timeline --all)`)
  lines.push('│')
  let prevBranch = shown[0]!.branch
  shown.forEach((step, i) => {
    const last = i === shown.length - 1
    if (!o.all && step.branch !== prevBranch) lines.push(`│  ⑂ branch ${step.branch} (from ${circled(step.parent)})`)
    prevBranch = step.branch
    const tag = o.all && step.branch !== 'main' ? ` [${step.branch}]` : ''
    const agent = step.agentId ? ` (agent ${step.agentId.slice(0, 6)})` : ''
    lines.push(`${last ? '└──' : '├──'} ${circled(step.n)} ${clip(label(step), 60)}${agent}${tag}`)
    for (const note of notes(step)) lines.push(`${last ? ' ' : '│'}       └── ${note}`)
  })
  return lines.join('\n')
}

export function renderStep(step: Step): string {
  const took = step.endedAt !== undefined ? ` · took ${step.endedAt - step.startedAt}ms` : ''
  const lines = [
    `${circled(step.n)} ${label(step)}`,
    `kind ${step.kind} · branch ${step.branch} · parent ${circled(step.parent)} · turn ${step.turn}${step.agentId ? ` · agent ${step.agentId}` : ''}${took}`,
  ]
  const keys = Object.keys(step.input)
  if (keys.length > 0) {
    lines.push('input:')
    for (const key of keys) {
      const value = step.input[key]
      lines.push(`  ${key}: ${clip(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 300)}`)
    }
    if (step.inputLossy) lines.push('  (stored input was cut or redacted)')
  }
  if (step.result) {
    lines.push(`result: ${step.result.denied ? 'denied' : step.result.isError ? 'error' : 'ok'} · ${step.result.chars} chars`)
    for (const line of step.result.head.split('\n').slice(0, 40)) lines.push(`  │ ${line}`)
    if (step.result.chars > step.result.head.length) lines.push('  │ …')
  }
  if (step.snapshot) {
    const s = step.snapshot
    lines.push(`snapshot: ${s.commit.slice(0, 12)}${s.changed ? '' : ' (no change)'} · ${s.ms}ms${s.concurrent ? ' · concurrent' : ''}`)
    for (const f of s.files) lines.push(`  ${f.status} ${f.path}`)
    if (s.filesTotal > s.files.length && step.kind !== 'baseline') lines.push(`  … +${s.filesTotal - s.files.length} more`)
  }
  if (step.test) {
    lines.push(`test (${step.test.framework}): ${testSummary(step.test)}`)
    for (const f of step.test.failures.slice(0, 10)) lines.push(`  ✗ ${f.name}${f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ''})` : ''}`)
  }
  return lines.join('\n')
}

// `labels(n)` names a step for the fixed-by line (`⑤ Edit middleware.py`); without it, the bare number.
export function renderWhy(w: Why, labels?: (n: number) => string | undefined): string {
  const t = w.run.test!
  const lines = [`Why did ${circled(w.run.n)} ${label(w.run)} ${t.ok ? 'pass' : 'fail'}? ${testSummary(t)} (${t.framework})`]
  lines.push(`Compared with: ${w.base ? `${circled(w.base.n)} ${label(w.base)}${w.base.test ? ' (last passing run)' : ' (no passing run before it)'}` : 'the start of the session'}`)
  if (!t.ok) {
    if (w.suspects.length === 0) lines.push('Suspects: no file changed in between (look at the environment, test order, or external services)')
    else {
      lines.push('Suspects (files changed since then, ranked):')
      w.suspects.forEach((s, i) => {
        lines.push(`  ${i + 1}. ${s.path}  score ${s.score} — ${s.reasons.join('; ')}`)
        lines.push(`     changed by ${s.steps.map(circled).join(' ')}`)
      })
    }
    if (t.failures.length > 0) lines.push(`Failures: ${t.failures.slice(0, 5).map(f => `${f.name}${f.line !== undefined ? ` (${f.file}:${f.line})` : ''}`).join(', ')}`)
  }
  if (w.fixedBy) lines.push(`Fixed by: ${w.fixedBy.steps.map(n => labels?.(n) ?? circled(n)).join(', ')} → ${circled(w.fixedBy.run.n)} ${label(w.fixedBy.run)} ${testSummary(w.fixedBy.run.test!)}`)
  if (w.improved) lines.push(`Improved: ${w.improved.from} → ${w.improved.to} failed at ${circled(w.improved.run.n)}`)
  lines.push('(inferred from failure-output mentions, recency and change counts — not proof)')
  return lines.join('\n')
}

export function renderCompare(nameA: string, nameB: string, c: Compared, stat?: string): string {
  const step = (s: Step | undefined): string => (s ? `${circled(s.n)} ${label(s)}` : '(end)')
  const lines = [`Compare ${nameA} ↔ ${nameB}`, `Shared start: ${c.common} step(s)`, `Diverged at: ${nameA} ${step(c.divergeA)} · ${nameB} ${step(c.divergeB)}`]
  lines.push(`Only on ${nameA} (${c.onlyA.length}): ${c.onlyA.slice(0, 20).map(step).join(', ') || '—'}`)
  lines.push(`Only on ${nameB} (${c.onlyB.length}): ${c.onlyB.slice(0, 20).map(step).join(', ') || '—'}`)
  lines.push(`Matched after the divergence: ${c.matched}`)
  const test = (s: Step | undefined): string => (s?.test ? testSummary(s.test) : 'no test run')
  lines.push(`Last test: ${nameA} ${test(c.lastTestA)} · ${nameB} ${test(c.lastTestB)}`)
  if (stat !== undefined) lines.push(`Files (${nameA} head → ${nameB} head):`, stat.trimEnd() || '  (identical)')
  return lines.join('\n')
}

export function renderRerun(step: Step, c: OutputComparison, where: string): string {
  const lines = [`Rerun of ${circled(step.n)} ${label(step)} (${where})`]
  if (c.identical) lines.push('Result: identical')
  else {
    lines.push(`Result: changed — +${c.addedCount} −${c.removedCount} line(s) (first 2 KiB compared)`)
    for (const line of c.removed) lines.push(`  − ${clip(line, 160)}`)
    for (const line of c.added) lines.push(`  + ${clip(line, 160)}`)
  }
  if (c.was && c.now) lines.push(`Test: ${testSummary(c.was)} → ${testSummary(c.now)}`)
  return lines.join('\n')
}

// `step` is the step asked for; `target` the step whose snapshot is used (the same, or the nearest earlier one).
export function renderRestorePlan(step: Step, target: Step, files: readonly FileChange[], applied: boolean, branch?: string): string {
  const n = step.n
  const what = `${circled(n)} ${label(step)}`
  const head = `snapshot ${target.snapshot?.commit.slice(0, 7) ?? '?'}${target.n !== n ? ` from ${circled(target.n)}` : ''}`
  const lines = applied
    ? [`Restored to ${what} (${head}): ${files.length} file(s) changed.`]
    : [`Restore to ${what} (${head}): ${files.length} file(s) would change.`]
  for (const f of files.slice(0, 50)) lines.push(`  ${f.status} ${f.path}`)
  if (files.length > 50) lines.push(`  … +${files.length - 50} more`)
  if (applied) {
    lines.push('The state before the restore was snapshotted, so this can be undone. The model was told the files changed.')
    if (branch !== undefined) lines.push(`New steps go to branch '${branch}'. The conversation itself was not rewound.`)
  } else {
    lines.push(branch !== undefined ? `Run /tm branch ${n} ${branch} --yes to apply.` : `Run /tm restore ${n} --yes to apply (the current state is snapshotted first, so it can be undone).`)
  }
  return lines.join('\n')
}

export function renderSessions(rows: readonly { id: string; startedAt: number; current: boolean }[]): string {
  if (rows.length === 0) return 'No recorded sessions for this project.'
  const sorted = [...rows].sort((a, b) => b.startedAt - a.startedAt)
  return ['Recorded sessions (newest first):', ...sorted.map(r => `  ${r.id}${r.current ? ' (this session)' : ''} · started ${new Date(r.startedAt).toISOString()}`)].join('\n')
}

export function statusLine(rec: Recorder, snapMs: readonly number[], off?: string): string {
  const steps = rec.all().filter(s => s.kind !== 'baseline')
  const last = steps.at(-1)?.n ?? 0
  if (off) return `tm ${circled(last)} · snapshots off`
  const snaps = steps.filter(s => s.snapshot?.changed).length
  const mean = avg(snapMs)
  return `tm ${circled(last)} · ${snaps} snaps${mean !== undefined ? ` · ${mean}ms` : ''}`
}
```

- [ ] **Step 4: Run tests, type check, commit**

Run: `"$CLAUDE292" plugin test time-machine && npx -y -p typescript@5 tsc -p time-machine --noEmit`
Expected: all PASS; tsc silent. Exact-string assertions on tree lines are the contract: if one differs by spacing, fix the renderer to match the test's tree shape (the spec's example), not the test.

```bash
git add time-machine
git commit -m "feat(time-machine): timeline tree, step detail, why, compare, rerun and restore rendering

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Shadow git wrapper

**Files:**
- Create: `time-machine/hooks/git.ts`
- Test: `time-machine/tests/git.test.ts`

**Interfaces:**
- Consumes: `FileChange`.
- Produces: `type RunResult = { exitCode; stdout; stderr }`, `type RunOptions = { env?; cwd?; timeoutMs? }`, `type Runner = (argv, opts?) => Promise<RunResult>`, `class GitError`, `MAX_FILES = 200`, `parseNameStatus(out): FileChange[]`, `isInside(child, parent)`, `type SnapResult = { commit; changed; files; filesTotal }`, `class ShadowGit(runner, gitDir, workTree, indexFile)` with public mutable `runner`, `serial(fn)`, `git(args, opts?)`, `init()`, `snapshot(parent, message, ref): Promise<SnapResult>`, `nameStatus(a, b)`, `diffText(a, b): Promise<{ stat; patch }>`, `restore(target, ref)`, `updateRef(ref, commit)`, `exportTo(commit, dir)`, `deleteRefs(prefix)`, `gc()`.

- [ ] **Step 1: Write the failing test**

`time-machine/tests/git.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { GitError, isInside, parseNameStatus, ShadowGit, type RunResult, type Runner } from '../hooks/git.ts'

type Call = { argv: readonly string[]; env?: Record<string, string>; cwd?: string }

// A scripted git: answers by subcommand, records every call.
function fake(answer: (sub: string, args: readonly string[]) => Partial<RunResult> | undefined = () => undefined) {
  const calls: Call[] = []
  const runner: Runner = async (argv, opts) => {
    calls.push({ argv, env: opts?.env, cwd: opts?.cwd })
    await Promise.resolve()
    const i = argv.indexOf('core.quotepath=off')
    const args = i >= 0 ? argv.slice(i + 1) : argv.slice(1)
    const r = answer(args[0] ?? '', args) ?? {}
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }
  const subs = (): string[] =>
    calls.map(c => {
      const i = c.argv.indexOf('core.quotepath=off')
      return i >= 0 ? c.argv[i + 1]! : c.argv[1]!
    })
  return { runner, calls, subs }
}

const G = (f: ReturnType<typeof fake>): ShadowGit => new ShadowGit(f.runner, '/s/shadow.git', '/r', '/s/index/s1')

test('the first snapshot commits the tree and counts its files', async () => {
  const f = fake((sub, args) => {
    if (sub === 'write-tree') return { stdout: 'tree1\n' }
    if (sub === 'commit-tree') return { stdout: 'commit1\n' }
    if (sub === 'ls-tree') return { stdout: 'a.py\nb.py\n' }
    return args.length ? undefined : undefined
  })
  const s = await G(f).snapshot(undefined, 'baseline', 'refs/tm/s1/main')
  expect(s).toEqual({ commit: 'commit1', changed: true, files: [], filesTotal: 2 })
  expect(f.subs()).toEqual(['add', 'write-tree', 'commit-tree', 'update-ref', 'ls-tree'])
  const first = f.calls[0]!
  expect(first.argv.slice(0, 3)).toEqual(['git', '--git-dir=/s/shadow.git', '--work-tree=/r'])
  expect(first.env!.GIT_INDEX_FILE).toBe('/s/index/s1')
  expect(first.env!.GIT_AUTHOR_NAME).toBe('time-machine')
  expect(first.cwd).toBe('/r')
  expect(f.calls[2]!.argv.slice(-3)).toEqual(['tree1', '-m', 'baseline'])
})

test('an unchanged tree makes no commit; a changed one lists its files', async () => {
  const same = fake(sub => (sub === 'write-tree' || sub === 'rev-parse' ? { stdout: 'treeX\n' } : undefined))
  expect(await G(same).snapshot('c1', 'step 2', 'refs/tm/s1/main')).toEqual({ commit: 'c1', changed: false, files: [], filesTotal: 0 })
  expect(same.subs()).toEqual(['add', 'write-tree', 'rev-parse'])
  const changed = fake(sub => {
    if (sub === 'write-tree') return { stdout: 'treeB\n' }
    if (sub === 'rev-parse') return { stdout: 'treeA\n' }
    if (sub === 'commit-tree') return { stdout: 'c2\n' }
    if (sub === 'diff') return { stdout: 'M\tauth.py\nR100\told.py\tnew.py\nD\tjunk.txt\n' }
    return undefined
  })
  const s = await G(changed).snapshot('c1', 'step 3', 'refs/tm/s1/main')
  expect(s.files).toEqual([
    { status: 'M', path: 'auth.py' },
    { status: 'R', path: 'new.py' },
    { status: 'D', path: 'junk.txt' },
  ])
  expect(changed.calls.find(c => c.argv.includes('commit-tree'))!.argv.slice(-5)).toEqual(['treeB', '-p', 'c1', '-m', 'step 3'])
})

test('a failing git call throws GitError with the first stderr line', async () => {
  const f = fake(sub => (sub === 'add' ? { exitCode: 128, stderr: 'fatal: not a git repository\nmore' } : undefined))
  let error: unknown
  try {
    await G(f).snapshot(undefined, 'x', 'r')
  } catch (e) {
    error = e
  }
  expect(error instanceof GitError).toBe(true)
  expect(String((error as Error).message)).toBe('git add failed (128): fatal: not a git repository')
})

test('operations run one at a time, in the order they were asked', async () => {
  const f = fake(sub => (sub === 'write-tree' ? { stdout: 't\n' } : sub === 'rev-parse' ? { stdout: 't\n' } : undefined))
  const g = G(f)
  await Promise.all([g.snapshot('c1', 'a', 'r'), g.snapshot('c1', 'b', 'r')])
  expect(f.subs()).toEqual(['add', 'write-tree', 'rev-parse', 'add', 'write-tree', 'rev-parse'])
})

test('restore, export, init, deleteRefs and gc issue the expected commands', async () => {
  const f = fake(sub => (sub === 'for-each-ref' ? { stdout: 'refs/tm/old/main\nrefs/tm/old/b1\n' } : undefined))
  const g = G(f)
  await g.restore('c3', 'refs/tm/s1/main')
  expect(f.calls[0]!.argv.slice(-4)).toEqual(['read-tree', '-u', '--reset', 'c3'])
  expect(f.calls[1]!.argv.slice(-3)).toEqual(['update-ref', 'refs/tm/s1/main', 'c3'])
  await g.exportTo('c3', '/s/tmp/x')
  const exp = f.calls[2]!
  expect(exp.argv).toContain('--work-tree=/s/tmp/x')
  expect(exp.env!.GIT_INDEX_FILE).toBe('/s/tmp/x.index')
  expect(exp.cwd).toBe('/s/tmp/x')
  await g.init()
  expect(f.calls[3]!.argv).toEqual(['git', 'init', '--bare', '--quiet', '/s/shadow.git'])
  await g.deleteRefs('refs/tm/old/')
  expect(f.calls.slice(5).map(c => c.argv.slice(-3))).toEqual([
    ['update-ref', '-d', 'refs/tm/old/main'],
    ['update-ref', '-d', 'refs/tm/old/b1'],
  ])
  await g.gc()
  expect(f.calls.at(-1)!.argv.slice(-3)).toEqual(['gc', '--prune=now', '--quiet'])
})

test('parseNameStatus and isInside', () => {
  expect(parseNameStatus('A\ta.py\nC75\tx.py\ty.py\n\n')).toEqual([
    { status: 'A', path: 'a.py' },
    { status: 'C', path: 'y.py' },
  ])
  expect(isInside('/s/tmp/x', '/s/tmp')).toBe(true)
  expect(isInside('/s/tmp', '/s/tmp')).toBe(false)
  expect(isInside('/s/tmp/../etc', '/s/tmp')).toBe(false)
  expect(isInside('/s/tmpx/a', '/s/tmp')).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `"$CLAUDE292" plugin test time-machine`
Expected: git test FAILS (module missing).

- [ ] **Step 3: Implement git.ts**

`time-machine/hooks/git.ts`:

```ts
import type { FileChange } from './core/types.ts'

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunOptions = { env?: Record<string, string>; cwd?: string; timeoutMs?: number }
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<RunResult>
export type SnapResult = { commit: string; changed: boolean; files: FileChange[]; filesTotal: number }

export const MAX_FILES = 200
const TIMEOUT_MS = 30_000
const IDENTITY = {
  GIT_AUTHOR_NAME: 'time-machine',
  GIT_AUTHOR_EMAIL: 'tm@local',
  GIT_COMMITTER_NAME: 'time-machine',
  GIT_COMMITTER_EMAIL: 'tm@local',
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: RunResult,
  ) {
    super(`git ${args[0] ?? ''} failed (${result.exitCode}): ${result.stderr.trim().split('\n')[0] ?? ''}`)
  }
}

// `--name-status` lines: `M\tpath`, `R100\told\tnew`, `C75\tfrom\tto`; the path kept is the new one.
export function parseNameStatus(out: string): FileChange[] {
  const files: FileChange[] = []
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    files.push({ status: parts[0]!.charAt(0), path: parts[parts.length - 1]! })
  }
  return files
}

// A path strictly below `parent`, spelled without `..`.
export function isInside(child: string, parent: string): boolean {
  const base = parent.replace(/\/+$/, '')
  return child.startsWith(`${base}/`) && !child.split('/').includes('..')
}

// A bare repository beside the project: its own index per session, the project as work tree, so the
// user's .git is never read or written. The host's `.gitignore` files apply.
export class ShadowGit {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    // Any live hook's `$.process.run`; set again by each hook that uses git.
    public runner: Runner,
    readonly gitDir: string,
    readonly workTree: string,
    readonly indexFile: string,
  ) {}

  // One operation at a time: parallel tool calls share the index.
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  async git(args: readonly string[], opts: { index?: string; workTree?: string; timeoutMs?: number } = {}): Promise<string> {
    const workTree = opts.workTree ?? this.workTree
    const argv = ['git', `--git-dir=${this.gitDir}`, `--work-tree=${workTree}`, '-c', 'core.quotepath=off', ...args]
    const result = await this.runner(argv, {
      cwd: workTree,
      env: { ...IDENTITY, GIT_INDEX_FILE: opts.index ?? this.indexFile },
      timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    })
    if (result.exitCode !== 0) throw new GitError(args, result)
    return result.stdout
  }

  // Idempotent: re-running init on an existing repository leaves it as it is.
  async init(): Promise<void> {
    const args = ['init', '--bare', '--quiet', this.gitDir]
    const result = await this.runner(['git', ...args], { timeoutMs: TIMEOUT_MS })
    if (result.exitCode !== 0) throw new GitError(args, result)
  }

  // Stage the work tree; commit only when its tree differs from `parent`'s.
  snapshot(parent: string | undefined, message: string, ref: string): Promise<SnapResult> {
    return this.serial(async () => {
      await this.git(['add', '-A'])
      const tree = (await this.git(['write-tree'])).trim()
      if (parent !== undefined) {
        const parentTree = (await this.git(['rev-parse', `${parent}^{tree}`])).trim()
        if (parentTree === tree) return { commit: parent, changed: false, files: [], filesTotal: 0 }
      }
      const commit = (await this.git(['commit-tree', tree, ...(parent !== undefined ? ['-p', parent] : []), '-m', message])).trim()
      await this.git(['update-ref', ref, commit])
      if (parent === undefined) {
        const listed = (await this.git(['ls-tree', '-r', '--name-only', commit])).split('\n').filter(l => l !== '')
        return { commit, changed: true, files: [], filesTotal: listed.length }
      }
      const files = parseNameStatus(await this.git(['diff', '--name-status', '-M', parent, commit]))
      return { commit, changed: true, files: files.slice(0, MAX_FILES), filesTotal: files.length }
    })
  }

  nameStatus(a: string, b: string): Promise<FileChange[]> {
    return this.serial(async () => parseNameStatus(await this.git(['diff', '--name-status', '-M', a, b])))
  }

  diffText(a: string, b: string): Promise<{ stat: string; patch: string }> {
    return this.serial(async () => ({ stat: await this.git(['diff', '--stat', a, b]), patch: await this.git(['diff', a, b]) }))
  }

  // The work tree made to match `target`: tracked files rewritten, files `target` lacks removed, ignored
  // files untouched. The index must hold the current state (a snapshot just before does that).
  restore(target: string, ref: string): Promise<void> {
    return this.serial(async () => {
      await this.git(['read-tree', '-u', '--reset', target])
      await this.git(['update-ref', ref, target])
    })
  }

  updateRef(ref: string, commit: string): Promise<void> {
    return this.serial(async () => {
      await this.git(['update-ref', ref, commit])
    })
  }

  // A snapshot's files written into `dir` (existing and empty) through a throwaway index beside it.
  exportTo(commit: string, dir: string): Promise<void> {
    return this.serial(async () => {
      await this.git(['read-tree', '-u', '--reset', commit], { index: `${dir}.index`, workTree: dir })
    })
  }

  deleteRefs(prefix: string): Promise<void> {
    return this.serial(async () => {
      const refs = (await this.git(['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter(l => l !== '')
      for (const ref of refs) await this.git(['update-ref', '-d', ref])
    })
  }

  gc(): Promise<void> {
    return this.serial(async () => {
      await this.git(['gc', '--prune=now', '--quiet'], { timeoutMs: 120_000 })
    })
  }
}
```

- [ ] **Step 4: Run tests, type check, commit**

Run: `"$CLAUDE292" plugin test time-machine && npx -y -p typescript@5 tsc -p time-machine --noEmit`
Expected: all PASS; tsc silent.

```bash
git add time-machine
git commit -m "feat(time-machine): shadow git wrapper over an injected runner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Adapter

**Files:**
- Modify (replace): `time-machine/hooks/register.tsx`
- Test: `time-machine/tests/adapter.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: commands `/tm` (with `argumentHint`) and `/tm-pane`; pane id `time-machine`.

- [ ] **Step 1: Write the failing adapter test**

`time-machine/tests/adapter.test.ts`:

```ts
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PYTEST_FAIL = `FAILED tests/test_auth.py::test_login - AssertionError\ntests/test_auth.py:12: AssertionError\n========================= 1 failed, 4 passed in 0.10s =========================`

// The runner's `$` has no `process`, so git is unavailable here: these tests run the "snapshots off" path.
function world(on: On, writes: Map<string, string>): void {
  mock.env(on, { HOME: '/Users/u' })
  mock.store(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_$, e) => {
    writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('session.start', () => ({}) as never)
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') return { isError: true, text: PYTEST_FAIL } as never
    if (e.tool === 'Write') return { deny: 'not allowed' } as never
    return { result: {}, text: 'file body' } as never
  })
}

async function recordSome($: Parameters<Parameters<typeof test>[1]>[0], on: On, writes: Map<string, string>) {
  world(on, writes)
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  await $.tool.call({ tool: 'Read', file_path: '/r/auth.py', tool_use_id: 't1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pytest -q', tool_use_id: 't2' } as never)
}

test('tool.call relays the answer unchanged, deny included', async ($, on) => {
  world(on, new Map())
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  const denied = await $.tool.call({ tool: 'Write', file_path: '/r/x', content: 'y', tool_use_id: 't9' } as never)
  expect(denied.deny).toBe('not allowed')
})

test('/tm draws the timeline and says why snapshots are off', async ($, on) => {
  await recordSome($, on, new Map())
  const text = String((await $.command.run({ command: 'tm', args: '' } as never)).text)
  expect(text).toContain('snapshots off:')
  expect(text).toContain('├── ① Read auth.py')
  expect(text).toContain('└── ② Bash pytest -q')
  expect(text).toContain('✗ 1 failed, 4 passed')
})

test('/tm show, /tm why, /tm restore and an unknown subcommand', async ($, on) => {
  await recordSome($, on, new Map())
  const run = async (args: string): Promise<string> => String((await $.command.run({ command: 'tm', args } as never)).text)
  expect(await run('show 2')).toContain('command: pytest -q')
  const why = await run('why')
  expect(why).toContain('Why did ② Bash pytest -q fail?')
  expect(why).toContain('tests/test_auth.py::test_login')
  expect(await run('restore 1')).toContain('snapshots are off')
  expect(await run('show 99')).toContain('no step 99')
  expect(await run('bogus')).toContain('/tm [timeline')
})

test('the timeline is persisted as JSONL in the session folder, with a meta file', async ($, on) => {
  const writes = new Map<string, string>()
  await recordSome($, on, writes)
  const dir = [...writes.keys()].find(p => p.endsWith('/meta.json'))!
  expect(dir).toMatch(/^\/Users\/u\/\.claude\/time-machine\/r-[0-9a-f]{8}\/sessions\/sess-1\/meta\.json$/)
  const chunk = [...writes.entries()].find(([p]) => p.endsWith('.jsonl'))!
  const types = chunk[1].trim().split('\n').map(l => (JSON.parse(l) as { type: string }).type)
  expect(types).toEqual(['session', 'step', 'step', 'step'])
})

test('turn.step chunks reach the caller unchanged', async ($, on) => {
  world(on, new Map())
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'hi' }
    yield { kind: 'tool', index: 1, id: 'x', name: 'Read' }
    yield { kind: 'stop', stopReason: 'tool_use', usage }
    return { turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'tool_use', usage }
  })
  const kinds: string[] = []
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) kinds.push(chunk.kind)
  expect(kinds).toEqual(['text', 'tool', 'stop'])
})
```

Notes for the implementer:
- `types` in the persistence test is `['session', 'step', 'step', 'step']`: the baseline step (no snapshot, written when git turned out unavailable at the first mutating call) and the two tool steps. If the baseline is written in a different position, assert the multiset instead and say so; do not drop the baseline.
- If a mock's answer shape is rejected by the runner (e.g. `command.register`, `session.root`), look up the result type in `time-machine/.claude-plugin/types/claude-code/index.d.ts` and adjust the mock, not the adapter.

- [ ] **Step 2: Run to verify it fails**

Run: `"$CLAUDE292" plugin test time-machine`
Expected: adapter tests FAIL (stub adapter).

- [ ] **Step 3: Write the adapter**

`time-machine/hooks/register.tsx`:

```tsx
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import { why } from './core/causality.ts'
import { classifyCommand } from './core/classify.ts'
import { compare, compareOutputs } from './core/compare.ts'
import { contentHash } from './core/hash.ts'
import {
  circled,
  label,
  renderCompare,
  renderRerun,
  renderRestorePlan,
  renderSessions,
  renderStep,
  renderTimeline,
  renderWhy,
  statusLine,
} from './core/render.ts'
import { ChunkWriter, parseChunks, projectKey } from './core/store.ts'
import { parseTestOutput } from './core/testparse.ts'
import { Recorder } from './core/timeline.ts'
import { callInput, isMutating, resultText, summarizeInput, summarizeResult, targetOf } from './core/tools.ts'
import type { SnapshotRef, Step } from './core/types.ts'
import { isInside, ShadowGit, type Runner } from './git.ts'

const PANE = 'time-machine'
// Names this module load's timeline chunks, so a reload never overwrites an earlier load's.
const LOAD_ID = Date.now().toString(36)
const DAY = 86_400_000
const TOO_SLOW_MS = 5_000
const MAX_LIVE_INPUTS = 500
const USAGE =
  'usage: /tm [timeline [--all] [--branch b] | show <n> | diff <a> [b] | why [n] | restore <n> [--yes] | branch <n> [name] [--yes] | compare <a> <b> | rerun <n> [--write] [--isolated] | sessions]'

type Ctx = {
  rec: Recorder
  root: string
  base: string
  dir: string
  git?: ShadowGit
  ready?: Promise<void>
  off?: string
  head?: string
  writer: ChunkWriter
  writing: Promise<void>
  inflight: number
  snapMs: number[]
  live: Map<number, Record<string, unknown>>
  rerunOf?: number
  ended?: boolean
}

let ctx: Ctx | undefined
let currentOptions: PluginOptions = {}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

function runnerOf($: EngineInterface): Runner {
  return async (argv, opts) => {
    const r = await $.process.run(argv, opts)
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  }
}

const refOf = (c: Ctx): string => `refs/tm/${c.rec.session.sessionId}/${c.rec.branch}`

async function storeDir($: EngineInterface, options: PluginOptions): Promise<string> {
  const dir = (String(options.storeDir ?? '').trim() || '~/.claude/time-machine').replace(/\/+$/, '')
  if (!/^~(?=\/|$)/.test(dir)) return dir
  return dir.replace(/^~/, (await $.env.get('HOME')) ?? '.')
}

// Records written in order: every chunk a batch touched gets its final body.
async function persist($: EngineInterface, c: Ctx): Promise<void> {
  const recs = c.rec.drain()
  if (recs.length === 0) return c.writing
  const writes = new Map<string, string>()
  for (const rec of recs) {
    const { name, body } = c.writer.add(rec)
    writes.set(name, body)
  }
  c.writing = c.writing
    .then(async () => {
      for (const [name, body] of writes) await $.fs.write(`${c.dir}/${name}`, body)
    })
    .catch(() => undefined)
  return c.writing
}

function paint($: EngineInterface, c: Ctx): void {
  try {
    $.ui.status(statusLine(c.rec, c.snapMs, c.off))
    $.ui.invalidate('ui.render')
  } catch {
    // no status line here
  }
}

async function startSession($: EngineInterface): Promise<Ctx> {
  const sessionId = await $.session.id()
  const root = await $.session.root()
  const base = `${await storeDir($, currentOptions)}/${projectKey(root)}`
  const dir = `${base}/sessions/${sessionId}`
  let rec: Recorder | undefined
  try {
    const entries = await $.fs.list(dir)
    const files = await Promise.all(
      entries.filter(e => e.kind === 'file' && e.name.endsWith('.jsonl')).map(async e => ({ name: e.name, text: String(await $.fs.read(`${dir}/${e.name}`)) })),
    )
    rec = Recorder.fromRecords(parseChunks(files))
  } catch {
    // a new session
  }
  rec ??= new Recorder({ sessionId, root, startedAt: Date.now(), loadId: LOAD_ID })
  const c: Ctx = { rec, root, base, dir, writer: new ChunkWriter(LOAD_ID), writing: Promise.resolve(), inflight: 0, snapMs: [], live: new Map() }
  const last = rec.lastSnapshot()
  if (last?.snapshot) c.head = last.snapshot.commit
  try {
    await $.fs.write(`${dir}/meta.json`, JSON.stringify({ sessionId, root, startedAt: rec.session.startedAt }))
  } catch {
    // the timeline still lives in memory
  }
  await persist($, c)
  return c
}

// The context for this session, started again after a /clear or a resume.
async function live($: EngineInterface): Promise<Ctx | undefined> {
  if (ctx && !ctx.ended) return ctx
  try {
    ctx = await startSession($)
  } catch {
    ctx = undefined
  }
  return ctx
}

// Git, ready to use from this hook, or undefined with `c.off` saying why.
async function ensureGit($: EngineInterface, c: Ctx): Promise<ShadowGit | undefined> {
  if (c.off) return undefined
  if (c.git) {
    c.git.runner = runnerOf($)
    await c.ready
    return c.off ? undefined : c.git
  }
  const home = await $.env.get('HOME').catch(() => undefined)
  if (c.root === '/' || (home !== undefined && c.root.replace(/\/+$/, '') === home.replace(/\/+$/, ''))) {
    c.off = 'the session root is the home or the root directory'
  }
  const git = new ShadowGit(runnerOf($), `${c.base}/shadow.git`, c.root, `${c.base}/index/${c.rec.session.sessionId}`)
  c.git = git
  c.ready = (async () => {
    if (c.off) return
    try {
      await git.runner(['mkdir', '-p', `${c.base}/index`])
      await git.init()
      if (c.head === undefined) {
        const t0 = Date.now()
        const snap = await git.snapshot(undefined, `baseline ${c.rec.session.sessionId}`, refOf(c))
        const ms = Date.now() - t0
        c.head = snap.commit
        if (!c.rec.get(0)) c.rec.baseline(Date.now(), { ...snap, ms })
        if (ms > TOO_SLOW_MS) c.off = `the baseline snapshot took ${ms}ms; per-step snapshots would slow every tool`
      }
      await prune($, c, git)
    } catch (error) {
      c.off = `git unavailable: ${message(error)}`
    }
  })()
  await c.ready
  if (!c.rec.get(0)) c.rec.baseline(Date.now())
  await persist($, c)
  return c.off ? undefined : git
}

async function takeSnapshot($: EngineInterface, c: Ctx, label: string): Promise<SnapshotRef | undefined> {
  const git = await ensureGit($, c)
  if (!git) return undefined
  const concurrent = c.inflight > 0
  const t0 = Date.now()
  try {
    const s = await git.snapshot(c.head, label, refOf(c))
    const ms = Date.now() - t0
    c.head = s.commit
    c.snapMs.push(ms)
    if (c.snapMs.length > 1_000) c.snapMs.shift()
    return { ...s, ms, ...(concurrent ? { concurrent: true } : {}) }
  } catch (error) {
    c.off = `snapshot failed: ${message(error)}`
    return undefined
  }
}

// Changes made outside the agent since the last snapshot become an `external` step of their own.
async function checkExternal($: EngineInterface, c: Ctx): Promise<void> {
  if (c.inflight > 0) return
  const snap = await takeSnapshot($, c, 'external')
  if (!snap?.changed) return
  const step = c.rec.begin({ id: `external-${Date.now()}`, tool: 'external', kind: 'external', at: Date.now() })
  c.rec.finish(step, Date.now(), { snapshot: snap })
}

async function prune($: EngineInterface, c: Ctx, git: ShadowGit): Promise<void> {
  const key = `lastPrune:${projectKey(c.root)}`
  const last = Number((await $.store.get(key)) ?? 0)
  if (Date.now() - last < DAY) return
  await $.store.set(key, Date.now())
  const days = Number(currentOptions.retentionDays ?? 14)
  if (!(days > 0)) return
  const sessions = `${c.base}/sessions`
  for (const entry of await $.fs.list(sessions).catch(() => [])) {
    if (entry.kind !== 'dir' || entry.name === c.rec.session.sessionId) continue
    const target = `${sessions}/${entry.name}`
    try {
      const meta = JSON.parse(String(await $.fs.read(`${target}/meta.json`))) as { startedAt?: number }
      if (Date.now() - Number(meta.startedAt ?? Date.now()) < days * DAY || !isInside(target, sessions)) continue
      await git.runner(['rm', '-rf', target])
      await git.deleteRefs(`refs/tm/${entry.name}/`)
    } catch {
      // leave it for next time
    }
  }
  await git.gc().catch(() => undefined)
}

async function settle($: EngineInterface, c: Ctx, step: Step | undefined, mutating: boolean, answer: unknown): Promise<void> {
  if (mutating) c.inflight = Math.max(0, c.inflight - 1)
  if (!step) return
  try {
    const result = summarizeResult(answer)
    const snapshot = mutating ? await takeSnapshot($, c, `step ${step.n} ${step.tool}`) : undefined
    const command = String(c.live.get(step.n)?.command ?? step.input.command ?? '')
    const test = step.tool === 'Bash' && classifyCommand(command) === 'test' ? parseTestOutput(resultText(answer), result.isError) : undefined
    c.rec.finish(step, Date.now(), { result, ...(snapshot ? { snapshot } : {}), ...(test ? { test } : {}) })
    await persist($, c)
    paint($, c)
  } catch {
    // recording never breaks the call
  }
}

const num = (word: string | undefined): number | undefined => (word !== undefined && /^\d+$/.test(word) ? Number(word) : undefined)

async function restore($: EngineInterface, c: Ctx, n: number, yes: boolean, branch?: string): Promise<string> {
  if (!c.rec.get(n)) return `time-machine: no step ${n}`
  const git = await ensureGit($, c)
  if (!git) return `time-machine: snapshots are off (${c.off ?? 'not ready'}); there is nothing to restore`
  const target = c.rec.snapshotAt(n)
  if (!target?.snapshot) return `time-machine: no snapshot at or before step ${n}`
  await checkExternal($, c)
  const from = c.head!
  const files = await git.nameStatus(from, target.snapshot.commit)
  const name = branch === undefined ? undefined : branch || c.rec.nextBranchName()
  const asked = c.rec.get(n)!
  if (!yes) return renderRestorePlan(asked, target, files, false, name)
  if (name !== undefined) c.rec.fork(name, n, Date.now())
  await git.restore(target.snapshot.commit, refOf(c))
  c.head = target.snapshot.commit
  const step = c.rec.begin({ id: `restore-${Date.now()}`, tool: 'restore', kind: 'restore', input: { to: n, from }, target: `step ${n}`, at: Date.now() })
  const snapshot: SnapshotRef = { commit: target.snapshot.commit, changed: files.length > 0, files: files.slice(0, 200), filesTotal: files.length, ms: 0 }
  c.rec.finish(step, Date.now(), { snapshot })
  await persist($, c)
  paint($, c)
  const list = files.slice(0, 20).map(f => `${f.status} ${f.path}`).join(', ')
  const note =
    `[time-machine] The user restored the working tree to step ${n} (${label(c.rec.get(n)!)}). ${files.length} file(s) changed${list ? `: ${list}` : ''}. ` +
    'Earlier tool results about these files are out of date; re-read files before editing them.' +
    (name !== undefined ? ` Work continues on branch '${name}'; the conversation itself was not rewound.` : '')
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: note }] } })
  } catch {
    // the restore stands; the model was not told
  }
  return renderRestorePlan(asked, target, files, true, name)
}

// A branch name, or `session:<id>[/<branch>]` for another recorded session of this project.
async function pathOf($: EngineInterface, c: Ctx, spec: string): Promise<{ steps: Step[]; head?: string } | string> {
  let rec: Recorder | undefined = c.rec
  let branch = spec
  if (spec.startsWith('session:')) {
    const [id, b] = spec.slice('session:'.length).split('/')
    const dir = `${c.base}/sessions/${id}`
    try {
      const entries = await $.fs.list(dir)
      const files = await Promise.all(
        entries.filter(e => e.kind === 'file' && e.name.endsWith('.jsonl')).map(async e => ({ name: e.name, text: String(await $.fs.read(`${dir}/${e.name}`)) })),
      )
      rec = Recorder.fromRecords(parseChunks(files))
    } catch {
      rec = undefined
    }
    if (!rec) return `time-machine: no recorded session ${id}`
    branch = b ?? 'main'
  }
  if (!rec.branches.has(branch)) return `time-machine: no branch '${branch}'`
  const steps = rec.path(branch)
  const head = rec.lastSnapshot(branch)?.snapshot?.commit
  return head !== undefined ? { steps, head } : { steps }
}

async function rerun($: EngineInterface, c: Ctx, n: number, write: boolean, isolated: boolean): Promise<string> {
  const step = c.rec.get(n)
  if (!step || step.kind !== 'tool') return `time-machine: no tool step ${n}`
  const input = c.live.get(n) ?? (step.inputLossy ? undefined : step.input)
  if (!input) return `time-machine: step ${n}'s input was cut or redacted when stored and this load did not record it live, so it cannot be replayed`
  if (isolated) {
    if (step.tool !== 'Bash') return 'time-machine: --isolated replays Bash steps only'
    const git = await ensureGit($, c)
    if (!git) return `time-machine: snapshots are off (${c.off ?? 'not ready'})`
    const before = c.rec.snapshotAt(step.parent)
    if (!before?.snapshot) return `time-machine: no snapshot before step ${n}`
    const command = String(input.command ?? '')
    const tmpRoot = `${c.base}/tmp`
    const tmp = `${tmpRoot}/${LOAD_ID}-${n}-${Date.now().toString(36)}`
    const run = runnerOf($)
    try {
      await run(['mkdir', '-p', tmp])
      await git.exportTo(before.snapshot.commit, tmp)
      const r = await run(['sh', '-lc', command], { cwd: tmp, timeoutMs: 600_000 })
      const text = [r.stdout, r.stderr].filter(s => s !== '').join('\n')
      const now = step.test ? parseTestOutput(text, r.exitCode !== 0) : undefined
      const where = `isolated, in a copy of ${circled(before.n)}'s snapshot; ignored files such as dependencies are not in the copy`
      return [`$ ${command}`, renderRerun(step, compareOutputs(step.result, text, step.test, now), where)].join('\n')
    } finally {
      if (isInside(tmp, tmpRoot)) await run(['rm', '-rf', tmp, `${tmp}.index`]).catch(() => undefined)
    }
  }
  if (isMutating(step.tool, input, currentOptions.skipSearchBash === true) && !write)
    return `time-machine: step ${n} (${step.tool}) can change files; add --write to run it again here (a snapshot is taken after it)`
  c.rerunOf = n
  const answer = await $.tool.call({ tool: step.tool, ...input } as never)
  const text = resultText(answer)
  const now = step.test ? parseTestOutput(text, summarizeResult(answer).isError) : undefined
  return renderRerun(step, compareOutputs(step.result, text, step.test, now), 'here, against the current files')
}

async function runTm($: EngineInterface, c: Ctx, args: string): Promise<string> {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const flags = new Set(words.filter(w => w.startsWith('--')))
  const rest = words.filter(w => !w.startsWith('--'))
  const sub = rest[0] ?? 'timeline'
  switch (sub) {
    case 'timeline': {
      const branchAt = words.indexOf('--branch')
      const branch = branchAt >= 0 ? words[branchAt + 1] : undefined
      if (branch !== undefined && !c.rec.branches.has(branch)) return `time-machine: no branch '${branch}'`
      return renderTimeline(c.rec, { all: flags.has('--all'), ...(branch ? { branch } : {}), ...(c.off ? { off: c.off } : {}), snapMs: c.snapMs })
    }
    case 'show': {
      const n = num(rest[1])
      const step = n === undefined ? undefined : c.rec.get(n)
      return step ? renderStep(step) : `time-machine: no step ${rest[1] ?? ''}`.trim()
    }
    case 'diff': {
      const a = num(rest[1])
      if (a === undefined) return USAGE
      const git = await ensureGit($, c)
      if (!git) return `time-machine: snapshots are off (${c.off ?? 'not ready'})`
      const from = c.rec.snapshotAt(a)?.snapshot?.commit
      let to: string | undefined
      const b = num(rest[2])
      if (b !== undefined) to = c.rec.snapshotAt(b)?.snapshot?.commit
      else {
        await checkExternal($, c)
        to = c.head
      }
      if (from === undefined || to === undefined) return 'time-machine: no snapshot for that step'
      const { stat, patch } = await git.diffText(from, to)
      const lines = patch.split('\n')
      const cut = lines.length > 400 ? [...lines.slice(0, 400), `… (${lines.length - 400} more lines)`] : lines
      return [stat.trimEnd() || '(no difference)', '', ...cut].join('\n')
    }
    case 'why': {
      const w = why(c.rec.path(), num(rest[1]))
      if (!w) return rest[1] ? `time-machine: step ${rest[1]} is not a test run on this branch` : 'time-machine: no failing test run on this branch'
      return renderWhy(w, n => {
        const s = c.rec.get(n)
        return s ? `${circled(n)} ${label(s)}` : undefined
      })
    }
    case 'restore':
    case 'branch': {
      const n = num(rest[1])
      if (n === undefined) return USAGE
      return restore($, c, n, flags.has('--yes'), sub === 'branch' ? (rest[2] ?? '') : undefined)
    }
    case 'compare': {
      if (rest.length < 3) return USAGE
      const a = await pathOf($, c, rest[1]!)
      const b = await pathOf($, c, rest[2]!)
      if (typeof a === 'string') return a
      if (typeof b === 'string') return b
      let stat: string | undefined
      if (a.head && b.head) {
        const git = await ensureGit($, c)
        if (git) stat = (await git.diffText(a.head, b.head).catch(() => ({ stat: '(snapshots no longer available)', patch: '' }))).stat
      }
      return renderCompare(rest[1]!, rest[2]!, compare(a.steps, b.steps), stat)
    }
    case 'rerun': {
      const n = num(rest[1])
      if (n === undefined) return USAGE
      return rerun($, c, n, flags.has('--write'), flags.has('--isolated'))
    }
    case 'sessions': {
      const sessions = `${c.base}/sessions`
      const rows: { id: string; startedAt: number; current: boolean }[] = []
      for (const entry of await $.fs.list(sessions).catch(() => [])) {
        if (entry.kind !== 'dir') continue
        let startedAt = 0
        try {
          startedAt = Number((JSON.parse(String(await $.fs.read(`${sessions}/${entry.name}/meta.json`))) as { startedAt?: number }).startedAt ?? 0)
        } catch {
          // unknown start
        }
        rows.push({ id: entry.name, startedAt, current: entry.name === c.rec.session.sessionId })
      }
      return renderSessions(rows)
    }
    default:
      return USAGE
  }
}

export const register: Register = (on, options) => {
  currentOptions = options

  on('session.start', async ($, e, next) => {
    try {
      ctx = await startSession($)
      for (const command of [
        { name: 'tm', description: 'Agent Time Machine: timeline, show, diff, why, restore, branch, compare, rerun, sessions', argumentHint: '[timeline|show n|diff a [b]|why [n]|restore n|branch n|compare a b|rerun n|sessions]' },
        { name: 'tm-pane', description: 'Open the live Time Machine timeline pane' },
      ]) {
        try {
          await $.command.register(command)
        } catch {
          // the command stays unavailable
        }
      }
      paint($, ctx)
    } catch {
      ctx = undefined
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const result = await next(e)
    if ((e.reason === 'clear' || e.reason === 'resume') && ctx) ctx.ended = true
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    try {
      const c = await live($)
      if (c) {
        c.rec.startTurn(Date.now(), e.text, currentOptions.recordModelOutput === true)
        await persist($, c)
      }
    } catch {
      // not recorded
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const c = await live($).catch(() => undefined)
    if (!c) return next(e)
    const raw = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    let step: Step | undefined
    let mutating = false
    try {
      mutating = isMutating(tool, raw, currentOptions.skipSearchBash === true)
      if (mutating) await checkExternal($, c)
      const { input, lossy } = summarizeInput(raw)
      const target = targetOf(tool, raw, c.root)
      step = c.rec.begin({
        id: e.tool_use_id ?? `call-${Date.now()}`,
        tool,
        input,
        inputLossy: lossy,
        at: Date.now(),
        ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(c.rerunOf !== undefined ? { rerunOf: c.rerunOf } : {}),
      })
      c.rerunOf = undefined
      c.live.set(step.n, callInput(raw))
      if (c.live.size > MAX_LIVE_INPUTS) c.live.delete(c.live.keys().next().value!)
      if (mutating) c.inflight += 1
    } catch {
      // recording never blocks the tool
    }
    try {
      const answer = await next(e)
      await settle($, c, step, mutating, answer)
      return answer
    } catch (error) {
      await settle($, c, step, mutating, { isError: true, text: message(error) })
      throw error
    }
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    let text = ''
    const tools: { id: string; tool: string }[] = []
    for await (const chunk of next(e)) {
      try {
        if (chunk.kind === 'text') text += chunk.text
        else if (chunk.kind === 'tool') tools.push({ id: chunk.id, tool: chunk.name })
        else if (chunk.kind === 'stop' && ctx && !ctx.ended)
          ctx.rec.addModel({
            turn: ctx.rec.turn,
            index: e.index,
            ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
            model: e.model,
            stopReason: chunk.stopReason,
            usage: chunk.usage,
            text: { chars: text.length, hash: contentHash(text), ...(currentOptions.recordModelOutput === true ? { body: text } : {}) },
            toolUses: tools,
          })
      } catch {
        // not recorded
      }
      yield chunk
    }
    if (ctx) await persist($, ctx).catch(() => undefined)
  })

  on('command.run', { command: 'tm' }, async ($, e) => {
    try {
      const c = await live($)
      if (!c) return { text: 'time-machine: not recording (the session could not be read)' }
      return { text: await runTm($, c, e.args ?? '') }
    } catch (error) {
      return { text: `time-machine: ${message(error)}` }
    }
  })

  on('command.run', { command: 'tm-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Time Machine' })
    return { text: 'Time Machine pane opened (shown in the terminal and the desktop app).' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    let lines: string[]
    try {
      lines = ctx ? renderTimeline(ctx.rec, { ...(ctx.off ? { off: ctx.off } : {}), snapMs: ctx.snapMs }).split('\n') : ['Time Machine: not recording']
    } catch (error) {
      lines = [`time-machine: ${message(error)}`]
    }
    const width = e.props.bodyColumns ?? 80
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text>{(line.length > width ? `${line.slice(0, width - 1)}…` : line) || ' '}</Text>
        ))}
      </Box>
    )
  })
}
```

Notes:
- Task 5's `renderWhy` takes the optional `labels` argument used here.

- [ ] **Step 4: Run tests, type check, validate**

Run: `"$CLAUDE292" plugin test time-machine && npx -y -p typescript@5 tsc -p time-machine --noEmit && "$CLAUDE292" plugin validate time-machine`
Expected: all PASS; tsc silent; validate passes (report any warnings verbatim). If tsc rejects an engine type against the core (e.g. `e.reason`, `chunk.usage`), fix the core type or add the narrowest guard, never a broad cast.

- [ ] **Step 5: Commit**

```bash
git add time-machine
git commit -m "feat(time-machine): adapter: recording, snapshots, /tm commands, restore notes, pane

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: README, marketplace entry, end-to-end check

**Files:**
- Create: `time-machine/README.md`
- Modify: `.claude-plugin/marketplace.json`, `README.md` (root)

- [ ] **Step 1: Marketplace and root README**

Add to `.claude-plugin/marketplace.json` `plugins` (after context-inspector):

```json
    {
      "name": "time-machine",
      "source": "./time-machine",
      "description": "Agent Time Machine: a branching timeline of tool calls with shadow-git snapshots — inspect, diff, explain test failures, restore, branch, compare, re-run"
    }
```

Add to the root `README.md` list under `## Mods`:

```markdown
- [time-machine](time-machine/README.md): records every tool call on a branching timeline with shadow-git snapshots, so you can see the files as they were at any step, explain which edit broke a test, restore, branch, compare runs and re-run steps.
```

- [ ] **Step 2: Write the mod README**

`time-machine/README.md` (Korean, like the other mods' READMEs). Sections, each with the content below:

1. 제목과 한 단락 소개 — 에이전트가 여러 파일을 바꾸다 엉뚱한 결과를 냈을 때 Git diff로는 알 수 없는 "순서, 도구 호출, 그때의 파일 상태, 결과"를 기록하고 되돌아가 본다. 스펙의 Session #184 예시 트리를 그대로 넣는다.
2. 설치 — `/plugin install time-machine --marketplace YeonwooSung/my-claude-code-mods`; Claude Code 2.1.287+; git 필요.
3. 명령 표 — `/tm` 하위 명령 전부(스펙 §4.8 표와 같은 내용, `/tm-pane` 포함)와 상태줄 형식.
4. 어떻게 기록하나 — 섀도 git(위치, 세션별 인덱스, ref 이름, 사용자 `.git` 불간섭, `.gitignore` 존중), 변경성 도구 뒤 스냅샷(모든 Bash 기본, `skipSearchBash`), 외부 변경 step, 베이스라인은 첫 변경 직전, 동시 도구 호출 시 `concurrent`.
5. 관찰 가능성 등급 표 — 스펙 §2 표.
6. 인과(why) — 기준(마지막 통과 실행), 점수 규칙(실패 출력 언급 +100, 파일명만 +60, 실패 위치 +50, 최근성 0–20, 변경 횟수 0–10), fixed by, improved, "추론이지 증명이 아님".
7. 복구·분기 — dry run 기본, `--yes`, 복구 전 스냅샷, 대화에 노트 추가, 대화는 되감지 않음, 무시 파일은 그대로.
8. 재실행 — 기본(같은 입력, 권한 확인, 변경성은 `--write`), `--isolated`(Bash만, 그 시점 스냅샷 복사본에서, 무시 파일 없음, 권한 다이얼로그를 거치지 않음 — 사용자 명령으로만), 저장된 입력이 잘렸거나 마스킹된 step은 다른 로드에서 재실행 불가.
9. 파일 복구 ≠ 결정적 재현 — 스펙 §1 경계와 §9 v2 설계 요약.
10. 설정 — `storeDir`, `retentionDays`, `recordModelOutput`, `skipSearchBash` 표(기본값 포함).
11. 저장 형식 — `sessions/<id>/meta.json`, `<load>-<n>.jsonl` 레코드 종류(session/turn/step/model/branch), 입력 4 KiB·결과 2 KiB 자름과 마스킹.
12. 실행 환경 표 — 터미널/VS Code/`-p`.
13. 한계 — git 없거나 루트가 HOME·`/`이거나 베이스라인 5초 초과 시 스냅샷 꺼짐; 큰 저장소에선 변경성 도구마다 스냅샷 시간이 더해짐(상태줄에 평균); 백그라운드 Bash의 나중 변경은 다음 스냅샷에 붙음; 동시 도구 호출의 스냅샷 귀속은 근사; 테스트 파서가 모르는 형식은 종료 상태만; 사용자의 `.git/info/exclude`는 섀도 저장소에 적용되지 않음.
14. 개발 — `CLAUDE292` 테스트 명령, types 복사, tsc, validate; 단위 테스트는 가짜 git 러너로, 진짜 git은 E2E로.

- [ ] **Step 3: End-to-end run with real git (one process, stream-json input)**

Work in the scratchpad, never the repo:

```bash
S=/private/tmp/claude-501/-Users-ywsung-Desktop-my-claude-code-mods/09194f66-fade-4182-b75d-a2386b222d56/scratchpad/tm-e2e
rm -rf "$S" && mkdir -p "$S" && cd "$S"
cat > math.js <<'EOF'
exports.add = (a, b) => a + b
EOF
cat > math.test.js <<'EOF'
const test = require('node:test')
const assert = require('node:assert')
const { add } = require('./math.js')
test('adds', () => assert.equal(add(2, 2), 4))
EOF
printf 'node_modules/\n' > .gitignore
C="$CLAUDE292"
m() { printf '{"type":"user","message":{"role":"user","content":%s}}\n' "$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$1")"; }
{
  m "Read math.js. Then use the Edit tool to change 'a + b' to 'a - b' in math.js. Then run: node --test. Then use the Edit tool to change 'a - b' back to 'a + b'. Then run: node --test. Reply 'done'."
  m "/tm"
  m "/tm why"
  m "/tm restore 2"
  m "/tm restore 2 --yes"
} | "$C" -p --input-format stream-json --output-format stream-json --verbose \
    --plugin-dir /Users/ywsung/Desktop/my-claude-code-mods/time-machine --allowedTools Read,Edit,Bash > out.jsonl 2>&1
python3 - <<'PY'
import json
for line in open('out.jsonl'):
    try: d = json.loads(line)
    except Exception: continue
    if d.get('type') == 'result': print('RESULT:', str(d.get('result'))[:3000]); print('---')
PY
cat math.js
ls ~/.claude/time-machine/
```

Expected (record the actual output in the report):
- `/tm`: the tree with ① Read math.js, ② Edit math.js with a snapshot line `M math.js`, ③ Bash node --test with `✗ 1 failed`, ④ Edit math.js with a snapshot, ⑤ Bash node --test with `✓ … passed`; the header shows snapshots with an average time.
- `/tm why`: why ③ failed, suspect `math.js` (step ②), and `Fixed by: ④ Edit math.js → ⑤ …`.
- `/tm restore 2`: a dry-run plan listing `M math.js`.
- `/tm restore 2 --yes`: restored; `cat math.js` afterwards shows `a - b`.
- A project folder under `~/.claude/time-machine/` containing `shadow.git` and `sessions/<id>/`.

If any expectation fails, do not change mod code in this task: report DONE_WITH_CONCERNS with the evidence.

- [ ] **Step 4: Final checks and commit**

Run: `"$CLAUDE292" plugin test time-machine && npx -y -p typescript@5 tsc -p time-machine --noEmit && "$CLAUDE292" plugin validate time-machine && "$CLAUDE292" plugin validate .`
Expected: all pass.

```bash
git add .claude-plugin/marketplace.json README.md time-machine/README.md
git commit -m "docs(time-machine): README, marketplace entry and root listing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
