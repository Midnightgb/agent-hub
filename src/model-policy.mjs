import fs from 'node:fs'
import { paths } from './config.mjs'
import { updateJsonLocked } from './fsutil.mjs'
import { catalogTier } from './catalog.mjs'

/**
 * Which opencode models agent-hub may use. opencode's catalog churns every
 * few weeks (free models are renamed or retired), so chains name a pool
 * (`@free`, `@go`) instead of a model id and the user decides, from the
 * dashboard, which catalog models are allowed and in what order.
 *
 * Schema (model-policy.json, written by the dashboard and read by the MCP
 * process, so every write goes through updateJsonLocked):
 *   { "opencode": { "decisions": { "<model id>": { "allowed": bool, "decidedAt": "ISO" } },
 *                   "order": ["<model id>", ...] } }
 *
 * A model without a decision follows the default: allowed when the catalog
 * prices it at zero, blocked otherwise (Go, paid, or not listed at all).
 */

export const POLICY_AGENTS = Object.freeze(['opencode'])
export const POOLS = Object.freeze(['free', 'go'])

/**
 * Agents that are not policy agents themselves but run some models on a
 * policy agent's quota: gentle-shell (pi) with an `opencode-go/*` model
 * spends the same opencode Go subscription (quota/mapping.mjs), so the
 * opencode decision for that model id governs it too.
 */
const SHARED_QUOTA_MODELS = Object.freeze({
  'gentle-shell': Object.freeze({ policyAgent: 'opencode', prefix: 'opencode-go/' }),
})

/** The policy agent whose decisions govern agent:model, or null when the policy does not cover it. */
export function policyAgentFor(agent, model) {
  if (POLICY_AGENTS.includes(agent)) return agent
  const shared = SHARED_QUOTA_MODELS[agent]
  if (shared && typeof model === 'string' && model.startsWith(shared.prefix)) return shared.policyAgent
  return null
}
export const DEFAULT_POOL_LIMIT = 2

/** A chain step model that names a pool instead of a model id. */
export function isPoolModel(model) {
  return typeof model === 'string' && model.startsWith('@')
}

export function poolOf(model) {
  return isPoolModel(model) ? model.slice(1) : null
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** discovery.json read directly: discovery.mjs imports the router, which imports this module. */
function readDiscoveryFile(env) {
  return readJson(paths(env).discoveryFile)
}

export function readModelPolicy(env = process.env) {
  return readJson(paths(env).modelPolicyFile)
}

function agentPolicy(policy, agent) {
  const entry = policy?.[agent] ?? {}
  return {
    decisions: entry.decisions && typeof entry.decisions === 'object' ? entry.decisions : {},
    order: Array.isArray(entry.order) ? entry.order.filter((id) => typeof id === 'string') : [],
  }
}

function catalogModels(discovery, agent) {
  const row = discovery?.[agent]
  if (!row || row.error || !Array.isArray(row.models)) return []
  return row.models.filter((m) => m && typeof m.id === 'string')
}

/**
 * 'free' when the catalog prices the model at zero, 'go' for an
 * opencode-go/ model with a price or no price data (the Go subscription),
 * 'paid' for any other priced model, 'unknown' otherwise.
 */
export function modelPool(entry) {
  if (!entry || typeof entry.id !== 'string') return 'unknown'
  const tier = catalogTier(entry)
  if (tier === 'free') return 'free'
  if (entry.id.startsWith('opencode-go/')) return 'go'
  if (tier === 'paid') return 'paid'
  return 'unknown'
}

/**
 * { allowed, source, pool } for one agent:model. source is 'user' (a
 * dashboard decision), 'default' (S4 rule) or 'not_applicable' (an
 * agent:model the policy does not cover, always allowed). A model that runs on
 * a policy agent's quota (policyAgentFor) is judged by that agent's catalog
 * and decisions.
 */
export function modelDecision({ agent, model, env = process.env, discovery = readDiscoveryFile(env), policy = readModelPolicy(env) }) {
  const policyAgent = policyAgentFor(agent, model)
  if (!policyAgent) return { allowed: true, source: 'not_applicable', pool: null }
  // A `model#variant` id (opencode reasoning variants) is judged by its base model.
  const base = typeof model === 'string' ? model.split('#')[0] : model
  const entry = catalogModels(discovery, policyAgent).find((m) => m.id === base) ?? null
  const pool = entry ? modelPool(entry) : 'unknown'
  const decision = agentPolicy(policy, policyAgent).decisions[base]
  if (typeof decision?.allowed === 'boolean') return { allowed: decision.allowed, source: 'user', pool }
  return { allowed: pool === 'free', source: 'default', pool }
}

/**
 * Throw (code 'model_blocked') when the policy does not allow agent:model.
 * startJob calls this before any job record or process exists, so every path
 * that launches a model (delegate, plans, assignments, replies) is covered.
 */
export function assertModelAllowed({ agent, model, env = process.env, discovery = readDiscoveryFile(env), policy = readModelPolicy(env) }) {
  const { allowed, source, pool } = modelDecision({ agent, model, env, discovery, policy })
  if (allowed) return
  const why = source === 'user' ? 'blocked in the dashboard' : pool === 'unknown' ? 'not listed by the current catalog' : `${pool} models are blocked until allowed`
  const error = new Error(
    `${agent} model "${model}" is blocked by the model policy (${why}); allow it in the dashboard (Agents → ${policyAgentFor(agent, model)}) or use an allowed model`
  )
  error.code = 'model_blocked'
  throw error
}

/** Sort ids by their position in `order`, then alphabetically. */
function byPolicyOrder(order) {
  const rank = new Map(order.map((id, i) => [id, i]))
  return (a, b) => {
    const ra = rank.has(a) ? rank.get(a) : Infinity
    const rb = rank.has(b) ? rank.get(b) : Infinity
    if (ra !== rb) return ra - rb
    return a < b ? -1 : a > b ? 1 : 0
  }
}

/**
 * The allowed models of `pool` that the current catalog lists, in policy
 * order, at most `limit`. A model the catalog no longer lists is skipped.
 */
export function expandPool({ agent, pool, env = process.env, discovery = readDiscoveryFile(env), policy = readModelPolicy(env), limit = DEFAULT_POOL_LIMIT }) {
  const { order } = agentPolicy(policy, agent)
  return catalogModels(discovery, agent)
    .filter((m) => modelPool(m) === pool)
    .map((m) => m.id)
    .filter((id) => modelDecision({ agent, model: id, env, discovery, policy }).allowed)
    .sort(byPolicyOrder(order))
    .slice(0, limit)
}

/**
 * Replace every pool step of `chain` (`{agent, model: '@free'}`) with one
 * concrete step per allowed model (`{...step, model, pool}`). A pool with no
 * allowed listed model is dropped and reported in `emptyPools` as
 * `{agent, model: '@pool', reason: 'pool_empty'}`. A concrete step of a
 * policy agent that is not allowed (e.g. appended by an accepted proposal) is
 * dropped as `reason: 'model_blocked'`. A model already in the chain is not
 * repeated. Other steps are returned unchanged.
 */
export function expandChain(chain, { env = process.env, discovery = readDiscoveryFile(env), policy = readModelPolicy(env) } = {}) {
  if (!chain.some((step) => policyAgentFor(step?.agent, step?.model))) return { chain, emptyPools: [] }
  const out = []
  const emptyPools = []
  const seen = new Set()
  for (const step of chain) {
    if (!isPoolModel(step?.model)) {
      if (policyAgentFor(step.agent, step.model) && !modelDecision({ agent: step.agent, model: step.model, env, discovery, policy }).allowed) {
        emptyPools.push({ agent: step.agent, model: step.model, reason: 'model_blocked' })
        continue
      }
      out.push(step)
      seen.add(`${step.agent}:${step.model}`)
      continue
    }
    const pool = poolOf(step.model)
    const models = expandPool({ agent: step.agent, pool, env, discovery, policy }).filter((id) => !seen.has(`${step.agent}:${id}`))
    if (models.length === 0) emptyPools.push({ agent: step.agent, model: step.model, reason: 'pool_empty' })
    for (const id of models) {
      seen.add(`${step.agent}:${id}`)
      out.push({ ...step, model: id, pool })
    }
  }
  return { chain: out, emptyPools }
}

/** Every catalog model of `agent` with its pool and decision, in policy order (dashboard view). */
export function policyView({ agent, env = process.env, discovery = readDiscoveryFile(env) }) {
  const policy = readModelPolicy(env)
  const { order } = agentPolicy(policy, agent)
  const models = catalogModels(discovery, agent)
  const ids = models.map((m) => m.id).sort(byPolicyOrder(order))
  return {
    agent,
    catalogAvailable: models.length > 0,
    catalogCheckedAt: discovery?.[agent]?.checkedAt ?? null,
    models: ids.map((id) => {
      const { allowed, source, pool } = modelDecision({ agent, model: id, env, discovery, policy })
      return { id, pool, allowed, source, isNew: source === 'default' }
    }),
  }
}

function assertPolicyAgent(agent) {
  if (!POLICY_AGENTS.includes(agent)) throw new Error(`model policy only covers ${POLICY_AGENTS.join(', ')}, not "${agent}"`)
}

export function setModelDecision({ agent, model, allowed, env = process.env }) {
  assertPolicyAgent(agent)
  if (typeof model !== 'string' || model.trim() === '') throw new Error('model is required')
  if (typeof allowed !== 'boolean') throw new Error('allowed must be a boolean')
  const next = updateJsonLocked(
    paths(env).modelPolicyFile,
    (policy) => {
      const entry = (policy[agent] ??= {})
      entry.decisions = { ...(entry.decisions ?? {}), [model]: { allowed, decidedAt: new Date().toISOString() } }
    },
    { defaultValue: {} }
  )
  return next[agent].decisions[model]
}

/** Replace the priority order (ids first in `order` are tried first within their pool). */
export function setModelOrder({ agent, order, env = process.env }) {
  assertPolicyAgent(agent)
  if (!Array.isArray(order) || order.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new Error('order must be an array of model ids')
  }
  const next = updateJsonLocked(
    paths(env).modelPolicyFile,
    (policy) => {
      const entry = (policy[agent] ??= {})
      entry.order = [...new Set(order)]
    },
    { defaultValue: {} }
  )
  return next[agent].order
}
