# subagents

Small shell wrappers for running local coding subagents in non-interactive mode.

Included wrappers:

- `opencode-subagent`
- `antigravity-subagent`

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

## Notes

- These wrappers are intentionally thin. They only normalize prompt shape and runtime flags.
- They may need local path changes if your `opencode` or `agy` binaries live elsewhere.
