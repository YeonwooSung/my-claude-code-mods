import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const market = JSON.parse(await readFile('.claude-plugin/marketplace.json', 'utf8'))
for (const { name } of market.plugins) {
  if (['agent-profiler', 'context-inspector', 'time-machine', 'loop-detective', 'pin-memo', 'model-effort-band', 'token-run'].includes(name)) continue
  const hook = await readFile(`${name}/hooks/register.ts`, 'utf8')
  const command = hook.match(/const command = '([^']+)'/)?.[1]
  assert.ok(command, `${name}: command missing`)
  for (const [target, source] of [
    [`${name}/hooks/core/runtime.ts`, await readFile('scripts/workflow/runtime.ts', 'utf8')],
    [`${name}/hooks/core/redact.ts`, await readFile('scripts/redact-secrets.ts', 'utf8')],
    [`${name}/hooks/register.ts`, (await readFile('scripts/workflow/adapter.template.ts', 'utf8')).replaceAll('__NAME__', name).replaceAll('__COMMAND__', command)],
  ]) {
    if (process.argv.includes('--check')) assert.equal(await readFile(target, 'utf8'), source, `${target}: run node scripts/sync-workflow.mjs`)
    else await writeFile(target, source)
  }
}
