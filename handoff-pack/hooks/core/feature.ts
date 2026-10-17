import { bounded, isCheck, object, outcome, restore, safeText, statusPaths, type Observation, type Port } from './runtime.ts'
type Todo = { id: number; text: string; done: boolean }
type Check = { command: string; result: string; revision?: string; changed: boolean }
export class Feature {
  data: { goal: string; nextId: number; todos: Todo[]; notes: string[]; failures: string[]; checks: Check[] }
  constructor(value?: unknown) { this.data = restore(value, { goal: '', nextId: 1, todos: [] as Todo[], notes: [] as string[], failures: [] as string[], checks: [] as Check[] }) }
  async observe(e: Observation, _io: Port): Promise<void> {
    if (e.tool !== 'Bash' || object(e.result).deny !== undefined) return
    const command = safeText(e.input.command, 1000), result = outcome(e.result)
    if (result === 'fail') this.data.failures = bounded([...this.data.failures, command + ' — ' + safeText(object(e.result).text ?? '(no output captured)', 500)])
    if (isCheck(String(e.input.command ?? ''))) this.data.checks = bounded([...this.data.checks.filter(c => c.command !== command), { command, result, revision: e.before, changed: e.before !== e.after }])
  }
  async command(args: string, io: Port): Promise<string> {
    const [verb, ...rest] = args.trim().split(/\s+/); const text = rest.join(' ')
    if (verb === 'help') return '/handoff [goal <text> | todo <text> | done <id> | note <text> | preview | reset] — Markdown preview only; no automatic file export.'
    if (verb === 'goal' && text) this.data.goal = safeText(text, 2000)
    else if (verb === 'todo' && text) this.data.todos = bounded([...this.data.todos, { id: this.data.nextId++, text: safeText(text, 1000), done: false }])
    else if (verb === 'note' && text) this.data.notes = bounded([...this.data.notes, safeText(text, 1000)])
    else if (verb === 'done') { const todo = this.data.todos.find(t => t.id === Number(text)); if (!todo) return 'Todo not found'; todo.done = true }
    else if (verb && verb !== 'preview') return 'Usage: /handoff [goal <text> | todo <text> | done <id> | note <text> | preview | reset]'
    let paths: string[] = [], unavailable = false
    try { paths = await statusPaths(io) } catch { unavailable = true }
    const current = await io.revision()
    return ['# Handoff Pack', '', '## Goal', this.data.goal || '(not set)', '', '## Changed files', ...paths.slice(0, 200).map(p => '- ' + safeText(p)), ...(unavailable || paths.length > 200 ? ['INCOMPLETE: changed files unavailable or limited'] : []), '', '## Tasks', ...this.data.todos.map(t => `- [${t.done ? 'x' : ' '}] #${t.id} ${t.text}`), '', '## Verification (observed only)', ...this.data.checks.map(c => `${c.result === 'fail' ? 'FAIL' : c.result !== 'pass' || !c.revision || !current ? 'UNKNOWN' : c.changed || current !== c.revision ? 'STALE' : 'PASS'} ${c.command}`), '', '## Failed approaches (latest 200)', ...this.data.failures.map(f => '- ' + f), '', '## Notes', ...this.data.notes.map(n => '- ' + n)].join('\n')
  }
}
