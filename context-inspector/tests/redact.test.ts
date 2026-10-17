import { expect, test } from 'claude-code/testing'

import { redactSecrets } from '../hooks/core/redact.ts'

const cases = [
  ['gh api --token FAKE_tok_123 /user', 'gh api --token [REDACTED] /user'],
  ['run --token=FAKE_tok_123 --verbose', 'run --token=[REDACTED] --verbose'],
  ['run --api-key "FAKE key 456"', 'run --api-key [REDACTED]'],
  ["run --secret='FAKE secret 456'", 'run --secret=[REDACTED]'],
  [String.raw`run --token "FAKE\" quoted token" --verbose`, 'run --token [REDACTED] --verbose'],
  ['curl -H "x-api-key: FAKE_key_456" https://api.example.com', 'curl -H "x-api-key: [REDACTED]" https://api.example.com'],
  ["curl -H 'X-Auth-Token: FAKE_token' https://api.example.com", "curl -H 'X-Auth-Token: [REDACTED]' https://api.example.com"],
  ['curl -H "X-Client-Secret: FAKE_secret" https://api.example.com', 'curl -H "X-Client-Secret: [REDACTED]" https://api.example.com'],
  ['git clone https://alice:FAKE_pw_789@git.example.com/r.git', 'git clone https://alice:[REDACTED]@git.example.com/r.git'],
  ['https://alice:p%40ss%3Aword@example.com/r?q=1', 'https://alice:[REDACTED]@example.com/r?q=1'],
  ['curl -u alice:FAKE_pw_000 https://api.example.com', 'curl -u [REDACTED] https://api.example.com'],
  ['curl --user="alice:FAKE password" https://api.example.com', 'curl --user=[REDACTED] https://api.example.com'],
  ["curl --user 'alice:FAKE password' https://api.example.com", 'curl --user [REDACTED] https://api.example.com'],
  ['curl -ualice:FAKE_pw https://api.example.com', 'curl -u[REDACTED] https://api.example.com'],
  ['API_KEY=FAKE_ok_111 ./run.sh', 'API_KEY=[REDACTED] ./run.sh'],
  ['run --password="FAKE password"', 'run --password=[REDACTED]'],
  ['mysql -u alice -pFAKE_pw db', 'mysql -u alice -p[REDACTED] db'],
  ['curl -H "Authorization: Bearer FAKE_token" https://x', 'curl -H "Authorization: [REDACTED]" https://x'],
  ['Bearer FAKE_token', 'Bearer [REDACTED]'],
] as const

for (const [input, expected] of cases) {
  test(`redacts credentials in ${input}`, () => {
    expect(redactSecrets(input)).toBe(expected)
  })
}

test('keeps ordinary options, headers, credential-free URLs and file paths', () => {
  const input = 'curl --token-count 10 -H "Content-Type: application/json" https://example.com:443/r ./token.txt ssh://git@example.com/r'
  expect(redactSecrets(input)).toBe(input)
})
