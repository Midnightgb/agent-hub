# gentle-shell

`gentle-shell` launches [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) with the Gentle Shell
package loaded and its own isolated agent home (`~/.gentle-shell/agent`). agent-hub runs
it headless with `pi -p --mode json`.

## Explicit-only

gentle-shell bills per token on the provider its home is signed in to (today an
Anthropic API key), so **no `DELEGATION_MAP` chain names it**: `route` and `dispatch`
never pick it. Reach it only by naming it:

```jsonc
// delegate
{ "agent": "gentle-shell", "model": "anthropic/claude-sonnet-5-5", "task": "...", "cwd": "...", "mode": "read" }
```

`task_assign` and `job_reply` accept it too. Its pairs live in `EXPLICIT_ONLY_PAIRS`
(`src/router.mjs`), so `agents_status`, `agents_quota`, the boot preflight and the
dashboard still check and show them.

Cost note: every run carries the Gentle Shell system prompt (~19k input tokens). A
one-file read on `anthropic/claude-haiku-4-5` measured about $0.027. `job_result`
reports `costUsd` from pi's own usage accounting.

## Models

Model ids use pi's `provider/id` form. `pi --list-models` (run as
`gentle-shell -- --list-models`) lists only providers the home is signed in to, so a
listed model is also an authenticated one. The `compat-custom` catalog is skipped.

```sh
gentle-shell -- --list-models              # what discovery and preflight L1 read
gentle-shell -- auth check --provider anthropic --json --no-refresh
```

To add a provider (for example an opencode go API key), sign in inside gentle-shell,
add the pairs you want to `EXPLICIT_ONLY_PAIRS` and `MODEL_REGISTRY['gentle-shell']`
(`src/config.mjs`), then refresh agents from the dashboard.

## Execution

| Mode | Flags passed to pi | Where it runs |
|------|--------------------|---------------|
| read | `--tools read,grep,find,ls --no-mcp` | in place (`readPolicy: 'enforced'`): no write, edit or bash tool exists |
| write | default tools | the usual write worktree |

`variant` maps to `--thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
A trailing `--` ends option parsing, so a prompt that starts with a dash stays a message.

Sessions are persisted. `job_reply` resumes with `--fork <sessionId>`: pi stores sessions
per project cwd, and `--session` from another cwd stops to ask a y/N question that a
detached job cannot answer. `--fork` copies the conversation into the spawn cwd without
asking and records the new session id.

## Errors and quota

pi exits 0 even when the provider fails; the failure is the last `turn_end` with
`stopReason: 'error'` and an `errorMessage` of the form `<status> <provider JSON>`.

| errorMessage | kind |
|--------------|------|
| `429`, `usage limit`, `rate_limit`, `quota`, `credit balance` | `quota` (retriable) |
| `401`/`403`, `authentication_error`, `x-api-key` | `auth` |
| `404`, `not_found_error`, `Model is unavailable` | `model_unavailable` |

CodexBar does not meter the Anthropic API, so its quota reads as unknown and never
causes a routing skip. `opencode-go/*` models on gentle-shell map to the `opencodego`
CodexBar provider, the same quota the `opencode` agent uses.
