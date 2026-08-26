---
name: local-subagents
description: Delegate a bounded coding, investigation, review, or parallel implementation task to local CLI subagents (OpenCode, Antigravity, Claude Code, Codex). Use when the user requests a subagent, a specific local harness/model, a second opinion, parallel task delegation, or background work execution.
---

# Local Subagents

Execute delegated tasks across 5 local coding harnesses (`opencode-subagent`, `opencode-subagent-fallback`, `antigravity-subagent`, `claude-subagent`, `codex-subagent`). Each wrapper runs non-interactively in the target workspace, logs output, captures diffs and telemetry, and integrates with the local Visualizer Dashboard at `http://localhost:4242`.

## Available Harnesses & Invocation

Run from the target repository/workspace directory:

```sh
cd /path/to/workspace

# OpenCode (GLM / multi-provider)
opencode-subagent "Task prompt..."

# OpenCode with Automatic Model Fallback Chain (Quota/Rate-Limit Failover)
OPENCODE_MODEL_CHAIN='zai-coding-plan/glm-5.3,openai/gpt-5.4-mini' opencode-subagent-fallback "Task prompt..."

# Antigravity (Gemini / AGY)
antigravity-subagent "Task prompt..."

# Claude Code (Sonnet / Opus / Haiku)
claude-subagent "Task prompt..."

# OpenAI Codex (GPT-5.6 family)
codex-subagent "Task prompt..."
```

Multi-line prompts can be piped via stdin:
```sh
printf '%s\n' "$DETAILED_TASK" | opencode-subagent
```

## Session Reuse & Continuation (Save Context)

Avoid spawning a fresh session when a task is a continuation or follow-up. Reusing sessions preserves the conversation context, loaded files, and reasoning history:

Use the same provider session when the previous subagent created an issue, returned `partial`/`blocked`, or the follow-up depends on files, reasoning, or decisions from that run. Prefer a fresh session for unrelated tasks, parallel workers, or when prior context could bias the answer.

### 1. Continue the Most Recent Session in Workspace
Use the `--continue` (or `-c`) flag:
```sh
# OpenCode
opencode-subagent --continue "Fix the type error reported in the last step"

# Antigravity
antigravity-subagent --continue "Run tests on the modified component"

# Claude Code
claude-subagent --continue "Proceed with step 2"

# OpenAI Codex
codex-subagent --continue "Add edge case unit tests"
```

### 2. Resume a Specific Session ID
Pass `--resume <session-id>` or `SUBAGENT_SESSION`:
```sh
opencode-subagent --resume "session-abc-123" "Next step prompt..."
# or
SUBAGENT_SESSION="session-abc-123" antigravity-subagent "Next step prompt..."
```
*(Every subagent run writes its persisted `sessionId` in `logs/<log>.done` and in the dashboard header).*

---

## Recommended Orchestration: Zero-Polling & Event-Driven Execution

Avoid busy polling loops (`while sleep 5; check status`) which waste tokens, context window, and CPU. Use one of these **zero-polling** patterns:

Completeness rule: Never tail or manually read run logs to decide whether delegated work is complete. Use `subagent-wait <log-filename>` or `GET /api/runs/<log-filename>/result`. Logs are for debugging only after the structured result says `attentionRequired=true` or the result API is unavailable.

### Pattern A: AI Agent Native Reactive Wake-Up (Recommended for AI Assistants)
When calling a subagent from an agentic runtime (Antigravity, Claude Code, Codex):
1. Launch the command directly (or as a background task):
   ```sh
   opencode-subagent "Implement auth token refresh"
   ```
2. **Stop calling tools**. The harness runtime monitors the process at the OS kernel level and automatically resumes your execution with a `<SYSTEM_MESSAGE> Task finished with result: ...` the exact millisecond the subagent completes.

### Pattern B: Event-Driven `subagent-wait` CLI (For Scripts & Parallel Chaining)
When orchestrating multi-agent parallel pipelines:
```sh
# Launch multiple subagents in parallel
opencode-subagent "Refactor service A" &
antigravity-subagent "Refactor service B" &

# Block until all finish with ZERO CPU/network polling
subagent-wait --last
```
*Uses Linux kernel process monitors (`tail --pid` / `inotify`) and immediately outputs the structured JSON result upon completion.*

### Pattern C: Structured API Result Retrieval
Once notified of completion:
```sh
subagent-wait <log-filename>
```

`subagent-wait` returns the caller contract as JSON and exits nonzero when any result has `accepted=false`. Treat `processStatus=completed` as wrapper success only. Treat the delegated task as accepted only when `accepted=true`. Always surface `blockers`, `incomplete`, and failed/skipped `verification` to the user instead of hiding them in a summary.

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
    "sameSessionCommand": "opencode-subagent --resume <session> \"<follow-up task>\"",
    "continueLastCommand": "opencode-subagent --continue \"<follow-up task>\"",
    "env": { "SUBAGENT_SESSION": "" }
  }
}
```

If `accepted=false` or `outcome` is `partial`, `blocked`, `failed`, or `unknown`, do not mark the parent task complete. Continue with a follow-up subagent prompt, fix the issue directly, or report the blocker to the user. `outcome=unknown` can mean the process exited without writing a `.done` sentinel, so completion could not be verified.

If the original subagent caused a defect and the compact result includes `continuation`, prefer `continuation.sameSessionCommand` so the same agent can repair its own work with full context. Include the exact issue, failing check, and acceptance condition in the follow-up prompt.

For direct dashboard access, use `GET /api/runs/<log-filename>/result` for the compact result contract or `GET /api/runs/<log-filename>` for full metadata. The dashboard history has an Outcome filter for `done`, `partial`, `blocked`, and `unknown` task results.

Dashboard note: Live Terminal is optimized for large logs. It initially shows the latest log tail and keeps a bounded rendered window while continuing to stream new output; use `Load Older`, full-log search, the log download, or `/api/logs/<log-filename>` when more history or the exact full raw log is required. Rebuild the derived SQLite cache with `npm --prefix dashboard run rebuild` if it gets stale.

Do not use `/api/logs/<log-filename>`, `tail`, or the Live Terminal as the normal completion check. They are diagnostic surfaces, not the task result contract.

---

## Model Selection

Inspect available models for each harness:
```sh
opencode-subagent --models --refresh
antigravity-subagent --models
claude-subagent --models
codex-subagent --models
subagent-doctor
```

Use `subagent-doctor` when local-subagents behavior looks stale, Docker restart automation seems broken, or the dashboard/API is unreachable.

Specify a non-default model via environment variables:
- `OPENCODE_MODEL='zai-coding-plan/glm-5.3' opencode-subagent "..."`
- `AGY_MODEL='Gemini 3.7 Flash (High)' antigravity-subagent "..."`
- `CLAUDE_MODEL='opus' claude-subagent "..."`
- `CODEX_MODEL='gpt-5.5' codex-subagent "..."`

### Automatic Model Failover Chains (opencode-subagent-fallback)
To prevent jobs from failing when a model hits monthly quota exhaustion or rate limits, define an `OPENCODE_MODEL_CHAIN`:
```sh
OPENCODE_MODEL_CHAIN='zai-coding-plan/glm-5.3,openai/gpt-5.4-mini,opencode-go/qwen3.7-plus' \
  opencode-subagent-fallback "Implement feature X..."
```
*Sends a cheap pre-flight probe to verify provider quota before committing the full task prompt.*

---

## Emergency Process Control

If a subagent is runaway, stuck, or orphaned:
```sh
# Kill through the dashboard UI or POST these local API endpoints:
http://localhost:4242/api/runs/<log-filename>/kill
http://localhost:4242/api/dangling/kill-all
```

---

## Rules & Best Practices

1. **Always anchor to target workspace**: Always `cd /path/to/target/repo` before running a subagent. Each harness automatically sets strict process and workspace scoping so background runs never leak into your interactive `/resume` lists.
2. **Reuse sessions for multi-step tasks**: Use `--continue` (or `-c`) / `--resume <id>` for follow-up prompts to save context, cache, and token budget.
3. **Never poll in busy loops**: Use native reactive agent wake-up or `subagent-wait` instead of `sleep` polling loops.
4. **Keep tasks bounded**: One bug trace, one refactor, one test implementation, or one code review per turn.
5. **Parallel execution safety**: When running multiple write-capable subagents simultaneously, execute them in separate `git worktree` directories to prevent file write collisions.
6. **Verify deliverables**: Inspect the generated git diff or test results locally after a subagent reports completion before accepting changes.
7. **Never trust process status alone**: `status` / `processStatus` says whether the wrapper exited. `accepted` says whether the task result is safe to accept.
8. **Never tail logs for acceptance**: Call `subagent-wait` or `/api/runs/<log>/result`; only inspect logs when debugging a failed, blocked, partial, or unknown outcome.
9. **Reuse sessions deliberately**: Use `continuation.sameSessionCommand` for fixes to the same task or closely related follow-ups. Do not reuse one session across unrelated tasks or parallel workers.
