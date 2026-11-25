import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { route } from '../src/router.mjs'
import { parseQuotaResetAt, recordQuotaMark, activeQuotaMark } from '../src/routing/quota-gate.mjs'
import { agentsQuotaTool } from '../src/tools/agents.mjs'
import { seedOpencodeCatalog } from './helpers/opencode-catalog.mjs'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const HOUR = 3_600_000

function isolated(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-quota-marks-test-'))
  seedOpencodeCatalog(home)
  return { AGENT_HUB_HOME: home, AGENT_HUB_CODEXBAR_URL: 'http://127.0.0.1:8787', ...overrides }
}

function withBlockedFetch(fn) {
  const originalFetch = global.fetch
  global.fetch = () => new Promise(() => {})
  return fn().finally(() => {
    global.fetch = originalFetch
  })
}

test('parseQuotaResetAt reads relative durations and absolute timestamps, leniently', () => {
  const at = (message) => parseQuotaResetAt(message, NOW)
  assert.equal(at('Individual quota reached. Please upgrade your subscription. Resets in 78h0m13s.'), NOW + 78 * HOUR + 13_000)
  assert.equal(at('quota exceeded, reset in 150 hours'), NOW + 150 * HOUR)
  assert.equal(at('429: try again in 2 days 3h'), NOW + 51 * HOUR)
  assert.equal(at('quota reached; resets at 2026-10-25T10:00:00Z'), Date.parse('2026-10-25T10:00:00Z'))
  assert.equal(at('quota reached, no timing info'), null)
  assert.equal(at('resets at 2026-10-01T00:00:00Z'), null, 'a reset already in the past is ignored')
  assert.equal(at(undefined), null)
})

test('recordQuotaMark keys agy by model group and falls back to a default TTL', () => {
  const env = isolated()
  const mark = recordQuotaMark({ agent: 'agy', model: 'claude-sonnet-4-6', message: 'Individual quota reached', env, now: () => NOW })
  assert.equal(mark.resetAt, NOW + HOUR)
  assert.ok(activeQuotaMark({ agent: 'agy', model: 'claude-opus-4-6-thinking', env, now: () => NOW }), 'same group shares the mark')
  assert.equal(activeQuotaMark({ agent: 'agy', model: 'gemini-3.8-flash-low', env, now: () => NOW }), null)
  assert.equal(activeQuotaMark({ agent: 'agy', model: 'claude-sonnet-4-6', env, now: () => NOW + 2 * HOUR }), null, 'expired')
})

test('route skips a pair with an active exhaustion mark only when quota routing is skip', async () => {
  await withBlockedFetch(async () => {
    const deps = { _computeMetrics: () => ({ rows: [] }), _resolveAgyProfileSync: () => ({ profiles: [] }) }
    const now = Date.now()
    const off = isolated()
    recordQuotaMark({ agent: 'agy', model: 'gemini-3.8-flash-low', message: 'Resets in 78h', env: off, now: () => now })
    assert.equal((await route({ taskType: 'recon', env: off, ...deps })).primary.agent, 'agy')

    const env = isolated({ AGENT_HUB_QUOTA_ROUTING: 'skip' })
    recordQuotaMark({ agent: 'agy', model: 'gemini-3.8-flash-low', message: 'Resets in 78h', env, now: () => now })
    const result = await route({ taskType: 'recon', env, ...deps })
    assert.equal(result.primary.agent, 'opencode')
    const iso = new Date(now + 78 * HOUR).toISOString()
    assert.equal(result.skipped.find((s) => s.agent === 'agy')?.reason, `quota-exhausted-until ${iso}`)
  })
})

test('agents_quota shows an active exhaustion mark on its pair', async () => {
  const env = isolated({ AGENT_HUB_QUOTA_ROUTING: 'skip' })
  const now = Date.now()
  recordQuotaMark({ agent: 'copilot', model: 'auto', message: 'Resets in 3h', env, now: () => now })
  const rows = await agentsQuotaTool({
    env,
    pairsFn: () => [{ agent: 'copilot', model: 'auto' }, { agent: 'agy', model: 'gemini-3.8-flash-low' }],
    readDiscoveryFn: () => ({}),
    fetchUsageFn: async () => ({}),
  })
  assert.equal(rows[0].quotaExhaustedUntil, new Date(now + 3 * HOUR).toISOString())
  assert.equal('quotaExhaustedUntil' in rows[1], false)
})
