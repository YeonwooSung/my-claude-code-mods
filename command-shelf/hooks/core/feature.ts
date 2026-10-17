import { bounded, outcome, restore, safeText, type Observation, type Port } from './runtime.ts'
type Entry = { id: number; command: string; cwd: string; label: string }
const HELP = '/shelf [list | show <id> | pin <id> <label> | run <id> | remove <id> | reset] — only explicit run executes through Bash permissions.'
export class Feature {
  data: { nextId: number; commands: Entry[] }
  constructor(value?: unknown) { this.data = restore(value, { nextId: 1, commands: [] as Entry[] }) }
  async observe(e: Observation, io: Port): Promise<void> {
    if (e.tool !== 'Bash' || outcome(e.result) !== 'pass') return
    const command = e.input.command
    if (typeof command !== 'string' || !command.trim() || command.length > 4000 || safeText(command) !== command || safeText(io.cwd) !== io.cwd) return
    if (this.data.commands.some(c => c.command === command && c.cwd === io.cwd)) return
    this.data.commands = bounded([...this.data.commands, { id: this.data.nextId++, command, cwd: io.cwd, label: '' }])
  }
  async command(args: string, io: Port): Promise<string> {
    const [verb, idText, ...rest] = args.trim().split(/\s+/)
    if (verb === 'help') return HELP
    if (!verb || verb === 'list') return ['Command Shelf — successful foreground commands, latest 200; environment is not captured.', ...this.data.commands.map(c => `#${c.id} ${c.label ? c.label + ' — ' : ''}${c.command}\n  cwd: ${c.cwd}`)].join('\n')
    const entry = this.data.commands.find(c => c.id === Number(idText))
    if (!['show', 'pin', 'run', 'remove'].includes(verb)) return 'Usage: ' + HELP
    if (!entry) return 'Command not found'
    if (verb === 'pin') { const label = rest.join(' '); if (!label) return 'Usage: /shelf pin <id> <label>'; entry.label = safeText(label, 500) }
    if (verb === 'remove') { this.data.commands = this.data.commands.filter(c => c !== entry); return 'Command removed' }
    if (verb === 'run') {
      if (entry.cwd !== io.cwd) return 'Refusing replay in a different project'
      if (safeText(entry.command) !== entry.command) return 'Refusing replay of a masked command'
      if (!io.replay) return 'Replay unavailable in this host'
      const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"
      const result = await io.replay(`cd -- ${quote(entry.cwd)} && ${entry.command}`)
      return outcome(result) === 'pass' ? `Command #${entry.id} completed` : `Command #${entry.id} not completed successfully; inspect Bash result`
    }
    return `#${entry.id} ${entry.label}\n${entry.command}\ncwd: ${entry.cwd}\nEnvironment values are not captured; review before /shelf run ${entry.id}`
  }
}
