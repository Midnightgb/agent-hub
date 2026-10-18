/**
 * Pure derivation of an agent CLI's live pricing tier from its catalog
 * (discovery.json), plus report-only drift between that catalog and
 * MODEL_REGISTRY/DELEGATION_MAP. Implements T11/T12 of
 * odd/tasks/opencode-v2-migration.md (see odd/tasks/opencode-live-catalog.md
 * for the full rationale).
 *
 * Deliberately pure and side-effect-free, like model-gaps.mjs: callers own
 * reading discovery.json/DELEGATION_MAP/MODEL_REGISTRY and deciding what to
 * persist or expose.
 */

/**
 * True when a discovery.json row for one agent reflects a successful catalog
 * fetch: no error, and a non-empty models list.
 *
 * Deliberately NOT a freshness/TTL check. discovery.json is only refreshed
 * at MCP startup (src/startup.mjs) and on an explicit dashboard "Rediscover
 * CLIs" action (src/dashboard.mjs) -- there is no periodic background
 * refresh -- so gating on PREFLIGHT_TTL_MS (15 minutes, meant for CLI
 * *readiness* in preflight.mjs/discovery.mjs) made catalog-derived tier/
 * drift silently fall back to the registry almost all the time, defeating
 * the whole point of this module. A row hours old is still the best
 * evidence available; only "never fetched successfully" (error, or no
 * models) should fall back.
 */
function isGoodCatalogRow(entry) {
  return Boolean(entry) && !entry.error && Array.isArray(entry.models) && entry.models.length > 0
}

/**
 * Pricing tier from one catalog model entry's `cost` (an array of
 * {input, output, cache} -- the first entry is the one opencode's
 * `api model.list` actually varies per model). Missing or empty cost is
 * 'unknown' (null): a model must be POSITIVELY confirmed input:0/output:0 to
 * report as free, never assumed free from absence of data.
 */
export function catalogTier(entry) {
  const cost = entry?.cost?.[0]
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') return null
  if (cost.input === 0 && cost.output === 0) return 'free'
  if (cost.input > 0 || cost.output > 0) return 'paid'
  return null
}

/**
 * Effective tier for one agent:model pair: the last good catalog's tier when
 * `agent`'s discovery row actually lists `model` (regardless of how long ago
 * it was fetched -- see isGoodCatalogRow); otherwise MODEL_REGISTRY's
 * hand-written tier (or null if neither knows the model). `tierSource`
 * records which one won, so callers/UI can show provenance instead of
 * presenting a stale registry value as live fact. `catalogCheckedAt` is the
 * catalog row's `checkedAt` when the catalog won (null otherwise), so
 * consumers can show the age of that evidence.
 */
export function effectiveTier({ agent, model, discovery = {}, registry = {} }) {
  const row = discovery?.[agent]
  if (isGoodCatalogRow(row)) {
    const entry = row.models.find((m) => m.id === model)
    if (entry) return { tier: catalogTier(entry), tierSource: 'catalog', catalogCheckedAt: row.checkedAt ?? null }
  }
  return { tier: registry?.[agent]?.[model]?.tier ?? null, tierSource: 'registry', catalogCheckedAt: null }
}

/**
 * Drift between the live catalog and MODEL_REGISTRY/DELEGATION_MAP for one
 * `agent` (opencode by default -- the only CLI with an authoritative,
 * cost-bearing catalog today; see discovery.mjs's note on copilot/codex).
 * Report-only: this never mutates routing or the registry, mirroring
 * model-gaps.mjs's unmapped/versionBumps split.
 *
 * Only computed when that agent's discovery row is a successful catalog
 * fetch (see isGoodCatalogRow) -- a missing, errored, or empty row would
 * otherwise report every pinned id as "vanished", which is not evidence of
 * anything. Age alone does NOT disqualify a row (see isGoodCatalogRow).
 *
 * Returns an array of:
 *   {type: 'vanished', agent, model, checkedAt}            -- pinned id no longer in the catalog
 *   {type: 'now_paid', agent, model, checkedAt}             -- registry tier:'free', catalog cost > 0
 *   {type: 'new_free', agent, model, checkedAt}             -- catalog free model, absent from the registry
 *   {type: 'variant_unavailable', agent, model, variant, checkedAt} -- pinned registry variant not in catalog variants[]
 * `checkedAt` is the source discovery row's `checkedAt`, so consumers can
 * show the age of the catalog evidence a drift item is based on.
 */
export function computeCatalogDrift({ discovery = {}, map = {}, registry = {}, agent = 'opencode' } = {}) {
  const row = discovery?.[agent]
  if (!isGoodCatalogRow(row)) return []

  const checkedAt = row.checkedAt ?? null
  const catalog = row.models ?? []
  const catalogById = new Map(catalog.filter((m) => m?.id).map((m) => [m.id, m]))
  const items = []

  // Every id pinned for `agent`, from MODEL_REGISTRY and from DELEGATION_MAP
  // chains -- either source can reference an id that later vanishes.
  const pinnedVariant = new Map() // id -> registry variant (or null)
  for (const [id, entry] of Object.entries(registry?.[agent] ?? {})) {
    pinnedVariant.set(id, entry?.variant ?? null)
  }
  for (const chainEntry of Object.values(map ?? {})) {
    for (const step of chainEntry?.chain ?? []) {
      if (step?.agent !== agent || !step.model) continue
      if (!pinnedVariant.has(step.model)) pinnedVariant.set(step.model, null)
    }
  }

  for (const [id, variant] of pinnedVariant) {
    const entry = catalogById.get(id)
    if (!entry) {
      items.push({ type: 'vanished', agent, model: id, checkedAt })
      continue
    }
    if (registry?.[agent]?.[id]?.tier === 'free' && catalogTier(entry) === 'paid') {
      items.push({ type: 'now_paid', agent, model: id, checkedAt })
    }
    if (variant) {
      const variants = entry.variants ?? []
      if (!variants.some((v) => v?.id === variant)) {
        items.push({ type: 'variant_unavailable', agent, model: id, variant, checkedAt })
      }
    }
  }

  const registrySet = new Set(Object.keys(registry?.[agent] ?? {}))
  for (const entry of catalog) {
    if (!entry?.id || registrySet.has(entry.id)) continue
    if (catalogTier(entry) === 'free') items.push({ type: 'new_free', agent, model: entry.id, checkedAt })
  }

  return items
}

/**
 * Validate a requested reasoning-effort variant against the last good
 * catalog row (see isGoodCatalogRow) before a job spawns (T3 of
 * odd/tasks/opencode-live-catalog.md). An unsupported variant must never
 * reach the provider as `provider.no-route: Variant unavailable for
 * <model>: <variant>` -- it is dropped here instead, and the caller gets a
 * human-readable warning to record on the job.
 *
 * `model` may already carry an explicit `<model>#<variant>` id (the same
 * convention src/adapters/opencode.mjs's buildArgv uses to fold a variant
 * into the model id): that embedded variant is validated the same way, and
 * takes precedence over a separately-passed `variant`, mirroring buildArgv's
 * own `variant && !model.includes('#')` precedence -- otherwise this
 * function could "validate" a variant that never actually reaches the CLI.
 *
 * Missing/errored/empty catalog, or a model the catalog doesn't list, keeps
 * today's behavior unchanged (model/variant returned as given, no warning):
 * there is no live evidence to validate against, so nothing is second-guessed.
 *
 * Returns {model, variant, warning}: `model` has any invalid embedded
 * variant stripped back to the bare id; `variant` is null when dropped;
 * `warning` is a message to surface on the job, or null when nothing changed.
 */
export function validateVariant({ agent, model, variant, discovery = {} }) {
  const hashIndex = typeof model === 'string' ? model.indexOf('#') : -1
  const baseModel = hashIndex === -1 ? model : model.slice(0, hashIndex)
  const embeddedVariant = hashIndex === -1 ? null : model.slice(hashIndex + 1)
  const requestedVariant = embeddedVariant ?? variant

  if (!requestedVariant) return { model, variant, warning: null }

  const row = discovery?.[agent]
  if (!isGoodCatalogRow(row)) return { model, variant, warning: null }

  const entry = row.models.find((m) => m?.id === baseModel)
  if (!entry) return { model, variant, warning: null }

  const variants = entry.variants ?? []
  if (variants.some((v) => v?.id === requestedVariant)) return { model, variant, warning: null }

  return {
    model: baseModel,
    variant: null,
    warning: `Variant unavailable for ${baseModel}: ${requestedVariant} (dropped; running at the model default)`,
  }
}
