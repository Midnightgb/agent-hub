import { parseJsonl } from './base.mjs'

export const id = 'gentle-shell'
export const cmd = 'gentle-shell'

// same-tree-fanout (S1): read mode passes pi a tool allowlist with no write,
// edit or bash tool and disables MCP, so the CLI itself cannot write and a
// read job may run in the caller's tree.
export const readPolicy = 'enforced'

const READ_TOOLS = 'read,grep,find,ls'

// The `--list-models` catalog from an OpenAI-compatible custom provider
// (`compat-custom`, e.g. AI Horde image models) is not usable for coding.
const SKIPPED_PROVIDERS = new Set(['compat-custom'])

/**
 * Argv only, never a shell. gentle-shell launches pi with the Gentle Shell
 * package and its own isolated agent home; everything after the first `--`
 * is handed to pi unchanged. The trailing `--` ends pi's option parsing so a
 * prompt that starts with a dash stays a message.
 *
 * Model ids are pi's `provider/id` form (e.g. `anthropic/claude-sonnet-5-5`),
 * the same spelling listModels() returns; 'default' leaves the home's
 * configured default model in place.
 *
 * Sessions are persisted (no --no-session) so job_reply can resume them.
 * Resume uses --fork, not --session: pi stores sessions per project cwd, and
 * `--session <id>` from another cwd asks "Fork this session into current
 * directory? [y/N]" on stdin, which a detached job answers "no" (verified
 * live). --fork copies the conversation into a new session in the spawn cwd
 * without asking, and that new session id is what the reply job records.
 */
export function buildArgv({ model, prompt, mode = 'read', sessionId, variant }) {
  const args = ['--', '-p', '--mode', 'json']
  if (sessionId) args.push('--fork', sessionId)
  if (model && model !== 'default') args.push('--model', model)
  if (variant) args.push('--thinking', variant)
  if (mode !== 'write') args.push('--tools', READ_TOOLS, '--no-mcp')
  args.push('--', prompt)
  return args
}

function turnEnds(events) {
  return events.filter((e) => e.type === 'turn_end' && e.message?.role === 'assistant')
}

function textOf(message) {
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
}

/**
 * Every turn's usage summed into the hub's token contract, a plain number
 * (JobRecord/HubEvent `tokens`, like opencode): input plus cache reads and
 * writes plus output. pi's `reasoning` is already part of `output`, as with
 * Anthropic's output_tokens, so it is not added again.
 */
function sumUsage(turns) {
  const usages = turns.map((t) => t.message.usage).filter(Boolean)
  if (usages.length === 0) return { tokens: null, costUsd: null }
  const sum = (pick) => usages.reduce((total, u) => total + (pick(u) ?? 0), 0)
  return {
    tokens: sum((u) => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0)),
    costUsd: sum((u) => u.cost?.total),
  }
}

export function parseResult(stdout) {
  const events = parseJsonl(stdout)
  const turns = turnEnds(events)
  const last = turns.at(-1)?.message
  const failed = !last || last.stopReason === 'error' || last.stopReason === 'aborted'
  const text = failed ? '' : textOf(last)
  const { tokens, costUsd } = sumUsage(turns)

  return {
    ok: !failed && text.length > 0,
    text,
    tokens,
    costUsd,
    sessionId: events.find((e) => e.type === 'session')?.id ?? null,
    raw: events,
  }
}

/**
 * pi reports a provider failure inside the stream, not through the exit code
 * (it exits 0): the last assistant turn_end carries stopReason 'error' and an
 * errorMessage of the form `<status> <provider JSON body>`.
 */
export function classifyError(stdout, exitInfo = {}) {
  if (exitInfo.timedOut) {
    return { kind: 'timeout', retriable: true, message: 'gentle-shell hard timeout' }
  }

  const last = turnEnds(parseJsonl(stdout)).at(-1)?.message
  if (last?.stopReason === 'error') {
    const message = String(last.errorMessage ?? 'gentle-shell turn failed')
    if (/^429\b|usage limit|rate[ _]limit|quota|credit balance/i.test(message)) {
      return { kind: 'quota', retriable: true, message: `gentle-shell quota/rate limit: ${message}` }
    }
    if (/^40[13]\b|authentication_error|permission_error|x-api-key|unauthori[sz]ed/i.test(message)) {
      return { kind: 'auth', retriable: false, message: `gentle-shell not authenticated: ${message}` }
    }
    if (/^404\b|not_found_error|model is unavailable/i.test(message)) {
      return { kind: 'model_unavailable', retriable: false, message: `gentle-shell model unavailable: ${message}` }
    }
    return { kind: 'crash', retriable: false, message }
  }

  if (!textOf(last)) {
    return { kind: 'empty', retriable: true, message: 'gentle-shell produced no assistant text and no error turn' }
  }
  return null
}

/**
 * Parse `pi --list-models`: a header row, then whitespace-aligned columns
 * provider, model, context, max-out, thinking, images. Only providers the
 * agent home is signed in to are listed, so a listed model is also an
 * authenticated one.
 */
export function listModels(stdout) {
  const models = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s{2,}/)
    if (cols.length < 3 || cols[0] === 'provider') continue
    const [provider, model, context] = cols
    if (SKIPPED_PROVIDERS.has(provider)) continue
    models.push({ id: `${provider}/${model}`, label: `${model} (${provider}, ${context} ctx)` })
  }
  return models
}
