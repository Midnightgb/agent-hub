import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { createServer } from '../src/dashboard.mjs'
import { MetricsResponse } from '../src/schemas.mjs'
import { writeJsonAtomic } from '../src/fsutil.mjs'
import { paths } from '../src/config.mjs'
import { createJob, updateResult, responsePath } from '../src/jobstore.mjs'

// New JSON routes added when the dashboard started serving the Vite-built
// React app instead of the vanilla bundle: metrics, proposals, learnings and
// the job-result endpoint the job detail view needs.

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dashboard-api-v2-'))
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function request(port, urlPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: { Host: '127.0.0.1', ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
      },
      (res) => {
        let raw = ''
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let parsed = null
          try {
            parsed = raw ? JSON.parse(raw) : null
          } catch {
            parsed = raw
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed })
        })
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

// --- metrics ---

test('GET /api/metrics returns a payload matching MetricsResponse', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/metrics')
    assert.equal(res.status, 200)
    const parsed = MetricsResponse.parse(res.body)
    assert.ok(Array.isArray(parsed.rows))
    assert.deepEqual(parsed.groupBy, ['agent', 'model', 'mode', 'taskType'])
  } finally {
    server.close()
  }
})

test('GET /api/metrics?groupBy= ignores unknown dimension names and keeps the known ones', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/metrics?groupBy=agent,bogus')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.groupBy, ['agent'])
  } finally {
    server.close()
  }
})

test('GET /api/metrics?groupBy=bogus (all unknown) falls back to the default groupBy', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/metrics?groupBy=bogus,alsobogus')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.groupBy, ['agent', 'model', 'mode', 'taskType'])
  } finally {
    server.close()
  }
})

// --- proposals ---

test('GET /api/proposals returns an empty list with no proposals.json yet', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/proposals')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.proposals, [])
  } finally {
    server.close()
  }
})

test('POST /api/proposals/refresh recomputes from metrics and returns the stored proposals array', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/proposals/refresh', { method: 'POST', body: {} })
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.proposals))
  } finally {
    server.close()
  }
})

test('GET /api/proposals and POST /api/proposals/refresh include a drift list from a fresh, error-free opencode discovery row', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  writeJsonAtomic(paths(env).discoveryFile, {
    opencode: {
      agent: 'opencode',
      cmd: 'opencode',
      binPath: '/bin/opencode',
      version: 'opencode v2.0.18',
      // opencode/mimo-v2.5-free is pinned tier:'free' in MODEL_REGISTRY but is
      // no longer in this live catalog -- a "vanished" drift item.
      models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }],
      checkedAt: new Date().toISOString(),
      error: null,
    },
  })
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const get = await request(port, '/api/proposals')
    assert.equal(get.status, 200)
    assert.ok(Array.isArray(get.body.drift))
    assert.ok(get.body.drift.some((d) => d.type === 'vanished' && d.agent === 'opencode' && d.model === 'opencode/mimo-v2.5-free'))

    const refresh = await request(port, '/api/proposals/refresh', { method: 'POST', body: {} })
    assert.equal(refresh.status, 200)
    assert.ok(refresh.body.drift.some((d) => d.type === 'vanished' && d.model === 'opencode/mimo-v2.5-free'))
  } finally {
    server.close()
  }
})

test('GET /api/proposals and POST /api/proposals/refresh include an unmapped list of catalog models with no safe taskType', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  writeJsonAtomic(paths(env).discoveryFile, {
    agy: {
      agent: 'agy',
      cmd: 'agy',
      binPath: '/bin/agy',
      version: 'v1',
      models: [{ id: 'gemini-9.9-nova-low' }],
      checkedAt: new Date().toISOString(),
      error: null,
    },
  })
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const get = await request(port, '/api/proposals')
    assert.equal(get.status, 200)
    assert.ok(Array.isArray(get.body.unmapped))
    assert.ok(get.body.unmapped.some((m) => m.agent === 'agy' && m.model === 'gemini-9.9-nova-low'))

    const refresh = await request(port, '/api/proposals/refresh', { method: 'POST', body: {} })
    assert.equal(refresh.status, 200)
    assert.ok(refresh.body.unmapped.some((m) => m.agent === 'agy' && m.model === 'gemini-9.9-nova-low'))
  } finally {
    server.close()
  }
})

function seedPendingProposal(env, overrides = {}) {
  const proposal = {
    id: 'prop-recon-test-1',
    taskType: 'recon',
    chainHash: 'deadbeef0000',
    fromOrder: [{ agent: 'agy', model: 'gemini-3.8-flash-low' }],
    toOrder: [{ agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }],
    evidence: {},
    reason: 'test seed',
    status: 'pending',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    ...overrides,
  }
  writeJsonAtomic(paths(env).proposalsFile, { version: 1, proposals: [proposal] })
  return proposal
}

test('POST /api/proposals/:id/accept accepts a pending proposal', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const proposal = seedPendingProposal(env)
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, `/api/proposals/${proposal.id}/accept`, { method: 'POST', body: {} })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'accepted')
  } finally {
    server.close()
  }
})

test('POST /api/proposals/:id/reject rejects a pending proposal', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const proposal = seedPendingProposal(env)
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, `/api/proposals/${proposal.id}/reject`, { method: 'POST', body: {} })
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'rejected')
  } finally {
    server.close()
  }
})

test('POST /api/proposals/:id/accept for an unknown id returns 404', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/proposals/does-not-exist/accept', { method: 'POST', body: {} })
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})

test('POST /api/proposals/:id/accept on an already-decided proposal returns 409', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const proposal = seedPendingProposal(env, { status: 'accepted', decidedAt: new Date().toISOString() })
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, `/api/proposals/${proposal.id}/accept`, { method: 'POST', body: {} })
    assert.equal(res.status, 409)
  } finally {
    server.close()
  }
})

// --- learnings ---

test('POST /api/learnings creates a pending learning (201)', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/learnings', { method: 'POST', body: { text: 'agy hangs on very long prompts' } })
    assert.equal(res.status, 201)
    assert.equal(res.body.status, 'pending')
    assert.equal(res.body.text, 'agy hangs on very long prompts')
  } finally {
    server.close()
  }
})

test('POST /api/learnings with empty text returns 400', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/learnings', { method: 'POST', body: { text: '' } })
    assert.equal(res.status, 400)
  } finally {
    server.close()
  }
})

test('GET /api/learnings lists learnings, optionally filtered by status', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const created = await request(port, '/api/learnings', { method: 'POST', body: { text: 'opencode needs explicit file paths' } })
    assert.equal(created.status, 201)

    const all = await request(port, '/api/learnings')
    assert.equal(all.status, 200)
    assert.equal(all.body.learnings.length, 1)

    const pending = await request(port, '/api/learnings?status=pending')
    assert.equal(pending.body.learnings.length, 1)

    const approved = await request(port, '/api/learnings?status=approved')
    assert.equal(approved.body.learnings.length, 0)
  } finally {
    server.close()
  }
})

test('POST /api/learnings/:id/approve and /reject decide a learning; DELETE removes it', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const created = await request(port, '/api/learnings', { method: 'POST', body: { text: 'copilot ignores system prompt hints' } })
    const id = created.body.id

    const approved = await request(port, `/api/learnings/${id}/approve`, { method: 'POST', body: {} })
    assert.equal(approved.status, 200)
    assert.equal(approved.body.status, 'approved')

    const created2 = await request(port, '/api/learnings', { method: 'POST', body: { text: 'a second distinct learning entry' } })
    const id2 = created2.body.id
    const rejected = await request(port, `/api/learnings/${id2}/reject`, { method: 'POST', body: {} })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.status, 'rejected')

    const deleted = await request(port, `/api/learnings/${id}`, { method: 'DELETE', body: {} })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.deleted, true)

    const remaining = await request(port, '/api/learnings')
    assert.equal(remaining.body.learnings.some((l) => l.id === id), false)
  } finally {
    server.close()
  }
})

test('POST /api/learnings/:id/approve for an unknown id returns 404', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/learnings/does-not-exist/approve', { method: 'POST', body: {} })
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})

test('DELETE /api/learnings/:id for an unknown id returns 404', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/learnings/does-not-exist', { method: 'DELETE', body: {} })
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})

// --- job result ---
// jobResultTool (src/tools/jobs.mjs) reads via jobstore's process.env-default
// env param, so this route is only reachable with the dashboard's own
// process.env.AGENT_HUB_HOME set to the fixture home — mirrors how
// test/tools-jobs.test.mjs exercises the same tool.

test('GET /api/jobs/:id/result returns the job response text and metadata', async () => {
  const home = tmpHome()
  const previousHome = process.env.AGENT_HUB_HOME
  process.env.AGENT_HUB_HOME = home
  try {
    const env = { AGENT_HUB_HOME: home }
    const job = createJob({ agent: 'agy', model: 'x', task: 't', cwd: '/tmp', title: 't', mode: 'read', env })
    updateResult(job.jobId, { status: 'succeeded' }, env)
    fs.writeFileSync(responsePath(job.jobId, env), ['line one', 'line two', 'line three'].join('\n'), 'utf8')

    const server = createServer({ env })
    const port = await listen(server)
    try {
      const res = await request(port, `/api/jobs/${job.jobId}/result?maxLines=2&tailLines=1`)
      assert.equal(res.status, 200)
      assert.equal(res.body.status, 'succeeded')
      assert.match(res.body.text, /line one\nline two/)
      assert.equal(res.body.totalLines, 3)
    } finally {
      server.close()
    }
  } finally {
    process.env.AGENT_HUB_HOME = previousHome
  }
})

test('GET /api/jobs/:id/result for an unknown job returns 404', async () => {
  const home = tmpHome()
  const previousHome = process.env.AGENT_HUB_HOME
  process.env.AGENT_HUB_HOME = home
  try {
    const env = { AGENT_HUB_HOME: home }
    const server = createServer({ env })
    const port = await listen(server)
    try {
      const res = await request(port, '/api/jobs/does-not-exist/result')
      assert.equal(res.status, 404)
    } finally {
      server.close()
    }
  } finally {
    process.env.AGENT_HUB_HOME = previousHome
  }
})

test('GET /api/jobs/..%2F..%2Fetc/result cannot escape runs/ even when a file exists there', async () => {
  const base = tmpHome()
  const home = path.join(base, 'nested')
  fs.mkdirSync(path.join(home, 'runs'), { recursive: true })
  // Plant a valid job record two directories above runs/, which is exactly
  // where the unvalidated id `../../etc` resolves. Without central validation
  // in jobstore this is returned as a 200.
  const escapedDir = path.join(base, 'etc')
  fs.mkdirSync(escapedDir, { recursive: true })
  fs.writeFileSync(path.join(escapedDir, 'result.json'), JSON.stringify({ jobId: 'etc', status: 'succeeded' }), 'utf8')

  const previousHome = process.env.AGENT_HUB_HOME
  process.env.AGENT_HUB_HOME = home
  try {
    const env = { AGENT_HUB_HOME: home }
    const server = createServer({ env })
    const port = await listen(server)
    try {
      const res = await request(port, '/api/jobs/..%2F..%2Fetc/result')
      assert.equal(res.status, 404)
    } finally {
      server.close()
    }
  } finally {
    process.env.AGENT_HUB_HOME = previousHome
  }
})

// --- write-route guards reused from the existing dashboard hardening ---

test('write routes under the new API (proposals refresh, learnings create) reject a missing JSON content type', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const refresh = await request(port, '/api/proposals/refresh', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: undefined })
    assert.equal(refresh.status, 415)

    const learning = await request(port, '/api/learnings', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: undefined })
    assert.equal(learning.status, 415)
  } finally {
    server.close()
  }
})

test('write routes under the new API reject a foreign Origin', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await request(port, '/api/learnings', {
      method: 'POST',
      headers: { Origin: 'http://evil.example' },
      body: { text: 'should be rejected' },
    })
    assert.equal(res.status, 403)
  } finally {
    server.close()
  }
})

// --- providers mode ---

test('POST /api/providers/mode sets mode and returns snapshot', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    // Set off
    const offRes = await request(port, '/api/providers/mode', {
      method: 'POST',
      body: { mode: 'off' },
    })
    assert.equal(offRes.status, 200)
    assert.equal(offRes.body.mode, 'off')
    assert.equal(offRes.body.source, 'setting')

    // Set profile
    const profileRes = await request(port, '/api/providers/mode', {
      method: 'POST',
      body: { mode: 'profile', profile: 'work' },
    })
    assert.equal(profileRes.status, 200)
    assert.equal(profileRes.body.mode, 'profile')
    assert.equal(profileRes.body.pinnedProfile, 'work')
    assert.equal(profileRes.body.source, 'setting')

    // Check file was persisted
    const modeFile = path.join(env.AGENT_HUB_HOME, 'agys-mode.json')
    assert.ok(fs.existsSync(modeFile))
    const persisted = JSON.parse(fs.readFileSync(modeFile, 'utf8'))
    assert.deepEqual(persisted, { mode: 'profile', profile: 'work' })

    // Invalid mode -> 400
    const invalidModeRes = await request(port, '/api/providers/mode', {
      method: 'POST',
      body: { mode: 'invalid' },
    })
    assert.equal(invalidModeRes.status, 400)

    // Missing profile when mode is profile -> 400
    const missingProfileRes = await request(port, '/api/providers/mode', {
      method: 'POST',
      body: { mode: 'profile' },
    })
    assert.equal(missingProfileRes.status, 400)
  } finally {
    server.close()
  }
})
