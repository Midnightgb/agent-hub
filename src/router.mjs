import { CIRCUIT_BREAKER_BY_CLASS } from './config.mjs'
import { readCache } from './preflight.mjs'
import { circuitBreakerOpen } from './breakers.mjs'
import { readDiscovery } from './discovery.mjs'
import { readOverrides, overrideKey } from './overrides.mjs'
import { acceptedOrderFor, effectiveChainFor } from './proposals.mjs'
import { fetchUsage } from './quota/codexbar.mjs'
import { quotaFor, getProvider } from './quota/mapping.mjs'
import { computeMetrics } from './metrics.mjs'
import { rankCandidates, metricKey } from './routing/score.mjs'
import { codexQuotaDecision } from './routing/codex-gate.mjs'
import { quotaRoutingMode, quotaSkipReason } from './routing/quota-gate.mjs'
import { resolveAgyProfileSync as defaultResolveAgyProfileSync, getAgysMode } from './providers/agys.mjs'
import { requirementsFor } from './capabilities.mjs'

// T4: the ONLY taskTypes where codex appears (always as a last-resort
// fallback — see DELEGATION_MAP) and therefore the only ones where the
// quota-gated codex reordering below can ever apply.
const CODEX_GATED_TASK_TYPES = new Set(['triage', 'mechanical-edit'])

/**
 * The delegation map from the plan, expressed as ordered candidate chains.
 * Claude subagent tiers are {agent:'claude', model:'haiku'|'sonnet'|'opus'}
 * — the caller (Claude Code itself) runs those via the Agent tool; they are
 * never preflighted or breaker-checked here.
 */
export const DELEGATION_MAP = {
  recon: {
    why: 'proven context compression, cheap refreshable quota',
    chain: [
      { agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read' },
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', mode: 'read' },
      { agent: 'claude', model: 'haiku' },
    ],
  },
  'call-chain-trace': {
    why: 'needs multi-hop reasoning, 1M ctx',
    chain: [
      { agent: 'agy', model: 'gemini-3.8-flash-high', mode: 'read' },
      { agent: 'opencode', model: 'opencode/nemotron-3-ultra-free', mode: 'read' },
      { agent: 'claude', model: 'sonnet' },
    ],
  },
  research: {
    why: 'zero cost, 1M ctx',
    chain: [
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', mode: 'read' },
      { agent: 'opencode', model: 'opencode/mimo-v2.5-free', mode: 'read' },
      { agent: 'agy', model: 'gemini-3.8-flash-medium', mode: 'read' },
    ],
  },
  triage: {
    why: 'lowest latency',
    chain: [
      // nemotron-3.5-lightning-free hung indefinitely in live tests (2026-09-11);
      // muse-spark-1.3 is the free model verified to answer.
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', mode: 'read' },
      // copilot's --model allowlist is account-specific and unstable (most
      // documented ids were rejected live); 'auto' is the one value verified
      // reliable. See config.mjs MODEL_REGISTRY for accounts that do allow
      // an explicit id.
      { agent: 'copilot', model: 'auto', mode: 'read' },
      // LAST resort only: codex's plan quota is limited (see config.mjs).
      { agent: 'codex', model: 'default', mode: 'read' },
    ],
  },
  'second-opinion': {
    why: 'different model lineage than Claude Code',
    chain: [
      { agent: 'agy', model: 'gemini-3.8-flash-high', mode: 'read' },
      { agent: 'copilot', model: 'auto', mode: 'read' },
    ],
  },
  'adversarial-review': {
    why: 'dual blind review off the Claude Code quota',
    chain: [
      { agent: 'agy', model: 'claude-sonnet-4-6', mode: 'read', parallelWith: { agent: 'copilot', model: 'auto', mode: 'read' } },
      { agent: 'agy', model: 'claude-opus-4-6-thinking', mode: 'read' },
    ],
  },
  'github-context': {
    why: 'built-in GitHub MCP; cheap models keep premium quota',
    // gpt-4.1 removed: rejected live by --model on this account, same as
    // every other explicit id we tried except 'auto'. No second copilot
    // fallback remains — 'auto' is the only value verified reliable.
    chain: [{ agent: 'copilot', model: 'auto', mode: 'read' }],
  },
  'mechanical-edit': {
    why: 'cheap write-capable; single writer',
    chain: [
      // agy first: refreshable plan quota, load-balanced across profiles;
      // deepseek is paid per token, so it only runs when agy is unavailable.
      { agent: 'agy', model: 'gemini-3.8-flash-medium', mode: 'write' },
      { agent: 'opencode', model: 'deepseek/deepseek-v4-flash', mode: 'write' },
      { agent: 'copilot', model: 'auto', mode: 'write' },
      // LAST resort only: codex's plan quota is limited (see config.mjs).
      { agent: 'codex', model: 'default', mode: 'write' },
    ],
  },
  'implementation-with-repo-rules': {
    why: 'only Claude Code loads CLAUDE.md + skills + hooks',
    chain: [{ agent: 'claude', model: 'sonnet' }],
  },
  architecture: {
    why: 'highest reasoning',
    chain: [
      { agent: 'claude', model: 'opus' },
      { agent: 'agy', model: 'claude-opus-4-6-thinking', mode: 'read' },
    ],
  },
  'structured-mechanical': {
    why: 'cheapest Claude tier',
    chain: [{ agent: 'claude', model: 'haiku' }],
  },
  'ui-test': {
    why: 'drives a real browser through a Playwright MCP server; flash-low misread pages in live probes',
    // Requires the 'browser' capability (TASK_TYPE_REQUIREMENTS in
    // capabilities.mjs): agy only qualifies when its MCP config has an
    // enabled Playwright server. Default timeout comes from TASK_TYPE_TIMEOUTS_S.
    chain: [
      { agent: 'agy', model: 'gemini-3.8-flash-high', mode: 'read' },
      { agent: 'agy', model: 'claude-sonnet-4-6', mode: 'read' },
    ],
  },
}

function isDiscoveryFresh(entry, ttlMs) {
  if (!entry?.checkedAt) return false
  return Date.now() - new Date(entry.checkedAt).getTime() < ttlMs
}

/**
 * Evaluate one chain candidate against a manual hold override, the preflight
 * cache, the circuit breaker and (additively) discovery.json. Returns
 * {usable, reason}, where reason is one of 'held' | 'cli_not_found' |
 * 'breaker_open' | 'cached_unavailable' when usable is false, otherwise
 * null. Advisory only: a cli_not_found discovery row still lets the
 * candidate through unless the hold/cache/breaker also say no — discovery
 * alone never hard-filters.
 */
function evaluateCandidate(candidate, env) {
  if (candidate.agent === 'claude') return { usable: true, reason: null } // Claude subagents are never CLI-preflighted

  const override = readOverrides(env)[overrideKey(candidate.agent, candidate.model)]
  if (override?.hold === true) return { usable: false, reason: 'held' }

  const discoveryRow = readDiscovery(env)[candidate.agent]
  if (discoveryRow?.error === 'not found on PATH') {
    return { usable: false, reason: 'cli_not_found' }
  }

  const cached = readCache(env)[`${candidate.agent}:${candidate.model}`]
  if (cached?.status === 'unavailable') return { usable: false, reason: 'cached_unavailable' }

  for (const klass of Object.keys(CIRCUIT_BREAKER_BY_CLASS)) {
    if (klass === 'default') continue
    if (circuitBreakerOpen({ agent: candidate.agent, model: candidate.model, klass, env })) {
      return { usable: false, reason: 'breaker_open:' + klass }
    }
  }

  if (circuitBreakerOpen({ agent: candidate.agent, model: candidate.model, env })) return { usable: false, reason: 'breaker_open' }
  return { usable: true, reason: null }
}

function isUsable(candidate, env) {
  return evaluateCandidate(candidate, env).usable
}

/**
 * A discovery row without its model catalog. Full catalogs run to several KB
 * per agent, and route() is called before every delegation, so the default
 * keeps the orchestrator's context small.
 */
function summarizeDiscoveryRow(row) {
  if (!row) return null
  return {
    binPath: row.binPath ?? null,
    version: row.version ?? null,
    modelCount: Array.isArray(row.models) ? row.models.length : 0,
    checkedAt: row.checkedAt ?? null,
    error: row.error ?? null,
  }
}

/**
 * discovery.json rows for every distinct CLI agent referenced in one chain
 * (additive context, never used to hard-filter). Summarized unless
 * includeCatalog is true.
 */
function discoveryForChain(chain, env, includeCatalog) {
  const discovery = readDiscovery(env)
  const out = {}
  for (const candidate of chain) {
    if (candidate.agent === 'claude' || candidate.agent in out) continue
    const row = discovery[candidate.agent] ?? null
    out[candidate.agent] = includeCatalog ? row : summarizeDiscoveryRow(row)
  }
  return out
}

/**
 * Metrics rows for routing. `computeFn` is injectable so tests can supply
 * fixtures without touching the filesystem (see _computeMetrics in route()).
 */
function readMetricsRows(env, computeFn) {
  return (computeFn ?? computeMetrics)({ env })?.rows ?? []
}

/**
 * route({taskType}) -> {primary, fallbacks, reason, ranking, ...}. Filters out
 * candidates whose cached preflight is 'unavailable' or whose circuit breaker
 * is open, filters by required capabilities, scores survivors by preferences,
 * and optionally reorders primary/fallbacks when adaptive is true.
 */
export async function route({
  taskType,
  mode,
  includeCatalog = false,
  requirements = [],
  preferences = {},
  adaptive = false,
  env = process.env,
  now = Date.now,
  _computeMetrics = computeMetrics,
  _resolveAgyProfileSync = defaultResolveAgyProfileSync,
}) {
  const entry = DELEGATION_MAP[taskType]
  if (!entry) {
    throw new Error(`unknown task type: "${taskType}". Known types: ${Object.keys(DELEGATION_MAP).join(', ')}`)
  }

  // The effective chain is the static DELEGATION_MAP chain plus every
  // accepted add_candidate proposal appended at the TAIL (never index 0);
  // the reorder proposal (if any) is then applied on top of THAT chain, so
  // an accepted addition becomes eligible for promotion once it has metrics.
  const effective = effectiveChainFor(taskType, entry.chain, env)
  const applied = acceptedOrderFor(taskType, env, { chain: effective })
  const chain = applied ? applied.chain : effective
  const appliedProposal = applied ? { id: applied.proposalId } : null

  const evaluated = chain.map((c) => ({ candidate: c, ...evaluateCandidate(c, env) }))
  const survivors = evaluated.filter((e) => e.usable).map((e) => e.candidate)
  const skipped = evaluated.filter((e) => !e.usable).map((e) => ({ agent: e.candidate.agent, model: e.candidate.model, reason: e.reason }))
  const discovery = discoveryForChain(chain, env, includeCatalog)

  const rows = readMetricsRows(env, _computeMetrics)
  const metricsLookup = {}
  for (const row of rows) {
    const key = metricKey(row.agent, row.model)
    if (!metricsLookup[key]) {
      metricsLookup[key] = row
    } else if (row.taskType === taskType && metricsLookup[key].taskType !== taskType) {
      metricsLookup[key] = row
    }
  }

  const survivorsToRank = survivors.map((c) => (c.mode ? c : { ...c, mode: mode ?? 'read' }))
  const { ranking, excluded } = rankCandidates({
    candidates: survivorsToRank,
    metrics: metricsLookup,
    preferences,
    requirements: requirementsFor(taskType, requirements),
    env,
  })

  const excludedKeys = new Set(excluded.map((e) => `${e.agent}:${e.model}`))
  const eligibleSurvivors = survivors.filter((c) => !excludedKeys.has(`${c.agent}:${c.model}`))
  for (const item of excluded) {
    skipped.push({
      agent: item.agent,
      model: item.model,
      reason: 'missing_capabilities:' + item.missing.join(','),
    })
  }

  if (eligibleSurvivors.length === 0) {
    const detail = skipped.map((s) => `${s.agent}:${s.model} (${s.reason})`).join(', ')
    return {
      primary: null,
      fallbacks: [],
      skipped,
      discovery,
      ranking: [],
      reason: `every candidate for "${taskType}" is unavailable: ${detail} (${entry.why})`,
      appliedProposal,
    }
  }

  let candidates
  if (adaptive) {
    const survivorMap = new Map(eligibleSurvivors.map((c) => [`${c.agent}:${c.model}`, c]))
    candidates = ranking.map((r) => survivorMap.get(`${r.agent}:${r.model}`))
  } else {
    candidates = eligibleSurvivors
  }

  // Quota is informational only for every agent EXCEPT codex, which is
  // deliberately quota-gated below (T4) — see CODEX_GATED_TASK_TYPES and
  // src/routing/codex-gate.mjs — unless AGENT_HUB_QUOTA_ROUTING=skip opts
  // every agent into the gate below. It must never slow a delegation either way:
  // 'cached' mode reads whatever is already in the quota cache and never
  // awaits the network. Providers are computed from every surviving
  // candidate (not just the eventual primary/fallbacks) since the codex
  // gate below needs codex's own quota BEFORE the chain is finalized.
  const providers = new Set()
  for (const c of candidates) {
    const p = getProvider(c.agent, c.model)
    if (p) providers.add(p)
  }
  const usageByProvider = await fetchUsage({ providers: [...providers], env, mode: 'cached' })

  const agysEnv = env?.AGENT_HUB_AGYS
  const isAgysSet = typeof agysEnv === 'string' ? agysEnv.trim() !== '' : Boolean(agysEnv)
  // Quota exhaustion/headroom is per model group (Gemini vs Claude/GPT), so
  // each agy candidate's OWN model is threaded through and memoized here —
  // a chain can carry agy candidates from different groups (e.g. a gemini
  // primary with a claude fallback), and resolveAgyProfileSync's own cache
  // key is keyed by group too, so this memo just avoids redundant sync calls
  // within one route() invocation.
  const agysProfilesByGroup = new Map()
  const resolveAgysProfiles = (model) => {
    const groupKey = model ?? ''
    if (!agysProfilesByGroup.has(groupKey)) {
      const resolved = _resolveAgyProfileSync({ env, model })
      agysProfilesByGroup.set(groupKey, Array.isArray(resolved?.profiles) ? resolved.profiles : [])
    }
    return agysProfilesByGroup.get(groupKey)
  }
  const agysProfilesFor = (model) => (isAgysSet ? resolveAgysProfiles(model) : null)

  // Opt-in (AGENT_HUB_QUOTA_ROUTING=skip): drop every candidate whose own
  // quota is used up before it is launched — see src/routing/quota-gate.mjs.
  // A no-op when the flag is off. agys accounts are read whenever agys is
  // not off (its default is auto), not only when AGENT_HUB_AGYS is set.
  if (quotaRoutingMode(env) === 'skip') {
    const agysInUse = getAgysMode(env).mode !== 'off'
    candidates = candidates.filter((c) => {
      const reason = quotaSkipReason({
        candidate: c,
        quota: quotaFor(c, usageByProvider),
        agysProfiles: c.agent === 'agy' && agysInUse ? resolveAgysProfiles(c.model) : null,
        env,
        now,
      })
      if (reason) skipped.push({ agent: c.agent, model: c.model, reason })
      return !reason
    })
  }

  // T4: quota-gated codex routing. codex is a last-resort-only fallback in
  // `triage`/`mechanical-edit`; when its OWN plan quota is nearly exhausted
  // it is dropped from the chain entirely (never even attempted), and when
  // it clearly has headroom to spare AND is on pace it is promoted ahead of
  // the other fallback(s). This is the one deliberate exception to "quota
  // never chooses/skips/reorders a candidate" — every other agent's order
  // is untouched.
  if (CODEX_GATED_TASK_TYPES.has(taskType)) {
    const codexIdx = candidates.findIndex((c) => c.agent === 'codex')
    if (codexIdx !== -1) {
      const codexCandidate = candidates[codexIdx]
      const decision = codexQuotaDecision({ quota: quotaFor(codexCandidate, usageByProvider), now: now() })
      if (decision.action === 'drop') {
        candidates = candidates.filter((_, i) => i !== codexIdx)
        skipped.push({
          agent: codexCandidate.agent,
          model: codexCandidate.model,
          reason: decision.reason,
          remainingPct: decision.remainingPct,
        })
      } else if (decision.action === 'promote' && candidates.length > 1) {
        const rest = candidates.filter((_, i) => i !== codexIdx)
        const promoted = {
          ...codexCandidate,
          quotaGate: { action: 'promoted', reason: decision.reason, remainingPct: decision.remainingPct },
        }
        candidates = [rest[0], promoted, ...rest.slice(1)]
      }
    }
  }

  if (candidates.length === 0) {
    // Only reachable when a quota gate (opt-in skip, or codex's) just
    // dropped the last surviving candidate — mirrors the
    // eligibleSurvivors.length===0 branch above.
    const detail = skipped.map((s) => `${s.agent}:${s.model} (${s.reason})`).join(', ')
    return {
      primary: null,
      fallbacks: [],
      skipped,
      discovery,
      ranking: [],
      reason: `every candidate for "${taskType}" is unavailable: ${detail} (${entry.why})`,
      appliedProposal,
    }
  }

  const [primary, ...fallbacks] = candidates
  const toAnnotate = [primary, ...fallbacks]

  // Annotate fresh copies, never DELEGATION_MAP's own candidate objects: `chain`
  // (and therefore `primary`/`fallbacks`) are the same shared, module-level
  // objects on every call, so mutating them in place with `.quota = q` let one
  // route() call's quota data leak into another's result through that shared
  // reference — most visible once quota could differ from call to call (SWR
  // cache: pending vs. cached vs. stale) instead of always being refetched.
  const quotaByCandidate = new Map(toAnnotate.map((c) => [c, quotaFor(c, usageByProvider)]))
  const annotate = (c) => {
    const q = quotaByCandidate.get(c)
    let candidate = q ? { ...c, quota: q } : { ...c }
    if (isAgysSet && c.agent === 'agy') {
      candidate = { ...candidate, profiles: [...agysProfilesFor(c.model)] }
    }
    return candidate
  }

  return {
    primary: annotate(primary),
    fallbacks: fallbacks.map(annotate),
    skipped,
    discovery,
    ranking,
    reason: entry.why,
    appliedProposal,
  }
}

export function knownTaskTypes() {
  return Object.keys(DELEGATION_MAP)
}
