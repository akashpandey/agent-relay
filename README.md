# subagents

Small shell wrappers for running local coding subagents in non-interactive mode.

## Why these wrappers exist

The main purpose of these wrappers is to make subagent delegation easy from any harness that can run a shell command.

That includes:

- Claude Code
- Codex CLI
- OpenCode
- shell scripts
- local automation tools
- other agent runners

The underlying CLIs already work, but their raw command lines are noisy, backend-specific, and awkward to embed repeatedly in prompts or automation. These wrappers give you one stable entrypoint per subagent with the same basic shape:

- take a task as an argument or from stdin
- treat the current directory as the workspace root
- inject a small non-interactive system prompt
- pass through a few useful runtime knobs via environment variables
- add enough observability to tell whether the run is alive or stuck
- tee every run's combined output to a timestamped log file under
  `~/local-subagents/logs/` (path override: `SUBAGENT_LOG_DIR`), printed in the
  startup banner, so a backgrounded run can be tailed live instead of waiting
  for the final result

That makes them useful as lightweight building blocks inside terminal workflows, shell scripts, and agent harnesses where one model needs to hand off a task to another model through a plain command invocation.

Included wrappers:

- `opencode-subagent`
- `opencode-subagent-fallback`
- `antigravity-subagent`
- `claude-subagent`
- `codex-subagent`

## What they are good for

These wrappers are useful when you want a harness to delegate a bounded task to a subagent without opening an interactive UI.

Common cases:

- a Codex or Claude Code session delegating work to another model
- quick implementation tasks from the terminal
- code review or second-opinion passes on a repo
- one-shot debugging prompts
- delegated work from another agent
- scripted handoffs from tools like `xargs`, shell loops, or CI-adjacent automation
- comparing two model backends on the same task prompt

They are best for short, self-contained tasks where stdout is enough as the return channel.

They are not a full orchestration layer. They do not manage retries, queueing, result parsing, session recovery, or multi-step workflows across runs.

## Harness-friendly design

These wrappers are intentionally command-shaped so another coding agent can call them without knowing the underlying provider CLI.

The harness only needs to know:

- command name
- working directory
- task text
- optional environment variables

Everything else stays inside the wrapper:

- workspace wiring
- prompt framing
- provider-specific flags
- timeout handling
- basic observability

That gives you a stable delegation surface even if the underlying CLI syntax changes later.

## Requirements

These wrappers assume the backing CLIs are already installed on the host:

- `opencode-subagent` calls `$HOME/.opencode/bin/opencode`
- `antigravity-subagent` calls `$HOME/.local/bin/agy`
- `claude-subagent` calls `$HOME/.local/bin/claude`
- `codex-subagent` calls `codex`

They are meant for a machine where those tools already exist. The wrappers do not install or manage them.

## Harness skill

Install the shared delegation skill for Codex and Claude Code with:

```bash
./install-skill
```

This creates symlinks from `~/.codex/skills/local-subagents` and
`~/.claude/skills/local-subagents` to the tracked source at
`skills/local-subagents/`. Update that source here; do not edit the installed
links. OpenCode already permits Claude-style skills on this host. Antigravity's
plugin system can import Claude skills when needed, but has no global skill
directory configured yet.

## Usage

```bash
./opencode-subagent "Fix the bug"
printf '%s\n' "Review this repo" | ./opencode-subagent
./opencode-subagent --models

./antigravity-subagent "Implement TASK.md"
printf '%s\n' "Review this repo" | ./antigravity-subagent
./antigravity-subagent --models

./claude-subagent "Review this repo"
printf '%s\n' "Review this repo" | ./claude-subagent
./claude-subagent --models

./codex-subagent "Review this repo"
printf '%s\n' "Review this repo" | ./codex-subagent
./codex-subagent --models
./subagent-doctor
```

Both wrappers use the current working directory as the workspace root and inject a short non-interactive system prompt around the task.

Run `./subagent-doctor` to check Docker, the dashboard container, the compose symlink, and the post-commit restart hook.

## Session reuse

Fresh runs persist their provider session. For a sequential follow-up, pass the
prior provider session/conversation ID through `SUBAGENT_SESSION`:

```bash
SUBAGENT_SESSION='<provider-session-id>' \
  ./codex-subagent "Implement the fix you proposed."
```

The wrappers map this to each CLI's native resume option. Do not reuse one
session across parallel workers or unrelated tasks; context and file intent
will mix. Copy the provider ID from its run output or session list; every
wrapper also keeps the full run log under `SUBAGENT_LOG_DIR`.

The compact result from `subagent-wait` and `/api/runs/<log>/result` includes a
`continuation` object when a session ID is available. Use
`continuation.sameSessionCommand` when the same subagent should fix its own
issue or continue a closely related task. Use a fresh session for unrelated work
or parallel workers.

## Model catalogues

These are the model IDs available on this host when checked on 2026-08-02.
Refresh or re-list them before relying on the list for automation:

```bash
opencode-subagent --models --refresh
antigravity-subagent --models
```

### OpenCode

`opencode-subagent --models` intentionally exposes only these providers:

```text
opencode-go/deepseek-v4-flash
opencode-go/deepseek-v4-pro
opencode-go/glm-5.1
opencode-go/glm-5.2
opencode-go/gpt-5.6-luna
opencode-go/grok-4.5
opencode-go/hy3
opencode-go/kimi-k2.6
opencode-go/kimi-k2.7-code
opencode-go/kimi-k3
opencode-go/mimo-v2.5
opencode-go/mimo-v2.5-pro
opencode-go/minimax-m2.7
opencode-go/minimax-m3
opencode-go/qwen3.6-plus
opencode-go/qwen3.7-max
opencode-go/qwen3.7-plus
openai/gpt-5.3-codex-spark
openai/gpt-5.4
openai/gpt-5.4-fast
openai/gpt-5.4-mini
openai/gpt-5.4-mini-fast
openai/gpt-5.5
openai/gpt-5.5-fast
openai/gpt-5.6
openai/gpt-5.6-fast
openai/gpt-5.6-luna
openai/gpt-5.6-luna-fast
openai/gpt-5.6-luna-pro
openai/gpt-5.6-pro
openai/gpt-5.6-sol
openai/gpt-5.6-sol-fast
openai/gpt-5.6-sol-pro
openai/gpt-5.6-terra
openai/gpt-5.6-terra-fast
openai/gpt-5.6-terra-pro
zai-coding-plan/glm-4.7
zai-coding-plan/glm-5-turbo
zai-coding-plan/glm-5.2
zai-coding-plan/glm-5.2-highspeed
```

### Antigravity

`antigravity-subagent --models` lists the models used by the wrapper.

```text
gemini-3.7-flash-high
gemini-3.7-flash-medium
gemini-3.7-flash-low
gemini-3.6-flash-high
gemini-3.6-flash-medium
gemini-3.6-flash-low
gemini-3.5-flash-high
gemini-3.5-flash-medium
gemini-3.5-flash-low
gemini-3.1-pro-high
gemini-3.1-pro-low
claude-opus-4-6-thinking
gpt-oss-120b-medium
```

### Claude Code

Claude Code has no live model-catalogue command. `claude-subagent --models`
prints the selectors documented by the installed CLI:

```text
opus
sonnet
```

### Codex

Codex has no live model-catalogue command. `codex-subagent --models` prints
the selectors documented by the installed CLI:

```text
gpt-5.6-sol
gpt-5.6-terra
gpt-5.6-luna
```

## Typical scenarios

### 1. Delegate a narrow coding task

```bash
cd /path/to/repo
opencode-subagent "Update the failing test and explain the change"
```

Useful when you want a direct code-editing subagent pass on the current repo without opening an interactive session.

This is the main pattern for use from Claude Code or Codex CLI: the primary agent stays in control and delegates a narrow task through a wrapper command.

### 2. Ask for a second opinion

```bash
cd /path/to/repo
antigravity-subagent "Review the auth flow for obvious risks"
```

Useful when you want an alternate model or toolchain to critique a change, review architecture, or sanity-check an approach.

### 3. Fan out a list of tasks

```bash
printf '%s\n' \
  "Review the Docker setup" \
  "Check the auth middleware" \
  "Summarize the test gaps" \
| xargs -I{} opencode-subagent "{}"
```

Useful when another script or agent needs a simple command-shaped interface.

### 4. Compare backends on the same prompt

```bash
OPENCODE_MODEL='zai-coding-plan/glm-5.2' opencode-subagent "Review this diff"
AGY_MODEL='Gemini 3.6 Flash (Low)' antigravity-subagent "Review this diff"
CLAUDE_MODEL='sonnet' claude-subagent "Review this diff"
CODEX_MODEL='gpt-5.6-terra' codex-subagent "Review this diff"
```

Useful when you want to compare speed, quality, or failure modes across providers.

## opencode-subagent

Environment variables:

- `OPENCODE_MODEL` - model in `provider/model` format
- `OPENCODE_VARIANT` - optional model variant
- `OPENCODE_AGENT` - optional agent name
- `OPENCODE_TIMEOUT` - timeout in seconds, default `7200`
- `OPENCODE_LOGS` - set to `0` to suppress wrapper log banner
- `SUBAGENT_SESSION` - optional OpenCode session ID to resume
- `SUBAGENT_LOG_DIR` - directory for the run's tee'd log file, default `~/local-subagents/logs`

Every subagent final answer is asked to end with a JSON task outcome contract:

```json
{
  "outcome": "done|partial|blocked|failed",
  "summary": "...",
  "changedFiles": [],
  "verification": [
    { "command": "pnpm test", "status": "passed|failed|skipped", "reason": "" }
  ],
  "blockers": [],
  "incomplete": [],
  "nextSteps": []
}
```

The JSON object must be the final non-whitespace output.

`status=completed` only means the wrapper process finished. Automation should accept delegated work only when `outcome=done` and `attentionRequired=false` from `subagent-wait` or `/api/runs/<log>/result`.

Do not tail logs to determine task completeness. Logs are diagnostic output; `subagent-wait` and `/api/runs/<log>/result` are the machine-readable acceptance surfaces.
`subagent-wait` exits nonzero when any structured result has `accepted=false`.

Behavior:

- runs `opencode run --dir "$PWD" --auto`
- enables `--print-logs` by default
- prints a startup banner (including the run log path) so hung runs are easier to identify
- tees combined stdout+stderr to a timestamped file under `SUBAGENT_LOG_DIR`
  (default `~/local-subagents/logs/`) for diagnostics when a structured result
  reports a blocker or failure
- preserves the underlying command's real exit code even though output goes
  through `tee`

Best fit:

- coding tasks that benefit from `opencode`'s tool/runtime setup
- runs where session/log visibility matters
- cases where you want to see startup, stream, and loop progress

Model note: `opencode-go/glm-5.2` is token-heavy for the same work as
`zai-coding-plan/glm-5.2`, so the wrapper auto-reroutes any request for
`OPENCODE_MODEL=opencode-go/glm-5.2` to `zai-coding-plan/glm-5.2` and prints
a one-line notice to stderr when it does. Ask for `zai-coding-plan/glm-5.2`
directly to skip the redirect notice.

## opencode-subagent-fallback

Motivation: a model can hit its monthly quota or a rate limit mid-session with
no warning — `opencode-go/glm-5.2` did exactly this once, several minutes into
a real task, after already burning real work. The failure looked identical to
"the model is being slow," and the wasted turns weren't discovered until the
transcript was checked by hand. This wrapper probes before committing to the
real task, so quota exhaustion is caught in seconds, not minutes, and falls
over to the next model in a priority chain automatically.

Environment variables:

- `OPENCODE_MODEL_CHAIN` - required, comma-separated `provider/model` list in priority order
- `OPENCODE_PROBE_TIMEOUT` - seconds for the cheap probe call per candidate, default `30`
- `OPENCODE_TIMEOUT` - seconds for the real task once a model is selected, default `7200`
- `OPENCODE_VARIANT`, `OPENCODE_AGENT`, `OPENCODE_LOGS` - passed through to `opencode-subagent` for the real task

Behavior:

- for each model in the chain, sends a one-word probe prompt through `opencode-subagent` with a short timeout
- greps the probe output for known quota/rate-limit phrasing (`usage limit`, `quota`, `rate limit`, `429`, `insufficient_quota`, `AI_APICallError`)
- skips a candidate on a quota/rate-limit match or any other probe failure, logging why to stderr
- the first candidate that probes clean gets the real task, on the real `OPENCODE_TIMEOUT`
- prints which model was actually selected to stderr

Example:

```bash
OPENCODE_MODEL_CHAIN='opencode-go/glm-5.2,zai-coding-plan/glm-5.2,zai-coding-plan/glm-5-turbo' \
  opencode-subagent-fallback "Build the UI described in TASK.md"
```

Best fit:

- any dispatch where you'd otherwise hardcode one model and hope it's not exhausted
- long delegation sessions (like a multi-task implementation plan) where quota can run out partway through

## antigravity-subagent

Environment variables:

- `AGY_MODEL` - model label exactly as shown by `agy models`
- `AGY_PRINT_TIMEOUT` - print-mode timeout, default `120m`
- `AGY_LOG_FILE` - optional path passed to `agy --log-file` (agy's own internal log, separate from the wrapper's run log)
- `AGY_LOGS` - set to `0` to suppress wrapper log banner
- `SUBAGENT_SESSION` - optional Antigravity conversation ID to resume
- `SUBAGENT_LOG_DIR` - directory for the run's tee'd log file, default `~/local-subagents/logs`

Behavior:

- runs `agy --print`
- passes the current directory via `--add-dir`
- prints a startup banner (including the run log path) for basic observability
- `--print` is blocking/silent by design (no incremental stdout until the run
  finishes), so the wrapper's own tee'd log is the only way to watch a
  backgrounded antigravity run mid-flight — `agy`'s own `--log-file`, if set,
  captures a separate internal debug log
- tees combined stdout+stderr to a timestamped file under `SUBAGENT_LOG_DIR`
- preserves the underlying command's real exit code even though output goes
  through `tee`

Best fit:

- second-opinion reviews
- alternative-model passes on the same prompt
- simple one-shot tasks where a final printed response is enough

## claude-subagent

Environment variables:

- `CLAUDE_MODEL` - Claude Code model alias or full model ID
- `CLAUDE_FALLBACK_MODEL` - optional comma-separated fallback aliases or IDs
- `CLAUDE_EFFORT` - optional `low`, `medium`, `high`, `xhigh`, or `max` reasoning effort
- `CLAUDE_TIMEOUT` - timeout in seconds, default `7200`
- `CLAUDE_LOGS` - set to `0` to suppress the wrapper log banner
- `SUBAGENT_SESSION` - optional Claude Code session ID to resume
- `SUBAGENT_LOG_DIR` - directory for the run's tee'd log file, default `~/local-subagents/logs`

Behavior:

- runs `claude --print` with the workspace supplied through `--add-dir`
- uses non-persistent, non-interactive execution and passes model, fallback, and optional effort selection through
- tees combined stdout+stderr to a timestamped log file and preserves the real exit code

Claude Code has no live model-list command; `claude-subagent --models` prints
the selectors documented by the installed CLI instead.

## codex-subagent

Environment variables:

- `CODEX_MODEL` - optional Codex model selector
- `CODEX_EFFORT` - optional `low`, `medium`, `high`, `xhigh`, `max`, or `ultra` reasoning effort
- `CODEX_SANDBOX` - sandbox mode; defaults to `workspace-write`, with an automatic
  `danger-full-access` fallback only when the host blocks Bubblewrap user namespaces
- `SUBAGENT_SESSION` - optional Codex session ID to resume
- `CODEX_TIMEOUT` - timeout in seconds, default `7200`
- `CODEX_LOGS` - set to `0` to suppress the wrapper log banner
- `SUBAGENT_LOG_DIR` - directory for the run's tee'd log file, default `~/local-subagents/logs`

Behavior:

- runs `codex exec` in the current workspace with non-interactive approval handling
- persists new sessions and resumes `SUBAGENT_SESSION` when provided; passes model and reasoning effort through
- defaults to the `workspace-write` sandbox; on hosts that block Bubblewrap user namespaces,
  automatically falls back to `danger-full-access`; set `CODEX_SANDBOX` explicitly to prevent fallback
- tees combined stdout+stderr to a timestamped log file and preserves the real exit code

Codex has no live model-list command; `codex-subagent --models` prints the
selectors documented by the installed CLI instead.

## Observability

All wrappers tee their combined
stdout+stderr to a timestamped file under `~/local-subagents/logs/` (override with
`SUBAGENT_LOG_DIR`). The path is printed in the startup banner, so a run
launched in the background can be watched live:

```bash
OPENCODE_MODEL='openai/gpt-5.5' opencode-subagent "long task" &
tail -f ~/local-subagents/logs/<the-run-log-printed-above>.log
```

This exists because, unmodified, `opencode` streams tool/loop progress to
stderr while `agy --print` and `claude --print` may not print incrementally — a
backgrounded antigravity run looked identical whether it was working or
hung. Teeing to a discoverable log file fixes that for all wrappers, uniformly,
without depending on upstream CLI verbosity flags. `opencode-subagent-fallback`
inherits this for free since it shells out to `opencode-subagent` for both
its probe and real task calls.

The `logs/` directory is gitignored and not rotated — clean it out
periodically if it grows (`rm -rf ~/local-subagents/logs/*`).

## Process Cleanup

A subagent can leave things running after it exits — a `npm run dev &`
it forgot to stop, a background server started to "test" something. All
wrapper types clean this up automatically:

1. When a user systemd manager is available, the CLI runs in a transient
   service with `KillMode=control-group` and `RuntimeMaxSec`. Stopping that
   unit kills every descendant, including a daemonized process that changes
   directory. The wrapper also stops it on `EXIT`, `INT`, `TERM`, or `HUP`.
2. Without a user systemd manager, the wrapper falls back to `setsid`,
   process-group termination, and its workspace-based `/proc` scan. That
   fallback can miss a process that both daemonizes and changes directory.

The systemd path bounds even an orphaned wrapper by its runtime limit. The
fallback remains useful on hosts without systemd user services.

## Notes

- These wrappers are intentionally thin. They only normalize prompt shape and runtime flags.
- They may need local path changes if your `opencode`, `agy`, or `claude` binaries live elsewhere.
- They assume the current working directory is the repo or workspace you want the subagent to operate on.
