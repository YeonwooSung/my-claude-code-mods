import { expect, test } from 'claude-code/testing'

import { redactSecrets } from '../hooks/core/redact.ts'
import { toOtlp } from '../hooks/core/otlp.ts'
import { session } from './fixtures.ts'

test('obvious secrets are redacted from command text', () => {
  expect(redactSecrets(`curl -H "Authorization: Bearer abc.def" https://x`)).toBe('curl -H "Authorization: [REDACTED]" https://x')
  expect(redactSecrets('curl -H "authorization:token123" x')).toBe('curl -H "authorization:[REDACTED]" x')
  expect(redactSecrets('http get x Bearer eyJhbGciOi.x-y_z')).toBe('http get x Bearer [REDACTED]')
  expect(redactSecrets('psql --password=hunter2 -h db')).toBe('psql --password=[REDACTED] -h db')
  expect(redactSecrets('tool --password hunter2 run')).toBe('tool --password [REDACTED] run')
  expect(redactSecrets('mysql -u root -phunter2 shop')).toBe('mysql -u root -p[REDACTED] shop')
  expect(redactSecrets('mysqldump -psecret db > out.sql')).toBe('mysqldump -p[REDACTED] db > out.sql')
  expect(redactSecrets('mysql -u root -p shop')).toBe('mysql -u root -p shop')
  expect(redactSecrets('API_KEY=abc123 GITHUB_TOKEN="x y" npm start')).toBe('API_KEY=[REDACTED] GITHUB_TOKEN=[REDACTED] npm start')
  expect(redactSecrets("export aws_secret_access_key='s3cr3t'")).toBe('export aws_secret_access_key=[REDACTED]')
  expect(redactSecrets('DB_PASSWORD=pw ./run --api-key=k1')).toBe('DB_PASSWORD=[REDACTED] ./run --api-key=[REDACTED]')
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
