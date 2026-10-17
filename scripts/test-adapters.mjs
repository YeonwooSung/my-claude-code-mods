import { spawnSync } from 'node:child_process'

const binary = process.env.CLAUDE_BIN || 'claude'
let failed = false
for (const mod of ['agent-profiler', 'context-inspector', 'time-machine', 'loop-detective', 'pin-memo', 'model-effort-band', 'token-run', 'verify-board', 'scope-guard']) {
  const result = spawnSync(binary, ['plugin', 'test', mod], {
    stdio: 'inherit', env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
