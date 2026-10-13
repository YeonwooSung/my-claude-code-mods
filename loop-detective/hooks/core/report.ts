import type { Case, Snapshot } from './detector.ts'

function caseLines(c: Case): string[] {
  const lines = [
    `Case #${c.id} [${c.kind}; ${c.status}] — ${c.agent}`,
    `  ${c.count} identical failures · calls #${c.firstSeq}–#${c.lastSeq} · ${c.editRetries} edit/retry transitions`,
    `  Command: ${c.command}`, `  Cwd: ${c.cwd}`, `  Failure: ${c.excerpt}`,
  ]
  if (c.files.length) lines.push(`  Observed edited files (not causal evidence): ${c.files.join(', ')}`)
  if (c.status === 'active') lines.push(c.kind === 'edit-retry'
    ? '  Possible next checks: inspect test expectations, input data, dependencies, or a different code path before another edit.'
    : '  Possible next checks: compare inputs and environment; formulate a different hypothesis before retrying.')
  return lines
}

export function renderReport(snapshot: Snapshot, args: string): string {
  const flags = args.trim().split(/\s+/).filter(Boolean)
  if (flags.some(f => f !== '--agents' && f !== '--history')) return 'Usage: /loop-report [--agents] [--history]'
  const all = flags.includes('--agents')
  const visible = (c: Case) => all || c.isMain
  const active = snapshot.active.filter(visible)
  const lines = [
    `Loop Detective — ${all ? 'all agents' : 'main agent'}`,
    `Threshold: ${snapshot.threshold} · ${active.length} active case(s)`,
    'Observed lexical repetition only; repeated failure does not establish a lack of progress.', '',
  ]
  if (!active.length) lines.push('No active cases in the retained observations.')
  for (const c of active) lines.push(...caseLines(c), '')
  if (flags.includes('--history')) {
    lines.push('', 'Closed cases (last 100):')
    const history = snapshot.history.filter(visible)
    if (!history.length) lines.push('none yet')
    for (const c of history) lines.push(...caseLines(c), '')
  }
  return lines.join('\n')
}

export function paneLines(snapshot: Snapshot): string[] {
  return renderReport(snapshot, '').split('\n')
}

export function statusLine(snapshot: Snapshot): string {
  const active = snapshot.active.filter(c => c.isMain)
  return active.length ? `loop: ${active.length} active · max ${Math.max(...active.map(c => c.count))} failures` : 'loop: no active cases'
}
