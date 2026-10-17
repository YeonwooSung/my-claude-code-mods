// Run from the repository root: node --experimental-transform-types docs/verification/2026-10-17-privacy-audit.mjs
// Every credential is fake. Repaired groups assert absence; the original vulnerable behavior is preserved in Git history.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
const mod = path => import(pathToFileURL(`${process.cwd()}/${path}`))
const { Profiler, summarizeInput: profilerInput } = await mod('agent-profiler/hooks/core/profiler.ts')
const { toOtlp } = await mod('agent-profiler/hooks/core/otlp.ts')
const { summarize: profilerSummary } = await mod('agent-profiler/hooks/core/analyze.ts')
const { renderReport: profilerReport } = await mod('agent-profiler/hooks/core/report.ts')
const tm = await mod('time-machine/hooks/core/tools.ts')
const { Recorder } = await mod('time-machine/hooks/core/timeline.ts')
const { ChunkWriter } = await mod('time-machine/hooks/core/store.ts')
const { parseTestOutput } = await mod('time-machine/hooks/core/testparse.ts')
const { compareOutputs } = await mod('time-machine/hooks/core/compare.ts')
const { Detector } = await mod('loop-detective/hooks/core/detector.ts')
const { renderReport: loopReport } = await mod('loop-detective/hooks/core/report.ts')
const { Ledger } = await mod('context-inspector/hooks/core/ledger.ts')
const { runBash } = await mod('context-inspector/tests/fixtures.ts')
const { summarize: contextSummary } = await mod('context-inspector/hooks/core/summary.ts')
const { renderReport: contextReport } = await mod('context-inspector/hooks/core/report.ts')
const { redactSecrets: contextRedact } = await mod('context-inspector/hooks/core/redact.ts')
const outputs = []
// Each repaired group checks absence; untouched groups still characterize the original finding.
const protectedGroups = new Set(['AP-1', 'TM-4', 'TM-3', 'AP-2', 'TM-1', 'LD-1', 'AP-3', 'TM-2', 'UI-AP', 'CI-1', 'UI-CI'])
function contains(label, value, secret) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const protectedCase = protectedGroups.has(label.split(':')[0])
  assert.equal(text.includes(secret), !protectedCase, `${label}: unexpected secret exposure state`)
  outputs.push({ label, protected: protectedCase, evidence: protectedCase ? 'secret absent' : text.length > 300 ? text.slice(Math.max(0, text.indexOf(secret) - 40), text.indexOf(secret) + secret.length + 50) : text })
}
function newProfiler(tool, input) {
  const p = new Profiler('audit-session')
  p.turnStart(0, 'turn')
  p.toolStart(1, { id: 'tool', tool, input: profilerInput(tool, input) })
  p.toolEnd(100, 'tool', { denied: false, isError: false })
  p.turnComplete(101, 'turn', 'answer')
  return p
}
function diskStep(input, answer, test, tool = 'Bash') {
  const rec = new Recorder({ sessionId: 'audit', root: '/fake', startedAt: 0 })
  const summarized = tm.summarizeInput(input)
  const step = rec.begin({ id: 'tool', tool, at: 1, input: summarized.input, inputLossy: summarized.lossy })
  rec.finish(step, 2, { result: tm.summarizeResult(answer), ...(test ? { test } : {}) })
  const writer = new ChunkWriter('audit')
  return rec.drain().map(record => writer.add(record).body).at(-1)
}
const search = newProfiler('Grep', { pattern: 'API_KEY=FAKE_SEARCH_SECRET', path: '/fake' })
contains('AP-1: OTLP default options retain sensitive search pattern', toOtlp(search.snapshot(101), 'audit'), 'FAKE_SEARCH_SECRET')
const command = newProfiler('Bash', { command: 'gh api --token FAKE_COMMAND_SECRET /user' })
assert(!JSON.stringify(toOtlp(command.snapshot(101), 'audit')).includes('FAKE_COMMAND_SECRET'))
contains('AP-2: opt-in command export misses token flag', toOtlp(command.snapshot(101), 'audit', { commandText: true }), 'FAKE_COMMAND_SECRET')
const prompt = new Profiler('audit')
prompt.turnStart(0, 'turn', '--password "FAKE_CUT_PROMPT' + 'z'.repeat(200) + '"')
contains('AP-3: prompt cut before masking loses closing quote', toOtlp(prompt.snapshot(1), 'audit', { commandText: true }), 'FAKE_CUT_PROMPT')
const bash = newProfiler('Bash', { command: '--password "FAKE_CUT_COMMAND' + 'z'.repeat(600) + '"' })
contains('AP-3: command cut before masking loses closing quote', toOtlp(bash.snapshot(101), 'audit', { commandText: true }), 'FAKE_CUT_COMMAND')
const ui = newProfiler('Bash', { command: 'API_KEY=FAKE_UI_SECRET ./run.sh' })
contains('UI-AP: profiler report bypasses redaction', profilerReport(profilerSummary(ui.snapshot(101))), 'FAKE_UI_SECRET')
contains('TM-1: disk input stores token flag and marks it replayable', diskStep({ command: 'gh api --token FAKE_TM_TOKEN' }, { text: 'ok' }), 'FAKE_TM_TOKEN')
assert.equal(tm.summarizeInput({ command: 'gh api --token FAKE_TM_TOKEN' }).lossy, protectedGroups.has('TM-1'))
contains('TM-1: ignored file Write body copied into disk input', diskStep({ file_path: '/fake/.env', content: 'DATABASE_URL=postgres://alice:FAKE_DB_PASSWORD@db/app' }, {}, undefined, 'Write'), 'FAKE_DB_PASSWORD')
contains('TM-1: serialized JSON string is not walked as structured input', diskStep({ content: '{"token":"FAKE_JSON_TOKEN"}' }, {}), 'FAKE_JSON_TOKEN')
assert(!JSON.stringify(tm.summarizeInput({ token: 'FAKE_STRUCTURED_TOKEN' })).includes('FAKE_STRUCTURED_TOKEN'))
const full = '--password "FAKE_CUT_RESULT' + 'z'.repeat(2300) + '"'
const { redactSecrets: tmRedact } = await mod('time-machine/hooks/core/redact.ts')
assert(!tmRedact(full).includes('FAKE_CUT_RESULT'))
contains('TM-2: result cut before masking loses closing quote', diskStep({ command: 'echo ok' }, { text: full }), 'FAKE_CUT_RESULT')
contains('TM-2: rerun comparison cuts before masking', compareOutputs(undefined, full), 'FAKE_CUT_RESULT')
const testText = 'not ok 1 - API_KEY=FAKE_TEST_NAME\n# pass 0\n# fail 1'
assert(!tm.summarizeResult({ text: testText }).head.includes('FAKE_TEST_NAME'))
contains('TM-3: parsed test failure bypasses sanitized result head', diskStep({ command: 'node --test' }, { text: testText }, parseTestOutput(testText, true)), 'FAKE_TEST_NAME')
const loopCommands = [
  ['curl -u alice:FAKE_CURL_PASSWORD https://example.com', 'FAKE_CURL_PASSWORD'],
  ['git clone https://alice:FAKE_URL_PASSWORD@example.com/r', 'FAKE_URL_PASSWORD'],
  ['mysql -pFAKE_MYSQL_PASSWORD', 'FAKE_MYSQL_PASSWORD'],
  ['run --secret FAKE_FLAG_SECRET', 'FAKE_FLAG_SECRET'],
  [String.raw`run --token "FAKE_PREFIX\"FAKE_ESCAPED_TAIL"`, 'FAKE_ESCAPED_TAIL'],
]
for (const [command, secret] of loopCommands) {
  const d = new Detector(3)
  for (let i = 0; i < 3; i++) d.finish(d.begin('Bash', { command }, undefined, '/fake'), { isError: true, text: 'error: failed' })
  contains('LD-1: loop report retains unsupported credential format', loopReport(d.snapshot(), ''), secret)
}
const l = new Ledger()
runBash(l, 'cmd', 'API_KEY=FAKE_CONTEXT_UI ./run.sh', 'ok')
contains('UI-CI: context report bypasses export redactor', contextReport(contextSummary(l.snapshot(), 'all'), 'occupants'), 'FAKE_CONTEXT_UI')
contains('CI-1: header escaped quote leaves secret suffix visible', contextRedact(String.raw`curl -H "x-api-key: FAKE_PREFIX\"FAKE_HEADER_TAIL" https://example.com`), 'FAKE_HEADER_TAIL')
contains('CI-1: serialized JSON credential remains in export redactor output', contextRedact(`curl -d '{"token":"FAKE_CONTEXT_JSON"}' https://example.com`), 'FAKE_CONTEXT_JSON')
// Exercise the real shadow-git implementation only in a disposable directory.
const { ShadowGit } = await mod('time-machine/hooks/git.ts')
const tmp = await mkdtemp(`${tmpdir()}/mods-audit-`)
try {
  const project = `${tmp}/project`
  await mkdir(project)
  const runner = async (argv, options = {}) => {
    try {
      return { exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: options.cwd, env: { ...process.env, ...options.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '' }
    } catch (error) { return { exitCode: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') } }
  }
  const git = new ShadowGit(runner, `${tmp}/shadow.git`, project, `${tmp}/index`)
  await git.init()
  await writeFile(`${project}/settings.txt`, 'ordinary configuration')
  const first = await git.snapshot(undefined, 'first', 'refs/tm/audit/main')
  await writeFile(`${project}/.gitignore`, 'settings.txt\n')
  await writeFile(`${project}/settings.txt`, 'FAKE_NEWLY_IGNORED_SECRET')
  const next = await git.snapshot(first.commit, 'after ignoring', 'refs/tm/audit/main')
  const recorded = await git.exec(['show', `${next.commit}:settings.txt`])
  contains('TM-4: newly ignored file stays tracked and new secrets enter shadow snapshot', recorded.exitCode === 0 ? recorded.stdout : 'file excluded', 'FAKE_NEWLY_IGNORED_SECRET')
  if (protectedGroups.has('TM-4')) {
    // Excluding from the final tree is insufficient if git add first stored the secret blob.
    const secretHash = (await git.git(['hash-object', 'settings.txt'])).trim()
    assert.notEqual((await git.exec(['cat-file', '-e', secretHash])).exitCode, 0)
    await assert.rejects(git.restore(first.commit, 'refs/tm/audit/main', next.commit, 'restore'), /overwrite ignored files/)
    const { readFile } = await import('node:fs/promises')
    assert.equal(await readFile(`${project}/settings.txt`, 'utf8'), 'FAKE_NEWLY_IGNORED_SECRET')
  }
} finally { await rm(tmp, { recursive: true, force: true }) }
console.log(JSON.stringify({ checkedCases: outputs.length, protectedCases: outputs.filter(x => x.protected).length, remainingLeaks: outputs.filter(x => !x.protected).length, outputs }, null, 2))
