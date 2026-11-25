# Verification

## Hub-run verification for delegate/dispatch

agy CLI 1.2.8's `run_command` auto-detaches a slow command (tests, builds, dev servers, package
installs) into a background task, and its own `-p` idle-exit kills that task while still
reporting `status:"SUCCESS"` — the work is silently lost, not just slow (upstream
google-antigravity/antigravity-cli #1044, #1076; no flag to disable). Prompt instructions alone
cannot prevent this, because the CLI's own idle-exit — not the model — decides to kill the task.
So the hub never asks agy (or any agent) to run its own verification: `src/adapters/agy.mjs`'s
`buildArgv` prepends a fixed, hub-owned instruction block to every agy prompt (unless
`guard:false`, reserved for a read-only probe like `preflight.mjs`'s ping) telling it to write
code and tests only — a RED test is written, never executed — and that the hub verifies
afterwards. The existing `incomplete` errorKind (the background-kill marker, see
`src/adapters/agy.mjs`'s `classifyError`) stays as the safety net for whatever slips through.

`delegate`/`dispatch` accept an optional `verify` array — the same check shapes
`normalizeVerifyCheck` above accepts (`argv` at minimum; `artifact`/`diff`/`schema` also work when
the job carries a `workflow_id`/`step_id`):

```js
delegate({
  agent: 'agy',
  model: 'gemini-3.8-flash-medium',
  task: 'Implement the feature with a RED test.',
  cwd: '/path/to/worktree',
  mode: 'write',
  verify: [
    { name: 'tests', argv: ['npm', 'test'] },
    { name: 'typecheck', argv: ['npm', 'run', 'typecheck'] },
  ],
})
```

- Invalid input (e.g. an empty `argv`) is rejected synchronously by `normalizeVerifyCheck`
  **before** the job is ever created — a bad `verify` never reaches routing, breaker checks,
  reservation, or `startJob`.
- Once (and only once) the job reaches `succeeded`, the hub runs each check in the foreground —
  bounded timeouts via `src/process.mjs`'s `runCommand`, never a shell, never in the background —
  in the job's own `cwd` by default (a check's own `cwd` still wins). This happens inside
  `finishJob`, before `startJob` releases the write lock (and before its lease heartbeat stops),
  so a write job's lock covers the whole verification run.
- A job that ends `incomplete`, `failed`, or `canceled` never runs its checks: the job record gets
  `verification: { ok: null, checks: [], skipped: true, reason }` instead, so a caller can tell
  "never ran" apart from "ran and failed."
- A failing check **never** changes the job's own `status` (it stays `succeeded`) and never trips
  a circuit breaker — verification is a separate signal, not a job outcome.
- The result — `{ ok, checks: [{ name, ok, exitCode, durationMs, outputTail }] }` — is recorded as
  `verification` on the job record, and surfaced through `job_status`/`job_result`, the
  `job.finished` event (`verificationOk`, the overall boolean only — the full checks array stays
  on the record), and the dashboard's job detail view.
- Reused, not reimplemented: `runJobVerification` (`src/verify.mjs`) shares `normalizeVerifyCheck`
  and the same argv-execution primitive as the workflow-node verifier below (`runVerification`) —
  there is exactly one place that spawns a verification command.

## Evidence artifacts

Execution success is not task success, and an opaque `response.txt` is not
evidence. A node can declare the evidence files it must produce, and
downstream nodes consume them by reference instead of by inlining a whole
response.

```js
{
  id: 'implementation',
  type: 'delegate',
  agent: 'opencode',
  model: 'opencode-go/glm-5.3', // must be allowed in the dashboard model policy
  mode: 'write',
  artifacts: ['plan.md', 'diff.patch', 'test-report.json'],
  task: 'Implement the feature. Baseline brief: artifact://research/plan.md',
}
```

- The engine creates `runs/<workflowId>/<stepId>/artifacts/` and appends the
  absolute path plus the exact filename list to the dispatched task, so the
  agent writes real files there instead of burying everything in prose.
- A task may reference an upstream artifact with
  `artifact://<workflowId>/<stepId>/<name>`; the engine inlines its content
  (capped at 64 KiB per ref, marked when truncated) before dispatch. An
  unresolved ref fails the node with `unresolved artifact ref: <ref>` rather
  than silently handing the literal token to a model.
- On success the engine writes `artifacts.manifest.json` next to the directory
  with per-name `present`/`missing`, bytes and sha256, and the same manifest
  travels on the `job.finished` event.
- The store is path-safe (every segment validated against the same shape
  `jobstore` uses for job ids) and writes atomically. A declared file that is
  missing is recorded, not yet fatal — enforcement belongs to the verifier
  (C3).

## Verifier

A node reaching a terminal success only means the CLI finished. A node can
declare deterministic checks, and the engine records a verdict next to the
result:

```js
{
  id: 'implementation',
  type: 'delegate',
  artifacts: ['diff.patch', 'test-report.json'],
  verify: {
    required: true,
    checks: [
      { name: 'tests', argv: ['npm', 'test'] },
      { name: 'typecheck', argv: ['npm', 'run', 'typecheck'] },
      { name: 'evidence', artifact: 'test-report.json' },
      { name: 'scope', forbid: ['src/generated'] },
    ],
  },
}
```

- Three check kinds, all deterministic and shell-free: `argv` (run a command,
  pass on the expected exit code), `artifact` (a C2 evidence file must exist,
  optionally from another step via `from`) and a diff/`forbid` check (`git diff
  --name-only` must not touch those path prefixes).
- The verdict is `{ verified, required, checks, startedAt, finishedAt }`. It is
  written to `runs/<workflowId>/<stepId>/artifacts/verification.json`, travels
  on `job.finished`/`job.failed`, and is mirrored best-effort onto the job
  record's `verified` column.
- `required: true` makes a failed verdict fatal: the node ends `failed` with
  `verification failed: <checks>` and the verdict attached, and the retry loop
  is skipped — a deterministic failure is not a transient one. With the default
  `required: false` the node still succeeds and the verdict is simply the truth
  a later judge acts on.
- C3 produces the verdict; it does not revise. Turning `needs_revision` into a
  re-dispatch is C4's job. There is no shell string anywhere: checks are argv
  arrays run through the same `runCommand` the rest of the hub uses.

## Judge and revision loop

A verification verdict is data; the judge turns it into a decision and, when
the decision is `needs_revision`, the engine tries again:

```
implementation -> verification -> judge -> accepted
                                    |-> needs_revision -> worker -> verification -> judge
                                    |-> rejected
                                    |-> blocked
```

```js
{
  id: 'implementation',
  type: 'delegate',
  maxRevisionAttempts: 2,
  verify: { required: true, checks: [{ name: 'tests', argv: ['npm', 'test'] }] },
}
```

- Decision rules are deterministic over the C3 verdict: no verification or
  `verified: true` -> `accepted`; a failed `artifact` check whose ref points to
  **another** step (upstream evidence the node cannot produce itself) ->
  `blocked`; otherwise `revision < maxRevisionAttempts` -> `needs_revision`,
  else `rejected`.
- `needs_revision` resets the attempt counter and re-dispatches the worker
  against the same node, with no backoff and up to `maxRevisionAttempts` times
  (default `0`, so a node without it behaves exactly as in C3).
- `rejected`/`blocked` fail the node only when `verify.required` is true;
  otherwise the node still `succeeded` and the verdict is the truth. A
  `blocked` verdict short-circuits: no revision is burned on an upstream
  failure the node cannot fix.
- The verdict is `{ verdict, reason, revision, maxRevisionAttempts, required,
  failed }`, written to `artifacts/judge.json` next to `verification.json`, and
  carried on the node result and on `job.finished`/`job.failed`.
- When `needs_revision` triggers, `buildRevisionFeedback` (`src/revision.mjs`)
  formats a bounded feedback block (`<agent-hub-revision>`) containing failed
  check names and specific failure findings, capped at `REVISION_LIMITS` (max 3
  findings, max 300 characters each) and instructs "Do not change unrelated
  files." This feedback is prepended to the task prompt on re-dispatch.

