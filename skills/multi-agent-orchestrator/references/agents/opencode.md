# opencode — reference

opencode v2 (`@opencode/cli`, tested against 2.0.10) replaced the v1 CLI contract this adapter
was originally written against — v1 and v2 do not coexist, so this is a hard cut, not dual
support. See `odd/tasks/opencode-v2-migration.md` for the full evidence table (`E1`-`E19`) behind
every claim below.

## The shared background server

opencode v2 runs every `run` invocation against a persistent, shared background server that owns
the actual execution: it holds provider credentials, the model catalog, and the running session.
The adapter **never passes `--standalone`**: a private, on-demand server reports zero credentials
and zero models even when warm, so any model id would fail to resolve. This is intentional, not
an oversight — do not "fix" it by adding `--standalone` back.

One consequence: because the server, not the local `opencode run` client, owns the session, killing
the client process does not by itself stop a run — see "Cancellation" below.

## Headless invocation (what `agent-hub`'s adapter builds)

```
opencode run -m <provider>/<model>[#variant] --format json --agent plan|build \
    [--title T] [-s <sessionId>] [--auto]
```

The prompt is **not** an argv element — it is written to the child's stdin and closed
(`stdinFor()`). An argv element containing spaces arrives at opencode wrapped in literal double
quotes and corrupts the prompt; the same text on stdin arrives verbatim. There is also no `--dir`
flag any more (removed in v2) — cwd comes from the spawned process's own `cwd`/`PWD` env var
instead, which `jobrunner.mjs` sets explicitly to the target worktree before every spawn.

- `mode:'read'` → `--agent plan`; `mode:'write'` → `--agent build` **and** `--auto` (auto-accept
  edits — required for a headless write job, otherwise it blocks on a prompt that never comes).
- Reasoning-effort variant (`minimal|low|medium|high|max`) is no longer a `--variant` flag (removed
  in v2) — it now rides the model id itself, as `<provider>/<model>#<variant>`. Explicit `variant`
  on `delegate`/`job_reply` wins; otherwise the model's `MODEL_REGISTRY` default applies (Muse Spark
  1.3 defaults to `high` — see Models below); otherwise the id is passed with no `#variant` suffix.
- `-s <sessionId>` resumes a prior session — this is what `job_reply` uses.
- Result parsing: JSONL event stream. A run can contain **several assistant messages**; the adapter
  groups `text` events by `part.messageID` and keeps only the last group, so concatenating every
  `text` event never splices unrelated turns together. Tokens come from the last `step_finish`
  event's `part.tokens`, which in v2 has **no `total` field** — the adapter sums
  `input+output+reasoning+cache.read+cache.write` itself. **`step_finish` can be absent entirely**,
  and `text`/`step_finish` events can still be silently dropped from the stream — if no `text`
  event is found at all, the adapter classifies the job `errorKind:'empty'` (retriable) rather than
  treating an empty response as a crash.
- A provider `error` event (v2 no longer emits `session.error` — that branch was dead against the
  real CLI and has been removed) with `statusCode:402` or an "insufficient balance" message
  classifies as `errorKind:'billing'` (not retriable) — a single occurrence opens the circuit
  breaker immediately for that agent+model pair, unlike `quota`/`canceled` which need two failures
  within 30 minutes. Measured live against `deepseek/deepseek-v4-pro`.
- Exit codes are meaningful: `0` ok, `1` failure, `130` interrupt. The adapter treats exit `130` as
  `errorKind:'canceled'` (retriable), not a crash — reachable in normal operation since the hub's
  own kill ladder sends SIGINT first (see Cancellation below), not just from an external Ctrl-C.
- opencode materializes a `.opencode/` directory inside the target cwd as a side effect.

## Cancellation

`opencode run` handles **SIGINT only**: its handler asks the shared server to interrupt the
session (`session.interrupt`) before the client exits 130. It does **not** register a SIGTERM
handler at all — SIGTERM is simply unhandled, and SIGKILL is uncatchable by definition. Because the
server, not the client, owns execution, only that SIGINT-triggered interrupt (or the explicit API
call below) actually stops server-side work; SIGTERM/SIGKILL only ever get rid of the local client
while an orphaned session keeps running on the server, spending tokens and editing the worktree
with nothing listening.

Consequently the hub's kill ladder (`src/process.mjs`) sends **SIGINT first**, then SIGTERM, then
SIGKILL — leading with SIGINT is what gives the server a chance to actually stop the run before
escalating. But SIGINT is still only best-effort: opencode's own SIGINT handler fires
`session.interrupt` and swallows a rejection, and a ladder that reaches SIGKILL never reaches the
server at all. So on a **timeout** specifically, `jobrunner.mjs` also fires an explicit,
independent cleanup call once the job has already been finalized as failed:

```
opencode api session.interrupt --param sessionID=<id>
```

The session id is recovered from the top-level `sessionID` field already present on every NDJSON
line captured before the timeout (the job may never have reached a terminal parse). This call is
verified idempotent and safe: it returns `{"interrupted": <bool>}` with exit 0, including `false`
on an already-finished session. It is best-effort — it never changes the job's recorded
`status`/`errorKind`, has its own short timeout, and never throws into finalization. The outcome
is recorded as a `job.interrupted` event, not folded into `job.failed`. No other adapter (`agy`,
`copilot`, `codex`, `jules`) defines this hook, so this is opencode-only (upstream issue #48683).

## Models: the dashboard decides (model policy)

opencode's catalog churns: free models are renamed or retired every few weeks. So no
opencode model id is pinned in `DELEGATION_MAP`. Chains name a **pool** instead, and the user
chooses in the dashboard (**Agents → opencode models**) which catalog models agent-hub may use.
The choice is stored in `$AGENT_HUB_HOME/model-policy.json` and survives reinstalls.

| Pool | Catalog models in it | Default for a model nobody decided yet |
|---|---|---|
| `@free` | catalog cost is zero (`opencode/*-free`, some `opencode-go/*`) | **allowed** |
| `@go` | `opencode-go/*` with a price or no price data (the OpenCode Go subscription) | **blocked** until allowed |
| — (paid) | any other priced model (`opencode/*`, `deepseek/*`) | **blocked**; never routed, only usable through an explicit `delegate` once allowed |

- `route()` expands a pool to the allowed models the live catalog lists, in the order set in
  the dashboard (at most 2 per pool). A pool with nothing allowed is reported in `skipped` as
  `pool_empty` and the chain falls through to the next agent.
- Pools per task type: `recon`, `research`, `triage` → `@free`; `call-chain-trace` → `@free` then `@go`
  then `@free`; `mechanical-edit` (write) → `@go`.
- Any job on an opencode model the policy does not allow is rejected before launch with an
  error whose `code` is `model_blocked` (delegate, plans, assignments, replies). A
  `model#variant` id is judged by its base model. Allowing a Go or paid model in the
  dashboard asks for confirmation, because it spends quota.
- A model the catalog does not list (or no catalog at all) is blocked unless you allowed it
  explicitly.

Free-tier models may train on prompts (Meta does for at least one): the `dataPolicy` badge in
`agents_status`/dashboard still shows it. `opencode-go/*` is capped ($12/5h · $30/week ·
$60/month) and its usage is read through CodexBar provider `opencodego` when available.

## Health / quota signal

- `opencode api model.list` = L1 listing. v1's `opencode models <provider> --verbose` scrape is
  gone (the provider positional and `--verbose` were both removed); the adapter now parses the
  JSON envelope `{location, data:[...]}` this API call returns, covering every provider in one
  shot, and rebuilds each id as `<providerID>/<id>` to match `DELEGATION_MAP`/`MODEL_REGISTRY`
  exactly. If that call fails or returns something else, the adapter falls back to parsing the
  flat `opencode models` list (one bare `<provider>/<id>` per line, no metadata).
- `opencode providers list`, `opencode stats --days 1 --models` — useful for a human check, not
  wired into the automated preflight ladder (unverified against 2.0.10; not covered by this
  migration's evidence table).
- No authoritative non-interactive quota API for the free tier or `deepseek/*`; `opencode-go/*`
  has hard dollar caps but no queryable usage — the circuit breaker is the only automated signal:
  ≥2 `quota`/`canceled` failures in 30 min for the same pair, or a **single** `billing` failure
  (402/insufficient balance opens it immediately, since a billing failure never clears on retry).

## Gotchas (measured)

1. Free-model prompts are not private by default — accepting the free tier's data-training terms
   is a deliberate per-user choice, not an oversight to fix. Never route a task containing
   secrets/`.env`/credentials to any agent regardless of tier.
2. A free model can hang past its timeout (`nemotron-3.5-lightning-free` did in live tests) —
   do not retry the same model: block it in the dashboard so its pool moves to the next one.
3. Cancel is not instant: the hub's own SIGINT is only best-effort at stopping server-side work
   (see Cancellation above), and if it doesn't land, `job_cancel` still takes as long as the
   SIGTERM/SIGKILL grace period before the process group is confirmed gone locally. Note the
   explicit `session.interrupt` API cleanup only fires on a hub-side **timeout**, not on a manual
   `job_cancel` — a canceled job relies on the kill ladder's SIGINT alone.
4. `.opencode/` appears in the target cwd after any run — expected, not a stray artifact to
   "clean up" mid-task.
