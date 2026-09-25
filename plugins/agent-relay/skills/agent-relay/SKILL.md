---
name: agent-relay
description: Delegate coding, investigation, review, or parallel implementation tasks to local CLI agents (OpenCode, Antigravity, Claude Code, Codex). Supports cross-harness relay takeover, model fallback chains, and dashboard tracking.
---

# Agent Relay

Delegate tasks across four providers: OpenCode, Antigravity, Claude Code, and Codex. Five wrappers include OpenCode's optional fallback runner. Runs execute non-interactively in the target workspace and save logs and structured results for the local dashboard at `http://localhost:4242`.

## Installation and plugins

Requires the host agent-relay installation, Node.js 24+ (recommended), and at least one authenticated provider CLI. Run `relay --help` to check installation. Native plugins are available for Claude Code, Codex, Antigravity CLI, and OpenCode; see `docs/PLUGINS.md` in the host checkout. Plugins connect to the installed host MCP server; they do not install providers or start the dashboard.

`relay dashboard` checks HTTP availability. Start the server separately using Docker or `HOST=127.0.0.1 agent-dashboard`, following `docs/GETTING_STARTED.md`. `relay doctor` checks a specific Docker/hook setup; missing optional hooks do not invalidate a working Node dashboard. Logs and data default to the installed checkout's `logs/` and `data/subagents.db`; apply overrides consistently across wrappers, MCP, and dashboard.

Discover MCP tool identifiers from the harness. Antigravity uses the plugin-prefixed server `agent-relay_agent-relay`, although its interactive menu displays `agent-relay`. Avoid duplicate manual and plugin MCP registrations. Verify actual tool results: model summaries and successful harness exits can misreport counts or hide failed tool calls.

## Available Harnesses & Invocation

Prefer the unified `relay` (or `agent`) front door when using canonical workspace names, finding recent sessions, continuing prior work, or passing the baton between harnesses:

```sh
relay workspaces
relay doctor
relay dashboard
relay my-app opencode "Task prompt..."
relay codex "Task prompt in the current directory..."
relay route my-app ui "Update the settings layout"
relay attention my-app
relay prune --dry-run --older-than 30d
relay result my-app
relay open my-app
relay last my-app
relay continue my-app "Follow-up prompt..."
relay continue my-app --to opencode "Continue using another provider..."
relay takeover my-app codex "Take over where previous harness left off..."
```

Run provider wrappers directly from the target repository/workspace directory when you need full wrapper-specific flags:

```sh
cd /path/to/workspace

# OpenCode (GLM / multi-provider) — supports OPENCODE_MODEL='openai/latest', 'glm/latest', etc.
OPENCODE_MODEL='glm/latest' opencode-agent "Task prompt..."

# OpenCode with Automatic Model Fallback Chain (Quota/Rate-Limit Failover)
OPENCODE_MODEL_CHAIN='zai-coding-plan/glm-5.3,openai/gpt-5.4-mini' opencode-agent-fallback "Task prompt..."

# Antigravity (Gemini / AGY) — supports AGY_MODEL='gemini-flash', 'gemini-pro', etc.
AGY_MODEL='gemini-flash' antigravity-agent "Task prompt..."

# Claude Code (Sonnet / Opus / Haiku)
CLAUDE_MODEL='opus' claude-agent "Task prompt..."

# OpenAI Codex (GPT-5.6 family) — supports CODEX_MODEL='latest', 'terra', etc.
CODEX_MODEL='latest' codex-agent "Task prompt..."
```

Multi-line prompts can be piped via stdin:
```sh
printf '%s\n' "$DETAILED_TASK" | opencode-agent
```

### Dynamic Model Family Aliases
All wrappers dynamically resolve to the latest available model version for a given family:
- **Antigravity**: `AGY_MODEL='gemini-flash'` (resolves latest Gemini Flash High), `AGY_MODEL='gemini-pro'` (resolves latest Gemini Pro High).
- **OpenCode**: `OPENCODE_MODEL='openai/latest'` or `'openai/sol'`, `OPENCODE_MODEL='glm/latest'` (resolves latest Z.AI GLM), `OPENCODE_MODEL='opencode-go/qwen-latest'`.
- **Codex**: `CODEX_MODEL='latest'` (resolves latest GPT Sol).
- **Claude Code**: `CLAUDE_MODEL='opus'`, `CLAUDE_MODEL='sonnet'`.

## Session Reuse & Continuation (Save Context)

Avoid spawning a fresh session when a task is a continuation or follow-up. Reusing sessions preserves the conversation context, loaded files, and reasoning history:

Use the same provider session when the previous agent created an issue, returned `partial`/`blocked`, or the follow-up depends on files, reasoning, or decisions from that run. Prefer a fresh session for unrelated tasks, parallel workers, or when prior context could bias the answer.

### 1. Continue the Most Recent Session in Workspace
Use the `--continue` (or `-c`) flag:
```sh
# OpenCode
opencode-agent --continue "Fix the type error reported in the last step"

# Antigravity
antigravity-agent --continue "Run tests on the modified component"

# Claude Code
claude-agent --continue "Proceed with step 2"

# OpenAI Codex
codex-agent --continue "Add edge case unit tests"
```

### 2. Resume a Specific Session ID
Pass `--resume <session-id>` or `AGENT_RELAY_SESSION`:
```sh
opencode-agent --resume "session-abc-123" "Next step prompt..."
# or
AGENT_RELAY_SESSION="session-abc-123" antigravity-agent "Next step prompt..."
```
Successful session capture records a provider `sessionId` in `logs/<log>.done`. If no resumable ID was captured, use a fresh session instead of assuming continuation is available.

> [!TIP]
> **Always use wrappers for continuation, not raw CLIs:** Always execute continuation through the wrapper binaries (`*-agent --continue` or `--resume <id>`) rather than raw provider CLIs (`claude -c`, `opencode attach`, etc.). Raw CLIs default to interactive REPL mode on resume, which stalls headless automation. Subagent wrappers enforce non-interactive batch flags and run an automatic completion watchdog that reaps lingering event-loop handles or background MCP connections after task completion, ensuring prompt exit and accurate `.done` recording.

### 3. Cross-Harness Relay Takeover (Token / Quota Exhaustion Handoff)

When an interactive session (in Claude Code, Codex, Antigravity, or OpenCode) or a agent run runs out of tokens, hits rate limits, or context window limits, transfer the baton to another harness without starting from scratch:

```sh
# Take over in the current workspace with Codex
relay takeover codex

# Take over a specific workspace with OpenCode
relay takeover my-app opencode

# Take over with an explicit goal/instruction
relay takeover my-app claude "Complete the remaining tests and verify build"

# Continue a previous agent run while switching providers
relay continue my-app --to codex "Finish the implementation"
```

The handoff engine inspects:
- The last recorded session across all 4 harnesses (from Codex SQLite `~/.codex/state_5.sqlite`, OpenCode SQLite `~/.local/share/opencode/opencode.db`, Claude Code `~/.claude/projects/`, and Antigravity transcript logs).
- Initial prompt and task goal.
- Touched files in flight.
- Last assistant message / reasoning and detected exhaustion errors (e.g. rate limit reached).
- Uncommitted git changes via `git status -s` and `git diff --stat`.

It packages a comprehensive baton-pass prompt and launches the target harness directly.

---

## Recommended Orchestration: Wait for Structured Results

Prefer one blocking wait over repeatedly requesting status. The CLI and MCP server handle their own waiting; do not assume every wait is implemented without polling.

Completeness rule: Never tail or manually read run logs to decide whether delegated work is complete. Use `agent-wait <log-filename>` or `GET /api/runs/<log-filename>/result`. Logs are for debugging only after the structured result says `attentionRequired=true` or the result API is unavailable.
With the unified CLI, prefer `agent result --last`, `agent result <workspace>`, or `agent result <log-filename>` for this structured result lookup.

### Pattern A: Harness completion notification
When your harness supports background-process completion notifications:
1. Launch the command directly (or as a background task):
   ```sh
   opencode-agent "Implement auth token refresh"
   ```
2. Wait for the harness's completion notification, then retrieve the structured result. Notification support and timing depend on the harness; agent-relay does not guarantee automatic wake-up in every runtime. Without notifications, use `wait_for_run` or `agent-wait`.

### Pattern B: Wait for specific CLI runs
When orchestrating multi-agent parallel pipelines:
```sh
# Launch multiple agents in parallel
opencode-agent --workspace /path/to/worktree-a "Refactor service A" &
antigravity-agent --workspace /path/to/worktree-b "Refactor service B" &

# Use both filenames printed in the startup banners
agent-wait "<first-run-log>" "<second-run-log>"
```
`--last` selects only the latest log; it does not wait for all parallel runs. The CLI waits using `tail --pid` with a polling fallback, then returns each structured result. MCP `wait_for_run` checks status internally every 500 ms until completion or its wait limit.

### Pattern C: Structured API Result Retrieval
Once notified of completion:
```sh
agent-wait <log-filename>
```

`agent-wait` returns the caller contract as JSON and exits nonzero when any result has `accepted=false`. Treat `processStatus=completed` as wrapper success only. Treat the delegated task as accepted only when `accepted=true`. Always surface `blockers`, `incomplete`, and failed/skipped `verification` to the user instead of hiding them in a summary.

Caller contract:
```json
{
  "processStatus": "running|completed|failed|empty",
  "outcome": "done|partial|blocked|failed|unknown",
  "attentionRequired": true,
  "accepted": false,
  "blockers": [],
  "incomplete": [],
  "verification": [
    { "command": "pnpm test", "status": "passed|failed|skipped", "reason": "" }
  ],
  "changedFiles": [],
  "nextSteps": [],
  "summary": "",
  "logFile": "",
  "sessionId": "",
  "continuation": {
    "sessionId": "",
    "sameSessionCommand": "opencode-agent --resume <session> \"<follow-up task>\"",
    "continueLastCommand": "opencode-agent --continue \"<follow-up task>\"",
    "agentContinueCommand": "relay continue my-app \"<follow-up task>\"",
    "relayCommands": {
      "codex": "relay takeover my-app codex",
      "claude": "relay takeover my-app claude",
      "opencode": "relay takeover my-app opencode",
      "antigravity": "relay takeover my-app antigravity"
    },
    "env": { "AGENT_RELAY_SESSION": "" }
  }
}
```

If `accepted=false` or `outcome` is `partial`, `blocked`, `failed`, or `unknown`, do not mark the parent task complete. Continue with a follow-up agent prompt, fix the issue directly, or report the blocker to the user. `outcome=unknown` means the process exited without writing a valid structured `.done` sentinel — the task completion could not be verified and attention is required.

If the original agent caused a defect and the compact result includes `continuation`, prefer `continuation.sameSessionCommand` so the same agent can repair its own work with full context. Include the exact issue, failing check, and acceptance condition in the follow-up prompt.

The dashboard run modal exposes copy-only `Continue` and `Run Again` actions. Prefer the copied `agent continue <workspace> "<follow-up task>"` form when a run is partial, blocked, failed, or needs a same-context repair. The browser does not execute commands directly.

Use `agent attention [workspace]`, the dashboard `Needs Attention` filter, or `/api/runs?attention=1` to find failed, blocked, partial, unknown, or attention-required runs before declaring delegated work complete.

Use `agent prune` only for log/dashboard cleanup. It is dry-run by default; require `--confirm` before it deletes `.log`/`.done` files and DB rows. Never prune running runs.

For direct dashboard access, use `GET /api/runs/<log-filename>/result` for the compact result contract or `GET /api/runs/<log-filename>` for full metadata. The dashboard history has an Outcome filter for `done`, `partial`, `blocked`, and `unknown` task results.

Dashboard note: Live Terminal is optimized for large logs. It initially shows the latest log tail and keeps a bounded rendered window while continuing to stream new output; use `Load Older`, full-log search, the log download, or `/api/logs/<log-filename>` when more history or the exact full raw log is required. Rebuild the derived SQLite cache with `npm --prefix dashboard run rebuild` if it gets stale.

Do not use `/api/logs/<log-filename>`, `tail`, or the Live Terminal as the normal completion check. They are diagnostic surfaces, not the task result contract.

### MCP Tool Surface

When the host supports MCP, prefer the local `agent-relay-mcp` server over ad-hoc shell parsing. It exposes structured tools: `run_agent`, `list_workspaces`, `list_runs`, `get_session_history`, `get_run_result`, `wait_for_run`, `get_log_tail`, `search_log`, `continue_run`, `takeover_run`, `doctor`, `list_models`, and `kill_run`.

- Use `run_agent` to delegate tasks directly without shell syntax (`provider`, `route`, `prompt`, `workspace`, `model`, `effort`, `sessionId`, `continueLatest`, `sandbox`, `fallbackChain`, `wait`). When a workspace has routing rules, pass a named `route` and omit `provider`, or omit both to match keywords and the configured default. An explicit `provider` bypasses routing.
- Use `list_runs` with keyword search `q` and date filters `since` / `until` (e.g. `since: "2026-09-16"`) to find past tasks across any provider or workspace.
- Use `get_session_history` to inspect the full conversational context, original goals, touched files, tokens, and assistant reasoning from past sessions.
- Use `takeover_run` with `execute: false` (default) to synthesize a complete cross-harness baton handoff prompt (original goal, touched files in flight, uncommitted git diffs, previous reasoning), or `execute: true` to immediately run the takeover on another harness.
- Use `list_models` to inspect available model selectors and family aliases for each provider.
- Use `kill_run` to safely terminate an agent process tree.
- Use `get_run_result` / `wait_for_run` for acceptance contracts. Use `get_log_tail` / `search_log` only for diagnostics.

---

## Model Selection

Inspect available models for each harness:
```sh
opencode-agent --models --refresh
antigravity-agent --models
claude-agent --models
codex-agent --models
agent-doctor
```

Use `agent-doctor` when agent-relay behavior looks stale, Docker restart automation seems broken, or the dashboard/API is unreachable.

Specify a non-default model via environment variables:
- `OPENCODE_MODEL='zai-coding-plan/glm-5.3' opencode-agent "..."`
- `AGY_MODEL='Gemini 3.7 Flash (High)' antigravity-agent "..."`
- `CLAUDE_MODEL='opus' claude-agent "..."`
- `CODEX_MODEL='gpt-5.5' codex-agent "..."`

### Automatic Model Failover Chains (opencode-agent-fallback)
To prevent jobs from failing when a model hits monthly quota exhaustion or rate limits, define an `OPENCODE_MODEL_CHAIN`:
```sh
OPENCODE_MODEL_CHAIN='zai-coding-plan/glm-5.3,openai/gpt-5.4-mini,opencode-go/qwen3.7-plus' \
  opencode-agent-fallback "Implement feature X..."
```
*Sends a cheap pre-flight probe to verify provider quota before committing the full task prompt.*

---

## Emergency Process Control

If an agent is runaway, stuck, or orphaned:
```sh
# Kill through the dashboard UI or POST these local API endpoints:
http://localhost:4242/api/runs/<log-filename>/kill
http://localhost:4242/api/dangling/kill-all
```

The dashboard's **Dangling** chip shows processes whose cmdline matches an agent wrapper but are not tracked as active runs. Detection correctly excludes child/grandchild processes spawned by active agents and wrapper parent processes, so only genuinely orphaned processes appear. Use `kill-all` only when you are confident the listed PIDs are not part of an active run.

---

## Rules & Best Practices

1. **Always anchor to target workspace**: Use `cd /path/to/target/repo` or an explicit workspace. Provider session visibility and process isolation depend on the provider and host; wrappers are not a security sandbox.
2. **Reuse sessions for multi-step tasks**: Use `--continue` (or `-c`) / `--resume <id>` for follow-up prompts to save context, cache, and token budget.
3. **Prefer blocking waits**: Use supported harness notifications, MCP `wait_for_run`, or `agent-wait` with explicit run filenames instead of repeated status tool calls.
4. **Keep tasks bounded**: One bug trace, one refactor, one test implementation, or one code review per turn.
5. **Parallel execution safety**: When running multiple write-capable agents simultaneously, execute them in separate `git worktree` directories to prevent file write collisions.
6. **Verify deliverables**: Inspect the generated git diff or test results locally after a agent reports completion before accepting changes.
7. **Never trust process status alone**: `status` / `processStatus` says whether the wrapper exited. `accepted` says whether the task result is safe to accept.
8. **Never tail logs for acceptance**: Call `agent-wait` or `/api/runs/<log>/result`; only inspect logs when debugging a failed, blocked, partial, or unknown outcome.
9. **Reuse sessions deliberately**: Use `continuation.sameSessionCommand` for fixes to the same task or closely related follow-ups. Do not reuse one session across unrelated tasks or parallel workers. Always invoke continuation through agent wrappers rather than raw CLIs to benefit from non-interactive enforcement and lingering process reaping.
10. **Use relay takeover on quota or token exhaustion**: When a harness or agent hits rate limits or token exhaustion midway through a task, use `relay takeover <provider>` or `relay continue --to <provider>` to transfer the goal, touched files, and uncommitted git state to another model without starting over.
