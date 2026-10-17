import { bounded, entries, restore, safeText, type Port } from './runtime.ts'
type Decision = { id: number; reference: string; choice: string; rationale: string; rejected: string }
const HELP = '/decision [add <file#symbol> | <choice> | <rationale> | <rejected alternative optional>] [list [reference] | remove <id> | reset]'
export class Feature {
  data: { nextId: number; decisions: Decision[] }
  constructor(value?: unknown) { this.data = restore(value, { nextId: 1, decisions: [] as Decision[] }) }
  async command(args: string, _io: Port): Promise<string> {
    const [verb, ...rest] = args.trim().split(/\s+/); const text = rest.join(' ')
    if (verb === 'help') return HELP
    if (verb === 'add') {
      const [reference, choice, rationale, rejected = ''] = entries(text)
      if (!reference || !choice || !rationale) return 'Usage: ' + HELP
      this.data.decisions = bounded([...this.data.decisions, { id: this.data.nextId++, reference: safeText(reference, 500), choice: safeText(choice, 1000), rationale: safeText(rationale, 2000), rejected: safeText(rejected, 1000) }])
    } else if (verb === 'remove') {
      const id = Number(text)
      if (!this.data.decisions.some(d => d.id === id)) return 'Decision not found'
      this.data.decisions = this.data.decisions.filter(d => d.id !== id)
    } else if (verb && verb !== 'list') return 'Usage: ' + HELP
    const rows = this.data.decisions.filter(d => verb !== 'list' || !text || d.reference.includes(text))
    return ['Decision Ledger — explicit decisions (latest 200)', ...rows.map(d => `#${d.id} ${d.reference}\n  Choice: ${d.choice}\n  Why: ${d.rationale}\n  Rejected: ${d.rejected || '(not recorded)'}`), ...(rows.length ? [] : ['No decisions recorded.'])].join('\n')
  }
}
