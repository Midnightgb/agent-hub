import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessionIdFrom, buildArgv, stdinFor, parseResult, classifyError, listModels, interruptArgv, sessionExportArgv, opencodeOccupancyFromExport, readSessionOccupancy } from '../../src/adapters/opencode.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opencode')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

test('buildArgv builds a read-mode plan argv with no prompt positional and no --dir (v2: prompt rides stdin, --dir was removed)', () => {
  const argv = buildArgv({
    model: 'opencode/muse-spark-1.3-contributor-free',
    prompt: 'Reply exactly: PONG',
    cwd: '/repo',
    mode: 'read',
    title: 'fixture-pong',
  })
  assert.deepEqual(argv, [
    'run',
    '-m',
    'opencode/muse-spark-1.3-contributor-free',
    '--format',
    'json',
    '--agent',
    'plan',
    '--title',
    'fixture-pong',
  ])
})

test('buildArgv builds a write-mode argv with --agent build and --auto, and never leaks the prompt into argv', () => {
  const argv = buildArgv({ model: 'deepseek/deepseek-v4-flash', prompt: 'do it', cwd: '/repo', mode: 'write' })
  assert.ok(argv.includes('--auto'))
  assert.ok(argv.includes('build'))
  assert.ok(!argv.includes('plan'))
  assert.ok(!argv.includes('do it'), 'the prompt must never appear as an argv element (E3: argv quoting corrupts it)')
  assert.ok(!argv.includes('--dir'), '--dir was removed in v2 (E1)')
})

test('buildArgv defaults to read/plan when mode is omitted', () => {
  const argv = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo' })
  assert.ok(argv.includes('plan'))
  assert.ok(!argv.includes('--auto'))
})

test('buildArgv folds variant into the model id as model#variant instead of a --variant flag (E2)', () => {
  const withVariant = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', variant: 'high' })
  assert.ok(!withVariant.includes('--variant'), '--variant was removed in v2')
  assert.equal(withVariant[withVariant.indexOf('-m') + 1], 'x#high')

  const withoutVariant = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo' })
  assert.equal(withoutVariant[withoutVariant.indexOf('-m') + 1], 'x')
})

test('buildArgv does not double up the variant when the model id already carries one', () => {
  const argv = buildArgv({ model: 'x#already', prompt: 'p', cwd: '/repo', variant: 'high' })
  assert.equal(argv[argv.indexOf('-m') + 1], 'x#already')
})

test('buildArgv adds -s <sessionId> only when given (session resume)', () => {
  const withSession = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', sessionId: 'ses_abc' })
  assert.equal(withSession[withSession.indexOf('-s') + 1], 'ses_abc')
  const withoutSession = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo' })
  assert.ok(!withoutSession.includes('-s'))
})

test('buildArgv never adds --standalone (E11: a standalone server has zero credentials/providers/models)', () => {
  const argv = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', mode: 'write' })
  assert.ok(!argv.includes('--standalone'))
})

test('stdinFor returns the prompt string, which is now piped to opencode run on stdin instead of argv (E3/E4)', () => {
  assert.equal(stdinFor({ prompt: 'Reply exactly: PONG' }), 'Reply exactly: PONG')
})

test('parseResult reads the real success fixture (JSONL with a leading non-JSON noise line)', () => {
  const result = parseResult(read('success.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG')
  assert.equal(result.tokens, 39465)
  assert.equal(result.sessionId, 'ses_f6f0a1e89ffe702DvBLQmWfcpn')
})

test('classifyError returns null for a success stream', () => {
  assert.equal(classifyError(read('success.jsonl')), null)
})

test('classifyError treats a dropped text/step_finish stream as empty and retriable', () => {
  const result = parseResult(read('empty.jsonl'))
  assert.equal(result.ok, false)
  const error = classifyError(read('empty.jsonl'))
  assert.equal(error.kind, 'empty')
  assert.equal(error.retriable, true)
})

test('classifyError reports timeout when the process wrapper says timedOut (opencode handles SIGINT but not SIGTERM)', () => {
  const error = classifyError(read('success.jsonl'), { timedOut: true })
  assert.equal(error.kind, 'timeout')
})

test('classifyError detects a real DeepSeek 402/Insufficient Balance error event as "billing" (not "crash"), not retriable', () => {
  const error = classifyError(read('billing-402.jsonl'))
  assert.equal(error.kind, 'billing')
  assert.equal(error.retriable, false)
})

test('parseResult keeps only the last assistant message when a run emits several (E7: group by part.messageID, take the last group)', () => {
  const result = parseResult(read('v2-two-assistant-messages.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'Ready to plan — what do you want to work on?')
  assert.notEqual(result.text, 'PONGReady to plan — what do you want to work on?', 'must not splice unrelated turns together')
})

test('parseResult sums step_finish.part.tokens components since v2 has no `total` field (E5)', () => {
  const result = parseResult(read('v2-two-assistant-messages.jsonl'))
  // input:19401 + output:12 + reasoning:14 + cache.read:0 + cache.write:0
  assert.equal(result.tokens, 19427)
  assert.equal(result.costUsd, 0)
  assert.equal(result.sessionId, 'ses_f442b8afeffeTPaFVPlSIhCR8b')
})

test('parseResult still computes the pre-v2 fixture total by summing components, matching its own recorded total (39465)', () => {
  const result = parseResult(read('success.jsonl'))
  assert.equal(result.tokens, 39465)
})

test('parseResult degrades tokens/cost to null but stays ok when step_finish is absent entirely (E6)', () => {
  const result = parseResult(read('v2-no-step-finish.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'Repeat back the exact characters of my message, nothing else.')
  assert.equal(result.tokens, null)
  assert.equal(result.costUsd, null)
  assert.equal(result.sessionId, 'ses_f442abe80ffeDArU3srUc4szQR')
})

test('classifyError treats exit code 130 as a canceled interrupt, not a crash (E16: our own kill ladder sends SIGINT first)', () => {
  const error = classifyError(read('success.jsonl'), { code: 130 })
  assert.equal(error.kind, 'canceled')
  assert.equal(error.retriable, true)
})

test('classifyError still reports timeout when the process wrapper says timedOut, even if a code is also present', () => {
  const error = classifyError(read('success.jsonl'), { timedOut: true, code: 130 })
  assert.equal(error.kind, 'timeout')
})

test('classifyError timeout message reflects that opencode handles SIGINT but not SIGTERM (not "ignores SIGTERM")', () => {
  const error = classifyError(read('success.jsonl'), { timedOut: true })
  assert.match(error.message, /SIGTERM/)
  assert.doesNotMatch(error.message, /ignores SIGTERM/)
})

test('classifyError recovers sessionId from partial NDJSON stdout on timeout, since a timed-out run may never reach a terminal parse (E19)', () => {
  const error = classifyError(read('success.jsonl'), { timedOut: true })
  assert.equal(error.sessionId, 'ses_f6f0a1e89ffe702DvBLQmWfcpn')
})

test('classifyError returns a null sessionId on timeout when stdout has no NDJSON at all', () => {
  const error = classifyError('', { timedOut: true })
  assert.equal(error.sessionId, null)
})

test('interruptArgv builds the argv that fires the verified `opencode api session.interrupt --param sessionID=<id>` invocation (E19)', () => {
  const argv = interruptArgv({ sessionId: 'ses_f6f0a1e89ffe702DvBLQmWfcpn' })
  assert.deepEqual(argv, ['api', 'session.interrupt', '--param', 'sessionID=ses_f6f0a1e89ffe702DvBLQmWfcpn'])
})

test('classifyError no longer special-cases a session.error event (v2 only emits "error", E18)', () => {
  const lines = [
    JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'partial', messageID: 'm1' } }),
    JSON.stringify({ type: 'session.error', error: { message: 'boom' } }),
  ].join('\n')
  const error = classifyError(lines)
  assert.equal(error, null, 'session.error is not a recognized v2 event type, so it is ignored and the text event still counts as success')
})

test('listModels parses the real `opencode api model.list` JSON envelope (v2 catalog, E9)', () => {
  const models = listModels(read('model-list.json'))
  assert.equal(models.length, 3)
  const byId = Object.fromEntries(models.map((m) => [m.id, m]))
  assert.ok(byId['opencode/muse-spark-1.3-contributor-free'], 'id is rebuilt as providerID/id, matching DELEGATION_MAP keys exactly')
  assert.ok(byId['opencode/jev-1.13-free'], 'a free model with no variants and capabilities.tools:false still comes through')
  assert.ok(byId['deepseek/deepseek-v4-flash'], 'a paid model on a different provider is included in the same single-call catalog')
  assert.equal(byId['opencode/muse-spark-1.3-contributor-free'].label, 'Muse Spark 1.3 Free')
})

test('listModels passes cost/limit/variants through untouched in their v2 shapes (array cost, {context,output} limit)', () => {
  const models = listModels(read('model-list.json'))
  const byId = Object.fromEntries(models.map((m) => [m.id, m]))

  const free = byId['opencode/jev-1.13-free']
  assert.ok(Array.isArray(free.cost), 'v2 cost is an array, unlike v1\'s single object')
  assert.equal(free.cost[0].input, 0)
  assert.equal(free.limit.context, 64000)
  assert.deepEqual(free.variants, [], 'a model with no reasoning variants keeps an empty array, not undefined')

  const withVariants = byId['opencode/muse-spark-1.3-contributor-free']
  assert.equal(withVariants.variants.length, 5)

  const paid = byId['deepseek/deepseek-v4-flash']
  assert.ok(paid.cost[0].input > 0)
})

test('listModels falls back to parsing bare "<provider>/<id>" lines when stdout is not the JSON envelope (e.g. the server is down)', () => {
  const stdout = 'opencode/muse-spark-1.3-contributor-free\ndeepseek/deepseek-v4-flash\n'
  const models = listModels(stdout)
  assert.deepEqual(models, [{ id: 'opencode/muse-spark-1.3-contributor-free' }, { id: 'deepseek/deepseek-v4-flash' }])
})

test('listModels\'s fallback parser rejects stray non-id lines instead of treating them as fake models', () => {
  const stdout = ['HTTP/1.1 400 Bad Request', '', 'opencode/muse-spark-1.3-contributor-free', 'usage: opencode [options]', '{"error":"boom"}'].join('\n')
  const models = listModels(stdout)
  assert.deepEqual(models, [{ id: 'opencode/muse-spark-1.3-contributor-free' }])
})

test('listModels returns an empty array (never throws) for stdout that matches neither format', () => {
  const models = listModels('opencode: command not found\n')
  assert.deepEqual(models, [])
})

test('parseResult tolerates a tokens object missing a component instead of reporting NaN', () => {
  // Not every model reports every component -- a model without reasoning
  // support can omit `reasoning` entirely. An unguarded sum would turn the
  // whole total into NaN and carry it into the job result.
  const stdout = [
    JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { messageID: 'm1', text: 'hi' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_x', part: { messageID: 'm1', cost: 0, tokens: { input: 10, output: 5 } } }),
  ].join('\n')

  const result = parseResult(stdout)
  assert.equal(result.tokens, 15)
})

test('listModels fallback accepts a nested model id (provider/vendor/model#variant)', () => {
  // v2 documents the id format as provider/model#variant where the provider
  // ends at the FIRST slash and the model itself may contain more, e.g.
  // openrouter/anthropic/claude-sonnet-4.5. No provider configured on this
  // machine produces one today, but silently dropping such a model from the
  // catalog would mark it unavailable with a misleading "model not listed".
  const stdout = ['openrouter/anthropic/claude-sonnet-4.5', 'opencode/big-pickle'].join('\n')

  const models = listModels(stdout)
  assert.deepEqual(
    models.map((m) => m.id),
    ['openrouter/anthropic/claude-sonnet-4.5', 'opencode/big-pickle']
  )
})

test('sessionIdFrom recovers the session id from partial NDJSON stdout', () => {
  // A canceled or timed-out run never reaches a terminal parse, but every
  // line carries a top-level sessionID (E19), so the id needed to interrupt
  // the server-side session is already in whatever stdout was captured.
  const partial = [
    '[skill-registry] skipping refresh: not a project root: /',
    JSON.stringify({ type: 'step_start', sessionID: 'ses_abc', part: { messageID: 'm1' } }),
    '{ truncated mid-line',
  ].join('\n')

  assert.equal(sessionIdFrom(partial), 'ses_abc')
  assert.equal(sessionIdFrom(''), null)
})

test('classifyError maps a "Transport" error event to a retriable transport failure, not a crash', () => {
  // Real capture (2026-09-23): opencode 2.x replaced its shared background
  // service (version-mismatch 2.0.14 -> 2.0.15) and every attached `run`
  // session received this event at the same instant.
  const stdout = [
    JSON.stringify({ type: 'step_start', sessionID: 'ses_t', part: { messageID: 'm1' } }),
    JSON.stringify({ type: 'error', timestamp: 1790169947641, sessionID: 'ses_t', error: { type: 'unknown', message: 'Transport' } }),
  ].join('\n')

  const result = classifyError(stdout)
  assert.equal(result.kind, 'transport')
  assert.equal(result.retriable, true)
  assert.match(result.message, /transport/i)
})

test('classifyError treats connection-level error messages as transport', () => {
  for (const message of ['ECONNRESET', 'socket hang up', 'fetch failed', 'connect ECONNREFUSED 127.0.0.1:4096']) {
    const stdout = JSON.stringify({ type: 'error', sessionID: 'ses_t', error: { type: 'unknown', message } })
    assert.equal(classifyError(stdout).kind, 'transport', message)
  }
})

test('classifyError recognizes the real captured "Transport: ...socket connection was closed" message as retriable transport, not a crash (T4, job 0ebdbb0a: narrower upstream pattern only matched the bare "Transport" string)', () => {
  const stdout = JSON.stringify({
    type: 'error',
    sessionID: 'ses_t',
    error: {
      type: 'unknown',
      message:
        'Transport: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to the client constructor.',
    },
  })
  const result = classifyError(stdout)
  assert.equal(result.kind, 'transport')
  assert.equal(result.retriable, true)
})

test('classifyError classifies a provider.no-route "Variant unavailable" error as a non-retriable no_route kind, with the original message preserved (T4, odd/tasks/opencode-live-catalog.md)', () => {
  const message = 'provider.no-route: Variant unavailable for opencode/nemotron-3-ultra-free: high'
  const stdout = JSON.stringify({ type: 'error', sessionID: 'ses_t', error: { type: 'provider.no-route', message } })
  const result = classifyError(stdout)
  assert.equal(result.kind, 'no_route')
  assert.equal(result.retriable, false)
  assert.equal(result.message, message)
})

test('classifyError also recognizes a "Variant unavailable" message by text even when error.type is not literally "provider.no-route"', () => {
  const message = 'provider.no-route: Variant unavailable for opencode/nemotron-3-ultra-free: high'
  const stdout = JSON.stringify({ type: 'error', sessionID: 'ses_t', error: { type: 'unknown', message } })
  const result = classifyError(stdout)
  assert.equal(result.kind, 'no_route')
  assert.equal(result.retriable, false)
  assert.equal(result.message, message)
})

test('classifyError still reports an unrecognised error event as a crash', () => {
  const stdout = JSON.stringify({ type: 'error', sessionID: 'ses_t', error: { type: 'unknown', message: 'Tool execution exploded' } })
  assert.equal(classifyError(stdout).kind, 'crash')
})

test('sessionExportArgv builds the session export call', () => {
  assert.deepEqual(sessionExportArgv('ses_abc'), ['session', 'export', 'ses_abc'])
})

test('opencodeOccupancyFromExport uses the last message with tokens: input + cache read + cache write', () => {
  const exp = {
    info: { tokens: { input: 999999, cache: { read: 999999, write: 0 } } },
    messages: [
      { info: { role: 'user' } },
      { info: { role: 'assistant', tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 20, write: 0 } } } },
      { info: { role: 'assistant', tokens: { input: 1076, output: 29, reasoning: 120, cache: { read: 35057, write: 0 } } } },
      { info: { role: 'user' } },
    ],
  }
  assert.equal(opencodeOccupancyFromExport(exp), 36133)
})

test('opencodeOccupancyFromExport also reads tokens placed directly on the message', () => {
  assert.equal(opencodeOccupancyFromExport({ messages: [{ tokens: { input: 5, cache: { read: 2, write: 3 } } }] }), 10)
})

test('opencodeOccupancyFromExport treats missing parts as 0 and tolerates garbage', () => {
  assert.equal(opencodeOccupancyFromExport({ messages: [{ info: { tokens: { input: 7 } } }] }), 7)
  assert.equal(opencodeOccupancyFromExport({ messages: [{ info: { tokens: { cache: { read: 4 } } } }] }), 4)
  for (const bad of [null, undefined, 'x', 3, {}, { messages: [] }, { messages: 'x' }, { messages: [null, {}, { info: {} }] },
    { messages: [{ info: { tokens: {} } }] }, { messages: [{ info: { tokens: { input: 'a' } } }] }]) {
    assert.equal(opencodeOccupancyFromExport(bad), null)
  }
})

test('readSessionOccupancy runs the export argv with a timeout and parses the occupancy', () => {
  const calls = []
  const execFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return JSON.stringify({ messages: [{ info: { tokens: { input: 1, cache: { read: 2, write: 3 } } } }] })
  }
  assert.equal(readSessionOccupancy('ses_x', { execFn, timeoutMs: 1234, env: { A: '1' } }), 6)
  assert.equal(calls[0].cmd, 'opencode')
  assert.deepEqual(calls[0].args, ['session', 'export', 'ses_x'])
  assert.equal(calls[0].opts.timeout, 1234)
  assert.ok(calls[0].opts.maxBuffer >= 64 * 1024 * 1024)
})

test('readSessionOccupancy is fail-soft: exec error, invalid JSON, missing session id all give null', () => {
  assert.equal(readSessionOccupancy('ses_x', { execFn: () => { throw new Error('ETIMEDOUT') } }), null)
  assert.equal(readSessionOccupancy('ses_x', { execFn: () => 'not json' }), null)
  assert.equal(readSessionOccupancy('', { execFn: () => '{}' }), null)
})
