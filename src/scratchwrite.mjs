import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { paths } from './config.mjs'

// scratch-writers (S1-S4): a write job given a `writeScope` runs in a
// hub-owned scratch copy (src/scratchcopy.mjs) instead of the caller's tree.
// When the agent succeeds, only the part of its diff inside the scope is
// applied back to the caller's WORKING TREE (never its index, refs or
// config), all or nothing, under a short per-repository apply lock.
//
// writeScope glob semantics: each entry is a repo-relative git pathspec with
// `glob` magic, matched from the repository root (`:(top,glob)<entry>`):
//   - `*` matches within one path segment (`src/*.js` does not match
//     `src/x/b.js`), `**` matches across segments (`src/**`, `**/*.test.mjs`);
//   - a plain directory (`src` or `src/`) matches everything below it;
//   - ignored files (.gitignore) are never part of the diff.

// Bounded wait for the apply lock: an apply holds it for one `git apply`, so
// anything past this means a stuck holder.
const APPLY_LOCK_WAIT_MS = 30_000
// A lock older than this is reclaimed even when its pid looks alive (pid reuse).
const APPLY_LOCK_STALE_MS = 2 * 60 * 1000
const APPLY_LOCK_POLL_MS = 50
// An unparseable lock file younger than this is treated as held.
const APPLY_LOCK_GARBLED_GRACE_MS = 10_000

const HUB_IDENTITY = ['-c', 'user.name=agent-hub', '-c', 'user.email=agent-hub@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
// Explicit a/ b/ prefixes override a user's diff.noprefix / diff.mnemonicPrefix,
// which would otherwise make `git apply` (-p1) strip the first path segment.
const PATCH_FLAGS = ['--binary', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/']

/**
 * Validate a writeScope synchronously, before any job record exists. Throws
 * on anything but a non-empty array of non-empty, repo-relative globs, or
 * when the job is not a write job. `undefined`/`null` means "no scope".
 */
export function assertWriteScope(writeScope, mode) {
  if (writeScope == null) return
  if (mode !== 'write') {
    throw new Error(`writeScope is only allowed with mode "write" (got mode ${JSON.stringify(mode)})`)
  }
  if (!Array.isArray(writeScope) || writeScope.length === 0) {
    throw new Error('writeScope must be a non-empty array of repo-relative glob strings')
  }
  for (const entry of writeScope) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`writeScope entries must be non-empty strings (got ${JSON.stringify(entry)})`)
    }
    if (path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry) || /^[A-Za-z]:/.test(entry)) {
      throw new Error(`writeScope entries must be repo-relative, not absolute (got ${JSON.stringify(entry)})`)
    }
    if (entry.split(/[\\/]/).includes('..')) {
      throw new Error(`writeScope entries must not contain a ".." segment (got ${JSON.stringify(entry)})`)
    }
    if (entry.startsWith(':')) {
      throw new Error(`writeScope entries are plain globs; git pathspec magic is not accepted (got ${JSON.stringify(entry)})`)
    }
  }
}

function git(cwd, args, exec, { input, encoding = 'utf8' } = {}) {
  return exec('git', args, {
    cwd,
    encoding,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(input != null ? { input } : {}),
  })
}

function firstLine(error) {
  const text = String(error?.stderr || error?.message || error)
  return text.split('\n').find((line) => line.trim()) ?? text
}

const pathspecs = (writeScope) => writeScope.map((entry) => `:(top,glob)${entry}`)
const splitZ = (out) => out.split('\0').filter(Boolean)

/**
 * Commit the copy's starting state (the caller's HEAD plus its replayed
 * uncommitted/untracked changes) as the base the agent's diff is measured
 * against. Explicit hub identity, hooks and signing off. Returns
 * `{ ok: true, base }` or `{ ok: false, reason }`.
 */
export function recordScratchBase({ dir, exec = execFileSync }) {
  try {
    git(dir, ['add', '-A'], exec)
    git(dir, [...HUB_IDENTITY, 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'agent-hub scratch base'], exec)
    return { ok: true, base: git(dir, ['rev-parse', '--verify', 'HEAD'], exec).trim() }
  } catch (error) {
    return { ok: false, reason: `could not record the scratch base commit: ${firstLine(error)}` }
  }
}

/**
 * Stage everything the agent left in the copy and split its changes against
 * `base` into in-scope and out-of-scope paths. Returns `{ inScope,
 * outOfScope, patch (Buffer, in-scope only), numstat }`. Throws on git failure.
 */
export function collectScopedChanges({ dir, base, writeScope, exec = execFileSync }) {
  git(dir, ['add', '-A'], exec)
  const all = splitZ(git(dir, ['diff', '--cached', '--name-only', '-z', '--no-renames', base], exec)).sort()
  const scoped = new Set(splitZ(git(dir, ['diff', '--cached', '--name-only', '-z', '--no-renames', base, '--', ...pathspecs(writeScope)], exec)))
  const inScope = all.filter((p) => scoped.has(p))
  const outOfScope = all.filter((p) => !scoped.has(p))
  if (inScope.length === 0) return { inScope, outOfScope, patch: Buffer.alloc(0), numstat: '' }
  const patch = git(dir, ['diff', '--cached', ...PATCH_FLAGS, base, '--', ...pathspecs(writeScope)], exec, { encoding: 'buffer' })
  const numstat = git(dir, ['diff', '--cached', '--numstat', '-z', '--no-renames', base, '--', ...pathspecs(writeScope)], exec)
  return { inScope, outOfScope, patch, numstat }
}

/**
 * Diff stats in the same shape as src/diffstats.mjs computeDiffStats, built
 * from the numstat of the APPLIED patch only (`git diff --numstat -z`
 * records are `add\tdel\tpath\0`; `-` marks a binary file).
 */
export function diffStatsFromNumstat({ numstat, baseCommit, maxFiles = 200 }) {
  const entries = []
  for (const record of splitZ(numstat)) {
    const match = record.match(/^(-|\d+)\t(-|\d+)\t(.+)$/s)
    if (!match) continue
    const [, add, del, filePath] = match
    const binary = add === '-' || del === '-'
    entries.push({ path: filePath, additions: binary ? 0 : Number(add), deletions: binary ? 0 : Number(del), binary })
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  const additions = entries.reduce((sum, e) => sum + e.additions, 0)
  const deletions = entries.reduce((sum, e) => sum + e.deletions, 0)
  const truncated = entries.length > maxFiles
  return {
    baseCommit,
    additions,
    deletions,
    filesChanged: entries.length,
    files: truncated ? entries.slice(0, maxFiles) : entries,
    truncated,
    computedAt: new Date().toISOString(),
    error: null,
  }
}

function applyLockFile(root, env) {
  let resolved = path.resolve(root)
  try {
    resolved = fs.realpathSync(resolved)
  } catch {
    // keep the resolved path: the lock still keys the same repository
  }
  const hash = crypto.createHash('sha1').update(resolved).digest('hex')
  return path.join(paths(env).locksDir, `apply-${hash}.lock`)
}

function readLock(file) {
  try {
    return { raw: fs.readFileSync(file, 'utf8'), mtimeMs: fs.statSync(file).mtimeMs }
  } catch {
    return null // vanished meanwhile
  }
}

function lockIsStale({ raw, mtimeMs }, now) {
  let holder
  try {
    holder = JSON.parse(raw)
  } catch {
    // Unparseable: a holder never publishes a partial file (see the link in
    // acquireApplyLock), but an older writer or a crash mid-write might. Only
    // reclaim it once it has sat untouched past a short grace period.
    return now - mtimeMs > APPLY_LOCK_GARBLED_GRACE_MS
  }
  if (!Number.isFinite(holder?.at) || now - holder.at > APPLY_LOCK_STALE_MS) return true
  try {
    process.kill(holder.pid, 0)
    return false
  } catch (error) {
    return error?.code === 'ESRCH'
  }
}

/**
 * Reclaim a stale lock without racing another reclaimer: move it aside to a
 * unique name (only one rename can win), then confirm the moved file is the
 * one judged stale. If a new holder replaced it between the read and the
 * rename, link that holder's file back (EEXIST if yet another holder already
 * got in; that residual window needs two reclaims and two acquisitions inside
 * one rename, and is accepted). Returns true when the caller should retry
 * acquiring right away.
 */
function reclaimIfStale(file, now) {
  const observed = readLock(file)
  if (!observed) return true
  if (!lockIsStale(observed, now)) return false
  const grave = `${file}.stale-${crypto.randomUUID()}`
  try {
    fs.renameSync(file, grave)
  } catch {
    return true // someone else moved or released it first
  }
  let moved = null
  try {
    moved = fs.readFileSync(grave, 'utf8')
  } catch {
    // unreadable: treat as not ours to keep
  }
  if (moved !== observed.raw) {
    try {
      fs.linkSync(grave, file)
    } catch {
      // a newer holder already holds the lock name
    }
  }
  fs.rmSync(grave, { force: true })
  return moved === observed.raw
}

/**
 * Short per-repository lock serializing applies to one caller repo across
 * every hub process, under AGENT_HUB_HOME. The payload is written to a
 * private temp file and published with link(2), which is atomic and fails
 * with EEXIST while the lock is held, so the lock file is never seen empty.
 * Bounded wait; a holder whose pid is gone or that is too old is reclaimed
 * race-safely (reclaimIfStale). Resolves `{ acquired: true, file, release }`
 * or `{ acquired: false, reason }`.
 */
export async function acquireApplyLock({ root, env = process.env, waitMs = APPLY_LOCK_WAIT_MS, pollMs = APPLY_LOCK_POLL_MS }) {
  const file = applyLockFile(root, env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const token = crypto.randomUUID()
  const temp = `${file}.${token}.tmp`
  const deadline = Date.now() + waitMs
  while (true) {
    try {
      fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, at: Date.now(), token }))
      fs.linkSync(temp, file)
      const release = () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.rmSync(file, { force: true })
        } catch {
          // already gone or garbled: nothing of ours to remove
        }
      }
      return { acquired: true, file, release }
    } catch (error) {
      if (error?.code !== 'EEXIST') return { acquired: false, reason: `could not create the apply lock: ${error?.message ?? error}` }
    } finally {
      fs.rmSync(temp, { force: true })
    }
    if (reclaimIfStale(file, Date.now())) continue
    if (Date.now() >= deadline) return { acquired: false, reason: `apply lock for ${root} is busy (waited ${waitMs}ms)` }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/** Paths `git apply --check` named in its errors, in order, deduplicated. */
export function parseConflictPaths(stderr) {
  const found = []
  for (const line of String(stderr ?? '').split('\n')) {
    const match =
      line.match(/^error: patch failed: (.+):\d+$/) ||
      line.match(/^error: (.+?): (?:patch does not apply|already exists in working directory|does not exist in index|No such file or directory|does not match index|wrong type)$/)
    if (match && !found.includes(match[1])) found.push(match[1])
  }
  return found
}

/**
 * Apply `patch` to the working tree of `root` (no --index/--cached: the
 * caller's index, refs and config are never touched). `git apply` is all or
 * nothing; `--check` runs first so a conflict can name its paths.
 */
export async function applyScopedPatch({ root, patch, inScope, env = process.env, exec = execFileSync, waitMs, isCanceled = () => false }) {
  const lock = await acquireApplyLock({ root, env, ...(waitMs != null ? { waitMs } : {}) })
  if (!lock.acquired) return { ok: false, errorKind: 'locked', error: lock.reason, conflictPaths: [] }
  try {
    // The job may have been canceled while this waited for the lock: checked
    // under the lock, right before touching the caller's tree.
    if (isCanceled()) return { ok: false, canceled: true, conflictPaths: [] }
    const args = ['apply', '--binary', '--whitespace=nowarn']
    try {
      git(root, [...args, '--check'], exec, { input: patch })
    } catch (error) {
      const parsed = parseConflictPaths(error?.stderr)
      const conflictPaths = parsed.length > 0 ? parsed : [...inScope]
      return {
        ok: false,
        errorKind: 'apply_conflict',
        error: `the in-scope patch does not apply to the caller's current tree; nothing was applied. Conflicting paths: ${conflictPaths.join(', ')}`,
        conflictPaths,
      }
    }
    if (isCanceled()) return { ok: false, canceled: true, conflictPaths: [] }
    try {
      git(root, args, exec, { input: patch })
    } catch (error) {
      return { ok: false, errorKind: 'apply_conflict', error: `git apply failed after a clean check (the caller's tree changed meanwhile): ${firstLine(error)}`, conflictPaths: [...inScope] }
    }
    return { ok: true }
  } finally {
    lock.release()
  }
}

/**
 * Finish a scratch writer while its copy still exists. With `apply` (the
 * agent succeeded) the in-scope patch is applied to the caller's tree;
 * otherwise nothing is applied and the patch is only saved for salvage.
 * Never throws. Returns `{ scratchWrite, diffStats, failure, canceled? }`
 * where `failure` is null or `{ errorKind, error }` for the job record and
 * `canceled` means `isCanceled()` turned true before the apply.
 */
export async function finalizeScratchWrite({ dir, root, base, writeScope, patchPath, apply, env = process.env, exec = execFileSync, waitMs, isCanceled = () => false }) {
  let changes
  try {
    changes = collectScopedChanges({ dir, base, writeScope, exec })
  } catch (error) {
    const reason = `could not compute the writer's diff in the scratch copy: ${firstLine(error)}`
    return {
      scratchWrite: { base, applied: false, appliedPaths: [], discardedPaths: [], patchPath: null, reason },
      diffStats: null,
      failure: apply ? { errorKind: 'scratch_unavailable', error: reason } : null,
    }
  }
  const { inScope, outOfScope, patch, numstat } = changes
  let savedPatch = null
  if (patch.length > 0) {
    try {
      fs.writeFileSync(patchPath, patch)
      savedPatch = patchPath
    } catch {
      // best-effort: the apply below does not depend on the saved copy
    }
  }
  const common = { base, discardedPaths: outOfScope, patchPath: savedPatch }

  if (!apply) {
    return { scratchWrite: { ...common, applied: false, appliedPaths: [], unappliedPaths: inScope }, diffStats: null, failure: null }
  }
  if (inScope.length === 0) {
    return { scratchWrite: { ...common, applied: true, appliedPaths: [] }, diffStats: null, failure: null }
  }
  const outcome = await applyScopedPatch({ root, patch, inScope, env, exec, waitMs, isCanceled })
  if (outcome.canceled) {
    return {
      scratchWrite: { ...common, applied: false, appliedPaths: [], unappliedPaths: inScope, reason: 'job was canceled before the apply; nothing was applied' },
      diffStats: null,
      failure: null,
      canceled: true,
    }
  }
  if (!outcome.ok) {
    return {
      scratchWrite: { ...common, applied: false, appliedPaths: [], unappliedPaths: inScope, conflictPaths: outcome.conflictPaths },
      diffStats: null,
      failure: { errorKind: outcome.errorKind, error: outcome.error },
    }
  }
  return {
    scratchWrite: { ...common, applied: true, appliedPaths: inScope },
    diffStats: diffStatsFromNumstat({ numstat, baseCommit: base }),
    failure: null,
  }
}
