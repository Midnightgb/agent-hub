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

test('route() auto-substitutes a vanished chain model with its discovered successor and logs one event', async () => {
  const home = tmpHome()
  writeDiscovery(home, { opencode: opencodeRow(DEEPSEEK_CATALOG) })
  const { route } = await freshModule(home, 'router.mjs')

  const first = await route({ taskType: 'mechanical-edit' })
  const second = await route({ taskType: 'mechanical-edit' })

  const all = [first.primary, ...first.fallbacks]
  const deepseek = all.find((c) => c.agent === 'opencode')
  assert.equal(deepseek.model, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(deepseek.substitutedFrom, 'deepseek/deepseek-v4-flash')
  assert.ok(!all.some((c) => c.model === 'deepseek/deepseek-v4-flash'))
  assert.deepEqual(first.substitutions, [{ agent: 'opencode', from: 'deepseek/deepseek-v4-flash', to: 'opencode-go/deepseek-v4.1-flash' }])
  assert.deepEqual(second.substitutions, first.substitutions)

  const events = fs
    .readFileSync(path.join(home, 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.phase === 'substitution')
  assert.equal(events.length, 1, 'the substitution is logged once, not on every route() call')
  assert.equal(events[0].model, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(events[0].from, 'deepseek/deepseek-v4-flash')
})

test('route() keeps the pinned model when discovery has no catalog for its agent', async () => {
  const home = tmpHome()
  const { route } = await freshModule(home, 'router.mjs')
  const result = await route({ taskType: 'mechanical-edit' })
  const all = [result.primary, ...result.fallbacks]
  assert.ok(all.some((c) => c.model === 'deepseek/deepseek-v4-flash'))
  assert.deepEqual(result.substitutions, [])
})

test('agents_status lists every discovered opencode/agy/gentle-shell model and points stale pins at their successor', async () => {
  const home = tmpHome()
  writeDiscovery(home, {
    opencode: opencodeRow(DEEPSEEK_CATALOG),
    agy: { agent: 'agy', models: [{ id: 'gemini-3.8-flash-low' }], checkedAt: new Date().toISOString(), error: null },
    'gentle-shell': { agent: 'gentle-shell', models: [{ id: 'anthropic/claude-sonnet-5' }], checkedAt: new Date().toISOString(), error: null },
    copilot: { agent: 'copilot', models: [{ id: 'gpt-9' }], checkedAt: new Date().toISOString(), error: null },
  })
  const { agentsStatusTool } = await freshModule(home, 'tools/agents.mjs')
  const runner = async (cmd, args) => (args[0] === '--version' ? { stdout: 'v1', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 0 })

  const rows = await agentsStatusTool({ cwd: '/tmp', env: { AGENT_HUB_HOME: home }, commandRunner: runner })
  const byKey = new Map(rows.map((r) => [`${r.agent}:${r.model}`, r]))

  const discovered = byKey.get('opencode:opencode-go/deepseek-v4.1-flash')
  assert.ok(discovered, 'a discovered-only model is listed')
  assert.equal(discovered.status, 'ready')
  assert.equal(discovered.source, 'discovery')
  assert.equal(discovered.tier, 'paid')
  assert.ok(byKey.has('gentle-shell:anthropic/claude-sonnet-5'))
  assert.equal(byKey.get('opencode:opencode/deepseek-v4.1-flash-free').tier, 'free')
  assert.ok(!byKey.has('copilot:gpt-9'), 'copilot catalog is not authoritative, so it is not listed')

  const stale = byKey.get('opencode:deepseek/deepseek-v4-flash')
  assert.equal(stale.status, 'unavailable')
  assert.equal(stale.successor, 'opencode-go/deepseek-v4.1-flash')

  const pinned = byKey.get('agy:gemini-3.8-flash-low')
  assert.notEqual(pinned.source, 'discovery', 'a pinned pair keeps its preflight row, not a duplicate discovery row')
  assert.equal(rows.filter((r) => r.agent === 'agy' && r.model === 'gemini-3.8-flash-low').length, 1)
})
