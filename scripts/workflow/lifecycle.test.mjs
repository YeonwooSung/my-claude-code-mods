import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register as verify } from '../../verify-board/hooks/register.ts'
import { register as scope } from '../../scope-guard/hooks/register.ts'
import { register as blast } from '../../blast-radius/hooks/register.ts'
import { register as decision } from '../../decision-ledger/hooks/register.ts'
import { register as handoff } from '../../handoff-pack/hooks/register.ts'
import { register as shelf } from '../../command-shelf/hooks/register.ts'
import { register as doctor } from '../../env-doctor/hooks/register.ts'
import { register as deps } from '../../dependency-lens/hooks/register.ts'
import { register as assume } from '../../assumption-tracker/hooks/register.ts'
import { register as review } from '../../review-queue/hooks/register.ts'

const modules = [['verify-board', verify], ['scope-guard', scope], ['blast-radius', blast], ['decision-ledger', decision], ['handoff-pack', handoff], ['command-shelf', shelf], ['env-doctor', doctor], ['dependency-lens', deps], ['assumption-tracker', assume], ['review-queue', review]]
const success = () => ({ result: { stdout: '', stderr: '', interrupted: false } })
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

// Only the host boundary is controlled. Each real adapter and Feature executes unchanged.
// Structured clones mirror engine store message boundaries rather than sharing mutable objects.
function host(selected = modules, underlying = async () => success()) {
  const hooks = [], saved = new Map(), commands = new Map(), toasts = [], calls = []
  const controls = { id: 'A', cwd: '/repo', status: '', failGet: false, failSet: false, failIdentity: false, beforeGet: undefined }
  const counts = { get: 0, set: 0 }
  const key = (name, id = controls.id) => `${name}:v1:${JSON.stringify([controls.cwd, id])}`
  const dispatch = async (event, input, origin = { plugin: 'engine', tier: 'core' }) => {
    const chain = hooks.filter(h => h.event === event && (!h.filter || Object.entries(h.filter).every(([key, value]) => input[key] === value)))
    const invoke = async (index, value) => {
      if (index === chain.length) {
        if (event === 'tool.call') { calls.push(value); return underlying(value) }
        return event === 'session.start' ? { cwd: controls.cwd } : { text: '(unhandled)' }
      }
      const link = chain[index], next = nextValue => invoke(index + 1, nextValue)
      next.origin = origin
      return link.handler(context(link.owner), value, next)
    }
    return invoke(0, input)
  }
  const context = owner => ({
    session: { cwd: async () => { if (controls.failIdentity) throw new Error('identity unavailable'); return controls.cwd }, id: async () => { if (controls.failIdentity) throw new Error('identity unavailable'); return controls.id } },
    store: {
      get: async name => { counts.get++; if (controls.beforeGet) await controls.beforeGet(name); if (controls.failGet) throw new Error('read unavailable'); return structuredClone(saved.get(name)) },
      set: async (name, value) => { counts.set++; if (controls.failSet) throw new Error('disk full'); saved.set(name, structuredClone(value)) },
    },
    command: { register: async spec => { if (commands.has(spec.name) && commands.get(spec.name) !== owner) throw new Error('command collision'); commands.set(spec.name, owner); return { command: spec.name } } },
    fs: { read: async (_path, options) => options?.as === 'bytes' ? { base64: '' } : '{}', list: async () => [], stat: async () => ({ kind: 'file', size: 0, mtimeMs: 0, isLink: false }) },
    process: { run: async argv => ({ exitCode: 0, stdout: argv.includes('--show-toplevel') ? controls.cwd + '\n' : argv.includes('rev-parse') ? 'a'.repeat(40) + '\n' : argv.includes('status') ? controls.status : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }) },
    ui: { toast: message => toasts.push(message) },
    tool: { call: input => dispatch('tool.call', input, { plugin: owner, tier: 'append' }) },
  })
  for (const [owner, register] of selected) register((event, filter, handler) => hooks.push({ owner, event, filter: typeof filter === 'function' ? undefined : filter, handler: typeof filter === 'function' ? filter : handler }))
  return { controls, counts, saved, calls, commands, toasts, key, command: (command, args = '') => dispatch('command.run', { command, args }), tool: input => dispatch('tool.call', input), start: () => dispatch('session.start', { cwd: controls.cwd, surface: 'terminal', isInteractive: true }) }
}

test('all ten actual adapters compose in either order without command collisions or duplicate tools', async () => {
  for (const selected of [modules, [...modules].reverse()]) {
    const h = host(selected); await h.start()
    assert.deepEqual([...h.commands.keys()].sort(), ['verify', 'scope', 'blast', 'decision', 'handoff', 'shelf', 'env-doctor', 'deps', 'assume', 'review-queue'].sort())
    await h.command('scope', 'allow src')
    await h.tool({ tool: 'Bash', command: 'npm test' })
    assert.match((await h.command('verify')).text, /PASS npm test/)
    assert.match((await h.command('handoff')).text, /PASS npm test/)
    assert.match((await h.command('shelf')).text, /npm test/)
    await h.tool({ tool: 'Write', file_path: '/outside/a.ts' })
    assert.match((await h.command('scope')).text, /OUTSIDE \/outside\/a.ts/)
    h.controls.status = ' M src/a.ts\0'
    assert.match((await h.command('verify')).text, /STALE npm test/)
    assert.equal(h.calls.length, 2)
  }
})
test('read-only reports remain available when durable writes are unavailable', async () => {
  const h = host([['decision-ledger', decision]])
  await h.command('decision', 'add a.ts | saved-choice | rationale')
  const writes = h.counts.set; h.controls.failSet = true
  const report = await h.command('decision', 'list')
  assert.match(report.text, /saved-choice/)
  assert.equal(h.counts.set, writes)
})
test('command-only mods never read or write persistence while forwarding tools', async () => {
  const h = host([['blast-radius', blast]])
  h.controls.failGet = true
  const result = await h.tool({ tool: 'Read', file_path: '/repo/a.ts' })
  assert.deepEqual(result, success()); assert.equal(h.calls.length, 1)
  assert.equal(h.counts.get, 0); assert.equal(h.counts.set, 0); assert.equal(h.toasts.length, 0)
})
test('concurrent decision commands preserve all unique records and stable ids', async () => {
  const h = host([['decision-ledger', decision]])
  const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => h.command('decision', `add ${i}.ts | choice-${i} | reason`)))
  for (const reply of replies) assert.doesNotMatch(reply.text, /not saved|unavailable/)
  const data = h.saved.get(h.key('decision-ledger'))
  assert.equal(data.decisions.length, 12)
  assert.deepEqual(data.decisions.map(d => d.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  for (let i = 0; i < 12; i++) assert.ok(data.decisions.some(d => d.choice === `choice-${i}`))
})
test('failed writes preserve the previous durable document and later commands recover', async () => {
  const h = host([['command-shelf', shelf]])
  await h.tool({ tool: 'Bash', command: 'npm test' }); await h.command('shelf', 'pin 1 old-label')
  const before = structuredClone(h.saved.get(h.key('command-shelf')))
  h.controls.failSet = true
  assert.match((await h.command('shelf', 'pin 1 unsaved-label')).text, /not saved/)
  assert.deepEqual(h.saved.get(h.key('command-shelf')), before)
  h.controls.failSet = false
  assert.match((await h.command('shelf', 'pin 1 recovered-label')).text, /recovered-label/)
  assert.equal(h.saved.get(h.key('command-shelf')).commands[0].label, 'recovered-label')
})
test('failed reads never overwrite a durable document with empty defaults', async () => {
  const h = host([['decision-ledger', decision]])
  await h.command('decision', 'add a.ts | durable | reason')
  const before = structuredClone(h.saved.get(h.key('decision-ledger'))), writes = h.counts.set
  h.controls.failGet = true
  assert.match((await h.command('decision', 'add b.ts | lost | reason')).text, /read unavailable/)
  assert.equal(h.counts.set, writes); assert.deepEqual(h.saved.get(h.key('decision-ledger')), before)
  h.controls.failGet = false
  assert.match((await h.command('decision')).text, /durable/)
})
test('an underlying thrown tool propagates the original error exactly once', async () => {
  const original = new Error('tool exploded'), h = host([['scope-guard', scope]], async () => { throw original })
  await assert.rejects(h.tool({ tool: 'Write', file_path: '/repo/a.ts' }), error => error === original)
  assert.equal(h.calls.length, 1); assert.equal(h.counts.set, 0)
})
test('observation failure cannot change a denied tool result or execute it twice', async () => {
  const denied = { deny: 'permission required' }, h = host([['command-shelf', shelf]], async () => denied)
  h.controls.failGet = true
  assert.equal(await h.tool({ tool: 'Bash', command: 'npm test' }), denied)
  assert.equal(h.calls.length, 1); assert.equal(h.counts.set, 0)
})
test('unavailable session identity cannot expose old notes and recovers without losing them', async () => {
  const h = host([['decision-ledger', decision]])
  await h.command('decision', 'add a.ts | old-note | reason')
  h.controls.failIdentity = true
  const reply = await h.command('decision')
  assert.match(reply.text, /identity unavailable/); assert.doesNotMatch(reply.text, /old-note/)
  await h.tool({ tool: 'Bash', command: 'echo harmless' }); assert.equal(h.calls.length, 1)
  h.controls.failIdentity = false
  assert.match((await h.command('decision')).text, /old-note/)
})
test('a session change while the store read is pending cancels the mutation', async () => {
  const h = host([['decision-ledger', decision]]), entered = deferred(), release = deferred()
  h.controls.beforeGet = async () => { entered.resolve(); await release.promise }
  const pending = h.command('decision', 'add a.ts | belongs-to-A | reason')
  await entered.promise; h.controls.id = 'B'; release.resolve()
  assert.match((await pending).text, /Session changed/)
  assert.equal(h.saved.size, 0)
})
test('reset recovers malformed records but still requires a successful durable write', async () => {
  const h = host([['decision-ledger', decision]])
  h.saved.set(h.key('decision-ledger'), { nextId: 2, decisions: [null] })
  h.controls.failSet = true
  assert.match((await h.command('decision', 'reset')).text, /not saved/)
  assert.deepEqual(h.saved.get(h.key('decision-ledger')).decisions, [null])
  h.controls.failSet = false
  assert.match((await h.command('decision', 'reset')).text, /records reset/)
  assert.deepEqual(h.saved.get(h.key('decision-ledger')).decisions, [])
})
test('an unrelated Bash completion during explicit replay is still observed', async () => {
  const entered = deferred(), release = deferred(), externalRan = deferred()
  const h = host([['command-shelf', shelf]], async input => {
    if (input.command?.startsWith('cd -- ')) { entered.resolve(); await release.promise }
    if (input.command === 'echo concurrent') externalRan.resolve()
    return success()
  })
  await h.tool({ tool: 'Bash', command: 'npm test' })
  const replay = h.command('shelf', 'run 1'); await entered.promise
  const external = h.tool({ tool: 'Bash', command: 'echo concurrent' }); await externalRan.promise
  release.resolve(); await Promise.all([replay, external])
  assert.match((await h.command('shelf')).text, /echo concurrent/)
  assert.equal(h.calls.length, 3)
})
test('identical session ids in different project folders never share saved decisions', async () => {
  const h = host([['decision-ledger', decision]])
  await h.command('decision', 'add a.ts | project-A-only | reason')
  h.controls.cwd = '/other-project'
  assert.doesNotMatch((await h.command('decision')).text, /project-A-only/)
  await h.command('decision', 'add b.ts | project-B-only | reason')
  h.controls.cwd = '/repo'
  const report = (await h.command('decision')).text
  assert.match(report, /project-A-only/); assert.doesNotMatch(report, /project-B-only/)
})
