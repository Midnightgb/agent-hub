import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-successors-'))
}

const paid = [{ input: 0.15, output: 0.6 }]
const free = [{ input: 0, output: 0 }]

function opencodeRow(models, extra = {}) {
  return { agent: 'opencode', cmd: 'opencode', binPath: '/bin/opencode', version: '1', models, checkedAt: new Date().toISOString(), error: null, ...extra }
}

const DEEPSEEK_CATALOG = [
  { id: 'deepseek/deepseek-flash', cost: paid },
  { id: 'opencode/deepseek-v4.1-flash', cost: paid },
  { id: 'opencode-go/deepseek-v4.1-flash', cost: paid },
  { id: 'opencode/deepseek-v4.1-flash-free', cost: free },
  { id: 'deepseek/deepseek-v4-pro', cost: paid },
]

function writeDiscovery(home, discovery) {
  fs.writeFileSync(path.join(home, 'discovery.json'), JSON.stringify(discovery))
}

async function freshModule(home, rel) {
  process.env.AGENT_HUB_HOME = home
  return import(`../src/${rel}?t=${Date.now()}${Math.random()}`)
}

test('findSuccessor maps a vanished pinned id to its newest same-family model, preferring opencode-go', async () => {
  const { findSuccessor } = await freshModule(tmpHome(), 'model-successors.mjs')
  const discovery = { opencode: opencodeRow(DEEPSEEK_CATALOG) }
  const successor = findSuccessor({ agent: 'opencode', model: 'deepseek/deepseek-v4-flash', discovery, registry: {} })
  assert.equal(successor, 'opencode-go/deepseek-v4.1-flash')
})

test('findSuccessor returns null when the pinned model is still listed', async () => {
  const { findSuccessor } = await freshModule(tmpHome(), 'model-successors.mjs')
  const discovery = { opencode: opencodeRow(DEEPSEEK_CATALOG) }
  assert.equal(findSuccessor({ agent: 'opencode', model: 'deepseek/deepseek-v4-pro', discovery, registry: {} }), null)
})

test('findSuccessor never substitutes without a good catalog (errored or empty discovery row)', async () => {
  const { findSuccessor } = await freshModule(tmpHome(), 'model-successors.mjs')
  for (const row of [opencodeRow(DEEPSEEK_CATALOG, { error: 'model list timed out' }), opencodeRow([]), undefined]) {
    assert.equal(findSuccessor({ agent: 'opencode', model: 'deepseek/deepseek-v4-flash', discovery: { opencode: row }, registry: {} }), null)
  }
})

test('findSuccessor never turns a free model into a paid one', async () => {
  const { findSuccessor } = await freshModule(tmpHome(), 'model-successors.mjs')
  const discovery = { opencode: opencodeRow([{ id: 'opencode/acme-2-mini', cost: paid }]) }
  const registry = { opencode: { 'opencode/acme-1-mini': { tier: 'free' } } }
  assert.equal(findSuccessor({ agent: 'opencode', model: 'opencode/acme-1-mini', discovery, registry }), null)
})

test('findSuccessor works for gentle-shell and agy catalogs (no cost data)', async () => {
  const { findSuccessor } = await freshModule(tmpHome(), 'model-successors.mjs')
  const discovery = {
    'gentle-shell': { models: [{ id: 'anthropic/claude-sonnet-5' }, { id: 'anthropic/claude-sonnet-5-5' }], checkedAt: 'x', error: null },
    agy: { models: [{ id: 'gemini-3.9-flash-low' }, { id: 'gemini-3.9-flash-high' }], checkedAt: 'x', error: null },
  }
  assert.equal(findSuccessor({ agent: 'gentle-shell', model: 'anthropic/claude-sonnet-4-6', discovery, registry: {} }), 'anthropic/claude-sonnet-5-5')
  assert.equal(findSuccessor({ agent: 'agy', model: 'gemini-3.8-flash-low', discovery, registry: {} }), 'gemini-3.9-flash-low')
})

// Since the opencode model policy (#135), opencode DELEGATION_MAP steps are
// pool steps (`@free`/`@go`); the route() cases below use agy pins, which
// are still concrete ids.
function agyRow(models) {
  return { agent: 'agy', models: models.map((id) => ({ id })), checkedAt: new Date().toISOString(), error: null }
}

test('route() auto-substitutes a vanished chain model with its discovered successor and logs one event', async () => {
  const home = tmpHome()
  writeDiscovery(home, { agy: agyRow(['gemini-3.9-flash-low', 'gemini-3.9-flash-high']) })
  const { route } = await freshModule(home, 'router.mjs')

  const first = await route({ taskType: 'recon' })
  const second = await route({ taskType: 'recon' })

  const all = [first.primary, ...first.fallbacks]
  const agy = all.find((c) => c.agent === 'agy')
  assert.equal(agy.model, 'gemini-3.9-flash-low')
  assert.equal(agy.substitutedFrom, 'gemini-3.8-flash-low')
  assert.ok(!all.some((c) => c.model === 'gemini-3.8-flash-low'))
  assert.deepEqual(first.substitutions, [{ agent: 'agy', from: 'gemini-3.8-flash-low', to: 'gemini-3.9-flash-low' }])
  assert.deepEqual(second.substitutions, first.substitutions)

  const events = fs
    .readFileSync(path.join(home, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.phase === 'substitution')
  assert.equal(events.length, 1, 'the substitution is logged once, not on every route() call')
  assert.equal(events[0].model, 'gemini-3.9-flash-low')
  assert.equal(events[0].from, 'gemini-3.8-flash-low')
})

test('route() keeps the pinned model when discovery has no catalog for its agent', async () => {
  const home = tmpHome()
  const { route } = await freshModule(home, 'router.mjs')
  const result = await route({ taskType: 'recon' })
  const all = [result.primary, ...result.fallbacks]
  assert.ok(all.some((c) => c.agent === 'agy' && c.model === 'gemini-3.8-flash-low'))
  assert.deepEqual(result.substitutions, [])
})

test('route() honors a hold on a vanished pinned id: skipped as held, never substituted', async () => {
  const home = tmpHome()
  writeDiscovery(home, { agy: agyRow(['gemini-3.9-flash-low']) })
  const { setOverride, overrideKey } = await freshModule(home, 'overrides.mjs')
  setOverride(overrideKey('agy', 'gemini-3.8-flash-low'), { hold: true, reason: 'manual' }, { ...process.env, AGENT_HUB_HOME: home })
  const { route } = await freshModule(home, 'router.mjs')

  const result = await route({ taskType: 'recon' })
  const all = [result.primary, ...result.fallbacks].filter(Boolean)
  assert.ok(!all.some((c) => c.agent === 'agy' && c.model === 'gemini-3.9-flash-low'), 'the substitute never takes the held slot')
  assert.ok(!all.some((c) => c.agent === 'agy' && c.model === 'gemini-3.8-flash-low'))
  assert.ok(result.skipped.some((s) => s.agent === 'agy' && s.model === 'gemini-3.8-flash-low' && s.reason === 'held'))
  assert.deepEqual(result.substitutions, [])
})

test('findSuccessor never picks a dated snapshot id over a non-dated newer version', async () => {
  const { findSuccessor } = await freshModule(tmpHome(), 'model-successors.mjs')
  const row = (ids) => ({ models: ids.map((id) => ({ id })), checkedAt: 'x', error: null })
  const pinned = { agent: 'gentle-shell', model: 'anthropic/claude-sonnet-4-5', registry: {} }
  assert.equal(
    findSuccessor({ ...pinned, discovery: { 'gentle-shell': row(['anthropic/claude-sonnet-4-20250514', 'anthropic/claude-sonnet-4-6']) } }),
    'anthropic/claude-sonnet-4-6'
  )
  assert.equal(findSuccessor({ ...pinned, discovery: { 'gentle-shell': row(['anthropic/claude-sonnet-4-20250514']) } }), null)
})

test('substituteChain leaves pool steps (@free, @go) untouched', async () => {
  const { substituteChain } = await freshModule(tmpHome(), 'model-successors.mjs')
  const discovery = { opencode: opencodeRow([...DEEPSEEK_CATALOG, { id: 'opencode/free-1', cost: free }, { id: 'opencode/go-2', cost: paid }]) }
  const chain = [
    { agent: 'opencode', model: '@free', mode: 'read' },
    { agent: 'opencode', model: '@go', mode: 'read' },
  ]
  const { chain: out, substitutions } = substituteChain(chain, { discovery, registry: {} })
  assert.deepEqual(out, chain)
  assert.deepEqual(substitutions, [])
})

test('agents_status lists every discovered opencode/agy/gentle-shell model and points stale pins at their successor', async () => {
  const home = tmpHome()
  writeDiscovery(home, {
    opencode: opencodeRow(DEEPSEEK_CATALOG),
    agy: { agent: 'agy', models: [{ id: 'gemini-3.8-flash-low' }, { id: 'gemini-3.9-flash-high' }], checkedAt: new Date().toISOString(), error: null },
    'gentle-shell': { agent: 'gentle-shell', models: [{ id: 'anthropic/claude-sonnet-5' }], checkedAt: new Date().toISOString(), error: null },
    copilot: { agent: 'copilot', models: [{ id: 'gpt-9' }], checkedAt: new Date().toISOString(), error: null },
  })
  const { agentsStatusTool } = await freshModule(home, 'tools/agents.mjs')
  const runner = async (cmd, args) => (args[0] === '--version' ? { stdout: 'v1', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 })

  const rows = await agentsStatusTool({ cwd: '/tmp', env: { AGENT_HUB_HOME: home }, commandRunner: runner })
  const byKey = new Map(rows.map((r) => [`${r.agent}:${r.model}`, r]))

  const discovered = byKey.get('gentle-shell:anthropic/claude-sonnet-5')
  assert.ok(discovered, 'a discovered-only model is listed')
  assert.equal(discovered.status, 'ready')
  assert.equal(discovered.source, 'discovery')
  // A free opencode model is listed (the @free pool expands to it).
  assert.equal(byKey.get('opencode:opencode/deepseek-v4.1-flash-free').tier, 'free')
  assert.ok(!byKey.has('opencode:opencode-go/deepseek-v4.1-flash'), 'a model the opencode policy blocks by default is not listed')
  assert.ok(!byKey.has('copilot:gpt-9'), 'copilot catalog is not authoritative, so it is not listed')

  const stale = byKey.get('agy:gemini-3.8-flash-high')
  assert.equal(stale.status, 'unavailable')
  assert.equal(stale.successor, 'gemini-3.9-flash-high')

  const pinned = byKey.get('agy:gemini-3.8-flash-low')
  assert.notEqual(pinned.source, 'discovery', 'a pinned pair keeps its preflight row, not a duplicate discovery row')
  assert.equal(rows.filter((r) => r.agent === 'agy' && r.model === 'gemini-3.8-flash-low').length, 1)
})
