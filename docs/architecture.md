# Architecture

## Repository layout

```
src/
  index.mjs          MCP bootstrap (stdio) + --selftest/--version, tool registry
  config.mjs         paths, TTLs, model registry, timeouts, breaker constants, sandbox config
  schemas.mjs        shared zod contracts (tool outputSchema + dashboard types); browser-safe
  eventlog.mjs       appendEvent() (one atomic append per line) / readTail()
  fsutil.mjs         writeJsonAtomic()/updateJsonLocked() (lock + tmp + rename)
  jobstore.mjs       runs/<jobId>/{prompt.txt,stdout.log,response.txt,result.json}, AGENT_HUB_STORE
  artifacts.mjs      runs/<workflowId>/<stepId>/artifacts/ evidence store + artifact:// refs (C2)
  verify.mjs         declarative argv/artifact/diff checks -> { verified, checks } (C3)
  judge.mjs          verification verdict -> accepted | needs_revision | rejected | blocked (C4)
  revision.mjs       buildRevisionFeedback() (<agent-hub-revision> capped at 3 findings x 300 chars)
  context.mjs        workflow context & handoff persistence (task_context / task_handoffs)
  handoff.mjs        structured handoff schemas (Base, Research, Security, Implementation, Review)
  roles.mjs          role definitions (TRACE_ANALYST, SECURITY_REVIEWER, ARCHITECT, IMPLEMENTER, etc.)
  process.mjs        spawn argv, SIGINT->SIGTERM->SIGKILL ladder, runCommand()
  jobrunner.mjs      ties process+jobstore+worktree+timeouts+learnings+readguard+sandbox into startJob/cancelJob
  dispatch.mjs       atomic decide+execute: preflight revalidation, policy recovery, idempotency CAS
  execution-graph.mjs pure execution graph builder (roots, nodes, retry/resume/delegate edges)
  sandbox.mjs        environment filtering & sandbox profiles (compatibility, isolated-home, isolated)
  preflight.mjs      L0-L3 ladder, TTL cache, circuit breaker
  preflight-cli.mjs  `agent-hub preflight` table printer
  discovery.mjs      CLI discovery (binPath/version/models), startup + on-demand
  overrides.mjs      manual per-pair hold / breaker-reset overrides
  startup.mjs        non-blocking startup discovery scheduler + quota warmup
  router.mjs         delegation map + availability filtering, applies accepted proposals + agys
  capabilities.mjs   per agent/model capabilities derived from adapter + registry signals
  routing/score.mjs  preference-weighted, explainable candidate ranking
  worktree.mjs       write-mode gate (secondary git worktree) + single-writer lock
  metrics.mjs        job-history aggregation (success, p50/p95, tokens, cost, verified, quality, revisions)
  timeouts.mjs       effective timeout: explicit > adaptive (p95 x 1.5) > static default
  proposals.mjs      Wilson-bound chain-reorder proposals, human-accepted before they apply
  learnings.mjs      curated pending/approved gotchas, sanitized and injected into root turns
  readguard.mjs      git snapshot for read jobs -> read_mode_violation (AGENT_HUB_READGUARD_IGNORED)
  scratchcopy.mjs    read isolation per adapter readPolicy; hub-managed scratch copy (AGENT_HUB_READGUARD=strict)
  hook.mjs           SubagentStart/SubagentStop -> events
  dashboard.mjs      node:http dashboard: serves dashboard/dist, SSE /events, JSON API
  accounts.mjs       Jules accounts management (0600 permissions, key masking)
  breakers.mjs       per-class circuit breaker evaluation
  scheduler.mjs      recurring Jules schedule runner
  schedules.mjs      recurring schedule storage and CRUD
  storage/
    db.mjs           database connection lifecycle & migrations
    sqlite.mjs       SQLite tables (workflows, workflow_nodes, jobs, leases, harness_origins, task_handoffs, task_context) + JSON fallback
    index.mjs        storage facade (getDb, upsertJob, upsertHandoff, etc.)
  adapters/{base,agy,opencode,copilot,codex,index}.mjs
  cloud/
    jules/{client,adapter,supervisor}.mjs
    {check,credentials,gitContext,poller,remote-observation,runner,selectAccount,sources}.mjs
  harness/
    bridge.mjs       lifecycle bridge contract (supportsWake, resolveBridge)
    lifecycle.mjs    deliverCompletion() back to originating harness
    origin.mjs       recordDispatchOrigin / getOrigin mapping
    registry.mjs     harness profile registry (generic, claude-code, opencode)
    {generic,claude-code,opencode}.mjs
  notify/
    policy.mjs       notification routing & dedup policy
    adapters.mjs     console, file, webhook notification sinks
    watch.mjs        events.jsonl follower
    cli.mjs          `agent-hub watch` CLI
  planner/
    plan.mjs         WorkflowPlanSchema, validatePlan, materializePlan
    decompose.mjs    decompose({ intent, runPlanner, routeFn, maxSteps })
  policy/
    taxonomy.mjs     failure classification (billing, auth, quota, timeout, transport, crash, quality)
    registry.mjs     declarative policy table mapping failure classes to retry/resume/fallback/escalate
    executor.mjs     executeWithPolicy() loop
  providers/
    profiles.mjs     normalizeProfile, selectProfile, profileStateFor (selected, fallback, exhausted, unavailable)
    agys.mjs         agys CLI multi-account profile integration (list, quota, auto/explicit selection)
  quota/{codexbar,mapping}.mjs
  tools/{agents,jobs,insights,jules,learnings,messaging,planner}.mjs
  workflow/
    schema.mjs       NodeSchema, WorkflowSchema, DAG cycle detection
    engine.mjs       parallel wave execution, claims, transitions, artifact/verify/judge/handoff lifecycle
    dsl.mjs          safe condition expression parser (==, !=, AND, OR, NOT, exists)
    execution.mjs    execution handle management and waitExecution
    resolver.mjs     resolves artifact:// and handoff context for node dispatch
    resume.mjs       resumeWorkflowNodeFromExecution (WAITING -> RUNNING)
    state.mjs        in-memory & SQLite workflow state management
docs/
  implementation-report-2026-09-21.md  report of merged PRs, architecture updates, C0-H milestones
  security-isolation.md                security isolation matrix, sandbox profiles, container design
bench/               benchmark runner (run.mjs) & corpus scenarios (corpus.mjs)
dashboard/           React 19 + TS + Vite + Tailwind v4 + Base UI workspace, builds dist/
scripts/             build-dashboard.mjs — prepare hook; install-local.mjs
bin/agent-hub        dispatch: mcp | hook | dashboard | preflight | selftest | watch
skills/              multi-agent-orchestrator and agy-delegate skills (see Install)
test/                node --test; fixtures/ has real+synthetic CLI output;
                     test/chaos/ (chaos & crash tests); live/ (gated by AGENT_HUB_LIVE=1)
systemd/agent-hub-dashboard.service   NOT installed — copy it yourself if wanted
```

Runtime state (never committed) lives in `AGENT_HUB_HOME`, default
`~/.local/share/agent-hub/`: `events.jsonl`, `agent-hub.db` (SQLite WAL database
with tables `workflows`, `workflow_nodes`, `jobs`, `leases`, `harness_origins`,
`task_handoffs`, `task_context`), `preflight-cache.json`, `discovery.json`,
`overrides.json`, `proposals.json`, `learnings.json`, `agys-mode.json`,
`accounts.json` (mode `0600`), `schedules.json`, `sources-cache.json`,
`quota-cache.json`, `runs/<jobId>/` (`prompt.txt`, `stdout.log`,
`response.txt`, `result.json`), `runs/<workflowId>/<stepId>/artifacts/`
(with `artifacts.manifest.json`, `verification.json`, `judge.json`,
`handoff.json`, and declared artifacts), and `runs/.locks/`.

