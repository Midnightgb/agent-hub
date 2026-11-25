import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createServer } from '../src/dashboard.mjs'

// opencode-model-policy T4 (S1): the dashboard API that reads and edits
// model-policy.json for the Agents view.

const FREE = [{ input: 0, output: 0 }]
const PAID = [{ input: 1, output: 2 }]

async function withServer(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dash-policy-'))
  const models = [
    { id: 'opencode/glm-5.3-flash-free', cost: FREE },
    { id: 'opencode-go/kimi-k3', cost: PAID },
  ]
  fs.writeFileSync(path.join(home, 'discovery.json'), JSON.stringify({ opencode: { checkedAt: '2026-10-25T00:00:00.000Z', error: null, models } }))
  const server = createServer({ env: { ...process.env, AGENT_HUB_HOME: home } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(server.address().port, home)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function request(port, urlPath, { method = 'GET', data } = {}) {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? '' : JSON.stringify(data)
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

test('GET /api/model-policy lists the opencode catalog with pool, decision and new marker', async () => {
  await withServer(async (port) => {
    const res = await request(port, '/api/model-policy?agent=opencode')
    assert.equal(res.status, 200)
    assert.equal(res.body.agent, 'opencode')
    assert.equal(res.body.catalogAvailable, true)
    assert.equal(res.body.catalogCheckedAt, '2026-10-25T00:00:00.000Z')
    assert.deepEqual(res.body.models, [
      { id: 'opencode-go/kimi-k3', pool: 'go', allowed: false, source: 'default', isNew: true },
      { id: 'opencode/glm-5.3-flash-free', pool: 'free', allowed: true, source: 'default', isNew: true },
    ])
  })
})

test('GET /api/model-policy defaults to opencode and rejects an agent the policy does not cover', async () => {
  await withServer(async (port) => {
    assert.equal((await request(port, '/api/model-policy')).body.agent, 'opencode')
    const bad = await request(port, '/api/model-policy?agent=agy')
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /model policy only covers opencode/)
  })
})

test('POST /api/model-policy records a decision that GET reflects and model-policy.json persists', async () => {
  await withServer(async (port, home) => {
    const res = await request(port, '/api/model-policy', { method: 'POST', data: { agent: 'opencode', model: 'opencode-go/kimi-k3', allowed: true } })
    assert.equal(res.status, 200)
    assert.equal(res.body.allowed, true)
    const view = await request(port, '/api/model-policy?agent=opencode')
    assert.deepEqual(view.body.models.find((m) => m.id === 'opencode-go/kimi-k3'), { id: 'opencode-go/kimi-k3', pool: 'go', allowed: true, source: 'user', isNew: false })
    const stored = JSON.parse(fs.readFileSync(path.join(home, 'model-policy.json'), 'utf8'))
    assert.equal(stored.opencode.decisions['opencode-go/kimi-k3'].allowed, true)
  })
})

test('POST /api/model-policy rejects a non-boolean allowed with 400 and writes nothing', async () => {
  await withServer(async (port, home) => {
    const res = await request(port, '/api/model-policy', { method: 'POST', data: { agent: 'opencode', model: 'opencode-go/kimi-k3', allowed: 'yes' } })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /allowed must be a boolean/)
    assert.equal(fs.existsSync(path.join(home, 'model-policy.json')), false)
  })
})

test('PUT /api/model-policy/order sets the priority order that GET returns first', async () => {
  await withServer(async (port) => {
    const res = await request(port, '/api/model-policy/order', { method: 'PUT', data: { agent: 'opencode', order: ['opencode/glm-5.3-flash-free'] } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.order, ['opencode/glm-5.3-flash-free'])
    const view = await request(port, '/api/model-policy?agent=opencode')
    assert.equal(view.body.models[0].id, 'opencode/glm-5.3-flash-free')
    const bad = await request(port, '/api/model-policy/order', { method: 'PUT', data: { agent: 'opencode', order: 'x' } })
    assert.equal(bad.status, 400)
  })
})

test('GET /api/config keeps opencode in resolvedBins whatever the process AGENT_HUB_HOME holds (verifier B1)', async () => {
  const previous = process.env.AGENT_HUB_HOME
  process.env.AGENT_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dash-policy-empty-'))
  try {
    await withServer(async (port) => {
      const res = await request(port, '/api/config')
      assert.equal(res.status, 200)
      assert.ok('opencode' in res.body.process.resolvedBins, 'opencode is a DELEGATION_MAP agent even when its pools resolve to nothing')
    })
  } finally {
    process.env.AGENT_HUB_HOME = previous
  }
})
