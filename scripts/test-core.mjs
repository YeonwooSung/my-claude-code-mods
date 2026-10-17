import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const files = ['agent-profiler', 'context-inspector', 'time-machine', 'loop-detective', 'pin-memo', 'model-effort-band', 'token-run', 'verify-board'].flatMap(mod =>
  readdirSync(`${mod}/tests`).filter(file => file.endsWith('.test.ts') && file !== 'adapter.test.ts')
    .map(file => `./${mod}/tests/${file}`),
).sort()
const result = spawnSync(process.execPath, ['--experimental-transform-types', '--import', './scripts/core-loader.mjs', '--test', '--test-concurrency=1', ...files], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
