import { parseJsonl } from './base.mjs'

export const id = 'opencode'
export const cmd = 'opencode'

/**
 * Argv only. read -> --agent plan; write -> --agent build --auto.
 * sessionId resumes a session (-s <id>); variant selects reasoning effort
 * (minimal/low/medium/high/max), e.g. Muse Spark 1.3's registry default 'high'.
 *
 * v2 changes (see odd/tasks/opencode-v2-migration.md, evidence E1-E3/E11):
 * - No prompt positional: an argv element containing spaces arrives wrapped
 *   in literal double quotes and corrupts the prompt (E3). The prompt now
 *   travels on stdin instead -- see stdinFor() below.
 * - No --dir: the flag was removed (E1); cwd comes from the spawned
 *   process's own cwd/PWD instead (see jobrunner.mjs).
 * - No --variant: the flag was removed (E2). The variant now rides the
 *   model id as `<model>#<variant>`.
 * - Never --standalone: a private `opencode serve` reports zero
 *   credentials, zero providers, and zero models even when warm (E11), so
 *   the model id above would never resolve. This looks like an obvious
 *   "fix" to a future reader -- it is not; the shared service is the only
 *   mode with real provider credentials wired up.
 */
export function buildArgv({ model, prompt, mode = 'read', title, variant, sessionId }) {
  const agent = mode === 'write' ? 'build' : 'plan'
  const modelId = variant && !model.includes('#') ? `${model}#${variant}` : model
  const args = ['run', '-m', modelId, '--format', 'json', '--agent', agent]
  if (title) args.push('--title', title)
  if (sessionId) args.push('-s', sessionId)
  if (mode === 'write') args.push('--auto')
  return args
}

/**
 * The prompt now reaches opencode via stdin instead of argv (E3/E4): a
 * prompt passed as an argv element arrives wrapped in literal double
 * quotes, corrupting it, while the same text on stdin arrives verbatim.
 */
export function stdinFor({ prompt }) {
  return prompt
}

/**
 * Optional adapter hook (see jobrunner.mjs): on a timeout, the kill ladder's
 * SIGINT is only best-effort (opencode's own SIGINT handler fires
 * `session.interrupt` but swallows its rejection) and a SIGKILL never
 * reaches the server at all, so the server-side session can be left running
 * and spending tokens after this process has moved on (E19). This builds
 * the argv for the verified, idempotent cleanup call:
 * `opencode api session.interrupt --param sessionID=<id>`, which returns
 * `{"interrupted": <bool>}` and exit 0, including when the session already
 * finished (returns `false`). No other adapter defines this hook, so this
 * fallback is opencode-only.
 */
export function interruptArgv({ sessionId }) {
  return ['api', 'session.interrupt', '--param', `sessionID=${sessionId}`]
}

export function parseResult(stdout) {
  const events = parseJsonl(stdout)
  const textEvents = events.filter((e) => e.type === 'text')
  const finish = [...events].reverse().find((e) => e.type === 'step_finish')

  if (textEvents.length === 0) {
    return { ok: false, raw: events }
  }

  // v2 can emit several assistant messages in one run (E7): concatenating
  // every `text` event splices unrelated turns together (a real capture
  // produced "PONG" followed by an unrelated "Ready to plan..." turn). Group
  // by part.messageID, preserving stream order, and keep only the last
  // group. An event missing messageID still groups fine (under the
  // `undefined` key) instead of throwing.
  const groupOrder = []
  const groups = new Map()
  for (const e of textEvents) {
    const key = e.part?.messageID
    if (!groups.has(key)) {
      groups.set(key, [])
      groupOrder.push(key)
    }
    groups.get(key).push(e)
  }
  const lastMessageEvents = groups.get(groupOrder[groupOrder.length - 1])

  // v2's step_finish.part.tokens has no `total` field (E5): it is
  // {input, output, reasoning, cache:{read,write}}. We sum every component,
  // including cache read/write, into the reported total: cache tokens still
  // represent real work done against the provider, and this matches the
  // `total` this adapter reported pre-v2 (verified against a real capture
  // where total === input+output+reasoning+cache.read+cache.write).
  const tokenParts = finish?.part?.tokens
  const tokens = tokenParts
    ? (tokenParts.input ?? 0) + (tokenParts.output ?? 0) + (tokenParts.reasoning ?? 0) + (tokenParts.cache?.read ?? 0) + (tokenParts.cache?.write ?? 0)
    : null

  return {
    ok: true,
    text: lastMessageEvents.map((e) => e.part?.text ?? '').join(''),
    tokens,
    costUsd: finish?.part?.cost ?? null,
    sessionId: events[0]?.sessionID ?? null,
    raw: events,
  }
}

/**
 * Recover the opencode session id from whatever stdout was captured. Every
 * NDJSON line carries a top-level sessionID (E19), so this works on the
 * partial output of a run that was killed before it could finish -- which is
 * exactly when the id is needed, to interrupt the still-live server-side
 * session (see interruptArgv).
 */
export function sessionIdFrom(stdout) {
  return parseJsonl(stdout).find((e) => e.sessionID)?.sessionID ?? null
}

export function classifyError(stdout, exitInfo = {}) {
  if (exitInfo.timedOut) {
    // Every NDJSON line carries a top-level sessionID (E19), so it is
    // recoverable from partial stdout even when the run never reached a
    // terminal parse. jobrunner uses this to fire a best-effort server-side
    // session.interrupt (see interruptArgv below): our own SIGINT is only
    // best-effort (opencode's handler swallows a rejected session.interrupt
    // call), and a SIGKILL never reaches the server at all.
    return {
      kind: 'timeout',
      retriable: true,
      message: 'opencode hard timeout (it handles SIGINT but not SIGTERM; the process group was SIGKILLed)',
      sessionId: sessionIdFrom(stdout),
    }
  }

  if (exitInfo.code === 130) {
    // v2 exit codes are meaningful (E16): 130 is SIGINT/interrupt, not a
    // crash. Our own kill ladder sends SIGINT first (E13), so this is
    // reachable in normal operation, not only from an external Ctrl-C.
    return { kind: 'canceled', retriable: true, message: 'opencode run was interrupted (exit 130 / SIGINT)' }
  }

  const events = parseJsonl(stdout)
  // v2's `run` only ever emits `error`, never `session.error` (E18) — that
  // branch was dead against the real CLI and has been removed.
  const errorEvent = events.find((e) => e.type === 'error')
  if (errorEvent) {
    const msg = JSON.stringify(errorEvent).toLowerCase()
    // Real capture: DeepSeek returned statusCode:402 "Insufficient Balance".
    // Distinct, non-retriable kind so the circuit breaker opens immediately
    // instead of waiting on the quota/canceled failureThreshold.
    if (/"statuscode":402|insufficient balance|payment required/.test(msg)) {
      return { kind: 'billing', retriable: false, message: 'opencode billing error (402/insufficient balance)' }
    }
    if (/429|rate limit|quota/.test(msg)) return { kind: 'quota', retriable: true, message: 'opencode quota/rate-limit error event' }
    if (/401|unauthorized|not authenticated/.test(msg)) return { kind: 'auth', retriable: false, message: 'opencode auth error event' }
    // Real capture: opencode 2.x replaces its shared `serve --service`
    // process on a version mismatch (auto-update), and every attached run
    // gets {error:{message:"Transport"}} at once. The model did nothing
    // wrong, so this must not count as a crash against it; the transport
    // policy retries and the transport breaker class tolerates bursts.
    //
    // T4 (opencode-live-catalog, job 0ebdbb0a): a second real capture had
    // error.message = "Transport: The socket connection was closed
    // unexpectedly. For more information, pass `verbose: true` ..." --
    // the original `^transport$` only matched the bare word, and "socket
    // connection was closed" is worded differently from "socket hang up",
    // so this longer message fell through to the generic crash branch
    // below. Extending the SAME pattern here (not a parallel branch) so the
    // two real captures and the synthetic fixtures all agree on one rule.
    const errorMessage = String(errorEvent.error?.message ?? '').toLowerCase()
    if (/^transport(:|$)|econnreset|econnrefused|socket hang up|socket connection was closed|fetch failed/.test(errorMessage)) {
      return { kind: 'transport', retriable: true, message: 'opencode lost its connection to the opencode service (transport error)' }
    }
    // T4: an unsupported reasoning-effort variant reaching the live CLI
    // (src/catalog.mjs's validateVariant should normally drop it before
    // spawn, but stale/missing catalog data can still let one through, or
    // the model can have no route to any provider for other reasons).
    // Non-retriable -- retrying the exact same model#variant would fail
    // identically every time -- and distinct from 'crash' so it is never
    // mistaken for the model itself misbehaving. The original message is
    // preserved verbatim (not replaced with a generic string) since it
    // names the offending model/variant.
    const errorType = String(errorEvent.error?.type ?? '')
    if (errorType === 'provider.no-route' || /provider\.no-route|variant unavailable/.test(errorMessage)) {
      return { kind: 'no_route', retriable: false, message: errorEvent.error?.message ?? 'opencode reported provider.no-route' }
    }
    return { kind: 'crash', retriable: false, message: 'opencode reported an error event' }
  }

  const hasText = events.some((e) => e.type === 'text')
  if (!hasText) {
    // Documented: text/step_finish events can be silently dropped from the stream.
    return { kind: 'empty', retriable: true, message: 'opencode stream had no text event (dropped)' }
  }
  return null
}

/**
 * v1's `models <provider> --verbose` scrape is gone (E8): the machine-
 * readable catalog is now one server-side call, `opencode api model.list`,
 * whose stdout is a JSON envelope `{location, data:[...]}` covering every
 * provider in one shot (E9). Each entry becomes `{id, label, cost, limit,
 * variants}`; `id` is rebuilt as `${providerID}/${id}` because that exact
 * string is the key preflight.mjs compares by strict equality against
 * DELEGATION_MAP/MODEL_REGISTRY (see buildArgv's doc above) -- getting this
 * wrong silently marks every model unavailable. `cost` (now an array) and
 * `limit` (`{context, output}`) are passed through as-is: nothing in this
 * codebase consumes them today, so there is no existing shape to preserve.
 *
 * Fallback: if stdout is not that JSON envelope (server down, a refusal, or
 * any other malformed response), this parses it instead as the flat
 * `opencode models` output -- one bare "<provider>/<id>" per line -- and
 * returns those ids with no metadata. Returning ids without metadata still
 * lets preflight's L1 catalog check pass; returning an empty array here would
 * mark every model unavailable instead.
 */
export function listModels(stdout) {
  return parseModelListEnvelope(stdout) ?? parseFlatModelList(stdout)
}

function parseModelListEnvelope(stdout) {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!parsed || !Array.isArray(parsed.data)) return null
  return parsed.data.map((m) => ({
    id: `${m.providerID}/${m.id}`,
    label: m.name,
    cost: m.cost,
    limit: m.limit,
    variants: m.variants,
  }))
}

// A valid flat-list line is exactly "<provider>/<id>": both segments start
// with a lowercase letter (id may also start with a digit) and continue with
// lowercase letters/digits/hyphen/underscore/dot only -- no whitespace, no
// uppercase, no colon. This is deliberately strict so stray CLI output never
// becomes a fake model: an HTTP status line ("HTTP/1.1 400 Bad Request")
// fails on its uppercase prefix and embedded space, a usage/help line
// ("usage: opencode [options]") has no slash to match at all, and a JSON
// fragment fails on its braces/quotes. Every real id observed against the
// live catalog (e.g. "opencode/muse-spark-1.3-contributor-free",
// "deepseek/deepseek-v4-flash") still matches.
// v2 ids are `provider/model#variant`: the provider ends at the FIRST slash
// and the model may itself contain more (openrouter/anthropic/claude-sonnet-4.5).
// Kept deliberately strict otherwise -- lowercase-led, no whitespace -- so an
// HTTP status line, a usage banner or a JSON fragment never becomes a model.
const FLAT_ID_LINE = /^[a-z][a-z0-9_-]*\/[a-z0-9][a-z0-9._\-\/]*(?:#[a-z0-9._-]+)?$/

function parseFlatModelList(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => FLAT_ID_LINE.test(line))
    .map((id) => ({ id }))
}
