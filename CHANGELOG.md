# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [1.3.0] - 2026-09-26

### Added

- Zero-API-key dynamic model resolution across all providers (`scripts/resolve-models.mjs`):
  - **Codex:** Dynamically extracts models from local client cache (`~/.codex/models_cache.json`).
  - **Claude Code:** Dynamically extracts configured models and tiers from `~/.claude.json` and `~/.claude/settings.json`.
  - **Antigravity:** Live query via `agy models`.
  - **OpenCode:** Live query of supported providers (`opencode-go`, `openai`, `zai-coding-plan`).
  - Supports custom model additions via `.agent-relay.json` or `~/.agent-relay/models.json`.
- New CLI command: `relay models [provider]` to inspect available models directly from the terminal.
- Updated `codex-agent --models` and `claude-agent --models` to use dynamic resolution with graceful fallback.
- Added test coverage in `tests/test-models.mjs` and `tests/test-wrappers.sh`.

## [1.2.1] - 2026-09-26

### Fixed

- Eliminated `/proc/$pid/cmdline` missing file stderr noise across all 4 agent wrappers (`antigravity-agent`, `claude-agent`, `codex-agent`, `opencode-agent`) by silently verifying file existence before reading.
- Fixed GitHub Actions CI failure on clean checkouts by adding `pretest` npm script to auto-generate derived plugin skills and updating CI workflow to run `npm run sync:skills` before testing.
- Added `scripts/install-tui.mjs` to CI Node.js syntax check step.

## [1.2.0] - 2026-09-26

### Added

- Interactive Terminal User Interface (TUI) for installation and environment setup (`scripts/install-tui.mjs`):
  - Accessible via `relay install --tui` or `relay init --tui` (and automatically invoked when `relay install` runs interactively in a TTY).
  - Automatically scans `$PATH` for installed AI harnesses (`claude`, `codex`, `opencode`, `agy`) and shows live detection status.
  - Interactive keyboard-driven checkbox multi-select menu (arrows/hjkl, space to toggle, enter to confirm, 'A' to toggle all).
  - Prompts for optional Claude Code `SessionStart` reminder hook.
  - Interactive selection of dashboard deployment method (Docker container, native background process, or skip).
  - Zero external dependencies: pure Node.js standard library with ANSI terminal escape sequences.

## [1.1.6] - 2026-09-26

### Fixed

- Dashboard **Tokens / Size** column now displays the real log file size (e.g. `512 KB`)
  when a run does not have token metrics, instead of incorrectly showing `0 B`:
  1. `rowToRunMeta` in `dashboard/db.js` now exports `fileSizeHuman` formatted via `formatBytes(size)`.
  2. `dashboard/public/app.js` now includes a `formatBytes()` fallback utility for `run.size`.
  3. `scripts/subagent-tracker.js` now enriches finished runs with `parseLogMetadata({ enrich: true })`
     on completion so token metrics, tool calls, and diffs are immediately saved into SQLite.

## [1.1.5] - 2026-09-26

### Fixed

- `antigravity-agent` watchdog no longer prematurely kills `agy` mid-response,
  causing the recurring "response loop" where the agent produced only an opening
  line before exiting. Two bugs in the completion-detection condition:
  1. The event key was `"event":"result"` but agy stream-json emits
     `"type":"result"` — so the primary check **never fired**.
  2. The fallback grep matched `"outcome":"done"` anywhere in raw log text,
     which false-positives the moment Gemini mentions the output format in its
     introductory text (before doing any actual work).
  Fix: correct the event key to `"type":"result"` and tighten the fallback to
  require `"outcome"` AND `"changedFiles"` on the same line — only satisfiable
  by the real complete JSON block, not a casual inline mention.

## [1.1.4] - 2026-09-26

### Changed

- `plugins/agent-relay/skills/` is now a derived artifact: gitignored and
  regenerated from the canonical `skills/agent-relay/` source by the `prepack`
  script before every npm publish. Previously both copies were tracked in git,
  causing them to drift whenever a commit touched `skills/` outside of a
  publish cycle.

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
