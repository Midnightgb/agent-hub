---
name: agy-delegate
description: >
  Pointer to the agent-hub MCP delegation flow for Antigravity (`agy`) tasks — recon, symbol
  inventories, call-chain tracing, summarizing huge artifacts, second opinions, adversarial
  review via Claude Sonnet/Opus hosted inside Antigravity.
  Trigger: "agy", "antigravity", "gemini flash", "delegate this", "save tokens",
  "use my antigravity quota", "don't burn Claude", "cheap model", "second opinion".
license: MIT
metadata:
  author: jalejandrov93
  version: "2.1"
---

## Use `agent-hub`, not this skill directly

Prefer `delegate({agent:'agy', model, task, cwd, mode, ...})` through the `agent-hub` MCP
server. Read `~/.claude/skills/multi-agent-orchestrator/SKILL.md` for the full loop
(`agents_status → route → delegate → job_wait/job_status → job_result → synthesize`), the
break-even rule, and the delegation map. Agy-specific models, health signals, measured
latencies, and gotchas (silent `CANCELED`, `--json-schema` unreliability, `GEMINI.md` not
auto-loaded, `--add-dir` requirement for hosted Claude models) live in
`~/.claude/skills/multi-agent-orchestrator/references/agents/agy.md` — that file is now
canonical; this skill only points to it.

**Read mode is not enforced by agy.** Verified: `agy --mode plan` writes files with or without
`--dangerously-skip-permissions`, so a plan turn can still edit its `cwd`. agent-hub handles it
for you: an agy read job runs in a hub-managed scratch copy of your tree (a detached worktree
under `AGENT_HUB_HOME/scratch/` with your uncommitted and untracked files, removed when the job
ends), so pass your own checkout as `cwd` and create no worktree yourself. Anything agy wrote is
discarded and listed in `isolation.discardedPaths`. Fan several agy reads out in parallel the
same way (see the orchestrator skill's "Parallel reads"). `isolation:'in-place'` opts back into
running in your tree with the strict guard (`errorKind:'read_mode_violation'` on any change).
(opencode's plan agent did respect read mode in testing.)

**Never ask agy to run tests/builds/dev servers itself.** Its CLI auto-detaches a slow
`run_command` into a background task and its own idle-exit kills it while still reporting
`SUCCESS` — the work is silently lost. Through the MCP path, agent-hub already prepends a fixed
guard to every agy prompt saying so (write code and an unexecuted RED test only); pass your
verification commands as `verify` on `delegate`/`dispatch` instead and let the hub run them in
the foreground once the job succeeds — see `~/.claude/skills/multi-agent-orchestrator/SKILL.md`'s
"Verification" section and this repo's `docs/verification.md`. The `agy-run.sh` no-MCP fallback
below calls `agy` directly and does **not** get that guard — restate the same instruction in
`--task` yourself when using it.

## No-MCP fallback

If `agent-hub` is not registered in this session, use the wrapper script directly:

```bash
~/.claude/skills/agy-delegate/scripts/agy-run.sh \
  --task "<question>" [--model low|medium|high|pro|sonnet|opus|oss] \
  [--max-lines N] [--timeout S] [--write] [--raw] [--cwd DIR]
```

Aliases resolve to `gemini-3.8-flash-{low,medium,high}`, `gemini-3.1-pro-high` (`pro`),
`claude-sonnet-4-6` (`sonnet`), `claude-opus-4-6-thinking` (`opus`), `gpt-oss-120b-medium`
(`oss`) — check them against your own `agy models` output, since agy's catalog moves over time.
It writes the full response to the scratchpad and prints only a header (`model · seconds ·
tokens · lines · mode`), the file path, and the first `--max-lines` lines; injects
`<cwd>/GEMINI.md` (if <8KB) as project rules since `agy -p` does not auto-load it; and always
passes `--dangerously-skip-permissions` + `--add-dir` (required for the hosted Claude models).
Never call `agy` directly — the wrapper's output contract is the difference between 108s/~27k
tokens and 4s/233 tokens.

> Author's setup (verified 2026-09-11 against agy 1.2.1's `agy models` output): the aliases
> above matched these exact ids.

## Resources

- Canonical agy reference (models, health, gotchas): `~/.claude/skills/multi-agent-orchestrator/references/agents/agy.md`
- Routing detail and anti-patterns: [references/routing.md](references/routing.md)
- Wrapper: [scripts/agy-run.sh](scripts/agy-run.sh)
