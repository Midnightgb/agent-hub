import test from 'node:test'
import assert from 'node:assert/strict'
import { route } from '../src/router.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { seedOpencodeCatalog } from './helpers/opencode-catalog.mjs'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(dirname, 'fixtures', 'codexbar', file), 'utf8'))

function isolated(overrides = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-'))
  seedOpencodeCatalog(tempDir)
  return {
    ...process.env,
    AGENT_HUB_HOME: tempDir,
    AGENT_HUB_CODEXBAR_URL: 'http://127.0.0.1:8787',
    ...overrides,
  }
}

// route() reads quota in 'cached' mode: it must never await the network, so
// it can only ever see whatever is already sitting in the quota cache file.
// This test seeds that cache directly rather than relying on a live fetch
// completing in time, since a cached-mode route() call never waits for one.
function seedCache(env, provider, data) {
  const cacheFile = path.join(env.AGENT_HUB_HOME, 'quota-cache.json')
  const current = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {}
  current[provider] = { data, timestamp: Date.now() }
  fs.writeFileSync(cacheFile, JSON.stringify(current))
}

test('route returns identical primary/fallback ordering whether quota data is present or absent', async () => {
  const envAbsent = isolated()
  const envPresent = isolated()
  seedCache(envPresent, 'copilot', readJson('copilot.json'))

  // A never-resolving fetch proves route() never blocks on the network,
  // regardless of whether the cache already has data for this call.
  const originalFetch = global.fetch
  global.fetch = () => new Promise(() => {})

  try {
    const resultAbsent = await route({ taskType: 'triage', env: envAbsent })
    const resultPresent = await route({ taskType: 'triage', env: envPresent })

    const stripQuota = (res) => {
      const cloned = JSON.parse(JSON.stringify(res))
      if (cloned.primary) delete cloned.primary.quota
      cloned.fallbacks.forEach((f) => delete f.quota)
      return cloned
    }

    assert.deepEqual(stripQuota(resultAbsent), stripQuota(resultPresent))

    // muse-spark is free (not metered), regardless of any cache state
    assert.deepEqual(resultPresent.primary.quota, { note: 'not metered by CodexBar' })
    // copilot was pre-seeded fresh in the cache, so cached mode returns it directly
    assert.equal(resultPresent.fallbacks[0].quota.exhausted, true)
    assert.equal(resultPresent.fallbacks[0].quota.stale, false)

    // Nothing was seeded for the absent case, so the fallback is pending —
    // never blocked, never a raw error message.
    assert.equal(resultAbsent.fallbacks[0].quota.quotaUnavailableReason, 'quota_pending')
  } finally {
    global.fetch = originalFetch
  }
})

test('route() resolves promptly even when the underlying fetch never resolves (quota is informational only)', async () => {
  const env = isolated()
  const originalFetch = global.fetch
  global.fetch = () => new Promise(() => {})

  try {
    const before = Date.now()
    const result = await route({ taskType: 'triage', env })
    const elapsed = Date.now() - before
    assert.ok(elapsed < 500, `route() must not block on quota, took ${elapsed}ms`)
    assert.ok(result.primary, 'route() still resolves a primary candidate')
  } finally {
    global.fetch = originalFetch
  }
})
