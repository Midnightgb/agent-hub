import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  routeEvent,
  consoleAdapter,
  createFileAdapter,
  createWebhookAdapter,
  formatLine,
} from '../src/notify/adapters.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-adapters-'))
}

test('routeEvent maps terminal kinds', () => {
  assert.equal(routeEvent({ kind: 'job.finished' }), 'job.finished')
  assert.equal(routeEvent({ kind: 'job.failed' }), 'job.failed')
  assert.equal(routeEvent({ kind: 'workflow.completed' }), 'workflow.completed')
})

test('routeEvent detects jules waiting from the job_wait waiting signal', () => {
  // pollingStoppedReason is what cloud/poller.mjs writes when a remote
  // session stops for interaction; job_wait surfaces it as waiting:true.
  assert.equal(routeEvent({ kind: 'job.started', pollingStoppedReason: 'awaiting_interaction' }), 'jules.waiting')
  assert.equal(routeEvent({ kind: 'job.started', waiting: true }), 'jules.waiting')
  assert.equal(routeEvent({ kind: 'job.started', state: 'AWAITING_PLAN_APPROVAL' }), 'jules.waiting')
  assert.equal(routeEvent({ kind: 'job.started', state: 'PAUSED' }), 'jules.waiting')
  // Nested record shape (emitters wrapping a job_wait payload).
  assert.equal(routeEvent({ kind: 'job.started', record: { state: 'AWAITING_USER_FEEDBACK' } }), 'jules.waiting')
})

test('routeEvent detects jules attention_required first (more specific than waiting)', () => {
  assert.equal(routeEvent({ kind: 'job.started', attentionRequired: true }), 'jules.attention_required')
  assert.equal(
    routeEvent({ kind: 'job.finished', attentionRequired: true, pollingStoppedReason: 'awaiting_interaction' }),
    'jules.attention_required'
  )
  assert.equal(routeEvent({ record: { attentionRequired: true } }), 'jules.attention_required')
})

test('routeEvent routes job.canceled', () => {
  assert.equal(routeEvent({ kind: 'job.canceled' }), 'job.canceled')
})

test('routeEvent ignores unlisted kinds and malformed input', () => {
  for (const kind of ['job.queued', 'job.started', 'preflight', 'subagent.stop', 'proposal.created', 'learning.proposed', 'other']) {
    assert.equal(routeEvent({ kind }), null, kind)
  }
  assert.equal(routeEvent(null), null)
  assert.equal(routeEvent(undefined), null)
  assert.equal(routeEvent('job.finished'), null)
  assert.equal(routeEvent({}), null)
})

test('consoleAdapter logs one line for interesting events, ignores the rest', () => {
  const lines = []
  assert.equal(consoleAdapter({ kind: 'job.finished', jobId: 'j1', title: 't' }, { log: (l) => lines.push(l) }), true)
  assert.equal(lines.length, 1)
  assert.ok(lines[0].includes('job.finished') && lines[0].includes('j1'))

  assert.equal(consoleAdapter({ kind: 'preflight', status: 'ready' }, { log: (l) => lines.push(l) }), false)
  assert.equal(lines.length, 1, 'unlisted kinds produce no output')
})

test('consoleAdapter never throws', () => {
  assert.equal(consoleAdapter(null), false)
  assert.doesNotThrow(() => consoleAdapter({ kind: 'job.finished', summary: 'x'.repeat(5000) }))
})

test('formatLine carries no more than display-safe fields', () => {
  const line = formatLine(
    { kind: 'job.finished', jobId: 'j1', title: 't', summary: 'done', JULES_API_KEY: 'secret', apiKey: 'secret' },
    'job.finished'
  )
  assert.ok(!line.includes('secret'), 'secrets must not leak into the log line')
})

test('fileAdapter appends one JSON line per interesting event, ignores the rest', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const file = path.join(env.AGENT_HUB_HOME, 'custom', 'notes.jsonl')
  const sink = createFileAdapter({ file })

  assert.equal(sink({ kind: 'job.finished', jobId: 'j1', title: 'done' }), true)
  assert.equal(sink({ kind: 'preflight' }), false)

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0])
  assert.equal(parsed.category, 'job.finished')
  assert.equal(parsed.jobId, 'j1')
  assert.ok(!('JULES_API_KEY' in parsed))
})

test('webhookAdapter without URL never throws and reports no_url', async () => {
  const sink = createWebhookAdapter({})
  const result = await sink({ kind: 'job.finished', jobId: 'j1' })
  assert.deepEqual(result, { delivered: false, reason: 'no_url' })

  // Ignored kinds resolve too, even with a URL configured.
  const withUrl = createWebhookAdapter({ url: 'http://127.0.0.1:1/' })
  assert.deepEqual(await withUrl({ kind: 'preflight' }), { delivered: false, reason: 'ignored' })
})

test('webhookAdapter never throws on unreachable endpoint', async () => {
  const sink = createWebhookAdapter({ url: 'http://127.0.0.1:1/', timeoutMs: 1000 })
  const result = await sink({ kind: 'job.failed', jobId: 'j9' })
  assert.equal(result.delivered, false)
  assert.ok(typeof result.reason === 'string')
})

test('webhookAdapter POSTs category + event and reports delivered', async () => {
  const { default: http } = await import('node:http')
  let body = null
  const server = http.createServer((req, res) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      body = JSON.parse(data)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const sink = createWebhookAdapter({ url: `http://127.0.0.1:${port}/hook` })
    const result = await sink({ kind: 'job.finished', jobId: 'j2', title: 'ok' })
    assert.deepEqual(result, { delivered: true })
    assert.equal(body.category, 'job.finished')
    assert.equal(body.event.jobId, 'j2')
  } finally {
    server.close()
  }
})
