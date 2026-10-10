import { expect, test } from 'claude-code/testing'

import { classifyCommand, isolationProblem } from '../hooks/core/classify.ts'

test('common runners and tools', () => {
  expect(classifyCommand('npm test')).toBe('test')
  expect(classifyCommand('pnpm run test -- --watch=false')).toBe('test')
  expect(classifyCommand('pytest -x tests/')).toBe('test')
  expect(classifyCommand('go test ./...')).toBe('test')
  expect(classifyCommand('cargo test')).toBe('test')
  expect(classifyCommand('npm install')).toBe('install')
  expect(classifyCommand('pip install -r requirements.txt')).toBe('install')
  expect(classifyCommand('npm run build')).toBe('build')
  expect(classifyCommand('tsc -p .')).toBe('build')
  expect(classifyCommand('git status')).toBe('git')
  expect(classifyCommand('gh pr view 12')).toBe('git')
  expect(classifyCommand('rg foo src')).toBe('search')
  expect(classifyCommand('echo hi')).toBe('other')
  expect(classifyCommand('')).toBe('other')
})

test('compound commands take the most expensive segment', () => {
  expect(classifyCommand('cd web && npm test')).toBe('test')
  expect(classifyCommand('cd web && git diff')).toBe('git')
  expect(classifyCommand('npm ci && npm test')).toBe('test')
  expect(classifyCommand('ls | grep foo')).toBe('search')
})

test('runner names must match at command position only', () => {
  expect(classifyCommand('npm install --save-dev vitest')).toBe('install')
  expect(classifyCommand('pip install pytest')).toBe('install')
  expect(classifyCommand('git add vitest.config.ts')).toBe('git')
  expect(classifyCommand('rg jest src')).toBe('search')
  expect(classifyCommand('cat jest.config.js')).toBe('search')
  expect(classifyCommand('git commit -m "fix pytest flake"')).toBe('git')
})

test('splitting respects quotes and heredocs', () => {
  expect(classifyCommand('git commit -m "a && npm test"')).toBe('git')
  expect(classifyCommand('git commit -m "$(cat <<\'EOF\'\nrun pytest\nEOF\n)"')).toBe('git')
  expect(classifyCommand('echo hi\ngit status')).toBe('git')
})

test('false negatives fixed', () => {
  expect(classifyCommand('pnpm -r test')).toBe('test')
  expect(classifyCommand('pnpm --filter web test')).toBe('test')
  expect(classifyCommand('npm t')).toBe('test')
  expect(classifyCommand('python -m unittest')).toBe('test')
  expect(classifyCommand('python -m pytest -q')).toBe('test')
  expect(classifyCommand('cargo nextest run')).toBe('test')
  expect(classifyCommand('npx vitest run')).toBe('test')
  expect(classifyCommand('npx jest')).toBe('test')
})

test('playwright and cypress require subcommands', () => {
  expect(classifyCommand('npx playwright install chromium')).toBe('other')
  expect(classifyCommand('cypress open')).toBe('other')
  expect(classifyCommand('npx playwright test')).toBe('test')
  expect(classifyCommand('cypress run --spec x')).toBe('test')
})

test('gradle/mvn complex task detection', () => {
  expect(classifyCommand('gradle test')).toBe('test')
  expect(classifyCommand('mvn clean test')).toBe('test')
  expect(classifyCommand('./gradlew clean test')).toBe('test')
  expect(classifyCommand('./gradlew :app:test')).toBe('test')
  expect(classifyCommand('mvn verify')).toBe('test')
  expect(classifyCommand('mvn clean install')).toBe('build')
  expect(classifyCommand('./gradlew build -x test')).toBe('build')
  expect(classifyCommand('mvn package -Dmaven.test.skip=true')).toBe('build')
})

test('env assignments and wrappers stripped', () => {
  expect(classifyCommand('npx tsc')).toBe('build')
  expect(classifyCommand('FOO=1 git status')).toBe('git')
  expect(classifyCommand('time npm test')).toBe('test')
  expect(classifyCommand('yarn')).toBe('install')
  expect(classifyCommand('env FOO=bar npm test')).toBe('test')
  expect(classifyCommand('sudo apt-get install curl')).toBe('install')
  expect(classifyCommand('poetry run pytest')).toBe('test')
  expect(classifyCommand('pnpm exec vitest')).toBe('test')
  expect(classifyCommand('yarn dlx tsc')).toBe('build')
  expect(classifyCommand('uv run python -m pytest')).toBe('test')
})

test('non-string input returns other', () => {
  expect(classifyCommand(undefined as unknown as string)).toBe('other')
  expect(classifyCommand(null as unknown as string)).toBe('other')
  expect(classifyCommand(123 as unknown as string)).toBe('other')
})

test('isolationProblem: a command naming the project root by its absolute path is not isolated', () => {
  const problem = "the command refers to the project's absolute path, so it would not be isolated"
  expect(isolationProblem('pytest /work/app/tests', '/work/app')).toBe(problem)
  expect(isolationProblem('cd /work/app && make', '/work/app/')).toBe(problem)
  expect(isolationProblem('node --root="/work/app"', '/work/app')).toBe(problem)
  expect(isolationProblem('rm -rf /work/app', '/work/app')).toBe(problem)
  expect(isolationProblem('pytest -q tests/', '/work/app')).toBeUndefined()
  expect(isolationProblem('ls /work/apple /work/app.bak', '/work/app')).toBeUndefined()
  expect(isolationProblem('ls /x/work/app', '/work/app')).toBeUndefined()
  expect(isolationProblem('ls /', '/')).toBeUndefined()
})
