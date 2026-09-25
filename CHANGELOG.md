# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [1.1.3] - 2026-09-25

### Fixed

- Completed agent runs no longer show `outcome=unknown` in the dashboard and
  API. `registerRunComplete` (called by `subagent-tracker.js` at the end of
  every wrapper run) now reads the `.done` sentinel file and persists
  `outcome`, `attention_required`, and `result_json` to the DB row directly.
  Previously those columns were left at their schema defaults (`'unknown'`,
  `0`, `NULL`) because `reconcileActiveRuns` only processes rows still in
  `status='running'`, which these rows are not by the time reconcile runs.
- Existing stale rows in the database are backfilled from on-disk `.done`
  files on startup.

## [1.1.2] - 2026-09-25

### Fixed

- MCP `run_agent` (synchronous mode) no longer returns `outcome='unknown'` /
  `accepted=false` when the run completed successfully. After the child process
  closes, the server now waits up to 2 s (20 × 100 ms polls) for the `.done`
  sentinel file written by `write-done.mjs` before reading the structured
  result, eliminating the race between the wrapper shell exiting and the
  final node child finishing disk I/O.

## [1.1.1] - 2026-09-25

### Fixed

- Dashboard dangling process detection no longer produces false positives for
  child/grandchild processes spawned by active agent runs or for wrapper parent
  processes whose PIDs were not directly tracked in the database. A single-pass
  `/proc` tree snapshot is built upfront; `activePids` is expanded via BFS to
  all descendants and one level upward to direct parents before the cmdline scan.

## [1.1.0] - 2026-09-24

### Added

- Route delegated tasks by named rule, prompt keyword, or target file path using repository or global routing config.
- Select providers and models through `relay route` and MCP `run_agent`, with explicit choices taking precedence.

### Changed

- Document routing configuration, selection order, and repository/global precedence.

## [1.0.4] - 2026-09-22

### Added

- Task routing configuration module with host model discovery (`relay config init [--global]`, `relay install`).
- Auto-population of global routing config (`~/.config/agent-relay/routing.json`) during `relay install`.

### Changed

- Dashboard landing page mobile optimization:
  - Header padding and subtitle responsive scaling to prevent layout clutter.
  - Horizontally swipeable metrics chips and segmented filters with smooth touch scrolling.
  - 2x2 executive KPI summary grid on mobile viewports.
  - Run history table converted to responsive native-like cards on viewports <= 768px with prompt preview, status, tokens, and direct CLI / Inspect action buttons.
- Fullscreen workspace inspection modal mobile optimization:
  - Header reorganized with dedicated touch-friendly close button pinned to top-right.
  - Horizontally scrollable actions toolbar (Details, Stop, Copy CLI, Continue, Run Again, Copy Prompt, Raw Log).
  - Collapsible task description, token cost, and modified files drawer, giving 90%+ vertical space to terminal/diff viewers by default.
  - Smooth horizontal scrolling for multi-tabs and tool filter pills.
