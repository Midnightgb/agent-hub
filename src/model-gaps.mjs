/**
 * Pure diff between a CLI's discovered model catalog and DELEGATION_MAP /
 * MODEL_REGISTRY: detects "version bumps" (a newer model that looks like the
 * same family/effort as one already routed) and flags every other catalog
 * model as "unmapped" (no taskType can be inferred safely for it).
 *
 * Deliberately has no side effects and no imports beyond plain JS: callers
 * (proposals.mjs/refreshProposals) own reading discovery.json and deciding
 * what to persist. Only agy and opencode catalogs are considered — copilot's
 * catalog is not authoritative (see discovery.mjs) and codex has no real
 * model listing (see config.mjs MODEL_REGISTRY.codex).
 */

const ELIGIBLE_AGENTS = ['agy', 'opencode']

// Reasoning-effort suffixes recognized as a trailing "-<effort>" token. Order
// matters only in that longer/more specific tokens should not be shadowed by
// shorter ones, but none here are prefixes of each other.
const EFFORT_SUFFIXES = ['minimal', 'low', 'medium', 'high', 'max']

/**
 * Splits a model id into {family, version, effort}. `family` replaces the
 * first digit run with a `*` wildcard so two ids differ only in that run
 * compare equal; `version` is that digit run split on `.`/`-` into numbers;
 * `effort` is a recognized trailing "-<effort>" suffix, stripped before the
 * version scan so it never gets mistaken for part of the family/version.
 *
 * Examples:
 *   'gemini-3.8-flash-low'  -> { family: 'gemini-*-flash', version: [3,8], effort: 'low' }
 *   'claude-sonnet-4-6'     -> { family: 'claude-sonnet-*', version: [4,6], effort: null }
 *   'opencode/muse-spark-1.3-contributor-free'
 *                           -> { family: 'opencode/muse-spark-*-contributor-free', version: [1,3], effort: null }
 */
export function parseModelId(id) {
  let rest = id
  let effort = null
  for (const suffix of EFFORT_SUFFIXES) {
    if (rest.endsWith(`-${suffix}`)) {
      effort = suffix
      rest = rest.slice(0, -(suffix.length + 1))
      break
    }
  }

  const versionMatch = rest.match(/\d+(?:[.-]\d+)*/)
  if (!versionMatch) return { family: rest, version: null, effort }

  const versionStr = versionMatch[0]
  const version = versionStr.split(/[.-]/).map(Number)
  const family = rest.slice(0, versionMatch.index) + '*' + rest.slice(versionMatch.index + versionStr.length)
  return { family, version, effort }
}

/** True when `a` is a strictly higher version than `b` (component-wise, missing components treated as 0). */
function isHigherVersion(a, b) {
  if (!a || !b) return false
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/**
 * Pure: {versionBumps, unmapped} for `discovery` ({agent: {models: [{id}]}})
 * against `map` (DELEGATION_MAP shape) and `registry` (MODEL_REGISTRY shape).
 *
 * versionBumps: one entry per distinct (agent, model, mode) chain usage that
 * has a same-family/same-effort/strictly-higher-version catalog match — the
 * highest such match wins. taskTypes lists every taskType whose chain uses
 * that exact (agent, model, mode) triple.
 *
 * unmapped: catalog models not used anywhere in `map`, not already known in
 * `registry`, and not selected as a versionBump's toModel.
 */
export function computeModelGaps({ discovery = {}, map = {}, registry = {} } = {}) {
  const versionBumps = []
  const unmapped = []

  // agent:model:mode -> {agent, model, mode, taskTypes: []}
  const usageGroups = new Map()
  // agent -> Set(model ids used anywhere in map, any mode)
  const mappedModelIds = new Map()

  for (const [taskType, entry] of Object.entries(map)) {
    for (const step of entry?.chain ?? []) {
      if (!ELIGIBLE_AGENTS.includes(step.agent)) continue
      // A pool step (`@free`) is not a model id: model-policy.mjs resolves it.
      if (typeof step.model === 'string' && step.model.startsWith('@')) continue
      const mode = step.mode ?? 'read'
      const key = `${step.agent}:${step.model}:${mode}`
      if (!usageGroups.has(key)) usageGroups.set(key, { agent: step.agent, model: step.model, mode, taskTypes: [] })
      usageGroups.get(key).taskTypes.push(taskType)

      if (!mappedModelIds.has(step.agent)) mappedModelIds.set(step.agent, new Set())
      mappedModelIds.get(step.agent).add(step.model)
    }
  }

  const bumpedToModels = new Set() // `${agent}:${model}` — excluded from unmapped

  for (const usage of usageGroups.values()) {
    const { agent, model: fromModel, mode, taskTypes } = usage
    const catalog = discovery[agent]?.models ?? []
    const fromParsed = parseModelId(fromModel)

    let best = null
    for (const entry of catalog) {
      const candidateId = entry?.id
      if (!candidateId || candidateId === fromModel) continue
      const parsed = parseModelId(candidateId)
      if (parsed.family !== fromParsed.family) continue
      if (parsed.effort !== fromParsed.effort) continue
      if (!isHigherVersion(parsed.version, fromParsed.version)) continue
      if (!best || isHigherVersion(parsed.version, best.version)) best = { id: candidateId, version: parsed.version }
    }

    if (best) {
      versionBumps.push({ agent, fromModel, toModel: best.id, taskTypes: [...taskTypes], mode })
      bumpedToModels.add(`${agent}:${best.id}`)
    }
  }

  for (const agent of ELIGIBLE_AGENTS) {
    const catalog = discovery[agent]?.models ?? []
    const mappedSet = mappedModelIds.get(agent) ?? new Set()
    const registrySet = new Set(Object.keys(registry[agent] ?? {}))
    for (const entry of catalog) {
      const id = entry?.id
      if (!id) continue
      if (mappedSet.has(id)) continue
      if (registrySet.has(id)) continue
      if (bumpedToModels.has(`${agent}:${id}`)) continue
      unmapped.push({ agent, model: id })
    }
  }

  return { versionBumps, unmapped }
}
