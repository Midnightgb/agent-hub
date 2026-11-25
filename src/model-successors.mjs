import { paths, SUCCESSOR_PROVIDER_PREFERENCE } from './config.mjs'
import { catalogTier } from './catalog.mjs'
import { parseModelId } from './model-gaps.mjs'
import { appendEvent } from './eventlog.mjs'
import { isPoolModel } from './model-policy.mjs'

/**
 * Model auto-discovery for pinned ids: when a model hardcoded in
 * DELEGATION_MAP / MODEL_REGISTRY / EXPLICIT_ONLY_PAIRS is no longer listed
 * by its CLI's live catalog (discovery.json), resolve the newest model of the
 * same family so routing keeps working without a code change.
 *
 * Example: opencode renamed `deepseek/deepseek-v4-flash` away; the catalog
 * now lists `opencode-go/deepseek-v4.1-flash` — same family
 * (`deepseek-v*-flash`, provider prefix ignored), higher version.
 *
 * Only agents whose catalog is authoritative are eligible: copilot's listing
 * is documentation, not account availability, and codex has no real list.
 */
export const SUCCESSOR_AGENTS = Object.freeze(['agy', 'opencode', 'gentle-shell'])

/** A discovery row that is actual evidence: fetched without error and non-empty. */
export function hasGoodCatalog(row) {
  return Boolean(row) && !row.error && Array.isArray(row.models) && row.models.length > 0
}

/** True when `agent`'s good catalog lists `model` (a `#variant` suffix is ignored). */
export function isListed(row, model) {
  const base = String(model).split('#')[0]
  return row.models.some((m) => m.id === base)
}

function splitProvider(id) {
  const slash = id.indexOf('/')
  return slash === -1 ? { provider: null, name: id } : { provider: id.slice(0, slash), name: id.slice(slash + 1) }
}

/** -1 / 0 / 1 component-wise, missing components treated as 0. */
function compareVersions(a, b) {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/**
 * The discovered successor of a pinned `agent:model`, or null when the model
 * is still listed, the agent is not eligible, the catalog is missing/errored
 * (absence of evidence never triggers a substitution), or no candidate is
 * safe. A candidate must share the pinned id's family and effort suffix
 * (provider prefix ignored), have a version >= the pinned one, and — when the
 * pinned model is known to be free — be confirmed free too, so a substitution
 * never silently starts billing.
 *
 * A trailing YYYYMMDD snapshot date is not part of the version
 * (parseModelId), so `claude-sonnet-4-20250514` is version 4 and never
 * outranks `claude-sonnet-4-6`.
 *
 * Ranking: highest version, then non-dated over dated snapshots, then the
 * pinned id's own provider, then
 * SUCCESSOR_PROVIDER_PREFERENCE[agent], then catalog order.
 */
export function findSuccessor({ agent, model, discovery = {}, registry = {}, preference = SUCCESSOR_PROVIDER_PREFERENCE }) {
  if (!SUCCESSOR_AGENTS.includes(agent)) return null
  const row = discovery?.[agent]
  if (!hasGoodCatalog(row) || isListed(row, model)) return null

  const pinned = splitProvider(String(model).split('#')[0])
  const pinnedParsed = parseModelId(pinned.name)
  const mustBeFree = registry?.[agent]?.[model]?.tier === 'free'
  const providerOrder = preference?.[agent] ?? []

  const candidates = []
  row.models.forEach((entry, index) => {
    const { provider, name } = splitProvider(entry.id)
    const parsed = parseModelId(name)
    if (parsed.family !== pinnedParsed.family || parsed.effort !== pinnedParsed.effort) return
    if ((parsed.version === null) !== (pinnedParsed.version === null)) return
    if (pinnedParsed.version && compareVersions(parsed.version, pinnedParsed.version) < 0) return
    if (mustBeFree && catalogTier(entry) !== 'free') return
    const prefIndex = providerOrder.indexOf(provider)
    candidates.push({
      id: entry.id,
      version: parsed.version ?? [],
      dated: Boolean(parsed.snapshot),
      sameProvider: provider === pinned.provider,
      prefRank: prefIndex === -1 ? Number.MAX_SAFE_INTEGER : prefIndex,
      index,
    })
  })

  candidates.sort(
    (a, b) =>
      compareVersions(b.version, a.version) ||
      Number(a.dated) - Number(b.dated) ||
      Number(b.sameProvider) - Number(a.sameProvider) ||
      a.prefRank - b.prefRank ||
      a.index - b.index
  )
  return candidates[0]?.id ?? null
}

// One event per (state home, agent, from, to) per process: route() runs
// before every delegation and must not flood the timeline.
const announced = new Set()

function announce({ agent, from, to }, env) {
  const key = `${paths(env).eventsFile}|${agent}|${from}|${to}`
  if (announced.has(key)) return
  announced.add(key)
  appendEvent(
    {
      kind: 'preflight',
      phase: 'substitution',
      agent,
      model: to,
      from,
      status: 'ok',
      reason: `${from} not listed by ${agent}; auto-substituted`,
      summary: `${agent}: ${from} → ${to} (auto-substituted)`,
    },
    { env }
  )
}

/**
 * Replace every chain candidate (and its parallelWith) whose model vanished
 * from its agent's catalog with the discovered successor. Substituted
 * candidates carry `substitutedFrom`; `substitutions` lists each distinct
 * swap. Candidates without a successor are returned unchanged, and so are:
 * - pool steps (`@free`, `@go`): expandChain resolves them from the catalog
 *   under the opencode model policy, so there is nothing pinned to replace;
 * - held pins (`isHeld(agent, model)` true): a hold set on the pinned id is
 *   honored, so route() still reports that candidate as skipped `held`
 *   instead of silently routing to its successor.
 */
export function substituteChain(chain, { discovery = {}, registry = {}, env = process.env, isHeld = () => false } = {}) {
  const substitutions = []
  const seen = new Set()

  const resolve = (candidate) => {
    if (!candidate || candidate.agent === 'claude' || isPoolModel(candidate.model)) return candidate
    if (isHeld(candidate.agent, candidate.model)) return candidate
    const to = findSuccessor({ agent: candidate.agent, model: candidate.model, discovery, registry })
    if (!to) return candidate
    const key = `${candidate.agent}|${candidate.model}|${to}`
    if (!seen.has(key)) {
      seen.add(key)
      substitutions.push({ agent: candidate.agent, from: candidate.model, to })
      announce({ agent: candidate.agent, from: candidate.model, to }, env)
    }
    return { ...candidate, model: to, substitutedFrom: candidate.model }
  }

  const resolved = chain.map((candidate) => {
    const next = resolve(candidate)
    if (candidate.parallelWith) {
      const parallelWith = resolve(candidate.parallelWith)
      return parallelWith === candidate.parallelWith ? next : { ...next, parallelWith }
    }
    return next
  })
  return { chain: resolved, substitutions }
}
