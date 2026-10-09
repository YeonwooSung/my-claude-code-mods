# Context Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod that records every row entering the context window and reports what occupies it, which reads repeat and why, which tool outputs are near-duplicates, what compaction kept, context growth per changed line, and rule-based advice — observe-only.

**Architecture:** A pure core (`hooks/core/`) holds a `Ledger` fed by pure `ingest*` functions, and pure analyses that fold a ledger snapshot into a `Summary`; a thin adapter (`hooks/register.tsx`) forwards engine events into the ingest functions, never changes what it relays, and renders the summary as a command's text, a status line and a pane. No raw content is stored: only sizes, hashes, SimHashes and targets.

**Tech Stack:** TypeScript mods API (types 2.1.292), `claude-code/testing` test runner, no dependencies.

**Spec:** `docs/superpowers/specs/2026-10-10-context-inspector-design.md` (§10 overrides earlier sections where they conflict).

## Global Constraints

- Mod folder: `context-inspector/` at the repo root (the repo is a marketplace; `agent-profiler/` sits beside it).
- Every hook relays `next(e)`'s result unchanged; the mod never rewrites rows, tool calls or compactions. All bookkeeping goes through `safe(...)` or try/catch.
- No raw text is stored in the ledger: only `chars`, `est`, `hash`, `simhash`, `target`.
- Token figures per item are estimates: `ceil(chars / 4)` plus 1,500 per image, scaled by calibration `k` clamped to [0.5, 2.0]; the report marks them `≈`.
- Item cap 20,000 (trim to 90% when exceeded: oldest non-live first, then oldest live). Hash input capped at 256 KiB (`HASH_CHARS = 262144`).
- Near-duplicate: SimHash Hamming distance ≤ 3, tool-result items with `chars >= 200` only. Documented as lexical, not semantic.
- Tests run with the 2.1.292 binary: `CLAUDE292=~/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude`, command `"$CLAUDE292" plugin test context-inspector` from the repo root. `session.append` cannot be raised in the test runner; the adapter's append path is covered through `ingestAppend` unit tests.
- Type check: `npx -y -p typescript@5 tsc -p context-inspector --noEmit` (types copied into the gitignored `context-inspector/.claude-plugin/types/`).
- Validate: `"$CLAUDE292" plugin validate context-inspector`.
- Imports inside the mod use explicit `.ts` extensions (as in agent-profiler).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A tool_result whose `content` is an array of blocks including images — text is joined, each image adds 1,500 estimated tokens (Task 1 `blockText` test, Task 2 ingest test).
2. A tool_result with no matching `tool.call` (backfill, unknown id) — recorded with no target, category from `origin.tool`, excluded from re-read analysis (Task 2 test).
3. A row re-appended with the same uuid after a compaction — revived, not duplicated (Task 2 test).
4. A compaction whose `next(e)` resolves `{ skip }`, or a `precompute` trigger — no ledger change, result returned unchanged (Task 2 unit test, Task 6 adapter test).
5. A file that grows between two whole-file Reads — classified `changed-externally`, never `different-range` (Task 3 test).

---

### Task 1: Scaffold and primitives

**Files:**
- Create: `context-inspector/.claude-plugin/plugin.json`
- Create: `context-inspector/hooks/hooks.json`
- Create: `context-inspector/hooks/register.tsx` (stub, replaced in Task 6)
- Create: `context-inspector/tsconfig.json`
- Modify: `.gitignore` (add one line)
- Create: `context-inspector/hooks/core/types.ts`
- Create: `context-inspector/hooks/core/format.ts`
- Create: `context-inspector/hooks/core/redact.ts`
- Create: `context-inspector/hooks/core/text.ts`
- Create: `context-inspector/hooks/core/hash.ts`
- Create: `context-inspector/hooks/core/tokens.ts`
- Create: `context-inspector/hooks/core/lines.ts`
- Test: `context-inspector/tests/primitives.test.ts`

**Interfaces:**
- Produces: `MAIN`, `Target`, `ContextItem`, `EditRec`, `Sample`, `Entity`, `EntityType`, `CompactionRec`, `Snapshot` (types.ts); `fmtCount`, `pct`, `clip`, `bar` (format.ts); `redactSecrets` (redact.ts); `HASH_CHARS`, `blockText(content): { text, images }`, `normalize(text)` (text.ts); `hash32(text, seed?)`, `contentHash(text): string /*16 hex*/`, `simhash64(normalized): string /*16 hex*/`, `hamming(a, b): number`, `bands(h): string[]` (hash.ts); `CHARS_PER_TOKEN`, `IMAGE_TOKENS`, `MIN_SEGMENT_EST`, `estimate(chars, images?)`, `inputOf(usage)`, `calibrate(samples, items): { k, segments }` (tokens.ts); `EDIT_TOOLS`, `diffLines(a, b)`, `changedLines(tool, input)` (lines.ts).

- [ ] **Step 1: Scaffold the mod**

`context-inspector/.claude-plugin/plugin.json`:

```json
{
  "name": "context-inspector",
  "version": "0.1.0",
  "description": "Context waste analyzer for Claude Code: what fills the window, re-reads, near-duplicate outputs, what compaction kept, advice",
  "author": { "name": "YeonwooSung" },
  "userConfig": {
    "outputDir": {
      "type": "string",
      "title": "Export directory",
      "description": "Where /context-export writes JSONL, one folder per session (empty: ~/.claude/context-inspector)",
      "default": ""
    },
    "toastAdvice": {
      "type": "boolean",
      "title": "Toast high-severity advice",
      "description": "Show one toast per session the first time a high-severity recommendation appears",
      "default": true
    }
  }
}
```

`context-inspector/hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

`context-inspector/hooks/register.tsx` (stub so the plugin loads; Task 6 replaces it):

```tsx
import type { Register } from 'claude-code'

export const register: Register = () => {}
```

`context-inspector/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "types": [],
    "module": "esnext",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "jsx": "react",
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment"
  },
  "include": [".claude-plugin/types", "hooks", "tests"]
}
```

Append to `.gitignore`:

```
context-inspector/.claude-plugin/types/
```

Copy the type declarations for tsc (gitignored, not committed):

```bash
cp -R agent-profiler/.claude-plugin/types context-inspector/.claude-plugin/types
```

- [ ] **Step 2: Write types.ts, format.ts, redact.ts**

`context-inspector/hooks/core/types.ts`:

```ts
// The main conversation's context key; a subagent's is its agentId.
export const MAIN = 'main'

export type TargetKind = 'file' | 'command' | 'pattern' | 'url' | 'agent'

export type Target = {
  kind: TargetKind
  value: string
  // Read only: 'offset:limit' from the call's input; absent for a whole-file read.
  range?: string
  // Read only: the result covered the whole file (startLine <= 1 and numLines >= totalLines).
  full?: boolean
}

export type ContextItem = {
  seq: number
  // Unique per item: the row uuid for a row's first item, '<row>#<n>' for its later ones.
  uuid: string
  row: string
  ctx: string
  turn: number
  door: string
  // The tool's name for a tool result, 'attachment:<name>' for attachments and hook context, else the door.
  category: string
  toolUseId?: string
  target?: Target
  chars: number
  est: number
  hash: string
  simhash?: string
  // The epoch the item arrived in, and the last epoch it was live in.
  born: number
  epoch: number
  live: boolean
  isError?: boolean
  // A Read the engine answered with "file unchanged" instead of the content.
  deduped?: boolean
  // File content the engine attached itself (a `file` attachment: an @-mention, or restored after compaction).
  attached?: boolean
  backfilled?: boolean
}

export type EditRec = { seq: number; ctx: string; turn: number; path: string; lines: number }

// One request's measured input: uncached + cache-written + cache-read tokens.
export type Sample = { seq: number; ctx: string; turn: number; epoch: number; input: number }

export type EntityType = 'edited-file' | 'read-file' | 'error' | 'requirement'
export type Entity = { type: EntityType; value: string; kept: boolean }

export type CompactionRec = {
  seq: number
  ctx: string
  turn: number
  trigger: string
  tokensBefore?: number
  tokensAfter?: number
  entities: Entity[]
  keptItems: number
  droppedItems: number
  droppedEst: number
}

export type Snapshot = {
  items: readonly ContextItem[]
  edits: readonly EditRec[]
  samples: readonly Sample[]
  compactions: readonly CompactionRec[]
  turn: number
  dropped: number
  droppedLive: number
}
```

`context-inspector/hooks/core/format.ts`:

```ts
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
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}
```

`context-inspector/hooks/core/redact.ts` (same rules as agent-profiler's):

```ts
// Best-effort removal of obvious secrets from command lines before they are exported.
const VALUE = String.raw`("[^"]*"|'[^']*'|[^\s'"]+)`
const RULES: [RegExp, string][] = [
  [/(\bauthorization\s*:\s*)[^'"\n]+/gi, '$1[REDACTED]'],
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [new RegExp(String.raw`(--password(?:=|\s+))` + VALUE, 'gi'), '$1[REDACTED]'],
  [/(\bmysql\w*\b[^\n;&|]*?\s-p)(?=\S)("[^"]*"|'[^']*'|\S+)/g, '$1[REDACTED]'],
  [new RegExp(String.raw`\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*)=` + VALUE, 'gi'), '$1=[REDACTED]'],
]

export function redactSecrets(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
}
```

- [ ] **Step 3: Write the failing primitives test**

`context-inspector/tests/primitives.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { bands, contentHash, hamming, hash32, simhash64 } from '../hooks/core/hash.ts'
import { changedLines, diffLines } from '../hooks/core/lines.ts'
import { blockText, normalize } from '../hooks/core/text.ts'
import { calibrate, estimate, inputOf } from '../hooks/core/tokens.ts'
import type { Sample } from '../hooks/core/types.ts'

const lettersText = (n: number): string =>
  Array.from({ length: n }, (_, i) => `q${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}x`).join(' ')
const okLines = (n: number): string => Array.from({ length: n }, (_, i) => `ok ${i} test case passed in the suite`).join('\n')

test('blockText joins text, tool results and tool inputs; images are counted apart', () => {
  const r = blockText([
    { type: 'text', text: 'hello' },
    { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'inner' }, { type: 'image', source: {} }] },
    { type: 'tool_use', id: 'u', name: 'Read', input: { file_path: '/a' } },
    { type: 'thinking', thinking: '', signature: 'zzz' },
  ])
  expect(r.text).toBe('hello\ninner\nRead {"file_path":"/a"}')
  expect(r.images).toBe(1)
  expect(blockText('plain').text).toBe('plain')
  expect(blockText([]).text).toBe('')
})

test('normalize folds case, spacing and digit runs', () => {
  expect(normalize('  Ran 12 tests\n\tin 3.5s ')).toBe('ran # tests in #.#s')
})

test('hash32 and contentHash are deterministic and seed-dependent', () => {
  expect(hash32('abc')).toBe(hash32('abc'))
  expect(hash32('abc', 1)).not.toBe(hash32('abc', 2))
  expect(contentHash('abc')).toMatch(/^[0-9a-f]{16}$/)
  expect(contentHash('abc')).not.toBe(contentHash('abd'))
})

test('simhash: identical after normalization is distance 0; unrelated text is far', () => {
  const a = simhash64(normalize(`${okLines(80)}\nTime: 1.23s`))
  const b = simhash64(normalize(`${okLines(80)}\nTime: 4.56s`))
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(hamming(a, b)).toBe(0)
  const c = simhash64(normalize(lettersText(300)))
  expect(hamming(a, c)).toBeGreaterThan(3)
})

test('hamming counts differing bits; bands split 16 bits each and are position-tagged', () => {
  expect(hamming('0000000000000000', '0000000000000007')).toBe(3)
  expect(hamming('ffffffff00000000', '0000000000000000')).toBe(32)
  expect(bands('0123456789abcdef')).toEqual(['0:0123', '4:4567', '8:89ab', '12:cdef'])
})

test('estimate and inputOf', () => {
  expect(estimate(0)).toBe(0)
  expect(estimate(9)).toBe(3)
  expect(estimate(4, 2)).toBe(3_001)
  expect(inputOf({ input_tokens: 2, cache_read_input_tokens: 19_834, cache_creation_input_tokens: 25_350, output_tokens: 9 })).toBe(45_186)
  expect(inputOf(undefined)).toBe(0)
})

const sample = (seq: number, input: number, epoch = 0, ctx = 'main'): Sample => ({ seq, ctx, turn: 1, epoch, input })

test('calibrate telescopes per context and epoch, skips thin segments, clamps', () => {
  const items = [
    { ctx: 'main', seq: 2, est: 1_500 },
    { ctx: 'main', seq: 3, est: 1_500 },
    { ctx: 'main', seq: 6, est: 900 },
  ]
  // main epoch 0: samples at 1 and 4 → growth 3,300 over est 3,000 → k 1.1
  expect(calibrate([sample(1, 10_000), sample(4, 13_300)], items)).toEqual({ k: 1.1, segments: 1 })
  // a segment whose items sum under 2,000 is skipped → no calibration
  expect(calibrate([sample(5, 10_000), sample(7, 11_000)], items)).toEqual({ k: 1, segments: 0 })
  // clamped to 2
  expect(calibrate([sample(1, 10_000), sample(4, 30_000)], items).k).toBe(2)
  // different epochs never pair
  expect(calibrate([sample(1, 10_000, 0), sample(4, 13_300, 1)], items).segments).toBe(0)
})

test('diffLines drops shared head and tail lines', () => {
  expect(diffLines('a\nb\nc', 'a\nB\nc')).toBe(2)
  expect(diffLines('', 'x\ny')).toBe(2)
  expect(diffLines('same', 'same')).toBe(0)
})

test('changedLines per edit tool', () => {
  expect(changedLines('Edit', { old_string: 'a\nb', new_string: 'a\nc\nd' })).toBe(3)
  expect(changedLines('MultiEdit', { edits: [{ old_string: 'x', new_string: 'y' }, { old_string: '', new_string: 'z' }] })).toBe(3)
  expect(changedLines('Write', { content: 'one\ntwo\n' })).toBe(2)
  expect(changedLines('NotebookEdit', { new_source: 'print(1)' })).toBe(1)
  expect(changedLines('Read', {})).toBe(0)
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `"$CLAUDE292" plugin test context-inspector`
Expected: FAIL — modules `../hooks/core/hash.ts` etc. not found.

- [ ] **Step 5: Implement text.ts, hash.ts, tokens.ts, lines.ts**

`context-inspector/hooks/core/text.ts`:

```ts
// Hashes read at most this much of a row; character counts still cover all of it.
export const HASH_CHARS = 256 * 1024

export type Extracted = { text: string; images: number }

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

// What the model reads from a row's blocks: text, tool inputs and results; images and documents counted apart.
export function blockText(content: unknown): Extracted {
  const parts: string[] = []
  let images = 0
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value !== '') parts.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v)
      return
    }
    if (!value || typeof value !== 'object') return
    const block = value as Record<string, unknown>
    switch (block.type) {
      case 'text':
        walk(block.text)
        return
      case 'tool_result':
        walk(block.content)
        return
      case 'tool_use':
        parts.push(`${String(block.name ?? '')} ${safeJson(block.input)}`)
        return
      case 'thinking':
        walk(block.thinking)
        return
      case 'image':
      case 'document':
        images += 1
        return
      default:
        return
    }
  }
  walk(content)
  return { text: parts.join('\n'), images }
}

// For similarity only: case and spacing folded, digit runs as '#', so runs differing in timings or counts match.
export function normalize(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
}
```

`context-inspector/hooks/core/hash.ts`:

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

const MAX_WORDS = 20_000

// 64-bit SimHash over word 3-shingles of normalized text: near-identical texts land a few bits apart.
// Lexical locality-sensitive hashing, not semantic similarity.
export function simhash64(normalized: string): string {
  const words = normalized.split(' ').filter(w => w !== '').slice(0, MAX_WORDS)
  const counts = new Int32Array(64)
  const shingles = Math.max(1, words.length - 2)
  for (let i = 0; i < shingles; i += 1) {
    const shingle = words.slice(i, i + 3).join(' ')
    const hi = hash32(shingle, 1)
    const lo = hash32(shingle, 2)
    for (let b = 0; b < 32; b += 1) {
      counts[b]! += (hi >>> b) & 1 ? 1 : -1
      counts[b + 32]! += (lo >>> b) & 1 ? 1 : -1
    }
  }
  let hi = 0
  let lo = 0
  for (let b = 0; b < 32; b += 1) {
    if (counts[b]! > 0) hi |= 1 << b
    if (counts[b + 32]! > 0) lo |= 1 << b
  }
  return hex(hi) + hex(lo)
}

function popcount(n: number): number {
  let x = n - ((n >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24
}

export function hamming(a: string, b: string): number {
  const hi = (parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0
  const lo = (parseInt(a.slice(8, 16), 16) ^ parseInt(b.slice(8, 16), 16)) >>> 0
  return popcount(hi) + popcount(lo)
}

// Four 16-bit bands, tagged by position: two hashes within 3 bits of each other agree on at least one.
export function bands(h: string): string[] {
  return [0, 4, 8, 12].map(i => `${i}:${h.slice(i, i + 4)}`)
}
```

`context-inspector/hooks/core/tokens.ts`:

```ts
import type { ContextItem, Sample } from './types.ts'

export const CHARS_PER_TOKEN = 4
export const IMAGE_TOKENS = 1_500
// A calibration segment counts only when its items add up to at least this many estimated tokens.
export const MIN_SEGMENT_EST = 2_000

export function estimate(chars: number, images = 0): number {
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS
}

// What a request was answered over: uncached, cache-written and cache-read input together.
export function inputOf(usage: unknown): number {
  const u = (usage ?? {}) as Record<string, unknown>
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
}

export type Calibration = { k: number; segments: number }

// Per context and epoch, the measured growth between its first and last request over the estimated
// tokens of the items that arrived in between. Telescoping makes the order of rows and stop chunks
// inside the segment irrelevant.
export function calibrate(samples: readonly Sample[], items: readonly Pick<ContextItem, 'ctx' | 'seq' | 'est'>[]): Calibration {
  const spans = new Map<string, { a: Sample; b: Sample }>()
  for (const s of samples) {
    const key = `${s.ctx}\u0000${s.epoch}`
    const span = spans.get(key)
    if (!span) spans.set(key, { a: s, b: s })
    else span.b = s
  }
  let growth = 0
  let est = 0
  let segments = 0
  for (const { a, b } of spans.values()) {
    if (b.seq === a.seq || b.input <= a.input) continue
    let sum = 0
    for (const item of items) if (item.ctx === a.ctx && item.seq > a.seq && item.seq <= b.seq) sum += item.est
    if (sum < MIN_SEGMENT_EST) continue
    growth += b.input - a.input
    est += sum
    segments += 1
  }
  if (segments === 0) return { k: 1, segments: 0 }
  return { k: Math.min(2, Math.max(0.5, growth / est)), segments }
}
```

`context-inspector/hooks/core/lines.ts`:

```ts
export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
}

// Lines removed plus lines added, after the lines both sides share at the start and at the end.
export function diffLines(before: string, after: string): number {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1
  return a.length - head - tail + (b.length - head - tail)
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function changedLines(tool: string, input: Record<string, unknown>): number {
  switch (tool) {
    case 'Edit':
      return diffLines(str(input.old_string), str(input.new_string))
    case 'MultiEdit':
      if (!Array.isArray(input.edits)) return 0
      return input.edits.reduce((sum: number, edit: unknown) => {
        const e = (edit ?? {}) as Record<string, unknown>
        return sum + diffLines(str(e.old_string), str(e.new_string))
      }, 0)
    case 'Write':
      return lineCount(str(input.content))
    case 'NotebookEdit':
      return lineCount(str(input.new_source))
    default:
      return 0
  }
}
```

- [ ] **Step 6: Run the tests, type check, validate**

Run: `"$CLAUDE292" plugin test context-inspector && npx -y -p typescript@5 tsc -p context-inspector --noEmit && "$CLAUDE292" plugin validate context-inspector`
Expected: all primitives tests PASS; tsc prints nothing; validate passes.

- [ ] **Step 7: Commit**

```bash
git add .gitignore context-inspector
git commit -m "feat(context-inspector): scaffold and hashing, token and line primitives

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Ledger, entities and ingestion

**Files:**
- Create: `context-inspector/hooks/core/ledger.ts`
- Create: `context-inspector/hooks/core/entities.ts`
- Create: `context-inspector/hooks/core/ingest.ts`
- Create: `context-inspector/tests/fixtures.ts`
- Test: `context-inspector/tests/ingest.test.ts`

**Interfaces:**
- Consumes (Task 1): types.ts, `blockText`, `normalize`, `HASH_CHARS`, `contentHash`, `simhash64`, `estimate`, `EDIT_TOOLS`, `changedLines`.
- Produces:
  - `class Ledger(maxItems = 20_000)` with `version`, `turn`, `dropped`, `droppedLive`, `size`, `epochOf(ctx)`, `nextTurn()`, `revive(row): boolean`, `toolStart(id, ToolInfo)`, `tool(id)`, `toolEnd(id, outcome)`, `forgetTool(id)`, `add(NewItem): ContextItem`, `edit(ctx, path, lines)`, `sample(ctx, input)`, `compacted(ctx, keptRows, keptTools, rec)`, `markBackfilled()`, `snapshot(): Snapshot`.
  - `type ToolInfo = { tool; ctx; target?; lines?; deduped?; isError? }`, `type NewItem = Omit<ContextItem, 'seq' | 'turn' | 'born' | 'epoch' | 'live'>`.
  - entities.ts: `type MessageLike`, `extractEntities(messages)`, `flattenMessages(messages)`, `isMentioned(text, entity)`.
  - ingest.ts: `type AppendLike`, `targetOf(tool, input)`, `ingestToolCall(l, id, tool, agentId, input)`, `ingestToolResult(l, id, answer)`, `ingestAppend(l, e)`, `ingestCompaction(l, e, r)`, `backfill(l, messages)`, `type CompactIn`, `type CompactOut`.
  - fixtures.ts: `toolResultRow`, `promptRow`, `attachmentRow`, `readFile`, `editFile`, `runBash`, `okLines`, `letters`.

- [ ] **Step 1: Write ledger.ts**

`context-inspector/hooks/core/ledger.ts`:

```ts
import type { CompactionRec, ContextItem, EditRec, Sample, Snapshot, Target } from './types.ts'

export type ToolInfo = {
  tool: string
  ctx: string
  target?: Target
  // Lines an edit tool changes, counted from its input; recorded once the call succeeds.
  lines?: number
  deduped?: boolean
  isError?: boolean
}

export type ToolOutcome = { deduped?: boolean; isError?: boolean; full?: boolean }

export type NewItem = Omit<ContextItem, 'seq' | 'turn' | 'born' | 'epoch' | 'live'>

const MAX_TOOLS = 2_000

export class Ledger {
  version = 0
  turn = 0
  dropped = 0
  droppedLive = 0
  // One counter orders items, edits, samples and compactions.
  private seq = 0
  private items: ContextItem[] = []
  private byUuid = new Map<string, ContextItem>()
  private edits: EditRec[] = []
  private samples: Sample[] = []
  private compactions: CompactionRec[] = []
  private epochs = new Map<string, number>()
  private tools = new Map<string, ToolInfo>()

  constructor(readonly maxItems = 20_000) {}

  get size(): number {
    return this.items.length
  }

  epochOf(ctx: string): number {
    return this.epochs.get(ctx) ?? 0
  }

  nextTurn(): void {
    this.turn += 1
    this.version += 1
  }

  // A row the engine appends again (after a compaction) is live once more, in the current epoch.
  revive(row: string): boolean {
    let item = this.byUuid.get(row)
    if (!item) return false
    for (let n = 1; item; n += 1) {
      item.live = true
      item.epoch = this.epochOf(item.ctx)
      item = this.byUuid.get(`${row}#${n}`)
    }
    this.version += 1
    return true
  }

  toolStart(id: string, info: ToolInfo): void {
    this.tools.set(id, info)
    if (this.tools.size > MAX_TOOLS) {
      const oldest = this.tools.keys().next().value
      if (oldest !== undefined) this.tools.delete(oldest)
    }
  }

  tool(id: string): ToolInfo | undefined {
    return this.tools.get(id)
  }

  // The call's result is known: a Read learns whether it was whole or deduplicated; an edit that went through counts.
  toolEnd(id: string, outcome: ToolOutcome): void {
    const info = this.tools.get(id)
    if (!info) return
    info.deduped = outcome.deduped
    info.isError = outcome.isError
    if (info.target && outcome.full !== undefined) info.target = { ...info.target, full: outcome.full }
    if (!outcome.isError && info.lines !== undefined && info.target?.kind === 'file') this.edit(info.ctx, info.target.value, info.lines)
  }

  forgetTool(id: string): void {
    this.tools.delete(id)
  }

  add(item: NewItem): ContextItem {
    this.seq += 1
    const epoch = this.epochOf(item.ctx)
    const full: ContextItem = { ...item, seq: this.seq, turn: this.turn, born: epoch, epoch, live: true }
    this.items.push(full)
    this.byUuid.set(full.uuid, full)
    this.version += 1
    if (this.items.length > this.maxItems) this.trim()
    return full
  }

  edit(ctx: string, path: string, lines: number): void {
    this.seq += 1
    this.edits.push({ seq: this.seq, ctx, turn: this.turn, path, lines })
    if (this.edits.length > this.maxItems) this.edits.splice(0, this.edits.length - this.maxItems)
    this.version += 1
  }

  sample(ctx: string, input: number): void {
    if (!Number.isFinite(input) || input <= 0) return
    this.seq += 1
    this.samples.push({ seq: this.seq, ctx, turn: this.turn, epoch: this.epochOf(ctx), input })
    if (this.samples.length > this.maxItems) this.samples.splice(0, this.samples.length - this.maxItems)
    this.version += 1
  }

  // Live items of `ctx` that neither sit in a kept row nor answer a kept tool call leave the window.
  compacted(
    ctx: string,
    keptRows: ReadonlySet<string>,
    keptTools: ReadonlySet<string>,
    rec: Pick<CompactionRec, 'trigger' | 'tokensBefore' | 'tokensAfter' | 'entities'>,
  ): CompactionRec {
    const epoch = this.epochOf(ctx) + 1
    this.epochs.set(ctx, epoch)
    let keptItems = 0
    let droppedItems = 0
    let droppedEst = 0
    for (const item of this.items) {
      if (item.ctx !== ctx || !item.live) continue
      if (keptRows.has(item.row) || (item.toolUseId !== undefined && keptTools.has(item.toolUseId))) {
        item.epoch = epoch
        keptItems += 1
      } else {
        item.live = false
        droppedItems += 1
        droppedEst += item.est
      }
    }
    this.seq += 1
    const full: CompactionRec = { ...rec, seq: this.seq, ctx, turn: this.turn, keptItems, droppedItems, droppedEst }
    this.compactions.push(full)
    this.version += 1
    return full
  }

  markBackfilled(): void {
    for (const item of this.items) item.backfilled = true
    this.version += 1
  }

  snapshot(): Snapshot {
    return {
      items: this.items,
      edits: this.edits,
      samples: this.samples,
      compactions: this.compactions,
      turn: this.turn,
      dropped: this.dropped,
      droppedLive: this.droppedLive,
    }
  }

  // Down to 90% of the cap: the oldest items already out of the window first, then the oldest live ones.
  private trim(): void {
    let excess = this.items.length - Math.floor(this.maxItems * 0.9)
    const keep: ContextItem[] = []
    for (const item of this.items) {
      if (excess > 0 && !item.live) {
        this.byUuid.delete(item.uuid)
        this.dropped += 1
        excess -= 1
      } else {
        keep.push(item)
      }
    }
    if (excess > 0) {
      for (const item of keep.splice(0, excess)) {
        this.byUuid.delete(item.uuid)
        this.droppedLive += 1
      }
    }
    this.items = keep
  }
}
```

- [ ] **Step 2: Write entities.ts**

`context-inspector/hooks/core/entities.ts`:

```ts
import { EDIT_TOOLS } from './lines.ts'
import type { Entity, EntityType } from './types.ts'

// One message as `session.compact` and `$.session.messages()` hand it over.
export type MessageLike = {
  role: string
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string; isError?: boolean }[]
  toolResults?: readonly { tool_use_id: string; text: string; isError: boolean }[]
  handle?: string
}

export type Found = Omit<Entity, 'kept'>

const MAX_ERRORS = 20
const MAX_REQUIREMENTS = 50
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const BACKTICK = /`([^`\n]{4,80})`/g
const PATH = /(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w+|\b[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|kt|rb|md|json|ya?ml|toml|sh|c|cc|cpp|h|hpp|css|html|sql)\b/g
const IDENT = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g

const pathOf = (input: Record<string, unknown>): string | undefined =>
  typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : undefined

function errorLine(text: string): string {
  const line = text
    .replace(/<\/?tool_use_error>/g, '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l !== '')
  return (line ?? '').slice(0, 120)
}

// What a compaction should keep: edited files, other files read, tool errors, identifiers the user typed.
export function extractEntities(messages: readonly MessageLike[]): Found[] {
  const out: Found[] = []
  const seen = new Set<string>()
  const add = (type: EntityType, value: string): boolean => {
    const key = `${type}\u0000${value}`
    if (value === '' || seen.has(key)) return false
    seen.add(key)
    out.push({ type, value })
    return true
  }
  const edited = new Set<string>()
  for (const m of messages)
    for (const u of m.toolUses) {
      const path = pathOf(u.input)
      if (path && EDIT_TOOLS.has(u.tool) && !u.isError) edited.add(path)
    }
  for (const path of edited) add('edited-file', path)
  for (const m of messages)
    for (const u of m.toolUses) {
      const path = pathOf(u.input)
      if (u.tool === 'Read' && path && !edited.has(path)) add('read-file', path)
    }
  let errors = 0
  for (const m of messages) {
    const failed = [
      ...(m.toolResults ?? []).filter(r => r.isError).map(r => r.text),
      ...m.toolUses.flatMap(u => (u.isError && u.text ? [u.text] : [])),
    ]
    for (const text of failed) if (errors < MAX_ERRORS && add('error', errorLine(text))) errors += 1
  }
  let requirements = 0
  for (const m of messages) {
    if (m.role !== 'user' || (m.toolResults?.length ?? 0) > 0) continue
    const text = m.text.replace(REMINDER, ' ')
    for (const re of [BACKTICK, PATH, IDENT])
      for (const match of text.matchAll(re)) {
        const value = (match[1] ?? match[0]).trim()
        if (requirements < MAX_REQUIREMENTS && value.length >= 4 && add('requirement', value)) requirements += 1
      }
  }
  return out
}

// Everything the model will read after the compaction, as one string to search.
export function flattenMessages(messages: readonly MessageLike[]): string {
  const parts: string[] = []
  for (const m of messages) {
    parts.push(m.text)
    for (const u of m.toolUses) {
      parts.push(JSON.stringify(u.input) ?? '')
      if (u.text) parts.push(u.text)
    }
    for (const r of m.toolResults ?? []) parts.push(r.text)
  }
  return parts.join('\n')
}

const basename = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

// A file counts as kept when its path or its base name appears; an error by its first 40 characters.
export function isMentioned(text: string, entity: Found): boolean {
  switch (entity.type) {
    case 'edited-file':
    case 'read-file':
      return text.includes(entity.value) || text.includes(basename(entity.value))
    case 'error':
      return text.includes(entity.value.slice(0, 40))
    case 'requirement':
      return text.includes(entity.value)
  }
}
```

- [ ] **Step 3: Write ingest.ts**

`context-inspector/hooks/core/ingest.ts`:

```ts
import { extractEntities, flattenMessages, isMentioned, type MessageLike } from './entities.ts'
import { contentHash, simhash64 } from './hash.ts'
import { Ledger, type ToolInfo } from './ledger.ts'
import { changedLines, EDIT_TOOLS } from './lines.ts'
import { blockText, HASH_CHARS, normalize } from './text.ts'
import { estimate } from './tokens.ts'
import { MAIN, type Target } from './types.ts'

// The parts of a `session.append` input the ledger reads.
export type AppendLike = {
  door: string
  uuid: string
  agentId?: string
  origin?: { kind: string; tool?: string }
  message: { type: string; name?: string; role?: string; content: unknown }
}

export type CompactIn = { trigger: string; agentId?: string; messages: readonly MessageLike[] }
export type CompactOut = { messages?: readonly MessageLike[]; tokensBefore?: number; tokensAfter?: number; skip?: string }

const SIMHASH_MIN_CHARS = 200
const FILE_ATTACHMENT = /"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string
  } catch {
    return s
  }
}

export function targetOf(tool: string, input: Record<string, unknown>): Target | undefined {
  switch (tool) {
    case 'Read': {
      const path = str(input.file_path)
      if (!path) return undefined
      const offset = typeof input.offset === 'number' ? input.offset : undefined
      const limit = typeof input.limit === 'number' ? input.limit : undefined
      if (offset === undefined && limit === undefined) return { kind: 'file', value: path }
      return { kind: 'file', value: path, range: `${offset ?? 1}:${limit ?? 'all'}` }
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const path = str(input.file_path)
      return path ? { kind: 'file', value: path } : undefined
    }
    case 'NotebookEdit': {
      const path = str(input.notebook_path)
      return path ? { kind: 'file', value: path } : undefined
    }
    case 'Bash': {
      const command = str(input.command)
      return command ? { kind: 'command', value: command } : undefined
    }
    case 'Grep':
    case 'Glob': {
      const pattern = str(input.pattern)
      if (!pattern) return undefined
      const where = str(input.path)
      return { kind: 'pattern', value: where ? `${pattern} in ${where}` : pattern }
    }
    case 'WebFetch': {
      const url = str(input.url)
      return url ? { kind: 'url', value: url } : undefined
    }
    case 'WebSearch': {
      const query = str(input.query)
      return query ? { kind: 'pattern', value: query } : undefined
    }
    case 'Agent':
    case 'Task': {
      const agent = str(input.subagent_type) ?? str(input.description)
      return agent ? { kind: 'agent', value: agent } : undefined
    }
    default:
      return undefined
  }
}

// Before the call runs: what it targets and, for an edit, how many lines it changes.
export function ingestToolCall(l: Ledger, id: string, tool: string, agentId: string | undefined, input: Record<string, unknown>): void {
  const info: ToolInfo = { tool, ctx: agentId ?? MAIN, target: targetOf(tool, input) }
  if (EDIT_TOOLS.has(tool)) info.lines = changedLines(tool, input)
  l.toolStart(id, info)
}

// After the call: an engine-deduplicated Read, whether a Read was whole, an error or a deny.
export function ingestToolResult(l: Ledger, id: string, answer: unknown): void {
  const a = (answer ?? {}) as Record<string, unknown>
  const result = (a.result ?? {}) as Record<string, unknown>
  const file = (result.file ?? {}) as Record<string, unknown>
  const { startLine, numLines, totalLines } = file
  const full =
    typeof startLine === 'number' && typeof numLines === 'number' && typeof totalLines === 'number'
      ? startLine <= 1 && numLines >= totalLines
      : undefined
  l.toolEnd(id, {
    deduped: result.type === 'file_unchanged',
    isError: a.isError === true || typeof a.deny === 'string',
    full,
  })
}

function measure(text: string, images: number, tool: boolean): { chars: number; est: number; hash: string; simhash?: string } {
  const cut = text.length > HASH_CHARS ? text.slice(0, HASH_CHARS) : text
  return {
    chars: text.length,
    est: estimate(text.length, images),
    hash: contentHash(cut),
    simhash: tool && text.length >= SIMHASH_MIN_CHARS ? simhash64(normalize(cut)) : undefined,
  }
}

// One row entering a conversation: one item per tool_result block, one for the rest of the row.
export function ingestAppend(l: Ledger, e: AppendLike): void {
  if (e.message.role === undefined) return // a notice or a record no request carries
  if (l.revive(e.uuid)) return // re-appended after a compaction
  const ctx = e.agentId ?? MAIN
  if (ctx === MAIN && e.door === 'prompt') l.nextTurn()
  const blocks: unknown[] = Array.isArray(e.message.content) ? e.message.content : [e.message.content]
  let made = 0
  const nextUuid = (): string => {
    made += 1
    return made === 1 ? e.uuid : `${e.uuid}#${made - 1}`
  }
  const rest: unknown[] = []
  for (const raw of blocks) {
    const block = (raw ?? {}) as Record<string, unknown>
    if (block.type !== 'tool_result') {
      rest.push(raw)
      continue
    }
    const id = str(block.tool_use_id)
    const info = id ? l.tool(id) : undefined
    const { text, images } = blockText(block.content)
    if (id) l.forgetTool(id)
    if (text === '' && images === 0) continue
    l.add({
      uuid: nextUuid(),
      row: e.uuid,
      ctx,
      door: e.door,
      category: info?.tool ?? e.origin?.tool ?? 'tool',
      toolUseId: id,
      target: info?.target,
      ...measure(text, images, true),
      isError: block.is_error === true || info?.isError === true || undefined,
      deduped: info?.deduped || undefined,
    })
  }
  const { text, images } = blockText(rest)
  if (text === '' && images === 0) return
  const attachment = e.message.type === 'attachment'
  const name = e.message.name ?? 'unknown'
  const filePath = attachment && name === 'file' ? FILE_ATTACHMENT.exec(text)?.[1] : undefined
  l.add({
    uuid: nextUuid(),
    row: e.uuid,
    ctx,
    door: e.door,
    category: attachment ? `attachment:${name}` : e.door,
    target: filePath ? { kind: 'file', value: unescapeJson(filePath) } : undefined,
    ...measure(text, images, false),
    attached: filePath ? true : undefined,
  })
}

// A compaction that stands: which items stay in the window, and which entities the result still mentions.
export function ingestCompaction(l: Ledger, e: CompactIn, r: CompactOut): void {
  if (e.trigger === 'precompute' || typeof r.skip === 'string' || !r.messages) return
  const before = new Set(e.messages.flatMap(m => (typeof m.handle === 'string' ? [m.handle] : [])))
  const keptRows = new Set<string>()
  const keptTools = new Set<string>()
  for (const m of r.messages) {
    // The summary carries a handle too, but not one of the messages it replaced.
    if (m.handle === undefined || !before.has(m.handle)) continue
    keptRows.add(m.handle)
    for (const u of m.toolUses) keptTools.add(u.tool_use_id)
    for (const t of m.toolResults ?? []) keptTools.add(t.tool_use_id)
  }
  const after = flattenMessages(r.messages)
  const entities = extractEntities(e.messages).map(found => ({ ...found, kept: isMentioned(after, found) }))
  l.compacted(e.agentId ?? MAIN, keptRows, keptTools, { trigger: e.trigger, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter, entities })
}

// After a reload or resume: what the main conversation already holds (no attachments, no timing).
export function backfill(l: Ledger, messages: readonly MessageLike[]): void {
  messages.forEach((m, i) => {
    const row = `backfill-${i}`
    if (m.role === 'assistant') {
      for (const u of m.toolUses) {
        ingestToolCall(l, u.tool_use_id, u.tool, undefined, u.input)
        ingestToolResult(l, u.tool_use_id, { isError: u.isError === true, result: (u as { result?: unknown }).result })
      }
      const content = [{ type: 'text', text: m.text }, ...m.toolUses.map(u => ({ type: 'tool_use', name: u.tool, input: u.input }))]
      ingestAppend(l, { door: 'response', uuid: row, message: { type: 'assistant', role: 'assistant', content } })
    } else if ((m.toolResults?.length ?? 0) > 0) {
      const content = (m.toolResults ?? []).map(t => ({ type: 'tool_result', tool_use_id: t.tool_use_id, content: t.text, is_error: t.isError }))
      ingestAppend(l, { door: 'tool-result', uuid: row, message: { type: 'user', role: 'user', content } })
    } else {
      ingestAppend(l, { door: 'prompt', uuid: row, message: { type: 'user', role: 'user', content: m.text } })
    }
  })
  l.markBackfilled()
}
```

- [ ] **Step 4: Write the fixtures**

`context-inspector/tests/fixtures.ts`:

```ts
import { ingestAppend, ingestToolCall, ingestToolResult, type AppendLike } from '../hooks/core/ingest.ts'
import type { Ledger } from '../hooks/core/ledger.ts'

let rows = 0
const nextRow = (): string => `row-${(rows += 1)}`

export const okLines = (n: number, word = 'ok'): string =>
  Array.from({ length: n }, (_, i) => `${word} ${i} test case passed in the suite`).join('\n')

// Unrelated words: far from okLines in SimHash space.
export const letters = (n: number): string =>
  Array.from({ length: n }, (_, i) => `q${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))}x`).join(' ')

export function toolResultRow(id: string, text: string, o: { agentId?: string; tool?: string; isError?: boolean; uuid?: string } = {}): AppendLike {
  return {
    door: 'tool-result',
    uuid: o.uuid ?? nextRow(),
    agentId: o.agentId,
    origin: { kind: 'tool', tool: o.tool ?? 'Read' },
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, ...(o.isError ? { is_error: true } : {}) }] },
  }
}

export function promptRow(text: string, uuid = nextRow()): AppendLike {
  return { door: 'prompt', uuid, origin: { kind: 'unclassified' }, message: { type: 'user', role: 'user', content: [{ type: 'text', text }] } }
}

export function attachmentRow(name: string, text: string, uuid = nextRow()): AppendLike {
  return { door: 'attachment', uuid, origin: { kind: 'engine' }, message: { type: 'attachment', name, role: 'user', content: [{ type: 'text', text }] } }
}

const UNCHANGED = 'Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.'

export function readFile(
  l: Ledger,
  id: string,
  path: string,
  text: string,
  o: { offset?: number; limit?: number; unchanged?: boolean; agentId?: string; total?: number; uuid?: string } = {},
): void {
  const input: Record<string, unknown> = { file_path: path }
  if (o.offset !== undefined) input.offset = o.offset
  if (o.limit !== undefined) input.limit = o.limit
  ingestToolCall(l, id, 'Read', o.agentId, input)
  const numLines = text.split('\n').length
  ingestToolResult(
    l,
    id,
    o.unchanged
      ? { result: { type: 'file_unchanged', file: { filePath: path } }, text: UNCHANGED }
      : { result: { type: 'text', file: { filePath: path, startLine: o.offset ?? 1, numLines, totalLines: o.total ?? numLines } }, text },
  )
  ingestAppend(l, toolResultRow(id, o.unchanged ? UNCHANGED : text, { agentId: o.agentId, uuid: o.uuid }))
}

export function editFile(l: Ledger, id: string, path: string, before: string, after: string, agentId?: string): void {
  ingestToolCall(l, id, 'Edit', agentId, { file_path: path, old_string: before, new_string: after })
  ingestToolResult(l, id, { result: {}, text: 'The file has been updated.' })
  ingestAppend(l, toolResultRow(id, 'The file has been updated.', { tool: 'Edit', agentId }))
}

export function runBash(l: Ledger, id: string, command: string, output: string, agentId?: string): void {
  ingestToolCall(l, id, 'Bash', agentId, { command })
  ingestToolResult(l, id, { result: { stdout: output }, text: output })
  ingestAppend(l, toolResultRow(id, output, { tool: 'Bash', agentId }))
}
```

- [ ] **Step 5: Write the failing ingest test**

`context-inspector/tests/ingest.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { extractEntities, isMentioned, type MessageLike } from '../hooks/core/entities.ts'
import { backfill, ingestAppend, ingestCompaction } from '../hooks/core/ingest.ts'
import { Ledger } from '../hooks/core/ledger.ts'
import { attachmentRow, editFile, okLines, promptRow, readFile, runBash, toolResultRow } from './fixtures.ts'

test('a Read becomes one item joined to its call: category, target, size, whole-file flag', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('fix the bug'))
  readFile(l, 't1', '/src/a.ts', okLines(10))
  const items = l.snapshot().items
  expect(items.length).toBe(2)
  const read = items[1]!
  expect(read.category).toBe('Read')
  expect(read.door).toBe('tool-result')
  expect(read.toolUseId).toBe('t1')
  expect(read.target).toEqual({ kind: 'file', value: '/src/a.ts', full: true })
  expect(read.est).toBe(Math.ceil(okLines(10).length / 4))
  expect(read.simhash).toMatch(/^[0-9a-f]{16}$/)
  expect(read.turn).toBe(1)
  expect(read.live).toBe(true)
})

test('offset/limit become the range key; a partial result is not whole', () => {
  const l = new Ledger()
  readFile(l, 't1', '/a', okLines(5), { offset: 10, limit: 5, total: 100 })
  expect(l.snapshot().items[0]!.target).toEqual({ kind: 'file', value: '/a', range: '10:5', full: false })
})

test('an engine-deduplicated Read is flagged', () => {
  const l = new Ledger()
  readFile(l, 't1', '/a', okLines(5))
  readFile(l, 't2', '/a', '', { unchanged: true })
  expect(l.snapshot().items[1]!.deduped).toBe(true)
})

test('a result with no recorded call keeps origin.tool and no target', () => {
  const l = new Ledger()
  ingestAppend(l, toolResultRow('unknown', 'some output', { tool: 'Grep' }))
  const item = l.snapshot().items[0]!
  expect(item.category).toBe('Grep')
  expect(item.target).toBeUndefined()
})

test('images in a tool result add 1,500 estimated tokens each', () => {
  const l = new Ledger()
  ingestAppend(l, {
    door: 'tool-result',
    uuid: 'r1',
    origin: { kind: 'tool', tool: 'Read' },
    message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'abcd' }, { type: 'image', source: {} }] }] },
  })
  expect(l.snapshot().items[0]!.est).toBe(1 + 1_500)
})

test('rows without a role, and empty rows, make no items', () => {
  const l = new Ledger()
  ingestAppend(l, { door: 'notice', uuid: 'n', message: { type: 'system', name: 'compact_boundary', content: [{ type: 'text', text: 'x' }] } })
  ingestAppend(l, attachmentRow('credential_org', ''))
  expect(l.size).toBe(0)
})

test('attachments are categorized by name; a file attachment carries its path and is marked attached', () => {
  const l = new Ledger()
  ingestAppend(l, attachmentRow('skill_listing', 'skills…'))
  ingestAppend(l, attachmentRow('file', '<system-reminder>\nCalled the Read tool with the following input: {"file_path":"/src/b.ts"}\nResult: …'))
  const [skills, file] = l.snapshot().items
  expect(skills!.category).toBe('attachment:skill_listing')
  expect(file!.target).toEqual({ kind: 'file', value: '/src/b.ts' })
  expect(file!.attached).toBe(true)
})

test('only main prompts advance the turn; subagent rows get their own context', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('one'))
  ingestAppend(l, { ...promptRow('sub'), agentId: 'a1' })
  ingestAppend(l, promptRow('two'))
  expect(l.turn).toBe(2)
  expect(l.snapshot().items.map(i => i.ctx)).toEqual(['main', 'a1', 'main'])
})

test('a successful edit is recorded with its changed lines; a failed one is not', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('edit'))
  editFile(l, 'e1', '/a.ts', 'a\nb', 'a\nc')
  const edits = l.snapshot().edits
  expect(edits.length).toBe(1)
  expect(edits[0]).toEqual({ seq: edits[0]!.seq, ctx: 'main', turn: 1, path: '/a.ts', lines: 2 })
})

test('a compaction keeps items in kept rows or answering kept calls; a re-appended row revives', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('go', 'p1'))
  readFile(l, 'r1', '/a.ts', okLines(20), { uuid: 'row-a' })
  runBash(l, 'b1', 'npm test', okLines(30))
  const before: MessageLike[] = [
    { role: 'user', text: 'go', toolUses: [], handle: 'p1' },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }], handle: 'h-a' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: '…', isError: false }], handle: 'row-a' },
  ]
  const after: MessageLike[] = [
    { role: 'user', text: 'Summary: worked on a.ts', toolUses: [], handle: 'summary-row' },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: '…', isError: false }], handle: 'row-a' },
  ]
  ingestCompaction(l, { trigger: 'auto', messages: before }, { messages: after, tokensBefore: 900, tokensAfter: 100 })
  const s = l.snapshot()
  const live = s.items.filter(i => i.live).map(i => i.category)
  expect(live).toEqual(['Read'])
  expect(s.compactions.length).toBe(1)
  expect(s.compactions[0]!.droppedItems).toBe(2)
  expect(s.compactions[0]!.entities).toContainEqual({ type: 'read-file', value: '/a.ts', kept: true })
  expect(l.epochOf('main')).toBe(1)
  // the engine re-appends the prompt row with its uuid: revived, not duplicated
  const size = l.size
  ingestAppend(l, promptRow('go', 'p1'))
  expect(l.size).toBe(size)
  expect(l.snapshot().items[0]!.live).toBe(true)
  expect(l.turn).toBe(1)
})

test('a skipped or precompute compaction changes nothing', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a', okLines(5))
  const v = l.version
  ingestCompaction(l, { trigger: 'manual', messages: [] }, { skip: 'vetoed' })
  ingestCompaction(l, { trigger: 'precompute', messages: [] }, { messages: [] })
  expect(l.version).toBe(v)
  expect(l.snapshot().compactions.length).toBe(0)
})

test('entities: edited files, other reads, errors, user identifiers; mentions by path or base name', () => {
  const messages: MessageLike[] = [
    { role: 'user', text: 'Rename `parseConfig` in src/config.ts <system-reminder>ignore_me_please</system-reminder>', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: '1', tool: 'Read', input: { file_path: '/r/src/config.ts' } },
        { tool_use_id: '2', tool: 'Edit', input: { file_path: '/r/src/config.ts' } },
        { tool_use_id: '3', tool: 'Read', input: { file_path: '/r/README.md' } },
      ],
    },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: '4', text: '<tool_use_error>File not found: x.ts</tool_use_error>', isError: true }] },
  ]
  const found = extractEntities(messages)
  expect(found).toContainEqual({ type: 'edited-file', value: '/r/src/config.ts' })
  expect(found).toContainEqual({ type: 'read-file', value: '/r/README.md' })
  expect(found.some(f => f.type === 'read-file' && f.value === '/r/src/config.ts')).toBe(false)
  expect(found).toContainEqual({ type: 'error', value: 'File not found: x.ts' })
  expect(found).toContainEqual({ type: 'requirement', value: 'parseConfig' })
  expect(found).toContainEqual({ type: 'requirement', value: 'src/config.ts' })
  expect(found.some(f => f.value === 'ignore_me_please')).toBe(false)
  expect(isMentioned('we changed config.ts', { type: 'edited-file', value: '/r/src/config.ts' })).toBe(true)
  expect(isMentioned('nothing here', { type: 'read-file', value: '/r/README.md' })).toBe(false)
})

test('backfill rebuilds turns, tool results with targets, and edits, all marked backfilled', () => {
  const l = new Ledger()
  backfill(l, [
    { role: 'user', text: 'start', toolUses: [] },
    { role: 'assistant', text: 'reading', toolUses: [{ tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }, { tool_use_id: 'e1', tool: 'Write', input: { file_path: '/b.ts', content: 'x\ny\n' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'r1', text: okLines(3), isError: false }, { tool_use_id: 'e1', text: 'written', isError: false }] },
  ])
  const s = l.snapshot()
  expect(l.turn).toBe(1)
  expect(s.items.every(i => i.backfilled === true)).toBe(true)
  expect(s.items.find(i => i.toolUseId === 'r1')!.target).toEqual({ kind: 'file', value: '/a.ts' })
  expect(s.edits.map(e => [e.path, e.lines])).toEqual([['/b.ts', 2]])
})

test('the ledger trims to 90% of its cap, out-of-window items first', () => {
  const l = new Ledger(10)
  for (let i = 0; i < 6; i += 1) runBash(l, `b${i}`, 'ls', `out ${i}`)
  ingestCompaction(l, { trigger: 'manual', messages: [] }, { messages: [] }) // all six leave the window
  for (let i = 6; i < 11; i += 1) runBash(l, `b${i}`, 'ls', `out ${i}`)
  const s = l.snapshot()
  expect(s.items.length).toBe(9)
  expect(l.dropped).toBe(2)
  expect(l.droppedLive).toBe(0)
})
```

- [ ] **Step 6: Run to verify the new tests fail, then pass**

Run: `"$CLAUDE292" plugin test context-inspector`
Expected before Steps 1-3 exist: FAIL (modules missing). With Steps 1-4 written: all tests PASS (primitives + ingest).

- [ ] **Step 7: Type check and commit**

Run: `npx -y -p typescript@5 tsc -p context-inspector --noEmit`
Expected: no output.

```bash
git add context-inspector
git commit -m "feat(context-inspector): ledger, entity extraction and event ingestion

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Analyses

**Files:**
- Create: `context-inspector/hooks/core/analyze/occupancy.ts`
- Create: `context-inspector/hooks/core/analyze/rereads.ts`
- Create: `context-inspector/hooks/core/analyze/similar.ts`
- Create: `context-inspector/hooks/core/analyze/compaction.ts`
- Create: `context-inspector/hooks/core/analyze/efficiency.ts`
- Test: `context-inspector/tests/analyze.test.ts`

**Interfaces:**
- Consumes: types.ts, `bands`, `hamming` (hash.ts), `MAIN`; Ledger and fixtures in tests.
- Produces:
  - `occupancy(items, k, top = 20): Occupancy` with `Occupancy = { liveEst; liveItems; byCategory: Row[]; byTarget: Row[]; top: TopItem[] }`, `Row = { key; est; count }`, `TopItem = { seq; category; label; est; turn }`, `label(item): string`.
  - `rereads(items, edits, k): Rereads` with `RereadClass`, `RereadRow = { seq; ctx; path; cls; est }`, `FileRereads = { path; reads; wasteEst; classes: Partial<Record<RereadClass, number>> }`, `Rereads = { rows; files; wasteEst; compactionEst; deduped; wasteSeqs: Set<number> }`.
  - `similar(items, k, exclude?): Similar` with `Cluster = { kind: 'exact'|'near'|'mixed'; category; label; size; seqs; totalEst; wasteEst }`, `Similar = { clusters; wasteEst }`, `NEAR_BITS = 3`, `MIN_SIMILAR_CHARS = 200`.
  - `compactionViews(recs, rows, k): CompactionView[]` with `CompactionView = { seq; ctx; turn; trigger; tokensBefore?; tokensAfter?; keptItems; droppedItems; droppedEst; stats: Record<EntityType, { total; kept }>; lostEdited: string[]; reflowEst }`.
  - `efficiency(samples, edits): Efficiency` with `TurnEff = { turn; growth?; lines; perLine? }`, `Efficiency = { turns; growth; lines; exploration; medianPerLine? }`.

- [ ] **Step 1: Write the failing analyze test**

`context-inspector/tests/analyze.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { compactionViews } from '../hooks/core/analyze/compaction.ts'
import { efficiency } from '../hooks/core/analyze/efficiency.ts'
import { occupancy } from '../hooks/core/analyze/occupancy.ts'
import { rereads } from '../hooks/core/analyze/rereads.ts'
import { similar } from '../hooks/core/analyze/similar.ts'
import { ingestAppend, ingestCompaction } from '../hooks/core/ingest.ts'
import { Ledger } from '../hooks/core/ledger.ts'
import { attachmentRow, editFile, letters, okLines, promptRow, readFile, runBash } from './fixtures.ts'

const compactAll = (l: Ledger, ctx?: string): void =>
  ingestCompaction(l, { trigger: 'auto', agentId: ctx, messages: [] }, { messages: [] })

test('occupancy sums live items by category and target, scaled by k, largest first', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/big.ts', 'x'.repeat(4_000))
  readFile(l, 'r2', '/small.ts', 'x'.repeat(400))
  runBash(l, 'b1', 'ls', 'y'.repeat(800))
  const o = occupancy(l.snapshot().items, 2)
  expect(o.liveItems).toBe(3)
  expect(o.liveEst).toBe(2_000 + 200 + 400)
  expect(o.byCategory.map(r => [r.key, r.est, r.count])).toEqual([['Read', 2_200, 2], ['Bash', 400, 1]])
  expect(o.byTarget[0]).toEqual({ key: '/big.ts', est: 2_000, count: 1 })
  expect(o.top[0]!.label).toBe('/big.ts')
})

test('occupancy ignores items out of the window', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a', okLines(5))
  compactAll(l)
  expect(occupancy(l.snapshot().items, 1).liveItems).toBe(0)
})

test('rereads: first, unchanged-live (waste), after-edit, different-range, engine-deduped', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('go'))
  readFile(l, 'r1', '/a.ts', okLines(40))
  readFile(l, 'r2', '/a.ts', okLines(40)) // unchanged-live
  editFile(l, 'e1', '/a.ts', 'x', 'y')
  readFile(l, 'r3', '/a.ts', okLines(40, 'changed')) // after-edit
  readFile(l, 'r4', '/a.ts', okLines(5), { offset: 1, limit: 5, total: 40 }) // different-range
  readFile(l, 'r5', '/a.ts', '', { unchanged: true }) // engine-deduped
  const s = l.snapshot()
  const r = rereads(s.items, s.edits, 1)
  expect(r.rows.map(x => x.cls)).toEqual(['first', 'unchanged-live', 'after-edit', 'different-range', 'engine-deduped'])
  const wasted = s.items.find(i => i.toolUseId === 'r2')!
  expect(r.wasteEst).toBe(wasted.est)
  expect([...r.wasteSeqs]).toEqual([wasted.seq])
  expect(r.deduped).toBe(1)
  expect(r.files[0]!.reads).toBe(5)
  expect(r.files[0]!.classes['unchanged-live']).toBe(1)
})

test('rereads: a file that grew between whole reads is changed-externally, not different-range', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/log.txt', okLines(10))
  readFile(l, 'r2', '/log.txt', okLines(12))
  const s = l.snapshot()
  expect(rereads(s.items, s.edits, 1).rows.map(x => x.cls)).toEqual(['first', 'changed-externally'])
})

test('rereads: after-compaction when the earlier copy was dropped; restored for an engine file attachment', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a.ts', okLines(10))
  readFile(l, 'r2', '/b.ts', okLines(10))
  compactAll(l)
  readFile(l, 'r3', '/a.ts', okLines(10))
  ingestAppend(l, attachmentRow('file', 'Called the Read tool with the following input: {"file_path":"/b.ts"}\n' + okLines(10)))
  const s = l.snapshot()
  const r = rereads(s.items, s.edits, 1)
  expect(r.rows.map(x => [x.path, x.cls])).toEqual([
    ['/a.ts', 'first'],
    ['/b.ts', 'first'],
    ['/a.ts', 'after-compaction'],
    ['/b.ts', 'restored'],
  ])
  expect(r.compactionEst).toBe(r.rows[2]!.est + r.rows[3]!.est)
  expect(r.wasteEst).toBe(0)
})

test('rereads: a later read that survived a compaction while the earlier one did not is still unchanged-live', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a.ts', okLines(10), { uuid: 'row-1' })
  readFile(l, 'r2', '/a.ts', okLines(10), { uuid: 'row-2' })
  ingestCompaction(
    l,
    { trigger: 'auto', messages: [{ role: 'user', text: '', toolUses: [], handle: 'row-2' }] },
    { messages: [{ role: 'user', text: '', toolUses: [], handle: 'row-2' }] },
  )
  const s = l.snapshot()
  expect(rereads(s.items, s.edits, 1).rows.map(x => x.cls)).toEqual(['first', 'unchanged-live'])
})

test('similar: exact and near-duplicate tool outputs cluster; waste keeps the largest live copy', () => {
  const l = new Ledger()
  runBash(l, 'b1', 'npm test', `${okLines(40)}\nTime: 1.20s`)
  runBash(l, 'b2', 'npm test', `${okLines(40)}\nTime: 3.45s`)
  runBash(l, 'b3', 'npm test', `${okLines(40)}\nTime: 3.45s`)
  runBash(l, 'b4', 'ls', letters(300))
  const items = l.snapshot().items
  const sim = similar(items, 1)
  expect(sim.clusters.length).toBe(1)
  const c = sim.clusters[0]!
  expect(c.size).toBe(3)
  expect(c.kind).toBe('mixed')
  expect(c.category).toBe('Bash')
  expect(c.label).toBe('npm test')
  const ests = items.slice(0, 3).map(i => i.est)
  expect(c.wasteEst).toBe(ests.reduce((a, b) => a + b, 0) - Math.max(...ests))
  expect(sim.wasteEst).toBe(c.wasteEst)
})

test('similar: short outputs are ignored; excluded items do not count as waste twice', () => {
  const l = new Ledger()
  runBash(l, 'b1', 'echo', 'hi')
  runBash(l, 'b2', 'echo', 'hi')
  expect(similar(l.snapshot().items, 1).clusters.length).toBe(0)
  const m = new Ledger()
  readFile(m, 'r1', '/a', okLines(20))
  readFile(m, 'r2', '/a', okLines(20))
  const items = m.snapshot().items
  expect(similar(items, 1, new Set([items[1]!.seq])).wasteEst).toBe(0)
})

test('compaction views: entity stats, lost edits, reflow assigned to the compaction before it', () => {
  const l = new Ledger()
  readFile(l, 'r1', '/a.ts', okLines(10))
  ingestCompaction(
    l,
    { trigger: 'manual', messages: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e', tool: 'Edit', input: { file_path: '/src/lost.ts' } }, { tool_use_id: 'r1', tool: 'Read', input: { file_path: '/a.ts' } }] }] },
    { messages: [{ role: 'user', text: 'Summary mentions a.ts only', toolUses: [] }], tokensBefore: 5_000, tokensAfter: 800 },
  )
  readFile(l, 'r2', '/a.ts', okLines(10))
  const s = l.snapshot()
  const rr = rereads(s.items, s.edits, 1)
  const [v] = compactionViews(s.compactions, rr.rows, 1)
  expect(v!.trigger).toBe('manual')
  expect(v!.tokensBefore).toBe(5_000)
  expect(v!.stats['edited-file']).toEqual({ total: 1, kept: 0 })
  expect(v!.stats['read-file']).toEqual({ total: 1, kept: 1 })
  expect(v!.lostEdited).toEqual(['/src/lost.ts'])
  expect(v!.reflowEst).toBe(rr.rows[1]!.est)
})

test('efficiency: growth per main turn within an epoch, lines per turn, exploration, median', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('one'))
  l.sample('main', 10_000)
  ingestAppend(l, promptRow('two'))
  l.sample('main', 14_000)
  editFile(l, 'e1', '/a', 'a', 'b') // 2 lines
  l.sample('a1', 99_999) // a subagent's requests do not count
  ingestAppend(l, promptRow('three'))
  l.sample('main', 20_000) // exploration: growth, no edits
  compactAll(l)
  ingestAppend(l, promptRow('four'))
  l.sample('main', 5_000) // new epoch: no growth figure
  const e = efficiency(l.snapshot().samples, l.snapshot().edits)
  expect(e.turns.map(t => [t.turn, t.growth, t.lines, t.perLine])).toEqual([
    [1, undefined, 0, undefined],
    [2, 4_000, 2, 2_000],
    [3, 6_000, 0, undefined],
    [4, undefined, 0, undefined],
  ])
  expect(e.growth).toBe(10_000)
  expect(e.lines).toBe(2)
  expect(e.exploration).toBe(1)
  expect(e.medianPerLine).toBe(2_000)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `"$CLAUDE292" plugin test context-inspector`
Expected: FAIL — `../hooks/core/analyze/*.ts` not found.

- [ ] **Step 3: Implement the analyses**

`context-inspector/hooks/core/analyze/occupancy.ts`:

```ts
import type { ContextItem } from '../types.ts'

export type Row = { key: string; est: number; count: number }
export type TopItem = { seq: number; category: string; label: string; est: number; turn: number }
export type Occupancy = { liveEst: number; liveItems: number; byCategory: Row[]; byTarget: Row[]; top: TopItem[] }

export function label(item: ContextItem): string {
  return item.target ? item.target.value : item.category
}

function bump(map: Map<string, Row>, key: string, est: number): void {
  const row = map.get(key)
  if (row) {
    row.est += est
    row.count += 1
  } else {
    map.set(key, { key, est, count: 1 })
  }
}

const sorted = (map: Map<string, Row>): Row[] => [...map.values()].sort((a, b) => b.est - a.est || a.key.localeCompare(b.key))

// What the window holds now, by category (tool, attachment kind, door) and by target (file, command…).
export function occupancy(items: readonly ContextItem[], k: number, top = 20): Occupancy {
  const categories = new Map<string, Row>()
  const targets = new Map<string, Row>()
  const live: ContextItem[] = []
  let liveEst = 0
  for (const item of items) {
    if (!item.live) continue
    live.push(item)
    const est = Math.round(item.est * k)
    liveEst += est
    bump(categories, item.category, est)
    if (item.target) bump(targets, item.target.value, est)
  }
  live.sort((a, b) => b.est - a.est || a.seq - b.seq)
  return {
    liveEst,
    liveItems: live.length,
    byCategory: sorted(categories),
    byTarget: sorted(targets),
    top: live.slice(0, top).map(i => ({ seq: i.seq, category: i.category, label: label(i), est: Math.round(i.est * k), turn: i.turn })),
  }
}
```

`context-inspector/hooks/core/analyze/rereads.ts`:

```ts
import type { ContextItem, EditRec } from '../types.ts'

export type RereadClass =
  | 'first'
  | 'engine-deduped'
  | 'restored'
  | 'different-range'
  | 'after-edit'
  | 'after-compaction'
  | 'changed-externally'
  | 'unchanged-live'

export type RereadRow = { seq: number; ctx: string; path: string; cls: RereadClass; est: number }
export type FileRereads = { path: string; reads: number; wasteEst: number; classes: Partial<Record<RereadClass, number>> }
export type Rereads = { rows: RereadRow[]; files: FileRereads[]; wasteEst: number; compactionEst: number; deduped: number; wasteSeqs: Set<number> }

// The first rule that matches wins (spec §4.2 and §10).
function classify(r: ContextItem, prior: readonly ContextItem[], edits: readonly number[]): RereadClass {
  if (prior.length === 0) return 'first'
  if (r.deduped) return 'engine-deduped'
  const sameRange = prior.findLast(p => p.target?.range === r.target?.range)
  const p = sameRange ?? prior[prior.length - 1]!
  // p.epoch is the last epoch p was live in; r.born the epoch r arrived in.
  if (r.attached && p.epoch < r.born) return 'restored'
  if (!sameRange) return 'different-range'
  if (edits.some(seq => seq > p.seq && seq < r.seq)) return 'after-edit'
  if (p.epoch < r.born) return 'after-compaction'
  if (p.hash !== r.hash) return 'changed-externally'
  return 'unchanged-live'
}

export function rereads(items: readonly ContextItem[], edits: readonly EditRec[], k: number): Rereads {
  const reads = items.filter(i => i.target?.kind === 'file' && (i.category === 'Read' || i.attached)).sort((a, b) => a.seq - b.seq)
  const editSeqs = new Map<string, number[]>()
  for (const e of edits) {
    const key = `${e.ctx}\u0000${e.path}`
    const list = editSeqs.get(key)
    if (list) list.push(e.seq)
    else editSeqs.set(key, [e.seq])
  }
  const history = new Map<string, ContextItem[]>()
  const rows: RereadRow[] = []
  for (const r of reads) {
    const path = r.target!.value
    const key = `${r.ctx}\u0000${path}`
    const prior = history.get(key) ?? []
    rows.push({ seq: r.seq, ctx: r.ctx, path, cls: classify(r, prior, editSeqs.get(key) ?? []), est: Math.round(r.est * k) })
    prior.push(r)
    history.set(key, prior)
  }
  const files = new Map<string, FileRereads>()
  const wasteSeqs = new Set<number>()
  let wasteEst = 0
  let compactionEst = 0
  let deduped = 0
  for (const row of rows) {
    const f = files.get(row.path) ?? { path: row.path, reads: 0, wasteEst: 0, classes: {} }
    f.reads += 1
    f.classes[row.cls] = (f.classes[row.cls] ?? 0) + 1
    if (row.cls === 'unchanged-live') {
      f.wasteEst += row.est
      wasteEst += row.est
      wasteSeqs.add(row.seq)
    }
    if (row.cls === 'after-compaction' || row.cls === 'restored') compactionEst += row.est
    if (row.cls === 'engine-deduped') deduped += 1
    files.set(row.path, f)
  }
  return {
    rows,
    files: [...files.values()].filter(f => f.reads > 1).sort((a, b) => b.wasteEst - a.wasteEst || b.reads - a.reads || a.path.localeCompare(b.path)),
    wasteEst,
    compactionEst,
    deduped,
    wasteSeqs,
  }
}
```

`context-inspector/hooks/core/analyze/similar.ts`:

```ts
import { bands, hamming } from '../hash.ts'
import type { ContextItem } from '../types.ts'
import { label } from './occupancy.ts'

export const NEAR_BITS = 3
export const MIN_SIMILAR_CHARS = 200
// Each band bucket compares against at most this many earlier members, which bounds the work on runs
// of thousands of near-identical outputs (they are already joined through their first members).
const BUCKET_CAP = 64

export type Cluster = { kind: 'exact' | 'near' | 'mixed'; category: string; label: string; size: number; seqs: number[]; totalEst: number; wasteEst: number }
export type Similar = { clusters: Cluster[]; wasteEst: number }

function mostCommon(values: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? ''
}

// Tool outputs that are byte-identical (same hash) or lexically near-identical (SimHash within 3 bits).
// `exclude`: items already counted as re-read waste, so they are not counted again here.
export function similar(items: readonly ContextItem[], k: number, exclude: ReadonlySet<number> = new Set()): Similar {
  const cand = items.filter(i => i.door === 'tool-result' && i.chars >= MIN_SIMILAR_CHARS)
  const parent = cand.map((_, i) => i)
  const find = (i: number): number => {
    let x = i
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!
      x = parent[x]!
    }
    return x
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  const firstByHash = new Map<string, number>()
  const reps: number[] = []
  cand.forEach((item, i) => {
    const first = firstByHash.get(item.hash)
    if (first === undefined) {
      firstByHash.set(item.hash, i)
      reps.push(i)
    } else {
      union(first, i)
    }
  })
  const buckets = new Map<string, number[]>()
  for (const i of reps) {
    const h = cand[i]!.simhash
    if (h === undefined) continue
    const tried = new Set<number>()
    for (const band of bands(h)) {
      let bucket = buckets.get(band)
      if (!bucket) {
        bucket = []
        buckets.set(band, bucket)
      }
      for (const j of bucket) {
        if (tried.has(j)) continue
        tried.add(j)
        if (hamming(h, cand[j]!.simhash!) <= NEAR_BITS) union(j, i)
      }
      if (bucket.length < BUCKET_CAP) bucket.push(i)
    }
  }
  const groups = new Map<number, ContextItem[]>()
  cand.forEach((item, i) => {
    const root = find(i)
    const group = groups.get(root)
    if (group) group.push(item)
    else groups.set(root, [item])
  })
  const clusters: Cluster[] = []
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const hashes = new Set(members.map(m => m.hash)).size
    const est = (m: ContextItem): number => Math.round(m.est * k)
    const live = members.filter(m => m.live)
    const liveSum = live.reduce((s, m) => s + est(m), 0)
    const largest = live.reduce((s, m) => Math.max(s, est(m)), 0)
    const excluded = live.filter(m => exclude.has(m.seq)).reduce((s, m) => s + est(m), 0)
    clusters.push({
      kind: hashes === 1 ? 'exact' : hashes === members.length ? 'near' : 'mixed',
      category: mostCommon(members.map(m => m.category)),
      label: label(members[0]!),
      size: members.length,
      seqs: members.map(m => m.seq),
      totalEst: members.reduce((s, m) => s + est(m), 0),
      wasteEst: Math.max(0, liveSum - largest - excluded),
    })
  }
  clusters.sort((a, b) => b.wasteEst - a.wasteEst || b.totalEst - a.totalEst || a.seqs[0]! - b.seqs[0]!)
  return { clusters, wasteEst: clusters.reduce((s, c) => s + c.wasteEst, 0) }
}
```

`context-inspector/hooks/core/analyze/compaction.ts`:

```ts
import type { CompactionRec, EntityType } from '../types.ts'
import type { RereadRow } from './rereads.ts'

export type EntityStat = { total: number; kept: number }
export type CompactionView = {
  seq: number
  ctx: string
  turn: number
  trigger: string
  tokensBefore?: number
  tokensAfter?: number
  keptItems: number
  droppedItems: number
  droppedEst: number
  stats: Record<EntityType, EntityStat>
  lostEdited: string[]
  // Estimated tokens of files read again (or restored by the engine) because this compaction dropped them.
  reflowEst: number
}

const TYPES: EntityType[] = ['edited-file', 'read-file', 'error', 'requirement']

export function compactionViews(recs: readonly CompactionRec[], rows: readonly RereadRow[], k: number): CompactionView[] {
  const views: CompactionView[] = recs.map(rec => {
    const stats = Object.fromEntries(TYPES.map(t => [t, { total: 0, kept: 0 }])) as Record<EntityType, EntityStat>
    for (const e of rec.entities) {
      stats[e.type].total += 1
      if (e.kept) stats[e.type].kept += 1
    }
    return {
      seq: rec.seq,
      ctx: rec.ctx,
      turn: rec.turn,
      trigger: rec.trigger,
      tokensBefore: rec.tokensBefore,
      tokensAfter: rec.tokensAfter,
      keptItems: rec.keptItems,
      droppedItems: rec.droppedItems,
      droppedEst: Math.round(rec.droppedEst * k),
      stats,
      lostEdited: rec.entities.filter(e => e.type === 'edited-file' && !e.kept).map(e => e.value),
      reflowEst: 0,
    }
  })
  for (const row of rows) {
    if (row.cls !== 'after-compaction' && row.cls !== 'restored') continue
    let owner: CompactionView | undefined
    for (const v of views) if (v.ctx === row.ctx && v.seq < row.seq && (!owner || v.seq > owner.seq)) owner = v
    if (owner) owner.reflowEst += row.est
  }
  return views
}
```

`context-inspector/hooks/core/analyze/efficiency.ts`:

```ts
import { MAIN, type EditRec, type Sample } from '../types.ts'

export type TurnEff = { turn: number; growth?: number; lines: number; perLine?: number }
export type Efficiency = { turns: TurnEff[]; growth: number; lines: number; exploration: number; medianPerLine?: number }

// Per main turn: measured input growth (last request of the turn against the last request of the turn
// before, same epoch only) next to the lines edits changed in the turn, subagents' included.
export function efficiency(samples: readonly Sample[], edits: readonly EditRec[]): Efficiency {
  const last = new Map<number, Sample>()
  for (const s of samples) if (s.ctx === MAIN) last.set(s.turn, s)
  const lines = new Map<number, number>()
  for (const e of edits) lines.set(e.turn, (lines.get(e.turn) ?? 0) + e.lines)
  const order = [...new Set([...last.keys(), ...lines.keys()])].sort((a, b) => a - b)
  const turns: TurnEff[] = []
  let prev: Sample | undefined
  for (const turn of order) {
    const s = last.get(turn)
    const growth = s && prev && s.epoch === prev.epoch ? s.input - prev.input : undefined
    if (s) prev = s
    const changed = lines.get(turn) ?? 0
    turns.push({ turn, growth, lines: changed, perLine: growth !== undefined && changed > 0 ? Math.round(growth / changed) : undefined })
  }
  const per = turns.flatMap(t => (t.perLine !== undefined ? [t.perLine] : [])).sort((a, b) => a - b)
  return {
    turns,
    growth: turns.reduce((s, t) => s + Math.max(0, t.growth ?? 0), 0),
    lines: turns.reduce((s, t) => s + t.lines, 0),
    exploration: turns.filter(t => (t.growth ?? 0) > 0 && t.lines === 0).length,
    medianPerLine: per.length > 0 ? per[Math.floor((per.length - 1) / 2)] : undefined,
  }
}
```

- [ ] **Step 4: Run tests and type check**

Run: `"$CLAUDE292" plugin test context-inspector && npx -y -p typescript@5 tsc -p context-inspector --noEmit`
Expected: all PASS; tsc silent. (`Array.prototype.findLast` is ES2023, in the configured lib.)

- [ ] **Step 5: Commit**

```bash
git add context-inspector
git commit -m "feat(context-inspector): occupancy, re-read, similarity, compaction and efficiency analyses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Advice, summary and report

**Files:**
- Create: `context-inspector/hooks/core/advice.ts`
- Create: `context-inspector/hooks/core/summary.ts`
- Create: `context-inspector/hooks/core/report.ts`
- Test: `context-inspector/tests/report.test.ts`

**Interfaces:**
- Consumes: Task 3 analyses, `calibrate`, `fmtCount`, `pct`, `clip`, `bar`, `MAIN`.
- Produces:
  - advice.ts: `Severity`, `Advice = { id; severity; title; evidence; action; savings }`, `BreakdownLite = { mcpTools: { name; serverName; tokens; isLoaded }[]; memoryFiles: { path; tokens }[] }`, `severityOf(savings)`, `advise(AdviceInput): Advice[]`.
  - summary.ts: `Scope = 'main' | 'all'`, `Summary`, `summarize(snapshot, scope, breakdown?)`.
  - report.ts: `SECTIONS`, `Section`, `UsageLite`, `PaneLine`, `parseArgs(args)`, `renderReport(sum, section?, usage?)`, `statusLine(sum, percent?)`, `paneLines(sum, width)`.

- [ ] **Step 1: Write the failing report test**

`context-inspector/tests/report.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { advise, severityOf } from '../hooks/core/advice.ts'
import { rereads } from '../hooks/core/analyze/rereads.ts'
import { ingestAppend, ingestCompaction } from '../hooks/core/ingest.ts'
import { Ledger } from '../hooks/core/ledger.ts'
import { paneLines, parseArgs, renderReport, statusLine } from '../hooks/core/report.ts'
import { summarize } from '../hooks/core/summary.ts'
import { okLines, promptRow, readFile, runBash } from './fixtures.ts'

function busy(): Ledger {
  const l = new Ledger()
  ingestAppend(l, promptRow('fix the flaky test'))
  readFile(l, 'r1', '/src/big.ts', 'x'.repeat(40_000)) // ≈10k, whole file
  readFile(l, 'r2', '/src/big.ts', 'x'.repeat(40_000)) // unchanged-live ≈10k
  for (let i = 0; i < 3; i += 1) runBash(l, `b${i}`, 'npm test', `${okLines(400)}\nTime: ${i}.5s`) // ≈3.9k each, near-identical
  runBash(l, 'b9', 'cat huge.log', 'z'.repeat(24_000)) // ≈6k
  l.sample('main', 30_000)
  return l
}

test('severity thresholds', () => {
  expect(severityOf(10_000)).toBe('high')
  expect(severityOf(3_000)).toBe('medium')
  expect(severityOf(2_999)).toBe('low')
})

test('advice fires for unchanged re-reads, large whole reads, long output and repeated output, most severe first', () => {
  const s = summarize(busy().snapshot(), 'main')
  const ids = s.advice.map(a => a.id)
  expect(ids).toContain('reread-unchanged')
  expect(ids).toContain('large-read')
  expect(ids).toContain('large-bash')
  expect(ids).toContain('repeated-output')
  const reread = s.advice.find(a => a.id === 'reread-unchanged')!
  expect(reread.severity).toBe('high')
  expect(reread.evidence).toContain('big.ts ×2')
  const ranks = s.advice.map(a => ({ high: 0, medium: 1, low: 2 })[a.severity])
  expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
})

test('advice from a breakdown: idle MCP servers and large memory files', () => {
  const l = new Ledger()
  runBash(l, 'b', 'ls', 'a')
  const s = l.snapshot()
  const rr = rereads(s.items, s.edits, 1)
  const advice = advise({
    items: s.items,
    k: 1,
    rereads: rr,
    clusters: [],
    compactions: [],
    breakdown: {
      mcpTools: [
        { name: 'mcp__docs__a', serverName: 'docs', tokens: 2_500, isLoaded: true },
        { name: 'mcp__docs__b', serverName: 'docs', tokens: 1_000, isLoaded: true },
        { name: 'mcp__lazy__c', serverName: 'lazy', tokens: 9_000, isLoaded: false },
      ],
      memoryFiles: [{ path: '/r/CLAUDE.md', tokens: 6_000 }],
    },
  })
  // both medium: the larger saving first
  expect(advice.map(a => [a.id, a.severity, a.savings])).toEqual([
    ['memory-large', 'medium', 4_000],
    ['mcp-unused', 'medium', 3_500],
  ])
})

test('compaction that lost an edited file is at least medium', () => {
  const l = new Ledger()
  ingestCompaction(
    l,
    { trigger: 'auto', messages: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e', tool: 'Write', input: { file_path: '/src/x.ts' } }] }] },
    { messages: [{ role: 'user', text: 'Summary: nothing about it', toolUses: [] }] },
  )
  const lost = summarize(l.snapshot(), 'main').advice.find(a => a.id === 'compaction-lost-edits')!
  expect(lost.severity).toBe('medium')
  expect(lost.evidence).toBe('x.ts')
})

test('summary: waste adds re-read and similar waste without double counting', () => {
  const s = summarize(busy().snapshot(), 'main')
  expect(s.wasteEst).toBe(s.rereads.wasteEst + s.similar.wasteEst)
  expect(s.rereads.wasteEst).toBe(10_000)
  // the two identical Reads also form an exact cluster, but its waste is already the re-read's
  expect(s.similar.clusters.find(c => c.category === 'Read')!.wasteEst).toBe(0)
  expect(s.similar.clusters.find(c => c.category === 'Bash')!.size).toBe(3)
})

test('summary scope: main leaves subagent items out, all keeps them', () => {
  const l = new Ledger()
  runBash(l, 'b1', 'ls', 'x'.repeat(400))
  runBash(l, 'b2', 'ls', 'y'.repeat(400), 'agent-1')
  expect(summarize(l.snapshot(), 'main').occupancy.liveItems).toBe(1)
  expect(summarize(l.snapshot(), 'all').occupancy.liveItems).toBe(2)
})

test('parseArgs', () => {
  expect(parseArgs('')).toEqual({ section: 'overview', scope: 'main' })
  expect(parseArgs('rereads --agents')).toEqual({ section: 'rereads', scope: 'all' })
  expect(parseArgs('nonsense')).toEqual({ section: 'overview', scope: 'main', unknown: 'nonsense' })
})

test('overview report names every section and marks estimates', () => {
  const text = renderReport(summarize(busy().snapshot(), 'main'), 'overview', { percent: 15, tokens: 30_000, window: 200_000 })
  for (const heading of ['Context Inspector — main context', 'Top occupants', 'Re-reads', 'Similar tool outputs', 'Compactions', 'Efficiency', 'Advice'])
    expect(text).toContain(heading)
  expect(text).toContain('window 30.0k/200.0k tokens (15%, measured)')
  expect(text).toContain('≈ = estimate')
  expect(text).toContain('/src/big.ts')
  expect(text).toContain('not semantic')
})

test('a single section renders only its block; an empty ledger renders without throwing', () => {
  const text = renderReport(summarize(busy().snapshot(), 'main'), 'advice')
  expect(text).toContain('Advice')
  expect(text).not.toContain('Top occupants')
  const empty = renderReport(summarize(new Ledger().snapshot(), 'main'))
  expect(empty).toContain('nothing recorded yet')
  expect(empty).toContain('nothing stands out')
})

test('status line and pane lines', () => {
  const s = summarize(busy().snapshot(), 'main')
  expect(statusLine(s, 62)).toMatch(/^ctx 62% · waste≈\d+(\.\d)?k$/)
  expect(statusLine(s)).toMatch(/^ctx ≈[\d.]+k · waste≈/)
  const lines = paneLines(s, 40)
  expect(lines.every(l => l.text.length <= 40)).toBe(true)
  expect(lines[0]!.bold).toBe(true)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `"$CLAUDE292" plugin test context-inspector`
Expected: FAIL — advice.ts / summary.ts / report.ts missing.

- [ ] **Step 3: Implement advice.ts**

`context-inspector/hooks/core/advice.ts`:

```ts
import type { CompactionView } from './analyze/compaction.ts'
import type { Rereads } from './analyze/rereads.ts'
import type { Cluster } from './analyze/similar.ts'
import { fmtCount } from './format.ts'
import type { ContextItem } from './types.ts'

export type Severity = 'high' | 'medium' | 'low'
export type Advice = { id: string; severity: Severity; title: string; evidence: string; action: string; savings: number }
export type BreakdownLite = {
  mcpTools: { name: string; serverName: string; tokens: number; isLoaded: boolean }[]
  memoryFiles: { path: string; tokens: number }[]
}
export type AdviceInput = {
  items: readonly ContextItem[]
  k: number
  rereads: Rereads
  clusters: readonly Cluster[]
  compactions: readonly CompactionView[]
  breakdown?: BreakdownLite
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 }

export function severityOf(savings: number): Severity {
  return savings >= 10_000 ? 'high' : savings >= 3_000 ? 'medium' : 'low'
}

const tok = (n: number): string => `≈${fmtCount(n)}`
const base = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path
const short = (s: string): string => {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

function list<T>(xs: readonly T[], show: (x: T) => string, n = 3): string {
  const head = xs.slice(0, n).map(show).join(', ')
  return xs.length > n ? `${head}, +${xs.length - n} more` : head
}

// Rule-based recommendations (spec §4.6); every one names its evidence and an estimated saving.
export function advise(input: AdviceInput): Advice[] {
  const { items, k, rereads, clusters, compactions, breakdown } = input
  const est = (i: ContextItem): number => Math.round(i.est * k)
  const out: Advice[] = []
  const push = (a: Omit<Advice, 'severity'>, floor?: Severity): void => {
    let severity = severityOf(a.savings)
    if (floor && RANK[floor] < RANK[severity]) severity = floor
    out.push({ ...a, severity })
  }

  const rereadFiles = rereads.files.filter(
    f => (f.classes['unchanged-live'] ?? 0) > 0 && (f.wasteEst >= 2_000 || f.reads - (f.classes['engine-deduped'] ?? 0) >= 3),
  )
  if (rereadFiles.length > 0)
    push({
      id: 'reread-unchanged',
      title: 'Unchanged files read again while the earlier copy is still in context',
      evidence: list(rereadFiles, f => `${base(f.path)} ×${f.reads} (${tok(f.wasteEst)})`),
      action: 'Refer to the earlier result; for one part, Grep or Read with offset/limit',
      savings: rereadFiles.reduce((s, f) => s + f.wasteEst, 0),
    })

  const bigReads = items.filter(i => i.category === 'Read' && i.target?.full === true && est(i) >= 8_000).sort((a, b) => b.est - a.est)
  if (bigReads.length > 0)
    push({
      id: 'large-read',
      title: 'Whole large files read into context',
      evidence: list(bigReads, i => `${base(i.target!.value)} (${tok(est(i))})`),
      action: 'Grep for the symbol first, then Read with offset/limit',
      savings: bigReads.reduce((s, i) => s + est(i) - 2_000, 0),
    })

  const bigBash = items.filter(i => i.category === 'Bash' && est(i) >= 5_000).sort((a, b) => b.est - a.est)
  if (bigBash.length > 0)
    push({
      id: 'large-bash',
      title: 'Long command output',
      evidence: list(bigBash, i => `${short(i.target?.value ?? 'Bash')} (${tok(est(i))})`),
      action: 'Pipe through tail or grep, or use quiet flags (-q, --silent)',
      savings: bigBash.reduce((s, i) => s + est(i) - 1_000, 0),
    })

  const repeated = clusters.filter(c => c.size >= 3 || c.wasteEst >= 3_000)
  if (repeated.length > 0)
    push({
      id: 'repeated-output',
      title: 'Near-identical tool output repeated',
      evidence: list(repeated, c => `${c.category} ${short(c.label)} ×${c.size} (${tok(c.wasteEst)})`),
      action: 'Narrow the rerun (only the failing test, a filter) or refer back to one result',
      savings: repeated.reduce((s, c) => s + c.wasteEst, 0),
    })

  const lost = compactions.filter(c => c.lostEdited.length > 0)
  if (lost.length > 0)
    push(
      {
        id: 'compaction-lost-edits',
        title: 'Compaction summaries dropped files that were edited',
        evidence: list(lost.flatMap(c => c.lostEdited), base, 5),
        action: 'Say what to keep: /compact keep <files and plan>, or keep the plan in a file',
        savings: lost.reduce((s, c) => s + c.reflowEst, 0),
      },
      'medium',
    )

  const reflow = compactions.reduce((s, c) => s + c.reflowEst, 0)
  if (reflow >= 5_000)
    push({
      id: 'compaction-reflow',
      title: 'Files read again after compaction',
      evidence: list(compactions.filter(c => c.reflowEst > 0), c => `${c.trigger} @turn ${c.turn} (${tok(c.reflowEst)})`),
      action: 'Compact with instructions naming the key files, or compact at a task boundary',
      savings: reflow,
    })

  const verbose = items.filter(i => (i.category === 'Agent' || i.category === 'Task') && est(i) >= 4_000).sort((a, b) => b.est - a.est)
  if (verbose.length > 0)
    push({
      id: 'agent-verbose',
      title: 'Subagents returned long results',
      evidence: list(verbose, i => `${short(i.target?.value ?? i.category)} (${tok(est(i))})`),
      action: 'Ask subagents for a short summary with file:line pointers',
      savings: verbose.reduce((s, i) => s + est(i) - 1_000, 0),
    })

  if (breakdown) {
    const used = new Set(items.map(i => i.category))
    const servers = new Map<string, { tokens: number; used: boolean }>()
    for (const t of breakdown.mcpTools) {
      if (!t.isLoaded) continue
      const s = servers.get(t.serverName) ?? { tokens: 0, used: false }
      s.tokens += t.tokens
      s.used ||= used.has(t.name)
      servers.set(t.serverName, s)
    }
    const idle = [...servers.entries()].filter(([, s]) => !s.used && s.tokens >= 3_000).sort((a, b) => b[1].tokens - a[1].tokens)
    if (idle.length > 0)
      push({
        id: 'mcp-unused',
        title: 'MCP tool schemas loaded but never called',
        evidence: list(idle, ([name, s]) => `${name} (${tok(s.tokens)})`),
        action: 'Disable the server for this project (/mcp), or let tool schemas load on demand',
        savings: idle.reduce((s, [, x]) => s + x.tokens, 0),
      })
    const memory = breakdown.memoryFiles.filter(f => f.tokens >= 4_000).sort((a, b) => b.tokens - a.tokens)
    if (memory.length > 0)
      push({
        id: 'memory-large',
        title: 'Large memory files loaded with every request',
        evidence: list(memory, f => `${base(f.path)} (${tok(f.tokens)})`),
        action: 'Trim CLAUDE.md; move rarely needed detail into files it links to',
        savings: memory.reduce((s, f) => s + f.tokens - 2_000, 0),
      })
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.savings - a.savings)
}
```

- [ ] **Step 4: Implement summary.ts**

`context-inspector/hooks/core/summary.ts`:

```ts
import { advise, type Advice, type BreakdownLite } from './advice.ts'
import { compactionViews, type CompactionView } from './analyze/compaction.ts'
import { efficiency, type Efficiency } from './analyze/efficiency.ts'
import { occupancy, type Occupancy } from './analyze/occupancy.ts'
import { rereads, type Rereads } from './analyze/rereads.ts'
import { similar, type Similar } from './analyze/similar.ts'
import { calibrate } from './tokens.ts'
import { MAIN, type Snapshot } from './types.ts'

export type Scope = 'main' | 'all'

export type Summary = {
  scope: Scope
  k: number
  segments: number
  turns: number
  occupancy: Occupancy
  rereads: Rereads
  similar: Similar
  compactions: CompactionView[]
  efficiency: Efficiency
  advice: Advice[]
  // Unchanged re-reads plus near-duplicate outputs, each item counted once.
  wasteEst: number
  dropped: number
  droppedLive: number
  hasBreakdown: boolean
}

export function summarize(s: Snapshot, scope: Scope, breakdown?: BreakdownLite): Summary {
  const inScope = (ctx: string): boolean => scope === 'all' || ctx === MAIN
  const items = s.items.filter(i => inScope(i.ctx))
  // Calibration uses every context: more segments, and k is a property of the tokenizer, not the scope.
  const { k, segments } = calibrate(s.samples, s.items)
  const rr = rereads(items, s.edits, k)
  const sim = similar(items, k, rr.wasteSeqs)
  const comps = compactionViews(s.compactions.filter(c => inScope(c.ctx)), rr.rows, k)
  return {
    scope,
    k,
    segments,
    turns: s.turn,
    occupancy: occupancy(items, k),
    rereads: rr,
    similar: sim,
    compactions: comps,
    efficiency: efficiency(s.samples, s.edits),
    advice: advise({ items, k, rereads: rr, clusters: sim.clusters, compactions: comps, breakdown }),
    wasteEst: rr.wasteEst + sim.wasteEst,
    dropped: s.dropped,
    droppedLive: s.droppedLive,
    hasBreakdown: breakdown !== undefined,
  }
}
```

- [ ] **Step 5: Implement report.ts**

`context-inspector/hooks/core/report.ts`:

```ts
import { bar, clip, fmtCount, pct } from './format.ts'
import type { Scope, Summary } from './summary.ts'
import { MAIN } from './types.ts'

export const SECTIONS = ['overview', 'occupants', 'rereads', 'similar', 'compactions', 'efficiency', 'advice'] as const
export type Section = (typeof SECTIONS)[number]
export type UsageLite = { percent?: number; tokens?: number; window?: number }
export type PaneLine = { text: string; bold?: boolean }

const tok = (n: number): string => `≈${fmtCount(n)}`
const signed = (n: number): string => `${n >= 0 ? '+' : '−'}${fmtCount(Math.abs(n))}`
const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const base = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path

export function parseArgs(args: string): { section: Section; scope: Scope; unknown?: string } {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  const scope: Scope = words.includes('--agents') ? 'all' : 'main'
  const first = words.find(w => w !== '--agents')
  if (first === undefined) return { section: 'overview', scope }
  if ((SECTIONS as readonly string[]).includes(first)) return { section: first as Section, scope }
  return { section: 'overview', scope, unknown: first }
}

function header(sum: Summary, usage?: UsageLite): string[] {
  const where = sum.scope === 'main' ? 'main context' : 'main + subagents'
  const window =
    usage?.tokens !== undefined && usage.window ? ` · window ${fmtCount(usage.tokens)}/${fmtCount(usage.window)} tokens (${usage.percent ?? 0}%, measured)` : ''
  const lines = [
    `Context Inspector — ${where}${window}`,
    `Live ${tok(sum.occupancy.liveEst)} tokens in ${sum.occupancy.liveItems} items · ${sum.turns} turn(s) · ${sum.compactions.length} compaction(s) · waste ${tok(sum.wasteEst)}`,
    `≈ = estimate (chars/4 × k=${sum.k.toFixed(2)}, ${sum.segments} calibration segment(s)); figures without ≈ are measured or engine-reported`,
  ]
  if (sum.dropped + sum.droppedLive > 0) lines.push(`(ledger cap reached: ${sum.dropped} old and ${sum.droppedLive} live items dropped)`)
  return lines
}

function occupants(sum: Summary, n: number): string[] {
  const o = sum.occupancy
  if (o.liveItems === 0) return ['Top occupants', '  nothing recorded yet']
  const out = ['Top occupants (live, by category)']
  for (const r of o.byCategory.slice(0, n))
    out.push(`  ${pad(clip(r.key, 28), 28)} ${pad(tok(r.est), 8)} ${pad(pct(r.est, o.liveEst), 4)} ${bar(r.est / o.liveEst)}  ${r.count} item(s)`)
  out.push('Largest live items')
  for (const t of o.top.slice(0, n)) out.push(`  ${pad(tok(t.est), 8)} ${pad(clip(t.category, 14), 14)} ${clip(t.label, 60)} · turn ${t.turn}`)
  return out
}

function rereadLines(sum: Summary, n: number): string[] {
  const r = sum.rereads
  const out = [`Re-reads — waste ${tok(r.wasteEst)} · compaction-induced ${tok(r.compactionEst)} · engine-deduped ${r.deduped}`]
  if (r.files.length === 0) return [...out, '  no file was read twice']
  for (const f of r.files.slice(0, n)) {
    const classes = Object.entries(f.classes)
      .filter(([c]) => c !== 'first')
      .map(([c, x]) => `${c}×${x}`)
      .join(' ')
    out.push(`  ${clip(f.path, 50)}  ${f.reads} reads  ${classes}${f.wasteEst > 0 ? `  waste ${tok(f.wasteEst)}` : ''}`)
  }
  return out
}

function similarLines(sum: Summary, n: number): string[] {
  const out = [`Similar tool outputs (lexical SimHash ≤3 bits, not semantic) — waste ${tok(sum.similar.wasteEst)}`]
  if (sum.similar.clusters.length === 0) return [...out, '  none']
  for (const c of sum.similar.clusters.slice(0, n))
    out.push(`  ${c.category} ×${c.size} ${c.kind}  waste ${tok(c.wasteEst)} of ${tok(c.totalEst)}  ${clip(c.label, 50)}`)
  return out
}

function compactionLines(sum: Summary, n: number): string[] {
  if (sum.compactions.length === 0) return ['Compactions', '  none yet']
  const out = ['Compactions (entities still found in the summary and kept messages)']
  const shown = sum.compactions.slice(-n)
  shown.forEach((c, i) => {
    const index = sum.compactions.length - shown.length + i + 1
    const sizes = c.tokensBefore !== undefined ? `  ${fmtCount(c.tokensBefore)}→${c.tokensAfter !== undefined ? fmtCount(c.tokensAfter) : '?'} tokens` : ''
    const who = c.ctx === MAIN ? '' : ` (${c.ctx})`
    out.push(`  #${index} ${c.trigger}${who} @turn ${c.turn}${sizes}  dropped ${c.droppedItems} item(s) ${tok(c.droppedEst)}`)
    const s = c.stats
    const lost = c.lostEdited.length > 0 ? ` · lost edits: ${c.lostEdited.map(base).join(', ')}` : ''
    const reflow = c.reflowEst > 0 ? ` · reflow ${tok(c.reflowEst)}` : ''
    out.push(
      `     kept: edited ${s['edited-file'].kept}/${s['edited-file'].total} · read ${s['read-file'].kept}/${s['read-file'].total} · errors ${s.error.kept}/${s.error.total} · requirements ${s.requirement.kept}/${s.requirement.total}${lost}${reflow}`,
    )
  })
  return out
}

function efficiencyLines(sum: Summary, n: number): string[] {
  const e = sum.efficiency
  const out = ['Efficiency (measured input growth vs changed lines; exploration is not a fault)']
  if (e.turns.length === 0) return [...out, '  no measured requests yet']
  const median = e.medianPerLine !== undefined ? `median ${fmtCount(e.medianPerLine)} tokens/line` : 'no edits yet'
  out.push(`  ${e.turns.length} turn(s) · +${fmtCount(e.growth)} tokens · ${e.lines} line(s) changed · ${median} · ${e.exploration} exploration turn(s)`)
  const top = e.turns
    .filter(t => t.growth !== undefined)
    .sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0))
    .slice(0, n)
  for (const t of top) {
    const tail = t.perLine !== undefined ? `  ${fmtCount(t.perLine)} tokens/line` : t.lines === 0 && (t.growth ?? 0) > 0 ? '  exploration' : ''
    out.push(`  turn ${t.turn}  ${signed(t.growth ?? 0)}  ${t.lines} line(s)${tail}`)
  }
  return out
}

function adviceLines(sum: Summary, n: number): string[] {
  const out = [`Advice${sum.hasBreakdown ? '' : ' (MCP and memory checks run from /context-inspect)'}`]
  if (sum.advice.length === 0) return [...out, '  nothing stands out']
  for (const a of sum.advice.slice(0, n)) {
    out.push(`  [${a.severity}] ${a.title} — saves ${tok(a.savings)}`)
    out.push(`     ${a.evidence}`)
    out.push(`     → ${a.action}`)
  }
  return out
}

const PARTS: [Section, (sum: Summary, n: number) => string[]][] = [
  ['occupants', occupants],
  ['rereads', rereadLines],
  ['similar', similarLines],
  ['compactions', compactionLines],
  ['efficiency', efficiencyLines],
  ['advice', adviceLines],
]

export function renderReport(sum: Summary, section: Section = 'overview', usage?: UsageLite): string {
  const n = section === 'overview' ? 3 : 15
  const blocks: string[][] = [header(sum, usage)]
  for (const [name, part] of PARTS) if (section === 'overview' || section === name) blocks.push(part(sum, n))
  return blocks.map(b => b.join('\n')).join('\n\n')
}

export function statusLine(sum: Summary, percent?: number): string {
  const head = percent !== undefined ? `ctx ${percent}%` : `ctx ${tok(sum.occupancy.liveEst)}`
  return `${head} · waste${tok(sum.wasteEst)}`
}

export function paneLines(sum: Summary, width: number): PaneLine[] {
  return renderReport(sum, 'overview')
    .split('\n')
    .map(text => ({ text: clip(text, Math.max(20, width)), bold: text !== '' && /^[A-Z]/.test(text) }))
}
```

- [ ] **Step 6: Run tests and type check**

Run: `"$CLAUDE292" plugin test context-inspector && npx -y -p typescript@5 tsc -p context-inspector --noEmit`
Expected: all PASS; tsc silent.

- [ ] **Step 7: Commit**

```bash
git add context-inspector
git commit -m "feat(context-inspector): advice rules, summary and text report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: JSONL export

**Files:**
- Create: `context-inspector/hooks/core/export.ts`
- Test: `context-inspector/tests/export.test.ts`

**Interfaces:**
- Consumes: `Snapshot`, `Summary`, `redactSecrets`, `contentHash`.
- Produces: `MAX_EXPORT_BYTES`, `ExportMeta = { sessionId; version; at }`, `exportLines(snapshot, summary, meta): string[]`, `chunkLines(lines, max?): string[]`.

- [ ] **Step 1: Write the failing export test**

`context-inspector/tests/export.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { chunkLines, exportLines } from '../hooks/core/export.ts'
import { ingestAppend, ingestCompaction } from '../hooks/core/ingest.ts'
import { Ledger } from '../hooks/core/ledger.ts'
import { summarize } from '../hooks/core/summary.ts'
import { okLines, promptRow, readFile, runBash } from './fixtures.ts'

const meta = { sessionId: 's1', version: '0.1.0', at: '2026-10-10T00:00:00.000Z' }

test('export has meta first, one line per record, summary last, and no content', () => {
  const l = new Ledger()
  ingestAppend(l, promptRow('secret prompt text'))
  readFile(l, 'r1', '/a.ts', 'CONTENT_THAT_MUST_NOT_LEAK')
  runBash(l, 'b1', 'curl -H "Authorization: Bearer abc123" https://x', okLines(3))
  l.sample('main', 5_000)
  ingestCompaction(l, { trigger: 'manual', messages: [{ role: 'user', text: 'use `fooBar`', toolUses: [] }] }, { messages: [] })
  const lines = exportLines(l.snapshot(), summarize(l.snapshot(), 'all'), meta)
  const records = lines.map(line => JSON.parse(line) as Record<string, unknown>)
  expect(records[0]).toEqual({ type: 'meta', schema: 'context-inspector/1', ...meta })
  expect(records.at(-1)!.type).toBe('summary')
  expect(records.filter(r => r.type === 'item').length).toBe(3)
  expect(records.filter(r => r.type === 'sample').length).toBe(1)
  const all = lines.join('\n')
  expect(all).not.toContain('CONTENT_THAT_MUST_NOT_LEAK')
  expect(all).not.toContain('secret prompt text')
  expect(all).not.toContain('abc123')
  expect(all).not.toContain('fooBar')
  const compaction = records.find(r => r.type === 'compaction') as { entities: Record<string, unknown>[] }
  expect(compaction.entities[0]).toEqual({ type: 'requirement', kept: false, hash: expect.any(String) })
})

test('chunkLines splits under the byte limit and keeps every line whole', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `{"n":${i},"pad":"${'x'.repeat(90)}"}`)
  const chunks = chunkLines(lines, 300)
  expect(chunks.length).toBe(5)
  expect(chunks.every(c => new TextEncoder().encode(c).length <= 300)).toBe(true)
  expect(chunks.join('').trim().split('\n')).toEqual(lines)
  expect(chunkLines([])).toEqual([])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `"$CLAUDE292" plugin test context-inspector`
Expected: FAIL — export.ts missing.

- [ ] **Step 3: Implement export.ts**

`context-inspector/hooks/core/export.ts`:

```ts
import { contentHash } from './hash.ts'
import { redactSecrets } from './redact.ts'
import type { Summary } from './summary.ts'
import type { Snapshot, Target } from './types.ts'

// Under `$.fs.write`'s 4 MiB limit with room to spare.
export const MAX_EXPORT_BYTES = Math.floor(3.5 * 1024 * 1024)

export type ExportMeta = { sessionId: string; version: string; at: string }

// Paths and agent names stay; command lines, patterns and URLs are redacted and cut to 200 characters.
function exportTarget(t: Target | undefined): Target | undefined {
  if (!t) return undefined
  const value = t.kind === 'file' || t.kind === 'agent' ? t.value : redactSecrets(t.value).slice(0, 200)
  return { ...t, value }
}

// One JSON record per line: meta, items, edits, samples, compactions, summary. No row content, and
// entity values only for files (errors and user identifiers are hashed).
export function exportLines(s: Snapshot, sum: Summary, meta: ExportMeta): string[] {
  const out: string[] = [JSON.stringify({ type: 'meta', schema: 'context-inspector/1', ...meta })]
  for (const i of s.items)
    out.push(
      JSON.stringify({
        type: 'item',
        seq: i.seq,
        ctx: i.ctx,
        turn: i.turn,
        door: i.door,
        category: i.category,
        toolUseId: i.toolUseId,
        target: exportTarget(i.target),
        chars: i.chars,
        est: i.est,
        hash: i.hash,
        simhash: i.simhash,
        born: i.born,
        epoch: i.epoch,
        live: i.live,
        isError: i.isError,
        deduped: i.deduped,
        attached: i.attached,
        backfilled: i.backfilled,
      }),
    )
  for (const e of s.edits) out.push(JSON.stringify({ type: 'edit', ...e }))
  for (const x of s.samples) out.push(JSON.stringify({ type: 'sample', ...x }))
  for (const c of s.compactions)
    out.push(
      JSON.stringify({
        type: 'compaction',
        ...c,
        entities: c.entities.map(e =>
          e.type === 'edited-file' || e.type === 'read-file' ? { type: e.type, kept: e.kept, value: e.value } : { type: e.type, kept: e.kept, hash: contentHash(e.value) },
        ),
      }),
    )
  out.push(
    JSON.stringify({
      type: 'summary',
      k: sum.k,
      segments: sum.segments,
      liveEst: sum.occupancy.liveEst,
      wasteEst: sum.wasteEst,
      rereadWasteEst: sum.rereads.wasteEst,
      similarWasteEst: sum.similar.wasteEst,
      compactionReflowEst: sum.rereads.compactionEst,
      advice: sum.advice.map(a => ({ id: a.id, severity: a.severity, savings: a.savings })),
    }),
  )
  return out
}

// Newline-terminated chunks of whole lines, each at most `max` bytes (a single longer line goes alone).
export function chunkLines(lines: readonly string[], max = MAX_EXPORT_BYTES): string[] {
  const encoder = new TextEncoder()
  const chunks: string[] = []
  let current: string[] = []
  let size = 0
  for (const line of lines) {
    const bytes = encoder.encode(line).length + 1
    if (current.length > 0 && size + bytes > max) {
      chunks.push(`${current.join('\n')}\n`)
      current = []
      size = 0
    }
    current.push(line)
    size += bytes
  }
  if (current.length > 0) chunks.push(`${current.join('\n')}\n`)
  return chunks
}
```

- [ ] **Step 4: Run tests and type check**

Run: `"$CLAUDE292" plugin test context-inspector && npx -y -p typescript@5 tsc -p context-inspector --noEmit`
Expected: PASS; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add context-inspector
git commit -m "feat(context-inspector): JSONL export of ledger metadata, content-free

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Adapter

**Files:**
- Modify (replace): `context-inspector/hooks/register.tsx`
- Test: `context-inspector/tests/adapter.test.ts`
- Test: `context-inspector/tests/perf.test.ts`

**Interfaces:**
- Consumes: everything above: `Ledger`, `ingestAppend`, `ingestToolCall`, `ingestToolResult`, `ingestCompaction`, `backfill`, `summarize`, `renderReport`, `statusLine`, `paneLines`, `parseArgs`, `exportLines`, `chunkLines`, `inputOf`, `MAIN`, `BreakdownLite`.
- Produces: commands `/context-inspect`, `/context-pane`, `/context-export`; pane id `context-inspector`.

- [ ] **Step 1: Write the failing adapter and perf tests**

`context-inspector/tests/adapter.test.ts`:

```ts
import { expect, mock, test } from 'claude-code/testing'

test('tool.call relays the answer unchanged, deny included', async ($, on) => {
  on('tool.call', () => ({ deny: 'nope' }))
  const denied = await $.tool.call({ tool: 'Bash', command: 'rm -rf /tmp/x', tool_use_id: 'toolu_d' })
  expect(denied.deny).toBe('nope')
})

test('session.compact returns what next resolved, for a compaction and for a skip', async ($, on) => {
  const after = [{ role: 'user', text: 'Summary', toolUses: [], handle: 'h9' }]
  on('session.compact', (_$, e) => (e.trigger === 'manual' ? { skip: 'vetoed' } : { messages: after, tokensBefore: 10, tokensAfter: 2 }))
  const done = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'a', toolUses: [], handle: 'h1' }] } as never)
  expect(done).toEqual({ messages: after, tokensBefore: 10, tokensAfter: 2 })
  const skipped = await $.session.compact({ trigger: 'manual', messages: [] } as never)
  expect(skipped).toEqual({ skip: 'vetoed' })
})

test('turn.step chunks reach the caller unchanged', async ($, on) => {
  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'hi' }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage }
  })
  const kinds: string[] = []
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) kinds.push(chunk.kind)
  expect(kinds).toEqual(['text', 'stop'])
})

test('/context-inspect renders a report after a compaction, even without a usage figure', async ($, on) => {
  on('tool.call', () => ({ result: { type: 'text', file: { filePath: '/a.ts', startLine: 1, numLines: 1, totalLines: 1 } }, text: 'x' }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'Summary mentions a.ts', toolUses: [] }], tokensBefore: 900, tokensAfter: 100 }))
  await $.tool.call({ tool: 'Read', file_path: '/a.ts', tool_use_id: 'toolu_r' })
  await $.session.compact({
    trigger: 'auto',
    messages: [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_r', tool: 'Read', input: { file_path: '/a.ts' } }], handle: 'h1' }],
  } as never)
  const answer = await $.command.run({ command: 'context-inspect', args: 'compactions' } as never)
  const text = String(answer.text)
  expect(text).toContain('Context Inspector — main context')
  // module state may carry over from the earlier compaction test, so the index is not pinned
  expect(text).toMatch(/#\d+ auto @turn \d+  900→100 tokens/)
  expect(text).toContain('read 1/1')
})

test('/context-inspect names an unknown section', async $ => {
  const answer = await $.command.run({ command: 'context-inspect', args: 'bogus' } as never)
  expect(String(answer.text)).toContain("unknown section 'bogus'")
})

test('/context-export writes JSONL into the session folder under HOME', async ($, on) => {
  mock.env(on, { HOME: '/Users/u' })
  on('session.id', () => ({ value: 'sess-1' }))
  const writes: { path: string; body: string }[] = []
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, body: e.text })
    return { value: undefined }
  })
  const answer = await $.command.run({ command: 'context-export', args: '' } as never)
  expect(writes.length).toBe(1)
  expect(writes[0]!.path).toMatch(/^\/Users\/u\/\.claude\/context-inspector\/sess-1\/context-[0-9a-z]+-1\.jsonl$/)
  expect(writes[0]!.body.split('\n')[0]).toContain('"type":"meta"')
  expect(String(answer.text)).toContain('wrote /Users/u/.claude/context-inspector/sess-1/')
})

test('/context-export reports a write failure instead of throwing', async ($, on) => {
  mock.env(on, { HOME: '/Users/u' })
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', () => ({ deny: 'EACCES' }))
  const answer = await $.command.run({ command: 'context-export', args: '' } as never)
  expect(String(answer.text)).toContain('export failed')
})
```

The `fs.write` event's input is `{ path, text }` (types line `'fs.write': {`). `$.session.usage` has no implementation in the test runner: the adapter's try/catch must turn that into "no usage figure", so `/context-inspect` still answers. If the runner fails the test on the unanswered call instead, add `on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: {}, cost: {} } }) as never)` to the two `/context-inspect` tests.

`context-inspector/tests/perf.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'

import { Ledger } from '../hooks/core/ledger.ts'
import { summarize } from '../hooks/core/summary.ts'
import { okLines, readFile, runBash } from './fixtures.ts'

test('summarize over 20k items stays fast', () => {
  const l = new Ledger()
  for (let i = 0; i < 10_000; i += 1) {
    readFile(l, `r${i}`, `/src/f${i % 500}.ts`, `${okLines(3)}\n${i}`)
    runBash(l, `b${i}`, 'npm test', `${okLines(12, `w${i % 50}`)}`)
    if (i % 100 === 0) l.sample('main', 10_000 + i * 50)
  }
  expect(l.size).toBe(20_000)
  const t0 = Date.now()
  const s = summarize(l.snapshot(), 'all')
  const ms = Date.now() - t0
  expect(s.occupancy.liveItems).toBe(20_000)
  expect(ms).toBeLessThan(1_000)
})
```

- [ ] **Step 2: Run to verify the adapter tests fail**

Run: `"$CLAUDE292" plugin test context-inspector`
Expected: adapter tests FAIL (stub register has no commands); perf test PASS or FAIL on time only.

- [ ] **Step 3: Write the adapter**

`context-inspector/hooks/register.tsx`:

```tsx
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { BreakdownLite } from './core/advice.ts'
import { chunkLines, exportLines } from './core/export.ts'
import { fmtCount } from './core/format.ts'
import { backfill, ingestAppend, ingestCompaction, ingestToolCall, ingestToolResult } from './core/ingest.ts'
import { Ledger } from './core/ledger.ts'
import { paneLines, parseArgs, renderReport, statusLine, type UsageLite } from './core/report.ts'
import { summarize, type Scope, type Summary } from './core/summary.ts'
import { inputOf } from './core/tokens.ts'
import { MAIN } from './core/types.ts'

const VERSION = '0.1.0'
const PANE = 'context-inspector'
const COMMANDS = [
  {
    name: 'context-inspect',
    description: 'Show what fills the context window and what is wasted: [overview|occupants|rereads|similar|compactions|efficiency|advice] [--agents]',
  },
  { name: 'context-pane', description: 'Open the live Context Inspector pane' },
  { name: 'context-export', description: "Write this session's context ledger as JSONL (metadata only, no content)" },
]
// Names this module load's export files, so a reload never overwrites an earlier load's.
const LOAD_ID = Date.now().toString(36)

let ledger = new Ledger()
let percent: number | undefined
let paintQueued = false
let toasted = false
const cache = new Map<Scope, { ledger: Ledger; version: number; sum: Summary }>()

// The inspector never breaks the session: every bookkeeping step goes through here.
function safe(fn: () => void): void {
  try {
    fn()
  } catch {
    // dropped on purpose
  }
}

function summary(scope: Scope = 'main'): Summary {
  const hit = cache.get(scope)
  if (hit && hit.ledger === ledger && hit.version === ledger.version) return hit.sum
  const sum = summarize(ledger.snapshot(), scope)
  cache.set(scope, { ledger, version: ledger.version, sum })
  return sum
}

// Paints are queued behind the event that asked, at most one pending.
function paint($: EngineInterface, options: PluginOptions): void {
  if (paintQueued) return
  paintQueued = true
  try {
    $.clock.after(0, async () => {
      paintQueued = false
      try {
        percent = (await $.session.usage()).context.percent
      } catch {
        // keep the last figure
      }
      safe(() => {
        const sum = summary()
        $.ui.status(statusLine(sum, percent))
        $.ui.invalidate('ui.render')
        const high = sum.advice.find(a => a.severity === 'high')
        if (high && !toasted && options.toastAdvice !== false) {
          toasted = true
          $.ui.toast(`context-inspector: ${high.title} (saves ≈${fmtCount(high.savings)}) — /context-inspect advice`)
        }
      })
    })
  } catch {
    paintQueued = false
  }
}

async function measured($: EngineInterface): Promise<{ usage?: UsageLite; breakdown?: BreakdownLite }> {
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const b = u.context.breakdown
    return {
      usage: { percent: u.context.percent, tokens: u.context.tokens, window: u.context.window },
      breakdown: b
        ? {
            mcpTools: b.mcpTools.map(t => ({ name: t.name, serverName: t.serverName, tokens: t.tokens, isLoaded: t.isLoaded })),
            memoryFiles: b.memoryFiles.map(f => ({ path: f.path, tokens: f.tokens })),
          }
        : undefined,
    }
  } catch {
    return {}
  }
}

async function outputDir($: EngineInterface, options: PluginOptions): Promise<string> {
  const dir = (String(options.outputDir ?? '').trim() || '~/.claude/context-inspector').replace(/\/+$/, '')
  if (!/^~(?=\/|$)/.test(dir)) return dir
  return dir.replace(/^~/, (await $.env.get('HOME')) ?? '.')
}

async function exportLedger($: EngineInterface, options: PluginOptions): Promise<string> {
  let sessionId = 'unknown'
  try {
    sessionId = await $.session.id()
  } catch {
    // files go under 'unknown'
  }
  const dir = `${await outputDir($, options)}/${sessionId}`
  const snap = ledger.snapshot()
  const chunks = chunkLines(exportLines(snap, summarize(snap, 'all'), { sessionId, version: VERSION, at: new Date().toISOString() }))
  const written: string[] = []
  for (const [i, body] of chunks.entries()) {
    const path = `${dir}/context-${LOAD_ID}-${i + 1}.jsonl`
    await $.fs.write(path, body)
    written.push(path)
  }
  return `wrote ${written.join(', ')}`
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    ledger = new Ledger()
    cache.clear()
    toasted = false
    percent = undefined
    for (const command of COMMANDS) {
      try {
        await $.command.register(command)
      } catch {
        // the command stays unavailable
      }
    }
    // A reload or a resume starts empty: read back what the conversation holds, off the start path.
    safe(() =>
      $.clock.after(0, async () => {
        const own = ledger
        try {
          const messages = await $.session.messages()
          if (own === ledger && own.size === 0 && messages.length > 0) backfill(own, messages)
        } catch {
          // nothing to read back
        }
      }),
    )
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    safe(() => ingestAppend(ledger, e))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    if (id !== undefined) safe(() => ingestToolCall(ledger, id, String(e.tool), e.agentId, e as unknown as Record<string, unknown>))
    const answer = await next(e)
    if (id !== undefined) safe(() => ingestToolResult(ledger, id, answer))
    return answer
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    for await (const chunk of next(e)) {
      if (chunk.kind === 'stop') safe(() => ledger.sample(e.agentId ?? MAIN, inputOf(chunk.usage)))
      yield chunk
    }
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    safe(() => ingestCompaction(ledger, e, result))
    paint($, options)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    paint($, options)
    return next(e)
  })

  on('command.run', { command: 'context-inspect' }, async ($, e) => {
    const { section, scope, unknown } = parseArgs(e.args)
    const { usage, breakdown } = await measured($)
    const text = renderReport(summarize(ledger.snapshot(), scope, breakdown), section, usage)
    return { text: unknown ? `unknown section '${unknown}'; showing the overview\n\n${text}` : text }
  })

  on('command.run', { command: 'context-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Context Inspector' })
    return { text: 'Context Inspector pane opened (shown in the terminal and the desktop app).' }
  })

  on('command.run', { command: 'context-export' }, async $ => {
    try {
      return { text: await exportLedger($, options) }
    } catch (error) {
      return { text: `export failed: ${String(error)}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const lines = paneLines(summary(), e.props.bodyColumns ?? 60)
    return (
      <Box flexDirection="column">
        {lines.map(line => (
          <Text bold={line.bold}>{line.text || ' '}</Text>
        ))}
      </Box>
    )
  })
}
```

- [ ] **Step 4: Run tests, type check, validate**

Run: `"$CLAUDE292" plugin test context-inspector && npx -y -p typescript@5 tsc -p context-inspector --noEmit && "$CLAUDE292" plugin validate context-inspector`
Expected: all tests PASS; tsc silent; validate passes (warnings allowed only for `$.fs.write` and `$.http`-style capability notes, not for hooks without `.catch` on gating events).
If tsc rejects `ingestCompaction(ledger, e, result)` or `ingestAppend(ledger, e)` because the engine types are not assignable to `CompactIn`/`CompactOut`/`AppendLike`, fix the core types (widen to the engine's shapes), not the adapter with casts.

- [ ] **Step 5: Commit**

```bash
git add context-inspector
git commit -m "feat(context-inspector): adapter hooks, commands, pane and export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: README, marketplace entry, end-to-end check

**Files:**
- Create: `context-inspector/README.md`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: the finished mod.
- Produces: marketplace listing `context-inspector` with source `./context-inspector`.

- [ ] **Step 1: Add the marketplace entry**

`.claude-plugin/marketplace.json` becomes:

```json
{
  "name": "my-claude-code-mods",
  "owner": { "name": "YeonwooSung" },
  "plugins": [
    {
      "name": "agent-profiler",
      "source": "./agent-profiler",
      "description": "Execution profiler for Claude Code: model wait vs tools vs subagents, live, with OTLP export"
    },
    {
      "name": "context-inspector",
      "source": "./context-inspector",
      "description": "Context waste analyzer: what fills the window, re-reads, near-duplicate outputs, what compaction kept, advice"
    }
  ]
}
```

- [ ] **Step 2: Write the README**

`context-inspector/README.md`:

````markdown
# Context Inspector — 컨텍스트 낭비 분석기

Claude Code 세션에서 컨텍스트 창을 무엇이 채우는지, 같은 정보가 왜 다시 들어오는지, 컴팩션이 무엇을 남기고 잃었는지 보여 주는 mod.
관찰만 한다: 행·도구 호출·컴팩션을 바꾸지 않는다.

## 설치

```
/plugin install context-inspector --marketplace YeonwooSung/my-claude-code-mods
```

Claude Code 2.1.287 이상(mods 기본 활성화). 그보다 오래된 빌드는 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`.

## 명령

| 명령 | 내용 |
|---|---|
| `/context-inspect [overview\|occupants\|rereads\|similar\|compactions\|efficiency\|advice] [--agents]` | 텍스트 보고서. 기본은 main 컨텍스트의 overview, `--agents`는 서브에이전트 포함 |
| `/context-pane` | 실시간 패널(터미널, 데스크톱 앱) |
| `/context-export` | 원문 없이 메타데이터만 JSONL로 저장: `<outputDir>/<sessionId>/context-<load>-<n>.jsonl` |

상태줄: `ctx 62% · waste≈8.1k` (창 점유율은 측정값, 낭비는 추정).

## 무엇을 재는가 — 관찰 가능성 등급

| 등급 | 예 |
|---|---|
| measured | 요청마다 API가 보고한 입력 토큰(uncached + cache read + cache write), 컴팩션 전/후 토큰 |
| observed | 대화에 들어온 행의 문자 수·해시, 컴팩션 전/후 메시지 집합 |
| estimated (`≈`) | 항목별 토큰 = 문자 수/4(이미지 1,500) × 보정 계수 k (측정된 입력 증가량으로 0.5–2.0 사이에서 보정) |

모델 내부의 토큰별 주의(attention)나 정확한 점유율은 외부에서 보이지 않으므로 주장하지 않는다.

## 분석

- **점유**: 현재 창에 남은 항목을 범주(도구 이름, `attachment:<name>`, prompt/response)와 대상(파일, 명령)별로.
- **재읽기**: 같은 파일의 두 번째 이후 읽기를 분류한다 — `engine-deduped`(엔진이 "unchanged" 안내로 대신함), `restored`(컴팩션 후 엔진이 다시 붙임), `different-range`, `after-edit`, `after-compaction`, `changed-externally`, `unchanged-live`(이전 사본이 아직 창에 있음 = 순수 낭비).
- **유사 출력**: 같은 해시(정확) 또는 64비트 SimHash 해밍 거리 ≤ 3(근사). 단어 3-shingle 기반 **어휘** 유사도이며 의미(임베딩) 유사도가 아니다. 숫자는 `#`로 접어 실행 시간만 다른 테스트 출력도 묶인다.
- **컴팩션**: 컴팩션 전 대화에서 편집 파일·읽은 파일·오류·사용자 식별자를 뽑아, 요약과 유지된 메시지에 남았는지 본다. 잃은 편집 파일과, 컴팩션 때문에 다시 읽은 양(reflow)을 보고한다.
- **효율**: 메인 턴별 측정 입력 증가량 대비 변경 라인 수(Edit/MultiEdit/Write/NotebookEdit). 편집 없이 커진 턴은 "탐색 턴"으로 표시만 한다(탐색은 결함이 아니다).
- **추천**: 무변경 재읽기, 큰 파일 통째 읽기, 긴 명령 출력, 반복 출력, 컴팩션이 잃은 편집 파일, 컴팩션 후 재유입, 긴 서브에이전트 결과, 호출되지 않은 MCP 서버, 큰 메모리 파일. 각 추천에 근거와 ≈절감량이 붙는다.

## 설정 (userConfig)

| 키 | 기본 | 뜻 |
|---|---|---|
| `outputDir` | `~/.claude/context-inspector` | `/context-export` 위치 |
| `toastAdvice` | `true` | high 추천이 처음 생길 때 세션당 한 번 토스트 |

## 내보내기 형식

한 줄에 JSON 하나: `meta`, `item`(seq, ctx, turn, door, category, target, chars, est, hash, simhash, born, epoch, live …), `edit`, `sample`, `compaction`, `summary`.
원문은 없다. 명령·패턴·URL 대상은 비밀값 마스킹 후 200자로 자른다. 컴팩션 엔티티 중 오류와 사용자 식별자는 해시만 남는다.

## 실행 환경

| 환경 | 동작 |
|---|---|
| 터미널 | 상태줄, 패널, 토스트, 명령 모두 |
| VS Code 채팅 패널 | 훅과 명령 텍스트만(mod의 그림은 표시되지 않음) — `/context-inspect`가 기본 출력 |
| `claude -p` | 기록만; 명령은 `-p "/context-inspect"`로 실행 가능 |

## 한계

- 리로드·재개 시 `$.session.messages()`로 메인 대화만 복구한다(attachment, 서브에이전트, 시간 정보 없음).
- 원장 상한 20,000 항목(넘치면 창 밖 항목부터 버림).
- 컴팩션 보존 판정은 문자열 포함 여부다(파일은 basename도 인정) — 요약이 다른 말로 바꿔 쓴 것은 잃은 것으로 센다.
- 유사도 버킷은 각 64개까지만 비교한다(수천 개의 거의 같은 출력도 대표끼리는 묶인다).

## 개발

```bash
CLAUDE292=~/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude
"$CLAUDE292" plugin test context-inspector
cp -R agent-profiler/.claude-plugin/types context-inspector/.claude-plugin/types   # once, for tsc
npx -y -p typescript@5 tsc -p context-inspector --noEmit
"$CLAUDE292" plugin validate context-inspector
```
````

- [ ] **Step 3: End-to-end check with the real engine**

Run from the scratchpad (not the repo), with a small file to read twice and a compaction:

```bash
S=<scratchpad>/ci-e2e && mkdir -p "$S" && cd "$S" && printf 'a\nb\nc\n' > f.txt
"$CLAUDE292" -p "Read f.txt, read it again, run 'seq 1 300' in bash twice. Reply 'ok'." --plugin-dir <repo>/context-inspector --allowedTools Read,Bash --output-format json < /dev/null > run.json
SID=$(python3 -c "import json;print([x for x in json.load(open('run.json')) if x.get('type')=='result'][0]['session_id'])")
"$CLAUDE292" -p "/context-inspect" --resume "$SID" --plugin-dir <repo>/context-inspector < /dev/null
"$CLAUDE292" -p "/compact" --resume "$SID" --plugin-dir <repo>/context-inspector < /dev/null
"$CLAUDE292" -p "/context-inspect compactions" --resume "$SID" --plugin-dir <repo>/context-inspector < /dev/null
```

Expected: the first report lists `Read` and `Bash` occupants, `f.txt` with `engine-deduped×1`, and a `Bash ×2` similar cluster (or exact). The compaction report lists `#1 manual` with token counts. A resumed `-p` run reloads the mod, so the ledger comes from backfill: say so in the report if attachments are missing. Record what you saw in the task report (the actual output, trimmed).

- [ ] **Step 4: Final checks and commit**

Run: `"$CLAUDE292" plugin test context-inspector && npx -y -p typescript@5 tsc -p context-inspector --noEmit && "$CLAUDE292" plugin validate context-inspector && "$CLAUDE292" plugin validate .`
Expected: all pass.

```bash
git add .claude-plugin/marketplace.json context-inspector/README.md
git commit -m "docs(context-inspector): README and marketplace entry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
