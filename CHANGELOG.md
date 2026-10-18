# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Diff stats for write-mode jobs: a GitHub-style `+X −Y · N files` summary and
  per-file table, live on Running Jobs and persisted (survives worktree
  deletion) on History. Measured from `git diff --numstat` against the
  baseline HEAD captured at job start plus untracked files, read-only and
  bounded by timeouts. New `GET /api/jobs/:id/diff-stats` endpoint.
- Task assignments: `task_assign`, `task_continue`, `task_status` and
  `task_close` keep one plan task in one agent's native CLI session (agy,
  opencode, codex) across many turns until a human closes it with
  `accepted` or `abandoned`. One turn runs at a time (`busy` otherwise), and
  turn completion is reconciled lazily from the job record, so it survives a
  restart. Backed by a new SQLite `assignments` table (JSON fallback).
- Context budget for assignments: `task_continue` and `task_status` report
  `contextBudget`, the last turn's input-side tokens against the model's
  context window (opencode live catalog, else
  `AGENT_HUB_ASSIGNMENT_DEFAULT_CONTEXT_TOKENS`, default 200000), with an
  advisory warning at `AGENT_HUB_ASSIGNMENT_CONTEXT_WARN_FRACTION` (default
  0.6). It replaces the turn-depth nudge inside an assignment.
- Assignment rehydration: when the native session cannot be resumed, or on
  `rehydrate: true`, `task_continue` starts a fresh session seeded with the
  brief, the tail of the last response and the new message, and reports
  `rehydrated`/`rehydrationReason`. An expired session behind a failed resumed
  run is not yet detected automatically.

### Fixed

- The `claude` capability row no longer claims `sessionResume`: the hub has no
  claude CLI adapter (claude tiers are host-only routing hints), so it cannot
  resume a host-run Claude subagent session. Routing with
  `requirements: ['sessionResume']` now skips claude candidates.
- agy jobs whose turn ended while the model was still "waiting" on a command
  agy had auto-detached into the background (marker `terminating N background
  task(s) on exit`) are now reported as `failed` with `errorKind: incomplete`
  instead of an empty `succeeded`. The partial text and session id are kept so
  `job_reply` can resume the conversation.

### Changed

- Relicensed from Apache-2.0 to MIT. Releases up to and including v2.1.0 stay
  available under Apache-2.0; this and later versions are MIT.

### Removed

- Unused per-job `quality_score` field removed from `JobRecord` schema and `createJob`.
  The SQLite column remains dormant for compatibility, and the derived metrics
  `qualityScore` (`10 * verifiedRate`) is unaffected.

### Fixed

- `createJob` now rejects a record without `agent`/`model` instead of writing
  one that violates `JobRecord`, and `/api/state` (`buildState`) drops job
  records that do not satisfy `JobRecord` instead of returning a payload the
  dashboard client cannot parse. One malformed record used to blank every
  job-list view ("Could not load jobs").

### Added

- Quota-gated codex routing in the `triage`/`mechanical-edit` chains
  (`src/routing/codex-gate.mjs`): codex, always a LAST-resort fallback there,
  is now dropped entirely when its own plan quota is below 20% remaining, and
  promoted to position 2 when at/above 50% remaining and on pace. This is the
  one deliberate exception to "quota is informational only" (see
  `docs/routing.md`); every other agent's ordering is unaffected.
- `delegate()`/`dispatch()` accept an optional `profile` input to pin one
  agys account (agy only) for a single call: validated against the live
  `agys list`, recorded as `profile`/`profileStatus:'pinned'` on the job,
  and authoritative over both auto selection and a global pin (including
  `mode:'off'`) — dispatch's retry/fallback recovery never swaps a pinned
  profile. An unknown profile, a non-agy agent, or an unavailable agys CLI
  fails fast with a clear error and no silent fallback.
- agy account auto-selection is now load-aware, not just quota-aware: the
  pick is `remainingQuota - 0.15 * inFlightJobsOnThatAccount` (same model
  group), so a burst of similar-quota jobs spreads across accounts instead
  of piling onto one, while an account with meaningfully more quota still
  wins several jobs in a row. Ties break by least-recently-assigned, then
  priority, then name. Only the agys list/quota snapshot is cached (60s);
  the pick itself is recomputed on every call.
- Quality/cost/latency intelligence in `computeMetrics` (`agents_metrics`,
  `GET /api/metrics`): `costUsdTotal`/`costUsdAvg`, `verifiedCount`/
  `verifiedSamples`/`verifiedRate`/`verificationFailures`, `judgeVerdicts`,
  `revisionTotal`/`revisionAvg`, `retryCount` and `qualityScore`
  (`10 * verifiedRate`, null without verification evidence). The engine mirrors
  `judge_verdict`/`revision` onto the job record as soon as the judge decides,
  so rejected/blocked verdicts are recorded too. The dashboard Metrics view
  gains Verified, Quality, Avg cost and Avg revisions columns.
- Workflow judge and revision loop (`src/judge.mjs`): a delegate node can set
  `maxRevisionAttempts` and the engine turns the verifier verdict into
  `accepted | needs_revision | rejected | blocked` — `needs_revision`
  re-dispatches the worker (no backoff, bounded), `blocked` short-circuits on
  missing upstream evidence, and the verdict is persisted as
  `artifacts/judge.json` and carried on the node result and `job.finished`/
  `job.failed`.
- Workflow verifier (`src/verify.mjs`): a delegate node can declare `verify`
  checks (`argv` commands, `artifact` evidence existence, `forbid` diff scope)
  and the engine records a `{ verified, required, checks }` verdict next to the
  result — persisted as `artifacts/verification.json`, carried on
  `job.finished`/`job.failed`, and mirrored onto the job record's `verified`
  column (`required: true` makes a failed verdict fatal and skips the retry
  loop).
- Workflow evidence artifacts (`src/artifacts.mjs`): a delegate node can
  declare `artifacts: ['plan.md', ...]`, the engine creates
  `runs/<workflowId>/<stepId>/artifacts/`, tells the agent to write exactly
  those files there, and records an `artifacts.manifest.json`
  (`present`/`missing`, bytes, sha256) that also travels on `job.finished`.
  Downstream nodes pass evidence with `artifact://<workflowId>/<stepId>/<name>`
  refs, inlined into the task (64 KiB per ref) instead of inlining a whole
  response; an unresolved ref fails the node.
- Harness profiles (`src/harness/`: `generic`, `claude-code`, `opencode`)
  with a default `dispatch()` wait contract per caller. `dispatch()` accepts
  `waitMode` (`none` = return at create/start, `attention` = also return on
  waiting/attention, `terminal` = terminal status only); explicit beats
  `AGENT_HUB_HARNESS` env beats the MCP client hint (from `clientInfo.name`,
  default-only) beats generic. `delegate()` still never waits. `harness` +
  `waitMode` travel on the dispatch result, the job record, and the
  `job.started`/`job.finished`/`job.failed` events.

- Google Jules as a cloud agent, reachable through its own MCP tools
  (`jules_delegate`, `jules_sources`, `jules_check`, `jules_sessions`). The work
  runs on Google's servers against a connected GitHub repo and produces a pull
  request; the job is recorded like any other, so `job_status`, `job_wait`,
  `job_result` and `job_cancel` keep working. `job_reply` relays to the live
  session instead of spawning a turn, sending a message or approving a plan via
  a new `action` input.
- Reboot-safe tracking for those sessions. A poll loop streams Jules' activity
  into the job's `stdout.log` while the server is up; on startup the server
  resumes any job still `running`, doing one final read before declaring a
  timeout so a session that finished unattended lands as `succeeded` with its
  pull-request link. `jules_check` answers the same question at any time with a
  single live read and no poller, and `jules_sessions` lists sessions even when
  this machine has no record of them.
- Several Jules accounts. Keys live in `accounts.json` (mode `0600`, never
  returned raw), a selection policy picks the account for each new session, a
  `429` fails over to the next eligible account, and a job keeps the account
  that started it. `jules_sessions` merges every enabled account and tags each
  session with its `accountId`. New read-only tools `jules_accounts` and
  `jules_schedules`.
- Recurring Jules tasks, run by the dashboard service: interval or daily
  schedules, at most one run in flight per schedule.
- Dashboard HTTP API for Jules accounts, sources, schedules and cloud sessions.
- Quota state before delegating, read from a local CodexBar server: a `quota`
  field on `agents_status` and `route()` results, the `agents_quota` tool,
  `GET /api/quota` and the Agents view. It is information only — quota data
  never chooses, skips or reorders an agent, and a test pins that `route()` is
  unchanged by it.
- The dashboard's Cloud view for Jules accounts, sources, schedules and
  sessions, typed from shared response schemas and guarded by a contract test
  that parses every real Cloud route response.
- The Codex CLI as a delegation agent: a last fallback for `triage` and
  `mechanical-edit`, built from the real CLI's JSONL output and supporting
  `job_reply` through `codex exec resume`.

### Changed

- `JULES_API_KEY` is stripped from the environment handed to the local agent
  CLIs. It is a credential agent-hub introduces, so it is not shared with
  third-party programs it merely spawns.
- `job_reply` accepts a missing `message` only for a Jules `approve_plan`; every
  other agent now fails fast with `errorKind:'invalid'` instead of starting a
  turn with an empty prompt.

### Fixed

- A remote job becomes terminal only from its remote session's own state. A
  local deadline, a rejected key, transient API errors or a poller crash stop
  the polling and leave the job running; before this, three healthy Jules
  sessions were marked failed on one day while each kept running.
- `job_reply` and `jules_sessions` used only `JULES_API_KEY` and sent unkeyed
  requests once keys moved into accounts; all key resolution now goes through
  one module.
- The dashboard's job views no longer go blank when a job has no local `cwd`,
  as a Jules job never does.
- A learning's text wraps inside its table cell instead of overlapping the
  Approve and Reject buttons.
- The live Jules activity log no longer prints an empty line for each progress
  step and a near-identical change-set line for every intermediate diff.

## [2.1.0] - 2026-09-16

### Added

- `npm run install:local` (`scripts/install-local.mjs`): build the dashboard
  and install only the runtime (`bin/`, `src/`, `skills/`, `systemd/`,
  `dashboard/dist/`, a workspace-free `package.json` and production
  dependencies) into `~/.claude/mcp-servers/agent-hub` (or `--target` /
  `AGENT_HUB_INSTALL_DIR`), so the git checkout can live anywhere. It writes
  `INSTALL.json` with the installed version and commit, keeps the target's
  `node_modules` between runs, never touches `AGENT_HUB_HOME`, and
  `--restart` restarts the dashboard unit.

## [2.0.0] - 2026-09-15

### Added

- Dashboard rewritten as a React 19 + TypeScript + Vite + Tailwind v4 app
  (`dashboard/` npm workspace) using shadcn/ui on Base UI, TanStack Router
  (hash history) and TanStack Query, served read-only from `dashboard/dist/`
  under a strict CSP. New views: Metrics (`#/metrics?taskType=`) and Approvals
  (`#/approvals?tab=proposals|learnings`), plus filters/deep links across
  Agents (`filter`, `q`), History (`status`, `agent`, `q`) and Timeline
  (`source`, `q`).
- `agents_metrics` MCP tool and `GET /api/metrics`: success rate, p50/p95
  latency, error kinds and token totals per agent/model/mode/taskType from job
  history.
- Adaptive timeouts: a job's timeout is raised (never lowered) from observed
  succeeded-run p95 x1.5, capped at 3600s, once a pair has 10 samples. An
  explicit `timeoutS` always wins; the job record keeps `timeoutSource`.
- Routing proposals (`proposals.json`, `src/proposals.mjs`): propose promoting
  a chain candidate whose 95% Wilson lower bound beats the current primary's
  upper bound (both with 10+ samples). A human accepts or rejects at
  `#/approvals?tab=proposals`; accepting supersedes the previous accepted
  proposal for that task type, a chain change marks a stored proposal
  `superseded`, and a rejection starts a 7-day cooldown. `route()` returns the
  applied proposal as `appliedProposal`.
- Learnings (`learnings.json`, `src/learnings.mjs`) and the `learning_propose`
  tool: stored pending, sanitized on write and on read, and approved ones
  (max 3, 300 chars each) prepended to matching root turns.
- Read-mode guard (`src/readguard.mjs`): a git before/after snapshot of `cwd`
  fails a `read` job with `errorKind:'read_mode_violation'` when the tree
  changed. Verified: `agy --mode plan` writes files regardless of
  `--dangerously-skip-permissions`; a non-git `cwd` is reported unverifiable.
- `taskType` on `delegate`/`job_reply` (reply defaults to the parent's) and
  `tailLines` on `job_result`; `job_reply` returns `turnDepth` and warns from
  5 turns deep.
- Job resources (`agent-hub://jobs/{jobId}`, `…/response`) and prompts
  (`recon`, `adversarial-review`, `guided-write`). Every tool declares a zod
  `outputSchema` and returns `structuredContent`.
- Dashboard HTTP API: `GET /api/metrics`; proposals (`GET`,
  `POST /api/proposals/refresh`, `POST /api/proposals/:id/accept|reject`);
  learnings (`GET`, `POST`, `POST /api/learnings/:id/approve|reject`,
  `DELETE /api/learnings/:id`); `GET /api/jobs/:id/result`.

### Changed

- **Breaking:** Node.js >= 20.19 is now required. `npm install` builds the
  dashboard through the `prepare` script (`scripts/build-dashboard.mjs`, which
  prints a hint but never fails the install); `npm run build` rebuilds it, and
  the server picks up a rebuild without restarting. A missing `dashboard/dist/`
  serves a 503 page with the build command.
- `route` returns a compact per-CLI discovery summary (`binPath`, `version`,
  `modelCount`, `checkedAt`, `error`) instead of the full model catalog, which
  added several KB to every routing call. Pass `includeCatalog: true` to get
  the catalog.
- Cross-process JSON state writes are serialized with a lock file.

### Fixed

- Cross-process JSON updates (overrides, proposals, learnings) no longer lose
  each other's writes now that the store takes a lock file.
- Jobs record the task type, turn depth, effective timeout and injected
  learnings, so history and metrics reflect what actually ran.
- A job finished late by the MCP process can no longer overwrite a
  cancellation written by the dashboard.
- The dashboard uses a colored chart palette and no longer requests a missing
  favicon on every load.

### Security

- Job ids are validated as a single safe path segment before any filesystem
  access, so `GET /api/jobs/:id/result` and the MCP job tools can no longer
  read files outside `runs/` with an encoded `..` id.
- Cross-process locks carry an ownership token, so a paused holder can no
  longer release a lock that another process reclaimed.
- Dashboard CSP still enforces `style-src 'self'`: Base UI runs with
  `CSPProvider disableStyleElements` and chart colors come from CSS variables,
  so the app injects no inline styles.

### Removed

- **Breaking:** the vanilla ES-module dashboard under `src/dashboard/`
  (HTML/CSS/JS, no build step) — replaced by the `dashboard/` workspace.

## [1.2.0] - 2026-09-14

### Added

- Dashboard app shell with a grouped sidebar (Monitor, Activity, System) and
  hash routes for Overview, Agents, Running jobs, Job history, Claude
  subagents, Timeline and Config. Routes are deep-linkable, the back button
  works, and focus moves to the view heading on navigation.
- Sidebar badges that surface state: unhealthy agents, running jobs, failed
  jobs in the last 24 hours, unseen timeline events and unresolved CLIs.
- Overview view that leads with what needs attention, with KPI cards linking
  to filtered views.
- Agents grouped by CLI with filters (unhealthy, held, breaker open), search,
  a row action menu and a detail panel. Job history filters by status and
  agent, with a detail panel for errors, session and cost.
- Confirmation dialogs before an L3 ping, a breaker reset or a job cancel.
- System, light and dark theme choice, remembered per browser.
- Navigation drawer on screens narrower than 960px.

### Changed

- The single 1749-line dashboard page is split into static ES modules under
  `src/dashboard/` with no build step, served from an exact-match allowlist.
- Live events are appended incrementally; only job and preflight events
  trigger a debounced state refetch instead of a full reload per event.

### Fixed

- A DELETE override request with malformed percent-encoding no longer
  crashes the dashboard process; it returns 400, and any other synchronous
  error inside a route becomes a 500 for that request.
- Events delivered over SSE while a state refresh is in flight are kept
  instead of being replaced by the older snapshot.
- Navigating quickly no longer lets a slower view import replace the view
  the user navigated to.
- HEAD requests to the dashboard shell and assets return 200 instead of
  415.
- The browser no longer requests a missing favicon on every load.

### Security

- Dashboard responses send `Content-Security-Policy: default-src 'self'`
  without inline script or style allowances, plus `X-Content-Type-Options:
  nosniff`.

## [1.1.0] - 2026-09-14

### Added

- Startup CLI discovery (`scheduleStartupDiscovery`, `src/startup.mjs`): runs
  L0 (`--version`) + L1 (model listing) for every CLI in the delegation map
  in the background via `setImmediate`, so it never blocks the MCP stdio
  handshake, and never runs an L3 ping. Writes `discovery.json`
  (`{ [agent]: {agent, cmd, binPath, version, models, checkedAt, error,
  note?} }`), TTL-gated by the existing 15-minute preflight TTL. Prunes
  `preflight-cache.json` rows for agent:model pairs no longer present in the
  delegation map. Opt-out via `AGENT_HUB_DISABLE_STARTUP_DISCOVERY=1`.
- Manual per-pair overrides (`overrides.json`, `src/overrides.mjs`): a
  `hold` flag makes the router skip a pair, and a `breakerReset` timestamp
  discounts circuit-breaker failures at or before that instant.
- `agents_status` rows and `route()` results gain `binPath`/`cliVersion`
  (from discovery); `route()` also returns `skipped` (each entry tagged
  `held`, `cli_not_found`, `cached_unavailable`, or `breaker_open`) and
  `discovery`.
- Dashboard: `GET /api/config` (delegation map, discovery, timeouts, breaker
  settings, overrides), `POST /api/agents/refresh` (bulk L0-L2, or `ping:true`
  for a single L3 round-trip), `POST /api/discovery/refresh`, `POST
  /api/overrides`, `DELETE /api/overrides/:agent/:model`. New UI: per-row
  Revalidate / Ping / Hold / Release / Reset breaker, header Revalidate
  all / Rediscover CLIs, and a Config panel. New `preflight` event kind
  (`phase: discovery|agent|ping`) streamed over the existing SSE feed.
- `multi-agent-orchestrator` and `agy-delegate` skills, shipped in `skills/`
  for symlinking into a Claude Code skills directory.

### Changed

- Atomic JSON writes (tmp + rename, `src/fsutil.mjs`) for every state file
  written by both the MCP process and the dashboard process.
- Discovery fetches an agent's model list once per agent instead of once per
  agent+model pair; agents are probed in parallel, pairs within one agent
  serially.

### Removed

- Unused `CONCURRENCY_CAP_PER_AGENT` config constant (never enforced).

### Fixed

- The dashboard never writes preflight or discovery state for a CLI it cannot
  resolve on its own `PATH`. Revalidate, ping and rediscover return a
  `skipped` result with reason `cli_not_found_in_dashboard_process` instead
  of recording the agent as unavailable for the MCP server. The Agents panel
  warns about unresolved CLIs and disables their buttons, and the Config
  panel shows the dashboard process `PATH` and resolved binaries.
- The dashboard prunes cache rows for pairs removed from the delegation map
  when it starts, not only when the MCP server starts.
- Cancelling an unknown job from the dashboard returns 404 instead of 500.
- Dashboard rejects cross-site and DNS-rebinding requests. A loopback check
  alone let any web page open in the user's browser trigger writes, because
  the browser itself connects from loopback. Every request now needs a
  loopback `Host` header (403 otherwise). Every non-GET request also needs
  `Content-Type: application/json` (415), a same-origin `Origin` when one is
  sent (403), a body of at most 64 KiB (413) and valid JSON (400).
- The systemd `--user` dashboard unit now loads `PATH` from the optional
  `~/.config/agent-hub/env` file. With systemd's minimal default `PATH` the
  dashboard could not find `agy`, `opencode` or `copilot`, so a Revalidate
  click recorded ready agents as unavailable in the shared preflight cache.
- Sanitized test fixtures (home paths and private repository names replaced
  with placeholders).

## [1.0.0] - 2026-09-14

### Added

- MCP server over stdio with `agents_status`, `route`, `delegate`, `job_status`,
  `job_wait`, `job_result`, `job_reply` and `job_cancel` tools.
- Adapters for `agy` (Antigravity), `opencode` and GitHub `copilot` CLIs.
- L0-L3 preflight ladder with a 15-minute on-disk cache and a per-pair circuit breaker.
- Task-type delegation map with ordered fallback chains.
- Write-mode gate: secondary git worktree required, per-cwd write lock.
- Append-only event log, per-job run directory, orphan reconciliation on startup.
- Local dashboard on `127.0.0.1:7777` with SSE timeline and job cancel.
- `SubagentStart`/`SubagentStop` hook recorder for Claude Code subagents.

[Unreleased]: https://github.com/jalejandrov93/agent-hub/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/jalejandrov93/agent-hub/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/jalejandrov93/agent-hub/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/jalejandrov93/agent-hub/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/jalejandrov93/agent-hub/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/jalejandrov93/agent-hub/releases/tag/v1.0.0
