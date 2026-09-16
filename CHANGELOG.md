# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- `codex-agent` for non-interactive local Codex delegation with model, reasoning-effort, sandbox, timeout, logging, and cleanup support.
- Optional `CLAUDE_EFFORT` support for Claude Code reasoning-effort selection.
- `claude-agent` for non-interactive Claude Code delegation with model, fallback, timeout, logging, and cleanup support.
- `opencode-agent --models [--refresh]` to list its documented provider-filtered model catalogue.
- `antigravity-agent --models` to list its available model catalogue.
- Model catalogue snapshots and refresh commands in the README.
- `AGENT_RELAY_SESSION` support to resume a provider session across sequential wrapper calls.
- Transient systemd user-service execution with cgroup-wide cleanup and runtime limits, with the existing process cleanup retained as fallback.
