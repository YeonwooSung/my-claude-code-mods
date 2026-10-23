// Generate only the host capabilities the feature actually uses. Unsupported Port
// methods fail closed without carrying dormant fs/process/environment/tool calls.
const capabilities = {
  'verify-board': ['read', 'bytes', 'stat', 'git', 'revision'],
  'scope-guard': ['git'],
  'blast-radius': ['read', 'git'],
  'decision-ledger': [],
  'handoff-pack': ['read', 'bytes', 'stat', 'git', 'revision'],
  'command-shelf': ['replay'],
  'env-doctor': ['read', 'versions', 'presence'],
  'dependency-lens': ['read', 'list', 'git'],
  'assumption-tracker': [],
  'review-queue': ['read', 'bytes', 'stat', 'git'],
}
const source = {
  read: '  io.read = async path => await $.fs.read(path)',
  bytes: "  io.bytes = async path => (await $.fs.read(path, { as: 'bytes' })).base64",
  stat: '  io.stat = path => $.fs.stat(path)',
  list: '  io.list = async path => (await $.fs.list(path)).map(entry => entry.name)',
  git: `  io.run = argv => {
    if (argv[0] !== 'git') throw new Error('Only local Git evidence commands are supported')
    return $.process.run(['git', ...argv.slice(1)], { cwd, timeoutMs: 10_000 })
  }`,
  revision: '  io.revision = () => revision(io)',
  versions: `  io.run = argv => {
    if (argv.length !== 2 || argv[1] !== '--version') throw new Error('Only version probes are supported')
    switch (argv[0]) {
      case 'node': return $.process.run(['node', '--version'], { cwd, timeoutMs: 10_000 })
      case 'npm': return $.process.run(['npm', '--version'], { cwd, timeoutMs: 10_000 })
      case 'pnpm': return $.process.run(['pnpm', '--version'], { cwd, timeoutMs: 10_000 })
      case 'yarn': return $.process.run(['yarn', '--version'], { cwd, timeoutMs: 10_000 })
      default: throw new Error('Unsupported version program')
    }
  }`,
  presence: String.raw`  io.env = async variableName => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variableName)) throw new Error('invalid environment variable name')
    const program = $.plugin.root + '/hooks/env-presence.mjs'
    const r = await $.process.run(['node', '--', program, variableName], { cwd, timeoutMs: 10_000 })
    if (r.exitCode !== 0) throw new Error('environment presence unavailable')
    return r.stdout === 'set' ? 'set' : undefined
  }`,
  replay: `  io.replay = async text => {
    state.replaying = true
    try { return await $.tool.call({ tool: 'Bash', command: text, description: 'Replay explicitly selected Command Shelf entry' }) }
    finally { state.replaying = false }
  }`,
}
export function portSource(name) {
  const selected = capabilities[name]
  if (!selected) throw new Error(`Choose explicit capabilities for ${name}`)
  return [
    "  const unavailable = async (): Promise<never> => { throw new Error('Capability not used by this feature') }",
    '  const io: Port = { cwd, read: unavailable, run: unavailable, env: unavailable, revision: async () => undefined }',
    ...selected.map(capability => source[capability]),
  ].join('\n')
}
