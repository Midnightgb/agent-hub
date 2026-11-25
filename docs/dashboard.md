# Observability and dashboard

## Event watcher and notifications policy

`bin/agent-hub watch [--once|--follow] [--sink console|file|webhook] [--job ID[,ID...]] [--root ID] [--until-terminal]`
tails `events.jsonl` (`src/notify/watch.mjs`, offset-tracked) and routes events
according to a declarative notification policy (`src/notify/policy.mjs`):

| Category | Channels | Severity | Default Dedup Window |
|---|---|---|---|
| `job.finished` | `console` | `info` | 0 ms (immediate) |
| `job.failed` | `console`, `file` | `error` | 0 ms (immediate) |
| `job.canceled` | `console` | `warn` | 0 ms (immediate) |
| `jules.waiting` | `console`, `file` | `warn` | 60,000 ms (1 min) |
| `jules.attention_required` | `console`, `file`, `webhook` | `error` | 300,000 ms (5 min) |
| `workflow.completed` | `console`, `file` | `info` | 0 ms (immediate) |

Sinks (`src/notify/adapters.mjs`) dispatch to `console`, file
(`<AGENT_HUB_HOME>/notifications.jsonl`), or an external HTTP webhook
(`AGENT_HUB_WEBHOOK_URL`). Adapters never throw, sanitize secrets before
logging, and suppress duplicate notifications within the category's `dedupMs`
window. The watcher runs as a standalone process outside the MCP stdio lifecycle.

### Getting told when a delegated job ends

Delegated agents finish silently; the hub, not the agent, is the source of the
signal. Run the watcher in the background (for Claude Code, a background Bash
command or a Monitor) and it exits when the work is done:

```bash
agent-hub watch --follow --job <jobId>[,<jobId>...] --until-terminal
agent-hub watch --follow --root <rootExecutionId> --until-terminal
```

- `--job` (repeatable, comma-separated) and `--root` filter routed events to
  those jobs; `--root` matches every job of that root execution.
- `--until-terminal` (requires `--job` or `--root`, `--follow` only) exits 0
  once every targeted job is `succeeded`, `failed` or `canceled`. Terminal state
  is read from the job store, so a job that already finished before the watcher
  started is counted and nothing is missed.
- A job marked `failed` with `errorKind: 'orphaned'` on startup reconcile now
  emits a `job.failed` event, so a watcher no longer waits on it forever.

## Dashboard

```bash
node bin/agent-hub dashboard --port 7777
# open http://127.0.0.1:7777
```

Binds to `127.0.0.1` only. The page is a sidebar app with deep-linkable hash
routes, so a link can open the exact filtered view:

| Group | Route | Shows |
|---|---|---|
| Monitor | `#/overview` | What needs attention: unhealthy agents, open breakers, failures in the last 24h, unresolved CLIs, recent activity |
| Monitor | `#/agents?filter=all\|unhealthy\|held\|breaker&q=` | Agents grouped by CLI; filter, free-text search, row menu, detail panel |
| Monitor | `#/jobs` | Running and queued jobs with live elapsed time, job profile badge, diff stats, and Cancel |
| Monitor | `#/history?status=&agent=&q=` | Terminal jobs; `status=failed\|succeeded\|canceled`, agent filter, free-text search, error detail, job profile badge, diff stats, reply chains |
| Monitor | `#/providers` | agys multi-account profiles, quotas, active mode toggle (`off`\|`profile`\|`auto`), and profile selector |
| Monitor | `#/graph` | Visual execution graph lineage DAG: roots, attempts, and delegate/retry/resume edges |
| Monitor | `#/metrics?taskType=` | Success-rate chart and per-pair table; `taskType` filters the rows |
| Activity | `#/subagents` | Claude Code subagent runs recorded by the hooks |
| Activity | `#/timeline?source=&q=` | Last 200 events over SSE, filtered by source and free text |
| System | `#/approvals?tab=proposals\|learnings` | Routing proposals and learnings awaiting a human accept/reject |
| System | `#/tools` | MCP tool inventory (`GET /api/tools`): every registered tool with title and description — validates the loaded build exposes what you expect after each change. |
| System | `#/config?section=delegation\|process\|breaker\|overrides\|paths` | Delegation map, process PATH and CLIs, breaker and TTL, overrides, paths |

Sidebar badges show unhealthy agents, running jobs, failures in the last 24h,
unseen timeline events and unresolved CLIs. Running Jobs (`#/jobs`) and History
(`#/history`) display the `JobProfileBadge` showing which agys profile executed
the job along with its status badge (`selected`, `fallback`, `exhausted`,
`unavailable`). Agent row actions are Revalidate, Ping (an L3 round-trip for
that one agent+model), Hold / Release and Reset breaker; the Agents header
adds Revalidate all and Rediscover CLIs. Ping, Reset breaker and Cancel job
ask for confirmation first. The theme follows the system by default and can
be set to light or dark. `preflight` events (`phase: discovery|agent|ping`)
stream over the same SSE feed as job events.

**Diff stats.** A write-mode job in a git work tree shows a GitHub-style
`+X −Y · N files` summary (Running Jobs polls it live every 5s; History reads
the persisted snapshot, so it survives worktree deletion) plus a per-file
table in the job detail view. Read-mode and non-git jobs show nothing — no
baseline was ever captured, and that is never an error. The measured file
list is capped at 200 entries (`truncated: true` when more changed); the
`+X −Y · N files` totals always reflect the true count. Additions/deletions
come from `git diff --numstat` against the baseline HEAD captured at job
start (so a commit the agent makes during the run is still measured) plus
untracked files counted as additions; a binary file is reported as
`binary: true` with 0 lines either way. When an implementation handoff
declares `changedFiles` for the same workflow/step, an informational
`changedFilesMismatch` is attached — it never blocks or fails anything.

The UI is a React 19 + TypeScript + Vite + Tailwind v4 app in the `dashboard/`
workspace, using shadcn/ui components on Base UI, with TanStack Router (hash
history) and TanStack Query. It is built to `dashboard/dist/` and served
read-only from there — see Install for the build step.

| Route | Method | Body | Notes |
|---|---|---|---|
| `/` and dashboard assets | GET | — | Built app (`index.html` + hashed assets), served from an exact-match allowlist; 503 with a build hint when `dashboard/dist/` is missing |
| `/api/state` | GET | — | `{agents, jobs, subagents, events}` |
| `/api/config` | GET | — | `{delegationMap, discovery, timeouts, breaker, ttlMs, agentHubHome, writeAllowlist, breakerState, overrides, process}` |
| `/api/metrics` | GET | — | Same rows as `agents_metrics`; `?groupBy=agent,model,mode,taskType` |
| `/api/providers` | GET | — | Snapshot of agys profiles, quota buckets, mode, source, and selected profile |
| `/api/providers/mode` | POST | `{mode: 'off'\|'profile'\|'auto', profile?}` | Switch agys mode (persisted to `agys-mode.json`; invalidates sync profile cache) |
| `/api/execution-graph` | GET | — | Lineage DAG of executions across workflows; `?rootExecutionId=` filters to subtree |
| `/api/proposals` | GET | — | `{proposals}` |
| `/api/proposals/refresh` | POST | — | Recompute proposals from current metrics and store new pending ones |
| `/api/proposals/:id/accept` | POST | — | Accept a pending proposal (supersedes the previous accepted one for that task type) |
| `/api/proposals/:id/reject` | POST | — | Reject a pending proposal (7-day cooldown before the same task type is proposed again) |
| `/api/learnings` | GET | — | `{learnings}`; `?status=pending\|approved\|rejected` |
| `/api/learnings` | POST | `{text, agent?, model?, taskType?, sourceJobId?}` | Creates a **pending** learning (201) |
| `/api/learnings/:id/approve` | POST | — | Approves a learning so matching root turns get it |
| `/api/learnings/:id/reject` | POST | — | Rejects a learning |
| `/api/learnings/:id` | DELETE | — | Deletes a learning |
| `/events` | GET | — | SSE stream of `events.jsonl` |
| `/api/jobs/:id/cancel` | POST | — | Cancels a running job |
| `/api/jobs/:id/result` | GET | — | Same payload as `job_result`; `?maxLines=&tailLines=` |
| `/api/jobs/:id/diff-stats` | GET | — | `{diffStats}`: the persisted snapshot for a terminal job, or a short-TTL-cached live computation for a running write-mode job; `null` for a read-mode or no-baseline job |
| `/api/agents/refresh` | POST | `{agent?, model?, ping?}` | No body = all pairs, L0-L2. `ping:true` runs L3 for exactly one agent+model. |
| `/api/discovery/refresh` | POST | — | Forces a fresh discovery pass, ignoring the TTL |
| `/api/overrides` | POST | `{agent, model, hold?, breakerReset?:true}` | Sets a manual hold and/or clears breaker history |
| `/api/overrides/:agent/:model` | DELETE | — | `model` must be URL-encoded (model ids contain `/`) |

**Security**: the dashboard binds only to `127.0.0.1` and is meant for the
local user. It also defends against a hostile web page open in the same
browser, because that browser connects from loopback too:

- Every request must carry a loopback `Host` header (`127.0.0.1`,
  `localhost` or `[::1]`, any port). This blocks DNS rebinding. Otherwise 403.
- Every state-changing request must come from a loopback address and use
  `Content-Type: application/json`, so a cross-origin browser request needs a
  CORS preflight the server never grants (415 otherwise). When an `Origin`
  header is present it must be the dashboard's own loopback origin (403).
- Request bodies are capped at 64 KiB (413) and must be valid JSON (400).
- Pages and assets send `Content-Security-Policy: default-src 'self';
  script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'
  data:` with no inline script or style, plus `X-Content-Type-Options:
  nosniff`. `style-src 'self'` is still enforced: the app runs Base UI with
  `CSPProvider disableStyleElements`, and chart colors come from CSS variables
  instead of injected styles.

There is no authentication: any local process can call the API. Do not
expose the port beyond loopback (no reverse proxy, no port-forward to a
shared network).

