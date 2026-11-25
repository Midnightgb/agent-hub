import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArgv, parseResult, classifyError, listModels, readPolicy } from '../../src/adapters/gentle-shell.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'gentle-shell')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

test('buildArgv builds a read-mode argv restricted to read-only tools and no MCP', () => {
  const argv = buildArgv({ model: 'anthropic/claude-haiku-4-5', prompt: 'Reply exactly: PONG', cwd: '/repo', mode: 'read' })
  assert.deepEqual(argv, [
    '--',
    '-p',
    '--mode',
    'json',
    '--model',
    'anthropic/claude-haiku-4-5',
    '--tools',
    'read,grep,find,ls',
    '--no-mcp',
    '--',
    'Reply exactly: PONG',
  ])
})

test('buildArgv keeps the default tool set in write mode', () => {
  const argv = buildArgv({ model: 'anthropic/claude-sonnet-5-5', prompt: 'do it', cwd: '/repo', mode: 'write' })
  assert.ok(!argv.includes('--tools'))
  assert.ok(!argv.includes('--no-mcp'))
  assert.deepEqual(argv.slice(-2), ['--', 'do it'])
})

test('buildArgv ends option parsing so a prompt starting with a dash stays a message', () => {
  const argv = buildArgv({ model: 'anthropic/claude-haiku-4-5', prompt: '--help me', cwd: '/repo', mode: 'read' })
  assert.deepEqual(argv.slice(-2), ['--', '--help me'])
})

test('buildArgv omits --model for the CLI default model', () => {
  for (const model of ['default', undefined]) {
    const argv = buildArgv({ model, prompt: 'p', cwd: '/repo', mode: 'read' })
    assert.ok(!argv.includes('--model'))
  }
})

test('buildArgv maps the variant to --thinking', () => {
  const argv = buildArgv({ model: 'anthropic/claude-opus-5-5', prompt: 'p', cwd: '/repo', mode: 'read', variant: 'high' })
  assert.equal(argv[argv.indexOf('--thinking') + 1], 'high')
  assert.ok(!buildArgv({ model: 'anthropic/claude-opus-5-5', prompt: 'p', cwd: '/repo', mode: 'read' }).includes('--thinking'))
})

test('buildArgv resumes by forking the session, which works from any cwd', () => {
  const argv = buildArgv({ model: 'anthropic/claude-haiku-4-5', prompt: 'and now?', cwd: '/repo', mode: 'read', sessionId: 'sess-1' })
  assert.equal(argv[argv.indexOf('--fork') + 1], 'sess-1')
  assert.ok(!argv.includes('--session'))
  assert.ok(!argv.includes('--no-session'))
})

test('read mode is enforced by the CLI tool allowlist', () => {
  assert.equal(readPolicy, 'enforced')
})

test('parseResult extracts the final text, session id, summed tokens and cost', () => {
  const result = parseResult(read('print-ok.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'hello')
  assert.equal(result.sessionId, '01a1992b-737c-75f3-9543-c6e6b0d806e5')
  // The hub contract is a number: input (cache reads and writes included) plus output (reasoning included).
  assert.equal(result.tokens, 37990)
  assert.ok(Math.abs(result.costUsd - 0.0267959) < 1e-9)
})

test('parseResult reports a failed turn as not ok', () => {
  const result = parseResult(read('print-bad-model.jsonl'))
  assert.equal(result.ok, false)
  assert.equal(result.text, '')
  assert.equal(result.sessionId, '01a1992c-1592-7638-b98c-d5d6f7b5eab1')
})

test('classifyError returns null for a successful run', () => {
  assert.equal(classifyError(read('print-ok.jsonl'), { code: 0 }), null)
})

test('classifyError maps a provider usage-limit 429 to quota', () => {
  const error = classifyError(read('print-quota.jsonl'), { code: 0 })
  assert.equal(error.kind, 'quota')
  assert.equal(error.retriable, true)
  assert.match(error.message, /usage limit exceeded/i)
})

test('classifyError maps an unknown model 404 to model_unavailable', () => {
  const error = classifyError(read('print-bad-model.jsonl'), { code: 0 })
  assert.equal(error.kind, 'model_unavailable')
  assert.equal(error.retriable, false)
})

test('classifyError maps Anthropic auth and billing failures', () => {
  const turn = (errorMessage) => JSON.stringify({ type: 'turn_end', message: { role: 'assistant', stopReason: 'error', errorMessage, content: [] } })
  const auth = classifyError(turn('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), {})
  assert.equal(auth.kind, 'auth')
  const credit = classifyError(turn('400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'), {})
  assert.equal(credit.kind, 'quota')
  const rate = classifyError(turn('429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}'), {})
  assert.equal(rate.kind, 'quota')
})

test('classifyError reports a timeout and an empty run', () => {
  assert.equal(classifyError('', { timedOut: true }).kind, 'timeout')
  const empty = classifyError('', { code: 0 })
  assert.equal(empty.kind, 'empty')
  assert.equal(empty.retriable, true)
})

test('listModels parses the --list-models table into provider/id models', () => {
  const models = listModels(read('list-models.txt'))
  assert.equal(models.length, 17)
  assert.deepEqual(models[0], { id: 'anthropic/claude-fable-5', label: 'claude-fable-5 (anthropic, 1M ctx)' })
  assert.ok(models.some((m) => m.id === 'anthropic/claude-sonnet-5-5'))
})

test('listModels skips the compat-custom image catalog', () => {
  const models = listModels(read('list-models-mixed.txt'))
  assert.deepEqual(
    models.map((m) => m.id),
    ['opencode-go/beam-free', 'opencode-go/claude-haiku-5-5', 'opencode-go/deepseek-v4-pro']
  )
})
