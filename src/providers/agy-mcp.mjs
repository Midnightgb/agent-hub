import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * agy reads its MCP servers from <HOME>/.gemini/config/mcp_config.json. agys
 * runs every profile with HOME=~/.agys/profiles/<name>/, so each profile has
 * its own copy of that file and a server added with `agy mcp add` (which
 * writes the base file) is invisible to profile-run jobs until it is copied.
 * Everything here is synchronous, read-only (except the two sync functions)
 * and never throws on a missing, empty or invalid file: that means "no
 * servers". Config reads follow symlinks, so a profile whose mcp_config.json
 * links to the base one (agys sync) reports the base servers.
 */

export function homeDirOf(env = process.env) {
  const home = env?.HOME
  return typeof home === 'string' && home.trim() !== '' ? home : os.homedir()
}

export function mcpConfigPath(homeDir) {
  return path.join(homeDir, '.gemini', 'config', 'mcp_config.json')
}

export function agysProfilesRoot(env = process.env) {
  return path.join(homeDirOf(env), '.agys', 'profiles')
}

export function profileHomeDir(name, env = process.env) {
  return path.join(agysProfilesRoot(env), name)
}

/** Parsed config object, or null for a missing, empty or invalid file. */
function readConfig(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    if (text.trim() === '') return null
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function serversOf(config) {
  const servers = config?.mcpServers
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {}
}

export function readMcpServers(file) {
  return serversOf(readConfig(file))
}

export function isBrowserServer(name, server) {
  if (!server || typeof server !== 'object' || server.disabled === true) return false
  if (String(name).toLowerCase() === 'playwright') return true
  const parts = [server.command, ...(Array.isArray(server.args) ? server.args : [])]
  return parts.some((part) => typeof part === 'string' && part.includes('@playwright/mcp'))
}

export function hasBrowserServer(file) {
  return Object.entries(readMcpServers(file)).some(([name, server]) => isBrowserServer(name, server))
}

/** Profile names: one directory per profile under ~/.agys/profiles. */
export function listProfileDirs(env = process.env) {
  try {
    return fs
      .readdirSync(agysProfilesRoot(env), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export function profileHasBrowser(name, env = process.env) {
  if (typeof name !== 'string' || name.trim() === '') return false
  return hasBrowserServer(mcpConfigPath(profileHomeDir(name.trim(), env)))
}

/** Per-config browser detection: the base agy config plus every agys profile. */
export function agyBrowserStatus(env = process.env) {
  const profiles = {}
  for (const name of listProfileDirs(env)) profiles[name] = profileHasBrowser(name, env)
  return { base: hasBrowserServer(mcpConfigPath(homeDirOf(env))), profiles }
}

/**
 * Whether the config an agy job will actually use has a browser server, given
 * the agys mode: 'off' runs plain agy (base config); 'profile' runs the pinned
 * profile; 'auto' can pick any profile (profile selection prefers one with a
 * browser), or plain agy when no profile exists.
 */
export function agyBrowserAvailable({ mode = 'auto', profile = null } = {}, env = process.env) {
  if (mode === 'off') return hasBrowserServer(mcpConfigPath(homeDirOf(env)))
  if (mode === 'profile') return profileHasBrowser(profile, env)
  const names = listProfileDirs(env)
  if (names.length === 0) return hasBrowserServer(mcpConfigPath(homeDirOf(env)))
  return names.some((name) => profileHasBrowser(name, env))
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Merge the base agy mcpServers into every agys profile config. A base server
 * replaces a same-named profile server; profile-only servers and any other
 * top-level keys are kept. A changed file is copied to <file>.bak first (when
 * it exists). With apply:false nothing is written and the same report is
 * returned.
 */
export function syncAgysMcpConfigs({ env = process.env, apply = true } = {}) {
  const baseFile = mcpConfigPath(homeDirOf(env))
  const baseServers = readMcpServers(baseFile)
  const results = []

  for (const name of listProfileDirs(env)) {
    const file = mcpConfigPath(profileHomeDir(name, env))
    // A profile config linked to the base one (default `agys sync` mode) is
    // replaced by a real copy, so merging never writes through to the base.
    const linked = isSymlink(file)
    const config = readConfig(file) ?? {}
    const current = serversOf(config)
    const added = []
    const updated = []
    for (const [serverName, server] of Object.entries(baseServers)) {
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) added.push(serverName)
      else if (!sameJson(current[serverName], server)) updated.push(serverName)
    }
    const changed = linked || added.length > 0 || updated.length > 0
    let backup = null
    if (changed && apply) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (linked) fs.unlinkSync(file)
      else if (fs.existsSync(file)) {
        backup = `${file}.bak`
        fs.copyFileSync(file, backup)
      }
      const next = { ...config, mcpServers: { ...current, ...baseServers } }
      fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
    }
    results.push({ profile: name, file, added, updated, unlinked: linked, changed, written: changed && apply, backup })
  }

  return { baseFile, baseServers: Object.keys(baseServers), profiles: results }
}

/** Paths under <HOME>/.gemini that every agys profile shares with the base HOME. */
export const AGY_SHARED_PATHS = Object.freeze([
  'GEMINI.md',
  'skills',
  'antigravity/skills',
  'antigravity-cli/skills',
  'config/mcp_config.json',
])

export const AGY_MCP_CONFIG_REL = 'config/mcp_config.json'

function isSymlink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink()
  } catch {
    return false
  }
}

function isEmptyEntry(stat, file) {
  if (stat.isDirectory()) return fs.readdirSync(file).length === 0
  return stat.size === 0
}

function freeBackupPath(file, epoch) {
  let candidate = `${file}.bak-${epoch}`
  for (let i = 1; fs.existsSync(candidate) || isSymlink(candidate); i++) candidate = `${file}.bak-${epoch}-${i}`
  return candidate
}

/**
 * What linking `target` to `base` needs: 'skipped' (no base path), 'ok'
 * (already the right symlink), 'linked' (nothing there), 'relinked' (a symlink
 * to somewhere else), 'replaced-empty' (an empty file or directory) or
 * 'backed-up' (a non-empty real file or directory, moved to .bak-<epoch>).
 */
function planLink(base, target) {
  if (!fs.existsSync(base)) return 'skipped'
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch {
    return 'linked'
  }
  if (stat.isSymbolicLink()) {
    const resolved = path.resolve(path.dirname(target), fs.readlinkSync(target))
    return resolved === base ? 'ok' : 'relinked'
  }
  return isEmptyEntry(stat, target) ? 'replaced-empty' : 'backed-up'
}

/**
 * Symlink the shared base agy paths (GEMINI.md, user skills dirs and,
 * unless `mcpMerge`, config/mcp_config.json) into every agys profile's
 * .gemini, so profile-run agy jobs see the user's global setup. Idempotent: a
 * correct symlink is left alone, a missing base path is skipped, an empty
 * file or directory is replaced and a non-empty one is moved to
 * <path>.bak-<epoch> first. With `mcpMerge` the MCP config keeps the previous
 * per-profile merge (syncAgysMcpConfigs). With apply:false nothing is written
 * and the same report is returned.
 */
export function syncAgysProfiles({ env = process.env, apply = true, mcpMerge = false, now = Date.now } = {}) {
  const baseGemini = path.join(homeDirOf(env), '.gemini')
  const shared = AGY_SHARED_PATHS.filter((rel) => !(mcpMerge && rel === AGY_MCP_CONFIG_REL))
  const epoch = Math.floor(now() / 1000)
  const profiles = []

  for (const name of listProfileDirs(env)) {
    const profileGemini = path.join(profileHomeDir(name, env), '.gemini')
    const links = []
    for (const rel of shared) {
      const base = path.join(baseGemini, rel)
      const target = path.join(profileGemini, rel)
      const action = planLink(base, target)
      let backup = null
      if (action === 'backed-up') backup = freeBackupPath(target, epoch)
      if (apply && action !== 'skipped' && action !== 'ok') {
        if (action === 'backed-up') fs.renameSync(target, backup)
        else if (action === 'relinked') fs.unlinkSync(target)
        else if (action === 'replaced-empty') fs.rmSync(target, { recursive: true, force: true })
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.symlinkSync(base, target, fs.statSync(base).isDirectory() ? 'dir' : 'file')
      }
      links.push({ path: rel, target, base, action, backup, written: apply && action !== 'skipped' && action !== 'ok' })
    }
    profiles.push({ profile: name, links })
  }

  const mcp = mcpMerge ? syncAgysMcpConfigs({ env, apply }) : null
  return { baseDir: baseGemini, mcpMerge, profiles, mcp }
}
