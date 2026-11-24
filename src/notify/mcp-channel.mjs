/**
 * Claude Code "channels": a one-way push of a job's terminal state into the
 * session as a <channel> event (https://code.claude.com/docs/en/channels-reference).
 * Legacy 2025-era connections only: Claude Code does not register channels on
 * protocol revision 2026-07-28, where tasks do the job.
 *
 * Opt in with AGENT_HUB_CHANNEL=1; Claude Code additionally has to load this
 * server as a channel (--dangerously-load-development-channels server:<name>
 * while channels are a research preview), otherwise it drops the events
 * silently. The tool results are never changed by this.
 */
import { noticeText } from './mcp-jobs.mjs'

export const CHANNEL_CAPABILITY = 'claude/channel'
export const CHANNEL_METHOD = 'notifications/claude/channel'
export const CHANNEL_INSTRUCTIONS =
  'Events from agent-hub arrive as <channel source="agent-hub" job_id="..." status="..." error_kind="...">. ' +
  'Each one reports that a delegated job reached a terminal state (succeeded, failed or canceled); ' +
  'on a failure the body gives errorKind, error, agent/model and, for dispatch, the fallbacks tried. ' +
  'They are one-way: read job_result for the output and act, no reply is expected.'

export function channelEnabled(env = process.env) {
  return String(env?.AGENT_HUB_CHANNEL ?? '').trim() === '1'
}

/** Channel meta keys must be identifiers and every value a string; null/empty entries are dropped. */
function channelMeta(notice) {
  const meta = {
    job_id: notice.jobId,
    status: notice.status,
    error_kind: notice.errorKind,
    agent: notice.agent,
    model: notice.model,
    tool: notice.tool,
  }
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => typeof v === 'string' && v !== ''))
}

/**
 * Push one channel event for a finished job's notice. Fire and forget: a failure
 * to deliver (for example a 2026-07-28 connection, where channels do not register)
 * never reaches the tool call.
 */
export async function pushChannelNotice(mcpServer, notice) {
  try {
    await mcpServer.server.notification({
      method: CHANNEL_METHOD,
      params: { content: noticeText(notice), meta: channelMeta(notice) },
    })
  } catch {}
}
