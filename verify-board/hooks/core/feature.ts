import { bounded, isCheck, outcome, restore, safeText, type Observation, type Port } from './runtime.ts'
type Check = { command: string; result: string; revision?: string; changed: boolean }
export class Feature {
  data: { checks: Check[] }
  constructor(value?: unknown) { this.data = restore(value, { checks: [] as Check[] }) }
  async observe(e: Observation, _io: Port): Promise<void> {
    const command = String(e.input.command ?? '').trim()
    if (e.tool !== 'Bash' || !isCheck(command)) return
    const check: Check = { command: safeText(command), result: outcome(e.result), revision: e.before, changed: e.before !== e.after }
    this.data.checks = bounded([...this.data.checks.filter(c => c.command !== check.command), check])
  }
  async command(args: string, io: Port): Promise<string> {
    if (args.trim() === 'help') return '/verify [list | reset] — PASS matches the current content; STALE requires revalidation; UNKNOWN has no complete evidence.'
    if (args.trim() && args.trim() !== 'list') return 'Usage: /verify [list | reset]'
    const current = await io.revision()
    return ['Verify Board — observed checks only; commands are not coverage guarantees.', ...this.data.checks.map(c => {
      const status = c.result === 'fail' ? 'FAIL' : c.result !== 'pass' || !c.revision || !current ? 'UNKNOWN' : c.changed || c.revision !== current ? 'STALE' : 'PASS'
      return `${status} ${c.command}`
    }), ...(this.data.checks.length ? [] : ['No checks observed. Run a verification command.'])].join('\n')
  }
}
