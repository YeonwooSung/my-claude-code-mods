import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

// Literal expected outputs shared by every independently packaged mod.
const cases = [
  [String.raw`curl -H "x-api-key: FAKE_PREFIX\"FAKE_HEADER_TAIL" https://example.com`, 'curl -H "x-api-key: [REDACTED]" https://example.com'],
  [`curl -H 'X-Client-Secret: FAKE"TAIL' https://example.com`, "curl -H 'X-Client-Secret: [REDACTED]' https://example.com"],
  [String.raw`curl -H "Authorization: Basic FAKE\"TAIL" https://example.com`, 'curl -H "Authorization: [REDACTED]" https://example.com'],
  [`curl -d '{"access_token":"FAKE_JSON_TOKEN"}' https://example.com`, `curl -d '{"access_token":[REDACTED]}' https://example.com`],
  ['gh api --token FAKE_TOKEN /user', 'gh api --token [REDACTED] /user'],
  ['run --secret "FAKE secret"', 'run --secret [REDACTED]'],
  [String.raw`run --api-key="FAKE\"TAIL" --verbose`, 'run --api-key=[REDACTED] --verbose'],
  ['curl -H "x-api-key: FAKE_HEADER" https://example.com', 'curl -H "x-api-key: [REDACTED]" https://example.com'],
  ['git clone https://alice:FAKE_URL@example.com/r', 'git clone https://alice:[REDACTED]@example.com/r'],
  ['curl -u alice:FAKE_CURL https://example.com', 'curl -u [REDACTED] https://example.com'],
  ['curl --user="alice:FAKE password" https://example.com', 'curl --user=[REDACTED] https://example.com'],
  ['mysql -u root -pFAKE_MYSQL db', 'mysql -u root -p[REDACTED] db'],
  [`curl -d '{"token":"FAKE_JSON"}' https://example.com`, `curl -d '{"token":[REDACTED]}' https://example.com`],
  ['password: FAKE_PLAIN', 'password: [REDACTED]'],
  ['API_KEY=FAKE_ENV run', 'API_KEY=[REDACTED] run'],
  ['curl -H "Authorization: Bearer FAKE_AUTH" https://x', 'curl -H "Authorization: [REDACTED]" https://x'],
  ['run --token-count 10 ./token.txt', 'run --token-count 10 ./token.txt'],
]
for (const name of ['agent-profiler', 'time-machine', 'loop-detective', 'context-inspector', 'verify-board', 'scope-guard', 'blast-radius', 'decision-ledger', 'handoff-pack', 'command-shelf', 'env-doctor', 'dependency-lens', 'assumption-tracker', 'review-queue']) {
  const path = name === 'loop-detective' ? `${name}/hooks/core/fingerprint.ts` : `${name}/hooks/core/redact.ts`
  const core = await import(pathToFileURL(`${process.cwd()}/${path}`))
  const redact = name === 'loop-detective' ? value => core.display(value, 10000) : core.redactSecrets
  for (const [input, expected] of cases) assert.equal(redact(input), expected, `${name}: ${input}`)
  console.log(`${name}: ${cases.length} shared redaction cases passed`)
}
