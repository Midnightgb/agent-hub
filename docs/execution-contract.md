# Execution Contract (A0)

Normative invariants for job execution. `MUST` = contract (some fields are
target state for later slices); file:line refs ground what already exists.

## 1. Deadline semantics

- Four independent clocks: `startup` (spawn/session-create), `execution`
  (CLI run / remote session), `idle` (no stdout/activity), `remote-watcher`
  (local poll budget). They never share a timer.
- Effective timeout: explicit wins (`src/timeouts.mjs` `resolveEffectiveTimeoutS`); else
  `clamp(adaptive_p95 * multiplier, min=static_default, max=capS)` where
  adaptive only ever RAISES the static default (`src/timeouts.mjs` `resolveEffectiveTimeoutS` adaptive branch,
  `src/config.mjs`; defaults `src/config.mjs`).
- Local kill = `timeoutS + KILL_GRACE_S` (`src/jobrunner.mjs` `KILL_GRACE_S` usage,
  `src/config.mjs`); grace lets agy exit with partial output first.
- **Local-deadline ≠ remote-failure.** A local timeout stops OUR polling and
  records `pollingStoppedReason: local_deadline`; only the remote session's
  own state finalizes the job (`src/cloud/runner.mjs` `pollingStoppedReason`).
- Resume after deadline still does one final bounded poll (60s) to learn the
  real outcome instead of failing on the clock (`src/cloud/runner.mjs` `resumeRemoteJobs`).
- Per-attempt backoff: attempt n waits `base * {1x, 1.5x, 2x}[min(n,3)]`;
  remote poller backs off `5s -> 60s ceiling, factor 1.5`, resets on new
  activity (`src/cloud/poller.mjs` `BACKOFF_FACTOR`).

## 2. Cancellation

- **LOCAL CANCEL WINS.** `cancelJob` marks `canceled` BEFORE killing, so the
  racy `finishJob` no-ops and never resurrects the job (`src/jobrunner.mjs` `cancelJob` and `finishJob`); `updateResult` merges but never flips
  `canceled` -> terminal-other (`src/jobstore.mjs` `updateResult`). Local kill is
  SIGINT->SIGTERM->SIGKILL over the whole process group (`src/process.mjs` `killProcessGroup`).
  Final state is `canceled`, no retry.
- **REMOTE NO-GUARANTEE.** No `sessions/{id}:cancel` exists upstream; cancel
  marks the LOCAL record `canceled` and stops polling — the remote session
  MAY keep running (`src/cloud/poller.mjs` `pollUntilTerminal`, `src/index.mjs` `job_cancel`).
  `remote.sessionId/sessionUrl` MUST be preserved on the record for later
  `jules_check` reconciliation. Poller checks `canceled` before the clock so
  a canceled job never spends quota (`src/cloud/poller.mjs` `pollUntilTerminal` cancel-before-clock).

## 3. Retry / resume / fallback / escalation

- `ExecutionPolicy { retry, resume, fallback, escalation }` travels with every
  dispatch; each dimension is independent and bounded.
- `retry`: same agent+model, fresh attempt id, per-attempt backoff (§1).
  Never retries `canceled`, `worktree_denied`, `read_mode_violation`, `auth`.
- `resume`: same `sessionId` (local CLI conversation, `src/jobrunner.mjs` `startJob` `adapterArgs`)
  or same `remote.sessionId` (Jules `job_reply`); resumes do NOT consume a
  retry attempt.
- `fallback`: router `primary + fallbacks[]` chain (`src/router.mjs` `primary + fallbacks`);
  codex is LAST fallback only, never primary (`src/config.mjs` `codex` tier).
  Preflight L0-L2 gates each candidate; breaker opens on ≥2 quota/canceled
  failures in 30m, billing opens immediately (`src/preflight.mjs` circuit breaker usage,
  `src/config.mjs` `CIRCUIT_BREAKER` limits).
- `escalation`: only on explicit policy (e.g. repeated `quota` after
  `MAX_ACCOUNT_ATTEMPTS=3`, `src/cloud/runner.mjs:22-23`); escalation MUST
  carry `parentExecutionId/rootExecutionId` (§4).

## 4. Idempotency

- `dispatchKey = sha256(task + cwd + taskType + workflowStep)`; re-dispatch
  with the same key MUST return the existing job, never spawn a duplicate.
  An optional per-call `label` joins the hash, so a deliberate fan-out of
  identical tasks gets one job per label; no label keeps the legacy hash.
- Identity chain: `executionId` (this attempt), `attempt` (n of N),
  `parentExecutionId` (retry/resume parent), `rootExecutionId` (first cause).
  `jobstore.createJob` persists all four alongside `parentJobId/sessionId`
  (`src/jobstore.mjs` `createJob`).
- Remote creation reconciliation: before `createSession`, compute fingerprint
  `(repo, branch, task-hash, title, time-window)` and search `listSessions`;
  a match re-adopts instead of creating. Startup re-adopts `running` remote
  jobs with keys and skips unkeyed ones without failing them
  (`src/cloud/runner.mjs` reconciliation); local orphans reconcile by pid, remotes
  are never judged by pid (`src/jobstore.mjs` `reconcileOrphans`).

## 5. Read purity / write ownership

- Read purity: snapshot AFTER gate+lock, diff at terminal transition; the
  guard level comes from the adapter's `readPolicy` (`src/scratchcopy.mjs`
  `resolveReadIsolation`). With the `strict` guard a modifying `read` job fails
  as `read_mode_violation` (output kept for inspection); with `warn`
  (enforced-read CLIs, or agy in its scratch copy) the change is recorded as
  `readGuard` and a warning. A scratch-policy job (agy) runs in a hub-owned
  detached worktree and never writes the caller's tree. Non-git cwd =
  `unverifiable`, never a violation (`src/jobrunner.mjs` `takeSnapshotFn` /
  `diffSnapshotsFn`, `src/readguard.mjs` `takeSnapshot`). `.env` / `JULES_API_KEY` never reach child
  CLIs (`src/sandbox.mjs` env filtering).
- Write ownership: `mode:write` requires secondary `git worktree add`
  checkout or allowlist (`src/worktree.mjs` `checkWriteAllowed`); single-writer lock per
  cwd via atomic `wx` create + stale-pid reclaim (`src/worktree.mjs` `acquireWriteLock`).
  JSON state merges via token-owned `updateJsonLocked`
  (`src/fsutil.mjs` `updateJsonLocked`). Remote jobs never
  take the local lock (`src/cloud/runner.mjs` `startRemoteJob` bypassing local lock).

## 6. Local vs remote state

- Local `job.status ∈ {queued, running, succeeded, failed, canceled}`
  (`src/jobstore.mjs` `createJob` defaults) is OUR bookkeeping; remote
  `{state, stateSince, lastActivityAt, polling}` is THEIR truth.
- Remote block: `state` (last `getSession`), `branch/prUrl` (sticky, never
  erased by a null tick), `activityCursor/seenActivityIds` (bounded dedup),
  `pollingStopped{At,Reason}` (`src/cloud/poller.mjs` and
  `src/cloud/runner.mjs` blocks).
- Terminal remote = `COMPLETED/FAILED` state, never timeout/error-budget
  (`src/cloud/poller.mjs` terminal check -> `src/cloud/runner.mjs`).

## 7. Watch ownership (Model A, confirmed — implemented for B4)

- `jules_interact`/`job_reply` on a Jules parent NEVER restart a poller.
  Model A (confirmed): `jules_interact`/`job_reply` deliberately DO NOT clear
  `pollingStoppedReason`; they leave it for the next observation (e.g.
  `jules_wait`/`jules_check`) to clear. After an interaction the session is
  unobserved until the caller observes it or a supervisor owns it.
- B4 `jules_supervise` formally acquires observation ownership, not just
  `check → reply → return`: Supervisor = observe → decide → interact →
  resume-observation.
- Lease shape:
  `remote.watch = {owner: 'supervisor' | 'jules_wait' | null, generation: N}`.
  A new owner bumps `generation`; a stale generation stops writing. This keeps
  a supervisor and a concurrent `jules_wait` from driving the same session.
- `jules_wait` respects the lease: read-only observation while a supervisor
  owns the watch.

## 8. C0 SQLite gate (landed)

- C0 schema (SQLite WAL tables + `JobRecord` mapping) ships and is initialized
  at startup (`initDb` in `src/index.mjs`). The `better-sqlite3` package is a
  standard runtime dependency.
- Job persistence (`src/jobstore.mjs`) behavior is controlled by `AGENT_HUB_STORE`:
  - `json` (default): reads `result.json`
  - `shadow`: reads JSON, verifies against SQLite, and logs divergences
  - `sqlite`: reads from SQLite first, falling back to JSON
- In all modes, `result.json` continues to be written on `createJob` and
  `updateResult` as a durability and content artifact.

## 9. Dispatch vs Delegate

- `delegate()`: **raw escape hatch**, for callers that must pin one exact
  agent+model and handle failure themselves. Exact execution without policy: it
  skips routing, policy recovery, circuit breakers, `dispatchKey` idempotency
  and execution lineage. Returns `{jobId, status:'queued'}` immediately and
  never waits (it is synchronous by contract).
- `dispatch()`: execution WITH policy, idempotency, and lineage. Dedupes by
  `dispatchKey` (concurrent dispatches with the same key share one job),
  applies `waitMode` (`none`|`attention`|`terminal`), and handles preflight
  gates and circuit breakers.
- **Prefer `dispatch()`.** They are deliberately NOT unified: wrapping
  `delegate()` in `dispatch()` changes its type (delegate returns the job
  record synchronously) and its semantics, and an audit of this repo confirmed
  the split is intentional. The open item is narrower than "unify them": keep
  `delegate()` raw and make orchestrators reach for `dispatch()` by default.

## 10. Harness profiles & waitMode

- `src/harness/` maps the calling harness to a default wait contract:
  `generic` (none — return at create/start), `claude-code` / `opencode`
  (attention — return at terminal OR waiting/attention).
- `dispatch()` accepts `waitMode` (`none`|`attention`|`terminal`); an
  explicit value always beats the profile default. Resolution priority:
  explicit > `AGENT_HUB_HARNESS` env > MCP client hint > generic.
- The MCP client hint (from `clientInfo.name` at the handshake) is
  default-only: it never overrides an explicit harness/env/waitMode and
  never decides anything security-sensitive. `delegate()` never waits.
- `harness` + `waitMode` travel on the dispatch result, the job record, and
  `job.started` / `job.finished` / `job.failed` events (informational only).
