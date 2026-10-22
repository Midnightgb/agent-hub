import { extractLastJsonLine, parseJsonl } from './base.mjs'

export const id = 'agy'

// same-tree-fanout (S2): `--mode plan` is known to write anyway, so read jobs
// run in a hub-managed scratch copy of the caller's tree (src/scratchcopy.mjs).
export const readPolicy = 'scratch'
export const cmd = 'agy'

/**
 * D1 (agy-hub-verification): agy 1.2.8's `run_command` auto-detaches a slow
 * command into a background task and its own `-p` idle-exit kills it while
 * still reporting SUCCESS (upstream google-antigravity/antigravity-cli
 * #1044, #1076 -- no flag to disable). The hub therefore never lets agy run
 * tests, builds, dev servers or installs itself; it writes the code (and a
 * RED test, unexecuted) and the hub runs verification afterwards in the
 * foreground (see src/verify.mjs, docs/verification.md). This text is fixed
 * and hub-owned -- never interpolated with per-call prose -- and is injected
 * at exactly one place: buildArgv below, for agy only.
 */
export const AGY_GUARD_BLOCK =
  'Hub instructions (do not deviate): Do not run tests, builds, dev servers, package installs, ' +
  'or any other long-running command yourself -- your CLI silently kills and abandons such commands ' +
  'while still reporting success. Write the code and its tests only: a RED test is written, never ' +
  'executed. The hub runs verification itself, in the foreground, after this job ends.'

/**
 * Appended to AGY_GUARD_BLOCK only for jobs that need a browser (taskType
 * ui-test or a 'browser' requirement). Same rules: fixed, hub-owned text.
 * MCP browser tool calls are not shell commands, but "long-running command"
 * is close enough that the model could refuse them without this sentence.
 */
export const AGY_BROWSER_TOOLS_NOTE =
  'This is a UI test: use the MCP browser tools (for example Playwright navigate, snapshot, click, type) ' +
  'as needed; they are not shell commands. Do not start a dev server or install anything to reach the page.'

/**
 * Argv only, never a shell — the prompt is one argv element. agy 1.2.1's
 * --mode only accepts 'plan' or 'accept-edits' (not 'read'/'write'), so the
 * hub's own read/write mode is mapped here, not passed through verbatim.
 * --output-format stream-json (not the legacy single-line 'json') is what
 * lets parseResult/classifyError see partial text_delta output even when a
 * turn is abandoned by agy's own --print-timeout.
 *
 * `guard` (default true) prepends AGY_GUARD_BLOCK to the prompt. The only
 * sanctioned opt-out (`guard: false`) is an internal, non-user-visible flag
 * for a read-only probe that never asks agy to write or run anything (e.g.
 * preflight.mjs's pingAgent) -- every real job (delegate/dispatch/workflow),
 * which all reach this function through jobrunner.mjs's startJob, gets it.
 */
export function buildArgv({ model, prompt, cwd, mode = 'read', sessionId, timeoutS, guard = true, browserTools = false }) {
  const agyMode = mode === 'write' ? 'accept-edits' : 'plan'
  const guardText = browserTools ? `${AGY_GUARD_BLOCK} ${AGY_BROWSER_TOOLS_NOTE}` : AGY_GUARD_BLOCK
  const effectivePrompt = guard === false ? prompt : `${guardText}\n\n${prompt}`
  const args = ['-p', effectivePrompt, '--output-format', 'stream-json', '--model', model, '--mode', agyMode, '--add-dir', cwd, '--dangerously-skip-permissions']
  if (timeoutS) args.push('--print-timeout', `${timeoutS}s`)
  if (sessionId) args.push('--conversation', sessionId)
  return args
}

/**
 * Parse either shape agy can produce:
 *  - stream-json: NDJSON events {"event":"init"|"step_update"|"result",...}.
 *    The final "result" event's `result` object is the envelope; text_delta
 *    of "agent_response" step_update events accumulates as partial text.
 *  - legacy single-line json: one bare {...} envelope (no "event" wrapper),
 *    same shape agy-run.sh expects with `grep -o '^{.*}$' | tail -1`.
 */
function parseAgyStream(stdout) {
  const lines = parseJsonl(stdout)
  const streamEvents = lines.filter((e) => typeof e.event === 'string')

  if (streamEvents.length > 0) {
    const resultEvent = [...streamEvents].reverse().find((e) => e.event === 'result')
    const initEvent = streamEvents.find((e) => e.event === 'init')
    const partialText = streamEvents
      .filter((e) => e.event === 'step_update' && e.step_update?.step_type === 'agent_response')
      .map((e) => e.step_update.text_delta ?? '')
      .join('')
    return {
      resultEnvelope: resultEvent?.result ?? null,
      partialText,
      sessionId: resultEvent?.result?.conversation_id ?? initEvent?.conversation_id ?? null,
    }
  }

  const legacy = extractLastJsonLine(stdout)
  return { resultEnvelope: legacy, partialText: '', sessionId: legacy?.conversation_id ?? null }
}

export function parseResult(stdout) {
  const { resultEnvelope, partialText, sessionId } = parseAgyStream(stdout)
  if (!resultEnvelope || resultEnvelope.status !== 'SUCCESS') {
    return { ok: false, raw: resultEnvelope ?? stdout, partialText, sessionId }
  }
  return {
    ok: true,
    text: resultEnvelope.response || partialText || '',
    tokens: resultEnvelope.usage?.total_tokens ?? null,
    sessionId: resultEnvelope.conversation_id ?? sessionId ?? null,
    durationS: resultEnvelope.duration_seconds ?? null,
    raw: resultEnvelope,
  }
}

export function classifyError(stdout, exitInfo = {}) {
  const { resultEnvelope, partialText, sessionId } = parseAgyStream(stdout)

  // agy's own --print-timeout fires inside the CLI and still exits 0 with a
  // SUCCESS/empty envelope — exitInfo.timedOut (our hard-kill wrapper) is
  // false in that case, so the stdout marker must be checked too. The turn
  // itself is abandoned (verified live: resuming and asking for the answer
  // returned UNFINISHED), so this is 'timeout', not a plain empty response.
  if (exitInfo.timedOut || /\[agy\] print timeout/.test(stdout)) {
    return {
      kind: 'timeout',
      retriable: true,
      message: exitInfo.timedOut ? 'agy hard timeout' : 'agy print-timeout: turn abandoned mid-response',
      partialText,
      sessionId,
    }
  }

  // agy 1.2.x auto-detaches a slow run_command into a background task; the
  // model then "waits" by yielding its turn, and print mode ends the turn,
  // prints this marker, kills the task and still reports SUCCESS. The work
  // (usually the verification run) never finished, so this is not a success.
  // Line-anchored: agy prints the marker as its own raw line, while the same
  // text quoted in tool output or model text only ever appears JSON-escaped
  // inside a stream event line.
  const backgroundKilled = stdout.match(/^terminating (\d+) background task\(s\) on exit\r?$/m)
  if (backgroundKilled && resultEnvelope?.status === 'SUCCESS') {
    return {
      kind: 'incomplete',
      retriable: true,
      message: `agy ended the turn and killed ${backgroundKilled[1]} background task(s) the model was still waiting on`,
      partialText: resultEnvelope.response || partialText,
      sessionId,
    }
  }

  if (resultEnvelope) {
    if (resultEnvelope.status === 'SUCCESS') {
      if (!resultEnvelope.response && !partialText) {
        return { kind: 'empty', retriable: true, message: 'agy SUCCESS with an empty response and no streamed text', partialText, sessionId }
      }
      return null
    }
    if (resultEnvelope.status === 'CANCELED') {
      // Headless agy auto-denies any tool that needs a permission prompt and
      // returns an empty response with exit code 0 — this is that failure.
      return { kind: 'canceled', retriable: true, message: 'agy CANCELED (silent permission denial)', partialText, sessionId }
    }
    if (resultEnvelope.status === 'ERROR') {
      // A status:"ERROR" envelope carries the provider error in `error`
      // (e.g. "Individual quota reached ... Resets in 4h26m13s." for a 429,
      // or a 401/"not logged in" auth failure). Classify from that text
      // before falling back to a generic crash so a 429 gets a breaker and
      // failover instead of being treated as fatal.
      const providerError = resultEnvelope.error || ''
      if (/429|RESOURCE_EXHAUSTED|quota reached/i.test(providerError)) {
        return { kind: 'quota', retriable: true, message: providerError || 'agy quota exhausted', partialText, sessionId }
      }
      if (/not logged in|unauthenticated|401/i.test(providerError)) {
        return { kind: 'auth', retriable: false, message: providerError || 'agy not authenticated', partialText, sessionId }
      }
      return { kind: 'crash', retriable: false, message: providerError || `agy status=${resultEnvelope.status}`, partialText, sessionId }
    }
    return { kind: 'crash', retriable: false, message: `agy status=${resultEnvelope.status}`, partialText, sessionId }
  }

  if (/429|RESOURCE_EXHAUSTED/i.test(stdout)) {
    return { kind: 'quota', retriable: true, message: 'agy quota exhausted (429/RESOURCE_EXHAUSTED)' }
  }
  if (/not logged in|unauthenticated|401/i.test(stdout)) {
    return { kind: 'auth', retriable: false, message: 'agy not authenticated' }
  }
  return { kind: 'crash', retriable: false, message: 'agy produced no JSON envelope' }
}

/** Parse `agy models` output: lines of "id\tlabel" after a "Fetching..." banner. */
export function listModels(stdout) {
  const models = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9._-]+)\t(.+)$/)
    if (match) models.push({ id: match[1], label: match[2].trim() })
  }
  return models
}
