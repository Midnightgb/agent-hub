import { agentsStatus as runAgentsStatus } from '../preflight.mjs'
import { route as defaultRoute, DELEGATION_MAP, knownTaskTypes } from '../router.mjs'
import { MODEL_REGISTRY } from '../config.mjs'
import { readDiscovery } from '../discovery.mjs'
import { effectiveTier } from '../catalog.mjs'
import { runCommand } from '../process.mjs'
import { fetchUsage } from '../quota/codexbar.mjs'
import { quotaFor, getProvider } from '../quota/mapping.mjs'

/**
 * The default set of agent+model pairs agents_status checks: every distinct
 * CLI pair (not Claude subagent tiers, which are not CLI-preflighted) named
 * anywhere in the delegation map.
 */
export function defaultPairs() {
  const seen = new Set()
  const pairs = []
  const add = (c) => {
    if (!c || c.agent === 'claude') return
    const key = `${c.agent}:${c.model}`
    if (seen.has(key)) return
    seen.add(key)
    pairs.push({ agent: c.agent, model: c.model })
  }
  for (const entry of Object.values(DELEGATION_MAP)) {
    for (const candidate of entry.chain) {
      add(candidate)
      add(candidate.parallelWith)
    }
  }
  return pairs
}

export async function agentsStatusTool({ refresh = false, cwd = process.cwd(), env = process.env, commandRunner = runCommand } = {}) {
  const pairs = defaultPairs()
  // A manual refresh from an MCP client is worth showing in the dashboard
  // timeline too; a plain cache-served call stays silent.
  const results = await runAgentsStatus({ agents: pairs, cwd, env, refresh, commandRunner, announce: refresh })
  const discovery = readDiscovery(env)

  const providers = new Set()
  for (const pair of pairs) {
    const p = getProvider(pair.agent, pair.model)
    if (p) providers.add(p)
  }
  // 'cached' mode never awaits the network; refresh:true only starts a
  // background refresh instead of blocking this call on a cold CodexBar.
  const usageByProvider = await fetchUsage({ providers: [...providers], refresh, env, mode: 'cached' })

  return results.map((r) => {
    const { tier, tierSource, catalogCheckedAt } = effectiveTier({ agent: r.agent, model: r.model, discovery, registry: MODEL_REGISTRY })
    return {
      agent: r.agent,
      model: r.model,
      status: r.status,
      reason: r.reason ?? null,
      latencyMs: r.latencyMs ?? null,
      quotaSignal: r.quotaSignal ?? 'unknown',
      dataPolicy: MODEL_REGISTRY[r.agent]?.[r.model]?.dataPolicy ?? 'unknown',
      checkedAt: r.checkedAt,
      // Additive: sourced from discovery.json (populated at startup and by
      // the dashboard's "Rediscover CLIs" action), null until a discovery row
      // exists for this agent.
      binPath: discovery[r.agent]?.binPath ?? null,
      cliVersion: discovery[r.agent]?.version ?? null,
      quota: quotaFor({ agent: r.agent, model: r.model }, usageByProvider),
      // Live-catalog pricing tier (src/catalog.mjs): 'catalog' when the last
      // successful discovery row for this agent lists the model (regardless
      // of age), else the MODEL_REGISTRY fallback. catalogCheckedAt is that
      // row's checkedAt when tierSource is 'catalog', else null.
      tier,
      tierSource,
      catalogCheckedAt,
    }
  })
}

export async function routeTool({
  taskType,
  mode,
  includeCatalog = false,
  requirements = [],
  preferences = {},
  adaptive = false,
  env = process.env,
  routeFn = defaultRoute,
} = {}) {
  const result = await routeFn({ taskType, mode, includeCatalog, requirements, preferences, adaptive, env })
  return result
}

export { knownTaskTypes }

export async function agentsQuotaTool({
  refresh = false,
  env = process.env,
  pairsFn = defaultPairs,
  readDiscoveryFn = readDiscovery,
  fetchUsageFn = fetchUsage,
} = {}) {
  const pairs = pairsFn()
  // codex is added when it is installed even if no chain names it, so its
  // quota is visible before anyone delegates to it. It now also appears in the
  // delegation map, so add it only when that did not already contribute it —
  // otherwise the pair is listed twice (observed right after the quota work
  // merged).
  const discovery = readDiscoveryFn(env)
  const hasCodex = pairs.some((pair) => pair.agent === 'codex' && pair.model === 'default')
  if (discovery?.codex && !hasCodex) {
    pairs.push({ agent: 'codex', model: 'default' })
  }

  const providers = new Set()
  for (const pair of pairs) {
    const p = getProvider(pair.agent, pair.model)
    if (p) providers.add(p)
  }

  // 'live' mode: this is the tool a human calls to get a fresh reading, so
  // it awaits the network (up to fetchUsage's 45s live timeout) instead of
  // returning stale/pending data.
  const usageByProvider = await fetchUsageFn({ providers: [...providers], refresh, env, mode: 'live' })

  return pairs.map((p) => ({
    agent: p.agent,
    model: p.model,
    quota: quotaFor(p, usageByProvider),
  }))
}
