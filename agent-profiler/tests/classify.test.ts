import { expect, test } from 'claude-code/testing'

import { classifyCommand } from '../hooks/core/classify.ts'

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
