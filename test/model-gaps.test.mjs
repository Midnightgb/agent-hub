import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeModelGaps } from '../src/model-gaps.mjs'

const MAP = {
  recon: {
    why: 'x',
    chain: [
      { agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read' },
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', mode: 'read' },
      { agent: 'claude', model: 'haiku' },
    ],
  },
  'mechanical-edit': {
    why: 'x',
    chain: [
      { agent: 'agy', model: 'gemini-3.8-flash-medium', mode: 'write' },
      { agent: 'copilot', model: 'auto', mode: 'write' },
      { agent: 'codex', model: 'default', mode: 'write' },
    ],
  },
}

const REGISTRY = {
  agy: { 'gemini-3.8-flash-low': {}, 'gemini-3.8-flash-medium': {} },
  opencode: { 'opencode/muse-spark-1.3-contributor-free': {} },
}

test('computeModelGaps: detects a same-family same-effort version bump for a mapped model', () => {
  const discovery = {
    agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-low' }] },
  }
  const { versionBumps } = computeModelGaps({ discovery, map: MAP, registry: REGISTRY })
  assert.equal(versionBumps.length, 1)
  assert.deepEqual(versionBumps[0], {
    agent: 'agy',
    fromModel: 'gemini-3.8-flash-low',
    toModel: 'gemini-3.9-flash-low',
    taskTypes: ['recon'],
    mode: 'read',
  })
})

test('computeModelGaps: does not bump across a different effort or family', () => {
  const discovery = {
    agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-high' }, { id: 'gemini-3.9-pro-low' }] },
  }
  const { versionBumps } = computeModelGaps({ discovery, map: MAP, registry: REGISTRY })
  assert.equal(versionBumps.length, 0)
})

test('computeModelGaps: picks the highest version when multiple bumps exist', () => {
  const discovery = {
    agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-low' }, { id: 'gemini-4.0-flash-low' }] },
  }
  const { versionBumps } = computeModelGaps({ discovery, map: MAP, registry: REGISTRY })
  assert.equal(versionBumps.length, 1)
  assert.equal(versionBumps[0].toModel, 'gemini-4.0-flash-low')
})

test('computeModelGaps: never lowers version and never matches the same id', () => {
  const discovery = {
    agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.7-flash-low' }] },
  }
  const { versionBumps } = computeModelGaps({ discovery, map: MAP, registry: REGISTRY })
  assert.equal(versionBumps.length, 0)
})

test('computeModelGaps: a catalog model with no mapped/registry family match is unmapped', () => {
  const discovery = {
    agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gpt-oss-120b-medium' }] },
  }
  const { unmapped } = computeModelGaps({ discovery, map: MAP, registry: REGISTRY })
  assert.deepEqual(unmapped, [{ agent: 'agy', model: 'gpt-oss-120b-medium' }])
})

test('computeModelGaps: a version-bump toModel is excluded from unmapped', () => {
  const discovery = {
    agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-low' }] },
  }
  const { unmapped } = computeModelGaps({ discovery, map: MAP, registry: REGISTRY })
  assert.deepEqual(unmapped, [])
})

test('computeModelGaps: copilot and codex catalogs never produce bumps or unmapped entries', () => {
  const discovery = {
    copilot: { models: [{ id: 'gpt-9000' }] },
    codex: { models: [{ id: 'default' }] },
  }
  const result = computeModelGaps({ discovery, map: MAP, registry: REGISTRY })
  assert.deepEqual(result, { versionBumps: [], unmapped: [] })
})

test('computeModelGaps: groups taskTypes across multiple chains sharing the same agent:model:mode', () => {
  const map = {
    recon: MAP.recon,
    research: {
      why: 'x',
      chain: [{ agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read' }],
    },
  }
  const discovery = { agy: { models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-low' }] } }
  const { versionBumps } = computeModelGaps({ discovery, map, registry: REGISTRY })
  assert.equal(versionBumps.length, 1)
  assert.deepEqual(versionBumps[0].taskTypes.slice().sort(), ['recon', 'research'])
})

test('computeModelGaps: same model used with different modes yields separate bump entries', () => {
  const map = {
    research: {
      why: 'x',
      chain: [{ agent: 'agy', model: 'gemini-3.8-flash-medium', mode: 'read' }],
    },
    'mechanical-edit': MAP['mechanical-edit'],
  }
  const discovery = { agy: { models: [{ id: 'gemini-3.8-flash-medium' }, { id: 'gemini-3.9-flash-medium' }] } }
  const { versionBumps } = computeModelGaps({ discovery, map, registry: REGISTRY })
  assert.equal(versionBumps.length, 2)
  const modes = versionBumps.map((b) => b.mode).sort()
  assert.deepEqual(modes, ['read', 'write'])
})

test('computeModelGaps: empty discovery/map/registry returns empty result', () => {
  assert.deepEqual(computeModelGaps({}), { versionBumps: [], unmapped: [] })
})

test('parseModelId: non-dated ids parse as before; a trailing YYYYMMDD is a snapshot date, not a version', async () => {
  const { parseModelId } = await import('../src/model-gaps.mjs')
  assert.deepEqual(parseModelId('gemini-3.8-flash-low'), { family: 'gemini-*-flash', version: [3, 8], effort: 'low' })
  assert.deepEqual(parseModelId('claude-sonnet-4-6'), { family: 'claude-sonnet-*', version: [4, 6], effort: null })
  const dated = parseModelId('claude-sonnet-4-20250514')
  assert.equal(dated.family, 'claude-sonnet-*')
  assert.deepEqual(dated.version, [4])
  assert.equal(dated.snapshot, '20250514')
})

test('computeModelGaps: a dated snapshot never counts as a version bump over a non-dated id', () => {
  const map = { x: { why: 'x', chain: [{ agent: 'agy', model: 'claude-sonnet-4-5', mode: 'read' }] } }
  const discovery = { agy: { models: [{ id: 'claude-sonnet-4-20250514' }] } }
  const gaps = computeModelGaps({ discovery, map, registry: {} })
  assert.deepEqual(gaps.versionBumps, [])
})
