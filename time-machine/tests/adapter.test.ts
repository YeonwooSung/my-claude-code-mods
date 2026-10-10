import type { On } from 'claude-code'
import { type Engine, expect, mock, test } from 'claude-code/testing'

import { branchTaken } from '../hooks/core/timeline.ts'

const PYTEST_FAIL = `FAILED tests/test_auth.py::test_login - AssertionError\ntests/test_auth.py:12: AssertionError\n========================= 1 failed, 4 passed in 0.10s =========================`

// The runner's `$` has no `process`, so git is unavailable here: these tests run the "snapshots off" path.
function world(on: On, writes: Map<string, string>, toolAnswer?: (e: { tool: string; tool_use_id?: string }) => unknown): void {
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
    if (toolAnswer) return toolAnswer(e as never) as never
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
  expect(await run('restore 1 --yes', 'channel')).toBe('time-machine: restore changes files or runs commands and only runs when you type it (this came from channel)')
  expect(await run('rerun 2 --write', 'scheduled-trigger')).toContain('rerun changes files or runs commands and only runs when you type it (this came from scheduled-trigger)')
  expect(await run('rerun 2 --isolated --yes', 'channel')).toContain('rerun changes files or runs commands and only runs when you type it (this came from channel)')
  expect(await run('rerun 1', 'peer-send-message')).toBe('time-machine: rerun changes files or runs commands and only runs when you type it (this came from peer-send-message)')
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

test('branch names are taken case-insensitively, since refs are files', () => {
  const rec = { branches: new Map([['main', { name: 'main', fromStep: 0, at: 0 }], ['b1', { name: 'b1', fromStep: 2, at: 1 }]]) }
  expect(branchTaken(rec, 'Main')).toBe(true)
  expect(branchTaken(rec, 'B1')).toBe(true)
  expect(branchTaken(rec, 'b2')).toBe(false)
})

test('/tm rerun --isolated without --yes is a dry run that shows the command first, from any origin', async ($, on) => {
  await recordSome($, on, new Map())
  const text = String((await $.command.run({ command: 'tm', args: 'rerun 2 --isolated', origin: { kind: 'channel' } } as never)).text)
  expect(text.split('\n')[0]).toBe('$ pytest -q')
  expect(text).toContain('Dry run')
  expect(text).toContain('--yes')
})

test('/tm rerun --isolated --yes refuses a command that names the project root', async ($, on) => {
  world(on, new Map())
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  await $.tool.call({ tool: 'Bash', command: 'pytest /r/tests', tool_use_id: 't1' } as never)
  const text = String((await $.command.run({ command: 'tm', args: 'rerun 1 --isolated --yes', origin: { kind: 'composer' } } as never)).text)
  expect(text).toBe("$ pytest /r/tests\ntime-machine: the command refers to the project's absolute path, so it would not be isolated")
})

test('a store inside the project turns snapshots off, and says so', { options: { storeDir: '/r/.tm' } }, async ($, on) => {
  await recordSome($, on, new Map())
  expect(String((await $.command.run({ command: 'tm', args: '' } as never)).text)).toContain('snapshots off: the time-machine store is inside the project')
})

test('a relative store turns snapshots off, and says so', { options: { storeDir: 'tm-store' } }, async ($, on) => {
  await recordSome($, on, new Map())
  expect(String((await $.command.run({ command: 'tm', args: '' } as never)).text)).toContain('snapshots off: storeDir must be an absolute path')
})

// Git answered from memory through `process.run`: every tree differs, so every check sees a change.
function fakeGit(on: On): void {
  let k = 0
  on('process.run', (_$, e) => {
    const args = e.argv.slice(e.argv.indexOf('core.quotepath=off') + 1)
    const sub = args[0] === 'rev-parse' && args[1] === '--verify' ? 'verify' : args[0]
    k += 1
    const out =
      sub === 'verify' ? { exitCode: 1, stdout: '' }
      : sub === 'write-tree' ? { exitCode: 0, stdout: `tree${k}\n` }
      : sub === 'rev-parse' ? { exitCode: 0, stdout: 'old\n' }
      : sub === 'commit-tree' ? { exitCode: 0, stdout: `c${k}\n` }
      : sub === 'diff' ? { exitCode: 0, stdout: 'M\tx.js\n' }
      : { exitCode: 0, stdout: '' }
    return { value: { ...out, stderr: '' } } as never
  })
}

test('parallel mutating calls check for external changes once, before the first of them', async ($, on) => {
  world(on, new Map())
  fakeGit(on)
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  await Promise.all([
    $.tool.call({ tool: 'Edit', file_path: '/r/a.js', old_string: 'a', new_string: 'b', tool_use_id: 'e1' } as never),
    $.tool.call({ tool: 'Edit', file_path: '/r/b.js', old_string: 'a', new_string: 'b', tool_use_id: 'e2' } as never),
  ])
  const text = String((await $.command.run({ command: 'tm', args: 'timeline' } as never)).text)
  expect(text).not.toContain('snapshots off')
  expect(text.split('\n').filter(l => l.includes('external change')).length).toBe(1)
})

test('/tm rerun of a subagent, skill or message step needs --write, as it can change files once run again', async ($, on) => {
  world(on, new Map())
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  await $.tool.call({ tool: 'Agent', description: 'fix', prompt: 'fix the tests', tool_use_id: 'a1' } as never)
  const text = String((await $.command.run({ command: 'tm', args: 'rerun 1', origin: { kind: 'composer' } } as never)).text)
  expect(text).toBe('time-machine: step 1 (Agent) can change files; add --write to run it again here (a snapshot is taken after it)')
})

test("a parallel mutating call waits for the external check in progress, so its writes are not counted in it", async ($, on) => {
  const log: string[] = []
  world(on, new Map(), e => {
    log.push(`tool ${String(e.tool_use_id)}`)
    return { result: {}, text: 'ok' }
  })
  let k = 0
  on('process.run', async (_$, e) => {
    const args = e.argv.slice(e.argv.indexOf('core.quotepath=off') + 1)
    const sub = args[0] === 'rev-parse' && args[1] === '--verify' ? 'verify' : args[0]
    k += 1
    if (sub === 'add') {
      log.push('add')
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    }
    const out =
      sub === 'verify' ? { exitCode: 1, stdout: '' }
      : sub === 'write-tree' ? { exitCode: 0, stdout: `tree${k}\n` }
      : sub === 'rev-parse' ? { exitCode: 0, stdout: 'old\n' }
      : sub === 'commit-tree' ? { exitCode: 0, stdout: `c${k}\n` }
      : sub === 'diff' ? { exitCode: 0, stdout: 'M\tx.js\n' }
      : { exitCode: 0, stdout: '' }
    return { value: { ...out, stderr: '' } } as never
  })
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  await $.tool.call({ tool: 'Read', file_path: '/r/a.js', tool_use_id: 'r0' } as never)
  log.length = 0
  await Promise.all([
    $.tool.call({ tool: 'Edit', file_path: '/r/a.js', old_string: 'a', new_string: 'b', tool_use_id: 'e1' } as never),
    $.tool.call({ tool: 'Edit', file_path: '/r/b.js', old_string: 'a', new_string: 'b', tool_use_id: 'e2' } as never),
  ])
  // The baseline's and the check's `add` both come before either edit runs.
  expect(log.slice(0, 2)).toEqual(['add', 'add'])
  expect(log.slice(2, 4).sort()).toEqual(['tool e1', 'tool e2'])
})

test('one failed snapshot skips that snapshot without turning snapshots off', async ($, on) => {
  world(on, new Map())
  let k = 0
  let failed = false
  on('process.run', (_$, e) => {
    const args = e.argv.slice(e.argv.indexOf('core.quotepath=off') + 1)
    const sub = args[0] === 'rev-parse' && args[1] === '--verify' ? 'verify' : args[0]
    k += 1
    if (sub === 'write-tree' && k > 8 && !failed) {
      failed = true
      return { value: { exitCode: 128, stdout: '', stderr: 'fatal: timed out\n' } } as never
    }
    const out =
      sub === 'verify' ? { exitCode: 1, stdout: '' }
      : sub === 'write-tree' ? { exitCode: 0, stdout: `tree${k}\n` }
      : sub === 'rev-parse' ? { exitCode: 0, stdout: 'old\n' }
      : sub === 'commit-tree' ? { exitCode: 0, stdout: `c${k}\n` }
      : { exitCode: 0, stdout: '' }
    return { value: { ...out, stderr: '' } } as never
  })
  await $.session.start({ cwd: '/r', surface: null, isInteractive: false } as never)
  for (const id of ['e1', 'e2', 'e3']) await $.tool.call({ tool: 'Edit', file_path: '/r/a.js', old_string: 'a', new_string: 'b', tool_use_id: id } as never)
  expect(failed).toBe(true)
  const text = String((await $.command.run({ command: 'tm', args: 'timeline' } as never)).text)
  expect(text).not.toContain('snapshots off')
})
