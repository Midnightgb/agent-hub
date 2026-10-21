import { syncAgysMcpConfigs } from './providers/agy-mcp.mjs'

const USAGE = 'Usage: agent-hub agys sync-mcp [--dry-run]'

function formatProfile(row) {
  if (!row.changed) return `  ${row.profile}: up to date`
  const parts = []
  if (row.added.length > 0) parts.push(`added ${row.added.join(', ')}`)
  if (row.updated.length > 0) parts.push(`updated ${row.updated.join(', ')}`)
  const suffix = row.written ? (row.backup ? ` (backup: ${row.backup})` : ' (new file)') : ' (dry run, not written)'
  return `  ${row.profile}: ${parts.join('; ')}${suffix}`
}

/**
 * `agent-hub agys sync-mcp`: copy the base agy MCP servers
 * (~/.gemini/config/mcp_config.json, written by `agy mcp add`) into every
 * agys profile, keeping profile-only servers. Writes by default (a .bak of
 * each changed file first); --dry-run only prints what would change.
 */
export async function runAgysCli(argv, { env = process.env, log = console.log, error = console.error } = {}) {
  const [command, ...flags] = argv
  if (command !== 'sync-mcp') {
    error(`agent-hub agys: unknown command "${command ?? ''}". ${USAGE}`)
    return 1
  }
  const unknown = flags.filter((f) => f !== '--dry-run')
  if (unknown.length > 0) {
    error(`agent-hub agys sync-mcp: unknown option ${unknown.join(' ')}. ${USAGE}`)
    return 1
  }

  const apply = !flags.includes('--dry-run')
  const report = syncAgysMcpConfigs({ env, apply })
  log(`base: ${report.baseFile} (${report.baseServers.length > 0 ? report.baseServers.join(', ') : 'no servers'})`)
  if (report.profiles.length === 0) {
    log('no agys profiles found')
    return 0
  }
  for (const row of report.profiles) log(formatProfile(row))
  return 0
}
