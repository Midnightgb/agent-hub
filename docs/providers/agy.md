# agy (Antigravity)

## Provider profiles and agys

To prevent quota exhaustion on single accounts, agent-hub supports multi-account
provider profiles (`src/providers/profiles.mjs`) and integrates with the `agys`
Go CLI (`src/providers/agys.mjs`):

- **Profile lifecycle states**: `selected` (active default), `fallback`
  (eligible alternate), `exhausted` (quota exhausted, errorClass `quota`, or
  bucket >= 100%), and `unavailable` (auth/billing failure).
- **Selection policies**: `priority`, `least_used`, and `round_robin`.
- **agys integration**: see the dedicated [agy multi-account (agys)](#agy-multi-account-agys)
  section below for one-time setup, mode precedence, dashboard controls, and safe
  degradation.

## agy multi-account (agys)

`agys` is a separate Go CLI (`~/.local/bin/agys`) that isolates multi-account
Antigravity (`agy`) profiles under `~/.agys/profiles/<name>/` by overriding `HOME`.
It allows routing jobs across multiple Google accounts so a single account's
quota exhaustion never blocks task execution.

### One-time setup

Create and manage profiles directly using the `agys` CLI:

```bash
agys add <name>                     # runs `agy login` under ~/.agys/profiles/<name>/
agys list                           # lists profiles with active default, priority, email, path
agys list -q                        # quiet: lists profile names only
agys quota                          # human-readable quota usage across profiles
agys quota --json                   # JSON quota snapshot used by agent-hub
agys use <name>                     # sets the active default profile
agys priority set <name> <priority> # sets integer priority (higher = preferred in auto mode)
```

### Share the base agy setup with every profile (`agent-hub agys sync`)

Because each profile has its own `HOME`, an agy job run through a profile does
not see the user's global agy setup in `~/.gemini`: no `GEMINI.md`, no user
skills and no MCP servers. `agent-hub agys sync` fixes that by symlinking these
base paths into every `~/.agys/profiles/<name>/.gemini/`:

| Path under `.gemini/` | What it is |
|---|---|
| `GEMINI.md` | global instructions |
| `skills`, `antigravity/skills`, `antigravity-cli/skills` | user skills |
| `config/mcp_config.json` | MCP servers |

```bash
agent-hub agys sync --dry-run   # print what would change, write nothing
agent-hub agys sync             # create the links
agent-hub agys sync --mcp-merge # link the rest, keep a per-profile MCP config
```

- A base path that does not exist is skipped.
- Idempotent: a symlink that already points at the base path is left alone; a
  symlink pointing elsewhere is replaced.
- An empty file or directory in the profile is replaced by the link. A
  non-empty one is first moved to `<path>.bak-<epoch>`.
- `--mcp-merge` keeps the profile's own `mcp_config.json` and merges the base
  `mcpServers` into it instead: a same-named profile server is replaced by the
  base one, profile-only servers and other keys are kept, and a changed file is
  copied to `mcp_config.json.bak` first. A profile config that is a symlink is
  turned into a real copy, so the merge never writes to the base file. Use it
  when profiles need servers the base config should not have.
- The command writes unless `--dry-run` is given; there is no `--apply`.

### Modes and precedence

Profile selection operates in one of three modes:
- `auto`: dynamically inspects `agys list` and `agys quota --json` and picks the
  non-exhausted profile with the highest load-aware score for the job's model
  group (Gemini vs Claude/GPT): `remainingQuota - 0.15 * inFlightJobsOnThatAccount`,
  ties broken by least-recently-assigned, then priority, then name. See
  [Load-aware rotation](#load-aware-rotation-auto-mode) below.
- `profile`: pins execution to a specific named profile.
- `off`: disables agys wrapping entirely; runs standard `agy`.

An individual `delegate()`/`dispatch()` call can also pin a profile for just
that call — see [Per-call profile pin](#per-call-profile-pin) below; this is
independent of (and takes priority over) the mode precedence table.

Precedence is evaluated in strict order (highest to lowest):

1. **Environment pin** (`AGENT_HUB_AGYS_PROFILE=<name>`): unconditionally forces the named profile (`mode: 'profile'`).
2. **Environment mode** (`AGENT_HUB_AGYS='auto'` or `'off'`): forces `auto` or `off` at the process level.
3. **Persisted dashboard setting** (`agys-mode.json` under `AGENT_HUB_HOME`): written by the dashboard Providers view toggle (`{ mode, profile }`).
4. **Default**: `auto`.

### How to change the mode

- **Dashboard**: in the **Providers** view (`#/providers`), toggle between `off`, `profile`, and `auto`. When `mode: 'profile'`, select any configured profile from the dropdown. If an environment variable is set (`AGENT_HUB_AGYS` or `AGENT_HUB_AGYS_PROFILE`), the toggle is disabled with an explanatory note.
- **Client environment configuration**:
  - **Claude Code**: configure `mcpServers['agent-hub'].env` in `~/.claude.json`:
    ```json
    {
      "mcpServers": {
        "agent-hub": {
          "env": {
            "AGENT_HUB_AGYS": "auto",
            "AGENT_HUB_AGYS_PROFILE": "work"
          }
        }
      }
    }
    ```
  - **OpenCode**: configure `mcp['agent-hub'].environment` in `~/.config/opencode/opencode.json`:
    ```json
    {
      "mcp": {
        "agent-hub": {
          "environment": {
            "AGENT_HUB_AGYS": "auto"
          }
        }
      }
    }
    ```
    Or via CLI: `opencode mcp add --env AGENT_HUB_AGYS=auto`

### Safe degradation

When `agys` is not installed on `PATH` or an `agys` invocation fails (non-zero exit, timeout, missing binary), the profile resolver returns `{ profile: null, status: 'unavailable' }` and `agy` runs **UNCHANGED** as a plain `agy` process. Because of this graceful fallback, `auto` is completely safe as the default setting: environments without `agys` run standard Antigravity without interruption.

### How it works underneath

- **Transparent wrapping**: when a profile is selected, agent-hub wraps the CLI command as:
  `agys run <profile> -- <agy argv>`
- **Effort-suffix splitting**: `agys run` injects `--effort high` when `--effort` is omitted. Because agent-hub model IDs encode the effort tier in the model name (for example, `gemini-3.8-flash-low`), `agy` rejects conflicting flags (`--model gemini-3.8-flash-low conflicts with --effort=high`). The hub's `agyArgvForAgys` automatically splits suffixed model IDs: `--model gemini-3.8-flash-low` becomes `--model gemini-3.8-flash` plus `--effort low`. An explicit `--effort` is left untouched.

### Observing which account ran

- **Job records**: `profile` and `profileStatus` (`selected`, `fallback`, `exhausted`, `unavailable`) are set synchronously at creation in `startJob()`, making them visible immediately while running via `job_status` and `job_result` (and stored in the SQLite `jobs` table).
- **Job events**: `job.started`, `job.finished`, and `job.failed` events carry `profile` and `profileStatus`.
- **Dashboard**: Running Jobs (`#/jobs`) and History (`#/history`) display the `JobProfileBadge` with the profile name and status pill. The Providers view (`#/providers`) shows the active mode, source, selected profile, and live quota bucket gauges.
- **Process table**: `pgrep -af agys` shows the running wrapped command.

### Two-profile example

```bash
agys add personal
agys add work
agys priority set personal 10
agys priority set work 5
```

With mode `auto`, agent-hub routes jobs to `personal` (priority 10). If `personal` quota is exhausted (bucket >= 100% or errorClass `quota`), agent-hub automatically routes to `work` as a fallback. To force the work profile for a specific session, set `AGENT_HUB_AGYS_PROFILE=work`.

### Load-aware rotation (`auto` mode)

`auto` mode no longer just picks the profile with the most remaining quota —
it also accounts for how many jobs are already in flight on each account, so
a burst of similar-quota jobs spreads across accounts instead of piling onto
one:

```
score = remainingQuota(profile, modelGroup) - 0.15 * inFlightJobs(profile, modelGroup)
```

- `remainingQuota` is the minimum remaining fraction across that model group's
  quota windows (5h, weekly, ...), same as before.
- `inFlightJobs` counts `running`/`queued` agy jobs on that profile in the
  same model group (Gemini vs Claude/GPT), read from the job store plus a
  short-lived (10s) in-process reservation that covers the gap between
  picking a profile and the job record landing in the store (protects
  same-tick bursts, e.g. several parallel `dispatch()` calls).
- The highest score wins. Ties (within floating-point noise) break by
  least-recently-assigned profile for that model group, then priority, then
  name.
- A profile with no readable quota data still sorts last, unaffected by load
  (unchanged from before).
- Only the slow `agys list`/`agys quota --json` snapshot is cached (60s); the
  pick itself is recomputed on every call, so load-awareness stays accurate
  within that window.

Net effect: 3 simultaneous jobs against accounts with similar quota land on 3
different accounts; an account with meaningfully more quota still gets more
of the next few jobs before a similar-quota idle account becomes preferable.

### Per-call profile pin

`delegate()` and `dispatch()` accept an optional `profile` input to pin one
agys account for that single call, independent of the global mode:

```js
delegate({ agent: 'agy', model: 'gemini-3.8-flash-low', task: '...', cwd: '...', profile: 'work' })
dispatch({ task: '...', cwd: '...', taskType: 'recon', profile: 'work' })
```

- Only meaningful for agent `agy` — any other agent, or a `dispatch()` call
  whose routed candidate is not `agy`, fails fast with a clear error.
- Validated against the live `agys list`; an unknown profile fails fast
  (`unknown agys profile "...": valid profiles: ...`) instead of silently
  falling back to auto selection.
- Recorded on the job as `profile` with `profileStatus: 'pinned'` (distinct
  from the auto-selected `selected`/`fallback` statuses).
- Overrides BOTH auto selection and a global pin — including under
  `mode: 'off'` — since it is explicit per call.
- In `dispatch()`, a pinned profile is never swapped by retry/fallback
  recovery: only the candidate (agent/model) can fail over, the pinned
  account stays fixed. A 429 on a pinned job still fails with quota, and
  exhaustion is still recorded for that account.

### When every account is exhausted

Account selection only picks among accounts; when all of them are out of quota
for a model group, the job still runs and fails. With
`AGENT_HUB_QUOTA_ROUTING=skip`, `route`/`dispatch` instead skip that agy
candidate (reason `quota`) once every eligible account is `exhausted` or below
`AGENT_HUB_QUOTA_MIN_REMAINING`, and the next candidate in the chain runs. The
dashboard service's quota refresh (`AGENT_HUB_QUOTA_REFRESH_S`) re-reads
`agys quota --json` and clears an account's exhaustion record once it has
quota again. See [routing](../routing.md#opt-in-skip-exhausted-pairs-agent_hub_quota_routingskip).


## Browser / UI testing (`ui-test`)

agy has no built-in browser in headless `-p` mode, so a UI check delegated to it
answers `NO_BROWSER` unless agy has a browser MCP server. agys runs every
profile with its own `HOME`, so each profile reads its own
`~/.agys/profiles/<name>/.gemini/config/mcp_config.json`, separate from the base
`~/.gemini/config/mcp_config.json`.

1. Add Playwright MCP to the base agy config:

   ```bash
   agy mcp add playwright npx -y @playwright/mcp@0.0.83 --headless --isolated \
     --executable-path <path-to-chromium>
   ```

2. Make every agys profile see it:

   ```bash
   agent-hub agys sync --dry-run   # print what would change
   agent-hub agys sync             # write it
   ```

   By default each profile's `mcp_config.json` becomes a symlink to the base
   one (see [Share the base agy setup](#share-the-base-agy-setup-with-every-profile-agent-hub-agys-sync)),
   so later `agy mcp add` calls reach every profile without another sync.
   `--mcp-merge` merges the base servers into a per-profile copy instead.

3. Check `agents_status`: every agy row carries
   `browser: { available, base, profiles: { <name>: true|false } }`.
   `available` is the `browser` capability for the current agys mode (`off`:
   base config; pinned profile: that profile; `auto`: any profile).

4. Dispatch with `taskType: 'ui-test'` (read mode, agy
   `gemini-3.8-flash-high`, fallback agy `claude-sonnet-4-6`, default timeout
   at least 1800 s). The page must already be reachable: the agy guard tells the
   job to use MCP browser tools and not to start a dev server.

A config counts as having a browser when an enabled server (no
`disabled: true`) is named `playwright` or references `@playwright/mcp` in its
command or args; a missing, empty or invalid file has no servers. A symlinked
profile config is read through the link.
`route({ requirements: ['browser'] })` and `dispatch({ requirements: ['browser'] })`
skip candidates without it (`missing_capabilities:browser`), and `ui-test` adds
the requirement on its own. In `auto` mode, profile selection for such a job
only considers profiles with a browser server when at least one has one. A job
that still lands on a config without one (for example a per-call `profile` pin)
runs anyway and records a warning on the job.
