import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { toBusybitsEvents, createBusybitsEventStream, hasBusybitsTranslator } from '../src/busybits-events.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'busybits-events')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')
const brief = (events) => events.map((e) => [e.type, e.data.toolName ?? e.data.content ?? null, e.data.arguments ?? null])

test('codex: commands, file changes, MCP calls, searches, reasoning and replies map to Copilot-shaped events', () => {
  assert.deepEqual(brief(toBusybitsEvents('codex', read('codex-session.jsonl'))), [
    ['reasoning', null, null],
    ['tool.execution_start', 'bash', { command: "bash -lc 'rg TODO src'" }],
    ['tool.execution_start', 'edit', { path: '/repo/src/a.js' }],
    ['tool.execution_start', 'write', { path: '/repo/src/b.js' }],
    ['tool.execution_start', 'mem_search', { query: 'x' }],
    ['tool.execution_start', 'search_web', { query: 'node test runner' }],
    ['assistant.message', 'Done: updated a.js', null],
  ])
})

test('codex: thread/turn bookkeeping and failures produce no activity events', () => {
  const failed = fs.readFileSync(path.join(FIXTURES, '..', 'codex', 'exec-bad-model.jsonl'), 'utf8')
  assert.deepEqual(toBusybitsEvents('codex', failed), [])
})

test('opencode: each tool call is announced once with its input; pending calls and step bookkeeping are skipped', () => {
  const events = toBusybitsEvents('opencode', read('opencode-session.jsonl'))
  assert.deepEqual(brief(events), [
    ['tool.execution_start', 'read', { filePath: '/repo/src/a.js' }],
    ['tool.execution_start', 'edit', { filePath: '/repo/src/a.js', oldString: 'a', newString: 'b' }],
    ['tool.execution_start', 'bash', { command: 'npm test' }],
    ['assistant.message', 'All done', null],
  ])
  assert.equal(events[0].timestamp, new Date(1789139000000).toISOString())
})

test('opencode: a tool call without input still shows the tool name (empty fixture)', () => {
  const empty = fs.readFileSync(path.join(FIXTURES, '..', 'opencode', 'empty.jsonl'), 'utf8')
  assert.deepEqual(brief(toBusybitsEvents('opencode', empty)), [['tool.execution_start', 'read', {}]])
})

test('agents without a translator are untouched', () => {
  assert.equal(hasBusybitsTranslator('agy'), false)
  assert.equal(hasBusybitsTranslator('codex'), true)
  assert.equal(createBusybitsEventStream('copilot', () => {}), null)
  assert.deepEqual(toBusybitsEvents('agy', '{"type":"x"}'), [])
})

test('stream: lines split across chunks are reassembled, duplicates dropped, a trailing partial line flushed on end', () => {
  const raw = read('opencode-session.jsonl')
  const out = []
  const stream = createBusybitsEventStream('opencode', (line) => out.push(line))
  for (let i = 0; i < raw.length; i += 37) stream.write(raw.slice(i, i + 37))
  stream.end()
  const streamed = out.join('')
  assert.ok(streamed.endsWith('\n'))
  assert.deepEqual(streamed.trim().split('\n').map((l) => JSON.parse(l)), toBusybitsEvents('opencode', raw))

  const tail = []
  const s2 = createBusybitsEventStream('codex', (line) => tail.push(line))
  s2.write('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"hi"}}')
  assert.equal(tail.length, 0)
  s2.end()
  assert.equal(JSON.parse(tail[0]).data.content, 'hi')
})

test('stream: a failing sink never throws into the job runner', () => {
  const s = createBusybitsEventStream('codex', () => { throw new Error('disk full') })
  assert.doesNotThrow(() => { s.write('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"x"}}\n'); s.end() })
})
