import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

const PYTEST_FAIL = `FAILED tests/test_auth.py::test_login - AssertionError\ntests/test_auth.py:12: AssertionError\n========================= 1 failed, 4 passed in 0.10s =========================`

// The runner's `$` has no `process`, so git is unavailable here: these tests run the "snapshots off" path.
function world(on: On, writes: Map<string, string>): void {
  mock.env(on, { HOME: '/Users/u' })
  mock.store(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.root', () => ({ value: '/r' }))
  on('session.cwd', () => ({ value: '/r' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_$, e) => {
    writes.set(e.path, e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('session.start', () => ({ cwd: '/r' }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash') return { result: {}, isError: true, text: PYTEST_FAIL } as never
    if (e.tool === 'Write') return { deny: 'not allowed' } as never
    if (e.tool === 'WebSearch') throw new Error('boom')
    return { result: {}, text: 'file body' } as never
  })
}

async function recordSome($: Engine, on: On, writes: Map<string, string>) {
  world(on, writes)
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  await $.tool.call({ tool: 'Read', file_path: '/r/auth.py', tool_use_id: 't1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pytest -q', tool_use_id: 't2' } as never)
}

test('tool.call relays the answer unchanged, deny included', async ($, on) => {
  world(on, new Map())
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  const denied = await $.tool.call({ tool: 'Write', file_path: '/r/x', content: 'y', tool_use_id: 't9' } as never)
  expect(denied.deny).toBe('not allowed')
})

test('/tm draws the timeline and says why snapshots are off', async ($, on) => {
  await recordSome($, on, new Map())
  const text = String((await $.command.run({ command: 'tm', args: '' } as never)).text)
  expect(text).toContain('snapshots off:')
  expect(text).toContain('├── ① Read auth.py')
  expect(text).toContain('└── ② Bash pytest -q')
  expect(text).toContain('✗ 1 failed, 4 passed')
})

test('/tm show, /tm why, /tm restore and an unknown subcommand', async ($, on) => {
  await recordSome($, on, new Map())
  const run = async (args: string): Promise<string> => String((await $.command.run({ command: 'tm', args } as never)).text)
  expect(await run('show 2')).toContain('command: pytest -q')
  const why = await run('why')
  expect(why).toContain('Why did ② Bash pytest -q fail?')
  expect(why).toContain('tests/test_auth.py::test_login')
  expect(await run('restore 1')).toContain('snapshots are off')
  expect(await run('show 99')).toContain('no step 99')
  expect(await run('bogus')).toContain('/tm [timeline')
})

test('the timeline is persisted as JSONL in the session folder, with a meta file', async ($, on) => {
  const writes = new Map<string, string>()
  await recordSome($, on, writes)
  const dir = [...writes.keys()].find(p => p.endsWith('/meta.json'))!
  expect(dir).toMatch(/^\/Users\/u\/\.claude\/time-machine\/r-[0-9a-f]{8}\/sessions\/sess-1\/meta\.json$/)
  const chunk = [...writes.entries()].find(([p]) => p.endsWith('.jsonl'))!
  const types = chunk[1].trim().split('\n').map(l => (JSON.parse(l) as { type: string }).type)
  expect(types).toEqual(['session', 'step', 'step', 'step'])
})

test('turn.step chunks reach the caller unchanged', async ($, on) => {
  world(on, new Map())
  const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'hi' }
    yield { kind: 'tool', index: 1, id: 'x', name: 'Read' }
    yield { kind: 'stop', stopReason: 'tool_use', usage }
    return { turnId: 't1', index: 0, answer: 'hi', toolUses: [], stopReason: 'tool_use', usage }
  })
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  const kinds: string[] = []
  for await (const chunk of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 })) kinds.push(chunk.kind)
  expect(kinds).toEqual(['text', 'tool', 'stop'])
})

test('a tool call that throws is still recorded as a finished, failed step, and the error reaches the caller', async ($, on) => {
  const writes = new Map<string, string>()
  world(on, writes)
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  let thrown = ''
  try {
    await $.tool.call({ tool: 'WebSearch', query: 'q', tool_use_id: 't3' } as never)
  } catch (error) {
    thrown = String(error)
  }
  // The runner turns a throwing mock into a HooksError beneath the plugin: next(e) throws either way.
  expect(thrown).toContain('Error')
  const chunk = [...writes.entries()].find(([p]) => p.endsWith('.jsonl'))!
  const steps = chunk[1].trim().split('\n').map(l => JSON.parse(l) as { type: string; tool?: string; endedAt?: number; result?: { isError: boolean } })
  const search = steps.find(r => r.type === 'step' && r.tool === 'WebSearch')!
  expect(search.endedAt).toBeDefined()
  expect(search.result?.isError).toBe(true)
})

test('/tm restore --yes runs only from an origin a person typed', async ($, on) => {
  await recordSome($, on, new Map())
  const run = async (args: string, kind: string): Promise<string> =>
    String((await $.command.run({ command: 'tm', args, origin: { kind } } as never)).text)
  expect(await run('restore 1 --yes', 'channel')).toBe('time-machine: restore changes files or runs commands and only runs when you type it')
  expect(await run('rerun 2 --write', 'scheduled-trigger')).toContain('rerun changes files or runs commands')
  expect(await run('restore 1', 'channel')).toContain('snapshots are off')
  expect(await run('restore 1 --yes', 'composer')).toContain('snapshots are off')
})

test('each session start in one module load writes chunks under its own names', async ($, on) => {
  const writes = new Map<string, string>()
  world(on, writes)
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  const names = [...writes.keys()].filter(p => p.endsWith('.jsonl')).map(p => p.slice(p.lastIndexOf('/') + 1))
  expect(names.length).toBe(2)
  expect(names[0]! < names[1]!).toBe(true)
})
