import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { route } from '../src/router.mjs'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const copilotFixture = () => JSON.parse(fs.readFileSync(path.join(dirname, 'fixtures', 'codexbar', 'copilot.json'), 'utf8'))

function isolated(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-quota-gate-test-'))
  return { AGENT_HUB_HOME: home, AGENT_HUB_CODEXBAR_URL: 'http://127.0.0.1:8787', ...overrides }
}

function seedCache(env, provider, data) {
  fs.writeFileSync(path.join(env.AGENT_HUB_HOME, 'quota-cache.json'), JSON.stringify({ [provider]: { data, timestamp: Date.now() } }))
}

// Same pattern as router-quota.test.mjs: route() must never await the network.
function withBlockedFetch(fn) {
  const originalFetch = global.fetch
  global.fetch = () => new Promise(() => {})
  return fn().finally(() => {
    global.fetch = originalFetch
  })
}

const profilesResolver = (profiles) => () => ({ profile: null, status: null, profiles })
const deps = (profiles) => ({ _computeMetrics: () => ({ rows: [] }), _resolveAgyProfileSync: profilesResolver(profiles) })
const EXHAUSTED = [
  { name: 'work', status: 'exhausted', remaining: 0 },
  { name: 'personal', status: 'exhausted', remaining: 0 },
]

test('quota routing off (default): an agy pair with every account exhausted keeps its place', async () => {
  await withBlockedFetch(async () => {
    const result = await route({ taskType: 'recon', env: isolated({ AGENT_HUB_AGYS: 'auto' }), ...deps(EXHAUSTED) })
    assert.equal(result.primary.agent, 'agy')
    assert.equal(result.skipped.some((s) => s.reason === 'quota'), false)
  })
})

test('quota routing skip: an agy pair with every eligible account exhausted is skipped with reason quota', async () => {
  await withBlockedFetch(async () => {
    const env = isolated({ AGENT_HUB_AGYS: 'auto', AGENT_HUB_QUOTA_ROUTING: 'skip' })
    const result = await route({ taskType: 'recon', env, ...deps(EXHAUSTED) })
    assert.equal(result.primary.agent, 'opencode')
    assert.deepEqual(
      result.skipped.find((s) => s.agent === 'agy'),
      { agent: 'agy', model: 'gemini-3.8-flash-low', reason: 'quota' }
    )
  })
})

test('quota routing skip: accounts below AGENT_HUB_QUOTA_MIN_REMAINING count as exhausted; unavailable ones are not eligible', async () => {
  await withBlockedFetch(async () => {
    const profiles = [
      { name: 'work', status: 'selected', remaining: 0.3 },
      { name: 'personal', status: 'fallback', remaining: 0.04 },
      { name: 'old', status: 'unavailable', remaining: null },
    ]
    const defaults = await route({ taskType: 'recon', env: isolated({ AGENT_HUB_AGYS: 'auto', AGENT_HUB_QUOTA_ROUTING: 'skip' }), ...deps(profiles) })
    assert.equal(defaults.primary.agent, 'agy', 'one account above the 5% default keeps the pair')

    const env = isolated({ AGENT_HUB_AGYS: 'auto', AGENT_HUB_QUOTA_ROUTING: 'skip', AGENT_HUB_QUOTA_MIN_REMAINING: '0.5' })
    const strict = await route({ taskType: 'recon', env, ...deps(profiles) })
    assert.equal(strict.primary.agent, 'opencode')
  })
})

test('quota routing skip: unknown quota never skips (fail open)', async () => {
  await withBlockedFetch(async () => {
    const env = isolated({ AGENT_HUB_AGYS: 'auto', AGENT_HUB_QUOTA_ROUTING: 'skip' })
    const unknown = [{ name: 'work', status: 'selected', remaining: null }]
    assert.equal((await route({ taskType: 'recon', env, ...deps(unknown) })).primary.agent, 'agy')
    assert.equal((await route({ taskType: 'recon', env, ...deps([]) })).primary.agent, 'agy', 'no accounts and no CodexBar data')
  })
})

test('quota routing skip: a CodexBar-metered pair whose window is used up is skipped with reason quota', async () => {
  await withBlockedFetch(async () => {
    const off = isolated()
    seedCache(off, 'copilot', copilotFixture())
    const baseline = await route({ taskType: 'triage', env: off, ...deps([]) })
    assert.equal(baseline.fallbacks[0].agent, 'copilot')

    const env = isolated({ AGENT_HUB_QUOTA_ROUTING: 'skip' })
    seedCache(env, 'copilot', copilotFixture())
    const result = await route({ taskType: 'triage', env, ...deps([]) })
    assert.equal(result.fallbacks.some((c) => c.agent === 'copilot'), false)
    assert.equal(result.skipped.find((s) => s.agent === 'copilot')?.reason, 'quota')
  })
})

test('resolveAgyProfileSync reports each account remaining quota for the model group, which the skip gate reads', async () => {
  const { resolveAgyProfileSync, resetSyncProfileCache } = await import('../src/providers/agys.mjs')
  const list = 'Active Profiles:\nPROFILE  PRIO  EMAIL  CONFIG  PATH\nwork (default)  1  w@x.com  (-)  ~/.agys/profiles/work\n'
  const quota = [{
    profileName: 'work',
    quota: {
      groups: [
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'g-weekly', remainingFraction: 0.8 }] },
        { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-weekly', remainingFraction: 0.02 }, { bucketId: '3p-5h', remainingFraction: 0.6 }] },
      ],
    },
  }]
  const execFn = (cmd, args) => (args[0] === 'list' ? list : JSON.stringify(quota))
  resetSyncProfileCache()
  const env = isolated({ AGENT_HUB_AGYS: 'auto' })
  const res = resolveAgyProfileSync({ env, execFn, model: 'claude-sonnet-4-6', listJobsFn: () => [] })
  resetSyncProfileCache()
  assert.equal(res.profiles[0].name, 'work')
  assert.equal(res.profiles[0].remaining, 0.02)
})

test('quota routing skip reads agys accounts under agys default auto mode, even with AGENT_HUB_AGYS unset', async () => {
  await withBlockedFetch(async () => {
    const result = await route({ taskType: 'recon', env: isolated({ AGENT_HUB_QUOTA_ROUTING: 'skip' }), ...deps(EXHAUSTED) })
    assert.equal(result.primary.agent, 'opencode')
    const off = await route({ taskType: 'recon', env: isolated({ AGENT_HUB_QUOTA_ROUTING: 'skip', AGENT_HUB_AGYS: 'off' }), ...deps(EXHAUSTED) })
    assert.equal(off.primary.agent, 'agy', 'agys off: accounts are not consulted')
  })
})
