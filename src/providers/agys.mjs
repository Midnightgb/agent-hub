import child_process from 'node:child_process'
import { runCommand as defaultRunCommand } from '../process.mjs'
import { normalizeProfile, selectProfile, profileStateFor, modelGroupFor, remainingQuotaForModel } from './profiles.mjs'
import { paths } from '../config.mjs'
import { writeJsonAtomic, readJsonSafe, updateJsonLocked } from '../fsutil.mjs'
import { listJobs as defaultListJobs } from '../jobstore.mjs'
import { profileHasBrowser } from './agy-mcp.mjs'

/**
 * A job that needs a browser prefers profiles whose agy MCP config has a
 * Playwright server. When none has one the list is returned unchanged, so the
 * job still runs (route() already excludes agy when no config qualifies).
 */
export function preferBrowserProfiles(candidates, env, hasBrowserFn = profileHasBrowser) {
  const withBrowser = candidates.filter((c) => hasBrowserFn(c.name, env))
  return withBrowser.length > 0 ? withBrowser : candidates
}

/**
 * agys is an external Go CLI (~/.local/bin/agys) that isolates multi-account profiles
 * under ~/.agys/profiles/<name>/ by overriding HOME.
 *
 * CRITICAL: `agys run` defaults to '--model gemini-3.8-flash --effort high' when no model
 * is passed, so callers must always pass the model explicitly in agyArgv.
 */

/**
 * Parses stdout from `agys list` into normalized profile objects.
 * Handles headers, '(default)' active indicators, '(-)' placeholders, and variable column spacing.
 */
export function parseAgysList(stdout) {
  if (typeof stdout !== 'string') return []
  const lines = stdout.split(/\r?\n/)
  const profiles = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^Active Profiles:/i.test(line)) continue
    if (/^PROFILE\b/i.test(line)) continue
    if (/^[-=]+$/.test(line)) continue

    let name = ''
    let active = false
    let rest = ''

    const defaultMatch = line.match(/^(\S+)\s+\(default\)(?:\s+(.*))?$/)
    if (defaultMatch) {
      name = defaultMatch[1].trim()
      active = true
      rest = defaultMatch[2]?.trim() ?? ''
    } else {
      const parts = line.split(/\s+/)
      name = parts[0]
      rest = parts.slice(1).join(' ')
    }

    if (!name) continue

    const tokens = rest ? rest.split(/\s+/) : []
    // Columns: PRIO, EMAIL, CONFIG, PATH
    const rawPrio = tokens[0]
    const rawEmail = tokens[1]
    const rawPath = tokens.slice(3).join(' ') || tokens[3]

    const priority = Number.isFinite(Number(rawPrio)) ? Number(rawPrio) : 0
    const email = rawEmail && rawEmail !== '(-)' ? rawEmail : null
    const path = rawPath && rawPath !== '(-)' ? rawPath : null

    profiles.push(
      normalizeProfile({
        name,
        email,
        active,
        priority,
        path,
      })
    )
  }

  return profiles
}

/**
 * Tolerantly parses `agys quota --json` stdout or parsed JSON array/object into a map
 * keyed by profileName. Never throws on invalid JSON or unexpected formats, returns {}.
 */
export function parseAgysQuota(input) {
  if (input == null) return {}
  let data = input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return {}
    try {
      data = JSON.parse(trimmed)
    } catch {
      return {}
    }
  }
  if (!data || typeof data !== 'object') return {}

  const result = {}
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        const name = item.profileName ?? item.name
        if (typeof name === 'string' && name.trim()) {
          result[name.trim()] = item
        }
      }
    }
    return result
  }

  if (typeof (data.profileName ?? data.name) === 'string') {
    const name = (data.profileName ?? data.name).trim()
    if (name) {
      result[name] = data
      return result
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object') {
      result[key] = value
    }
  }
  return result
}

const AGY_EFFORT_SUFFIXES = ['low', 'medium', 'high']

/**
 * agys injects its own `--effort high` when the caller does not pass one, and
 * agy rejects that against a suffixed model id:
 *   --model gemini-3.8-flash-low conflicts with --effort=high
 * Our adapter encodes the effort IN the model id (agy's own convention), so
 * when wrapping through agys we split `<base>-<effort>` into `--model <base>`
 * plus `--effort <effort>`. An explicit `--effort` is left untouched.
 */
export function agyArgvForAgys(agyArgv = []) {
  const args = [...agyArgv]
  const modelIdx = args.indexOf('--model')
  if (modelIdx === -1 || args.includes('--effort')) return args
  const model = args[modelIdx + 1]
  if (typeof model !== 'string') return args
  const match = new RegExp('^(.*)-(' + AGY_EFFORT_SUFFIXES.join('|') + ')$').exec(model)
  if (!match || !match[1]) return args
  args[modelIdx + 1] = match[1]
  args.push('--effort', match[2])
  return args
}

export function agysRunArgv({ profile, agyArgv = [] } = {}) {
  return ['run', profile, '--', ...agyArgvForAgys(agyArgv)]
}

export function agysAutoArgv({ agyArgv = [] } = {}) {
  return ['auto', '--', ...agyArgvForAgys(agyArgv)]
}

export async function isAgysAvailable({ runCommandFn = defaultRunCommand, env = process.env } = {}) {
  try {
    const res = await runCommandFn('agys', ['--version'], { env, timeoutMs: 10_000 })
    return res?.code === 0 && !res?.timedOut && !res?.error
  } catch {
    return false
  }
}

export async function listAgysProfiles({ runCommandFn = defaultRunCommand, env = process.env } = {}) {
  try {
    const res = await runCommandFn('agys', ['list'], { env, timeoutMs: 10_000 })
    if (!res || res.code !== 0 || res.timedOut || res.error || !res.stdout) {
      return []
    }
    return parseAgysList(res.stdout)
  } catch {
    return []
  }
}

/**
 * Synchronous counterpart to listAgysProfiles, for callers that must stay
 * synchronous (e.g. delegateTool validating an explicit `profile` input).
 * Uses child_process.execFileSync by default (injectable via execFn, same
 * pattern as resolveAgyProfileSync). Never throws: on failure returns
 * { available: false, profiles: [], reason }, distinguishing an unavailable
 * agys CLI (ENOENT / exit 127) from any other execFn error so a caller can
 * tell "agys is not installed" apart from "the profile list is genuinely
 * unreadable".
 */
export function listAgysProfilesSync({ env = process.env, execFn = child_process.execFileSync } = {}) {
  try {
    let stdout = execFn('agys', ['list'], {
      encoding: 'utf8',
      timeout: 2500,
      env: env || {},
    })
    if (typeof stdout !== 'string') {
      stdout = stdout?.toString?.('utf8') ?? ''
    }
    return { available: true, profiles: parseAgysList(stdout) }
  } catch (err) {
    const isUnavailable = err?.code === 'ENOENT' || err?.code === 127
    return {
      available: false,
      profiles: [],
      reason: isUnavailable ? 'unavailable' : String(err?.message ?? err),
    }
  }
}

export async function readAgysQuota({ runCommandFn = defaultRunCommand, env = process.env } = {}) {
  try {
    const res = await runCommandFn('agys', ['quota', '--json'], { env, timeoutMs: 15_000 })
    if (!res || res.code !== 0 || res.timedOut || res.error || !res.stdout) {
      return {}
    }
    return parseAgysQuota(res.stdout)
  } catch {
    return {}
  }
}

/**
 * Runs agy with the designated agys profile, falling back to plain agy only when
 * profile is falsy.
 *
 * NOTE: Caller handles fallback wiring when a profile run fails (e.g. on quota exhaustion),
 * that wiring is the next slice.
 */
export async function runAgyWithProfile({
  profile,
  agyArgv = [],
  runCommandFn = defaultRunCommand,
  env = process.env,
  cwd,
  timeoutMs,
  ...opts
} = {}) {
  try {
    if (profile) {
      const args = agysRunArgv({ profile, agyArgv })
      return await runCommandFn('agys', args, { env, cwd, timeoutMs, ...opts })
    }
    return await runCommandFn('agy', agyArgv, { env, cwd, timeoutMs, ...opts })
  } catch (error) {
    return {
      stdout: '',
      stderr: String(error?.message ?? error),
      code: 1,
      error,
      timedOut: false,
    }
  }
}

export function resolveAgyCommand({ profile = null, agyCmd = 'agy', agyArgv = [] } = {}) {
  if (profile) {
    return { cmd: 'agys', args: agysRunArgv({ profile, agyArgv }) }
  }
  return { cmd: agyCmd, args: [...agyArgv] }
}

/**
 * Synchronous profile resolution from the environment only.
 *
 * startJob() is and must stay SYNCHRONOUS: delegate() and dispatch() read
 * `startJob(...).job` immediately. The async quota-based 'auto' selection
 * (resolveAgyProfile) therefore belongs to an async caller (dispatch), not
 * here — resolving it inside startJob would only be possible by returning a
 * thenable whose `job` is null until it settles, which breaks every caller.
 */
export function profileFromEnv(env = process.env) {
  const value = env?.AGENT_HUB_AGYS_PROFILE
  return typeof value === 'string' && value.trim() !== ''
    ? { profile: value.trim(), status: 'selected' }
    : { profile: null, status: null }
}

export function getAgysMode(env = process.env) {
  try {
    const safeEnv = env || {}
    const explicitProfile = safeEnv.AGENT_HUB_AGYS_PROFILE
    if (typeof explicitProfile === 'string' && explicitProfile.trim() !== '') {
      return { mode: 'profile', profile: explicitProfile.trim(), source: 'env' }
    }

    const agysMode = safeEnv.AGENT_HUB_AGYS
    if (agysMode === 'auto') {
      return { mode: 'auto', profile: null, source: 'env' }
    }
    if (agysMode === 'off') {
      return { mode: 'off', profile: null, source: 'env' }
    }

    const modeFile = paths(safeEnv).agysModeFile
    const setting = readJsonSafe(modeFile, null)
    if (setting && typeof setting === 'object') {
      if (setting.mode === 'off') {
        return { mode: 'off', profile: null, source: 'setting' }
      }
      if (setting.mode === 'auto') {
        return { mode: 'auto', profile: null, source: 'setting' }
      }
      if (setting.mode === 'profile' && typeof setting.profile === 'string' && setting.profile.trim() !== '') {
        return { mode: 'profile', profile: setting.profile.trim(), source: 'setting' }
      }
    }

    return { mode: 'auto', profile: null, source: 'default' }
  } catch {
    return { mode: 'auto', profile: null, source: 'default' }
  }
}

export function setAgysMode({ mode, profile = null } = {}, env = process.env) {
  if (!['off', 'profile', 'auto'].includes(mode)) {
    throw new Error(`invalid mode: ${mode}`)
  }
  let effectiveProfile = null
  if (mode === 'profile') {
    if (typeof profile !== 'string' || profile.trim() === '') {
      throw new Error('profile is required when mode is profile')
    }
    effectiveProfile = profile.trim()
  }

  const safeEnv = env || {}
  const modeFile = paths(safeEnv).agysModeFile
  writeJsonAtomic(modeFile, { mode, profile: effectiveProfile })
  resetSyncProfileCache()
  resetSnapshotCache()

  return { mode, profile: effectiveProfile, source: 'setting' }
}

// Bounded default when a quota-exhausted provider error carries no parseable
// "Resets in ..." duration: better to skip an account for an hour than to
// keep hammering it (or to never recover it because we recorded no TTL).
export const DEFAULT_EXHAUSTION_TTL_MS = 60 * 60 * 1000

/**
 * Parses a provider error message's "Resets in XhYmZs" (any subset of the
 * three units) into milliseconds. Returns null when no such fragment is
 * present, so the caller can fall back to DEFAULT_EXHAUSTION_TTL_MS.
 */
export function parseResetDurationMs(message) {
  if (typeof message !== 'string') return null
  const match = message.match(/Resets in\s+(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i)
  if (!match) return null
  const hours = Number(match[1] || 0)
  const minutes = Number(match[2] || 0)
  const seconds = Number(match[3] || 0)
  if (!hours && !minutes && !seconds) return null
  return ((hours * 60 + minutes) * 60 + seconds) * 1000
}

/**
 * Records that `profile` is exhausted for `modelGroup` ('gemini' |
 * 'claude-gpt') until the reset parsed from `message` (or
 * DEFAULT_EXHAUSTION_TTL_MS when absent/unparseable). Persisted to
 * AGENT_HUB_HOME/agys-exhaustion.json under a file lock, since several MCP
 * processes may record/read this concurrently — see updateJsonLocked.
 *
 * Invalidates the sync profile cache (entirely, not just this group) so the
 * very next resolveAgyProfileSync call sees the new exhaustion instead of
 * serving a stale cached pick for up to SYNC_PROFILE_CACHE_TTL_MS.
 */
export function recordQuotaExhaustion({ profile, modelGroup, message, env = process.env, now = Date.now } = {}) {
  if (typeof profile !== 'string' || !profile.trim() || typeof modelGroup !== 'string' || !modelGroup) {
    return null
  }
  const resetAt = now() + (parseResetDurationMs(message) ?? DEFAULT_EXHAUSTION_TTL_MS)
  const safeEnv = env || {}
  const file = paths(safeEnv).agysExhaustionFile
  updateJsonLocked(
    file,
    (current) => {
      current[profile] = current[profile] || {}
      current[profile][modelGroup] = { resetAt, recordedAt: now(), message: typeof message === 'string' ? message : null }
      return current
    },
    { defaultValue: {} }
  )
  resetSyncProfileCache()
  return { profile, modelGroup, resetAt }
}

/** Raw { profile: { modelGroup: { resetAt, message } } } exhaustion store. */
export function readQuotaExhaustion(env = process.env) {
  return readJsonSafe(paths(env || {}).agysExhaustionFile, {})
}

/** True while `profile` is recorded as exhausted for `modelGroup` (resetAt in the future). */
export function isProfileExhaustedFor({ profile, modelGroup, env = process.env, now = Date.now } = {}) {
  if (!profile || !modelGroup) return false
  const entry = readQuotaExhaustion(env)?.[profile]?.[modelGroup]
  if (!entry || typeof entry.resetAt !== 'number') return false
  return now() < entry.resetAt
}

/**
 * True when `profile` should be skipped for `model` per the recorded quota
 * exhaustion store — checked in addition to (not instead of) the
 * `agys quota --json` derived state, since a just-recorded 429 may not have
 * propagated to `agys quota --json` yet. An unrecognized model conservatively
 * checks every group recorded for that profile.
 */
function isProfileExhaustedForModel(profileName, model, env, now) {
  const modelGroup = modelGroupFor(model)
  if (modelGroup) {
    return isProfileExhaustedFor({ profile: profileName, modelGroup, env, now })
  }
  const entry = readQuotaExhaustion(env)?.[profileName]
  if (!entry) return false
  return Object.values(entry).some((g) => typeof g?.resetAt === 'number' && now() < g.resetAt)
}

// In-flight job statuses that count toward a profile's load penalty. Any
// other status (succeeded/failed/canceled, or a remote-only state) is a
// finished job and must not keep penalizing the profile it ran on.
const AGY_LOAD_IN_FLIGHT_STATUSES = new Set(['running', 'queued'])

/**
 * Bound for an in-process load reservation (see reserveAgyLoadSlot): long
 * enough to cover the synchronous createJob() write that follows a profile
 * pick within the same tick/process (a burst of concurrent startJob/dispatch
 * calls), short enough that a stale reservation cannot meaningfully skew
 * selection once the real job record exists in the job store and is itself
 * being counted as in-flight.
 */
export const AGY_LOAD_RESERVATION_TTL_MS = 10_000

/** Shared in-process reservation store: `"<profile>:<modelGroup>"` -> [{ id, expiresAt }]. */
export const defaultAgyLoadReservations = new Map()

let agyLoadReservationSeq = 0

/**
 * Reserves one load slot for `profile` in `modelGroup`, so a burst of
 * same-tick resolutions (before any of their jobs are durably written to the
 * job store) still see each other's picks and spread instead of piling onto
 * the same account. The caller is responsible for calling this ONLY after
 * actually committing to a pick that will start a real job — an
 * informational-only caller (e.g. router.mjs's annotation) must never
 * reserve, or it would wrongly bias the next real selection.
 */
export function reserveAgyLoadSlot({ profile, modelGroup, reservations = defaultAgyLoadReservations, now = Date.now, ttlMs = AGY_LOAD_RESERVATION_TTL_MS } = {}) {
  if (typeof profile !== 'string' || !profile || typeof modelGroup !== 'string' || !modelGroup) return null
  const key = `${profile}:${modelGroup}`
  const entry = { id: ++agyLoadReservationSeq, expiresAt: now() + ttlMs }
  const list = reservations.get(key) ?? []
  list.push(entry)
  reservations.set(key, list)
  return entry.id
}

/** Test helper: clears every in-process load reservation. */
export function resetAgyLoadReservations(reservations = defaultAgyLoadReservations) {
  reservations.clear()
}

/**
 * Computes the load-awareness inputs for selectProfile() from the job store
 * plus any in-process reservations: `inFlightByProfile` (profileName ->
 * count of running/queued agy jobs on it, scoped to `modelGroup`) and
 * `lastAssignedByProfile` (profileName -> most recent createdAt, ms epoch,
 * of ANY agy job on it in that group — including terminal ones, since "last
 * assigned" is about round-robin fairness, not current load).
 *
 * Pure with respect to its inputs (listJobsFn/reservations/now are all
 * injectable); the only side effect is pruning expired reservation entries
 * from the given `reservations` map.
 */
export function computeAgyLoadContext({ modelGroup, listJobsFn = defaultListJobs, env = process.env, reservations = defaultAgyLoadReservations, now = Date.now } = {}) {
  const inFlightByProfile = {}
  const lastAssignedByProfile = {}
  if (!modelGroup) return { inFlightByProfile, lastAssignedByProfile }

  let jobs = []
  try {
    jobs = listJobsFn(env) || []
  } catch {
    jobs = []
  }

  for (const job of jobs) {
    if (job?.agent !== 'agy') continue
    const name = job?.profile
    if (typeof name !== 'string' || !name) continue
    if (modelGroupFor(job?.model) !== modelGroup) continue

    if (AGY_LOAD_IN_FLIGHT_STATUSES.has(job?.status)) {
      inFlightByProfile[name] = (inFlightByProfile[name] ?? 0) + 1
    }

    const ts = typeof job?.createdAt === 'string' ? Date.parse(job.createdAt) : NaN
    if (Number.isFinite(ts) && (!(name in lastAssignedByProfile) || ts > lastAssignedByProfile[name])) {
      lastAssignedByProfile[name] = ts
    }
  }

  if (reservations && typeof reservations.entries === 'function') {
    const nowMs = now()
    for (const [key, list] of reservations.entries()) {
      const sep = key.lastIndexOf(':')
      if (sep === -1) continue
      const name = key.slice(0, sep)
      const group = key.slice(sep + 1)
      if (group !== modelGroup) continue
      const active = (Array.isArray(list) ? list : []).filter((entry) => entry?.expiresAt > nowMs)
      if (active.length !== list.length) reservations.set(key, active)
      if (active.length > 0) {
        inFlightByProfile[name] = (inFlightByProfile[name] ?? 0) + active.length
      }
    }
  }

  return { inFlightByProfile, lastAssignedByProfile }
}

export async function resolveAgyProfile({
  env = process.env,
  runCommandFn = defaultRunCommand,
  listFn,
  quotaFn,
  selectFn = selectProfile,
  model = null,
  now = Date.now,
  // T2 load-awareness: same pure scoring as resolveAgyProfileSync (shared via
  // selectProfile's inFlightByProfile/lastAssignedByProfile), computed fresh
  // on every call from the job store (+ any in-process reservations). See
  // computeAgyLoadContext / reserveAgyLoadSlot for the reserve:false default
  // rationale (an informational-only caller like router.mjs must not reserve).
  listJobsFn = defaultListJobs,
  reservations = defaultAgyLoadReservations,
  reserve = false,
  requireBrowser = false,
  hasBrowserFn = profileHasBrowser,
} = {}) {
  try {
    const safeEnv = env || {}
    const modeInfo = getAgysMode(safeEnv)

    if (modeInfo.mode === 'off') {
      return { profile: null, status: null }
    }

    if (modeInfo.source === 'env' && modeInfo.mode === 'profile') {
      return { profile: modeInfo.profile, status: 'selected' }
    }

    const available = await isAgysAvailable({ runCommandFn, env: safeEnv })
    if (!available) {
      return { profile: null, status: 'unavailable' }
    }

    if (modeInfo.mode === 'profile') {
      return { profile: modeInfo.profile, status: 'selected' }
    }

    if (modeInfo.mode === 'auto') {
      const effectiveListFn = listFn ?? listAgysProfiles
      const effectiveQuotaFn = quotaFn ?? readAgysQuota
      const [rawProfiles, quotaMap] = await Promise.all([
        effectiveListFn({ runCommandFn, env: safeEnv }),
        effectiveQuotaFn({ runCommandFn, env: safeEnv }),
      ])

      const profiles = Array.isArray(rawProfiles) ? rawProfiles : []
      const candidates = profiles.map((p) => {
        const quotaEntry = quotaMap && typeof quotaMap === 'object' ? quotaMap[p.name] : null
        let state = p?.state ?? profileStateFor({ profile: p, quotaEntry, model })
        if (state !== 'exhausted' && state !== 'unavailable' && isProfileExhaustedForModel(p.name, model, safeEnv, now)) {
          state = 'exhausted'
        }
        return { ...p, state, quotaEntry }
      })

      const modelGroup = modelGroupFor(model)
      const { inFlightByProfile, lastAssignedByProfile } = modelGroup
        ? computeAgyLoadContext({ modelGroup, listJobsFn, env: safeEnv, reservations, now })
        : { inFlightByProfile: {}, lastAssignedByProfile: {} }

      const pool = requireBrowser ? preferBrowserProfiles(candidates, safeEnv, hasBrowserFn) : candidates
      const chosen = selectFn({ profiles: pool, model, inFlightByProfile, lastAssignedByProfile })
      if (!chosen) {
        return { profile: null, status: null }
      }
      if (chosen.name && reserve && modelGroup) {
        reserveAgyLoadSlot({ profile: chosen.name, modelGroup, reservations, now })
      }
      return {
        profile: chosen.name ?? null,
        status: chosen.active ? 'selected' : 'fallback',
      }
    }

    return { profile: null, status: null }
  } catch {
    return { profile: null, status: null }
  }
}

export const defaultSyncCache = new Map()
export const SYNC_PROFILE_CACHE_TTL_MS = 60_000

export function resetSyncProfileCache() {
  defaultSyncCache.clear()
}

export function resolveAgyProfileSync({
  env = process.env,
  execFn,
  cache = defaultSyncCache,
  now = Date.now,
  model = null,
  // T2 load-awareness: see resolveAgyProfile's matching params above. Shares
  // the same pure scoring (selectProfile) and the same job-store/reservation
  // computation (computeAgyLoadContext) as the async resolver — one shared
  // implementation, two entry points.
  listJobsFn = defaultListJobs,
  reservations = defaultAgyLoadReservations,
  reserve = false,
  requireBrowser = false,
  hasBrowserFn = profileHasBrowser,
} = {}) {
  try {
    const safeEnv = env || {}
    const modeInfo = getAgysMode(safeEnv)

    if (modeInfo.mode === 'off') {
      return { profile: null, status: null, profiles: [] }
    }

    if (modeInfo.source === 'env' && modeInfo.mode === 'profile') {
      const profile = modeInfo.profile
      return { profile, status: 'selected', profiles: [{ name: profile, status: 'selected' }] }
    }

    // The model GROUP (not the raw model id) is part of the cache key: two
    // models in the same group (e.g. two gemini-* variants) may safely share
    // a cached resolution, but a Gemini pick must never leak into a
    // Claude/GPT resolution (or vice versa) — their exhaustion differs.
    const modelGroup = modelGroupFor(model)
    const cacheKey = `agys:${modeInfo.mode}:${modeInfo.profile ?? ''}:${modeInfo.source}:${modelGroup ?? 'unknown'}`

    // T2: the cache holds ONLY the slow agys list+quota snapshot (as
    // `candidates`, or a failure result when agys itself could not be
    // reached) — never the final pick. In-flight load and last-assigned are
    // recomputed on EVERY call (cache hit or miss) so a burst of calls
    // within the 60s TTL still spreads across profiles instead of all
    // replaying one cached decision.
    let candidates = null
    if (cache && typeof cache.get === 'function') {
      const cached = cache.get(cacheKey)
      if (cached && typeof cached.expiresAt === 'number' && now() < cached.expiresAt) {
        if (cached.failure) return cached.value
        candidates = cached.candidates
      }
    }

    if (!candidates) {
      const effectiveExecFn = execFn ?? child_process.execFileSync
      let stdoutList = ''
      let stdoutQuota = ''

      try {
        stdoutList = effectiveExecFn('agys', ['list'], {
          encoding: 'utf8',
          timeout: 2500,
          env: safeEnv,
        })
        if (typeof stdoutList !== 'string') {
          stdoutList = stdoutList?.toString?.('utf8') ?? ''
        }
      } catch (err) {
        const isUnavailable = err?.code === 'ENOENT' || err?.code === 127
        const failureResult = {
          profile: null,
          status: isUnavailable ? 'unavailable' : null,
          profiles: [],
        }
        if (cache && typeof cache.set === 'function') {
          cache.set(cacheKey, { failure: true, value: failureResult, expiresAt: now() + SYNC_PROFILE_CACHE_TTL_MS })
        }
        return failureResult
      }

      try {
        stdoutQuota = effectiveExecFn('agys', ['quota', '--json'], {
          encoding: 'utf8',
          timeout: 2500,
          env: safeEnv,
        })
        if (typeof stdoutQuota !== 'string') {
          stdoutQuota = stdoutQuota?.toString?.('utf8') ?? ''
        }
      } catch {
        stdoutQuota = ''
      }

      const rawProfiles = parseAgysList(stdoutList)
      const quotaMap = parseAgysQuota(stdoutQuota)
      const profiles = Array.isArray(rawProfiles) ? rawProfiles : []

      candidates = profiles.map((p) => {
        const quotaEntry = quotaMap && typeof quotaMap === 'object' ? quotaMap[p.name] : null
        let state = p?.state ?? profileStateFor({ profile: p, quotaEntry, model })
        if (state !== 'exhausted' && state !== 'unavailable' && isProfileExhaustedForModel(p.name, model, safeEnv, now)) {
          state = 'exhausted'
        }
        return { ...p, state, quotaEntry }
      })

      if (cache && typeof cache.set === 'function') {
        cache.set(cacheKey, { failure: false, candidates, expiresAt: now() + SYNC_PROFILE_CACHE_TTL_MS })
      }
    }

    // `remaining` (0..1, null when unknown) is the account's headroom for
    // this model group; the opt-in quota gate in routing/quota-gate.mjs reads it.
    const annotatedProfiles = candidates.map((c) => ({
      name: c.name,
      status: c.state,
      remaining: remainingQuotaForModel(c.quotaEntry, model),
    }))

    let chosen = null
    if (modeInfo.mode === 'auto') {
      const { inFlightByProfile, lastAssignedByProfile } = modelGroup
        ? computeAgyLoadContext({ modelGroup, listJobsFn, env: safeEnv, reservations, now })
        : { inFlightByProfile: {}, lastAssignedByProfile: {} }
      const pool = requireBrowser ? preferBrowserProfiles(candidates, safeEnv, hasBrowserFn) : candidates
      chosen = selectProfile({ profiles: pool, model, inFlightByProfile, lastAssignedByProfile })
      if (chosen?.name && reserve && modelGroup) {
        reserveAgyLoadSlot({ profile: chosen.name, modelGroup, reservations, now })
      }
    }

    return {
      profile: modeInfo.mode === 'profile' ? modeInfo.profile : (chosen?.name ?? null),
      status: modeInfo.mode === 'profile' ? 'selected' : (chosen ? (chosen.active ? 'selected' : 'fallback') : null),
      profiles: annotatedProfiles,
    }
  } catch {
    return { profile: null, status: null, profiles: [] }
  }
}

export const defaultSnapshotCache = new Map()
export const SNAPSHOT_CACHE_TTL_MS = 60_000

export function resetSnapshotCache() {
  defaultSnapshotCache.clear()
}

function extractQuotaBuckets(quotaEntry) {
  if (!quotaEntry || typeof quotaEntry !== 'object') return []
  if (Array.isArray(quotaEntry.buckets)) return quotaEntry.buckets
  if (Array.isArray(quotaEntry.quota?.buckets)) return quotaEntry.quota.buckets
  if (Array.isArray(quotaEntry.quota?.groups)) {
    return quotaEntry.quota.groups.flatMap((g) => (Array.isArray(g.buckets) ? g.buckets : []))
  }
  return []
}

function mapQuotaBucket(rawBucket) {
  if (!rawBucket || typeof rawBucket !== 'object') {
    return {
      id: '',
      label: '',
      window: null,
      resetTime: null,
      usedPercent: null,
      remainingPercent: null,
      description: null,
    }
  }

  const id = String(rawBucket.bucketId ?? rawBucket.id ?? '')
  const label = String(rawBucket.displayName ?? rawBucket.label ?? rawBucket.bucketId ?? rawBucket.id ?? '')
  const windowVal = rawBucket.window != null ? String(rawBucket.window) : null
  const resetTime = rawBucket.resetTime != null ? String(rawBucket.resetTime) : null
  const description = rawBucket.description != null ? String(rawBucket.description) : null

  let usedPercent = null
  let remainingPercent = null

  if (typeof rawBucket.remainingPercent === 'number' && Number.isFinite(rawBucket.remainingPercent)) {
    remainingPercent = rawBucket.remainingPercent
  } else if (typeof rawBucket.remainingFraction === 'number' && Number.isFinite(rawBucket.remainingFraction)) {
    remainingPercent = rawBucket.remainingFraction * 100
  }

  if (typeof rawBucket.usedPercent === 'number' && Number.isFinite(rawBucket.usedPercent)) {
    usedPercent = rawBucket.usedPercent
  } else if (typeof rawBucket.usedFraction === 'number' && Number.isFinite(rawBucket.usedFraction)) {
    usedPercent = rawBucket.usedFraction * 100
  } else if (typeof rawBucket.percent === 'number' && Number.isFinite(rawBucket.percent)) {
    usedPercent = rawBucket.percent
  } else if (typeof rawBucket.percentage === 'number' && Number.isFinite(rawBucket.percentage)) {
    usedPercent = rawBucket.percentage
  } else if (remainingPercent !== null) {
    usedPercent = Math.max(0, Math.min(100, 100 - remainingPercent))
  }

  if (remainingPercent === null && usedPercent !== null) {
    remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent))
  }

  return {
    id,
    label,
    window: windowVal,
    resetTime,
    usedPercent,
    remainingPercent,
    description,
  }
}

export async function agysProfilesSnapshot({
  env = process.env,
  runCommandFn = defaultRunCommand,
  cache = defaultSnapshotCache,
  now = Date.now,
} = {}) {
  const safeEnv = env || {}
  const { mode, profile: pinnedProfile, source } = getAgysMode(safeEnv)

  const cacheKey = `snapshot:${mode}:${pinnedProfile ?? ''}:${source}`
  if (cache && typeof cache.get === 'function') {
    const cached = cache.get(cacheKey)
    if (cached && typeof cached.expiresAt === 'number' && now() < cached.expiresAt) {
      return cached.value
    }
  }

  try {
    const versionRes = await runCommandFn('agys', ['--version'], { env: safeEnv, timeoutMs: 10_000 })
    if (!versionRes || versionRes.code !== 0 || versionRes.timedOut || versionRes.error) {
      const reason =
        versionRes?.error?.message ||
        versionRes?.stderr?.trim() ||
        'agys CLI not found or unavailable on PATH'
      const result = {
        available: false,
        reason,
        mode,
        source,
        pinnedProfile,
        selected: null,
        profiles: [],
      }
      if (cache && typeof cache.set === 'function') {
        cache.set(cacheKey, { value: result, expiresAt: now() + SNAPSHOT_CACHE_TTL_MS })
      }
      return result
    }

    const [listRes, quotaRes] = await Promise.all([
      runCommandFn('agys', ['list'], { env: safeEnv, timeoutMs: 10_000 }),
      runCommandFn('agys', ['quota', '--json'], { env: safeEnv, timeoutMs: 15_000 }),
    ])

    if (!listRes || listRes.code !== 0 || listRes.timedOut || listRes.error) {
      const reason =
        listRes?.error?.message ||
        listRes?.stderr?.trim() ||
        'agys list command failed'
      const result = {
        available: false,
        reason,
        mode,
        source,
        pinnedProfile,
        selected: null,
        profiles: [],
      }
      if (cache && typeof cache.set === 'function') {
        cache.set(cacheKey, { value: result, expiresAt: now() + SNAPSHOT_CACHE_TTL_MS })
      }
      return result
    }

    const rawProfiles = parseAgysList(listRes.stdout || '')
    let quotaMap = {}
    if (quotaRes && quotaRes.code === 0 && quotaRes.stdout && !quotaRes.error) {
      quotaMap = parseAgysQuota(quotaRes.stdout)
    }

    const candidates = rawProfiles.map((p) => {
      const quotaEntry = quotaMap && typeof quotaMap === 'object' ? quotaMap[p.name] : null
      const state = p?.state ?? profileStateFor({ profile: p, quotaEntry })
      const rawBuckets = extractQuotaBuckets(quotaEntry)
      const buckets = rawBuckets.map(mapQuotaBucket)
      return {
        ...p,
        state,
        quota: { buckets },
      }
    })

    let selected = null
    if (mode === 'auto') {
      const chosen = selectProfile({ profiles: candidates })
      selected = chosen?.name ? { name: chosen.name } : null
    } else if (mode === 'profile' && pinnedProfile) {
      selected = { name: pinnedProfile }
    }

    const profiles = candidates.map((c) => ({
      name: c.name,
      email: c.email ?? null,
      active: Boolean(c.active),
      priority: typeof c.priority === 'number' ? c.priority : 0,
      state: c.state,
      quota: c.quota,
    }))

    const result = {
      available: true,
      mode,
      source,
      pinnedProfile,
      selected,
      profiles,
    }

    if (cache && typeof cache.set === 'function') {
      cache.set(cacheKey, { value: result, expiresAt: now() + SNAPSHOT_CACHE_TTL_MS })
    }

    return result
  } catch (error) {
    const fallbackResult = {
      available: false,
      reason: String(error?.message ?? error),
      mode,
      source,
      pinnedProfile,
      selected: null,
      profiles: [],
    }
    if (cache && typeof cache.set === 'function') {
      cache.set(cacheKey, { value: fallbackResult, expiresAt: now() + SNAPSHOT_CACHE_TTL_MS })
    }
    return fallbackResult
  }
}



