import { expect, test } from 'claude-code/testing'

import { redactSecrets } from '../hooks/core/redact.ts'
import { toOtlp } from '../hooks/core/otlp.ts'
import { session } from './fixtures.ts'
import { Profiler, summarizeInput } from '../hooks/core/profiler.ts'

test('long quoted credentials are masked before prompt and command prefixes are stored', () => {
  const raw = '--password "FAKE_LONG_SECRET' + 'x'.repeat(3000) + '" --verbose'
  const p = new Profiler('long')
  p.turnStart(0, 'turn', raw)
  p.toolStart(1, { id: 'bash', tool: 'Bash', input: summarizeInput('Bash', { command: raw }) })
  const snapshot = p.snapshot(2)
  expect(snapshot.turns[0]!.prompt).not.toContain('FAKE_LONG_SECRET')
  expect(snapshot.tools[0]!.input.command).toBe('--password [REDACTED] --verbose')
  expect(JSON.stringify(toOtlp(snapshot, 'test', { commandText: true }))).not.toContain('FAKE_LONG_SECRET')
})

// Command-shaped values below are redactor inputs only; they are never executed or fetched.
test('obvious secrets are redacted from command text', () => {
  expect(redactSecrets(`curl -H "Authorization: Bearer YOUR_TOKEN" https://example.invalid`)).toBe('curl -H "Authorization: [REDACTED]" https://example.invalid')
  expect(redactSecrets('curl -H "authorization:YOUR_TOKEN" x')).toBe('curl -H "authorization:[REDACTED]" x')
  expect(redactSecrets('http get x Bearer YOUR_TOKEN')).toBe('http get x Bearer [REDACTED]')
  expect(redactSecrets('psql --password=YOUR_PASSWORD -h db')).toBe('psql --password=[REDACTED] -h db')
  expect(redactSecrets('tool --password YOUR_PASSWORD run')).toBe('tool --password [REDACTED] run')
  expect(redactSecrets('mysql -u root -pYOUR_PASSWORD shop')).toBe('mysql -u root -p[REDACTED] shop')
  expect(redactSecrets('mysqldump -pYOUR_PASSWORD db > out.sql')).toBe('mysqldump -p[REDACTED] db > out.sql')
  expect(redactSecrets('mysql -u root -p shop')).toBe('mysql -u root -p shop')
  expect(redactSecrets('API_KEY=YOUR_API_KEY GITHUB_TOKEN="YOUR_TOKEN EXAMPLE" npm start')).toBe('API_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED] npm start')
  expect(redactSecrets("export aws_secret_access_key='YOUR_SECRET_KEY'")).toBe('export aws_secret_access_key=[REDACTED]')
  expect(redactSecrets('DB_PASSWORD=YOUR_PASSWORD ./run --api-key=YOUR_API_KEY')).toBe('DB_PASSWORD=[REDACTED] ./run --api-key=[REDACTED]')
  expect(redactSecrets('npm test -- --grep token')).toBe('npm test -- --grep token')
  expect(redactSecrets('ls -p /tmp')).toBe('ls -p /tmp')
})

function attrKeys(commandText?: boolean) {
  const p = session()
  p.turnStart(20_000, 't2', 'deploy with TOKEN=abc')
  p.toolStart(20_001, { id: 'sec', tool: 'Bash', input: { command: 'API_KEY=xyz ./deploy' } })
  const req = toOtlp(p.snapshot(21_000), '0.1.0', commandText === undefined ? {} : { commandText })
  return req.resourceSpans[0]?.scopeSpans[0]?.spans.flatMap(s => s.attributes) ?? []
}

test('prompt and command text are left out of exports unless enabled', () => {
  const attrs = attrKeys()
  expect(attrs.some(a => a.key === 'agent_profiler.turn.prompt')).toBe(false)
  expect(attrs.some(a => a.key === 'agent_profiler.bash.command')).toBe(false)
  expect(attrs).toContainEqual({ key: 'agent_profiler.bash.category', value: { stringValue: 'test' } })
})

test('when enabled, prompt and command text are exported redacted', () => {
  const attrs = attrKeys(true)
  expect(attrs).toContainEqual({ key: 'agent_profiler.turn.prompt', value: { stringValue: 'deploy with TOKEN=[REDACTED]' } })
  expect(attrs).toContainEqual({ key: 'agent_profiler.bash.command', value: { stringValue: 'API_KEY=[REDACTED] ./deploy' } })
  expect(attrs).toContainEqual({ key: 'agent_profiler.bash.command', value: { stringValue: 'npm test' } })
})
