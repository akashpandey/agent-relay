---
name: local-subagents
description: Delegate a bounded coding, investigation, or review task to the locally installed Codex, Claude Code, OpenCode, or Antigravity CLI through the local-subagents wrappers. Use when the user asks to use a subagent, a specific local model/CLI, a second opinion, or parallel delegated work. Do not use for a trivial edit, interactive back-and-forth, production changes, or an unbounded task.
---

# Local subagents

Run a wrapper from `/home/akey/local-subagents` in the target workspace. Pass a
short task as an argument or a multi-line task on stdin. The wrapper writes in
the current workspace, returns the underlying exit status, and logs the run.

```sh
cd /path/to/workspace
printf '%s\n' "$TASK" | /home/akey/local-subagents/codex-subagent
```

Choose the wrapper the user named. Otherwise use a default model from a local
CLI, or use a different provider for a second opinion:

- `codex-subagent` — Codex.
- `claude-subagent` — Claude Code.
- `opencode-subagent` — an OpenCode provider/model.
- `antigravity-subagent` — Antigravity / Gemini / alternate review.

List current selectors before choosing a named model:

```sh
/home/akey/local-subagents/codex-subagent --models
/home/akey/local-subagents/claude-subagent --models
/home/akey/local-subagents/opencode-subagent --models --refresh
/home/akey/local-subagents/antigravity-subagent --models
```

Use the matching environment variable for a named model: `CODEX_MODEL`,
`CLAUDE_MODEL`, `OPENCODE_MODEL`, or `AGY_MODEL`. Use each wrapper's `--help`
for timeout and reasoning settings.

Delegate one clear deliverable with boundaries and an expected check. Do not run
multiple write-capable subagents in the same worktree. Review the actual diff
and rerun relevant checks after a subagent reports completion.
