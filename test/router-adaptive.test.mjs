import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { seedOpencodeCatalog } from './helpers/opencode-catalog.mjs'

function tmpHome() {
  return seedOpencodeCatalog(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-router-adaptive-')))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/router.mjs?t=' + Date.now() + Math.random())
}

test('route() without the new options returns the same primary/fallbacks as before and now also a ranking array', async () => {
  const home = tmpHome()
  const { route } = await fresh(home)
  const result = await route({ taskType: 'recon' })

  assert.equal(result.primary.agent, 'agy')
  assert.equal(result.primary.model, 'gemini-3.8-flash-low')
  assert.ok(Array.isArray(result.fallbacks))
  assert.equal(result.fallbacks.length, 2)
  assert.ok(Array.isArray(result.ranking))
  assert.equal(result.ranking.length, 3)
  assert.equal(result.ranking[0].agent, 'agy')
  assert.equal(result.ranking[0].model, 'gemini-3.8-flash-low')
  assert.ok('score' in result.ranking[0])
  assert.ok(Array.isArray(result.ranking[0].reasons))
})

test('requirements: [sessionResume] moves a copilot candidate to skipped with reason starting missing_capabilities: and never makes it primary', async () => {
  const home = tmpHome()
  const { writeCacheEntry, cacheKey } = await import('../src/preflight.mjs?t=' + Date.now())
  const { route } = await fresh(home)

  writeCacheEntry(cacheKey('opencode', 'opencode/muse-spark-1.3-contributor-free'), {
    agent: 'opencode',
    model: 'opencode/muse-spark-1.3-contributor-free',
    status: 'unavailable',
    reason: 'test',
    ladderLevel: 'L2',
    checkedAt: new Date().toISOString(),
  })

  const result = await route({ taskType: 'triage', requirements: ['sessionResume'] })
  const skippedCopilot = result.skipped.find((s) => s.agent === 'copilot')
  assert.ok(skippedCopilot, 'copilot must be in skipped')
  assert.ok(skippedCopilot.reason.startsWith('missing_capabilities:'), 'reason must start with missing_capabilities:')
  assert.equal(skippedCopilot.reason, 'missing_capabilities:sessionResume')
  assert.notEqual(result.primary?.agent, 'copilot', 'copilot must never be primary')
  assert.equal(result.primary?.agent, 'codex')
})

test('adaptive: true with two eligible candidates where the second has better qualityScore reorders primary accordingly; with adaptive false the map order is preserved', async () => {
  const home = tmpHome()
  const { route } = await fresh(home)

  const mockMetrics = () => ({
    rows: [
      { agent: 'agy', model: 'gemini-3.8-flash-low', qualityScore: 4, taskType: 'recon' },
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', qualityScore: 9, taskType: 'recon' },
    ],
  })

  const nonAdaptive = await route({ taskType: 'recon', adaptive: false, _computeMetrics: mockMetrics })
  assert.equal(nonAdaptive.primary.agent, 'agy')
  assert.equal(nonAdaptive.primary.model, 'gemini-3.8-flash-low')

  const adaptiveRes = await route({ taskType: 'recon', adaptive: true, _computeMetrics: mockMetrics })
  assert.equal(adaptiveRes.primary.agent, 'opencode')
  assert.equal(adaptiveRes.primary.model, 'opencode/muse-spark-1.3-contributor-free')
  assert.equal(adaptiveRes.fallbacks[0].agent, 'agy')
})

test('preferences: { cost: 1 } picks the cheaper candidate when costUsdAvg differs; preferences: { quality: 1 } picks the higher qualityScore', async () => {
  const home = tmpHome()
  const { route } = await fresh(home)

  const mockMetrics = () => ({
    rows: [
      { agent: 'agy', model: 'gemini-3.8-flash-low', qualityScore: 9, costUsdAvg: 0.05, taskType: 'recon' },
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', qualityScore: 5, costUsdAvg: 0.001, taskType: 'recon' },
    ],
  })

  const costRes = await route({ taskType: 'recon', adaptive: true, preferences: { cost: 1 }, _computeMetrics: mockMetrics })
  assert.equal(costRes.primary.agent, 'opencode')

  const qualityRes = await route({ taskType: 'recon', adaptive: true, preferences: { quality: 1 }, _computeMetrics: mockMetrics })
  assert.equal(qualityRes.primary.agent, 'agy')
})

test('a candidate with no metrics rows does not break anything (ranking entry score 0 with a no data reason)', async () => {
  const home = tmpHome()
  const { route } = await fresh(home)

  const emptyMetrics = () => ({ rows: [] })
  const result = await route({ taskType: 'recon', _computeMetrics: emptyMetrics })

  assert.ok(result.ranking.length > 0)
  for (const entry of result.ranking) {
    assert.equal(entry.score, 0)
    assert.ok(entry.reasons.every((r) => r.note === 'no data'))
  }
})

test('empty requirements + empty preferences == todays behaviour', async () => {
  const home = tmpHome()
  const { route } = await fresh(home)

  const baseline = await route({ taskType: 'recon' })
  const explicitEmpty = await route({ taskType: 'recon', requirements: [], preferences: {} })

  assert.deepEqual(baseline.primary, explicitEmpty.primary)
  assert.deepEqual(baseline.fallbacks, explicitEmpty.fallbacks)
  assert.deepEqual(baseline.skipped, explicitEmpty.skipped)
  assert.deepEqual(baseline.reason, explicitEmpty.reason)
  assert.deepEqual(baseline.appliedProposal, explicitEmpty.appliedProposal)
})

test('metrics lookup prefers taskType match over other taskTypes for the same agent/model pair', async () => {
  const home = tmpHome()
  const { route } = await fresh(home)

  const mockMetrics = () => ({
    rows: [
      { agent: 'agy', model: 'gemini-3.8-flash-low', qualityScore: 9, taskType: 'triage' },
      { agent: 'agy', model: 'gemini-3.8-flash-low', qualityScore: 2, taskType: 'recon' },
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', qualityScore: 6, taskType: 'recon' },
    ],
  })

  const result = await route({ taskType: 'recon', adaptive: true, preferences: { quality: 1 }, _computeMetrics: mockMetrics })
  assert.equal(result.primary.agent, 'opencode')
})

test('metrics are read through the injected computeMetrics, never from a file', async () => {
  const home = tmpHome()
  const { route } = await fresh(home)
  const mockMetrics = () => ({
    rows: [
      { agent: 'agy', model: 'gemini-3.8-flash-low', qualityScore: 3, taskType: 'recon' },
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', qualityScore: 8, taskType: 'recon' },
    ],
  })
  const result = await route({ taskType: 'recon', adaptive: true, _computeMetrics: mockMetrics })
  assert.equal(result.primary.agent, 'opencode')
})
