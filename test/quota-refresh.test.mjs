import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recordQuotaMark, readQuotaMarks, refreshQuota } from '../src/routing/quota-gate.mjs'
import { recordQuotaExhaustion, readQuotaExhaustion } from '../src/providers/agys.mjs'
import { startScheduler } from '../src/scheduler.mjs'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const HOUR = 3_600_000
const at = (ms) => () => ms

function isolated(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-quota-refresh-test-'))
  return { AGENT_HUB_HOME: home, AGENT_HUB_QUOTA_ROUTING: 'skip', AGENT_HUB_AGYS: 'auto', ...overrides }
}

const copilotUsage = (usedPercent) => ({ copilot: [{ provider: 'copilot', usage: { primary: { usedPercent } } }] })
const agysQuota = (remainingFraction) => ({
  esp: { quota: { groups: [{ displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-weekly', remainingFraction }] }] } },
})

test('refreshQuota is a no-op unless quota routing is skip', async () => {
  let fetched = 0
  const result = await refreshQuota({
    env: isolated({ AGENT_HUB_QUOTA_ROUTING: '' }),
    fetchUsageFn: async () => (fetched++, {}),
    readAgysQuotaFn: async () => (fetched++, {}),
  })
  assert.deepEqual(result, { cleared: [] })
  assert.equal(fetched, 0)
})

test('refreshQuota clears pair marks whose reset passed or whose quota is back, and keeps the rest', async () => {
  const env = isolated()
  recordQuotaMark({ agent: 'codex', model: 'default', message: 'Resets in 1h', env, now: at(NOW) })
  recordQuotaMark({ agent: 'copilot', model: 'auto', message: 'Resets in 78h', env, now: at(NOW) })
  recordQuotaMark({ agent: 'opencode', model: 'opencode-go/x', message: 'Resets in 78h', env, now: at(NOW) })

  const later = NOW + 2 * HOUR
  const usage = { ...copilotUsage(40), opencodego: { error: 'codexbar_unreachable' } }
  const result = await refreshQuota({ env, now: at(later), fetchUsageFn: async () => usage, readAgysQuotaFn: async () => ({}) })
  assert.deepEqual(result.cleared.sort(), ['codex:default', 'copilot:auto'])
  assert.deepEqual(Object.keys(readQuotaMarks(env)), ['opencode:opencode-go/x'], 'unknown quota keeps the mark until its reset')
})

test('refreshQuota keeps a mark younger than one refresh interval even when quota reads as back', async () => {
  const env = isolated()
  recordQuotaMark({ agent: 'copilot', model: 'auto', message: 'Resets in 78h', env, now: at(NOW) })
  const result = await refreshQuota({ env, now: at(NOW + 60_000), fetchUsageFn: async () => copilotUsage(10), readAgysQuotaFn: async () => ({}) })
  assert.deepEqual(result.cleared, [])
})

test('refreshQuota clears an agys account mark once that account has quota again for the group', async () => {
  const env = isolated()
  recordQuotaExhaustion({ profile: 'esp', modelGroup: 'claude-gpt', message: 'Resets in 78h0m0s', env, now: at(NOW) })
  const later = NOW + HOUR

  await refreshQuota({ env, now: at(later), fetchUsageFn: async () => ({}), readAgysQuotaFn: async () => agysQuota(0.01) })
  assert.ok(readQuotaExhaustion(env).esp?.['claude-gpt'], 'still below the threshold')

  const result = await refreshQuota({ env, now: at(later), fetchUsageFn: async () => ({}), readAgysQuotaFn: async () => agysQuota(0.7) })
  assert.deepEqual(result.cleared, ['agys:esp:claude-gpt'])
  assert.equal(readQuotaExhaustion(env).esp?.['claude-gpt'], undefined)
})

test('startScheduler runs the quota refresh on AGENT_HUB_QUOTA_REFRESH_S only when quota routing is skip', async () => {
  const runs = []
  const opts = (env) => ({ env, intervalMs: 60_000, listSchedulesFn: () => [], refreshQuotaFn: async () => runs.push(env.AGENT_HUB_QUOTA_ROUTING) })
  const schedulers = [
    startScheduler(opts({ AGENT_HUB_QUOTA_ROUTING: 'skip', AGENT_HUB_QUOTA_REFRESH_S: '0.01' })),
    startScheduler(opts({ AGENT_HUB_QUOTA_ROUTING: 'skip', AGENT_HUB_QUOTA_REFRESH_S: '0' })),
    startScheduler(opts({ AGENT_HUB_QUOTA_REFRESH_S: '0.01' })),
  ]
  await new Promise((resolve) => setTimeout(resolve, 60))
  schedulers.forEach((s) => s.stop())
  assert.ok(runs.length >= 1)
  assert.ok(runs.every((mode) => mode === 'skip'))
})
