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

function comparable(a: Step & { test: TestRun }, b: Step & { test: TestRun }): boolean {
  const x = a.test.identity
  const y = b.test.identity
  return x !== undefined && y !== undefined && a.agentId === b.agentId && a.test.framework === b.test.framework && x.cwd === y.cwd && x.commandHash === y.commandHash
}

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
  const okBefore = [...runs].reverse().find(r => r.i < runIdx && r.step.test.ok && comparable(run, r.step))
  const baseIdx = okBefore ? okBefore.i : path[0]?.kind === 'baseline' ? 0 : -1
  const out: Why = { run, suspects: [] }
  const base = baseIdx >= 0 ? path[baseIdx] : undefined
  if (base) out.base = base
  if (!run.test.ok) out.suspects = rank(path, changesBetween(path, baseIdx, runIdx), run.test, baseIdx, runIdx)
  const later = runs.filter(r => r.i > runIdx && comparable(run, r.step))
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
