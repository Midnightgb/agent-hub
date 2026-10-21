import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * agy reads its MCP servers from <HOME>/.gemini/config/mcp_config.json. agys
 * runs every profile with HOME=~/.agys/profiles/<name>/, so each profile has
 * its own copy of that file and a server added with `agy mcp add` (which
 * writes the base file) is invisible to profile-run jobs until it is copied.
 * Everything here is synchronous, read-only (except syncAgysMcpConfigs) and
 * never throws on a missing, empty or invalid file: that means "no servers".
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
    const config = readConfig(file) ?? {}
    const current = serversOf(config)
    const added = []
    const updated = []
    for (const [serverName, server] of Object.entries(baseServers)) {
      if (!Object.prototype.hasOwnProperty.call(current, serverName)) added.push(serverName)
      else if (!sameJson(current[serverName], server)) updated.push(serverName)
    }
    const changed = added.length > 0 || updated.length > 0
    let backup = null
    if (changed && apply) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      if (fs.existsSync(file)) {
        backup = `${file}.bak`
        fs.copyFileSync(file, backup)
      }
      const next = { ...config, mcpServers: { ...current, ...baseServers } }
      fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
    }
    results.push({ profile: name, file, added, updated, changed, written: changed && apply, backup })
  }

  return { baseFile, baseServers: Object.keys(baseServers), profiles: results }
}
