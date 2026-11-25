import test from 'node:test'
import assert from 'node:assert/strict'
import { quotaFor, getProvider } from '../src/quota/mapping.mjs'

test('gentle-shell shares the opencode go quota and leaves Anthropic API models unmetered', () => {
  assert.equal(getProvider('gentle-shell', 'opencode-go/qwen3.8-flash'), 'opencodego')
  assert.equal(getProvider('gentle-shell', 'anthropic/claude-sonnet-5-5'), null)
  assert.equal(getProvider('opencode', 'opencode-go/default'), 'opencodego')
})

test('opencode free models are not metered', () => {
  const result = quotaFor({ agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }, {})
  assert.deepEqual(result, { note: 'not metered by CodexBar' })
})

test('opencode go is metered', () => {
  const usage = {
    opencodego: [{
      usage: {
        primary: { usedPercent: 10, resetsAt: '2026-09-16T17:29:01Z', windowMinutes: 300 },
        secondary: { usedPercent: 20, resetsAt: '2026-09-20T23:59:59Z', windowMinutes: 10080 },
        tertiary: { usedPercent: 30, resetsAt: '2026-10-07T03:40:05Z', windowMinutes: 43200 },
        dataConfidence: 'estimated',
        updatedAt: '2026-09-16T12:29:01Z'
      }
    }]
  }
  const result = quotaFor({ agent: 'opencode', model: 'opencode-go/default' }, usage)
  assert.equal(result.provider, 'opencodego')
  assert.equal(result.exhausted, false)
  assert.equal(result.windows.length, 3)
  assert.equal(result.windows[0].id, 'opencodego-primary')
  assert.equal(result.windows[0].usedPercent, 10)
  assert.equal(result.dataConfidence, 'estimated')
})

test('usageKnown false reports null usedPercent and does not trigger exhausted', () => {
  const usage = {
    antigravity: [{
      usage: {
        primary: { usedPercent: 10 },
        extraRateWindows: [
          {
            id: 'antigravity-quota-summary-3p-5h',
            title: 'Claude/GPT 5-hour',
            usageKnown: false,
            window: { usedPercent: 0, resetsAt: '2026-09-16T17:28:59Z', windowMinutes: 300 }
          }
        ]
      }
    }]
  }
  const result = quotaFor({ agent: 'agy', model: 'claude-sonnet-4-6' }, usage)
  assert.equal(result.exhausted, false)
  const window = result.windows.find(w => w.id === 'antigravity-quota-summary-3p-5h')
  assert.equal(window.usageKnown, false)
  assert.equal(window.usedPercent, null)
})

test('exhausted when >= 100 on known window', () => {
  const usage = {
    copilot: [{
      usage: {
        primary: { usedPercent: 100, resetsAt: '2026-10-01T00:00:00Z' }
      }
    }]
  }
  const result = quotaFor({ agent: 'copilot', model: 'auto' }, usage)
  assert.equal(result.exhausted, true)
  assert.equal(result.nextResetAt, '2026-10-01T00:00:00.000Z')
})

test('a pending provider (cached mode, nothing cached yet) reports quota_pending', () => {
  const usage = { copilot: { pending: true } }
  const result = quotaFor({ agent: 'copilot', model: 'auto' }, usage)
  assert.deepEqual(result, { quotaUnavailableReason: 'quota_pending' })
})

test('stale and cachedAt on a cached-mode entry pass through to the quota object', () => {
  const usage = {
    copilot: Object.assign(
      [{ usage: { primary: { usedPercent: 42, resetsAt: '2026-10-01T00:00:00Z' } } }],
      { stale: true, cachedAt: '2026-09-16T12:00:00.000Z' }
    ),
  }
  const result = quotaFor({ agent: 'copilot', model: 'auto' }, usage)
  assert.equal(result.stale, true)
  assert.equal(result.cachedAt, '2026-09-16T12:00:00.000Z')
})

test('a fresh (non-cached-mode) entry with no stale/cachedAt does not add those fields', () => {
  const usage = { copilot: [{ usage: { primary: { usedPercent: 5 } } }] }
  const result = quotaFor({ agent: 'copilot', model: 'auto' }, usage)
  assert.equal('stale' in result, false)
  assert.equal('cachedAt' in result, false)
})

test('an error code from fetchUsage passes through unchanged', () => {
  const usage = { copilot: { error: 'codexbar_timeout' } }
  const result = quotaFor({ agent: 'copilot', model: 'auto' }, usage)
  assert.deepEqual(result, { quotaUnavailableReason: 'codexbar_timeout' })
})

