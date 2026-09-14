# Contributing to agent-relay

Thank you for your interest in contributing to `agent-relay`!

## Design Philosophy

1. **Unix-first & Harness-agnostic**: Everything communicates through standard POSIX shell conventions (arguments, stdin, stdout, stderr, exit codes, process signals). Avoid vendor SDK couplings.
2. **Execution Boundary**: Backing CLIs (`claude`, `codex`, `agy`, `opencode`) are responsible for model auth, provider API calls, and file operations. The wrappers manage process lifecycles, timeouts, and logging.
3. **Local-first Observability**: Logs, diagnostics, and dashboard data remain strictly on your local machine.

## Local Setup & Development

Clone the repo and verify your environment:

```bash
git clone https://github.com/akashpandey/agent-relay.git
cd agent-relay

# Run health checks
./relay doctor
```

### Running Tests

We run tests against mock CLIs so you do not need active API keys or LLM provider accounts to test wrapper mechanics:

```bash
./tests/test-wrappers.sh
```

Ensure POSIX shell scripts pass syntax checks:

```bash
sh -n antigravity-subagent claude-subagent codex-subagent opencode-subagent subagent subagent-wait subagent-doctor
```

If you have `shellcheck` installed:

```bash
shellcheck -s sh antigravity-subagent claude-subagent codex-subagent opencode-subagent subagent subagent-wait subagent-doctor
```

## Pull Request Guidelines

1. **Keep changes focused**: One feature or bugfix per PR.
2. **Preserve command-line contracts**: Existing harness integrations (stdin/stdout, exit codes, log paths) must not break.
3. **Include tests**: Add or update test cases in `tests/test-wrappers.sh` whenever wrapper behavior changes.
4. **Sign off your commits**: Follow standard semantic commit messages (`feat: ...`, `fix: ...`, `docs: ...`).
