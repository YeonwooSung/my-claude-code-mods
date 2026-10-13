import type { Why } from './causality.ts'
import { keyOf, type Compared, type OutputComparison } from './compare.ts'
import { redactSecrets } from './redact.ts'
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
  return clip(rawLabel(step), 80)
}

function rawLabel(step: Step): string {
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
  else if (step.snapshot?.changed) {
    // A branch restore changed nothing along its path; how the work tree moved is in its input.
    const workTree = step.kind === 'restore' && Array.isArray(step.input.workTree) ? (step.input.workTree as FileChange[]) : undefined
    const files = workTree ? `work tree: ${filesSummary(workTree, workTree.length)}` : filesSummary(step.snapshot.files, step.snapshot.filesTotal)
    out.push(`snapshot ${step.snapshot.commit.slice(0, 7)} · ${files}${step.snapshot.concurrent ? ' (concurrent)' : ''}`)
  }
  if (step.rerunOf !== undefined) out.push(`rerun of ${circled(step.rerunOf)}`)
  return out
}

export function avg(xs: readonly number[]): number | undefined {
  return xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined
}

export type TimelineOptions = { all?: boolean; branch?: string; limit?: number; off?: string; snapMs?: readonly number[]; recording?: import('./store.ts').RecordingStatus }

export function renderTimeline(rec: Recorder, o: TimelineOptions = {}): string {
  const branch = o.branch ?? rec.branch
  const steps = o.all ? rec.all() : rec.path(branch)
  const shown = o.all ? steps : steps.slice(-(o.limit ?? 30))
  const count = rec.all().filter(s => s.kind !== 'baseline').length
  const snaps = rec.all().filter(s => s.kind !== 'baseline' && s.snapshot?.changed).length
  const mean = avg(o.snapMs ?? [])
  const lines = [`Session ${rec.session.sessionId.slice(0, 8)} · branch ${branch} · ${count} step(s) · ${snaps} snapshot(s)${mean !== undefined ? `, avg ${mean}ms` : ''}`]
  if (o.off) lines.push(`snapshots off: ${o.off}`)
  if (o.recording) lines.push(`storage: ${o.recording.state}${o.recording.error !== undefined ? ` · ${o.recording.pending} file(s) awaiting retry; records retained in memory` : ''}`)
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
    for (const f of step.test.failures.slice(0, 10)) lines.push(`  ✗ ${clip(redactSecrets(f.name), 200)}${f.file ? ` (${f.file}${f.line !== undefined ? `:${f.line}` : ''})` : ''}`)
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
    if (t.failures.length > 0) lines.push(`Failures: ${t.failures.slice(0, 5).map(f => `${clip(redactSecrets(f.name), 200)}${f.line !== undefined ? ` (${f.file}:${f.line})` : ''}`).join(', ')}`)
  }
  if (w.fixedBy) {
    const run = `${circled(w.fixedBy.run.n)} ${label(w.fixedBy.run)} ${testSummary(w.fixedBy.run.test!)}`
    if (w.fixedBy.steps.length === 0) lines.push(`Passed later at ${run} with no file changes in between (flaky, or the environment changed)`)
    else if (labels) lines.push(`Fixed by: ${w.fixedBy.steps.map(n => labels(n) ?? circled(n)).join(', ')} → ${run}`)
    else lines.push(`Fixed by: ${w.fixedBy.steps.map(circled).join(', ')} (${w.fixedBy.files.join(', ')}) → ${run}`)
  }
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

// `/tm rerun n --isolated` without `--yes`: the command first, then where it would run and why it may not.
// `before` is the step whose snapshot the copy would hold; `blocked` says why it cannot run now.
export function renderIsolatedPlan(step: Step, command: string, before: Step | undefined, blocked?: string): string {
  const copy = before?.snapshot ? `a throwaway copy of ${circled(before.n)}'s snapshot (${before.snapshot.commit.slice(0, 7)})` : 'a throwaway copy of the snapshot before it'
  const lines = [
    `$ ${command}`,
    `Dry run of ${circled(step.n)} ${label(step)}: nothing ran. With --yes this runs through \`sh -lc\` in ${copy}, without a permission prompt.`,
    'Caveats: ignored files such as dependencies are not in the copy; the command still reaches any absolute path it names and your home directory; a change it makes to the project is recorded as an external step.',
  ]
  lines.push(blocked !== undefined ? `It would not run now: ${blocked}` : `Run /tm rerun ${step.n} --isolated --yes to run it.`)
  return lines.join('\n')
}

// `step` is the step asked for; `target` the step whose snapshot is used (the same, or the nearest earlier one).
export function renderRestorePlan(step: Step, target: Step, files: readonly FileChange[], applied: boolean, branch?: string, told = true): string {
  const n = step.n
  const what = `${circled(n)} ${label(step)}`
  const head = `snapshot ${target.snapshot?.commit.slice(0, 7) ?? '?'}${target.n !== n ? ` from ${circled(target.n)}` : ''}`
  const lines = applied
    ? [`Restored to ${what} (${head}): ${files.length} file(s) changed.`]
    : [`Restore to ${what} (${head}): ${files.length} file(s) would change.`]
  for (const f of files.slice(0, 50)) lines.push(`  ${f.status} ${f.path}`)
  if (files.length > 50) lines.push(`  … +${files.length - 50} more`)
  if (applied) {
    lines.push(`The state before the restore was snapshotted, so this can be undone. ${told ? 'The model was told the files changed.' : 'The note to the model could not be added; tell it the files changed before it edits them.'}`)
    if (branch !== undefined) lines.push(`New steps go to branch '${branch}'. The conversation itself was not rewound.`)
  } else {
    lines.push(branch !== undefined ? `Run /tm branch ${n} ${branch} --yes to apply.` : `Run /tm restore ${n} --yes to apply (the current state is snapshotted first, so it can be undone).`)
  }
  return lines.join('\n')
}

export function renderSessions(rows: readonly { id: string; startedAt: number; current: boolean }[]): string {
  if (rows.length === 0) return 'No recorded sessions for this project.'
  const sorted = [...rows].sort((a, b) => b.startedAt - a.startedAt)
  const started = (at: number): string => {
    const date = new Date(at)
    return Number.isFinite(at) && Number.isFinite(date.getTime()) ? date.toISOString() : '?'
  }
  return ['Recorded sessions (newest first):', ...sorted.map(r => `  ${r.id}${r.current ? ' (this session)' : ''} · started ${started(r.startedAt)}`)].join('\n')
}

export function statusLine(rec: Recorder, snapMs: readonly number[], off?: string, recording?: import('./store.ts').RecordingStatus): string {
  const steps = rec.all().filter(s => s.kind !== 'baseline')
  const last = steps.at(-1)?.n ?? 0
  const storage = recording ? ` · ${recording.state}` : ''
  if (off) return `tm ${circled(last)} · snapshots off${storage}`
  const snaps = steps.filter(s => s.snapshot?.changed).length
  const mean = avg(snapMs)
  return `tm ${circled(last)} · ${snaps} snaps${mean !== undefined ? ` · ${mean}ms` : ''}${storage}`
}
