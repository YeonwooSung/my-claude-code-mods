import { bounded, entries, restore, safeText, type Port } from './runtime.ts'
type Status = 'UNVERIFIED' | 'CONFIRMED' | 'REFUTED'
type Assumption = { id: number; claim: string; reference: string; status: Status; evidence: string; history: { status: Status; evidence: string }[] }
const HELP = '/assume [add <claim> | <reference optional>] [list | show <id> | confirm <id> | <evidence> | refute <id> | <evidence> | reopen <id> | reset]'
export class Feature {
  data: { nextId: number; assumptions: Assumption[] }
  constructor(value?: unknown) { this.data = restore(value, { nextId: 1, assumptions: [] as Assumption[] }) }
  async command(args: string, _io: Port): Promise<string> {
    const [verb, ...rest] = args.trim().split(/\s+/); const text = rest.join(' ')
    if (verb === 'help') return HELP
    if (verb === 'add') {
      const [claim, reference = ''] = entries(text)
      if (!claim) return 'Usage: ' + HELP
      this.data.assumptions = bounded([...this.data.assumptions, { id: this.data.nextId++, claim: safeText(claim, 2000), reference: safeText(reference, 500), status: 'UNVERIFIED', evidence: '', history: [] }])
    } else if (['confirm', 'refute', 'reopen', 'show'].includes(verb ?? '')) {
      const [id, evidence = ''] = entries(text); const item = this.data.assumptions.find(a => a.id === Number(id))
      if (!item) return 'Assumption not found'
      if (verb === 'show') return `#${item.id} ${item.status} ${item.claim}\n${item.reference}\n${item.history.map(h => `${h.status}: ${h.evidence}`).join('\n')}`
      if (verb !== 'reopen' && !evidence) return 'Resolution evidence required: confirm/refute <id> | <evidence>'
      item.status = verb === 'confirm' ? 'CONFIRMED' : verb === 'refute' ? 'REFUTED' : 'UNVERIFIED'
      item.evidence = verb === 'reopen' ? '' : safeText(evidence, 2000)
      item.history = [...item.history, { status: item.status, evidence: item.evidence || '(reopened)' }].slice(-20)
    } else if (verb && verb !== 'list') return 'Usage: ' + HELP
    return ['Assumption Tracker — explicit claims, latest 200; last 20 transitions per claim', ...this.data.assumptions.map(a => `#${a.id} ${a.status} ${a.claim}\n  Ref: ${a.reference || '(none)'}\n  Evidence: ${a.evidence || '(unverified)'}`)].join('\n')
  }
}
