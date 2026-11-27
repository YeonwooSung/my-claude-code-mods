import type { EngineInterface, Register } from 'claude-code'
import { hash, object, revision, safeText, safeData, reportText, type Observation, type Port } from './core/runtime.ts'
export interface Model { data: object; command(args: string, io: Port): Promise<string>; observe?(event: Observation, io: Port): Promise<void> }
import { Feature } from './core/feature.ts'
const name = 'review-queue'
const command = 'review-queue'
type AdapterState = { queue: Promise<unknown>; replaying: boolean; writeVersion: number; observationFailure?: { session: string; message: string } }
const state: AdapterState = { queue: Promise.resolve(), replaying: false, writeVersion: 0 }
const observesTools = 'observe' in Feature.prototype
const observer = Feature as typeof Feature & { observedTools?: readonly string[]; acceptsObservation?: (event: Observation, cwd: string) => boolean }
class StateError extends Error { readonly writeVersion = state.writeVersion }
function storageError(operation: 'read' | 'write', error: unknown): StateError {
  const text = error instanceof Error ? error.message : String(error)
  // Fixed categories keep raw commands, stored JSON and credentials out of notifications.
  const reason = /key.*(?:256|limit|too long)/i.test(text) ? 'storage key limit exceeded'
    : /4194304|4\s*MiB|quota|store.*(?:exceed|too large)/i.test(text) ? 'plugin store quota exceeded'
    : /ENOSPC|disk full/i.test(text) ? 'disk full'
    : /EACCES|EPERM|permission denied/i.test(text) ? 'storage permission denied'
    : /JSON|parse|corrupt|unexpected token/i.test(text) ? 'invalid storage data' : undefined
  return new StateError(`${operation === 'read' ? 'state unavailable' : 'state not saved'}: store ${operation} unavailable${reason ? ` (${reason})` : ''}`)
}
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const work = state.queue.then(fn); state.queue = work.catch(() => {}); return work
}
const port = async ($: EngineInterface): Promise<Port> => {
  const cwd = await $.session.cwd()
  const unavailable = async (): Promise<never> => { throw new Error('Capability not used by this feature') }
  const io: Port = { cwd, read: unavailable, run: unavailable, env: unavailable, revision: async () => undefined }
  io.read = async path => await $.fs.read(path)
  io.bytes = async path => (await $.fs.read(path, { as: 'bytes' })).base64
  io.stat = path => $.fs.stat(path)
  io.run = argv => {
    if (argv[0] !== 'git') throw new Error('Only local Git evidence commands are supported')
    return $.process.run(['git', ...argv.slice(1)], { cwd, timeoutMs: 10_000 })
  }
  return io
}
const identity = ($: EngineInterface) => Promise.all([$.session.cwd(), $.session.id()])
const transact = async ($: EngineInterface, fn: (model: Model, io: Port) => Promise<string | void>, expected: string[], forceSave = false): Promise<string> => serial(async () => {
  const [io, id] = await Promise.all([port($), $.session.id()])
  if (io.cwd !== expected[0] || id !== expected[1]) return 'Session changed; operation not applied'
  const session = JSON.stringify([io.cwd, id])
  const key = `${name}:v1:${hash(session)}`
  const read = async (key: string) => { try { return await $.store.get(key) } catch (error) { throw storageError('read', error) } }
  let raw = await read(key)
  // Legacy keys can exceed the host limit; only readable keys may be queried.
  const legacyKey = `${name}:v1:${session}`
  if (raw === undefined && legacyKey.length <= 256) raw = await read(legacyKey)
  const loaded = await identity($)
  if (loaded[0] !== expected[0] || loaded[1] !== expected[1]) return 'Session changed; operation not applied'
  const model = new Feature(raw)
  const previous = JSON.stringify(safeData(model.data))
  const result = await fn(model, io)
  // No raw event payloads reach storage. Keep the serialized state bounded.
  const serialized = JSON.stringify(safeData(model.data))
  if (forceSave || serialized !== previous) {
    if (serialized.length > 256 * 1024) throw new StateError('state limit exceeded; not saved')
    try { await $.store.set(key, JSON.parse(serialized)) }
    catch (error) { throw storageError('write', error) }
    state.writeVersion++
    if (state.observationFailure?.session === session) state.observationFailure = undefined
  }
  return reportText(result ?? '')
})
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    state.observationFailure = undefined
    try { await $.command.register({ name: command, description: `${name}: /${command} help` }) } catch { /* Startup still forwards. */ }
    return next(e)
  })
  on('command.run', { command }, async ($, e) => {
    try {
      const expected = await identity($)
      const text = await transact($, async (model, io) => {
        if ((e.args ?? '').trim() === 'reset') { model.data = new Feature().data; return `${name}: records reset` }
        return model.command(e.args ?? '', io)
    }, expected, (e.args ?? '').trim() === 'reset')
      const warning = state.observationFailure?.session === JSON.stringify(expected) ? state.observationFailure.message : undefined
      return { text: warning ? `${text}\nWARNING: ${warning}. Recent observations were not saved.` : text }
    } catch (error) { return { text: `${name}: ${safeText(error instanceof Error ? error.message : error)}` } }
  })
  on('tool.call', async ($, e, next) => {
    const ownReplay = state.replaying && (next.origin?.plugin === name || next.origin?.plugin.startsWith(name + '@'))
    if (!observesTools || ownReplay || (observer.observedTools && !observer.observedTools.includes(String(e.tool)))) return next(e)
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
      const observation = { tool: e.tool, input: object(e), result, before }
      if (observer.acceptsObservation && !observer.acceptsObservation(observation, expected[0]!)) return result
      await transact($, async (model, io) => {
        const after = before !== undefined ? await io.revision() : undefined
        try { await model.observe?.({ ...observation, after }, io) }
        catch { throw new StateError('observer unavailable') }
      }, expected)
    } catch (error) {
      const failedVersion = error instanceof StateError ? error.writeVersion : state.writeVersion
      const current = await identity($).catch(() => undefined)
      if (failedVersion !== state.writeVersion || !expected || !current || current[0] !== expected[0] || current[1] !== expected[1]) return result
      const session = JSON.stringify(expected)
      const alreadyWarned = state.observationFailure?.session === session
      const message = error instanceof StateError ? error.message
        : error instanceof Error && error.message === 'state limit exceeded; not saved' ? error.message : 'observer unavailable'
      state.observationFailure = { session, message }
      if (!alreadyWarned) try { $.ui.toast(`${name}: observation not saved — ${message}. Use /${command} for details.`) } catch { /* Noninteractive host. */ }
    }
    return result
  })
}
