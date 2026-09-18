---
name: agent-relay
description: Delegate bounded tasks to local Codex, Claude Code, OpenCode, or Antigravity agents; inspect results, continue work, and transfer context between providers.
---

# Agent Relay

Requires the host agent-relay installation (`./install-skill` from its checkout),
Node, and an authenticated provider CLI. Plugins do not install providers or
start the dashboard. Run `relay --help` to verify installation.

Prefer the bundled MCP tools: `run_agent`, `get_run_result`, `wait_for_run`,
`continue_run`, and `takeover_run`. Pass an explicit workspace, bounded task,
owned files, and verification target. Check `accepted`, blockers, incomplete
work, and verification before declaring success. Logs are diagnostic only.

Shell equivalents, run from the target repository:

```sh
relay codex "Task with scope and verification target"
relay result --last
relay continue "Follow up on the previous task"
relay takeover claude "Finish the remaining work"
relay workspaces
relay dashboard
```

Provider names: `codex`, `claude`, `opencode`, `antigravity`. Use continuation
for related work; fresh sessions for unrelated tasks. Parallel editing requires
separate worktrees or disjoint file ownership. Do not commit, publish, deploy,
or message others unless authorized. A task instruction is not a sandbox.

The dashboard is at http://localhost:4242 after starting it separately.
`relay dashboard` checks availability. The CLI, MCP server, and dashboard share
the installed checkout's logs and data; plugin caches do not store run history.
