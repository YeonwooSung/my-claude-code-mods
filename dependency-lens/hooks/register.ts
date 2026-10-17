import type { EngineInterface, Register } from 'claude-code'
import { object, revision, safeText, safeData, reportText, type Observation, type Port } from './core/runtime.ts'
export interface Model { data: object; command(args: string, io: Port): Promise<string>; observe?(event: Observation, io: Port): Promise<void> }
import { Feature } from './core/feature.ts'
const name = 'dependency-lens'
const command = 'deps'
type AdapterState = { queue: Promise<unknown>; replaying: boolean }
const state: AdapterState = { queue: Promise.resolve(), replaying: false }
const observesTools = 'observe' in Feature.prototype
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const work = state.queue.then(fn); state.queue = work.catch(() => {}); return work
}
const port = async ($: EngineInterface): Promise<Port> => {
  const cwd = await $.session.cwd()
  const io: Port = {
    cwd,
    read: async path => await $.fs.read(path),
    bytes: async path => (await $.fs.read(path, { as: 'bytes' })).base64,
    stat: path => $.fs.stat(path),
    list: async path => (await $.fs.list(path)).map(entry => entry.name),
    run: argv => $.process.run(argv, { cwd, timeoutMs: 10_000 }),
    env: async key => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('invalid environment variable name')
      const r = await $.process.run(['node', '-e', 'process.stdout.write(process.env[process.argv[1]] ? "set" : "")', key], { cwd, timeoutMs: 10_000 })
      if (r.exitCode !== 0) throw new Error('environment presence unavailable')
      return r.stdout === 'set' ? 'set' : undefined
    },
    revision: () => revision(io),
    replay: async text => {
      state.replaying = true
      try { return await $.tool.call({ tool: 'Bash', command: text, description: 'Replay explicitly selected Command Shelf entry' }) }
      finally { state.replaying = false }
    },
  }
  return io
}
const identity = ($: EngineInterface) => Promise.all([$.session.cwd(), $.session.id()])
const transact = async ($: EngineInterface, fn: (model: Model, io: Port) => Promise<string | void>, expected: string[], forceSave = false): Promise<string> => serial(async () => {
  const [io, id] = await Promise.all([port($), $.session.id()])
  if (io.cwd !== expected[0] || id !== expected[1]) return 'Session changed; operation not applied'
  const key = `${name}:v1:${JSON.stringify([io.cwd, id])}`
  const raw = await $.store.get(key)
  const loaded = await identity($)
  if (loaded[0] !== expected[0] || loaded[1] !== expected[1]) return 'Session changed; operation not applied'
  const model = new Feature(raw)
  const previous = JSON.stringify(safeData(model.data))
  const result = await fn(model, io)
  // No raw event payloads reach storage. Keep the serialized state bounded.
  const serialized = JSON.stringify(safeData(model.data))
  if (forceSave || serialized !== previous) {
    if (serialized.length > 256 * 1024) throw new Error('state limit exceeded; not saved')
    try { await $.store.set(key, JSON.parse(serialized)) }
    catch { throw new Error('state not saved; retry after storage recovers') }
  }
  return reportText(result ?? '')
})
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try { await $.command.register({ name: command, description: `${name}: /${command} help` }) } catch { /* Startup still forwards. */ }
    return next(e)
  })
  on('command.run', { command }, async ($, e) => {
    try {
      const expected = await identity($)
      return { text: await transact($, async (model, io) => {
        if ((e.args ?? '').trim() === 'reset') { model.data = new Feature().data; return `${name}: records reset` }
        return model.command(e.args ?? '', io)
    }, expected, (e.args ?? '').trim() === 'reset') } } catch (error) { return { text: `${name}: ${safeText(error instanceof Error ? error.message : error)}` } }
  })
  on('tool.call', async ($, e, next) => {
    const ownReplay = state.replaying && (next.origin?.plugin === name || next.origin?.plugin.startsWith(name + '@'))
    if (!observesTools || ownReplay) return next(e)
    const expected = await identity($).catch(() => undefined)
    let before: string | undefined
    if (['verify-board', 'handoff-pack'].includes(name) && e.tool === 'Bash') {
      try { before = await (await port($)).revision() } catch { /* Unknown evidence. */ }
    }
    // next runs outside observation catch: an observer never retries a tool or hides its exception.
    const result = await next(e)
    try {
      const now = await Promise.all([$.session.cwd(), $.session.id()])
      if (!expected || expected[0] !== now[0] || expected[1] !== now[1]) return result
      await transact($, async (model, io) => {
        const after = before !== undefined ? await io.revision() : undefined
        await model.observe?.({ tool: e.tool, input: object(e), result, before, after }, io)
      }, expected)
    } catch { try { $.ui.toast(`${name}: observation not saved`) } catch { /* Noninteractive host. */ } }
    return result
  })
}
