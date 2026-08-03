# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- `codex-subagent` for non-interactive local Codex delegation with model, reasoning-effort, sandbox, timeout, logging, and cleanup support.
- Optional `CLAUDE_EFFORT` support for Claude Code reasoning-effort selection.
- `claude-subagent` for non-interactive Claude Code delegation with model, fallback, timeout, logging, and cleanup support.
- `opencode-subagent --models [--refresh]` to list its documented provider-filtered model catalogue.
- `antigravity-subagent --models` to list its available model catalogue.
- Model catalogue snapshots and refresh commands in the README.
- `SUBAGENT_SESSION` support to resume a provider session across sequential wrapper calls.
- Transient systemd user-service execution with cgroup-wide cleanup and runtime limits, with the existing process cleanup retained as fallback.
