import test from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../src/router.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedOpencodeCatalog } from './helpers/opencode-catalog.mjs'

function isolated(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-codex-gate-test-'))
  seedOpencodeCatalog(tempDir)
  return {
    ...process.env,
    AGENT_HUB_HOME: tempDir,
    AGENT_HUB_CODEXBAR_URL: 'http://127.0.0.1:8787',
    ...overrides,
  }
}

// route() reads quota in 'cached' mode: seed the cache file directly, same
// pattern as test/router-quota.test.mjs.
function seedCache(env, provider, data) {
  const cacheFile = path.join(env.AGENT_HUB_HOME, 'quota-cache.json')
  const current = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {}
  current[provider] = { data, timestamp: Date.now() }
  fs.writeFileSync(cacheFile, JSON.stringify(current))
}

const NOW = Date.parse('2026-09-22T12:00:00Z')
function isoAfterMinutes(minutes) {
  return new Date(NOW + minutes * 60_000).toISOString()
}

function codexFixture({ usedPercent, windowMinutes = 43200, resetInMinutes = 20000 }) {
  return [
    {
      provider: 'codex',
      usage: {
        primary: { usedPercent, resetsAt: isoAfterMinutes(resetInMinutes), windowMinutes },
        secondary: null,
        dataConfidence: 'exact',
        updatedAt: isoAfterMinutes(0),
      },
    },
  ]
}

// Blocks the network so every provider without a seeded cache entry stays
// 'quota_pending', matching test/router-quota.test.mjs's pattern.
function withBlockedFetch(fn) {
  const originalFetch = global.fetch
  global.fetch = () => new Promise(() => {})
  return fn().finally(() => {
    global.fetch = originalFetch
  })
}

test('route: codex remaining < 20% is DROPPED entirely from the triage chain, with a quota_low skip annotation', async () => {
  await withBlockedFetch(async () => {
    const env = isolated()
    seedCache(env, 'codex', codexFixture({ usedPercent: 89 })) // remaining 11%

    const result = await route({ taskType: 'triage', env, now: () => NOW })

    const allAgents = [result.primary, ...result.fallbacks].map((c) => c.agent)
    assert.ok(!allAgents.includes('codex'), 'codex must not appear in primary/fallbacks at all')

    const codexSkip = result.skipped.find((s) => s.agent === 'codex')
    assert.ok(codexSkip, 'codex must be recorded in skipped')
    assert.equal(codexSkip.reason, 'quota_low')
    assert.equal(codexSkip.remainingPct, 11)
  })
})

test('route: codex remaining >=50% and on pace is PROMOTED to position 2 in the triage chain', async () => {
  await withBlockedFetch(async () => {
    const env = isolated()
    // windowMinutes 100, resets in 50 -> elapsedFraction 0.5; usedPercent 30 -> on pace. Remaining 70%.
    seedCache(env, 'codex', codexFixture({ usedPercent: 30, windowMinutes: 100, resetInMinutes: 50 }))

    const result = await route({ taskType: 'triage', env, now: () => NOW })

    // triage's static order is [opencode/muse-spark, copilot, codex]; codex
    // must move to position 2 (right after the first entry), copilot pushed last.
    assert.equal(result.primary.agent, 'opencode')
    assert.equal(result.fallbacks[0].agent, 'codex')
    assert.equal(result.fallbacks[1].agent, 'copilot')
    assert.equal(result.fallbacks[0].quotaGate?.action, 'promoted')
    assert.equal(result.fallbacks[0].quotaGate?.reason, 'quota_headroom')
    assert.equal(result.fallbacks[0].quotaGate?.remainingPct, 70)
  })
})

test('route: codex with healthy-but-unremarkable quota (30%-50% used, or ahead of pace) stays the LAST fallback, unchanged', async () => {
  await withBlockedFetch(async () => {
    const env = isolated()
    // Remaining 35% -> below the 50% promote floor, above the 20% drop floor.
    seedCache(env, 'codex', codexFixture({ usedPercent: 65, windowMinutes: 100, resetInMinutes: 50 }))

    const result = await route({ taskType: 'triage', env, now: () => NOW })

    assert.equal(result.primary.agent, 'opencode')
    assert.equal(result.fallbacks[0].agent, 'copilot')
    assert.equal(result.fallbacks[1].agent, 'codex')
    assert.equal(result.fallbacks[1].quotaGate, undefined, 'unchanged codex carries no quotaGate annotation')
  })
})

test('route: codex quota gate applies the same way in the mechanical-edit chain', async () => {
  await withBlockedFetch(async () => {
    const env = isolated()
    seedCache(env, 'codex', codexFixture({ usedPercent: 95 })) // remaining 5%

    const result = await route({ taskType: 'mechanical-edit', env, now: () => NOW })

    const allAgents = [result.primary, ...result.fallbacks].map((c) => c.agent)
    assert.ok(!allAgents.includes('codex'))
    assert.equal(result.skipped.find((s) => s.agent === 'codex')?.reason, 'quota_low')
  })
})

test('route: unknown codex quota (nothing seeded, cache stays pending) leaves triage ordering unchanged — never drops or promotes on missing data', async () => {
  await withBlockedFetch(async () => {
    const env = isolated()
    const result = await route({ taskType: 'triage', env, now: () => NOW })

    assert.equal(result.primary.agent, 'opencode')
    assert.equal(result.fallbacks[0].agent, 'copilot')
    assert.equal(result.fallbacks[1].agent, 'codex')
  })
})

test('route: a taskType without codex in its chain (recon) is never touched by the gate', async () => {
  await withBlockedFetch(async () => {
    const env = isolated()
    seedCache(env, 'codex', codexFixture({ usedPercent: 89 }))

    const result = await route({ taskType: 'recon', env, now: () => NOW })
    const allAgents = [result.primary, ...result.fallbacks].map((c) => c.agent)
    assert.ok(!allAgents.includes('codex'), 'recon never routes to codex in the first place')
    assert.ok(!result.skipped.some((s) => s.agent === 'codex'), 'codex is not even in this chain, so it cannot be skipped by the gate')
  })
})
