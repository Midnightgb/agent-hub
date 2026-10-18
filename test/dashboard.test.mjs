import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import { isLoopback, isAllowedHost, isJsonContentType, isAllowedOrigin, createServer, buildState, startDashboard } from '../src/dashboard.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dashboard-'))
}

const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"

/**
 * A temp Vite `dist/` fixture: index.html referencing a hashed JS+CSS pair,
 * a `.vite/manifest.json` listing them plus a woff2 font asset, and the
 * actual asset files on disk.
 */
function distFixture({ jsName = 'index-abc123.js', cssName = 'index-abc123.css' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dashboard-dist-'))
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.vite'), { recursive: true })

  fs.writeFileSync(
    path.join(dir, 'index.html'),
    `<!doctype html><html><head><title>agent-hub dashboard</title><link rel="stylesheet" href="./assets/${cssName}"></head><body><script type="module" src="./assets/${jsName}"></script></body></html>`
  )
  fs.writeFileSync(path.join(dir, 'assets', jsName), `export const marker = ${JSON.stringify(jsName)}\n`)
  fs.writeFileSync(path.join(dir, 'assets', cssName), 'body { color: black; }\n')
  fs.writeFileSync(path.join(dir, 'assets', 'font-xyz.woff2'), 'fake-woff2-bytes')
  fs.writeFileSync(
    path.join(dir, '.vite', 'manifest.json'),
    JSON.stringify({
      'index.html': { file: `assets/${jsName}`, css: [`assets/${cssName}`], src: 'index.html', isEntry: true },
      'font.woff2': { file: 'assets/font-xyz.woff2', src: 'font.woff2' },
    })
  )
  return { dir, jsName, cssName }
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function get(port, urlPath, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

function postJson(port, urlPath, data, { method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = data === undefined ? '' : JSON.stringify(data)
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null }))
      }
    )
    req.on('error', reject)
    req.end(payload)
  })
}

// Raw http.request so tests can set Host/Origin/Content-Type exactly as
// wanted — fetch() forbids setting Host, and the postJson() helper above
// always sends a well-formed JSON Content-Type.
function rawRequest(port, urlPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
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
    })
    req.on('error', reject)
    req.end(body)
  })
}

// A raw socket write is the only way to send a request with no Host header
// at all — http.request always injects one unless overridden. Node's own
// HTTP/1.1 parser rejects a Host-less HTTP/1.1 request with its own 400
// before our request listener ever runs (stricter than what our handler
// could do), so this must speak HTTP/1.0 — which never mandated a Host
// header — to reach dashboard.mjs's own isAllowedHost() check.
function requestWithoutHostHeader(port, urlPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${urlPath} HTTP/1.0\r\n\r\n`)
    })
    let raw = ''
    socket.on('data', (c) => (raw += c))
    socket.on('end', () => {
      const statusLine = raw.split('\r\n')[0] || ''
      const match = statusLine.match(/^HTTP\/1\.\d (\d+)/)
      resolve({ status: match ? Number(match[1]) : null, raw })
    })
    socket.on('error', reject)
  })
}

function fakeRunner(responses) {
  const calls = []
  const runner = async (cmd, args) => {
    calls.push({ cmd, args })
    const key = `${cmd} ${args.join(' ')}`
    for (const [pattern, response] of responses) {
      if (typeof pattern === 'string' ? key.includes(pattern) : pattern.test(key)) return response
    }
    throw new Error(`fakeRunner: no response configured for "${key}"`)
  }
  runner.calls = calls
  return runner
}

test('isLoopback accepts 127.0.0.1 and ::1, rejects a routable address', () => {
  assert.equal(isLoopback('127.0.0.1'), true)
  assert.equal(isLoopback('::1'), true)
  assert.equal(isLoopback('::ffff:127.0.0.1'), true)
  assert.equal(isLoopback('192.168.1.50'), false)
  assert.equal(isLoopback('8.8.8.8'), false)
})

test('buildState reflects the jobstore, preflight cache and event log', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
  appendEvent({ kind: 'subagent.start', source: 'claude-hook', agent: 'claude', cwd: '/repo', title: 'Explore' }, { env })

  const state = buildState({ env })
  assert.ok(Array.isArray(state.agents))
  assert.ok(Array.isArray(state.jobs))
  assert.ok(Array.isArray(state.subagents))
  assert.equal(state.subagents.length, 1)
})

test('buildState enriches each agent row with dataPolicy (from MODEL_REGISTRY) and binPath/cliVersion (from discovery.json)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { writeCacheEntry } = await import('../src/preflight.mjs?t=' + Date.now())
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())

  writeCacheEntry('agy:gemini-3.8-flash-low', { agent: 'agy', model: 'gemini-3.8-flash-low', status: 'ready', checkedAt: new Date().toISOString() }, env)
  writeJsonAtomic(paths(env).discoveryFile, {
    agy: { agent: 'agy', cmd: 'agy', binPath: '/home/u/.local/bin/agy', version: '1.2.1', models: [], checkedAt: new Date().toISOString(), error: null },
  })

  const state = buildState({ env })
  const row = state.agents.find((a) => a.agent === 'agy' && a.model === 'gemini-3.8-flash-low')
  assert.equal(row.dataPolicy, 'unknown')
  assert.equal(row.binPath, '/home/u/.local/bin/agy')
  assert.equal(row.cliVersion, '1.2.1')
})

test('buildState enriches each agent row with tier/tierSource (src/catalog.mjs effectiveTier)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { writeCacheEntry } = await import('../src/preflight.mjs?t=' + Date.now())
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())

  writeCacheEntry('opencode:opencode/big-pickle', { agent: 'opencode', model: 'opencode/big-pickle', status: 'ready', checkedAt: new Date().toISOString() }, env)
  writeJsonAtomic(paths(env).discoveryFile, {
    opencode: {
      agent: 'opencode',
      cmd: 'opencode',
      binPath: '/bin/opencode',
      version: 'opencode v2.0.18',
      models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }],
      checkedAt: new Date().toISOString(),
      error: null,
    },
  })

  const state = buildState({ env })
  const row = state.agents.find((a) => a.agent === 'opencode' && a.model === 'opencode/big-pickle')
  assert.equal(row.tier, 'free')
  assert.equal(row.tierSource, 'catalog')
})

test('buildState jobs carry variant, sessionId, parentJobId and errorKind through to the dashboard (needed to render job_reply chains and the new billing/timeout/empty error badges)', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { createJob, updateResult } = await import('../src/jobstore.mjs?t=' + Date.now())

  const parent = createJob({
    agent: 'opencode',
    model: 'deepseek/deepseek-v4-pro',
    task: 't',
    cwd: '/tmp',
    title: 'parent job',
    mode: 'read',
    variant: 'high',
    env,
  })
  updateResult(parent.jobId, { status: 'failed', errorKind: 'billing', error: 'opencode billing error (402/insufficient balance)' }, env)

  const reply = createJob({
    agent: 'opencode',
    model: 'deepseek/deepseek-v4-pro',
    task: 't2',
    cwd: '/tmp',
    title: 'parent job (reply)',
    mode: 'read',
    sessionId: 'ses_abc',
    parentJobId: parent.jobId,
    env,
  })

  const state = buildState({ env })
  const jobsById = Object.fromEntries(state.jobs.map((j) => [j.jobId, j]))
  assert.equal(jobsById[parent.jobId].variant, 'high')
  assert.equal(jobsById[parent.jobId].errorKind, 'billing')
  assert.equal(jobsById[reply.jobId].sessionId, 'ses_abc')
  assert.equal(jobsById[reply.jobId].parentJobId, parent.jobId)
})

test('GET / serves the built dashboard shell (index.html, no-cache)', async () => {
  const { dir } = distFixture()
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    const res = await get(port, '/')
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/html/)
    assert.match(res.body, /<title>/i)
    assert.equal(res.headers['cache-control'], 'no-cache')
    assert.equal(res.headers['content-security-policy'], DASHBOARD_CSP)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
  } finally {
    server.close()
  }
})

test('GET /index.html serves the same shell as GET /', async () => {
  const { dir } = distFixture()
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    const res = await get(port, '/index.html')
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /text\/html/)
  } finally {
    server.close()
  }
})

test('hashed JS/CSS/font assets referenced from index.html and the manifest are served 200 with immutable caching, CSP and nosniff', async () => {
  const { dir, jsName, cssName } = distFixture()
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    const cases = [
      [`/assets/${jsName}`, /^text\/javascript; charset=utf-8$/],
      [`/assets/${cssName}`, /^text\/css; charset=utf-8$/],
      ['/assets/font-xyz.woff2', /^font\/woff2$/],
    ]
    for (const [urlPath, typeRe] of cases) {
      const res = await get(port, urlPath)
      assert.equal(res.status, 200, urlPath)
      assert.match(res.headers['content-type'], typeRe, urlPath)
      assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable', urlPath)
      assert.equal(res.headers['content-security-policy'], DASHBOARD_CSP, urlPath)
      assert.equal(res.headers['x-content-type-options'], 'nosniff', urlPath)
    }
  } finally {
    server.close()
  }
})

test('the manifest.json itself is never served', async () => {
  const { dir } = distFixture()
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    for (const urlPath of ['/.vite/manifest.json', '/assets/.vite/manifest.json']) {
      const res = await get(port, urlPath)
      assert.equal(res.status, 404, urlPath)
    }
  } finally {
    server.close()
  }
})

test('unknown paths and traversal attempts against the dist allowlist return 404 JSON', async () => {
  const { dir } = distFixture()
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    for (const urlPath of [
      '/does-not-exist.js',
      '/assets/../src/config.mjs',
      '/%2e%2e/dashboard.mjs',
      '/assets/%2e%2e%2fconfig.mjs',
      '/../dashboard.mjs',
    ]) {
      const res = await get(port, urlPath)
      assert.equal(res.status, 404, urlPath)
      assert.match(res.headers['content-type'], /application\/json/, urlPath)
    }
  } finally {
    server.close()
  }
})

test('an asset with an unallowlisted extension is never served', async () => {
  const { dir } = distFixture()
  fs.writeFileSync(path.join(dir, 'assets', 'secret.exe'), 'nope')
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    const res = await get(port, '/assets/secret.exe')
    assert.equal(res.status, 404)
  } finally {
    server.close()
  }
})

test('a bad Host header on a dashboard asset request is rejected 403 (blocks DNS rebinding for the static bundle too)', async () => {
  const { dir, jsName } = distFixture()
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    const res = await rawRequest(port, `/assets/${jsName}`, { headers: { Host: 'evil.example' } })
    assert.equal(res.status, 403)
  } finally {
    server.close()
  }
})

test('an allowlisted-but-missing asset file returns 404 JSON instead of throwing', async () => {
  const { dir, jsName } = distFixture()
  fs.rmSync(path.join(dir, 'assets', jsName))
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    const res = await get(port, `/assets/${jsName}`)
    assert.equal(res.status, 404)
    assert.match(res.headers['content-type'], /application\/json/)
  } finally {
    server.close()
  }
})

test('when dashboard/dist/index.html is missing, GET / returns a 503 HTML page and other asset paths 404', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dashboard-dist-empty-'))
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    const rootRes = await get(port, '/')
    assert.equal(rootRes.status, 503)
    assert.match(rootRes.headers['content-type'], /text\/html/)
    assert.match(rootRes.body, /npm run build/)

    const assetRes = await get(port, '/assets/whatever.js')
    assert.equal(assetRes.status, 404)
  } finally {
    server.close()
  }
})

test('HEAD works for the shell and for hashed assets', async () => {
  const { dir, jsName } = distFixture()
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    for (const urlPath of ['/', `/assets/${jsName}`]) {
      const res = await get(port, urlPath, { method: 'HEAD' })
      assert.equal(res.status, 200, urlPath)
      assert.equal(res.body, '', urlPath)
    }
  } finally {
    server.close()
  }
})

test('the allowlist refreshes after rewriting index.html with a newly hashed asset name (no restart needed)', async () => {
  const { dir, jsName: oldJsName } = distFixture()
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env, distDir: dir })
  const port = await listen(server)
  try {
    const before = await get(port, `/assets/${oldJsName}`)
    assert.equal(before.status, 200)

    // Rebuild dist/ in place with a new hashed filename, forcing index.html's mtime forward.
    const newJsName = 'index-def456.js'
    fs.writeFileSync(path.join(dir, 'assets', newJsName), `export const marker = ${JSON.stringify(newJsName)}\n`)
    const future = new Date(Date.now() + 5000)
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      `<!doctype html><html><head><title>agent-hub dashboard</title></head><body><script type="module" src="./assets/${newJsName}"></script></body></html>`
    )
    fs.utimesSync(path.join(dir, 'index.html'), future, future)

    const after = await get(port, `/assets/${newJsName}`)
    assert.equal(after.status, 200)
  } finally {
    server.close()
  }
})

test('GET /api/state returns JSON with agents/jobs/subagents/events arrays', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await get(port, '/api/state')
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    const parsed = JSON.parse(res.body)
    assert.ok(Array.isArray(parsed.agents))
    assert.ok(Array.isArray(parsed.jobs))
    assert.ok(Array.isArray(parsed.subagents))
    assert.ok(Array.isArray(parsed.events))
  } finally {
    server.close()
  }
})

test('GET /events opens an SSE stream framed as "data: <line>\\n\\n" for new event-log lines', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const server = createServer({ env })
  const port = await listen(server)

  try {
    const received = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/events', method: 'GET' }, (res) => {
        assert.equal(res.statusCode, 200)
        assert.match(res.headers['content-type'], /text\/event-stream/)
        let buf = ''
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8')
          if (buf.includes('\n\n') && buf.includes('"kind"')) {
            req.destroy()
            resolve(buf)
          }
        })
        res.on('error', () => {})
      })
      req.on('error', (err) => {
        if (!err.message.includes('socket hang up')) reject(err)
      })
      req.end()

      // Give the SSE connection a moment to register, then append an event.
      setTimeout(async () => {
        const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
        appendEvent({ kind: 'job.finished', agent: 'agy', model: 'x', cwd: '/tmp', title: 'sse-test' }, { env })
      }, 150)
    })

    assert.match(received, /data: \{.*"kind":"job\.finished".*\}\n\n/s)
  } finally {
    server.close()
  }
})

test('POST /api/jobs/:id/cancel from a loopback connection is processed (404-style JSON for an unknown job, not a 403)', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await get(port, '/api/jobs/does-not-exist/cancel', { method: 'POST' })
    assert.notEqual(res.status, 403, 'a real loopback request must never be rejected as non-loopback')
  } finally {
    server.close()
  }
})

test('GET /api/config returns delegationMap, discovery, timeouts, breaker, ttlMs, agentHubHome, writeAllowlist, breakerState, overrides', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await get(port, '/api/config')
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.ok(body.delegationMap && typeof body.delegationMap === 'object')
    assert.ok(body.discovery && typeof body.discovery === 'object')
    assert.ok(body.timeouts && typeof body.timeouts === 'object')
    assert.ok(body.breaker)
    assert.ok(Array.isArray(body.breaker.failureKinds))
    assert.ok(Array.isArray(body.breaker.immediateKinds))
    assert.equal(typeof body.breaker.windowMs, 'number')
    assert.equal(typeof body.breaker.failureThreshold, 'number')
    assert.equal(typeof body.ttlMs, 'number')
    assert.equal(typeof body.agentHubHome, 'string')
    assert.ok(Array.isArray(body.writeAllowlist))
    assert.ok(Array.isArray(body.breakerState))
    assert.ok(body.overrides && typeof body.overrides === 'object')
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh with an empty body refreshes every default pair using the injected commandRunner', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakeExecutable(binDir, 'agy')
  fakeExecutable(binDir, 'opencode')
  fakeExecutable(binDir, 'copilot')
  fakeExecutable(binDir, 'codex')
  const env = { AGENT_HUB_HOME: home, PATH: binDir }
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/agents/refresh', {})
    assert.equal(res.status, 200)
    assert.ok(Array.isArray(res.body.results))
    assert.ok(res.body.results.length > 0)
    assert.ok(!res.body.results.some((r) => r.status === 'skipped'), 'every default agent is resolvable on this PATH')
    assert.ok(!runner.calls.some((c) => c.args.includes('Reply exactly: PONG')), 'a bulk refresh must never L3-ping')
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh with {agent, model} refreshes only that pair', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakeExecutable(binDir, 'copilot')
  const env = { AGENT_HUB_HOME: home, PATH: binDir }
  const runner = fakeRunner([['--version', { stdout: 'GitHub Copilot CLI 1.0.83.', stderr: '', code: 0 }]])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/agents/refresh', { agent: 'copilot', model: 'auto' })
    assert.equal(res.status, 200)
    assert.equal(res.body.results.length, 1)
    assert.equal(res.body.results[0].agent, 'copilot')
    assert.equal(res.body.results[0].model, 'auto')
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh with {agent, model, ping:true} runs an L3 ping, not a bulk refresh', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakeExecutable(binDir, 'agy') // resolvable on this process's own PATH, so the ping is not skipped
  const env = { AGENT_HUB_HOME: home, PATH: binDir }
  const runner = fakeRunner([[/-p Reply exactly: PONG/, { stdout: '{"status":"SUCCESS","response":"PONG","usage":{"total_tokens":1},"conversation_id":"c1"}', stderr: '', code: 0 }]])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/agents/refresh', { agent: 'agy', model: 'gemini-3.8-flash-low', ping: true })
    assert.equal(res.status, 200)
    assert.equal(res.body.results.length, 1)
    assert.equal(res.body.results[0].ladderLevel, 'L3')
    assert.equal(res.body.results[0].status, 'ready')
  } finally {
    server.close()
  }
})

test('POST /api/discovery/refresh runs runDiscovery(force:true) and returns the discovery.json content', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakeExecutable(binDir, 'agy')
  fakeExecutable(binDir, 'opencode')
  fakeExecutable(binDir, 'copilot')
  const env = { AGENT_HUB_HOME: home, PATH: binDir }
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/discovery/refresh', undefined)
    assert.equal(res.status, 200)
    assert.ok(res.body.agy)
    assert.ok(res.body.opencode)
    assert.ok(res.body.copilot)
    assert.ok(!res.body.agy.skipped, 'a resolvable agent must be really refreshed, not skipped')
  } finally {
    server.close()
  }
})

test('POST /api/overrides sets a hold and GET /api/config reflects it; DELETE clears it', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const setRes = await postJson(port, '/api/overrides', { agent: 'agy', model: 'gemini-3.8-flash-low', hold: true })
    assert.equal(setRes.status, 200)
    assert.equal(setRes.body.hold, true)

    const configRes = await get(port, '/api/config')
    const config = JSON.parse(configRes.body)
    assert.equal(config.overrides['agy:gemini-3.8-flash-low'].hold, true)

    const delRes = await postJson(port, '/api/overrides/agy/gemini-3.8-flash-low', undefined, { method: 'DELETE' })
    assert.equal(delRes.status, 200)
    assert.equal(delRes.body.cleared, true)

    const configRes2 = await get(port, '/api/config')
    const config2 = JSON.parse(configRes2.body)
    assert.equal('agy:gemini-3.8-flash-low' in config2.overrides, false)
  } finally {
    server.close()
  }
})

test('DELETE /api/overrides/:agent/:model URL-decodes the model segment (opencode ids contain "/")', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { setOverride, overrideKey, readOverrides } = await import('../src/overrides.mjs?t=' + Date.now())
  setOverride(overrideKey('opencode', 'opencode/muse-spark-1.3-contributor-free'), { hold: true }, env)

  const server = createServer({ env })
  const port = await listen(server)
  try {
    const encodedModel = encodeURIComponent('opencode/muse-spark-1.3-contributor-free')
    const res = await postJson(port, `/api/overrides/opencode/${encodedModel}`, undefined, { method: 'DELETE' })
    assert.equal(res.status, 200)
    assert.equal(res.body.cleared, true)
    assert.equal('opencode:opencode/muse-spark-1.3-contributor-free' in readOverrides(env), false)
  } finally {
    server.close()
  }
})

test('write routes (agents/refresh, discovery/refresh, overrides) are loopback-gated with 403 for a non-loopback caller', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  server.on('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { value: '203.0.113.5', configurable: true })
  })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/overrides', { agent: 'agy', model: 'x', hold: true })
    assert.equal(res.status, 403)
  } finally {
    server.close()
  }
})

// --- Host/Origin/Content-Type hardening against browser-borne CSRF/DNS-rebinding ---

test('isAllowedHost accepts loopback hostnames (any port) and rejects everything else', () => {
  assert.equal(isAllowedHost('127.0.0.1:53211'), true)
  assert.equal(isAllowedHost('127.0.0.1'), true)
  assert.equal(isAllowedHost('localhost:53211'), true)
  assert.equal(isAllowedHost('[::1]:53211'), true)
  assert.equal(isAllowedHost('::1'), true)
  assert.equal(isAllowedHost('evil.example'), false)
  assert.equal(isAllowedHost('attacker.example:80'), false)
  assert.equal(isAllowedHost(undefined), false)
  assert.equal(isAllowedHost(''), false)
})

test('isJsonContentType requires the application/json media type, params allowed', () => {
  assert.equal(isJsonContentType('application/json'), true)
  assert.equal(isJsonContentType('application/json; charset=utf-8'), true)
  assert.equal(isJsonContentType('Application/JSON'), true)
  assert.equal(isJsonContentType('text/plain'), false)
  assert.equal(isJsonContentType('text/plain;application/json'), false)
  assert.equal(isJsonContentType(undefined), false)
  assert.equal(isJsonContentType(''), false)
})

test('isAllowedOrigin allows a missing Origin header and any loopback origin, rejects a foreign origin', () => {
  assert.equal(isAllowedOrigin(undefined), true)
  assert.equal(isAllowedOrigin('http://127.0.0.1:7777'), true)
  assert.equal(isAllowedOrigin('http://localhost:7777'), true)
  assert.equal(isAllowedOrigin('http://[::1]:7777'), true)
  assert.equal(isAllowedOrigin('http://evil.example'), false)
  assert.equal(isAllowedOrigin('https://127.0.0.1:7777'), false)
  assert.equal(isAllowedOrigin('not a url'), false)
})

test('GET with a bad Host header is rejected with 403 (blocks DNS rebinding)', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await rawRequest(port, '/api/state', { headers: { Host: 'evil.example' } })
    assert.equal(res.status, 403)
    assert.match(res.body.error, /invalid Host header/)
  } finally {
    server.close()
  }
})

test('GET with no Host header at all is rejected with 403', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await requestWithoutHostHeader(port, '/api/state')
    assert.equal(res.status, 403)
  } finally {
    server.close()
  }
})

test('POST /api/overrides with Content-Type: text/plain is rejected 415 and does not write the override (defeats a text/plain <form> CSRF)', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await rawRequest(port, '/api/overrides', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ agent: 'agy', model: 'gemini-3.8-flash-low', hold: true }),
    })
    assert.equal(res.status, 415)
    assert.match(res.body.error, /application\/json/)

    const { readOverrides } = await import('../src/overrides.mjs?t=' + Date.now())
    assert.equal('agy:gemini-3.8-flash-low' in readOverrides(env), false, 'text/plain request must have no side effect')
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh with Content-Type: text/plain is rejected 415 and never calls the commandRunner', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const runner = fakeRunner([])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await rawRequest(port, '/api/agents/refresh', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ ping: true, agent: 'agy', model: 'gemini-3.8-flash-low' }),
    })
    assert.equal(res.status, 415)
    assert.equal(runner.calls.length, 0, 'text/plain request must never reach the command runner (no L3 ping)')
  } finally {
    server.close()
  }
})

test('POST /api/overrides with a cross-origin Origin header is rejected 403', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await rawRequest(port, '/api/overrides', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', Origin: 'http://evil.example' },
      body: JSON.stringify({ agent: 'agy', model: 'gemini-3.8-flash-low', hold: true }),
    })
    assert.equal(res.status, 403)
    assert.match(res.body.error, /cross-origin/)
  } finally {
    server.close()
  }
})

test('POST /api/overrides with a matching loopback Origin header is allowed', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await rawRequest(port, '/api/overrides', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ agent: 'agy', model: 'gemini-3.8-flash-low', hold: true }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.hold, true)
  } finally {
    server.close()
  }
})

test('POST /api/overrides with a body over 64 KiB is rejected 413', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const oversized = JSON.stringify({ agent: 'agy', model: 'x'.repeat(70 * 1024), hold: true })
    const res = await rawRequest(port, '/api/overrides', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(oversized) },
      body: oversized,
    })
    assert.equal(res.status, 413)
    assert.match(res.body.error, /payload too large/)
  } finally {
    server.close()
  }
})

test('POST /api/overrides with malformed JSON is rejected 400 (not silently treated as {})', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await rawRequest(port, '/api/overrides', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'Content-Type': 'application/json' },
      body: '{not json',
    })
    assert.equal(res.status, 400)
    assert.match(res.body.error, /invalid JSON body/)
  } finally {
    server.close()
  }
})

test('a well-formed loopback JSON request still works end-to-end: refresh, overrides POST/DELETE and job cancel', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakeExecutable(binDir, 'agy')
  fakeExecutable(binDir, 'opencode')
  fakeExecutable(binDir, 'copilot')
  const env = { AGENT_HUB_HOME: home, PATH: binDir }
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const refreshRes = await postJson(port, '/api/agents/refresh', {})
    assert.equal(refreshRes.status, 200)

    const setRes = await postJson(port, '/api/overrides', { agent: 'agy', model: 'gemini-3.8-flash-low', hold: true })
    assert.equal(setRes.status, 200)

    const delRes = await postJson(port, '/api/overrides/agy/gemini-3.8-flash-low', undefined, { method: 'DELETE' })
    assert.equal(delRes.status, 200)

    const cancelRes = await postJson(port, '/api/jobs/does-not-exist/cancel', undefined, { method: 'POST' })
    assert.notEqual(cancelRes.status, 403)
    assert.notEqual(cancelRes.status, 415)
  } finally {
    server.close()
  }
})

// --- Dashboard-process-own-PATH guard: the dashboard (systemd --user, a
// possibly minimal PATH) must never poison shared state for an agent that is
// actually installed but simply not reachable from ITS OWN env.PATH. ---

function fakeExecutable(binDir, name) {
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\necho fake\n', { mode: 0o755 })
}

test('POST /api/jobs/:id/cancel for an unknown job returns 404 with the job-not-found message', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/jobs/does-not-exist/cancel', undefined, { method: 'POST' })
    assert.equal(res.status, 404)
    assert.equal(res.body.error, 'job not found: does-not-exist')
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh (bulk) skips an agent whose CLI is missing from the dashboard process own PATH, leaving its cached row untouched', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakeExecutable(binDir, 'copilot') // only copilot is on this PATH — agy and opencode are not
  const env = { AGENT_HUB_HOME: home, PATH: binDir }

  const { writeCacheEntry, readCache } = await import('../src/preflight.mjs?t=' + Date.now())
  const staleGoodEntry = { agent: 'agy', model: 'gemini-3.8-flash-low', status: 'ready', ladderLevel: 'L2', reason: null, checkedAt: new Date(Date.now() - 60_000).toISOString() }
  writeCacheEntry('agy:gemini-3.8-flash-low', staleGoodEntry, env)

  const runner = fakeRunner([
    ['--version', { stdout: 'GitHub Copilot CLI 1.0.83.', stderr: '', code: 0 }],
    ['help config', { stdout: '  `model`: desc.\n    - "auto"\n', stderr: '', code: 0 }],
  ])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/agents/refresh', {})
    assert.equal(res.status, 200)

    const agyResult = res.body.results.find((r) => r.agent === 'agy' && r.model === 'gemini-3.8-flash-low')
    assert.equal(agyResult.status, 'skipped')
    assert.match(agyResult.reason, /cli_not_found_in_dashboard_process: agy is not on this process PATH/)
    assert.equal(agyResult.written, false)
    assert.ok(!runner.calls.some((c) => c.cmd === 'agy'), 'agy must never be spawned when unresolvable on this PATH')
    assert.ok(!runner.calls.some((c) => c.cmd === 'opencode'), 'opencode must never be spawned when unresolvable on this PATH')

    const copilotResults = res.body.results.filter((r) => r.agent === 'copilot')
    assert.ok(copilotResults.length > 0)
    assert.ok(copilotResults.every((r) => r.status !== 'skipped'), 'a resolvable agent behaves as today')

    const cacheAfter = readCache(env)
    assert.deepEqual(cacheAfter['agy:gemini-3.8-flash-low'], staleGoodEntry, 'the good cached row for the unresolvable agent is byte-for-byte unchanged')
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh with an explicit {agent, model} for an unresolvable agent returns skipped and never calls the commandRunner', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), PATH: '/nonexistent/dir/only' }
  const runner = fakeRunner([])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/agents/refresh', { agent: 'copilot', model: 'auto' })
    assert.equal(res.status, 200)
    assert.equal(res.body.results.length, 1)
    assert.equal(res.body.results[0].status, 'skipped')
    assert.match(res.body.results[0].reason, /cli_not_found_in_dashboard_process: copilot is not on this process PATH/)
    assert.equal(res.body.results[0].written, false)
    assert.equal(runner.calls.length, 0)
  } finally {
    server.close()
  }
})

test('POST /api/agents/refresh with ping:true for an unresolvable agent returns skipped and never calls the commandRunner', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), PATH: '/nonexistent/dir/only' }
  const runner = fakeRunner([])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/agents/refresh', { agent: 'agy', model: 'gemini-3.8-flash-low', ping: true })
    assert.equal(res.status, 200)
    assert.equal(res.body.results.length, 1)
    assert.equal(res.body.results[0].status, 'skipped')
    assert.equal(res.body.results[0].written, false)
    assert.equal(runner.calls.length, 0, 'an unresolvable agent must never be L3-pinged')
  } finally {
    server.close()
  }
})

test('POST /api/discovery/refresh skips an agent missing from the dashboard PATH, preserving its existing discovery.json entry and refreshing the resolvable ones', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakeExecutable(binDir, 'copilot')
  const env = { AGENT_HUB_HOME: home, PATH: binDir }

  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  const staleAgyEntry = { agent: 'agy', cmd: 'agy', binPath: '/old/agy', version: '0.0.1', models: [], checkedAt: new Date().toISOString(), error: null }
  writeJsonAtomic(paths(env).discoveryFile, { agy: staleAgyEntry })

  const runner = fakeRunner([
    ['--version', { stdout: 'GitHub Copilot CLI 1.0.83.', stderr: '', code: 0 }],
    ['help config', { stdout: '  `model`: desc.\n    - "auto"\n', stderr: '', code: 0 }],
  ])
  const server = createServer({ env, commandRunner: runner })
  const port = await listen(server)
  try {
    const res = await postJson(port, '/api/discovery/refresh', undefined)
    assert.equal(res.status, 200)
    assert.equal(res.body.copilot.error, null)
    assert.ok(res.body.copilot.version)
    assert.equal(res.body.agy.skipped, true)
    assert.match(res.body.agy.reason, /cli_not_found_in_dashboard_process: agy is not on this process PATH/)
    assert.ok(!runner.calls.some((c) => c.cmd === 'agy'), 'agy must never be spawned')

    const { readDiscovery } = await import('../src/discovery.mjs?t=' + Date.now())
    const onDisk = readDiscovery(env)
    assert.deepEqual(onDisk.agy, staleAgyEntry, "the unresolvable agent's existing discovery.json row is untouched")
  } finally {
    server.close()
  }
})

test('GET /api/config exposes process.{pid,nodeVersion,platform,pathEntries,resolvedBins} scoped to DELEGATION_MAP agents', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakeExecutable(binDir, 'copilot')
  const env = { AGENT_HUB_HOME: home, PATH: binDir }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await get(port, '/api/config')
    const body = JSON.parse(res.body)
    assert.equal(body.process.pid, process.pid)
    assert.equal(body.process.nodeVersion, process.version)
    assert.equal(body.process.platform, process.platform)
    assert.deepEqual(body.process.pathEntries, [binDir])
    assert.equal(body.process.resolvedBins.copilot, path.join(binDir, 'copilot'))
    assert.equal(body.process.resolvedBins.agy, null)
    assert.equal(body.process.resolvedBins.opencode, null)
  } finally {
    server.close()
  }
})

test('startDashboard prunes stale preflight-cache rows at boot, keeps live ones, and never runs discovery', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { writeCacheEntry, readCache } = await import('../src/preflight.mjs?t=' + Date.now())
  writeCacheEntry('copilot:gpt-5-mini', { agent: 'copilot', model: 'gpt-5-mini', status: 'unavailable', checkedAt: new Date().toISOString() }, env) // not in DELEGATION_MAP
  writeCacheEntry('copilot:auto', { agent: 'copilot', model: 'auto', status: 'ready', checkedAt: new Date().toISOString() }, env) // in DELEGATION_MAP

  const server = startDashboard({ port: 0, env })
  try {
    await new Promise((resolve) => server.on('listening', resolve))
    const cache = readCache(env)
    assert.equal('copilot:gpt-5-mini' in cache, false, 'stale pair pruned at boot')
    assert.equal('copilot:auto' in cache, true, 'live pair kept')

    const { readDiscovery } = await import('../src/discovery.mjs?t=' + Date.now())
    assert.deepEqual(readDiscovery(env), {}, 'boot must never run discovery — only prune')
  } finally {
    server.close()
  }
})
test('Accounts CRUD happy path and raw apiKey is never exposed', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    // 1. POST /api/accounts
    const createRes = await postJson(port, '/api/accounts', { label: 'my-acc', apiKey: 'key-aaa' })
    assert.equal(createRes.status, 201)
    const accId = createRes.body.id
    assert.ok(accId)
    assert.equal(createRes.body.apiKey, undefined)
    assert.equal(createRes.body.keyLast4, '-aaa')
    assert.equal(createRes.body.keyPresent, true)

    // 2. GET /api/accounts
    const listRes = await get(port, '/api/accounts')
    assert.equal(listRes.status, 200)
    assert.ok(listRes.body, 'listRes body should be truthy')
    assert.ok(typeof listRes.body === 'string' ? JSON.parse(listRes.body) : listRes.body)
    const listResBody = typeof listRes.body === 'string' ? JSON.parse(listRes.body) : listRes.body
    assert.equal(listResBody.accounts.length, 1)
    assert.equal(listResBody.accounts[0].apiKey, undefined)

    // 3. PATCH /api/accounts/:id
    const patchRes = await postJson(port, `/api/accounts/${accId}`, { label: 'new-label' }, { method: 'PATCH' })
    assert.equal(patchRes.status, 200)
    assert.equal(patchRes.body.label, 'new-label')
    assert.equal(patchRes.body.apiKey, undefined)

    // 4. PUT /api/accounts/policy
    const policyRes = await postJson(port, '/api/accounts/policy', { policy: 'least_used' }, { method: 'PUT' })
    assert.equal(policyRes.status, 200)
    assert.equal(policyRes.body.policy, 'least_used')

    // 5. DELETE /api/accounts/:id
    const delRes = await postJson(port, `/api/accounts/${accId}`, undefined, { method: 'DELETE' })
    assert.equal(delRes.status, 200)
    assert.equal(delRes.body.deleted, true)
  } finally {
    server.close()
  }
})

test('refresh-sources maps 401 to 200 with no_source_access status', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { createAccount } = await import('../src/accounts.mjs?t=' + Date.now())
  const acc = createAccount({ label: 'test', apiKey: 'key-401' }, env)

  const fakeClient = {
    async listSources() {
      const err = new Error('unauthorized')
      err.status = 401
      throw err
    }
  }

  const server = createServer({ env, client: fakeClient })
  const port = await listen(server)
  try {
    const res = await postJson(port, `/api/accounts/${acc.id}/refresh-sources`, {})
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'no_source_access')
  } finally {
    server.close()
  }
})

test('refresh-sources happy path', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { createAccount } = await import('../src/accounts.mjs?t=' + Date.now())
  const acc = createAccount({ label: 'test', apiKey: 'key-123' }, env)

  const fakeClient = {
    async listSources() {
      return { sources: [{ name: 'sources/github/a/b' }] }
    }
  }

  const server = createServer({ env, client: fakeClient })
  const port = await listen(server)
  try {
    const res = await postJson(port, `/api/accounts/${acc.id}/refresh-sources`, {})
    assert.equal(res.status, 200)
    assert.equal(res.body.status, 'ok')
    assert.deepEqual(res.body.sources, [
      { name: 'sources/github/a/b', owner: 'a', repo: 'b', defaultBranch: null, branches: [] },
    ])
  } finally {
    server.close()
  }
})

test('GET /api/sources happy path: returns one entry per source name with every account known to have it', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { createAccount } = await import('../src/accounts.mjs?t=' + Date.now())
  const acc = createAccount({ label: 'test', apiKey: 'key-123' }, env)

  const { refreshSources } = await import('../src/cloud/sources.mjs?t=' + Date.now())
  const fakeClient = {
    async listSources() {
      return {
        sources: [{
          name: 'sources/github/a/b',
          githubRepo: { owner: 'a', repo: 'b', defaultBranch: { displayName: 'main' }, branches: [{ displayName: 'main' }, { displayName: 'dev' }] }
        }]
      }
    }
  }
  await refreshSources({ accountId: acc.id, env, client: fakeClient, apiKey: 'key-123' })

  const server = createServer({ env, client: fakeClient })
  const port = await listen(server)
  try {
    const res = await get(port, '/api/sources')
    assert.equal(res.status, 200)
    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    assert.equal(body.sources.length, 1)
    const source = body.sources[0]
    assert.equal(source.name, 'sources/github/a/b')
    assert.equal(source.owner, 'a')
    assert.equal(source.repo, 'b')
    assert.equal(source.defaultBranch, 'main')
    assert.deepEqual(source.branches, ['main', 'dev'])
    assert.deepEqual(source.accounts, [{ accountId: acc.id, status: 'ok' }])

    assert.deepEqual(body.accounts, [
      { accountId: acc.id, label: 'test', status: 'ok', fetchedAt: body.accounts[0].fetchedAt },
    ])
    assert.ok(body.accounts[0].fetchedAt)
  } finally {
    server.close()
  }
})

test('Schedules CRUD and run-now happy path', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }

  const fakeClient = {
    async createJob() { return { jobId: 'cloud-job-1' } }
  }

  const server = createServer({ env, client: fakeClient })
  const port = await listen(server)
  try {
    const payload = { source: 'a/b', prompt: 'test', schedule: { kind: 'interval', everyMinutes: 10 } }

    // 1. POST
    const createRes = await postJson(port, '/api/schedules', payload)
    assert.equal(createRes.status, 201)
    const schedId = createRes.body.id
    assert.ok(schedId)

    // 2. GET
    const listRes = await get(port, '/api/schedules')
    assert.equal(listRes.status, 200)
    const listResBody = typeof listRes.body === 'string' ? JSON.parse(listRes.body) : listRes.body;
    assert.equal(listResBody.schedules.length, 1)

    // 3. PATCH
    const patchRes = await postJson(port, `/api/schedules/${schedId}`, { prompt: 'new-prompt' }, { method: 'PATCH' })
    assert.equal(patchRes.status, 200)
    assert.equal(patchRes.body.prompt, 'new-prompt')

    // 4. POST run-now
    const runNowRes = await postJson(port, `/api/schedules/${schedId}/run-now`, {})
    assert.equal(runNowRes.status, 200)
    assert.ok(runNowRes.body.id === schedId)

    // 5. DELETE
    const delRes = await postJson(port, `/api/schedules/${schedId}`, undefined, { method: 'DELETE' })
    assert.equal(delRes.status, 200)
  } finally {
    server.close()
  }
})

test('Cloud sessions happy paths', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), JULES_API_KEY: 'key-env' }
  const { createJob, updateResult, appendStdout } = await import('../src/jobstore.mjs?t=' + Date.now())

  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: '/tmp', env })
  updateResult(job.jobId, { remote: { sessionId: 'ses-123', state: 'PENDING' } }, env)
  appendStdout(job.jobId, '{"activity":"foo"}\n', env)
  appendStdout(job.jobId, '{"activity":"bar"}\n', env)

  const fakeClient = {
    async listSessions() {
      return { sessions: [{ id: 'ses-123', name: 'sessions/ses-123', state: 'PENDING' }] }
    },
    async getSession() {
      return { id: 'ses-123', state: 'COMPLETED' }
    },
    async listActivities() {
      return { activities: [] }
    }
  }

  const server = createServer({ env, client: fakeClient })
  const port = await listen(server)
  try {
    const { createAccount } = await import('../src/accounts.mjs?t=' + Date.now())
    const acc = createAccount({ label: 'test', apiKey: 'key-123' }, env)

    const sessRes = await get(port, `/api/cloud/sessions?account=${acc.id}`)
    assert.equal(sessRes.status, 200)
    const sessResBody = typeof sessRes.body === 'string' ? JSON.parse(sessRes.body) : sessRes.body;
    assert.equal(sessResBody.sessions.length, 1)

    const checkRes = await postJson(port, `/api/cloud/jobs/${job.jobId}/check`, {})
    assert.equal(checkRes.status, 200)
    assert.equal(checkRes.body.state, 'COMPLETED')

    const actRes = await get(port, `/api/cloud/jobs/${job.jobId}/activities`)
    assert.equal(actRes.status, 200)
    const actResBody = typeof actRes.body === 'string' ? JSON.parse(actRes.body) : actRes.body;
    assert.deepEqual(actResBody.activities, ['{"activity":"foo"}', '{"activity":"bar"}'])

  } finally {
    server.close()
  }
})

test('Cloud contract: every Cloud GET route parses with its shared schema from src/schemas.mjs', async () => {
  // The dashboard's Cloud view (dashboard/src/lib/api.ts) and this server are
  // written by separate agents. A hand-rolled zod schema on the frontend can
  // drift from what the server actually returns without any test noticing,
  // because view tests mock @/lib/api instead of hitting the real server.
  // This test starts the real server and parses every real Cloud response
  // with the SAME schema the frontend imports from @shared — so a drift on
  // either side fails here, not in production.
  const env = { AGENT_HUB_HOME: tmpHome() }
  const {
    CloudAccountsResponse,
    CloudSourcesResponse,
    CloudSchedulesResponse,
    CloudSessionsResponse,
    CloudActivitiesResponse,
  } = await import('../src/schemas.mjs?t=' + Date.now())
  const { createAccount } = await import('../src/accounts.mjs?t=' + Date.now())
  const { refreshSources } = await import('../src/cloud/sources.mjs?t=' + Date.now())
  const { createSchedule, updateSchedule } = await import('../src/schedules.mjs?t=' + Date.now())
  const { createJob, updateResult, appendStdout } = await import('../src/jobstore.mjs?t=' + Date.now())

  // Two accounts, so /api/accounts and /api/sources each have more than one
  // row to merge.
  const accA = createAccount({ label: 'pro-1', apiKey: 'key-aaaa1111' }, env)
  createAccount({ label: 'pro-2', apiKey: 'key-bbbb2222' }, env)

  const fakeClient = {
    async listSources() {
      return {
        sources: [
          {
            name: 'sources/github/acme/widgets',
            githubRepo: {
              owner: 'acme',
              repo: 'widgets',
              defaultBranch: { displayName: 'main' },
              branches: [{ displayName: 'main' }, { displayName: 'dev' }],
            },
          },
        ],
      }
    },
    async listSessions() {
      return {
        sessions: [
          { id: 'ses-1', name: 'sessions/ses-1', title: 'Fix the thing', state: 'IN_PROGRESS', createTime: new Date().toISOString() },
        ],
      }
    },
    async getSession() {
      return { id: 'ses-1', state: 'IN_PROGRESS' }
    },
  }

  // Seed a sources cache for one account.
  await refreshSources({ accountId: accA.id, env, client: fakeClient, apiKey: 'key-aaaa1111' })

  // Seed a running Jules job so /api/cloud/sessions and /api/cloud/jobs/:id/activities have something real to return.
  const job = createJob({ agent: 'jules', model: 'jules', task: 'do it', cwd: null, env })
  updateResult(job.jobId, { status: 'running', remote: { sessionId: 'ses-1', state: 'IN_PROGRESS', accountId: accA.id } }, env)
  appendStdout(job.jobId, '[jules] started\n', env)

  // Seed a schedule linked to that job's outcome.
  const schedule = createSchedule(
    {
      label: 'nightly',
      schedule: { kind: 'daily', at: '02:00', weekdays: [1, 2, 3, 4, 5] },
      prompt: 'p',
      source: 'sources/github/acme/widgets',
      accountId: accA.id,
    },
    env
  )
  updateSchedule(schedule.id, { lastJobId: job.jobId, lastRunAt: new Date().toISOString(), lastStatus: 'running' }, env)

  const server = createServer({ env, client: fakeClient })
  const port = await listen(server)
  try {
    const accountsBody = JSON.parse((await get(port, '/api/accounts')).body)
    assert.doesNotThrow(() => CloudAccountsResponse.parse(accountsBody), 'GET /api/accounts must match the shared CloudAccountsResponse schema')

    const sourcesBody = JSON.parse((await get(port, '/api/sources')).body)
    assert.doesNotThrow(() => CloudSourcesResponse.parse(sourcesBody), 'GET /api/sources must match the shared CloudSourcesResponse schema')

    const schedulesBody = JSON.parse((await get(port, '/api/schedules')).body)
    assert.doesNotThrow(() => CloudSchedulesResponse.parse(schedulesBody), 'GET /api/schedules must match the shared CloudSchedulesResponse schema')

    const sessionsBody = JSON.parse((await get(port, '/api/cloud/sessions')).body)
    assert.doesNotThrow(() => CloudSessionsResponse.parse(sessionsBody), 'GET /api/cloud/sessions must match the shared CloudSessionsResponse schema')

    const activitiesBody = JSON.parse((await get(port, `/api/cloud/jobs/${job.jobId}/activities`)).body)
    assert.doesNotThrow(
      () => CloudActivitiesResponse.parse(activitiesBody),
      'GET /api/cloud/jobs/:id/activities must match the shared CloudActivitiesResponse schema'
    )
  } finally {
    server.close()
  }
})

test('CSRF/content-type guard rejecting a non-JSON write on a new route', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const res = await rawRequest(port, '/api/accounts', {
      method: 'POST',
      headers: { Host: '127.0.0.1', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ label: 'test', apiKey: 'key-123' }),
    })
    assert.equal(res.status, 415)
  } finally {
    server.close()
  }
})

test('404 for an unknown account and an unknown schedule', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const patchAcc = await postJson(port, '/api/accounts/acct-nope', { label: '1' }, { method: 'PATCH' })
    assert.equal(patchAcc.status, 404)

    const patchSched = await postJson(port, '/api/schedules/sched-nope', { prompt: '1' }, { method: 'PATCH' })
    assert.equal(patchSched.status, 404)
  } finally {
    server.close()
  }
})

test('400 for an invalid policy and an invalid schedule', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const server = createServer({ env })
  const port = await listen(server)
  try {
    const policyRes = await postJson(port, '/api/accounts/policy', { policy: 'invalid-policy' }, { method: 'PUT' })
    assert.equal(policyRes.status, 400)

    const schedRes = await postJson(port, '/api/schedules', { schedule: 'invalid-schedule' })
    assert.equal(schedRes.status, 400)
  } finally {
    server.close()
  }
})

// The route used to re-implement jules_sessions and returned an empty list
// whenever ?account was absent, so the dashboard showed "no sessions" for a
// multi-account setup that had several. It now delegates to the tool, which
// merges every enabled account and tags each session with its accountId.
test('GET /api/cloud/sessions without ?account merges the sessions of every enabled account', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { createAccount } = await import('../src/accounts.mjs?t=' + Date.now())
  const a = createAccount({ label: 'pro-1', apiKey: 'key-aaa' }, env)
  const b = createAccount({ label: 'pro-2', apiKey: 'key-bbb' }, env)

  const fakeClient = {
    async listSessions({ apiKey }) {
      if (apiKey === 'key-aaa') return { sessions: [{ id: 's-a', state: 'COMPLETED', createTime: '2026-09-16T10:00:00Z' }] }
      if (apiKey === 'key-bbb') return { sessions: [{ id: 's-b', state: 'IN_PROGRESS', createTime: '2026-09-16T11:00:00Z' }] }
      throw new Error('unexpected key')
    },
  }

  const server = createServer({ env, client: fakeClient })
  const port = await listen(server)
  try {
    const res = await get(port, '/api/cloud/sessions')
    assert.equal(res.status, 200)
    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body
    assert.deepEqual(body.sessions.map((s) => [s.sessionId, s.accountId]), [['s-b', b.id], ['s-a', a.id]])
    assert.deepEqual(body.accountErrors, [])
  } finally {
    server.close()
  }
})
