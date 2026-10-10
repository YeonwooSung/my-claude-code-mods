import type { TestFailure, TestRun } from './types.ts'

const MAX_FAILURES = 50
const MAX_LOCATIONS = 100
const MAX_PATHS = 200
const SCAN_MAX = 128 * 1024
const EXT = String.raw`(?:py|[cm]?[jt]sx?|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|exs?)`
const FILE = String.raw`(?<![\w.@/-])(?:\.{0,2}\/)?(?:[\w.@-]+\/)*[\w.@-]+\.${EXT}`
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
  const vitest = jest ? undefined : /^[ \t]*Tests\s+(.+?)\s*(?:\(\d+\))?\s*$/m.exec(text)
  const line = jest?.[1] ?? vitest?.[1]
  if (line === undefined) return undefined
  const failures: TestFailure[] = []
  for (const m of text.matchAll(/^[ \t]*● (.+?)\s*$/gm)) if (!/^Console\b/.test(m[1]!)) failures.push({ name: m[1]! })
  for (const m of text.matchAll(/^[ \t]*(?:FAIL|×|✗)\s+(\S+\.[cm]?[jt]sx?)\s+>\s+(.+?)\s*$/gm)) failures.push({ name: `${m[1]} > ${m[2]}`, file: m[1]! })
  return { framework: jest ? 'jest' : 'vitest', ...count(line, /(\d+) (passed|failed|skipped)\b/g), failures }
}

function parseGo(text: string): Found | undefined {
  const fails = [...text.matchAll(/^[ \t]*--- FAIL: (\S+)/gm)]
  const passes = [...text.matchAll(/^[ \t]*--- PASS: /gm)]
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

// Locations and paths come from the first and last 128 KiB only: a hook must not stall on a huge dump.
function scanWindow(text: string): string {
  return text.length <= 2 * SCAN_MAX ? text : `${text.slice(0, SCAN_MAX)}\n${text.slice(-SCAN_MAX)}`
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
  const window = scanWindow(text)
  const locations = locationsOf(window)
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
    paths: pathsOf(window),
  }
  if (found?.passed !== undefined) run.passed = found.passed
  if (found?.failed !== undefined) run.failed = found.failed
  if (found?.errors !== undefined) run.errors = found.errors
  if (found?.skipped !== undefined) run.skipped = found.skipped
  return run
}
