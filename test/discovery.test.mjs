import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-discovery-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/discovery.mjs?t=' + Date.now() + Math.random())
}

function fakeRunner(responses) {
  const calls = []
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const key = `${cmd} ${args.join(' ')}`
    for (const [pattern, response] of responses) {
      if (typeof pattern === 'string' ? key.includes(pattern) : pattern.test(key)) {
        return response
      }
    }
    throw new Error(`fakeRunner: no response configured for "${key}"`)
  }
  runner.calls = calls
  return runner
}

// A real PATH containing this process's own node binary dir, so discoverCli
// can resolve *some* binary. Tests stub the command runner regardless, but
// binPath resolution scans the real filesystem, so we build a small fake
// PATH pointing at a directory holding fake executables.
function fakePathWithBinary(dir, name) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\necho fake\n', { mode: 0o755 })
  return dir
}

test('resolveAgentCli reports resolvable:false and a null binPath when the CLI is not on the given PATH', async () => {
  const { resolveAgentCli } = await fresh(tmpHome())
  const info = resolveAgentCli('copilot', { PATH: '/nonexistent/dir/only' })
  assert.equal(info.agent, 'copilot')
  assert.equal(info.cmd, 'copilot')
  assert.equal(info.binPath, null)
  assert.equal(info.resolvable, false)
})

test('resolveAgentCli reports resolvable:true and the resolved binPath when the CLI is on the given PATH', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'agy')
  const { resolveAgentCli } = await fresh(home)
  const info = resolveAgentCli('agy', { PATH: binDir })
  assert.equal(info.resolvable, true)
  assert.equal(info.binPath, path.join(binDir, 'agy'))
})

test('discoverCli reports error (not throw) when the binary is missing from PATH', async () => {
  const { discoverCli } = await fresh(tmpHome())
  const env = { PATH: '/nonexistent/dir/only' }
  const entry = await discoverCli('agy', { env, commandRunner: fakeRunner([]) })

  assert.equal(entry.agent, 'agy')
  assert.equal(entry.binPath, null)
  assert.equal(entry.version, null)
  assert.deepEqual(entry.models, [])
  assert.match(entry.error, /not found on PATH/i)
})

test('discoverCli returns one row with cmd/binPath/version/models/checkedAt for a healthy agy', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'agy')
  const { discoverCli } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n', stderr: '', code: 0 }],
  ])

  const entry = await discoverCli('agy', { env: { PATH: binDir }, commandRunner: runner })

  assert.equal(entry.agent, 'agy')
  assert.equal(entry.cmd, 'agy')
  assert.equal(entry.binPath, path.join(binDir, 'agy'))
  assert.equal(entry.version, '1.2.1')
  assert.ok(entry.models.some((m) => m.id === 'gemini-3.8-flash-low'))
  assert.equal(entry.error, null)
  assert.ok(entry.checkedAt)
})

test('discoverCli for copilot always attaches note "catalog not authoritative"', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'copilot')
  const { discoverCli } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: 'GitHub Copilot CLI 1.0.83.', stderr: '', code: 0 }],
    ['help config', { stdout: '  `model`: desc.\n    - "gpt-5-mini"\n', stderr: '', code: 0 }],
  ])

  const entry = await discoverCli('copilot', { env: { PATH: binDir }, commandRunner: runner })
  assert.equal(entry.note, 'catalog not authoritative')
})

test('discoverCli for opencode fetches every provider\'s models with a single `opencode api model.list` call (T6: no more per-provider fan-out)', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'opencode')
  const { discoverCli } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '2.0.10', stderr: '', code: 0 }],
    [
      'api model.list',
      {
        stdout: JSON.stringify({
          location: { directory: '/repo' },
          data: [
            { id: 'muse-spark-1.3-contributor-free', providerID: 'opencode', name: 'Muse Spark' },
            { id: 'deepseek-v4-flash', providerID: 'deepseek', name: 'DeepSeek Flash' },
          ],
        }),
        stderr: '',
        code: 0,
      },
    ],
  ])

  const entry = await discoverCli('opencode', { env: { PATH: binDir }, commandRunner: runner })

  const ids = entry.models.map((m) => m.id)
  assert.ok(ids.includes('opencode/muse-spark-1.3-contributor-free'), 'includes the opencode provider catalog')
  assert.ok(ids.includes('deepseek/deepseek-v4-flash'), 'also includes the deepseek provider catalog, from the same single call')
  assert.equal(entry.error, null)
  const modelsCalls = runner.calls.filter((c) => c.args.join(' ') === 'api model.list')
  assert.equal(modelsCalls.length, 1, 'v2\'s catalog command covers every provider in one call, unlike v1\'s provider-scoped scrape')
})

test('discoverCli for opencode reports "model list timed out" when its single `api model.list` call fails, via the generic single-call path', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'opencode')
  const { discoverCli } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '2.0.10', stderr: '', code: 0 }],
    ['api model.list', { stdout: '', stderr: '', code: null, timedOut: true }],
  ])

  const entry = await discoverCli('opencode', { env: { PATH: binDir }, commandRunner: runner })

  assert.deepEqual(entry.models, [])
  assert.match(entry.error, /model list timed out/)
})

test('discoverCli reports a distinct "model list empty" error, not "timed out", when the CLI exits 0 with empty stdout (T4: cold background service, not a real timeout)', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'opencode')
  const { discoverCli } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '2.0.18', stderr: '', code: 0 }],
    ['api model.list', { stdout: '', stderr: '', code: 0, timedOut: false }],
  ])

  const entry = await discoverCli('opencode', { env: { PATH: binDir }, commandRunner: runner })

  assert.deepEqual(entry.models, [])
  assert.match(entry.error, /model list empty/)
  assert.doesNotMatch(entry.error, /timed out/)
})

test('runDiscovery writes discovery.json with one row per requested agent and never throws on a partial failure', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'agy')
  const { runDiscovery, readDiscovery } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])

  const result = await runDiscovery({ agents: ['agy', 'copilot'], env: { PATH: binDir, AGENT_HUB_HOME: home }, commandRunner: runner })

  assert.ok(result.agy)
  assert.ok(result.copilot)
  assert.equal(result.copilot.error, 'not found on PATH')

  const onDisk = readDiscovery({ AGENT_HUB_HOME: home })
  assert.ok(onDisk.agy)
  assert.equal(onDisk.agy.version, '1.2.1')
})

test('runDiscovery leaves no .tmp file next to discovery.json', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'agy')
  const { runDiscovery } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])

  await runDiscovery({ agents: ['agy'], env: { PATH: binDir, AGENT_HUB_HOME: home }, commandRunner: runner })
  const leftovers = fs.readdirSync(home).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('runDiscovery is TTL-gated: a fresh existing row is not re-probed unless force:true', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'agy')
  const { runDiscovery } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])
  const env = { PATH: binDir, AGENT_HUB_HOME: home }

  await runDiscovery({ agents: ['agy'], env, commandRunner: runner })
  const callsAfterFirst = runner.calls.length

  await runDiscovery({ agents: ['agy'], env, commandRunner: runner })
  assert.equal(runner.calls.length, callsAfterFirst, 'second call served from the fresh discovery.json, no new probes')

  await runDiscovery({ agents: ['agy'], env, commandRunner: runner, force: true })
  assert.ok(runner.calls.length > callsAfterFirst, 'force:true bypasses the TTL and re-probes')
})

test('runDiscovery emits one "preflight" event with phase:"discovery" per freshly-probed agent', async () => {
  const home = tmpHome()
  const binDir = path.join(home, 'bin')
  fakePathWithBinary(binDir, 'agy')
  const { runDiscovery } = await fresh(home)
  const { readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])
  const env = { PATH: binDir, AGENT_HUB_HOME: home }

  await runDiscovery({ agents: ['agy'], env, commandRunner: runner })
  const events = readTail({ env })
  const discoveryEvents = events.filter((e) => e.kind === 'preflight' && e.phase === 'discovery')
  assert.equal(discoveryEvents.length, 1)
  assert.equal(discoveryEvents[0].agent, 'agy')
  assert.equal(discoveryEvents[0].status, 'ok')
})

test('pruneCacheForMap drops preflight-cache rows for pairs no longer in DELEGATION_MAP, keeps live pairs', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeCacheEntry } = await import('../src/preflight.mjs?t=' + Date.now())
  writeCacheEntry('copilot:gpt-5-mini', { agent: 'copilot', model: 'gpt-5-mini', status: 'unavailable', checkedAt: new Date().toISOString() })
  writeCacheEntry('copilot:auto', { agent: 'copilot', model: 'auto', status: 'ready', checkedAt: new Date().toISOString() })

  const { pruneCacheForMap } = await fresh(home)
  const result = pruneCacheForMap({ AGENT_HUB_HOME: home })

  const { readCache } = await import('../src/preflight.mjs?t=' + Date.now())
  const cache = readCache({ AGENT_HUB_HOME: home })
  assert.equal('copilot:gpt-5-mini' in cache, false)
  assert.equal('copilot:auto' in cache, true)
  assert.equal(result.removed, 1)
})

test('pruneCacheForMap keeps a preflight-cache row for an accepted add_candidate pair not otherwise in DELEGATION_MAP', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeCacheEntry, readCache } = await import('../src/preflight.mjs?t=' + Date.now())
  writeCacheEntry('agy:gemini-3.9-flash-low', { agent: 'agy', model: 'gemini-3.9-flash-low', status: 'ready', checkedAt: new Date().toISOString() })

  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  const { chainHash } = await import('../src/proposals.mjs?t=' + Date.now())
  const { DELEGATION_MAP } = await import('../src/router.mjs?t=' + Date.now())
  const hash = chainHash(DELEGATION_MAP.recon.chain)

  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).proposalsFile, {
    version: 1,
    proposals: [
      {
        id: 'prop-add-1',
        taskType: 'recon',
        kind: 'add_candidate',
        chainHash: hash,
        fromOrder: [],
        toOrder: [],
        addCandidate: { agent: 'agy', model: 'gemini-3.9-flash-low', mode: 'read' },
        replaces: 'gemini-3.8-flash-low',
        evidence: {},
        reason: 'test',
        status: 'accepted',
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
      },
    ],
  })

  const { pruneCacheForMap } = await fresh(home)
  const result = pruneCacheForMap({ AGENT_HUB_HOME: home })
  const cache = readCache({ AGENT_HUB_HOME: home })
  assert.equal('agy:gemini-3.9-flash-low' in cache, true)
  assert.equal(result.removed, 0)
})
