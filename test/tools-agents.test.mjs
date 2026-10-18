import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-tools-agents-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/tools/agents.mjs?t=' + Date.now() + Math.random())
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

test('defaultPairs lists every distinct agent:model pair from DELEGATION_MAP, excluding claude tiers', async () => {
  const { defaultPairs } = await fresh(tmpHome())
  const pairs = defaultPairs()
  assert.ok(pairs.length > 0)
  assert.ok(!pairs.some((p) => p.agent === 'claude'))
  const keys = pairs.map((p) => `${p.agent}:${p.model}`)
  assert.equal(new Set(keys).size, keys.length, 'no duplicate pairs')
})

test('agentsStatusTool rows include binPath/cliVersion resolved from discovery.json (null when discovery has no row)', async () => {
  const home = tmpHome()
  const { agentsStatusTool } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])

  const rows = await agentsStatusTool({ cwd: '/tmp', env: { AGENT_HUB_HOME: home }, commandRunner: runner })

  assert.ok(rows.length > 0)
  for (const row of rows) {
    assert.ok('binPath' in row)
    assert.ok('cliVersion' in row)
  }
})

test('agentsStatusTool surfaces the real binPath/cliVersion once discovery.json has a fresh row for that agent', async () => {
  const home = tmpHome()
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).discoveryFile, {
    agy: { agent: 'agy', cmd: 'agy', binPath: '/home/u/.local/bin/agy', version: '1.2.1', models: [], checkedAt: new Date().toISOString(), error: null },
  })

  const { agentsStatusTool } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])

  const rows = await agentsStatusTool({ cwd: '/tmp', env: { AGENT_HUB_HOME: home }, commandRunner: runner })
  const agyRow = rows.find((r) => r.agent === 'agy')
  assert.equal(agyRow.binPath, '/home/u/.local/bin/agy')
  assert.equal(agyRow.cliVersion, '1.2.1')
})

test('agentsStatusTool with refresh:true does not await the network — quota reads cached mode, a refresh only starts a background fetch', async () => {
  const home = tmpHome()
  const { agentsStatusTool } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])

  const originalFetch = global.fetch
  global.fetch = () => new Promise(() => {}) // never resolves

  try {
    const before = Date.now()
    const rows = await agentsStatusTool({ cwd: '/tmp', refresh: true, env: { AGENT_HUB_HOME: home }, commandRunner: runner })
    const elapsed = Date.now() - before
    assert.ok(elapsed < 1000, `agentsStatusTool({refresh:true}) must not await the network, took ${elapsed}ms`)
    assert.ok(rows.length > 0)
  } finally {
    global.fetch = originalFetch
  }
})

test('agentsStatusTool: tier/tierSource come from the live catalog when a fresh, error-free opencode discovery row lists the model', async () => {
  const home = tmpHome()
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).discoveryFile, {
    opencode: {
      agent: 'opencode',
      cmd: 'opencode',
      binPath: '/bin/opencode',
      version: 'opencode v2.0.18',
      // opencode/mimo-v2.5-free is still pinned as tier:'free' in MODEL_REGISTRY
      // (src/config.mjs) -- this proves the LIVE catalog cost wins, not the
      // stale registry value.
      models: [{ id: 'opencode/mimo-v2.5-free', cost: [{ input: 0.2, output: 0.2 }] }],
      checkedAt: new Date().toISOString(),
      error: null,
    },
  })

  const { agentsStatusTool } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'x\tlabel\n', stderr: '', code: 0 }],
  ])

  const rows = await agentsStatusTool({ cwd: '/tmp', env: { AGENT_HUB_HOME: home }, commandRunner: runner })
  const row = rows.find((r) => r.agent === 'opencode' && r.model === 'opencode/mimo-v2.5-free')
  assert.equal(row.tier, 'paid')
  assert.equal(row.tierSource, 'catalog')
})

test('agentsStatusTool: tier/tierSource fall back to the MODEL_REGISTRY tier when there is no fresh discovery row', async () => {
  const home = tmpHome()
  const { agentsStatusTool } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'opencode/mimo-v2.5-free\tlabel\n', stderr: '', code: 0 }],
  ])

  const rows = await agentsStatusTool({ cwd: '/tmp', env: { AGENT_HUB_HOME: home }, commandRunner: runner })
  const row = rows.find((r) => r.agent === 'opencode' && r.model === 'opencode/mimo-v2.5-free')
  assert.equal(row.tier, 'free')
  assert.equal(row.tierSource, 'registry')
})

test('routeTool forwards default requirements, preferences and adaptive when omitted', async () => {
  const home = tmpHome()
  const { routeTool } = await fresh(home)
  let receivedArgs = null
  const fakeRoute = async (args) => {
    receivedArgs = args
    return { primary: null, fallbacks: [], skipped: [], discovery: {}, ranking: [], reason: 'test' }
  }

  await routeTool({ taskType: 'recon', routeFn: fakeRoute })

  assert.ok(receivedArgs, 'fakeRoute should be called')
  assert.equal(receivedArgs.taskType, 'recon')
  assert.equal(receivedArgs.mode, undefined)
  assert.equal(receivedArgs.includeCatalog, false)
  assert.deepEqual(receivedArgs.requirements, [])
  assert.deepEqual(receivedArgs.preferences, {})
  assert.equal(receivedArgs.adaptive, false)
})

test('routeTool forwards requirements, preferences and adaptive verbatim to routeFn', async () => {
  const home = tmpHome()
  const { routeTool } = await fresh(home)
  let receivedArgs = null
  const fakeRoute = async (args) => {
    receivedArgs = args
    return { primary: null, fallbacks: [], skipped: [], discovery: {}, ranking: [], reason: 'test' }
  }

  const requirements = ['write', 'git']
  const preferences = { quality: 0.8, cost: 0.1, latency: 0.1 }
  const adaptive = true

  await routeTool({
    taskType: 'recon',
    mode: 'write',
    includeCatalog: true,
    requirements,
    preferences,
    adaptive,
    routeFn: fakeRoute,
  })

  assert.ok(receivedArgs, 'fakeRoute should be called')
  assert.equal(receivedArgs.taskType, 'recon')
  assert.equal(receivedArgs.mode, 'write')
  assert.equal(receivedArgs.includeCatalog, true)
  assert.equal(receivedArgs.requirements, requirements)
  assert.equal(receivedArgs.preferences, preferences)
  assert.equal(receivedArgs.adaptive, true)
})
