import { syncAgysProfiles } from './providers/agy-mcp.mjs'

const USAGE = 'Usage: agent-hub agys sync [--dry-run] [--mcp-merge]'
const FLAGS = new Set(['--dry-run', '--mcp-merge'])

const ACTION_LABELS = {
  ok: 'up to date',
  linked: 'linked',
  relinked: 'relinked',
  'replaced-empty': 'replaced empty entry with link',
  'backed-up': 'linked',
}

function formatLink(link) {
  if (link.action === 'skipped') return null
  let text = `${link.path}: ${ACTION_LABELS[link.action]}`
  if (link.backup) text += ` (backup: ${link.backup})`
  if (!link.written && link.action !== 'ok') text += ' (dry run, not written)'
  return text
}

function formatMerge(row) {
  if (!row.changed) return 'config/mcp_config.json: merge up to date'
  const parts = []
  if (row.unlinked) parts.push('replaced symlink with a copy')
  if (row.added.length > 0) parts.push(`added ${row.added.join(', ')}`)
  if (row.updated.length > 0) parts.push(`updated ${row.updated.join(', ')}`)
  const suffix = row.written ? (row.backup ? ` (backup: ${row.backup})` : '') : ' (dry run, not written)'
  return `config/mcp_config.json: merged, ${parts.join('; ')}${suffix}`
}

/**
 * `agent-hub agys sync`: make every agys profile see the base agy setup in
 * ~/.gemini (GEMINI.md, user skills dirs, MCP config) by symlinking those
 * paths into ~/.agys/profiles/<name>/.gemini. Writes by default; --dry-run
 * only prints what would change; --mcp-merge keeps a per-profile MCP config
 * and merges the base servers into it instead of linking it.
 */
export async function runAgysCli(argv, { env = process.env, log = console.log, error = console.error, now } = {}) {
  const [command, ...flags] = argv
  if (command !== 'sync') {
    error(`agent-hub agys: unknown command "${command ?? ''}". ${USAGE}`)
    return 1
  }
  const unknown = flags.filter((f) => !FLAGS.has(f))
  if (unknown.length > 0) {
    error(`agent-hub agys sync: unknown option ${unknown.join(' ')}. ${USAGE}`)
    return 1
  }

  const apply = !flags.includes('--dry-run')
  const mcpMerge = flags.includes('--mcp-merge')
  const report = syncAgysProfiles({ env, apply, mcpMerge, ...(now ? { now } : {}) })
  log(`base: ${report.baseDir}`)
  if (report.profiles.length === 0) {
    log('no agys profiles found')
    return 0
  }
  const merges = new Map((report.mcp?.profiles ?? []).map((row) => [row.profile, row]))
  for (const profile of report.profiles) {
    const lines = profile.links.map(formatLink).filter(Boolean)
    if (merges.has(profile.profile)) lines.push(formatMerge(merges.get(profile.profile)))
    log(`  ${profile.profile}:${lines.length === 0 ? ' nothing to sync (no base paths)' : ''}`)
    for (const line of lines) log(`    ${line}`)
  }
  return 0
}
