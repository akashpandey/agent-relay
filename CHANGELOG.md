# Changelog

All notable changes to this project are documented in this file.

## [1.8.0] - 2026-11-08

### Added

- `relay takeover [workspace] <provider> [instructions...] [--model <model>]` now accepts `--model <name>`; the model is resolved via the provider's model env var (`runProvider`), matching `relay <provider> --model`. Usage text and the agent-relay skill updated.

## [1.7.0] - 2026-11-07

### Added

- Opt-in raw-log retention: set `AGENT_RELAY_LOG_RETENTION` (e.g. `30d`) and the dashboard startup sweep deletes `*.log`/`.done` sidecars of completed/failed runs past the horizon (in-progress runs are never touched); SQLite run history stays intact by design. Orphaned sidecars with no run row are reaped by file mtime. `relay prune --confirm` remains the explicit path for removing history rows as well as logs.

## [1.6.0] - 2026-11-07

### Fixed

- `relay <provider> --model` with the `agy` alias silently wrote an env var named `undefined` and dropped the model; the shared `scripts/provider-env.mjs` map now serves both the CLI and MCP server, including per-provider timeout formats.
- Codex runs no longer occasionally exit `stdin is not a terminal`: wrapper runtime moved into shared `scripts/wrapper-lib.sh`, and provider arguments are passed through explicitly (`run_agent_runtime "$@"`).
- Background `run_agent` resolves the target run deterministically from the wrapper's `run_log=` stderr marker instead of diff-scanning `logs/` (races with concurrent launches and recycled PIDs could bind the result to the wrong run log).
- Looking up a run by PID no longer matches stale logs from a recycled PID (`/proc` start-time guard).
- `kill_run` process-identity check no longer depends on locale-specific `ps -o lstart=` parsing.
- `relay install` no longer overwrites an unreadable/corrupt `~/.claude.json`, `opencode.json`, or Antigravity `mcp_config.json`; the failing provider is reported and left untouched. Non-object JSON is rejected the same way.
- `install-skill` archives an existing real (non-symlink) `agent-relay` skill directory to `<target>.pre-relay-backup` instead of deleting it.
- The installation TUI no longer crashes when stdin is not a terminal (arrow menus fall back to defaults), and its explicit dashboard choice (`docker` vs `background`) is now honored by `relay install` via `AGENT_RELAY_DASHBOARD_MODE` instead of always defaulting to Docker.

### Changed

- Dashboard live-terminal pane is now readable for `--json` runs: codex `item.completed`/`mcp_tool_call`/`command_execution`, Claude Code `assistant`/`user`/`system`, and OpenCode JSONL (`tool_use`/`text`/`step_*`) render as styled blocks (prose cards, EXEC lines with exit codes, dimmed compacted payloads with "(+N chars)" markers instead of raw JSON walls). OpenCode logfmt INFO event noise is hidden, WARN+ kept; ANSI rendering handles composed SGR sequences (`1;31m`, dim, resets) and drops non-color sequences; internal `agent-output-*` markers are hidden and wrapper banners are visually distinct. Regression coverage in `tests/test-terminal-format.mjs`.
- The four provider wrappers share one runtime skeleton (`wrapper-lib.sh`): prompt scaffold, exec/watchdog/cleanup, and completion wrap-up. Provider specifics (args, model aliases, completion markers, session-id parsing, prompt rules) stay per wrapper; `.done` now records the resolved model id rather than the raw alias.
- `relay`/`subagent` CLI error messages consistently use the configured CLI name instead of the legacy literal `subagent:`.
- Session-details lookup failures in `get_session_history` are logged instead of silently swallowed.

## [1.5.1] - 2026-10-21

### Fixed

- Dashboard run details now recover summaries, tools, commands, token usage, and changed files from OpenCode 2.x sessions and JSON logs.
- Opening an incomplete run refreshes its cached details while preserving existing data.

## [1.5.0] - 2026-10-21

### Fixed

- OpenCode 2.x compatibility: `opencode-agent` now runs `opencode run --standalone` and passes variants as `--model <model>#<variant>` (`--dir` and `--variant` were removed upstream).
- Model discovery (`relay models`, `opencode-agent --models`) works again: `opencode models` no longer accepts a provider argument, so output is filtered by provider prefix. `--models --refresh` is accepted as a no-op.
- `probe_model` / `relay probe` for OpenCode no longer fails on the removed `--pure` flag.

### Changed

- The native OpenCode plugin uses the v2 `{ id, setup }` default-export shape and injects guidance through the `context` session hook. It no longer loads on OpenCode 1.x and no longer registers the MCP server (`relay install` does).

## [1.4.1] - 2026-10-20

### Added

- Added `probe_model` MCP tool to `scripts/mcp-server.mjs` enabling calling LLMs and orchestrators to check model responsiveness, availability, and quota status directly over MCP prior to dispatching tasks.
- Updated skill instructions in `skills/agent-relay/SKILL.md` (and plugin copies) with pre-flight guidelines requiring calling LLMs to probe target models before delegating work.

## [1.4.0] - 2026-10-15

### Added

- `relay probe <provider> --model <model> [--timeout 30] [--json]` checks a model through the authenticated provider CLI using a tiny request in a temporary workspace, without relay run records or wrapper fallback chains.
- Probe results distinguish ready, explicit quota exhaustion, rate limiting, authentication failure, unavailable models, timeouts, network errors, and unknown failures. Model identity and retry hints are included when reported by the provider.
- Probes bound output and execution time, clean up child processes, and return script-friendly exit codes. Antigravity uses plan mode and sandboxing because its CLI lacks a switch to disable all tools.

## [1.3.3] - 2026-10-15

### Fixed

- Dashboard updates now batch all changed logs every 200 ms, preventing continuous output from postponing refreshes and simultaneous runs from losing updates.
- Dashboard event streams send updates every 15 seconds to keep idle connections alive and include changes written directly to SQLite.
- Reconnecting dashboards fetch current data immediately and poll every 15 seconds while disconnected.
- Synchronized the Claude marketplace plugin version with the package release.

## [1.3.2] - 2026-09-30

### Fixed

- Fixed modal "Copy" and "Copy Prompt" buttons copying only truncated 300-character task previews:
  - Added `full_task TEXT` column to SQLite `runs` table schema with automatic migration.
  - Persisted `fullTask` in `upsertRun` and `registerRunStart`, returning complete prompt strings via `rowToRunMeta`.
  - Added self-healing in `GET /api/runs/:filename` to re-extract complete `fullTask` from on-disk log files for legacy database records.
  - Extended dashboard search query filtering to match keywords in `full_task`.
  - Updated `scripts/subagent-tracker.js` to pass both short preview and full prompt on run start.
  - Added unit test suite in `tests/test-runs-task.mjs`.

## [1.3.1] - 2026-09-28

### Fixed

- Fixed non-functional copy buttons in the dashboard modal window:
  - Made `copyToClipboard` resilient across all environments with a 3-tier fallback: modern async `navigator.clipboard.writeText` in secure contexts, universal `document.execCommand('copy')` via offscreen textarea for non-secure HTTP / LAN / iframes, and prompt fallback.
  - Added CLI reproduction command fallback (`meta.runAgainCommand`) when `meta.cliCommand` is empty so "Copy CLI" and reproduction cards copy executable agent commands.
  - Added temporary in-button visual confirmation (`flashButtonCopied`) flashing "Copied!" or checkmark on click.
  - Added user feedback toasts when copying empty or still-loading task prompts, CLI commands, or logs instead of failing silently.
  - Added placeholder click handlers when opening run modals to handle early clicks gracefully during metadata loading.

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
