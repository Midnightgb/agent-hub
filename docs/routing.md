# Routing

## Preflight ladder

Every agent+model pair is checked through an ordered ladder before a job is
routed to it. Each rung short-circuits on failure, and results are cached
for `PREFLIGHT_TTL_MS` (15 minutes):

| Level | Check | When it runs |
|---|---|---|
| L0 | `--version` succeeds | `agents_status`, `route`, startup discovery |
| L1 | The requested model appears in the CLI's own model catalog | `agents_status`, `route`, startup discovery |
| L2 | Quota signal + circuit-breaker state | `agents_status`, `route` |
| L3 | A real `PONG` prompt round-trip | Only on an explicit dashboard "Ping" action — never at startup, never in bulk |

## Startup discovery

`scheduleStartupDiscovery()` runs in the background via `setImmediate` right
after the MCP process starts, so it never delays the stdio handshake with
Claude Code. It runs L0 + L1 only (never L3) for every CLI referenced in the
delegation map, prunes preflight-cache rows for agent:model pairs no longer
reachable from the map, and writes the merged result to `discovery.json`
(`{ [agent]: {agent, cmd, binPath, version, models, checkedAt, error,
note?} }`). It is TTL-gated the same 15 minutes as the preflight cache, and
can be disabled entirely with `AGENT_HUB_DISABLE_STARTUP_DISCOVERY=1`.

State writes (preflight cache, discovery, overrides) use atomic tmp+rename
writes because the MCP process and the dashboard process both write the same
files. The model list is fetched once per agent, not once per agent+model
pair; the three agents are probed in parallel, but pairs within one agent
are probed serially to avoid more than one live CLI process per agent at a
time.

## Delegation map

`route({taskType})` looks up an ordered candidate chain in
`DELEGATION_MAP` (`src/router.mjs`) and returns the first candidate that
passes availability filtering, plus the rest as fallbacks:

| Task type | Primary | Fallbacks | Why |
|---|---|---|---|
| `recon` | agy gemini-3.8-flash-low | opencode muse-spark-1.3 → claude haiku | proven context compression, cheap refreshable quota |
| `call-chain-trace` | agy gemini-3.8-flash-high | opencode nemotron-3-ultra → claude sonnet | needs multi-hop reasoning, 1M ctx |
| `research` | opencode muse-spark-1.3 | opencode mimo-v2.5 → agy gemini-3.8-flash-medium | zero cost, 1M ctx |
| `triage` | opencode muse-spark-1.3 | copilot auto → codex default | lowest latency |
| `second-opinion` | agy gemini-3.8-flash-high | copilot auto | different model lineage than Claude Code |
| `adversarial-review` | agy claude-sonnet-4-6 (parallel with copilot auto) | agy claude-opus-4-6-thinking | dual blind review off the Claude Code quota |
| `github-context` | copilot auto | — | built-in GitHub MCP; cheap models keep premium quota |
| `mechanical-edit` | agy gemini-3.8-flash-medium (write) | opencode deepseek-v4-flash (write) → copilot auto (write) → codex default (write) | cheap write-capable; single writer |
| `implementation-with-repo-rules` | claude sonnet | — | only Claude Code loads CLAUDE.md + skills + hooks |
| `architecture` | claude opus | agy claude-opus-4-6-thinking | highest reasoning |
| `structured-mechanical` | claude haiku | — | cheapest Claude tier |
| `ui-test` | agy gemini-3.8-flash-high | agy claude-sonnet-4-6 | requires `browser`; drives a Playwright MCP server ([setup](providers/agy.md#browser--ui-testing-ui-test)) |

Codex is only ever a last fallback, for small bounded tasks: its plan quota is
limited, and every call carries a baseline of about 17,000 input tokens (its own
system prompt), even for a one-word reply. Batch questions into one task. Model
`default` means the CLI's own default model, so no model name is guessed.

A `{agent: 'claude', model: 'haiku'|'sonnet'|'opus'}` candidate is a Claude
Code subagent tier, run by the caller through its own Agent tool — it is
never CLI-preflighted or breaker-checked. A candidate is filtered out of the
chain (and reported in the result's `skipped` list, with a reason) when it
is manually held, its CLI was not found on `PATH`, its cached preflight is
`unavailable`, or its circuit breaker is open. `route()` is advisory: it
never blocks the caller from delegating to a skipped pair directly.

## Quota state before delegating

agent-hub can show how much of each agent's usage limit is left before you
delegate, read from a local [CodexBar](https://github.com/steipete/CodexBar)
server (`codexbar serve`, default `http://127.0.0.1:8787`, override with
`AGENT_HUB_CODEXBAR_URL`). It appears as a `quota` field on `agents_status`
rows and on `route()`'s primary and fallbacks, in the `agents_quota` tool, at
`GET /api/quota`, and in the dashboard's Agents view.

**By default it never decides anything — with one deliberate exception.**
Quota data does not choose, skip, reorder or block an agent, and `route()`
returns the same chain with or without it — a test pins that. An exhausted
agent stays in its place; the point is that you see it before a job fails, and
decide. Setting `AGENT_HUB_QUOTA_ROUTING=skip` opts into quota-aware routing
instead (see below).

The exception is **codex**, which only ever appears as a LAST-resort fallback
in the `triage` and `mechanical-edit` chains because its plan quota is scarce
(see `src/routing/codex-gate.mjs`). There, and only there, codex's own quota
*does* reorder the chain: below 20% remaining on its most-constrained window it
is dropped entirely (never even attempted); at or above 50% remaining and "on
pace" (burn rate not ahead of the elapsed window) it is promoted to position 2
instead of being saved for last. Every other agent, and codex in every other
chain, is unaffected — quota still never decides anything for them.

### Opt-in: skip exhausted pairs (`AGENT_HUB_QUOTA_ROUTING=skip`)

With `AGENT_HUB_QUOTA_ROUTING=skip`, `route()` (and therefore `dispatch`)
drops a chain candidate before launching it when its own quota is used up, so
the next candidate runs instead of a job that would fail with a 429. It is
reported in `skipped` with reason `quota`:

- agy with agys accounts: every eligible account (not `unavailable`) is
  `exhausted` or below `AGENT_HUB_QUOTA_MIN_REMAINING` (default `0.05`) for the
  model's group (Gemini vs Claude/GPT).
- any other metered pair, or agy without agys: the lowest remaining CodexBar
  window is below that threshold.
- claude tiers are never skipped (they run on the host's own quota).

Unknown quota (no data, pending, stale, unmetered) never skips.

When a job fails with a quota error, the reset is parsed from the error
("Resets in 78h0m0s", "reset in 150 hours", an ISO timestamp, ...; one hour
when none is found) and the pair is marked exhausted until then in
`quota-exhaustion.json` (per model group for agy; a job that ran on an agys
account marks only that account, in `agys-exhaustion.json`). While a mark is
active `route()` skips the pair with reason `quota-exhausted-until <iso>`,
and `agents_status`, `agents_quota` and `GET /api/quota` show it as
`quotaExhaustedUntil`.

The dashboard service refreshes CodexBar and `agys quota --json` every
`AGENT_HUB_QUOTA_REFRESH_S` (default 300, `0` disables) and clears marks whose
reset passed or whose quota is back at or above the threshold. A mark younger
than one refresh interval is only cleared by its reset, since a quota reading
can lag a fresh 429.

Each pair maps to the CodexBar windows that actually limit it. agy splits by
model family: `gemini-*` models read the Gemini windows, while `claude-*` and
`gpt-*` models read the shared Claude/GPT windows, which are exhausted
independently. copilot and codex read their own provider, `opencode-go/*`
models read OpenCode Go, and the free opencode models and `deepseek/*` are not
metered by CodexBar. A window CodexBar reports with `usageKnown: false` is shown
as unknown, never as 0%. Readings are cached for five minutes, requested one
provider at a time (`/usage?provider=all` probes about 69 providers and is
slow), and a missing CodexBar never blocks or slows a delegation.

## Adaptive routing

`route()` used to order a task's chain only by availability and an accepted
proposal. It can now rank candidates by measured quality, latency and cost, and
filter them by required capabilities — while staying explainable:

```js
const r = await route({
  taskType: 'recon',
  requirements: ['sessionResume'],          // hard capability filter
  preferences: { quality: 0.6, cost: 0.2, latency: 0.2 },
  adaptive: true,                            // reorder primary/fallbacks
})
// r.ranking: [{ agent, model, score, reasons: [{dimension, raw, weight, ...}] }]
```

- `src/capabilities.mjs` derives capabilities from signals that already exist:
  `sessionResume` from each adapter's resume argv (`agy --conversation`,
  `opencode -s`, `codex exec resume`; copilot has none), `github` where the CLI
  has built-in GitHub access or works through PRs, `largeContext` from
  `MODEL_REGISTRY` strengths (`1M ctx`). `web` is a reserved key, false
  everywhere today. `browser` is detected per call for agy only, from the agy
  MCP config the job would use (an enabled Playwright server); `ui-test`
  requires it.
- Scoring is a weighted sum over quality (`qualityScore`, else `verifiedRate`,
  else `successRate`), latency (`p95Ms`) and cost (`costUsdAvg`), normalized
  within the eligible set. A dimension with no data is dropped and its weight
  redistributed — an unmeasured pair is **not** ranked as bad.
- `adaptive: false` (default) keeps today's order and still returns `ranking`
  for transparency. Persistent chain changes remain a human-accepted proposal;
  a candidate missing a required capability appears in `skipped` with
  `missing_capabilities:<keys>`.
- With no metrics at all, every score is 0 and the order is the static chain —
  routing degrades to today's behaviour, never to a wrong pick.

## Routing proposals

`refreshProposals()` compares a task type's current primary CLI candidate
against the other CLI candidates in its chain. It proposes promoting the
candidate with the strictly better 95% Wilson score lower bound — its lower
bound beats the primary's upper bound — once both have at least 10 samples.
New proposals stay `pending`: nothing changes until a human accepts one at
`#/approvals?tab=proposals`. Accepting one supersedes any other accepted
proposal for the same task type, and a stored proposal whose chain no longer
matches the delegation map (its chain hash changed) is marked `superseded`.
After a rejection, no new proposal for that task type for 7 days. `route()`
applies an accepted proposal to the chain and returns it as `appliedProposal`.

## Model autodiscover

`discovery.json` already records each CLI's own model catalog (see
"Startup discovery" above); `computeModelGaps({discovery, map, registry})`
(`src/model-gaps.mjs`) diffs that catalog against `DELEGATION_MAP` and
`MODEL_REGISTRY` for **agy and opencode only** — copilot's catalog is not
authoritative and codex has no real model listing, so neither ever produces a
gap. A model id is split into `{family, version, effort}` (e.g.
`gemini-3.8-flash-low` → family `gemini-*-flash`, version `[3, 8]`, effort
`low`); a catalog model is a **version bump** of a model already used in some
chain when it shares that model's agent, family and effort suffix and has a
strictly higher version — the highest such match wins. A catalog model that
matches no chain model and isn't already in `MODEL_REGISTRY` is **unmapped**:
no taskType can be inferred safely for it, so it is only ever surfaced for a
human to look at, never proposed.

`refreshProposals()` turns each version bump into a pending `add_candidate`
proposal (one per taskType per bump, deduped and cooldown-gated the same way
as a reorder proposal). Its `reason` names the bump; `addCandidate` carries
the new `{agent, model, mode}` and `replaces` names the older model id.
**Accepting one only ever appends the new candidate at the TAIL of that
taskType's chain — never index 0, and never as a reorder.** `route()` builds
this "effective chain" (the static `DELEGATION_MAP` chain plus every accepted
`add_candidate` step, in acceptance order) before applying any accepted
reorder proposal, and `refreshProposals()` computes new reorder proposals
over that same effective chain — so a newly added candidate only ever gets
promoted ahead of the current primary through a later, evidence-backed
reorder proposal once it has its own metrics. `pruneCacheForMap` treats an
accepted `add_candidate` pair as reachable, the same as a static chain step.

`GET /api/proposals` and `POST /api/proposals/refresh` also return an
`unmapped` list (`[{agent, model}]`) of catalog models with no safe taskType,
rendered in the dashboard's Proposals panel alongside the proposal list.

## Learnings

`learning_propose` records a short gotcha about an agent, model or task type as
`pending`; a human approves or rejects it in the dashboard. Approved learnings
that match a job are prepended, most specific first, to the prompt of a
**root** turn only — at most 3, each up to 300 characters — as a
`<hub-learnings>` advisory block; a reply turn continues a conversation that
already has it. Text is sanitized on write and again on every read (control
characters, backticks and `<hub-learnings>` tags stripped, whitespace
collapsed) before it can reach another model's prompt.


### Probing a pending learning

`learning_probe({learningId, task?, cwd?, agent?, model?, taskType?, output?})`
gathers evidence before you decide. It runs the same read task twice, in
parallel, with the same agent, model and cwd. The **control** job gets the
normal approved selection. The **treatment** job gets that selection plus the
probed learning, and only that job does. Agent, model and taskType default to the
learning's scope; task and cwd default to the job named by its `sourceJobId`.
Anything still missing is an error raised before any job starts. Only `pending`
learnings can be probed, read mode only.

`learning_probe_result({probeId})` never waits. While either job runs it
returns `done:false` with both statuses. Once both are terminal it compares
the arms: status, errorKind, durationMs, responseChars and, with
`output:'review'`, findings by severity. It adds a `verdictHint` from fixed
rules:

1. Exactly one arm succeeded: that arm is better.
2. Neither succeeded: `inconclusive`.
3. Both succeeded and both have review findings: fewer blocker+major wins.
4. Otherwise the faster arm wins when the slower took over 1.5x as long and
   over 30 s longer.
5. Otherwise `no_difference`.

The comparison is stored once on the learning as `probes[]` in
`learnings.json` and a `learning.probed` event is recorded. The dashboard
learnings API returns `probes` with each learning. A probe never changes the
learning's status: the hint is evidence for the human who approves it.
