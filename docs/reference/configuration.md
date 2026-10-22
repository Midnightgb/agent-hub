# Configuration reference

## Configuration

| Env var | Effect |
|---|---|
| `AGENT_HUB_HOME` | Overrides the state directory (default `~/.local/share/agent-hub`). Tests always override this. |
| `AGENT_HUB_STORE` | Job store read path: `json` (default; reads `result.json`), `sqlite` (reads SQLite first with JSON fallback), or `shadow` (reads JSON, verifies against SQLite, and logs divergences). |
| `AGENT_HUB_READGUARD_IGNORED` | `1` includes gitignored files in read-mode change detection via `git status --ignored=matching`. Default `0`. |
| `AGENT_HUB_SANDBOX_PROFILE` | Spawning sandbox profile: `compatibility` (default; redacts secret env vars, inherits host HOME), `isolated-home` (redacts secrets, redirects HOME to a temporary directory), or `isolated` (redacts secrets, isolates HOME, TMPDIR, and XDG_* directories). See [Security and isolation](../security-isolation.md). |
| `AGENT_HUB_SANDBOX_INCLUDE` | Comma-separated paths to copy into the sandbox directory under `isolated` mode (relative paths maintain structure; absolute paths copy to root). |
| `AGENT_HUB_AGYS` | agys multi-account profile mode: `auto` (default) queries `agys list` and `agys quota --json` for automatic profile selection based on quota/priority; `off` disables agys. |
| `AGENT_HUB_AGYS_PROFILE` | Explicitly pins a named agys profile, overriding `AGENT_HUB_AGYS` and dashboard setting. |
| `AGENT_HUB_OPENCODE_BRIDGE` | `1` enables the OpenCode lifecycle bridge: when a delegated job finishes, agent-hub resumes the originating OpenCode session with `POST /api/session/{id}/prompt` (`{ text, resume: true }`), reading the service URL/password from `~/.local/state/opencode/service.json` (override with `AGENT_HUB_OPENCODE_SERVICE_FILE`). Default off. |
| `AGENT_HUB_OPENCODE_SERVICE_FILE` | Path override for the OpenCode service credentials file (default `~/.local/state/opencode/service.json`). |
| `AGENT_HUB_HARNESS` | Default caller harness profile: `generic` (waitMode: `none`), `claude-code` (waitMode: `attention`), or `opencode` (waitMode: `attention`). |
| `AGENT_HUB_LEASE_TTL_MS` | Lease TTL in milliseconds for write-mode worktree locks (default 120,000 ms / 2 min). |
| `AGENT_HUB_DISABLE_STARTUP_DISCOVERY` | `1` skips the background discovery pass on MCP startup. Used by tests that boot the real stdio server and must not spawn a real CLI as a side effect. |
| `AGENT_HUB_CODEXBAR_URL` | Base URL for the local CodexBar quota server (default `http://127.0.0.1:8787`). |
| `AGENT_HUB_QUOTA_ROUTING` | `skip` makes `route`/`dispatch` skip a pair whose quota is used up or marked exhausted after a quota error (see [routing](../routing.md#opt-in-skip-exhausted-pairs-agent_hub_quota_routingskip)). `off` (default) keeps quota informational. |
| `AGENT_HUB_QUOTA_MIN_REMAINING` | Remaining fraction (0..1) below which a quota window counts as used up under `skip` (default `0.05`). |
| `AGENT_HUB_QUOTA_REFRESH_S` | Seconds between the dashboard service's quota refreshes under `skip`, which clear exhaustion marks once quota is back (default `300`, `0` disables). |
| `AGENT_HUB_CODEX_IGNORE_USER_CONFIG` | `1` passes `--ignore-user-config` to Codex CLI invocations to ignore user-level configuration files. |
| `AGENT_HUB_SCHEDULER` | `0` disables recurring Jules schedule evaluation in the dashboard service. |
| `AGENT_HUB_DB_INIT_RETRIES` | Number of retry attempts when initializing the SQLite database under file-lock contention (default 10). |
| `AGENT_HUB_POST_EDIT_CHECK` | Read by `skills/agy-delegate/scripts/agy-run.sh`: printed as the reminder command to run after a `--write` run, so it names your project's actual type-check/lint/test command instead of a placeholder. |
| `AGENT_HUB_LIVE` | `1` enables `npm run test:live` (one real ping per adapter, uses real quota). |
| `JULES_API_KEY` | API key for Google Jules cloud agent delegation (used when no accounts are configured in `accounts.json`). |

| State file (under `AGENT_HUB_HOME`) | Contents |
|---|---|
| `events.jsonl` | Append-only event log: jobs, preflight, hook-recorded subagents, harness wake events |
| `agent-hub.db` | SQLite database (coordination authority: `workflows`, `workflow_nodes`, `jobs`, `leases`, `harness_origins`, `task_handoffs`, `task_context`) |
| `preflight-cache.json` | L0-L2 results per agent:model pair, TTL-gated (15 min) |
| `discovery.json` | CLI binPath/version/model catalog per agent, from startup + on-demand discovery |
| `overrides.json` | Manual per-pair `hold`/`breakerReset` entries |
| `proposals.json` | Routing proposals (`pending`/`accepted`/`rejected`/`superseded`) with their evidence |
| `learnings.json` | Curated agent/model/taskType learnings (`pending`/`approved`/`rejected`) |
| `agys-mode.json` | Persisted agys mode configuration (`{ mode: 'off'\|'profile'\|'auto', profile? }`), written by the dashboard Providers view toggle |
| `accounts.json` | Jules accounts and masked API keys (mode `0600`) |
| `schedules.json` | Recurring Jules tasks evaluated by the dashboard service |
| `sources-cache.json` | Cached GitHub repositories connected to Jules accounts |
| `quota-cache.json` | Cached CodexBar quota readings (5 min TTL) |
| `quota-exhaustion.json` | Pair exhaustion marks (per model group for agy) recorded from quota errors under `AGENT_HUB_QUOTA_ROUTING=skip` |
| `runs/<jobId>/` | `prompt.txt`, `stdout.log`, `response.txt`, `result.json` per job |
| `runs/<workflowId>/<stepId>/artifacts/` | Step evidence directory: `artifacts.manifest.json`, `verification.json`, `judge.json`, `handoff.json`, and step-declared artifact files |
| `runs/.locks/` | Per-cwd single-writer locks for write-mode jobs |

## Documentation

- [Implementation & Architecture Report (2026-09-21)](../implementation-report-2026-09-21.md): Comprehensive technical report covering features, architecture updates, MCP tool additions, and reliability posture implemented across 48 merged pull requests (C0–H milestones).
- [Security Isolation Matrix & Container Design](../security-isolation.md): Detailed specification of execution isolation levels (`compatibility`, `isolated-home`, `isolated`), credential hygiene, ReadGuard gitignored change detection, and container sandbox architecture.

