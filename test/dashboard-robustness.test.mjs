import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createServer } from '../src/dashboard.mjs'

// The dashboard is a long-running local service: a malformed request must be
// answered, never allowed to throw out of the request listener and exit the
// process (found by adversarial review, reproduced with URIError exit 1).

async function withServer(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-robust-'))
  const server = createServer({ env: { ...process.env, AGENT_HUB_HOME: home } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await fn(server.address().port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(home, { recursive: true, force: true })
  }
}

function raw(port, method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath,
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('malformed percent-encoding in an override path returns 400 and the server keeps serving', async () => {
  await withServer(async (port) => {
    for (const bad of ['/api/overrides/agy/%', '/api/overrides/%E0%A4%A/auto']) {
      const res = await raw(port, 'DELETE', bad)
      assert.equal(res.status, 400, bad)
      assert.match(res.body, /invalid URL encoding/)
    }
    const after = await raw(port, 'GET', '/api/state')
    assert.equal(after.status, 200)
  })
})

test('a request with a very large Cookie header (shared localhost cookies) is not rejected with 431', async () => {
  await withServer(async (port) => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/config',
        headers: { Host: `127.0.0.1:${port}`, Cookie: `a=${'x'.repeat(20000)}` } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    assert.notEqual(status, 431)
    assert.equal(status, 200)
  })
})
