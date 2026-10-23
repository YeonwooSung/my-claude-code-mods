import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { register } from '../../env-doctor/hooks/register.ts'

const helper = fileURLToPath(new URL('../../env-doctor/hooks/env-presence.mjs', import.meta.url))

test('environment helper returns presence without exposing values, including empty variables', () => {
  for (const [name, env, expected, code] of [
    ['PROBE_VALUE', { PROBE_VALUE: 'YOUR_API_KEY' }, 'set', 0],
    ['PROBE_VALUE', { PROBE_VALUE: '' }, 'set', 0],
    ['PROBE_VALUE', {}, '', 0],
    ['INVALID-NAME', {}, '', 2],
  ]) {
    const result = spawnSync(process.execPath, [helper, name], { env, encoding: 'utf8' })
    assert.equal(result.stdout, expected)
    assert.equal(result.status, code)
    assert.doesNotMatch(result.stdout + result.stderr, /YOUR_API_KEY/)
  }
})

function doctor() {
  const hooks = [], runs = [], saved = new Map()
  register((event, matcher, callback) => hooks.push({ event, matcher: typeof matcher === 'function' ? undefined : matcher, callback: typeof matcher === 'function' ? matcher : callback }))
  const $ = {
    session: { cwd: async () => '/repo', id: async () => 's' },
    plugin: { root: fileURLToPath(new URL('../../env-doctor', import.meta.url)) },
    store: { get: async name => saved.get(name), set: async (name, value) => saved.set(name, structuredClone(value)) },
    fs: { read: async () => JSON.stringify({ engines: { node: '>=1.0.0', npm: '>=1.0.0', pnpm: '>=1.0.0', yarn: '>=1.0.0' } }) },
    process: { run: async argv => {
      runs.push(argv)
      if (argv.length === 2 && argv[1] === '--version') return { exitCode: 0, stdout: '1.2.3', stderr: '' }
      // Only the bundled program is executed, never arbitrary interpreter code.
      assert.equal(argv[0], 'node')
      assert.equal(argv[1], '--')
      assert.equal(argv[2], helper)
      const result = spawnSync(process.execPath, argv.slice(1), { env: { PROBE_VALUE: 'YOUR_API_KEY' }, encoding: 'utf8' })
      return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
    } },
  }
  return { runs, command: args => hooks.find(h => h.event === 'command.run').callback($, { args }, () => { throw new Error('unexpected next') }) }
}

test('Env Doctor executes fixed version probes and a bundled presence program without retaining credentials', async () => {
  const h = doctor()
  const report = await h.command('require PROBE_VALUE')
  assert.match(report.text, /PROBE_VALUE: SET/)
  assert.doesNotMatch(report.text, /YOUR_API_KEY/)
  assert.deepEqual(h.runs.slice(0, 4), [['node', '--version'], ['npm', '--version'], ['pnpm', '--version'], ['yarn', '--version']])
  assert.deepEqual(h.runs[4], ['node', '--', helper, 'PROBE_VALUE'])
  assert.ok(h.runs.every(argv => !argv.includes('-e') && !argv.includes('YOUR_API_KEY')))
})
