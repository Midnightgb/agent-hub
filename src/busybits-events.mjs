import { parseJsonl } from './adapters/base.mjs'

/**
 * Busybits office feed. Busybits reads `<runsDir>/<jobId>/stdout.log` and only
 * understands agy/copilot streams natively; opencode and codex rows show up as
 * a single opaque "respond" chunk. This module translates their raw JSONL into
 * the Copilot event shape Busybits already maps to activities
 * (`tool.execution_start`, `assistant.message`, `reasoning`) and the job
 * runner mirrors it into `<jobId>/events.jsonl`. Pure functions, no I/O.
 */

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined)

function toolStart(id, toolName, args, at) {
  return { type: 'tool.execution_start', data: { toolCallId: id, toolName, arguments: args }, id, ...(at ? { timestamp: at } : {}) }
}
const message = (id, content, at) => ({ type: 'assistant.message', data: { messageId: id, content }, id, ...(at ? { timestamp: at } : {}) })
const reasoning = (id, at) => ({ type: 'reasoning', data: { messageId: id }, id, ...(at ? { timestamp: at } : {}) })

/** One raw codex `exec --json` event -> zero or more Busybits events. */
export function fromCodexEvent(event) {
  if (event?.type !== 'item.started' && event?.type !== 'item.completed') return []
  const item = obj(event.item)
  const id = str(item?.id)
  if (!item || !id) return []
  const started = event.type === 'item.started'
  switch (item.type) {
    case 'command_execution':
      // Emitted on start only: the completion repeats the same call id.
      return started && str(item.command) ? [toolStart(id, 'bash', { command: item.command })] : []
    case 'file_change': {
      if (started) return []
      const change = Array.isArray(item.changes) ? obj(item.changes[0]) : undefined
      const path = str(change?.path)
      return path ? [toolStart(id, change.kind === 'add' ? 'write' : 'edit', { path })] : []
    }
    case 'mcp_tool_call':
      return started && str(item.tool) ? [toolStart(id, str(item.tool), obj(item.arguments) ?? {})] : []
    case 'web_search':
      return str(item.query) ? [toolStart(id, 'search_web', { query: item.query })] : []
    case 'reasoning':
      return started ? [] : [reasoning(id)]
    case 'agent_message':
      return !started && str(item.text) ? [message(id, item.text.trim())] : []
    default:
      return []
  }
}

/** One raw opencode `run --format json` event -> zero or more Busybits events. */
export function fromOpencodeEvent(event) {
  const part = obj(event?.part)
  if (!part) return []
  const at = Number.isFinite(event.timestamp) ? new Date(event.timestamp).toISOString() : undefined
  const id = str(part.callID) ?? str(part.id)
  if (event.type === 'tool_use') {
    const status = part.state?.status
    // `pending`/`running` and `completed` all describe the same call: announce it once, when first seen with input.
    if (!str(part.tool) || !id || (status !== 'running' && status !== 'completed')) return []
    return [toolStart(id, part.tool, obj(part.state?.input) ?? {}, at)]
  }
  if (event.type === 'reasoning' && id) return [reasoning(id, at)]
  if (event.type === 'text' && id && str(part.text) && part.time?.end !== undefined) return [message(id, part.text.trim(), at)]
  return []
}

const TRANSLATORS = { codex: fromCodexEvent, opencode: fromOpencodeEvent }

/** True for the agents whose raw output needs translating for Busybits. */
export const hasBusybitsTranslator = (agent) => Object.hasOwn(TRANSLATORS, agent)

/** Translate a whole captured stdout (fixtures, backfill). Unknown agents yield []. */
export function toBusybitsEvents(agent, stdout) {
  const translate = TRANSLATORS[agent]
  if (!translate) return []
  return dedupe(parseJsonl(stdout).flatMap(translate))
}

function dedupe(events) {
  const seen = new Set()
  return events.filter((e) => {
    const key = `${e.type}:${e.id}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Streaming variant for the job runner: feed raw stdout chunks (which may split
 * lines), receive each new event through `emit` as a JSON line. Never throws.
 */
export function createBusybitsEventStream(agent, emit) {
  const translate = TRANSLATORS[agent]
  if (!translate) return null
  let buffer = ''
  const seen = new Set()
  const flushLine = (line) => {
    for (const event of parseJsonl(line).flatMap(translate)) {
      const key = `${event.type}:${event.id}`
      if (seen.has(key)) continue
      seen.add(key)
      try { emit(`${JSON.stringify(event)}\n`) } catch { /* the feed is best-effort */ }
    }
  }
  return {
    write(chunk) {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        flushLine(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    },
    end() {
      if (buffer) flushLine(buffer)
      buffer = ''
    },
  }
}
