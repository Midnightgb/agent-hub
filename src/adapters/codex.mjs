import { parseJsonl } from './base.mjs'

export const id = 'codex'
export const cmd = 'codex'

// same-tree-fanout (S1): read mode runs under codex's read-only sandbox, so a
// read job may run in the caller's tree.
export const readPolicy = 'enforced'

/**
 * Argv only, never a shell — the prompt is one argv element. `codex exec`
 * reads additional input from stdin and BLOCKS FOREVER when it is left open
 * (verified: a one-word reply hung for over two minutes). agent-hub is safe
 * because spawnDetached defaults stdin to 'ignore' (see process.mjs and the
 * pinning test in test/adapters/codex.test.mjs); the "Reading additional
 * input from stdin..." line on stderr is normal noise even then.
 *
 * The CLI's own default model is spelled 'default' here — no model name is
 * guessed — so -m is omitted for it and the CLI picks.
 *
 * `codex exec resume` does NOT accept -s/--sandbox or -C/--cd, so a resumed
 * turn runs in the spawn cwd (spawnDetached passes it) and its sandbox is set
 * through config instead: -c sandbox_mode="...". This -c route for resume was
 * inferred from `codex exec resume --help` (which lists -c but not -s) and is
 * NOT yet verified live.
 *
 * --ignore-user-config is opt-in only (env.AGENT_HUB_CODEX_IGNORE_USER_CONFIG
 * === '1'): measured, it saves only ~1,500 of ~18,800 input tokens because
 * the baseline is Codex's own system prompt, so respecting the user's
 * ~/.codex config is the right default.
 */
export function buildArgv({ model, prompt, cwd, mode = 'read', sessionId, env = {} }) {
  const sandbox = mode === 'write' ? 'workspace-write' : 'read-only'
  const ignoreUserConfig = env.AGENT_HUB_CODEX_IGNORE_USER_CONFIG === '1'
  const explicitModel = model && model !== 'default'

  if (sessionId) {
    const args = ['exec', 'resume', '--json', '--skip-git-repo-check']
    if (ignoreUserConfig) args.push('--ignore-user-config')
    args.push('-c', `sandbox_mode="${sandbox}"`)
    if (explicitModel) args.push('-m', model)
    args.push(sessionId, prompt)
    return args
  }

  const args = ['exec', '--json', '--skip-git-repo-check']
  if (ignoreUserConfig) args.push('--ignore-user-config')
  args.push('-s', sandbox, '-C', cwd)
  if (explicitModel) args.push('-m', model)
  args.push(prompt)
  return args
}

/** The last `turn.completed` usage block, mapped to the hub's token shape. */
function parseUsage(events) {
  const completed = [...events].reverse().find((e) => e.type === 'turn.completed')
  const usage = completed?.usage
  if (!usage) return null
  return {
    input: usage.input_tokens ?? null,
    cachedInput: usage.cached_input_tokens ?? null,
    output: usage.output_tokens ?? null,
    reasoning: usage.reasoning_output_tokens ?? null,
  }
}

/**
 * A `turn.failed` event is the only real failure signal: `item.completed` with
 * item.type 'error' is a warning the CLI recovers from. error.message is a
 * JSON STRING (a serialized API error), so parse it defensively and fall back
 * to the raw string.
 */
function parseTurnFailure(events) {
  const failed = [...events].reverse().find((e) => e.type === 'turn.failed')
  if (!failed) return null
  const raw = failed.error?.message ?? ''
  if (typeof raw !== 'string') return { status: null, message: String(raw), raw: String(raw) }
  try {
    const parsed = JSON.parse(raw)
    return { status: parsed?.status ?? null, message: parsed?.error?.message ?? raw, raw }
  } catch {
    // Not JSON — the CLI occasionally emits a plain string here.
    return { status: null, message: raw, raw }
  }
}

export function parseResult(stdout) {
  const events = parseJsonl(stdout)
  const text = events
    .filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
    .map((e) => e.item.text ?? '')
    .join('')
  const failed = events.some((e) => e.type === 'turn.failed')
  const sessionId = events.find((e) => e.type === 'thread.started')?.thread_id ?? null

  return {
    ok: !failed && text.length > 0,
    text,
    tokens: parseUsage(events),
    sessionId,
    raw: events,
  }
}

export function classifyError(stdout, exitInfo = {}) {
  if (exitInfo.timedOut) {
    return { kind: 'timeout', retriable: true, message: 'codex hard timeout' }
  }

  const events = parseJsonl(stdout)
  const failure = parseTurnFailure(events)

  if (failure) {
    const haystack = `${failure.message} ${failure.raw}`
    if (failure.status === 429 || /usage limit|rate limit|quota/i.test(haystack)) {
      return { kind: 'quota', retriable: true, message: `codex quota/rate limit: ${failure.message}` }
    }
    if (failure.status === 401 || failure.status === 403 || /not logged in|log ?in|unauthori[sz]ed/i.test(haystack)) {
      return { kind: 'auth', retriable: false, message: `codex not authenticated: ${failure.message}` }
    }
    if (failure.status === 400 && /model .*not supported|model metadata/i.test(haystack)) {
      return { kind: 'model_unavailable', retriable: false, message: `codex model unavailable: ${failure.message}` }
    }
    return { kind: 'crash', retriable: false, message: failure.message || 'codex turn failed' }
  }

  const hasAgentMessage = events.some((e) => e.type === 'item.completed' && e.item?.type === 'agent_message' && e.item.text)
  if (!hasAgentMessage) {
    return { kind: 'empty', retriable: true, message: 'codex produced no agent_message and no turn.failed' }
  }
  return null
}

/** Codex exposes no model-list command; only the CLI's own default is known. */
export function listModels() {
  return [{ id: 'default', label: 'Codex CLI default model' }]
}
