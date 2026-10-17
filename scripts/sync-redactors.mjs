import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const source = await readFile(new URL('./redact-secrets.ts', import.meta.url), 'utf8')
for (const mod of ['agent-profiler', 'time-machine', 'loop-detective']) {
  const target = new URL(`../${mod}/hooks/core/redact.ts`, import.meta.url)
  if (process.argv.includes('--check')) assert.equal(await readFile(target, 'utf8'), source, `${mod}: run node scripts/sync-redactors.mjs`)
  else await writeFile(target, source)
}
