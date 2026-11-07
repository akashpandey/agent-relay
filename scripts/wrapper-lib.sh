# Shared runtime skeleton for the *-agent wrapper shells (codex, claude,
# opencode, antigravity). Sourced by each wrapper; the wrapper calls
# run_agent_runtime as its last step (it ends in `exit "$status"`). Call it with
# `run_agent_runtime "$@"` — the provider arguments live in the runtime
# function's positional parameters ("$@" is function-scoped in POSIX sh).
#
# Contract — the wrapper defines before calling run_agent_runtime:
#   provider_name       codex | claude | opencode | antigravity
#   runner_bin          resolved provider binary
#   timeout_seconds     nonzero -> wraps with `timeout` when systemd is off
#   done_model          resolved model id (already alias-expanded)
#   completion_marker   first completion grep for the watchdog. Empty lets the
#                       shared outcome sweep decide alone.
#   provider_prompt_rules   optional extra bullet injected into the prompt Rules
#                       section (antigravity uses: "Do not put deliverables in
#                       Antigravity scratch.").
#   timeout_spec        duration string for `timeout` and RuntimeMaxSec, e.g.
#                       "7200s" or "120m". Empty disables both. Wrappers compute
#                       it from their own timeout variable (format differs:
#                       plain seconds vs suffixed duration).
# Optional overrides:
#   provider_outcome_re   outcome regex over the post-Task section; the default
#                         matches the shared outcome contract.
#   provider_extract_session()  sets sess_id from $log_file; the default is the
#                         JSON/session-id double grep used by codex and claude.
# The wrapper keeps: usage/--models/--help, arg building (`set --`), the stderr
# banner including run_log=$log_file, log file creation, canonical workspace
# resolution, and finalize-run.sh sourcing (traps + write_done).

# Prevent hanging network commands from blocking subprocess cleanup
export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-5}"
export CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-10}"
export CI="${CI:-1}"
export npm_config_yes="${npm_config_yes:-true}"
export npm_config_fund="${npm_config_fund:-false}"
export npm_config_audit="${npm_config_audit:-false}"
export DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"
export GIT_TERMINAL_PROMPT="${GIT_TERMINAL_PROMPT:-0}"
export PAGER="${PAGER:-cat}"
export GIT_PAGER="${GIT_PAGER:-cat}"
export SYSTEMD_PAGER="${SYSTEMD_PAGER:-cat}"

# Non-interactive prompt scaffold shared by every provider. First arg is the
# workspace, second the user task; the JSON outcome contract follows Task:.
agent_prompt() {
  cat <<EOF
You are running as a non-interactive coding agent.
Workspace: $1

Rules:
- Treat the workspace above as the project root.
- Write requested files under that workspace unless the prompt gives a different absolute path.
- Run all commands in non-interactive batch mode (e.g. use 'npx -y', avoid interactive stdin/prompts).
${provider_prompt_rules:+- $provider_prompt_rules}
- After editing, summarize changed files and verification commands.
- Use outcome=done only when the requested task is complete and verification passed or was explicitly unnecessary.
- CRITICAL: Your absolute last turn MUST end with this exact JSON structure (no text or markdown after it):
\`\`\`json
{
  \"outcome\": \"done\",
  \"summary\": \"Brief explanation of what was done.\",
  \"changedFiles\": [\"path/to/file\"],
  \"verification\": [
    {
      \"command\": \"npm test\",
      \"status\": \"passed\",
      \"reason\": \"All tests passed\"
    }
  ],
  \"blockers\": [],
  \"incomplete\": [],
  \"nextSteps\": []
}
\`\`\`
outcome must be: done | partial | blocked | failed.
verification status must be: passed | failed | skipped.

Task:
$2
EOF
}

default_provider_outcome_re='(\\"|")outcome(\\"|"):[[:space:]]*(\\"|")(done|partial|blocked|failed)'

default_provider_extract_session() {
  sess_id="$(grep -oE '"session_id":"[^"]+"' "$log_file" 2>/dev/null | head -n 1 | cut -d'"' -f4 || grep -iE '^session id:' "$log_file" 2>/dev/null | head -n 1 | awk '{print $3}' || echo "${resume_session:-new}")"
  if [ -z "$sess_id" ]; then
    sess_id="$(grep -iE '^session id:' "$log_file" 2>/dev/null | head -n 1 | awk '{print $3}' || echo "${resume_session:-new}")"
  fi
}

# Runs the provider binary (args already in "$@" via set --), tails the log,
# reaps lingering event-loop handles, cleans up orphans, writes the .done
# sentinel, registers completion, and exits with the run status.
run_agent_runtime() {
# ponytail: a separate process group makes timeout cleanup cover ordinary children.
  before_pids="$(ls /proc 2>/dev/null | tr '\n' ' ')"
  printf 'agent: provider=%s workspace=%s model=%s session=%s\nagent-unit: %s\nTask:\n%s\n\n---\n\n' \
    "$provider_name" "$workspace" "$done_model" "${resume_session:-new}" "$done_unit" "$user_prompt" > "$log_file"

  # Register run start in SQLite database immediately
  mark_output_start
  if command -v node >/dev/null 2>&1; then
    node "$repo_dir/scripts/subagent-tracker.js" start "$(basename "$log_file")" "$$" "$provider_name" "$done_model" "$workspace" "${resume_session:-new}" "$user_prompt" >/dev/null 2>&1 || true
  fi

  if [ "$use_systemd" -eq 1 ]; then
    systemd_props="--property=KillMode=control-group"
    [ -n "$timeout_spec" ] && systemd_props="$systemd_props --property=RuntimeMaxSec=$timeout_spec"
    # shellcheck disable=SC2086  # specs and paths contain no whitespace
    systemd-run --user --pipe --working-directory="$workspace" --setenv=PATH="$PATH" --wait --collect --quiet --unit="$unit" $systemd_props "$runner_bin" "$@" >>"$log_file" 2>&1 &
  elif [ -n "$timeout_spec" ] && command -v timeout >/dev/null 2>&1; then
    setsid timeout --foreground "$timeout_spec" "$runner_bin" "$@" >>"$log_file" 2>&1 &
  else
    setsid "$runner_bin" "$@" >>"$log_file" 2>&1 &
  fi
  cmd_pid=$!
  tail -f "$log_file" &
  tail_pid=$!

  # Background watchdog: reap hanging runtime if task completed but lingering
  # event-loop handles prevent exit. Fires on the provider marker or an outcome
  # line; antigravity overrides provider_outcome_re because its JSON shape
  # differs (outcome and changedFiles on one line).
  (
    while kill -0 "$cmd_pid" 2>/dev/null; do
      sleep 2
      if { [ -n "$completion_marker" ] && grep -qE "$completion_marker" "$log_file" 2>/dev/null; } || \
         awk '/^---$/{f=1; next} f' "$log_file" 2>/dev/null | grep -qE "${provider_outcome_re:-$default_provider_outcome_re}"; then
        grace=6
        while [ "$grace" -gt 0 ] && kill -0 "$cmd_pid" 2>/dev/null; do
          sleep 1
          grace=$((grace - 1))
        done
        if kill -0 "$cmd_pid" 2>/dev/null; then
          touch "${log_file}.reaped"
          if [ "$use_systemd" -eq 1 ]; then
            systemctl --user stop "$unit" >/dev/null 2>&1 || true
          elif command -v pkill >/dev/null 2>&1; then
            pkill -TERM -g "$cmd_pid" >/dev/null 2>&1 || true
            sleep 1
            pkill -KILL -g "$cmd_pid" >/dev/null 2>&1 || true
          fi
        fi
        break
      fi
    done
  ) &
  watchdog_pid=$!

  # ponytail: `wait` returns the waited-on process status even under set -e;
  # captured deliberately so errexit never loses the real exit code.
  set +e
  wait "$cmd_pid"
  status=$?
  set -e

  kill "$watchdog_pid" >/dev/null 2>&1 || true
  wait "$watchdog_pid" 2>/dev/null || true
  kill "$tail_pid" >/dev/null 2>&1 || true
  wait "$tail_pid" 2>/dev/null || true

  if [ -f "${log_file}.reaped" ]; then
    rm -f "${log_file}.reaped"
    if [ "$status" -ne 0 ]; then
      if [ "$log_flag" = "1" ]; then
        echo "$provider_name-agent: process reaped after task completion (lingering event-loop handles)" >&2
      fi
      status=0
    fi
  fi
  if [ "$use_systemd" -eq 1 ]; then
    systemctl --user stop "$unit" >/dev/null 2>&1 || true
  elif command -v pkill >/dev/null 2>&1; then
    pkill -TERM -g "$cmd_pid" >/dev/null 2>&1 || true
    sleep 1
    pkill -KILL -g "$cmd_pid" >/dev/null 2>&1 || true
  fi

  # Clean up orphaned processes in the workspace (only in non-systemd fallback mode)
  if [ "$use_systemd" -eq 0 ]; then
    workspace_real="$(cd "$workspace" && pwd -P)"
    after_pids="$(ls /proc 2>/dev/null | tr '\n' ' ')"
    new_pids=""
    for pid in $after_pids; do
      case " $before_pids " in
        *" $pid "*) ;;
        *) new_pids="$new_pids $pid" ;;
      esac
    done

    for sig in TERM KILL; do
      if [ "$sig" = "KILL" ]; then
        sleep 1
      fi
      for pid in $new_pids; do
        [ "$pid" = "$$" ] && continue
        pid_cmd="$([ -f "/proc/$pid/cmdline" ] && cat "/proc/$pid/cmdline" 2>/dev/null | tr '\0' ' ' || true)"
        case "$pid_cmd" in
          *-subagent*|*systemd-run*|*claude*|*codex*|*opencode*|*antigravity*|*agy*)
            continue
            ;;
        esac
        pid_cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
        if [ -z "$pid_cwd" ]; then
          continue
        fi
        case "$pid_cwd" in
          "$workspace_real"|"$workspace_real"/*)
            kill "-$sig" "$pid" >/dev/null 2>&1 || true
            ;;
        esac
      done
    done
  fi

  # Write completion sentinel file (.done)
  done_file="${log_file%.log}.done"
  sess_id=""
  if command -v provider_extract_session >/dev/null 2>&1; then
    provider_extract_session
  else
    default_provider_extract_session
  fi
  write_done "$status"

  # Automatically ingest subagent session to claude-mem (non-blocking)
  if [ -f "$done_file" ] && command -v bun >/dev/null 2>&1; then
    bun "$repo_dir/scripts/ingest-to-claude-mem.js" "$done_file" >/dev/null 2>&1 &
  fi

  # Register run completion in SQLite database
  if command -v node >/dev/null 2>&1; then
    node "$repo_dir/scripts/subagent-tracker.js" complete "$(basename "$log_file")" "$status" "$sess_id" >/dev/null 2>&1 || true
  fi

  if [ "$log_flag" = "1" ]; then
    echo "$provider_name-agent: finished status=$status ($([ "$status" -eq 0 ] && echo "completed" || echo "failed")) session=$sess_id" >&2
  fi

  exit "$status"
}
