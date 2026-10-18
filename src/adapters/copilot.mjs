import { parseJsonl } from './base.mjs'

export const id = 'copilot'

// same-tree-fanout (S1): read mode passes --deny-tool=write/shell, so the CLI
// itself enforces read-only and a read job may run in the caller's tree.
export const readPolicy = 'enforced'
export const cmd = 'copilot'

/**
 * Argv only. Read mode denies write/shell tools (deny wins over allow);
 * write mode allows everything. --add-dir goes last, matching agy-delegate's
 * pattern of granting access to the cwd explicitly. copilot has no session
 * resume and no reasoning-effort flag, so title/variant/timeoutS/sessionId
 * are accepted (for the shared adapter contract) but unused.
 */
export function buildArgv({ model, prompt, cwd, mode = 'read', title, variant, timeoutS, sessionId }) {
  const args = ['-p', prompt, '-s', '--output-format', 'json', '--model', model, '--no-ask-user']
  if (mode === 'read') {
    args.push('--deny-tool=write', '--deny-tool=shell')
  } else {
    args.push('--allow-all-tools')
  }
  args.push('--add-dir', cwd)
  return args
}

export function parseResult(stdout) {
  const events = parseJsonl(stdout)
  const resultEvent = [...events].reverse().find((e) => e.type === 'result')
  const messageEvents = events.filter((e) => e.type === 'assistant.message')
  const lastMessage = messageEvents[messageEvents.length - 1]
  const toolDenials = events
    .filter((e) => e.type === 'tool.execution_complete' && e.data?.success === false && e.data?.error?.code === 'denied')
    .map((e) => ({ tool: e.data?.toolName, message: e.data?.error?.message }))

  if (!resultEvent || resultEvent.exitCode !== 0) {
    return { ok: false, raw: events, toolDenials }
  }

  return {
    ok: true,
    text: lastMessage?.data?.content ?? '',
    tokens: null, // copilot's JSON stream never reports a token count, only premiumRequests
    premiumRequests: resultEvent.usage?.premiumRequests ?? null,
    sessionId: resultEvent.sessionId ?? null,
    toolDenials,
    raw: events,
  }
}

export function classifyError(stdout, exitInfo = {}) {
  if (exitInfo.timedOut) return { kind: 'timeout', retriable: true, message: 'copilot hard timeout' }

  const events = parseJsonl(stdout)
  const resultEvent = [...events].reverse().find((e) => e.type === 'result')
  if (resultEvent && resultEvent.exitCode === 0) return null

  // The --model flag's client-side allowlist does not track `copilot help
  // config`'s documented catalog and was observed to reject most of it —
  // this is necessary but not sufficient; only an L3 ping confirms a model.
  // Distinct kind (not 'crash'): this is a known, non-retriable routing
  // mismatch, not an unexpected failure — preflight/router treat it specially.
  const modelUnavailable = stdout.match(/Model "(.+?)" from --model flag is not available/)
  if (modelUnavailable) {
    return {
      kind: 'model_unavailable',
      retriable: false,
      message: `requested --model "${modelUnavailable[1]}" is not available for this account`,
    }
  }
  if (/not authenticated|GH_TOKEN|GITHUB_TOKEN/i.test(stdout)) {
    return { kind: 'auth', retriable: false, message: 'copilot not authenticated' }
  }
  if (/429|rate limit|quota/i.test(stdout)) {
    return { kind: 'quota', retriable: true, message: 'copilot quota/rate limit' }
  }
  return { kind: 'crash', retriable: false, message: 'copilot exited without a successful result event' }
}

/**
 * Parse `copilot help config`'s documented `model` catalog. Advisory only:
 * measured against the live account, most of these ids were rejected by
 * --model with "is not available" — this list is necessary but not
 * sufficient for L1; router/preflight must still L3-ping before trusting a
 * specific model.
 */
export function listModels(stdout) {
  const lines = stdout.split(/\r?\n/)
  const startIdx = lines.findIndex((l) => l.includes('`model`:'))
  if (startIdx === -1) return []

  const models = []
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(/^\s*-\s*"([^"]+)"\s*$/)
    if (match) {
      models.push({ id: match[1], label: match[1] })
    } else if (models.length > 0) {
      break
    }
  }
  return models
}
