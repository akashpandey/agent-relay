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

## Observability & Live Visualizer

- **Live Dashboard**: Open `http://localhost:4242` to inspect active runs, stream live terminal outputs, view token/cost breakdowns, explore executed tool/command timelines, and inspect visual git diffs.
- **Log Files**: Stored in `~/local-subagents/logs/<timestamp>-<provider>-<pid>.log`.
- **Dangling Process Cleanup**: The dashboard sentinel automatically tracks and allows 1-click termination of orphaned processes.

## Rules & Best Practices

1. **Keep tasks bounded**: One bug trace, one refactor, one test implementation, or one code review.
2. **Parallel execution**: When running multiple write-capable subagents simultaneously, execute them in separate `git worktree` directories to prevent file write collisions.
3. **Verify deliverables**: Inspect the generated git diff or test results locally after a subagent reports completion before accepting changes.
