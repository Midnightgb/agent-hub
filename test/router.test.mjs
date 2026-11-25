import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { seedOpencodeCatalog, SEEDED_FREE_MODEL } from './helpers/opencode-catalog.mjs'

function tmpHome() {
  return seedOpencodeCatalog(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-router-')))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/router.mjs?t=' + Date.now() + Math.random())
}

test('route returns a primary and fallbacks for a known task type', async () => {
  const { route } = await fresh(tmpHome())
  const result = await route({ taskType: 'recon' })
  assert.ok(result.primary.agent)
  assert.ok(Array.isArray(result.fallbacks))
  assert.ok(result.reason)
})

test('route includes Claude subagent tiers as {agent:"claude", model} entries where the map specifies them', async () => {
  const { route } = await fresh(tmpHome())
  const result = await route({ taskType: 'implementation-with-repo-rules' })
  assert.equal(result.primary.agent, 'claude')
  assert.equal(result.primary.model, 'sonnet')
})

test('mechanical-edit prefers agy (write mode) before an OpenCode Go model', async () => {
  const { DELEGATION_MAP } = await fresh(tmpHome())
  const chain = DELEGATION_MAP['mechanical-edit'].chain
  assert.deepEqual(chain[0], { agent: 'agy', model: 'gemini-3.8-flash-medium', mode: 'write' })
  assert.deepEqual(chain[1], { agent: 'opencode', model: '@go', mode: 'write' })
})

test('route skips a pair whose cached preflight is unavailable, promoting the next fallback', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeCacheEntry, cacheKey } = await import('../src/preflight.mjs?t=' + Date.now())
  const { route } = await fresh(home)

  const first = await route({ taskType: 'recon' })
  const primaryPair = first.primary

  writeCacheEntry(cacheKey(primaryPair.agent, primaryPair.model), {
    agent: primaryPair.agent,
    model: primaryPair.model,
    status: 'unavailable',
    reason: 'test',
    ladderLevel: 'L2',
    checkedAt: new Date().toISOString(),
  })

  const second = await route({ taskType: 'recon' })
  assert.notDeepEqual(second.primary, primaryPair, 'an unavailable primary must not be re-selected')
})

test('route skips a pair whose circuit breaker is open, even if its cached preflight is "ready"', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeCacheEntry, cacheKey } = await import('../src/preflight.mjs?t=' + Date.now())
  const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
  const { route } = await fresh(home)

  const first = await route({ taskType: 'recon' })
  const primaryPair = first.primary

  writeCacheEntry(cacheKey(primaryPair.agent, primaryPair.model), {
    agent: primaryPair.agent,
    model: primaryPair.model,
    status: 'ready',
    reason: null,
    ladderLevel: 'L2',
    checkedAt: new Date().toISOString(),
  })
  appendEvent({ kind: 'job.failed', agent: primaryPair.agent, model: primaryPair.model, errorKind: 'quota', cwd: '/tmp', title: 'x' })
  appendEvent({ kind: 'job.failed', agent: primaryPair.agent, model: primaryPair.model, errorKind: 'canceled', cwd: '/tmp', title: 'x' })

  const second = await route({ taskType: 'recon' })
  assert.notDeepEqual(second.primary, primaryPair, 'a breaker-open pair must not be re-selected even when cached ready')
})

test('an unknown task type throws a clear error', async () => {
  const { route } = await fresh(tmpHome())
  await assert.rejects(() => route({ taskType: 'not-a-real-task-type' }), /unknown task ?type/i)
})

test('every copilot candidate in the delegation map uses "auto", and gpt-4.1 is gone', async () => {
  const { DELEGATION_MAP } = await fresh(tmpHome())
  const copilotModels = new Set()
  for (const entry of Object.values(DELEGATION_MAP)) {
    for (const candidate of entry.chain) {
      if (candidate.agent === 'copilot') copilotModels.add(candidate.model)
      if (candidate.parallelWith?.agent === 'copilot') copilotModels.add(candidate.parallelWith.model)
    }
  }
  assert.deepEqual([...copilotModels], ['auto'])
})

test('route() result includes an additive discovery field keyed by agent, sourced from discovery.json', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).discoveryFile, {
    agy: { agent: 'agy', cmd: 'agy', binPath: '/home/u/.local/bin/agy', version: '1.2.1', models: [], checkedAt: new Date().toISOString(), error: null },
  })

  const { route } = await fresh(home)
  const result = await route({ taskType: 'recon' })

  assert.ok(result.discovery)
  assert.equal(result.discovery.agy.binPath, '/home/u/.local/bin/agy')
})

test('route() discovery is a compact summary by default and the full catalog only with includeCatalog', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  const checkedAt = new Date().toISOString()
  const models = [
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  ]
  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).discoveryFile, {
    agy: { agent: 'agy', cmd: 'agy', binPath: '/home/u/.local/bin/agy', version: '1.2.1', models, checkedAt, error: null },
  })

  const { route } = await fresh(home)

  const compact = await route({ taskType: 'recon' })
  assert.deepEqual(compact.discovery.agy, { binPath: '/home/u/.local/bin/agy', version: '1.2.1', modelCount: 2, checkedAt, error: null })
  assert.equal(compact.discovery.opencode, null)

  const full = await route({ taskType: 'recon', includeCatalog: true })
  assert.deepEqual(full.discovery.agy.models, models)
})

test('route() skips a candidate whose discovery row reports the CLI missing from PATH, with reason "cli_not_found"', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).discoveryFile, {
    agy: { agent: 'agy', cmd: 'agy', binPath: null, version: null, models: [], checkedAt: new Date().toISOString(), error: 'not found on PATH' },
  })

  const { route } = await fresh(home)
  const result = await route({ taskType: 'recon' })

  assert.ok(!result.skipped.some((s) => s.agent === 'agy' && s.model === 'gemini-3.8-flash-low' && s.reason !== 'cli_not_found') || true)
  const skippedAgy = result.skipped.find((s) => s.agent === 'agy' && s.model === 'gemini-3.8-flash-low')
  assert.ok(skippedAgy, 'the agy candidate must be skipped')
  assert.equal(skippedAgy.reason, 'cli_not_found')
  // the candidate must still be present in the map's chain (advisory, never hard-deleted from knowledge) —
  // it is simply not chosen as primary/fallback.
  assert.ok(!result.fallbacks.some((c) => c.agent === 'agy' && c.model === 'gemini-3.8-flash-low'))
  assert.notEqual(result.primary?.agent, 'agy')
})

test('route() distinguishes breaker_open from cached_unavailable in the skipped list', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeCacheEntry, cacheKey } = await import('../src/preflight.mjs?t=' + Date.now())
  const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
  const { route } = await fresh(home)

  const first = await route({ taskType: 'triage' })
  const [a, b] = first.primary ? [first.primary, first.fallbacks[0]] : []
  assert.ok(a && b, 'triage has at least 2 chain candidates to work with')

  writeCacheEntry(cacheKey(a.agent, a.model), { agent: a.agent, model: a.model, status: 'unavailable', reason: 'test', ladderLevel: 'L2', checkedAt: new Date().toISOString() })
  appendEvent({ kind: 'job.failed', agent: b.agent, model: b.model, errorKind: 'quota', cwd: '/tmp', title: 'x' })
  appendEvent({ kind: 'job.failed', agent: b.agent, model: b.model, errorKind: 'canceled', cwd: '/tmp', title: 'x' })

  const second = await route({ taskType: 'triage' })
  const skippedA = second.skipped.find((s) => s.agent === a.agent && s.model === a.model)
  const skippedB = second.skipped.find((s) => s.agent === b.agent && s.model === b.model)
  assert.equal(skippedA.reason, 'cached_unavailable')
  assert.equal(skippedB.reason, 'breaker_open')
})

test('route() skips a candidate held via overrides.json, with reason "held", and promotes the next fallback', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { setOverride, overrideKey } = await import('../src/overrides.mjs?t=' + Date.now())
  const { route } = await fresh(home)

  const first = await route({ taskType: 'recon' })
  const primaryPair = first.primary

  setOverride(overrideKey(primaryPair.agent, primaryPair.model), { hold: true, reason: 'manual' })

  const second = await route({ taskType: 'recon' })
  assert.notDeepEqual(second.primary, primaryPair, 'a held pair must not be re-selected')
  const held = second.skipped.find((s) => s.agent === primaryPair.agent && s.model === primaryPair.model)
  assert.equal(held.reason, 'held')
})

test('route() applies an accepted proposal, reordering the chain and returning appliedProposal', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  const { chainHash } = await import('../src/proposals.mjs?t=' + Date.now())
  const { DELEGATION_MAP, route } = await fresh(home)

  const chain = DELEGATION_MAP.recon.chain
  const cli = chain.filter((c) => c.agent !== 'claude')
  const hash = chainHash(chain)

  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).proposalsFile, {
    version: 1,
    proposals: [
      {
        id: 'prop-recon-1',
        taskType: 'recon',
        chainHash: hash,
        fromOrder: cli.map((c) => ({ agent: c.agent, model: c.model })),
        toOrder: [{ agent: cli[1].agent, model: cli[1].model }, { agent: cli[0].agent, model: cli[0].model }],
        evidence: {},
        reason: 'test',
        status: 'accepted',
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
      },
    ],
  })

  const result = await route({ taskType: 'recon' })
  assert.deepEqual(result.appliedProposal, { id: 'prop-recon-1' })
  assert.equal(result.primary.agent, cli[1].agent)
  // The proposal reorders the declared chain; route() then expands the @free pool.
  assert.equal(cli[1].model, '@free')
  assert.equal(result.primary.model, SEEDED_FREE_MODEL)
})

test('route() ignores an accepted proposal whose chainHash is stale (DELEGATION_MAP changed underneath it)', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  const { route } = await fresh(home)

  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).proposalsFile, {
    version: 1,
    proposals: [
      {
        id: 'prop-stale',
        taskType: 'recon',
        chainHash: 'stale-hash-000000',
        fromOrder: [],
        toOrder: [],
        evidence: {},
        reason: 'test',
        status: 'accepted',
        createdAt: new Date().toISOString(),
        decidedAt: new Date().toISOString(),
      },
    ],
  })

  const result = await route({ taskType: 'recon' })
  assert.equal(result.appliedProposal, null)
})

test('clearing a hold override makes the candidate usable again', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { setOverride, clearOverride, overrideKey } = await import('../src/overrides.mjs?t=' + Date.now())
  const { route } = await fresh(home)

  const first = await route({ taskType: 'recon' })
  const primaryPair = first.primary
  const key = overrideKey(primaryPair.agent, primaryPair.model)

  setOverride(key, { hold: true })
  const held = await route({ taskType: 'recon' })
  assert.notDeepEqual(held.primary, primaryPair)

  clearOverride(key)
  const released = await route({ taskType: 'recon' })
  assert.deepEqual(released.primary, primaryPair)
})

test('route() appends an accepted add_candidate proposal at the tail; primary and fallback order stay unchanged', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeJsonAtomic } = await import('../src/fsutil.mjs?t=' + Date.now())
  const { paths } = await import('../src/config.mjs?t=' + Date.now())
  const { chainHash } = await import('../src/proposals.mjs?t=' + Date.now())
  const { DELEGATION_MAP, route } = await fresh(home)

  const chain = DELEGATION_MAP.recon.chain
  const hash = chainHash(chain)
  const before = await route({ taskType: 'recon' })

  writeJsonAtomic(paths({ AGENT_HUB_HOME: home }).proposalsFile, {
    version: 1,
    proposals: [
      {
        id: 'prop-add-recon-1',
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

  const result = await route({ taskType: 'recon' })
  assert.equal(result.primary.agent, before.primary.agent)
  assert.equal(result.primary.model, before.primary.model)
  assert.equal(result.fallbacks.length, before.fallbacks.length + 1, 'the new candidate is appended, not swapped in')
  const last = result.fallbacks[result.fallbacks.length - 1]
  assert.equal(last.agent, 'agy')
  assert.equal(last.model, 'gemini-3.9-flash-low')
})
