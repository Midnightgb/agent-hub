/**
 * Opt-in quota-aware routing (AGENT_HUB_QUOTA_ROUTING=skip). Off by default,
 * where quota stays informational for every agent but codex (see
 * codex-gate.mjs). With `skip`, route() drops a chain candidate before it is
 * launched when its own quota is used up, so the next candidate in the chain
 * runs instead of a job that would only fail with a 429.
 *
 * Unknown quota (no data, pending, stale, not metered) never skips.
 */

import { paths } from '../config.mjs'
import { readJsonSafe, updateJsonLocked } from '../fsutil.mjs'
import { modelGroupFor, remainingQuotaForModel } from '../providers/profiles.mjs'
import { DEFAULT_EXHAUSTION_TTL_MS, getAgysMode, readAgysQuota, readQuotaExhaustion, resetSyncProfileCache } from '../providers/agys.mjs'
import { fetchUsage } from '../quota/codexbar.mjs'
import { quotaFor } from '../quota/mapping.mjs'

export const DEFAULT_QUOTA_MIN_REMAINING = 0.05

export function quotaRoutingMode(env = process.env) {
  return String(env?.AGENT_HUB_QUOTA_ROUTING ?? '').trim().toLowerCase() === 'skip' ? 'skip' : 'off'
}

/** Refresh period of the scheduler's quota loop, ms; 0 disables it. */
export function quotaRefreshMs(env = process.env) {
  const raw = env?.AGENT_HUB_QUOTA_REFRESH_S
  const value = raw == null || String(raw).trim() === '' ? 300 : Number(raw)
  return Number.isFinite(value) && value > 0 ? value * 1000 : 0
}

/** Remaining fraction (0..1) below which a quota window counts as used up. */
export function quotaMinRemaining(env = process.env) {
  const raw = env?.AGENT_HUB_QUOTA_MIN_REMAINING
  const value = raw == null || String(raw).trim() === '' ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 && value < 1 ? value : DEFAULT_QUOTA_MIN_REMAINING
}

/**
 * Lowest remaining fraction across a quotaFor() result's known windows, or
 * null when nothing usable is known (the caller must then fail open).
 */
function codexbarRemaining(quota) {
  if (!quota || typeof quota !== 'object' || quota.quotaUnavailableReason || quota.stale === true) return null
  const used = (Array.isArray(quota.windows) ? quota.windows : [])
    .filter((w) => w?.usageKnown !== false && typeof w?.usedPercent === 'number' && Number.isFinite(w.usedPercent))
    .map((w) => w.usedPercent)
  if (used.length === 0) return null
  return Math.max(0, 1 - Math.max(...used) / 100)
}

/**
 * True when every eligible agys account (not 'unavailable') is exhausted for
 * this model group or below `min`. An account with unknown remaining quota
 * keeps the pair, and so does an empty or all-unavailable list.
 */
function agysAccountsUsedUp(profiles, min) {
  const eligible = profiles.filter((p) => p?.status !== 'unavailable')
  if (eligible.length === 0) return false
  return eligible.every((p) => p.status === 'exhausted' || (typeof p.remaining === 'number' && p.remaining < min))
}

/**
 * Why `candidate` must be skipped, or null to keep it. An active exhaustion
 * mark (recorded from a real quota error) wins. Otherwise `quota` is its
 * quotaFor() result; `agysProfiles` the resolveAgyProfileSync() accounts for
 * an agy candidate (null when agys is not in use). agys accounts, when
 * listed, decide for agy; otherwise the CodexBar windows do.
 */
export function quotaSkipReason({ candidate, quota, agysProfiles = null, env = process.env, now = Date.now }) {
  if (quotaRoutingMode(env) !== 'skip' || candidate.agent === 'claude') return null
  const mark = activeQuotaMark({ agent: candidate.agent, model: candidate.model, env, now })
  if (mark) return `quota-exhausted-until ${new Date(mark.resetAt).toISOString()}`
  const min = quotaMinRemaining(env)
  if (candidate.agent === 'agy' && Array.isArray(agysProfiles) && agysProfiles.length > 0) {
    return agysAccountsUsedUp(agysProfiles, min) ? 'quota' : null
  }
  const remaining = codexbarRemaining(quota)
  return remaining != null && remaining < min ? 'quota' : null
}

const DURATION_UNITS_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 }
const DURATION_TOKEN = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi
const RELATIVE_RESET = /(?:resets?|try again)\b[^0-9]{0,20}((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/

/**
 * Reset time (ms epoch) from a provider quota error: a relative "Resets in
 * 78h0m13s" / "reset in 150 hours" / "try again in 2 days", else the first
 * ISO timestamp still in the future. Null when neither is present.
 */
export function parseQuotaResetAt(message, now = Date.now()) {
  if (typeof message !== 'string') return null
  const relative = message.match(RELATIVE_RESET)
  if (relative) {
    let ms = 0
    for (const [, amount, unit] of relative[1].matchAll(DURATION_TOKEN)) {
      ms += Number(amount) * DURATION_UNITS_MS[unit[0].toLowerCase()]
    }
    if (ms > 0) return now + ms
  }
  const iso = message.match(ISO_TIMESTAMP)
  const at = iso ? Date.parse(iso[0]) : NaN
  return Number.isFinite(at) && at > now ? at : null
}

/** agy quota is per model group (Gemini vs Claude/GPT); every other pair is its own. */
function markKey(agent, model) {
  return agent === 'agy' ? `agy:${modelGroupFor(model) ?? model}` : `${agent}:${model}`
}

/** Raw { "<agent>:<model or group>": { agent, model, resetAt, recordedAt, message } } store. */
export function readQuotaMarks(env = process.env) {
  return readJsonSafe(paths(env || {}).quotaExhaustionFile, {})
}

/**
 * Marks the pair exhausted until the reset parsed from `message`, or
 * DEFAULT_EXHAUSTION_TTL_MS from now when it carries none. Locked write:
 * several MCP processes record and read marks at once.
 */
export function recordQuotaMark({ agent, model, message, env = process.env, now = Date.now } = {}) {
  if (!agent || !model) return null
  const recordedAt = now()
  const mark = {
    agent,
    model,
    resetAt: parseQuotaResetAt(message, recordedAt) ?? recordedAt + DEFAULT_EXHAUSTION_TTL_MS,
    recordedAt,
    message: typeof message === 'string' ? message.slice(0, 500) : null,
  }
  updateJsonLocked(paths(env || {}).quotaExhaustionFile, (current) => ({ ...current, [markKey(agent, model)]: mark }), { defaultValue: {} })
  return mark
}

/** The pair's mark while its reset is still ahead, else null. */
export function activeQuotaMark({ agent, model, env = process.env, now = Date.now } = {}) {
  const mark = readQuotaMarks(env)[markKey(agent, model)]
  return typeof mark?.resetAt === 'number' && now() < mark.resetAt ? mark : null
}

// Every CodexBar provider a non-claude pair can be metered by (quota/mapping.mjs).
const REFRESH_PROVIDERS = ['antigravity', 'copilot', 'codex', 'opencodego']

// A representative model per agys model group, for remainingQuotaForModel.
const GROUP_MODEL = { gemini: 'gemini', 'claude-gpt': 'claude' }

/**
 * One pass of the scheduler's quota loop (skip mode only): refreshes the
 * CodexBar cache and reads `agys quota --json`, then clears every exhaustion
 * mark (pair and agys account) whose reset has passed, or whose quota is back
 * at or above the threshold. A mark younger than one refresh interval is only
 * cleared by its reset, since a quota reading can lag a fresh 429; unknown
 * quota keeps a mark until its reset.
 */
export async function refreshQuota({
  env = process.env,
  now = Date.now,
  fetchUsageFn = fetchUsage,
  readAgysQuotaFn = readAgysQuota,
  intervalMs = quotaRefreshMs(env),
} = {}) {
  const cleared = []
  if (quotaRoutingMode(env) !== 'skip') return { cleared }
  const min = quotaMinRemaining(env)
  const nowMs = now()
  const settled = (mark, remaining) =>
    mark.resetAt <= nowMs || (nowMs - (mark.recordedAt ?? 0) >= intervalMs && remaining != null && remaining >= min)

  const usage = await fetchUsageFn({ providers: REFRESH_PROVIDERS, env, mode: 'live', refresh: true })
  const agysQuota = getAgysMode(env).mode === 'off' ? {} : await readAgysQuotaFn({ env })

  const marks = readQuotaMarks(env)
  const pairKeys = Object.keys(marks).filter((key) => settled(marks[key], codexbarRemaining(quotaFor(marks[key], usage))))
  if (pairKeys.length > 0) {
    updateJsonLocked(paths(env).quotaExhaustionFile, (current) => {
      // Keep a mark re-recorded since it was read.
      for (const key of pairKeys) if (current[key]?.recordedAt === marks[key].recordedAt) delete current[key]
      return current
    }, { defaultValue: {} })
    cleared.push(...pairKeys)
  }

  const accounts = readQuotaExhaustion(env)
  const accountKeys = []
  for (const [profile, groups] of Object.entries(accounts)) {
    for (const [group, mark] of Object.entries(groups ?? {})) {
      if (typeof mark?.resetAt !== 'number') continue
      if (settled(mark, remainingQuotaForModel(agysQuota?.[profile], GROUP_MODEL[group] ?? null))) accountKeys.push([profile, group])
    }
  }
  if (accountKeys.length > 0) {
    updateJsonLocked(paths(env).agysExhaustionFile, (current) => {
      for (const [profile, group] of accountKeys) {
        if (current[profile]?.[group]?.resetAt !== accounts[profile][group].resetAt) continue
        delete current[profile][group]
        if (Object.keys(current[profile]).length === 0) delete current[profile]
      }
      return current
    }, { defaultValue: {} })
    resetSyncProfileCache()
    cleared.push(...accountKeys.map(([profile, group]) => `agys:${profile}:${group}`))
  }
  return { cleared }
}
