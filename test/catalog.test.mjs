import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogTier, effectiveTier, computeCatalogDrift, validateVariant } from '../src/catalog.mjs'

const FRESH = new Date().toISOString()
// Well past PREFLIGHT_TTL_MS (15m). discovery.json is only refreshed at MCP
// startup and on an explicit dashboard "Rediscover CLIs" action, so a row
// this old is completely normal in production, not a sign of stale data --
// it is still the last successful catalog fetch and the best evidence
// available. Tier/drift must NOT gate on this age.
const OLD = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

// --- catalogTier ---

test('catalogTier: free when the first cost entry has input:0 and output:0', () => {
  const entry = { id: 'opencode/big-pickle', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }
  assert.equal(catalogTier(entry), 'free')
})

test('catalogTier: paid when input > 0', () => {
  const entry = { id: 'deepseek/deepseek-v4-pro', cost: [{ input: 0.27, output: 1.1 }] }
  assert.equal(catalogTier(entry), 'paid')
})

test('catalogTier: paid when only output > 0', () => {
  const entry = { id: 'x', cost: [{ input: 0, output: 0.5 }] }
  assert.equal(catalogTier(entry), 'paid')
})

test('catalogTier: unknown (null), never free, when cost is missing', () => {
  assert.equal(catalogTier({ id: 'x' }), null)
})

test('catalogTier: unknown (null) when cost is an empty array', () => {
  assert.equal(catalogTier({ id: 'x', cost: [] }), null)
})

// --- effectiveTier ---

test('effectiveTier: uses the live catalog tier when the discovery row is error-free and lists the model, and reports catalogCheckedAt', () => {
  const discovery = {
    opencode: {
      checkedAt: FRESH,
      error: null,
      models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }],
    },
  }
  const registry = { opencode: {} } // no registry entry at all -- catalog wins
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/big-pickle', discovery, registry })
  assert.deepEqual(result, { tier: 'free', tierSource: 'catalog', catalogCheckedAt: FRESH })
})

test('effectiveTier: uses the catalog tier even when the row is hours old (past the 15-minute preflight TTL) -- discovery.json is only refreshed at startup/explicit refresh, never on a fixed interval', () => {
  const discovery = {
    opencode: {
      checkedAt: OLD,
      error: null,
      models: [{ id: 'opencode/space-bunny-free', cost: [{ input: 0, output: 0 }] }],
    },
  }
  // Registry does not even know this model -- if the TTL gate were still
  // active this would incorrectly fall back to {tier: null, tierSource: 'registry'}.
  const registry = { opencode: {} }
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/space-bunny-free', discovery, registry })
  assert.deepEqual(result, { tier: 'free', tierSource: 'catalog', catalogCheckedAt: OLD })
})

test('effectiveTier: falls back to the registry tier when the discovery row has an error', () => {
  const discovery = {
    opencode: { checkedAt: FRESH, error: 'model list timed out', models: [] },
  }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/big-pickle', discovery, registry })
  assert.deepEqual(result, { tier: 'free', tierSource: 'registry', catalogCheckedAt: null })
})

test('effectiveTier: falls back to the registry tier when the discovery row has empty models (no successful fetch yet)', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: null, models: [] } }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/big-pickle', discovery, registry })
  assert.deepEqual(result, { tier: 'free', tierSource: 'registry', catalogCheckedAt: null })
})

test('effectiveTier: falls back to the registry tier when the catalog does not list the model', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/other-model' }] } }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/big-pickle', discovery, registry })
  assert.deepEqual(result, { tier: 'free', tierSource: 'registry', catalogCheckedAt: null })
})

test('effectiveTier: null tier, registry source, when neither the catalog nor the registry knows the model', () => {
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/unknown', discovery: {}, registry: { opencode: {} } })
  assert.deepEqual(result, { tier: null, tierSource: 'registry', catalogCheckedAt: null })
})

// --- computeCatalogDrift ---

const MAP = {
  recon: { why: 'x', chain: [{ agent: 'opencode', model: 'opencode/nemotron-3-ultra-free', mode: 'read' }] },
}

test('computeCatalogDrift: reports a pinned registry id that vanished from the live catalog, with checkedAt', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }] } }
  const registry = { opencode: { 'opencode/mimo-v2.5-free': { tier: 'free' } } }
  const drift = computeCatalogDrift({ discovery, map: {}, registry })
  assert.ok(drift.some((d) => d.type === 'vanished' && d.model === 'opencode/mimo-v2.5-free' && d.checkedAt === FRESH))
})

test('computeCatalogDrift: reports a pinned MODEL_REGISTRY/DELEGATION_MAP id that vanished, even if only referenced by the map', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }] } }
  const drift = computeCatalogDrift({ discovery, map: MAP, registry: { opencode: {} } })
  assert.ok(drift.some((d) => d.type === 'vanished' && d.model === 'opencode/nemotron-3-ultra-free'))
})

test('computeCatalogDrift: reports a registry tier:free model whose live cost is now > 0 (a money bug)', () => {
  const discovery = {
    opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/mimo-v2.5-free', cost: [{ input: 0.1, output: 0.1 }] }] },
  }
  const registry = { opencode: { 'opencode/mimo-v2.5-free': { tier: 'free' } } }
  const drift = computeCatalogDrift({ discovery, map: {}, registry })
  assert.ok(drift.some((d) => d.type === 'now_paid' && d.model === 'opencode/mimo-v2.5-free'))
})

test('computeCatalogDrift: reports a catalog free model absent from the registry', () => {
  const discovery = {
    opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/space-bunny-free', cost: [{ input: 0, output: 0 }] }] },
  }
  const drift = computeCatalogDrift({ discovery, map: {}, registry: { opencode: {} } })
  assert.ok(drift.some((d) => d.type === 'new_free' && d.model === 'opencode/space-bunny-free'))
})

test('computeCatalogDrift: reports a pinned registry variant no longer in the catalog variants[]', () => {
  const discovery = {
    opencode: {
      checkedAt: FRESH,
      error: null,
      models: [{ id: 'opencode/nemotron-3-ultra-free', cost: [{ input: 0, output: 0 }], variants: [] }],
    },
  }
  const registry = { opencode: { 'opencode/nemotron-3-ultra-free': { tier: 'free', variant: 'high' } } }
  const drift = computeCatalogDrift({ discovery, map: {}, registry })
  assert.ok(drift.some((d) => d.type === 'variant_unavailable' && d.model === 'opencode/nemotron-3-ultra-free' && d.variant === 'high'))
})

test('computeCatalogDrift: still reports drift for an hours-old row as long as it is the last good fetch (no TTL gate)', () => {
  const discovery = { opencode: { checkedAt: OLD, error: null, models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }] } }
  const registry = { opencode: { 'opencode/mimo-v2.5-free': { tier: 'free' } } }
  const drift = computeCatalogDrift({ discovery, map: {}, registry })
  assert.ok(drift.some((d) => d.type === 'vanished' && d.model === 'opencode/mimo-v2.5-free' && d.checkedAt === OLD))
})

test('computeCatalogDrift: returns nothing when the discovery row has empty models (no successful fetch yet)', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: null, models: [] } }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  assert.deepEqual(computeCatalogDrift({ discovery, map: {}, registry }), [])
})

test('computeCatalogDrift: returns nothing for an errored discovery row', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: 'model list timed out', models: [] } }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  assert.deepEqual(computeCatalogDrift({ discovery, map: {}, registry }), [])
})

test('computeCatalogDrift: returns nothing when there is no discovery row for the agent at all', () => {
  assert.deepEqual(computeCatalogDrift({ discovery: {}, map: {}, registry: { opencode: {} } }), [])
})

// --- validateVariant ---

const GOOD_DISCOVERY = {
  opencode: {
    checkedAt: OLD, // deliberately old -- validation must use isGoodCatalogRow semantics, not a TTL
    error: null,
    models: [{ id: 'opencode/nemotron-3-ultra-free', variants: [] }, { id: 'opencode/muse-spark-1.3-contributor-free', variants: [{ id: 'low' }, { id: 'medium' }] }],
  },
}

test('validateVariant: passes through unchanged when no variant is requested', () => {
  const result = validateVariant({ agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', variant: undefined, discovery: GOOD_DISCOVERY })
  assert.deepEqual(result, { model: 'opencode/muse-spark-1.3-contributor-free', variant: undefined, warning: null })
})

test('validateVariant: passes through unchanged when the requested variant IS in the catalog variants[]', () => {
  const result = validateVariant({ agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', variant: 'low', discovery: GOOD_DISCOVERY })
  assert.deepEqual(result, { model: 'opencode/muse-spark-1.3-contributor-free', variant: 'low', warning: null })
})

test('validateVariant: drops an unsupported variant and returns a warning, using the model default (bare model id)', () => {
  const result = validateVariant({ agent: 'opencode', model: 'opencode/nemotron-3-ultra-free', variant: 'high', discovery: GOOD_DISCOVERY })
  assert.equal(result.model, 'opencode/nemotron-3-ultra-free')
  assert.equal(result.variant, null)
  assert.match(result.warning, /nemotron-3-ultra-free/)
  assert.match(result.warning, /high/)
})

test('validateVariant: validates an explicit model#variant id the same way -- valid variant kept as-is', () => {
  const result = validateVariant({ agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free#low', variant: undefined, discovery: GOOD_DISCOVERY })
  assert.deepEqual(result, { model: 'opencode/muse-spark-1.3-contributor-free#low', variant: undefined, warning: null })
})

test('validateVariant: validates an explicit model#variant id the same way -- invalid variant stripped from the model id', () => {
  const result = validateVariant({ agent: 'opencode', model: 'opencode/nemotron-3-ultra-free#high', variant: undefined, discovery: GOOD_DISCOVERY })
  assert.equal(result.model, 'opencode/nemotron-3-ultra-free')
  assert.equal(result.variant, null)
  assert.match(result.warning, /high/)
})

test('validateVariant: an embedded model#variant wins over a separately-passed variant (matches buildArgv precedence)', () => {
  // opencode/nemotron-3-ultra-free has no variants at all: 'low' (embedded) is invalid.
  // If the separate 'medium' argument were used instead, this would incorrectly pass.
  const result = validateVariant({ agent: 'opencode', model: 'opencode/nemotron-3-ultra-free#low', variant: 'medium', discovery: GOOD_DISCOVERY })
  assert.equal(result.model, 'opencode/nemotron-3-ultra-free')
  assert.equal(result.variant, null)
  assert.match(result.warning, /low/)
})

test('validateVariant: keeps todays behavior (no warning) when the catalog does not list the model', () => {
  const result = validateVariant({ agent: 'opencode', model: 'opencode/unknown-model', variant: 'high', discovery: GOOD_DISCOVERY })
  assert.deepEqual(result, { model: 'opencode/unknown-model', variant: 'high', warning: null })
})

test('validateVariant: keeps todays behavior (no warning) when the discovery row has an error', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: 'model list timed out', models: [] } }
  const result = validateVariant({ agent: 'opencode', model: 'opencode/nemotron-3-ultra-free', variant: 'high', discovery })
  assert.deepEqual(result, { model: 'opencode/nemotron-3-ultra-free', variant: 'high', warning: null })
})

test('validateVariant: keeps todays behavior (no warning) when there is no discovery row for the agent at all', () => {
  const result = validateVariant({ agent: 'opencode', model: 'opencode/nemotron-3-ultra-free', variant: 'high', discovery: {} })
  assert.deepEqual(result, { model: 'opencode/nemotron-3-ultra-free', variant: 'high', warning: null })
})
