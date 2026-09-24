# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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
