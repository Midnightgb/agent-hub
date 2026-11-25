import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// opencode-model-policy T2 (S2): opencode chain steps name a pool; route()
// expands it to the allowed models the live catalog lists.

const FREE = [{ input: 0, output: 0 }]
const PAID = [{ input: 1, output: 2 }]

function homeWithCatalog(models) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-router-policy-'))
  const row = { binPath: '/bin/opencode', version: '2.1.3', checkedAt: new Date().toISOString(), error: null, models }
  fs.writeFileSync(path.join(home, 'discovery.json'), JSON.stringify({ opencode: row }))
  return home
}

const CATALOG = [
  { id: 'opencode/mimo-v2.6-flash-free', cost: FREE },
  { id: 'opencode/glm-5.3-flash-free', cost: FREE },
  { id: 'opencode/nemotron-3.5-super-vl-free', cost: FREE },
  { id: 'opencode-go/glm-5.3', cost: PAID },
  { id: 'opencode-go/kimi-k3', cost: PAID },
]

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const router = await import('../src/router.mjs?t=' + tag)
  const policy = await import('../src/model-policy.mjs?t=' + tag)
  return { ...router, ...policy }
}

const opencodeSteps = (chain) => chain.filter((c) => c.agent === 'opencode')
const pick = ({ agent, model, mode, pool }) => ({ agent, model, mode, pool })

test('A1: every opencode step in DELEGATION_MAP names a pool, never a model id', async () => {
  const { DELEGATION_MAP } = await fresh(homeWithCatalog(CATALOG))
  const models = Object.values(DELEGATION_MAP).flatMap((e) => opencodeSteps(e.chain).map((c) => c.model))
  assert.ok(models.length > 0)
  for (const model of models) assert.match(model, /^@(free|go)$/)
  assert.deepEqual(opencodeSteps(DELEGATION_MAP.recon.chain).map((c) => c.model), ['@free'])
  assert.deepEqual(opencodeSteps(DELEGATION_MAP['call-chain-trace'].chain).map((c) => c.model), ['@free', '@go'])
  assert.deepEqual(opencodeSteps(DELEGATION_MAP['mechanical-edit'].chain).map((c) => ({ model: c.model, mode: c.mode })), [{ model: '@go', mode: 'write' }])
})

test('S2: route expands @free to allowed catalog models in policy order, keeping the step mode', async () => {
  const home = homeWithCatalog(CATALOG)
  const env = { AGENT_HUB_HOME: home }
  const { route, setModelOrder } = await fresh(home)
  setModelOrder({ agent: 'opencode', order: ['opencode/nemotron-3.5-super-vl-free'], env })

  const result = await route({ taskType: 'research', env })
  assert.deepEqual(pick(result.primary), { agent: 'opencode', model: 'opencode/nemotron-3.5-super-vl-free', mode: 'read', pool: 'free' })
  assert.deepEqual(result.fallbacks.map((c) => `${c.agent}:${c.model}`), ['opencode:opencode/glm-5.3-flash-free', 'agy:gemini-3.8-flash-medium'])
  assert.equal(result.skipped.length, 0)
})

test('S2 (A1 rejected for call-chain-trace): route tries the free pool before the go pool', async () => {
  const home = homeWithCatalog(CATALOG)
  const env = { AGENT_HUB_HOME: home }
  const { route, setModelDecision } = await fresh(home)
  setModelDecision({ agent: 'opencode', model: 'opencode-go/kimi-k3', allowed: true, env })
  const result = await route({ taskType: 'call-chain-trace', env })
  const pools = [result.primary, ...result.fallbacks].filter((c) => c.agent === 'opencode').map((c) => c.pool)
  assert.deepEqual(pools, ['free', 'free', 'go'])
})

test('S2/S4: a pool with no allowed model is skipped as pool_empty and the chain falls through', async () => {
  const home = homeWithCatalog(CATALOG)
  const env = { AGENT_HUB_HOME: home }
  const { route } = await fresh(home)
  const result = await route({ taskType: 'mechanical-edit', env })
  assert.deepEqual(result.skipped.find((s) => s.agent === 'opencode'), { agent: 'opencode', model: '@go', reason: 'pool_empty' })
  assert.ok(result.fallbacks.every((c) => c.agent !== 'opencode'))
  assert.equal(result.primary.agent, 'agy')
})

test('S1/S2: a Go model the user allowed is routed in write mode; a blocked free model never is', async () => {
  const home = homeWithCatalog(CATALOG)
  const env = { AGENT_HUB_HOME: home }
  const { route, setModelDecision } = await fresh(home)
  setModelDecision({ agent: 'opencode', model: 'opencode-go/kimi-k3', allowed: true, env })
  setModelDecision({ agent: 'opencode', model: 'opencode/mimo-v2.6-flash-free', allowed: false, env })

  const edit = await route({ taskType: 'mechanical-edit', env })
  assert.deepEqual(pick(edit.fallbacks[0]), { agent: 'opencode', model: 'opencode-go/kimi-k3', mode: 'write', pool: 'go' })

  const recon = await route({ taskType: 'recon', env })
  const all = [recon.primary, ...recon.fallbacks].map((c) => c.model)
  assert.equal(all.includes('opencode/mimo-v2.6-flash-free'), false)
})

test('S2: without an opencode catalog every pool is empty and routing still answers', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-router-policy-'))
  const env = { AGENT_HUB_HOME: home }
  const { route } = await fresh(home)
  const result = await route({ taskType: 'triage', env })
  assert.deepEqual(result.skipped.find((s) => s.agent === 'opencode'), { agent: 'opencode', model: '@free', reason: 'pool_empty' })
  assert.equal(result.primary.agent, 'copilot')
})

test('S2: agents_status checks the expanded models, never a pool placeholder', async () => {
  const home = homeWithCatalog(CATALOG)
  process.env.AGENT_HUB_HOME = home
  const { defaultPairs } = await import('../src/tools/agents.mjs?t=' + Date.now() + Math.random())
  const opencode = defaultPairs({ env: { AGENT_HUB_HOME: home } }).filter((p) => p.agent === 'opencode').map((p) => p.model)
  assert.equal(opencode.some((m) => m.startsWith('@')), false)
  assert.deepEqual(opencode.sort(), ['opencode/glm-5.3-flash-free', 'opencode/mimo-v2.6-flash-free'])
})

test('S2: catalog drift never reports a pool placeholder as a vanished model', async () => {
  const home = homeWithCatalog(CATALOG)
  const { DELEGATION_MAP } = await fresh(home)
  const { computeCatalogDrift } = await import('../src/catalog.mjs?t=' + Date.now())
  const discovery = JSON.parse(fs.readFileSync(path.join(home, 'discovery.json'), 'utf8'))
  const drift = computeCatalogDrift({ discovery, map: DELEGATION_MAP, registry: {} })
  assert.equal(drift.some((d) => String(d.model ?? d.id ?? '').startsWith('@')), false)
})

test('verifier B2: reorder proposals aggregate the metrics of the concrete models behind a pool step', async () => {
  const home = homeWithCatalog(CATALOG)
  const { DELEGATION_MAP } = await fresh(home)
  const { computeProposals } = await import('../src/proposals.mjs?t=' + Date.now())
  const poolOfModel = (agent, model) => (agent === 'opencode' ? (model.endsWith('-free') ? 'free' : 'go') : null)
  const row = (agent, model, succeeded, samples) => ({ agent, model, mode: 'read', taskType: 'triage', samples, succeeded, successRate: succeeded / samples })
  const metrics = {
    rows: [
      row('opencode', 'opencode/mimo-v2.6-flash-free', 5, 30),
      row('opencode', 'opencode/glm-5.3-flash-free', 5, 30),
      row('copilot', 'auto', 60, 60),
    ],
  }
  const proposals = computeProposals({ metrics, map: { triage: DELEGATION_MAP.triage }, poolOfModel })
  assert.equal(proposals.length, 1)
  assert.deepEqual(proposals[0].toOrder[0], { agent: 'copilot', model: 'auto' })
  assert.equal(proposals[0].evidence['opencode:@free'].samples, 60)
})
