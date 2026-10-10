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
