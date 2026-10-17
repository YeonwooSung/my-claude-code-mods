import { test, expect } from 'claude-code/testing'
import { Feature, compare } from '../hooks/core/feature.ts'
test('dependency comparison distinguishes direct, transitive, removed and lifecycle changes', () => {
  const before = { dependencies: { '@scope/pkg': '^1' }, scripts: { install: 'old' } }
  const after = { dependencies: { '@scope/pkg': '^2', fresh: '1' }, scripts: { install: 'new' } }
  const oldLock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/@scope/pkg': { version: '1' }, 'node_modules/gone': { version: '1' } } }
  const newLock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/@scope/pkg': { version: '2' }, 'node_modules/fresh': { version: '1' }, 'node_modules/transitive': { version: '4', hasInstallScript: true } } }
  const report = compare(before, after, oldLock, newLock).join('\n')
  expect(report).toContain('DIRECT dependencies @scope/pkg: ^1 -> ^2')
  expect(report).toContain('REMOVED node_modules/gone')
  expect(report).toContain('ADDED node_modules/transitive')
  expect(report).toContain('INSTALL-SCRIPT node_modules/transitive')
  expect(report).toContain('LIFECYCLE install: changed')
})
test('unsupported or absent locks explicitly limit analysis while preserving manifest results', () => {
  const report = compare({}, { devDependencies: { typescript: '5.9.3' } }, { lockfileVersion: 1 }, undefined).join('\n')
  expect(report).toContain('DIRECT devDependencies typescript')
  expect(report).toContain('INCOMPLETE')
})
test('base refs are validated and malformed Git/JSON evidence is never a clean comparison', async () => {
  const f = new Feature()
  const io = { cwd: '/repo', read: async () => '{bad', run: async () => ({ exitCode: 0, stdout: '{bad', stderr: '' }), env: async () => undefined, revision: async () => 'a' }
  expect(await f.command('base --all', io)).toContain('Invalid')
  expect(await f.command('base HEAD~1', io)).toContain('INCOMPLETE')
  expect(await new Feature(f.data).command('', io)).toContain('HEAD~1')
})
test('denied reads and malformed lock package maps remain incomplete evidence', async () => {
  const lock = { lockfileVersion: 3, packages: [] }
  expect(compare({}, {}, lock, lock).join('\n')).toContain('INCOMPLETE')
  const f = new Feature()
  const io = { cwd: '/repo', read: async (path: string) => { if (path.endsWith('/package.json')) throw new Error('permission denied'); return '{"lockfileVersion":3,"packages":{}}' }, run: async (args: readonly string[]) => ({ exitCode: 0, stdout: args.includes('ls-tree') ? args.at(-1) + '\0' : args.includes('show') ? args.at(-1)!.endsWith(':package.json') ? '{"dependencies":{"pkg":"1"}}' : '{"lockfileVersion":3,"packages":{}}' : 'commit', stderr: '' }), env: async () => undefined, revision: async () => 'a' }
  expect(await f.command('', io)).toContain('INCOMPLETE')
})
