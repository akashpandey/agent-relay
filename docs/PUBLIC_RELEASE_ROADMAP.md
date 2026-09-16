# Public Release and Production Readiness Roadmap

## Purpose

`agent-relay` gives any shell-capable AI harness a stable way to delegate
work to other installed AI CLIs. This lets users choose specialized models for
specific tasks without replacing their primary harness or consuming only its
model allocation.

The public product should remain two separable pieces:

1. Thin CLI wrappers that preserve the existing task/stdin, stdout, logging,
   session, timeout, and exit-code behavior.
2. An optional local monitoring layer that records and visualizes task
   relationships without becoming the execution boundary.

Provider SDKs are not required for the initial release. The installed CLIs
remain responsible for authentication, provider access, model execution, and
workspace changes.

## Current State

Snapshot verified on 2026-08-03:

- The GitHub repository is private.
- The wrappers support Codex CLI, Claude Code, OpenCode, and Antigravity.
- Tasks can be supplied as arguments or stdin.
- Runs preserve exit codes, support timeouts and session reuse, write logs, and
  attempt child-process cleanup.
- A canonical local skill can be symlinked into Codex and Claude Code.
- POSIX shell syntax checks pass.
- There is no license, tagged release, automated test suite, CI workflow,
  contribution guide, or security policy.
- GitHub reports 28% community-profile completeness.
- Run logs are human-readable but there is no stable machine-readable task
  lifecycle or parent-child relationship format.

## Product Principles

- Preserve the existing command-line contract.
- Keep each provider CLI as the execution boundary.
- Make monitoring optional and local-first.
- Do not require a central cloud service or user API keys outside the provider
  CLIs they already use.
- Default to safe permissions; weaker isolation must require explicit consent.
- Record metadata by default, not full prompts or model output.
- Support one platform well before claiming broad portability.

## Target Architecture

```text
Primary harness
  └─ provider wrapper
      ├─ installed provider CLI
      ├─ stdout, stderr, exit code, and run log
      └─ structured lifecycle events
           └─ local monitor
               ├─ task store
               ├─ live event stream
               └─ browser task tree
```

The wrappers should work exactly as they do today when monitoring environment
variables are absent.

## Milestone 1: Public Beta

### Repository readiness

- Choose and add a license. Apache-2.0 provides an explicit patent grant; MIT
  is shorter and simpler. This is an owner decision.
- Add `CONTRIBUTING.md`, `SECURITY.md`, issue templates, and a pull-request
  template.
- Document supported platforms, backing CLI prerequisites, permission behavior,
  log contents, and known limitations.
- Add installation and uninstallation commands for both wrapper executables and
  harness skills.
- Add semantic versioning, starting with a `v0.1.0` beta release.
- Publish release notes and checksums for downloadable artifacts.

### Automated checks

Use fake provider executables so CI does not require accounts, credentials, or
model usage. A small POSIX shell test script is sufficient initially.

Cover:

- task arguments and stdin;
- empty and invalid invocation behavior;
- model and effort environment variables;
- session propagation;
- stdout, stderr, and exit-code preservation;
- timeout and signal handling;
- log creation and permissions;
- model-list output contracts;
- concurrent runs with distinct logs and IDs;
- child-process cleanup.

GitHub Actions should run shell syntax checks, ShellCheck, the fake-CLI tests,
and `git diff --check`. Start with Ubuntu only while the runtime remains
Linux-specific.

### Beta definition of done

- A new user can install, run, update, and uninstall the wrappers from the
  documented instructions.
- CI passes without provider credentials.
- Unsafe permission behavior is clearly disclosed and opt-in.
- The repository has a license and a published `v0.1.0` release.
- No existing harness invocation needs to change.

## Milestone 2: Runtime Hardening

### Portability

- Discover backing executables with `command -v` and allow explicit binary path
  overrides instead of assuming fixed paths under `$HOME`.
- Declare Linux as the initial supported platform.
- Treat macOS, Windows, and WSL as future compatibility work until timeout,
  process-group, symlink, and cleanup behavior is tested there.

### Isolation and permissions

- Do not automatically downgrade Codex from `workspace-write` to
  `danger-full-access`. Require an explicit override when safe sandboxing is
  unavailable.
- Replace unconditional permission-bypass flags in other wrappers with explicit
  configuration where their CLIs permit it.
- Bind every run to a unique process group or cgroup.
- Remove or constrain workspace-wide `/proc` cleanup. Concurrent runs in the
  same workspace must not be able to terminate one another's processes.
- Document that provider CLIs can modify the current workspace and should be run
  only in trusted repositories or isolated worktrees.

### Logs and secrets

- Create run data with `umask 077`.
- Add configurable log retention and a cleanup command.
- Do not store full task prompts in structured metadata by default.
- Warn that raw provider logs can contain prompts, source code, file paths,
  command output, or credentials exposed by the underlying CLI.

## Milestone 3: Structured Task Events

Add three optional environment variables:

```text
AGENT_RELAY_RUN_ID
AGENT_RELAY_PARENT_ID
AGENT_RELAY_EVENT_DIR
```

If `AGENT_RELAY_RUN_ID` is absent, the wrapper generates one. Before launching the
provider CLI, it exports its run ID as the parent ID inherited by any nested
wrapper. This creates task ancestry without parsing prompts or guessing from
the operating-system process tree.

Each run writes to its own JSONL event file to avoid concurrent writers. The
initial event vocabulary should stay small:

- `started`
- `completed`
- `failed`
- `cancelled`

Minimum event fields:

```json
{
  "schema": 1,
  "event": "started",
  "run_id": "generated-id",
  "parent_id": "optional-parent-id",
  "provider": "codex",
  "model": "selected-or-default",
  "workspace": "/path/to/repository",
  "pid": 12345,
  "timestamp": "2026-08-03T12:00:00Z",
  "log_path": "/path/to/run.log"
}
```

Completion events add duration and exit code. Provider session IDs and usage
metadata may be added when reliably available, but should remain optional.

### Event definition of done

- Existing invocations behave identically when event recording is disabled.
- Parallel and nested fake-CLI tests produce a correct task tree.
- Abrupt failure produces a recoverable terminal or stale-run state.
- The schema is versioned and documented.

## Milestone 4: Local Monitoring UI

Start with a read-only local monitor. A small standard-library HTTP server and a
static HTML/SVG interface are enough; a frontend framework is not required.

### Initial UI

- Parent-child task tree or directed graph.
- Status colors for running, completed, failed, cancelled, and stale tasks.
- Provider, model, workspace, start time, duration, and exit code.
- Task detail view with live log tail.
- Filters for provider, model, workspace, and status.
- Collapsed historical runs and configurable retention.

### Security boundaries

- Bind to `127.0.0.1` by default, never `0.0.0.0`.
- Use a per-launch access token because logs may contain sensitive data.
- Validate requested log paths against the configured run directory.
- Keep the first version read-only.
- Add cancellation, retries, or reruns only after authentication, authorization,
  and process ownership are reliable.

GitHub Pages can host project documentation and a demonstration using synthetic
events. It cannot host the real monitor because the task data and logs remain on
the user's machine.

## Future Ideas

Only add these after real usage demonstrates demand:

- Declarative routing from task type to installed provider/model.
- Provider health and quota probes.
- Token and cost normalization where CLIs expose reliable usage data.
- Export to OpenTelemetry or another external observability system.
- Remote team monitoring with authentication and encrypted transport.
- Package-manager distribution such as Homebrew, Scoop, or an OS package.

## Recommended Sequence

1. Complete public-repository hygiene and fake-CLI tests.
2. Harden permissions, cleanup, portability claims, and log handling.
3. Introduce the versioned event schema and parent-ID propagation.
4. Release the read-only local monitor.
5. Consider control actions and model-routing policy only after observing real
   user workflows.

The immediate product milestone is a trustworthy public beta with structured
events. Once run identity and ancestry are reliable, the visualization layer is
small and can evolve without destabilizing the wrappers.
