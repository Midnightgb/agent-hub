import os from 'node:os'
import path from 'node:path'

/**
 * All runtime state lives under AGENT_HUB_HOME (default ~/.local/share/agent-hub).
 * Tests MUST override this env var with a temp dir — never touch the real one.
 */
export function stateHome(env = process.env) {
  return env.AGENT_HUB_HOME || path.join(os.homedir(), '.local', 'share', 'agent-hub')
}

/**
 * Opt-in flag for read-purity guard: when '1', snapshot includes gitignored files.
 * Default is OFF (0/unset).
 */
export function readguardIgnoredEnabled(env = process.env) {
  return env?.AGENT_HUB_READGUARD_IGNORED === '1'
}

export function paths(env = process.env) {
  const home = stateHome(env)
  return {
    home,
    dbFile: path.join(home, 'agent-hub.db'),
    eventsFile: path.join(home, 'events.jsonl'),
    preflightCacheFile: path.join(home, 'preflight-cache.json'),
    discoveryFile: path.join(home, 'discovery.json'),
    overridesFile: path.join(home, 'overrides.json'),
    proposalsFile: path.join(home, 'proposals.json'),
    // Recurring Jules tasks. Owned by the long-lived dashboard process, which
    // is the only process here that outlives a Claude session (see scheduler.mjs).
    schedulesFile: path.join(home, 'schedules.json'),
    // Holds raw Jules API keys, so it is written 0600 (see accounts.mjs).
    accountsFile: path.join(home, 'accounts.json'),
    // Per-account /sources cache. Not credentials, so default mode is fine.
    sourcesCacheFile: path.join(home, 'sources-cache.json'),
    learningsFile: path.join(home, 'learnings.json'),
    quotaCacheFile: path.join(home, 'quota-cache.json'),
    runsDir: path.join(home, 'runs'),
    locksDir: path.join(home, 'runs', '.locks'),
    agysModeFile: path.join(home, 'agys-mode.json'),
    // Per (profile, model group) quota exhaustion recorded after a real 429,
    // consulted by resolveAgyProfileSync/resolveAgyProfile so the NEXT
    // resolution avoids that account even if `agys quota --json` has not
    // propagated the exhaustion yet. Several MCP processes run at once, so
    // this file is read/written through fsutil's locked/atomic helpers.
    agysExhaustionFile: path.join(home, 'agys-exhaustion.json'),
  }
}

export const PREFLIGHT_TTL_MS = 15 * 60 * 1000

/** A metrics row needs this many real outcomes before timeouts or proposals trust it. */
export const METRICS_MIN_SAMPLES = 10

/** job_reply warns (never blocks) once a conversation is this many turns deep. */
export const TURN_DEPTH_WARNING = 5

/**
 * Task assignments replace the turn-depth nudge with a context budget: the
 * model's context window when the live catalog reports one, otherwise this
 * default (override: AGENT_HUB_ASSIGNMENT_DEFAULT_CONTEXT_TOKENS).
 */
export const ASSIGNMENT_DEFAULT_CONTEXT_TOKENS = 200_000

/**
 * task_continue/task_status warn (never block) once the session's last
 * observed occupancy reaches this fraction of the context window
 * (override: AGENT_HUB_ASSIGNMENT_CONTEXT_WARN_FRACTION, in (0, 1]).
 */
export const ASSIGNMENT_CONTEXT_WARN_FRACTION = 0.6

export function assignmentDefaultContextTokens(env = process.env) {
  const value = Number(env?.AGENT_HUB_ASSIGNMENT_DEFAULT_CONTEXT_TOKENS)
  return Number.isInteger(value) && value > 0 ? value : ASSIGNMENT_DEFAULT_CONTEXT_TOKENS
}

export function assignmentContextWarnFraction(env = process.env) {
  const value = Number(env?.AGENT_HUB_ASSIGNMENT_CONTEXT_WARN_FRACTION)
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : ASSIGNMENT_CONTEXT_WARN_FRACTION
}

/** Approved learnings injected into one prompt, and the max length of each (mirrored in schemas.mjs). */
export const LEARNINGS_MAX = 3
export const LEARNING_TEXT_MAX = 300

/**
 * Adaptive timeouts only ever raise the static default: p95 of succeeded
 * runs times `multiplier`, capped at `capS`. Timed-out runs are censored
 * samples, so shrinking a timeout would feed back into more timeouts.
 */
export const ADAPTIVE_TIMEOUT = { multiplier: 1.5, capS: 3600 }

/** After a human rejects a proposal, no new proposal for that task type for this long. */
export const PROPOSAL_REJECT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

export const CIRCUIT_BREAKER = {
  windowMs: 30 * 60 * 1000,
  failureThreshold: 2,
  failureKinds: new Set(['quota', 'canceled', 'billing']),
  // A single failure of one of these kinds opens the breaker immediately,
  // instead of waiting for failureThreshold within the window. 'billing'
  // (e.g. DeepSeek 402 Insufficient Balance) never clears on its own retry.
  immediateKinds: new Set(['billing']),
}

export const CIRCUIT_BREAKER_BY_CLASS = {
  billing: { windowMs: 30 * 60 * 1000, failureThreshold: 1, immediate: true },
  auth: { windowMs: 30 * 60 * 1000, failureThreshold: 1, immediate: true },
  quota: { windowMs: 30 * 60 * 1000, failureThreshold: 2 },
  timeout: { windowMs: 15 * 60 * 1000, failureThreshold: 3 },
  transport: { windowMs: 15 * 60 * 1000, failureThreshold: 3 },
  crash: { windowMs: 15 * 60 * 1000, failureThreshold: 2 },
  quality: { windowMs: 15 * 60 * 1000, failureThreshold: 3 },
  default: { windowMs: 30 * 60 * 1000, failureThreshold: 2 },
}

export function breakerKey(agent, model, klass) {
  return klass ? `${agent}:${model}:${klass}` : `${agent}:${model}`
}

/**
 * Extra buffer (seconds) the hub's own hard-kill waits past the adapter's
 * requested timeoutS. agy is given --print-timeout <timeoutS>s and exits on
 * its own with a partial/empty result when it fires; KILL_GRACE_S gives that
 * graceful exit time to happen before jobrunner's outer SIGTERM->SIGKILL.
 */
export const KILL_GRACE_S = 30

/**
 * Cwd paths allowed to accept a write-mode job even outside a secondary git
 * worktree. Empty by default: write mode requires `git worktree add`. The
 * file-pattern denylist (never prisma/, URLs, src/server/openapi/**, tests,
 * next.config.ts, package.json, turbo.json) is a routing-skill policy, not
 * enforced here — this allowlist is only about which cwd bypasses the
 * "must be a secondary worktree" rule.
 */
export const WRITE_ALLOWLIST = []

// Real runs of 278s/303s on medium/high were being cut short by the old
// 90s/180s defaults — agy's own --print-timeout then abandons the turn.
export const DEFAULT_TIMEOUTS_S = {
  agy: {
    'gemini-3.8-flash-low': 300,
    'gemini-3.8-flash-medium': 600,
    'gemini-3.8-flash-high': 900,
    default: 900,
  },
  opencode: { default: 600 },
  copilot: { default: 300 },
  // Codex is a fallback for SMALL bounded tasks with a limited plan quota;
  // 600s mirrors opencode's local-CLI default.
  codex: { default: 600 },
  // A Jules session runs asynchronously on Google's own infrastructure through
  // a full plan -> code -> test -> PR cycle, not a single local CLI turn, so
  // it routinely takes far longer than any local agent. Without this entry
  // resolveTimeoutS() would fall back to 240s (no table for 'jules'), which
  // would abandon a normal session via the poller's own timeoutMs deadline.
  // 21600s (6h) is sized for an UNATTENDED session — the delegate-and-walk-away
  // case this feature exists for — not a watched one; polling costs almost
  // nothing once the backoff reaches its 60s ceiling. `timeoutS` on
  // jules_delegate overrides this per call.
  jules: { default: 21600 },
}

export function resolveTimeoutS(agent, model) {
  const table = DEFAULT_TIMEOUTS_S[agent]
  if (!table) return 240
  return table[model] ?? table.default
}

/**
 * Reasoning-effort variant (minimal/low/medium/high/max) for opencode:
 * explicit override wins, then the model's MODEL_REGISTRY default, else none.
 */
/**
 * Sandbox configuration.
 * - 'compatibility' (DEFAULT): redacts known secret env vars but INHERITS the real HOME.
 *   Not a security sandbox.
 * - 'isolated-home': redacts secret env vars and sets HOME to a fresh empty temp dir.
 * - 'isolated': redacts secret env vars, sets HOME, TMPDIR, and XDG_* directories to a
 *   fresh per-call sandbox dir, with opt-in copy via AGENT_HUB_SANDBOX_INCLUDE.
 *
 * What these levels do and do NOT protect:
 * None of these profiles use OS containers, Linux namespaces, cgroups, or network
 * policies. 'isolated' is still NOT a container; child processes retain regular process
 * privileges and unrestricted network access.
 */
export const SANDBOX = {
  defaultProfile: 'compatibility',
  profiles: {
    compatibility: { inheritHome: true, redactEnv: true },
    'isolated-home': { inheritHome: false, redactEnv: true },
    isolated: { inheritHome: false, redactEnv: true },
  },
}

export function resolveVariant(agent, model, override) {
  if (override) return override
  return MODEL_REGISTRY[agent]?.[model]?.variant ?? null
}

/**
 * Model registry: tier (cost/latency class), dataPolicy badge, and short
 * strength notes. Informational — the router does not block on dataPolicy.
 */
export const MODEL_REGISTRY = {
  agy: {
    'gemini-3.8-flash-low': { tier: 'cheap', dataPolicy: 'unknown', strengths: 'recon, summarize huge artifacts' },
    'gemini-3.8-flash-medium': { tier: 'cheap', dataPolicy: 'unknown', strengths: 'general read/write tasks' },
    'gemini-3.8-flash-high': { tier: 'mid', dataPolicy: 'unknown', strengths: 'cross-module call-chain trace, 1M ctx' },
    'gemini-3.7-flash-low': { tier: 'cheap', dataPolicy: 'unknown', strengths: 'legacy alias' },
    'gemini-3.7-flash-medium': { tier: 'cheap', dataPolicy: 'unknown', strengths: 'legacy alias' },
    'gemini-3.7-flash-high': { tier: 'mid', dataPolicy: 'unknown', strengths: 'legacy alias' },
    'gemini-3.1-pro-low': { tier: 'mid', dataPolicy: 'unknown', strengths: 'second architectural opinion' },
    'gemini-3.1-pro-high': { tier: 'expensive', dataPolicy: 'unknown', strengths: 'second architectural opinion, hard reasoning' },
    'claude-sonnet-4-6': { tier: 'mid', dataPolicy: 'unknown', strengths: 'adversarial diff review, judge' },
    'claude-opus-4-6-thinking': { tier: 'expensive', dataPolicy: 'unknown', strengths: 'architecture, hard judgment' },
    'gpt-oss-120b-medium': { tier: 'mid', dataPolicy: 'unknown', strengths: 'general purpose oss model' },
  },
  opencode: {
    'opencode/muse-spark-1.3-contributor-free': {
      tier: 'free',
      dataPolicy: 'trains',
      strengths: 'library/docs research, brainstorming, 1M ctx',
      // Verified live: this account runs Muse Spark 1.3 (OpenCode Zen free)
      // at variant 'high' by default; a ping with --variant high answered correctly.
      variant: 'high',
    },
    'opencode/nemotron-3.5-lightning-free': { tier: 'free', dataPolicy: 'logs', strengths: 'fast classification/triage/commit messages' },
    'opencode/nemotron-3-ultra-free': { tier: 'free', dataPolicy: 'logs', strengths: 'cross-module call-chain trace' },
    'opencode/mimo-v2.5-free': { tier: 'free', dataPolicy: 'logs', strengths: 'library/docs research' },
    'opencode/big-pickle': { tier: 'free', dataPolicy: 'logs', strengths: 'general purpose free model' },
    'deepseek/deepseek-v4-pro': { tier: 'paid', dataPolicy: 'unknown', strengths: 'general purpose paid model' },
    'deepseek/deepseek-v4-flash': { tier: 'paid', dataPolicy: 'unknown', strengths: 'mechanical edits in isolated worktree' },
    'opencode-go/default': { tier: 'paid', dataPolicy: 'unknown', strengths: 'capped $12/5h, $30/week, $60/month' },
  },
  copilot: {
    // The router's default candidates use 'auto': copilot's --model allowlist
    // is account-specific and was observed to reject most explicit ids below
    // (only 'auto' was reliable). These explicit ids stay in the registry for
    // accounts where they DO work — set them directly via route()/delegate()
    // once L3-pinged 'ready' on that account.
    auto: { tier: 'variable', dataPolicy: 'unknown', strengths: 'resolves to whatever this account can actually use; the only --model value verified reliable' },
    'gpt-5-mini': { tier: 'cheap', dataPolicy: 'unknown', strengths: 'fast classification/triage, GitHub-context work' },
    'gpt-4.1': { tier: 'cheap', dataPolicy: 'unknown', strengths: 'GitHub-context work fallback' },
    'gpt-5.4-mini': { tier: 'cheap', dataPolicy: 'unknown', strengths: 'cheap general purpose' },
    'gpt-5.4': { tier: 'mid', dataPolicy: 'unknown', strengths: 'second opinion fallback' },
    'gpt-5.3-codex': { tier: 'mid', dataPolicy: 'unknown', strengths: 'code-focused tasks' },
    'gpt-5.2-codex': { tier: 'mid', dataPolicy: 'unknown', strengths: 'code-focused tasks' },
    'gpt-5.2': { tier: 'mid', dataPolicy: 'unknown', strengths: 'general purpose' },
    'gpt-5.1': { tier: 'mid', dataPolicy: 'unknown', strengths: 'general purpose' },
    'claude-sonnet-4.6': { tier: 'mid', dataPolicy: 'unknown', strengths: 'adversarial diff review, judge' },
    'claude-sonnet-4.5': { tier: 'mid', dataPolicy: 'unknown', strengths: 'adversarial diff review, judge' },
    'claude-haiku-4.5': { tier: 'cheap', dataPolicy: 'unknown', strengths: 'mechanical edits, write-capable' },
    'claude-opus-4.7': { tier: 'expensive', dataPolicy: 'unknown', strengths: 'architecture, hard judgment' },
    'claude-opus-4.6': { tier: 'expensive', dataPolicy: 'unknown', strengths: 'architecture, hard judgment' },
    'claude-opus-4.6-fast': { tier: 'expensive', dataPolicy: 'unknown', strengths: 'architecture, hard judgment, faster' },
    'claude-opus-4.5': { tier: 'expensive', dataPolicy: 'unknown', strengths: 'architecture, hard judgment' },
    'claude-sonnet-4': { tier: 'mid', dataPolicy: 'unknown', strengths: 'legacy' },
  },
  codex: {
    // Limited-quota tier: codex's plan quota is small, so the router only ever
    // appends it as the LAST fallback of a chain (see router.mjs) — never a
    // primary. 'default' means the CLI's own configured model.
    default: { tier: 'limited', dataPolicy: 'unknown', strengths: 'small bounded tasks; limited plan quota — fallback only' },
  },
}
