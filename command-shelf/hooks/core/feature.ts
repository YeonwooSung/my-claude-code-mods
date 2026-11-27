import { bounded, outcome, restore, safeText, type Observation, type Port } from './runtime.ts'
type Entry = { id: number; command: string; cwd: string; label: string }
// Leave room below the adapter's 256 KiB state limit, also for UTF-8 and labels.
const MAX_HISTORY_BYTES = 240 * 1024
const encoder = new TextEncoder()
const HELP = '/shelf [list | show <id> | pin <id> <label> | run <id> | remove <id> | reset] — only explicit run executes through Bash permissions.'
export class Feature {
  static readonly observedTools = ['Bash']
  static acceptsObservation(e: Observation, cwd: string): boolean {
    const command = e.input.command
    return e.tool === 'Bash' && outcome(e.result) === 'pass' && typeof command === 'string'
      && command.trim() !== '' && command.length <= 4000 && safeText(command) === command && safeText(cwd) === cwd
  }
  data: { nextId: number; commands: Entry[] }
  constructor(value?: unknown) { this.data = restore(value, { nextId: 1, commands: [] as Entry[] }) }
  private fitHistory(keepId?: number): void {
    const sizes = this.data.commands.map(entry => encoder.encode(JSON.stringify(entry)).length + 1)
    let bytes = encoder.encode(JSON.stringify({ nextId: this.data.nextId, commands: [] })).length + sizes.reduce((a, b) => a + b, 0)
    // Evict oldest entries; never evict the entry a user is currently labelling.
    this.data.commands = this.data.commands.filter((entry, i) => {
      if (bytes <= MAX_HISTORY_BYTES || entry.id === keepId) return true
      bytes -= sizes[i]!
      return false
    })
  }
  async observe(e: Observation, io: Port): Promise<void> {
    if (!Feature.acceptsObservation(e, io.cwd)) return
    const command = e.input.command as string
    if (!this.data.commands.some(c => c.command === command && c.cwd === io.cwd))
      this.data.commands = bounded([...this.data.commands, { id: this.data.nextId++, command, cwd: io.cwd, label: '' }])
    this.fitHistory()
  }
  async command(args: string, io: Port): Promise<string> {
    const [verb, idText, ...rest] = args.trim().split(/\s+/)
    if (verb === 'help') return HELP
    if (!verb || verb === 'list') return ['Command Shelf — successful foreground commands, up to 200 / 240 KiB; environment is not captured.', ...this.data.commands.map(c => `#${c.id} ${c.label ? c.label + ' — ' : ''}${c.command}\n  cwd: ${c.cwd}`)].join('\n')
    const entry = this.data.commands.find(c => c.id === Number(idText))
    if (!['show', 'pin', 'run', 'remove'].includes(verb)) return 'Usage: ' + HELP
    if (!entry) return 'Command not found'
    if (verb === 'pin') { const label = rest.join(' '); if (!label) return 'Usage: /shelf pin <id> <label>'; entry.label = safeText(label, 500); this.fitHistory(entry.id) }
    if (verb === 'remove') { this.data.commands = this.data.commands.filter(c => c !== entry); this.fitHistory(); return 'Command removed' }
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
