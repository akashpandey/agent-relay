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

That makes them useful as lightweight building blocks inside terminal workflows, shell scripts, and agent harnesses where one model needs to hand off a task to another model through a plain command invocation.

Included wrappers:

- `opencode-subagent`
- `antigravity-subagent`

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

They are meant for a machine where those tools already exist. The wrappers do not install or manage them.

## Usage

```bash
./opencode-subagent "Fix the bug"
printf '%s\n' "Review this repo" | ./opencode-subagent

./antigravity-subagent "Implement TASK.md"
printf '%s\n' "Review this repo" | ./antigravity-subagent
```

Both wrappers use the current working directory as the workspace root and inject a short non-interactive system prompt around the task.

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
AGY_MODEL='Gemini 3.5 Flash (Low)' antigravity-subagent "Review this diff"
```

Useful when you want to compare speed, quality, or failure modes across providers.

## opencode-subagent

Environment variables:

- `OPENCODE_MODEL` - model in `provider/model` format
- `OPENCODE_VARIANT` - optional model variant
- `OPENCODE_AGENT` - optional agent name
- `OPENCODE_TIMEOUT` - timeout in seconds, default `1800`
- `OPENCODE_LOGS` - set to `0` to suppress wrapper log banner

Behavior:

- runs `opencode run --dir "$PWD" --auto`
- enables `--print-logs` by default
- prints a startup banner so hung runs are easier to identify

Best fit:

- coding tasks that benefit from `opencode`'s tool/runtime setup
- runs where session/log visibility matters
- cases where you want to see startup, stream, and loop progress

## antigravity-subagent

Environment variables:

- `AGY_MODEL` - model label exactly as shown by `agy models`
- `AGY_PRINT_TIMEOUT` - print-mode timeout, default `20m`
- `AGY_LOG_FILE` - optional `agy` log file path
- `AGY_LOGS` - set to `0` to suppress wrapper log banner

Behavior:

- runs `agy --print`
- passes the current directory via `--add-dir`
- prints a startup banner for basic observability

Best fit:

- second-opinion reviews
- alternative-model passes on the same prompt
- simple one-shot tasks where a final printed response is enough

## Notes

- These wrappers are intentionally thin. They only normalize prompt shape and runtime flags.
- They may need local path changes if your `opencode` or `agy` binaries live elsewhere.
- They assume the current working directory is the repo or workspace you want the subagent to operate on.
