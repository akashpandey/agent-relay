---
name: local-subagents
description: Delegate a bounded coding, investigation, review, or parallel implementation task to local CLI subagents (OpenCode, Antigravity, Claude Code, Codex). Use when the user requests a subagent, a specific local harness/model, a second opinion, parallel task delegation, or background work execution.
---

# Local Subagents

Execute delegated tasks across 4 local coding harnesses (`opencode-subagent`, `antigravity-subagent`, `claude-subagent`, `codex-subagent`). Each wrapper runs non-interactively in the target workspace, logs output, captures diffs and telemetry, and integrates with the local Visualizer Dashboard at `http://localhost:4242`.

## Available Harnesses & Invocation

Run from the target repository/workspace directory:

```sh
cd /path/to/workspace

# OpenCode (GLM / multi-provider)
opencode-subagent "Task prompt..."

# Antigravity (Gemini / Claude Sonnet via AGY)
antigravity-subagent "Task prompt..."

# Claude Code (Sonnet / Opus / Haiku)
claude-subagent "Task prompt..."

# OpenAI Codex (GPT-5.5 / GPT-4o)
codex-subagent "Task prompt..."
```

Multi-line prompts can be piped via stdin:
```sh
printf '%s\n' "$DETAILED_TASK" | opencode-subagent
```

## Recommended Orchestration: Background Execution & API Monitoring

To avoid flooding your prompt context window with thousands of lines of raw terminal logs, follow this **API-First Background Protocol**:

### Step 1: Launch in Background
Launch the subagent in the background with `&`:
```sh
opencode-subagent "Refactor token auth middleware..." &
```

### Step 2: Check Liveness & Progress via API (Heartbeat)
Query the structured sentinel endpoint rather than running raw `tail` on logs:
```sh
curl -s http://localhost:4242/api/stats | jq '.activeRuns[] | {pid, provider, model, durationHuman, currentAction, isAlive}'
```
*Returns clean JSON with explicit process state, active tool in flight, and duration (consuming only ~60 tokens).*

### Step 3: Retrieve Clean Structured Result Upon Completion
Once `isAlive` is `false`, fetch the parsed telemetry and summary directly:
```sh
curl -s "http://localhost:4242/api/runs/<log-filename>" | jq '{status, filesModified, cost, markdownSummary, toolCalls}'
```
*Returns the exact modified files, diff summary, token spend, and verification status with zero ANSI garbage or log noise.*

## Model Selection

Inspect available models for each harness:
```sh
opencode-subagent --models --refresh
antigravity-subagent --models
claude-subagent --models
codex-subagent --models
```

Specify a non-default model via environment variables:
- `OPENCODE_MODEL='openai/gpt-5.4-mini' opencode-subagent "..."`
- `AGY_MODEL='Claude Sonnet 4.6 (Thinking)' antigravity-subagent "..."`
- `CLAUDE_MODEL='opus' claude-subagent "..."`
- `CODEX_MODEL='gpt-5.5' codex-subagent "..."`

## Session Resumption (Sequential Follow-ups)

Every subagent run prints its persisted session ID. To continue a previous turn:
```sh
SUBAGENT_SESSION='<session-id>' opencode-subagent "Implement the second step."
```

## Emergency Process Control

If a subagent is runaway, stuck, or orphaned:
```sh
# Kill a specific subagent process tree:
curl -X POST "http://localhost:4242/api/runs/<log-filename>/kill"

# Kill all orphaned/dangling subagents:
curl -X POST "http://localhost:4242/api/dangling/kill-all"
```

## Rules & Best Practices

1. **Prefer API monitoring for background tasks**: Always query `http://localhost:4242/api/stats` and `http://localhost:4242/api/runs/:id` instead of raw `tail` to protect context windows.
2. **Keep tasks bounded**: One bug trace, one refactor, one test implementation, or one code review.
3. **Parallel execution**: When running multiple write-capable subagents simultaneously, execute them in separate `git worktree` directories to prevent file write collisions.
4. **Verify deliverables**: Inspect the generated git diff or test results locally after a subagent reports completion before accepting changes.
