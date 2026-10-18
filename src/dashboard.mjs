import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTail, appendEvent } from './eventlog.mjs'
import { listJobs } from './jobstore.mjs'
import { getWorkGraph } from './workGraph.mjs'
import { buildExecutionGraph } from './execution-graph.mjs'
import { readCache, agentsStatus, pingAgent, breakerStatus } from './preflight.mjs'
import { cancelJob, getJobDiffStats } from './jobrunner.mjs'
import { createDiffStatsCache } from './diffstats.mjs'
import { paths, stateHome, DEFAULT_TIMEOUTS_S, CIRCUIT_BREAKER, PREFLIGHT_TTL_MS, WRITE_ALLOWLIST, MODEL_REGISTRY } from './config.mjs'
import { initDb } from './storage/index.mjs'
import { runDiscovery, readDiscovery, resolveAgentCli, KNOWN_AGENTS, pruneCacheForMap } from './discovery.mjs'
import { readOverrides, setOverride, clearOverride, overrideKey } from './overrides.mjs'
import { DELEGATION_MAP } from './router.mjs'
import { defaultPairs, agentsQuotaTool } from './tools/agents.mjs'
import { runCommand } from './process.mjs'
import { computeMetrics } from './metrics.mjs'
import { listProposals, refreshProposals, decideProposal } from './proposals.mjs'
import { computeModelGaps } from './model-gaps.mjs'
import { effectiveTier, computeCatalogDrift } from './catalog.mjs'
import { listLearnings, proposeLearning, decideLearning, deleteLearning } from './learnings.mjs'
import { jobResultTool } from './tools/jobs.mjs'
import { JobRecord } from './schemas.mjs'
import { listMcpTools } from './index.mjs'
import { startScheduler, runScheduleNow } from './scheduler.mjs'
import { createAccount, updateAccount, deleteAccount, setPolicy, listAccounts } from './accounts.mjs'
import { refreshSources, readSourcesCache, normalizedSources } from './cloud/sources.mjs'
import { createSchedule, updateSchedule, deleteSchedule } from './schedules.mjs'
import { checkRemoteSession } from './cloud/check.mjs'
import { julesAccountsTool, julesSchedulesTool, julesSessionsTool } from './tools/jules.mjs'
import { keyForAccount } from './cloud/credentials.mjs'
import { stdoutPath } from './jobstore.mjs'
import * as defaultClient from './cloud/jules/client.mjs'
import * as defaultAdapter from './cloud/jules/adapter.mjs'
import { agysProfilesSnapshot, setAgysMode } from './providers/agys.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// The Vite-built React app lands here (built by a separate package); this
// server only serves its output, never its sources.
const DEFAULT_DIST_DIR = path.join(HERE, '..', 'dashboard', 'dist')

const METRICS_GROUP_DIMENSIONS = new Set(['agent', 'model', 'mode', 'taskType'])

const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"

/** Content-Type for a known, safe static-asset extension; null (never served) for anything else. */
function distContentType(ext) {
  switch (ext) {
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.woff2':
      return 'font/woff2'
    case '.woff':
      return 'font/woff'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.ico':
      return 'image/x-icon'
    case '.json':
      return 'application/json; charset=utf-8'
    default:
      return null
  }
}

/** The `assets/<name>` tail of a manifest file entry or an index.html reference, or null when it isn't under assets/. */
function assetBaseName(ref) {
  const idx = ref.lastIndexOf('assets/')
  if (idx === -1) return null
  return ref.slice(idx + 'assets/'.length)
}

/**
 * Exact-match allowlist (urlPath -> {file, contentType, cacheControl}) built
 * from distDir's index.html and (when present) its .vite/manifest.json.
 * Every `file` value here is a path this function itself joined from a
 * discovered, known-safe asset name — never from a request URL — so the
 * request-handling side only ever does a Map lookup by exact decoded
 * pathname, with no filesystem path join from client input. Returns null
 * when index.html itself is missing (dashboard not built).
 */
function buildDistAllowlist(distDir) {
  const indexPath = path.join(distDir, 'index.html')
  let indexHtml
  try {
    indexHtml = fs.readFileSync(indexPath, 'utf8')
  } catch {
    return null
  }

  const assetNames = new Set()

  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(distDir, '.vite', 'manifest.json'), 'utf8'))
    for (const entry of Object.values(manifest)) {
      const refs = [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])].filter(Boolean)
      for (const ref of refs) {
        const base = assetBaseName(ref)
        if (base) assetNames.add(base)
      }
    }
  } catch {
    // No manifest, or it's malformed — index.html's own asset references (below) still work.
  }

  for (const match of indexHtml.matchAll(/assets\/[^"'\s>]+/g)) {
    const base = assetBaseName(match[0])
    if (base) assetNames.add(base)
  }

  const allowlist = new Map()
  const indexEntry = { file: indexPath, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache' }
  allowlist.set('/', indexEntry)
  allowlist.set('/index.html', indexEntry)

  for (const base of assetNames) {
    const contentType = distContentType(path.extname(base))
    if (!contentType) continue // unknown extension — never allowlisted
    allowlist.set(`/assets/${base}`, {
      file: path.join(distDir, 'assets', base),
      contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    })
  }

  return allowlist
}

/** Escape text for safe interposition inside an HTML response (the repo-root path in the "not built" page). */
function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 503 shown for GET/HEAD "/" when dashboard/dist/index.html doesn't exist yet. */
function sendDistNotBuilt(res, distDir) {
  const repoRoot = path.dirname(path.dirname(distDir))
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Dashboard not built</title></head><body><h1>Dashboard not built</h1><p>Run <code>npm run build</code> in <code>${escapeHtml(repoRoot)}</code>.</p></body></html>`
  res.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': DASHBOARD_CSP,
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(html)
}

/** Serve one allowlisted dist asset. `entry` always comes from buildDistAllowlist, never from the request. */
function sendDistAsset(res, entry) {
  let body
  try {
    body = fs.readFileSync(entry.file)
  } catch {
    return sendJson(res, 404, { error: 'not found' })
  }
  res.writeHead(200, {
    'Content-Type': entry.contentType,
    'Cache-Control': entry.cacheControl,
    'Content-Security-Policy': DASHBOARD_CSP,
    'X-Content-Type-Options': 'nosniff',
  })
  // Node's ServerResponse drops the body automatically for HEAD requests.
  res.end(body)
}

/** Maps a domain-thrown Error (proposals/learnings/jobs) to a statusCode + expose message sendError() can use. */
function domainError(error) {
  if (error?.name === 'ZodError') {
    const message = error.errors?.[0]?.message ?? 'invalid input'
    const err = new Error(message)
    err.statusCode = 400
    err.expose = message
    return err
  }
  const message = String(error?.message ?? error)
  if (/not found/i.test(message)) {
    error.statusCode = 404
    error.expose = message
  } else if (/not pending/i.test(message)) {
    error.statusCode = 409
    error.expose = message
  } else if (/invalid|empty/i.test(message)) {
    error.statusCode = 400
    error.expose = message
  }
  return error
}

export function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}

// Hostnames a request is allowed to address this dashboard as. Anything else
// (an attacker-controlled DNS name that resolves to 127.0.0.1, e.g. DNS
// rebinding) is rejected regardless of remote address.
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

// Extract the hostname portion of a Host header, stripping the port and any
// IPv6 brackets (e.g. "[::1]:7777" -> "::1"). Returns null when there is
// nothing usable (missing header, or a malformed IPv6 literal).
function hostnameFromHostHeader(hostHeader) {
  if (!hostHeader) return null
  let h = hostHeader.trim()
  if (!h) return null
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? null : h.slice(1, end).toLowerCase()
  }
  // A single colon is "host:port"; more than one, unbracketed, is a bare
  // IPv6 literal like "::1" (no port is possible in that form) — leave it be.
  const colonCount = (h.match(/:/g) || []).length
  if (colonCount === 1) {
    const idx = h.indexOf(':')
    if (/^\d+$/.test(h.slice(idx + 1))) h = h.slice(0, idx)
  }
  return h.toLowerCase()
}

/** Host header validation against DNS rebinding: hostname must be a loopback name, any port. Missing header is rejected. */
export function isAllowedHost(hostHeader) {
  const hostname = hostnameFromHostHeader(hostHeader)
  return hostname !== null && ALLOWED_HOSTNAMES.has(hostname)
}

/** True when the media type (ignoring parameters like charset) is exactly application/json. */
export function isJsonContentType(contentType) {
  if (!contentType) return false
  const mediaType = contentType.split(';')[0].trim().toLowerCase()
  return mediaType === 'application/json'
}

/** A missing Origin header is allowed (same-origin browser navigations, and non-browser callers, don't send one). Present, it must be a loopback origin. */
export function isAllowedOrigin(origin) {
  if (origin == null) return true
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:') return false
    const hostname = u.hostname.toLowerCase()
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  } catch {
    return false
  }
}

let invalidJobsWarned = false

/** State for GET /api/state: agents (from the preflight cache), jobs, and the last 200 events (subagents included). */
export function buildState({ env = process.env } = {}) {
  const discovery = readDiscovery(env)
  const agents = Object.values(readCache(env)).map((a) => {
    const { tier, tierSource, catalogCheckedAt } = effectiveTier({ agent: a.agent, model: a.model, discovery, registry: MODEL_REGISTRY })
    return {
      ...a,
      dataPolicy: MODEL_REGISTRY[a.agent]?.[a.model]?.dataPolicy ?? 'unknown',
      binPath: discovery[a.agent]?.binPath ?? null,
      cliVersion: discovery[a.agent]?.version ?? null,
      tier,
      tierSource,
      catalogCheckedAt,
    }
  })
  // `/api/state` is validated by the client as ONE payload (`StateResponse`,
  // jobs: JobRecord[]). One record that does not satisfy JobRecord used to
  // blank every job-list view, so drop exactly the invalid ones here instead.
  const jobs = []
  let dropped = 0
  for (const job of listJobs(env)) {
    if (JobRecord.safeParse(job).success) jobs.push(job)
    else dropped++
  }
  if (dropped > 0 && !invalidJobsWarned) {
    invalidJobsWarned = true
    console.warn(`[agent-hub] /api/state dropped ${dropped} job record(s) that do not satisfy JobRecord; the dashboard shows the rest`)
  }
  const events = readTail({ n: 200, env })
  const subagents = events.filter((e) => e.source === 'claude-hook')
  return { agents, jobs, subagents, events }
}

/** PATH entries of `env`, split on the platform delimiter — used for the Config panel's "what does this process see" display. */
function pathEntries(env) {
  const pathVar = env.PATH ?? env.Path ?? ''
  return pathVar.split(path.delimiter).filter(Boolean)
}

/** Every distinct real CLI agent (never 'claude') reachable from DELEGATION_MAP. */
function delegationMapAgents() {
  return [...new Set(defaultPairs().map((p) => p.agent))]
}

/**
 * The reason string used on every 'skipped' row/entry below — shared so the
 * dashboard HTML, tests and every route agree on the exact wording.
 */
function cliNotFoundReason(cmd) {
  return `cli_not_found_in_dashboard_process: ${cmd} is not on this process PATH`
}

/** Read-only snapshot for GET /api/config: everything the Config panel renders, plus current overrides/breaker state. */
export function buildConfig({ env = process.env } = {}) {
  const resolvedBins = {}
  for (const agent of delegationMapAgents()) {
    resolvedBins[agent] = resolveAgentCli(agent, env).binPath
  }

  return {
    delegationMap: DELEGATION_MAP,
    discovery: readDiscovery(env),
    timeouts: DEFAULT_TIMEOUTS_S,
    breaker: {
      windowMs: CIRCUIT_BREAKER.windowMs,
      failureThreshold: CIRCUIT_BREAKER.failureThreshold,
      failureKinds: [...CIRCUIT_BREAKER.failureKinds],
      immediateKinds: [...CIRCUIT_BREAKER.immediateKinds],
    },
    ttlMs: PREFLIGHT_TTL_MS,
    agentHubHome: paths(env).home,
    writeAllowlist: WRITE_ALLOWLIST,
    breakerState: defaultPairs().map((p) => breakerStatus({ agent: p.agent, model: p.model, env })),
    overrides: readOverrides(env),
    // What THIS process (the dashboard, possibly a minimal systemd --user
    // PATH) actually sees — surfaced so a misconfigured PATH is diagnosable
    // from the UI instead of silently poisoning shared cache/discovery state.
    process: {
      pid: process.pid,
      nodeVersion: process.version,
      platform: process.platform,
      pathEntries: pathEntries(env),
      resolvedBins,
    },
  }
}

const MAX_BODY_BYTES = 64 * 1024

/**
 * Buffer and parse a request body as JSON; {} for an empty body. Rejects
 * (never throws synchronously) with a tagged error for a payload over
 * MAX_BODY_BYTES or malformed JSON, so a write route can answer 413/400
 * instead of silently treating either as {}.
 */
function readJsonBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let data = ''
    let size = 0
    let oversize = false
    req.on('data', (chunk) => {
      // Once over the cap, stop buffering (free the memory) but keep
      // draining the stream — destroying `req` would tear down the shared
      // socket and the response below would never reach the client.
      if (oversize) return
      size += chunk.length
      if (size > maxBytes) {
        oversize = true
        data = ''
        return
      }
      data += chunk
    })
    req.on('end', () => {
      if (oversize) {
        const err = new Error('payload too large')
        err.statusCode = 413
        err.expose = 'payload too large'
        return reject(err)
      }
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        const err = new Error('invalid JSON body')
        err.statusCode = 400
        err.expose = 'invalid JSON body'
        reject(err)
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Map a readJsonBody rejection (413/400) or a route-thrown error (500 default) to a JSON error response. */
function sendError(res, error) {
  const status = error?.statusCode ?? 500
  const message = error?.expose ?? String(error?.message ?? error)
  sendJson(res, status, { error: message })
}

export function createServer({ env = process.env, commandRunner = runCommand, distDir = DEFAULT_DIST_DIR, client = defaultClient } = {}) {
  const sseClients = new Set()
  // job-diff-stats: short-TTL cache for live diff stats on a running write
  // job, scoped to this server instance (see GET /api/jobs/:id/diff-stats).
  const diffStatsCache = createDiffStatsCache()

  // Rebuilt whenever index.html's mtime changes, so `npm run build` is
  // picked up without restarting the dashboard process — checked with one
  // cheap stat() per request rather than a filesystem watcher.
  let allowlistCache = { mtimeMs: null, map: null }
  function getDistAllowlist() {
    let stat
    try {
      stat = fs.statSync(path.join(distDir, 'index.html'))
    } catch {
      allowlistCache = { mtimeMs: null, map: null }
      return null
    }
    if (allowlistCache.map && allowlistCache.mtimeMs === stat.mtimeMs) return allowlistCache.map
    const map = buildDistAllowlist(distDir)
    allowlistCache = { mtimeMs: stat.mtimeMs, map }
    return map
  }

  const handleRequest = (req, res) => {
    const remoteAddress = req.socket.remoteAddress
    const url = new URL(req.url, 'http://localhost')

    // Every request (GET included) must address this dashboard by a loopback
    // hostname — otherwise a DNS-rebinding page could read state/config from
    // "inside" the browser's same-origin policy.
    if (!isAllowedHost(req.headers.host)) {
      return sendJson(res, 403, { error: 'forbidden: invalid Host header' })
    }

    // A browser can only be tricked into a "simple request" (no CORS
    // preflight) for GET/HEAD or a POST with one of a few whitelisted
    // Content-Types, none of which is application/json. So requiring
    // application/json on every write route forces a preflight, which this
    // server's lack of CORS headers will always fail — closing the
    // <form enctype="text/plain">/no-cors-fetch CSRF path.
    // GET and HEAD are safe methods; only state-changing methods need the write guard.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!isLoopback(remoteAddress)) {
        return sendJson(res, 403, { error: 'forbidden: dashboard only accepts loopback connections' })
      }
      if (!isJsonContentType(req.headers['content-type'])) {
        return sendJson(res, 415, { error: 'unsupported media type: application/json required' })
      }
      if (!isAllowedOrigin(req.headers.origin)) {
        return sendJson(res, 403, { error: 'forbidden: cross-origin request' })
      }
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const allowlist = getDistAllowlist()
      if (!allowlist) {
        if (url.pathname === '/') return sendDistNotBuilt(res, distDir)
      } else {
        const entry = allowlist.get(url.pathname)
        if (entry) return sendDistAsset(res, entry)
      }
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(buildState({ env })))
      return
    }

    if (url.pathname === '/api/work-graph' && req.method === 'GET') {
      try {
        sendJson(res, 200, getWorkGraph({ env }))
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    if (url.pathname === '/api/execution-graph' && req.method === 'GET') {
      try {
        const rootExecutionId = url.searchParams.get('root') || null
        const jobs = listJobs(env)
        sendJson(res, 200, buildExecutionGraph({ jobs, rootExecutionId }))
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    if (url.pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, buildConfig({ env }))
      return
    }

    if ((url.pathname === '/api/providers' || url.pathname === '/api/agys') && req.method === 'GET') {
      agysProfilesSnapshot({ env })
        .then((snapshot) => sendJson(res, 200, snapshot))
        .catch((error) =>
          sendJson(res, 200, {
            available: false,
            reason: String(error?.message ?? error),
            mode: 'off',
            pinnedProfile: null,
            selected: null,
            profiles: [],
          })
        )
      return
    }

    if (url.pathname === '/api/providers/mode' && req.method === 'POST') {
      readJsonBody(req)
        .then(async (body) => {
          try {
            setAgysMode(body, env)
          } catch (err) {
            return sendJson(res, 400, { error: err.message })
          }
          const snapshot = await agysProfilesSnapshot({ env })
          return sendJson(res, 200, snapshot)
        })
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    if (url.pathname === '/api/quota' && req.method === 'GET') {
      agentsQuotaTool({ env })
        .then((payload) => sendJson(res, 200, { agents: payload }))
        .catch((error) => sendError(res, error))
      return
    }

    if (url.pathname === '/api/tools' && req.method === 'GET') {
      try {
        sendJson(res, 200, { tools: listMcpTools() })
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    if (url.pathname === '/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      sseClients.add(res)
      req.on('close', () => sseClients.delete(res))
      return
    }

    const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/)
    if (cancelMatch && req.method === 'POST') {
      cancelJob(cancelMatch[1], { env })
        .then((result) => sendJson(res, 200, result))
        .catch((error) => {
          // readResult (jobstore.mjs) throws a plain, unstatused Error for an
          // unknown job id — map that specific message to 404 here rather
          // than the generic 500 sendError() would otherwise send.
          if (typeof error?.message === 'string' && error.message.startsWith('job not found:')) {
            return sendJson(res, 404, { error: error.message })
          }
          return sendError(res, error)
        })
      return
    }

    if (url.pathname === '/api/agents/refresh' && req.method === 'POST') {
      readJsonBody(req)
        .then(async (body) => {
          const cwd = process.cwd()
          // ping:true is the only path that ever runs L3 — always exactly
          // one explicit agent+model pair, never a bulk refresh.
          if (body.ping === true) {
            if (!body.agent || !body.model) throw new Error('ping requires both "agent" and "model"')

            // Resolve on THIS process's own PATH before ever spawning —
            // see cliNotFoundReason's callers for why (dashboard vs. MCP
            // server are separate processes with separate PATHs).
            const info = resolveAgentCli(body.agent, env)
            if (!info.resolvable) {
              const reason = cliNotFoundReason(info.cmd)
              appendEvent(
                {
                  kind: 'preflight',
                  phase: 'ping',
                  agent: body.agent,
                  model: body.model,
                  status: 'skipped',
                  reason,
                  summary: `${body.agent}:${body.model} L3 ping skipped — ${reason}`,
                },
                { env }
              )
              return { results: [{ agent: body.agent, model: body.model, status: 'skipped', reason, written: false }] }
            }

            const entry = await pingAgent({ agent: body.agent, model: body.model, cwd, env, commandRunner })
            appendEvent(
              {
                kind: 'preflight',
                phase: 'ping',
                agent: body.agent,
                model: body.model,
                status: entry.status,
                ladderLevel: entry.ladderLevel,
                reason: entry.reason ?? null,
                summary: `${body.agent}:${body.model} L3 ping → ${entry.status}`,
              },
              { env }
            )
            return { results: [entry] }
          }

          let pairs = defaultPairs()
          if (body.agent) pairs = pairs.filter((p) => p.agent === body.agent)
          if (body.model) pairs = pairs.filter((p) => p.model === body.model)

          // Partition by resolvability on THIS process's own PATH — an
          // unresolvable agent must never reach runPreflight (which spawns
          // `--version` directly), or a dashboard with a minimal PATH would
          // overwrite a good cached row with 'unavailable' (spawn ENOENT).
          const infoByAgent = new Map()
          const resolvedPairs = []
          const skippedRows = []
          for (const pair of pairs) {
            if (!infoByAgent.has(pair.agent)) infoByAgent.set(pair.agent, resolveAgentCli(pair.agent, env))
            const info = infoByAgent.get(pair.agent)
            if (info.resolvable) {
              resolvedPairs.push(pair)
            } else {
              const reason = cliNotFoundReason(info.cmd)
              skippedRows.push({ agent: pair.agent, model: pair.model, status: 'skipped', reason, written: false })
            }
          }

          for (const [agent, info] of infoByAgent) {
            if (info.resolvable) continue
            appendEvent(
              { kind: 'preflight', phase: 'agent', agent, status: 'skipped', reason: cliNotFoundReason(info.cmd), summary: `${agent} refresh skipped — ${cliNotFoundReason(info.cmd)}` },
              { env }
            )
          }

          const resolvedResults = resolvedPairs.length > 0 ? await agentsStatus({ agents: resolvedPairs, cwd, env, commandRunner, refresh: true, announce: true }) : []

          // Report results back in the same order the pairs were requested.
          const byKey = new Map()
          for (const r of resolvedResults) byKey.set(`${r.agent}:${r.model}`, r)
          for (const r of skippedRows) byKey.set(`${r.agent}:${r.model}`, r)
          const results = pairs.map((p) => byKey.get(`${p.agent}:${p.model}`))

          return { results }
        })
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendError(res, error))
      return
    }

    if (url.pathname === '/api/discovery/refresh' && req.method === 'POST') {
      Promise.resolve()
        .then(async () => {
          const infos = KNOWN_AGENTS.map((agent) => resolveAgentCli(agent, env))
          const resolvableAgents = infos.filter((i) => i.resolvable).map((i) => i.agent)
          const skippedInfos = infos.filter((i) => !i.resolvable)

          for (const info of skippedInfos) {
            const reason = cliNotFoundReason(info.cmd)
            appendEvent(
              { kind: 'preflight', phase: 'discovery', agent: info.agent, status: 'skipped', reason, summary: `${info.agent} discovery skipped — ${reason}` },
              { env }
            )
          }

          // Only ever probe agents resolvable on THIS process's PATH.
          // runDiscovery merges into the existing file and only overwrites
          // the agents it was asked to probe, so every other agent's
          // discovery.json row (including any skipped here) survives
          // untouched on disk.
          const discovery = resolvableAgents.length > 0 ? await runDiscovery({ agents: resolvableAgents, env, commandRunner, force: true }) : readDiscovery(env)

          const payload = { ...discovery }
          for (const info of skippedInfos) {
            payload[info.agent] = { agent: info.agent, cmd: info.cmd, skipped: true, reason: cliNotFoundReason(info.cmd) }
          }
          return payload
        })
        .then((payload) => sendJson(res, 200, payload))
        .catch((error) => sendError(res, error))
      return
    }

    if (url.pathname === '/api/overrides' && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => {
          if (!body.agent || !body.model) throw new Error('overrides require both "agent" and "model"')
          const patch = {}
          if ('hold' in body) patch.hold = Boolean(body.hold)
          if (body.breakerReset === true) patch.breakerReset = new Date().toISOString()
          const entry = setOverride(overrideKey(body.agent, body.model), patch, env)
          sendJson(res, 200, entry)
        })
        .catch((error) => sendError(res, error))
      return
    }

    // Model ids contain '/' (e.g. opencode/muse-spark-1.3-contributor-free),
    // so the model segment must be URL-encoded by the caller and decoded here.
    const overrideMatch = url.pathname.match(/^\/api\/overrides\/([^/]+)\/(.+)$/)
    if (overrideMatch && req.method === 'DELETE') {
      let agent
      let model
      try {
        agent = decodeURIComponent(overrideMatch[1])
        model = decodeURIComponent(overrideMatch[2])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      sendJson(res, 200, clearOverride(overrideKey(agent, model), env))
      return
    }

    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      const groupByParam = url.searchParams.get('groupBy')
      let groupBy
      if (groupByParam) {
        const requested = groupByParam
          .split(',')
          .map((s) => s.trim())
          .filter((d) => METRICS_GROUP_DIMENSIONS.has(d))
        if (requested.length > 0) groupBy = requested
      }
      sendJson(res, 200, groupBy ? computeMetrics({ env, groupBy }) : computeMetrics({ env }))
      return
    }

    if (url.pathname === '/api/proposals' && req.method === 'GET') {
      const { unmapped } = computeModelGaps({ discovery: readDiscovery(env), map: DELEGATION_MAP, registry: MODEL_REGISTRY })
      const drift = computeCatalogDrift({ discovery: readDiscovery(env), map: DELEGATION_MAP, registry: MODEL_REGISTRY })
      sendJson(res, 200, { proposals: listProposals({}, env), unmapped, drift })
      return
    }

    if (url.pathname === '/api/proposals/refresh' && req.method === 'POST') {
      try {
        const proposals = refreshProposals({ env, map: DELEGATION_MAP, discovery: readDiscovery(env), registry: MODEL_REGISTRY })
        const { unmapped } = computeModelGaps({ discovery: readDiscovery(env), map: DELEGATION_MAP, registry: MODEL_REGISTRY })
        const drift = computeCatalogDrift({ discovery: readDiscovery(env), map: DELEGATION_MAP, registry: MODEL_REGISTRY })
        sendJson(res, 200, { proposals, unmapped, drift })
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    const proposalDecisionMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/(accept|reject)$/)
    if (proposalDecisionMatch && req.method === 'POST') {
      let id
      try {
        id = decodeURIComponent(proposalDecisionMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      const status = proposalDecisionMatch[2] === 'accept' ? 'accepted' : 'rejected'
      try {
        sendJson(res, 200, decideProposal(id, status, env))
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    if (url.pathname === '/api/learnings' && req.method === 'GET') {
      const status = url.searchParams.get('status') ?? undefined
      sendJson(res, 200, { learnings: listLearnings({ status }, env) })
      return
    }

    if (url.pathname === '/api/learnings' && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => proposeLearning(body, env, { source: 'dashboard' }))
        .then((learning) => sendJson(res, 201, learning))
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    const learningDecisionMatch = url.pathname.match(/^\/api\/learnings\/([^/]+)\/(approve|reject)$/)
    if (learningDecisionMatch && req.method === 'POST') {
      let id
      try {
        id = decodeURIComponent(learningDecisionMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      const status = learningDecisionMatch[2] === 'approve' ? 'approved' : 'rejected'
      try {
        sendJson(res, 200, decideLearning(id, status, env))
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    const learningDeleteMatch = url.pathname.match(/^\/api\/learnings\/([^/]+)$/)
    if (learningDeleteMatch && req.method === 'DELETE') {
      let id
      try {
        id = decodeURIComponent(learningDeleteMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      try {
        sendJson(res, 200, deleteLearning(id, env))
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    if (url.pathname === '/api/accounts' && req.method === 'GET') {
      sendJson(res, 200, julesAccountsTool({ env, client }))
      return
    }

    if (url.pathname === '/api/accounts' && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => sendJson(res, 201, createAccount(body, env)))
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/)
    if (accountMatch && req.method === 'PATCH') {
      let id
      try {
        id = decodeURIComponent(accountMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      readJsonBody(req)
        .then((body) => sendJson(res, 200, updateAccount(id, body, env)))
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    if (accountMatch && req.method === 'DELETE') {
      let id
      try {
        id = decodeURIComponent(accountMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      try {
        sendJson(res, 200, deleteAccount(id, env))
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    if (url.pathname === '/api/accounts/policy' && req.method === 'PUT') {
      readJsonBody(req)
        .then((body) => {
          setPolicy(body.policy, env)
          sendJson(res, 200, { policy: body.policy })
        })
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    const refreshSourcesMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/refresh-sources$/)
    if (refreshSourcesMatch && req.method === 'POST') {
      let id
      try {
        id = decodeURIComponent(refreshSourcesMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      const { apiKey } = keyForAccount({ account: id, env })
      refreshSources({ accountId: id, env, client, apiKey })
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    if (url.pathname === '/api/sources' && req.method === 'GET') {
      try {
        const accounts = listAccounts(env)
        const cache = readSourcesCache(env)
        const sourcesByName = new Map()

        for (const account of accounts) {
          const entry = cache[account.id]
          const status = entry?.status ?? null
          for (const source of normalizedSources(entry)) {
            let merged = sourcesByName.get(source.name)
            if (!merged) {
              merged = {
                name: source.name,
                owner: source.owner,
                repo: source.repo,
                defaultBranch: source.defaultBranch,
                branches: source.branches,
                accounts: [],
              }
              sourcesByName.set(source.name, merged)
            } else {
              // A source cached richly by one account fills in what an older
              // or thinner cache entry from another account could not.
              if (!merged.owner && source.owner) merged.owner = source.owner
              if (!merged.repo && source.repo) merged.repo = source.repo
              if (!merged.defaultBranch && source.defaultBranch) merged.defaultBranch = source.defaultBranch
              if (merged.branches.length === 0 && source.branches.length > 0) merged.branches = source.branches
            }
            merged.accounts.push({ accountId: account.id, status })
          }
        }

        sendJson(res, 200, {
          sources: Array.from(sourcesByName.values()),
          accounts: accounts.map((account) => ({
            accountId: account.id,
            label: account.label,
            status: cache[account.id]?.status ?? null,
            fetchedAt: cache[account.id]?.fetchedAt ?? null,
          })),
        })
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    if (url.pathname === '/api/schedules' && req.method === 'GET') {
      sendJson(res, 200, julesSchedulesTool({ env }))
      return
    }

    if (url.pathname === '/api/schedules' && req.method === 'POST') {
      readJsonBody(req)
        .then((body) => sendJson(res, 201, createSchedule(body, env)))
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/)
    if (scheduleMatch && req.method === 'PATCH') {
      let id
      try {
        id = decodeURIComponent(scheduleMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      readJsonBody(req)
        .then((body) => sendJson(res, 200, updateSchedule(id, body, env)))
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    if (scheduleMatch && req.method === 'DELETE') {
      let id
      try {
        id = decodeURIComponent(scheduleMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      try {
        sendJson(res, 200, deleteSchedule(id, env))
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    const runNowMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)\/run-now$/)
    if (runNowMatch && req.method === 'POST') {
      let id
      try {
        id = decodeURIComponent(runNowMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      runScheduleNow(id, { env })
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    if (url.pathname === '/api/cloud/sessions' && req.method === 'GET') {
      // Reuse the jules_sessions tool instead of re-implementing it: it already
      // merges every enabled account, tags each session with its accountId,
      // maps local jobs (including legacy 'env' ones) and reports a failing
      // account in accountErrors without failing the whole call. A copy here
      // had drifted — it returned an empty list whenever ?account was absent.
      const account = url.searchParams.get('account') || undefined
      julesSessionsTool({ account, env, client })
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    const checkSessionMatch = url.pathname.match(/^\/api\/cloud\/jobs\/([^/]+)\/check$/)
    if (checkSessionMatch && req.method === 'POST') {
      let jobId
      try {
        jobId = decodeURIComponent(checkSessionMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      checkRemoteSession({ jobId, env, client })
        .then((result) => sendJson(res, 200, result))
        .catch((error) => sendError(res, domainError(error)))
      return
    }

    const jobActivitiesMatch = url.pathname.match(/^\/api\/cloud\/jobs\/([^/]+)\/activities$/)
    if (jobActivitiesMatch && req.method === 'GET') {
      let jobId
      try {
        jobId = decodeURIComponent(jobActivitiesMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      try {
        let text = ''
        try {
          text = fs.readFileSync(stdoutPath(jobId, env), 'utf8')
        } catch {
          // no log yet
        }
        const lines = text.split('\n').filter(Boolean)
        sendJson(res, 200, { activities: lines })
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    const jobResultMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/result$/)
    if (jobResultMatch && req.method === 'GET') {
      let jobId
      try {
        jobId = decodeURIComponent(jobResultMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      const options = { jobId }
      const maxLinesParam = url.searchParams.get('maxLines')
      const tailLinesParam = url.searchParams.get('tailLines')
      if (maxLinesParam !== null && Number.isFinite(Number(maxLinesParam))) options.maxLines = Number(maxLinesParam)
      if (tailLinesParam !== null && Number.isFinite(Number(tailLinesParam))) options.tailLines = Number(tailLinesParam)
      try {
        sendJson(res, 200, jobResultTool(options))
      } catch (error) {
        sendError(res, domainError(error))
      }
      return
    }

    const diffStatsMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/diff-stats$/)
    if (diffStatsMatch && req.method === 'GET') {
      let jobId
      try {
        jobId = decodeURIComponent(diffStatsMatch[1])
      } catch {
        return sendJson(res, 400, { error: 'invalid URL encoding' })
      }
      getJobDiffStats({ jobId, env, cache: diffStatsCache })
        .then((diffStats) => sendJson(res, 200, { diffStats }))
        .catch((error) => {
          if (typeof error?.message === 'string' && error.message.startsWith('job not found:')) {
            return sendJson(res, 404, { error: error.message })
          }
          return sendError(res, domainError(error))
        })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  }

  // Safety net: a synchronous throw inside a route must become a 500 for that
  // request, not an uncaught exception that exits the dashboard process.
  const server = http.createServer((req, res) => {
    try {
      handleRequest(req, res)
    } catch (error) {
      console.error('[agent-hub] dashboard request failed:', error?.message ?? error)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.destroy()
    }
  })

  // Tail events.jsonl (fs.watch on its directory, offset-tracked) and push
  // new lines to every connected SSE client as they are appended.
  const eventsFile = paths(env).eventsFile
  let offset = 0
  try {
    offset = fs.statSync(eventsFile).size
  } catch {
    offset = 0
  }

  function pushNewLines() {
    let stat
    try {
      stat = fs.statSync(eventsFile)
    } catch {
      return
    }
    if (stat.size < offset) offset = 0 // file was rotated/truncated
    if (stat.size <= offset) return

    const stream = fs.createReadStream(eventsFile, { start: offset, end: stat.size - 1, encoding: 'utf8' })
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk
    })
    stream.on('end', () => {
      offset = stat.size
      for (const line of buf.split('\n')) {
        if (!line.trim()) continue
        for (const client of sseClients) client.write(`data: ${line}\n\n`)
      }
    })
  }

  let watcher = null
  try {
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true })
    watcher = fs.watch(path.dirname(eventsFile), (_eventType, filename) => {
      if (filename === path.basename(eventsFile)) pushNewLines()
    })
  } catch {
    // fs.watch unavailable on this platform/mount — clients still get the heartbeat
  }

  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(': heartbeat\n\n')
  }, 15_000)
  heartbeat.unref?.()

  server.on('close', () => {
    clearInterval(heartbeat)
    watcher?.close()
  })

  return server
}

export function startDashboard({ port = 7777, env = process.env } = {}) {
  try {
    initDb(stateHome(env))
  } catch (error) {
    console.error('[agent-hub] initDb failed:', error?.message ?? error)
  }

  // "The board does not lie": drop zombie preflight-cache rows once at boot,
  // same as the MCP server's own startup path (startup.mjs). Pure fs
  // read/write — never a CLI spawn or a discovery probe, so this is safe to
  // run unconditionally regardless of what this process's PATH looks like.
  pruneCacheForMap(env)

  const server = createServer({ env })

  // The dashboard is the ONLY long-lived process here (systemd --user), so
  // recurring Jules tasks live in it: the MCP server is a per-session stdio
  // process that dies with the Claude session. AGENT_HUB_SCHEDULER=0 disables
  // it (tests, or a machine where another instance already owns the schedules).
  const scheduler = env.AGENT_HUB_SCHEDULER === '0' ? null : startScheduler({ env })
  server.on('close', () => scheduler?.stop())

  server.listen(port, '127.0.0.1', () => {
    console.error(`[agent-hub] dashboard listening on http://127.0.0.1:${port}`)
  })
  return server
}
