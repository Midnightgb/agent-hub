import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// opencode-model-policy T1 (S1, S4): the user decides which opencode models
// agent-hub may use; undecided free models are allowed, Go/paid are blocked.

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-model-policy-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/model-policy.mjs?t=' + Date.now() + Math.random())
}

const FREE = [{ input: 0, output: 0 }]
const PAID = [{ input: 1, output: 2 }]

function discovery(models) {
  return { opencode: { checkedAt: new Date().toISOString(), error: null, models } }
}

const CATALOG = discovery([
  { id: 'opencode/mimo-v2.6-flash-free', cost: FREE },
  { id: 'opencode/glm-5.3-flash-free', cost: FREE },
  { id: 'opencode-go/glm-5.3', cost: PAID },
  { id: 'opencode-go/beam-free', cost: FREE },
  { id: 'opencode-go/kimi-k3', cost: PAID },
  { id: 'opencode/claude-sonnet-5-5', cost: PAID },
  { id: 'deepseek/deepseek-flash', cost: PAID },
])

test('modelPool classifies by catalog cost and the opencode-go/ provider', async () => {
  const { modelPool } = await fresh(tmpHome())
  assert.equal(modelPool({ id: 'opencode/mimo-v2.6-flash-free', cost: FREE }), 'free')
  assert.equal(modelPool({ id: 'opencode-go/beam-free', cost: FREE }), 'free', 'a zero-cost Go model is free')
  assert.equal(modelPool({ id: 'opencode-go/glm-5.3', cost: PAID }), 'go')
  assert.equal(modelPool({ id: 'opencode-go/glm-5.3' }), 'go', 'Go without pricing is still Go')
  assert.equal(modelPool({ id: 'opencode/claude-sonnet-5-5', cost: PAID }), 'paid')
  assert.equal(modelPool({ id: 'opencode/no-pricing' }), 'unknown')
  assert.equal(modelPool(null), 'unknown')
})

test('S4: undecided models default to allowed when free, blocked when Go, paid or unlisted', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { modelDecision } = await fresh(home)
  const d = (model) => modelDecision({ agent: 'opencode', model, env, discovery: CATALOG })
  assert.deepEqual(d('opencode/mimo-v2.6-flash-free'), { allowed: true, source: 'default', pool: 'free' })
  assert.deepEqual(d('opencode-go/glm-5.3'), { allowed: false, source: 'default', pool: 'go' })
  assert.deepEqual(d('opencode/claude-sonnet-5-5'), { allowed: false, source: 'default', pool: 'paid' })
  assert.deepEqual(d('opencode/gone-free'), { allowed: false, source: 'default', pool: 'unknown' }, 'a model the catalog does not list fails closed')
})

test('S1: a user decision overrides the default and persists in model-policy.json', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { modelDecision, setModelDecision } = await fresh(home)
  setModelDecision({ agent: 'opencode', model: 'opencode-go/glm-5.3', allowed: true, env })
  setModelDecision({ agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free', allowed: false, env })

  assert.deepEqual(modelDecision({ agent: 'opencode', model: 'opencode-go/glm-5.3', env, discovery: CATALOG }), { allowed: true, source: 'user', pool: 'go' })
  assert.deepEqual(modelDecision({ agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free', env, discovery: CATALOG }), { allowed: false, source: 'user', pool: 'free' })

  const stored = JSON.parse(fs.readFileSync(path.join(home, 'model-policy.json'), 'utf8'))
  assert.equal(stored.opencode.decisions['opencode-go/glm-5.3'].allowed, true)
  assert.equal(typeof stored.opencode.decisions['opencode-go/glm-5.3'].decidedAt, 'string')
  assert.equal(stored.opencode.decisions['opencode/mimo-v2.6-flash-free'].allowed, false)
})

test('A2: an explicitly allowed model stays allowed when the catalog is unavailable', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { modelDecision, setModelDecision } = await fresh(home)
  setModelDecision({ agent: 'opencode', model: 'opencode-go/glm-5.3', allowed: true, env })
  const noCatalog = { opencode: { error: 'L0 --version check failed', models: [] } }
  assert.equal(modelDecision({ agent: 'opencode', model: 'opencode-go/glm-5.3', env, discovery: noCatalog }).allowed, true)
  assert.equal(modelDecision({ agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free', env, discovery: noCatalog }).allowed, false)
})

test('A3: agents other than opencode are never restricted by the policy', async () => {
  const home = tmpHome()
  const { modelDecision } = await fresh(home)
  assert.deepEqual(modelDecision({ agent: 'agy', model: 'gemini-3.8-flash-high', env: { AGENT_HUB_HOME: home }, discovery: {} }), { allowed: true, source: 'not_applicable', pool: null })
})

test('S2: expandPool returns allowed listed models of one pool, user order first, at most `limit`', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { expandPool, setModelDecision, setModelOrder } = await fresh(home)

  // Defaults: the free pool is every zero-cost model, alphabetically.
  assert.deepEqual(expandPool({ agent: 'opencode', pool: 'free', env, discovery: CATALOG, limit: 5 }), [
    'opencode-go/beam-free',
    'opencode/glm-5.3-flash-free',
    'opencode/mimo-v2.6-flash-free',
  ])
  // Go models are blocked until enabled.
  assert.deepEqual(expandPool({ agent: 'opencode', pool: 'go', env, discovery: CATALOG }), [])

  setModelDecision({ agent: 'opencode', model: 'opencode-go/glm-5.3', allowed: true, env })
  setModelDecision({ agent: 'opencode', model: 'opencode-go/kimi-k3', allowed: true, env })
  setModelDecision({ agent: 'opencode', model: 'opencode-go/beam-free', allowed: false, env })
  setModelOrder({ agent: 'opencode', order: ['opencode-go/kimi-k3', 'opencode/mimo-v2.6-flash-free'], env })

  assert.deepEqual(expandPool({ agent: 'opencode', pool: 'go', env, discovery: CATALOG }), ['opencode-go/kimi-k3', 'opencode-go/glm-5.3'])
  assert.deepEqual(expandPool({ agent: 'opencode', pool: 'free', env, discovery: CATALOG }), ['opencode/mimo-v2.6-flash-free', 'opencode/glm-5.3-flash-free'], 'default limit is 2')
})

test('S2: expandPool skips an allowed model the catalog no longer lists', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { expandPool, setModelDecision } = await fresh(home)
  setModelDecision({ agent: 'opencode', model: 'opencode-go/vanished', allowed: true, env })
  setModelDecision({ agent: 'opencode', model: 'opencode-go/glm-5.3', allowed: true, env })
  assert.deepEqual(expandPool({ agent: 'opencode', pool: 'go', env, discovery: CATALOG }), ['opencode-go/glm-5.3'])
})

test('S1: policyView lists every catalog model with pool, decision and a new marker, in policy order', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { policyView, setModelDecision, setModelOrder } = await fresh(home)
  setModelDecision({ agent: 'opencode', model: 'opencode-go/glm-5.3', allowed: true, env })
  setModelOrder({ agent: 'opencode', order: ['opencode-go/glm-5.3'], env })

  const view = policyView({ agent: 'opencode', env, discovery: CATALOG })
  assert.equal(view.catalogAvailable, true)
  assert.equal(view.models.length, 7)
  assert.deepEqual(view.models[0], { id: 'opencode-go/glm-5.3', pool: 'go', allowed: true, source: 'user', isNew: false })
  const mimo = view.models.find((m) => m.id === 'opencode/mimo-v2.6-flash-free')
  assert.deepEqual(mimo, { id: 'opencode/mimo-v2.6-flash-free', pool: 'free', allowed: true, source: 'default', isNew: true })
})

test('setModelDecision rejects a non-boolean allowed and an empty model', async () => {
  const home = tmpHome()
  const { setModelDecision } = await fresh(home)
  const env = { AGENT_HUB_HOME: home }
  assert.throws(() => setModelDecision({ agent: 'opencode', model: 'x', allowed: 'yes', env }), /allowed must be a boolean/)
  assert.throws(() => setModelDecision({ agent: 'opencode', model: '', allowed: true, env }), /model is required/)
})
