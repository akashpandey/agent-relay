# Install agent-relay and its dashboard

## Quickstart (2 minutes)

Run these two commands in any Linux terminal or WSL2 environment with Node.js 24+ and at least one authenticated AI CLI (`claude`, `codex`, `opencode`, or `agy`):

```bash
npm install -g @akashpandey/agent-relay
relay install
```

### What happens automatically:

1. **`npm install -g @akashpandey/agent-relay`** — installs the unified `relay` CLI, MCP server, and provider wrappers.
2. **`relay install`** — sets up your environment end-to-end:
   - **Installs the Skill**: Automatically links the `agent-relay` skill into Claude Code, Codex, Antigravity, and OpenCode.
   - **Registers MCP Tools**: Wires the MCP server into all detected harnesses.
   - **Claude Code SessionStart Hook**: Prompts to add an opt-in reminder so Claude knows delegation is available.
   - **Starts the Dashboard**: Offers to run the local monitor at `http://localhost:4242` (Docker if available, or plain background process).

Example install summary output:
```text
claude: skill+bin ok, mcp registered
codex: skill+bin ok, mcp registered
opencode: not found on PATH, skipped
agy: not found on PATH, skipped
hooks (Claude Code): registered
```

---

## How to use it: Just talk to your assistant!

Setup is done. **Go to your normal AI chat tab (Claude Code, Codex, etc.) and talk to it in plain English.**

You do **not** need to open other terminals or type wrapper commands manually. Your assistant delegates through agent-relay for you:

### Try your first prompt:
> *"Use agent-relay to have Codex describe this repository in one sentence. Do not edit any files."*

### Everyday delegation scenarios:
- **Second opinion / code review:**
  > *"Ask Codex to review my recent changes in `src/auth.ts` for security edge cases."*
- **Parallel test writing (TDD):**
  > *"Use OpenCode with GLM to write comprehensive unit tests for `utils.js` while you work on `api.js`."*
- **Token exhaustion handoff:**
  > *"I am running low on Claude tokens. Use relay takeover so Codex can finish this refactoring task."*

Your assistant delegates the task, streams progress to `http://localhost:4242`, waits for the real verification result (pass, fail, or blocked), and reports back directly in your chat.

*(Prefer direct scripting or terminal usage? You can also run commands directly like `relay claude "task"`. See [Usage](../README.md#usage) in the README).*

---

### 1. Prerequisites

Use Linux, or Linux inside WSL2. Linux is covered by CI; verify WSL2 on your
machine. Native Windows and macOS are not validated targets: wrappers use Linux
utilities including `setsid`, `timeout`, and `/proc`. On Windows, install Node
and your provider inside WSL and run these commands in that Linux terminal.

- [Node.js](https://nodejs.org/en/download) **24+** is recommended and used in
  CI. The declared minimum is 22.5.0; the Docker dashboard uses Node 22. Docker
  does not remove the host Node requirement.
- [Git](https://git-scm.com/downloads).
- [Docker Engine](https://docs.docker.com/engine/install/) and
  [Compose](https://docs.docker.com/compose/install/linux/), or
  [Docker Desktop with WSL integration](https://docs.docker.com/desktop/features/wsl/) —
  only needed for the persistent Docker dashboard. Skip Docker entirely if you
  use the foreground dashboard option instead (covered below), or no
  dashboard at all.
- Install and authenticate [Codex](https://github.com/openai/codex),
  [Claude Code](https://code.claude.com/docs/en/setup), or
  [OpenCode](https://opencode.ai/docs/) using its setup guide. Open it directly
  and confirm it can answer a prompt. Antigravity requires the
  [Antigravity CLI](https://antigravity.google/docs/cli/) executable `agy`;
  the editor or generic Gemini CLI alone is insufficient.

Check readiness (replace `codex` with your provider; omit Docker checks if
you're skipping Docker):

```bash
node --version
git --version
command -v codex
docker info
docker compose version
```

Provider charges and quotas apply; relay does not supply models or credentials.

### 2. Install

The quickstart above (`npm install -g @akashpandey/agent-relay` then
`relay install`) is the recommended path and covers most people. Use a
Git checkout instead if you want to track `main`, contribute, or run from
source:

```bash
git clone https://github.com/akashpandey/agent-relay.git "$HOME/agent-relay"
cd "$HOME/agent-relay"
./install-skill
export PATH="$HOME/.local/bin:$PATH"
relay --help
```

Add the PATH export once to `~/.bashrc` (Bash) or `~/.zshrc` (Zsh). Open a new
terminal and confirm `command -v relay` works. No sudo or npm install is needed.
Keep the checkout: commands and skills are symlinks into it. `./install-skill`
warns (but still proceeds) if it would replace an existing symlink pointing
somewhere else; pass `--force` to skip the warning. From a checkout, `relay
install` still handles MCP registration and the dashboard prompt the same way
it does after an npm install.

Wrappers find providers through PATH. For unusual executable locations, set
`AGENT_RELAY_CODEX_BIN`, `AGENT_RELAY_CLAUDE_BIN`, `AGENT_RELAY_OPENCODE_BIN`, or
`AGENT_RELAY_AGY_BIN` to its absolute path in your shell startup file.

### 3. Dashboard, manually

`relay install` offers to start the dashboard for you. To control it directly
instead:

**Persistent Docker dashboard** (survives closing the terminal, restarts with
Docker):

```bash
cd "$HOME/agent-relay"   # or wherever you cloned/installed it
cp docker-compose.sample.yml docker-compose.yml
mkdir -p data logs
```

Edit `docker-compose.yml`: use `"127.0.0.1:4242:4242"` as the port mapping for
local access. Uncomment only provider mounts you use, for example
`- ${HOME}/.codex:/codex_data:ro`. Confirm source directories exist. Mounts enable
session history and available token/cost details; basic relay logs work without
them. The dashboard has no login; keep sensitive logs and sessions local.

```bash
docker compose up -d --build
docker compose ps
relay dashboard
```

Open **http://localhost:4242**. `relay dashboard` checks HTTP availability; it
does not launch the server.

**Foreground Node dashboard** (no Docker, stops when you close the terminal):

```bash
HOST=127.0.0.1 agent-dashboard
```

Open the same URL. Ctrl+C stops it; run the command again to restart. No
dependency installation needed. Don't run both options on the same port.

### 4. Workspaces and shared paths (optional)

Skip this unless you work across several repositories and want short aliases
instead of typing full paths.

```bash
relay init
relay workspaces
```

Init scans `~/Code` and asks before writing aliases to
`~/.config/agent-relay/workspaces.json`. For a different root, use
`AGENT_RELAY_CODE_ROOT="/absolute/path/to/repos" relay init`. Existing config is
not overwritten; edit it directly. Aliases are optional: relay uses your current
repository directory when none is supplied.

Wrappers and the Node dashboard default to this checkout's `logs/` and
`data/subagents.db`. Docker mounts those same directories. Back up both.
If overriding `AGENT_RELAY_LOG_DIR` or `AGENT_RELAY_DATA_DIR`, apply the same
host paths to all relay processes and the Node dashboard, and adjust Docker's
host mount paths too. Host exports alone do not change container mounts.

To share workspace aliases with Docker, mount the config file read-only and
set `AGENT_RELAY_WORKSPACES_CONFIG` to its container path. Keep repository paths
inside that file as host paths for grouping runs.

### 5. Confirm it's really working

```bash
cd "/absolute/path/to/your/repository"
relay codex "Describe this repository in one sentence. Do not edit files or run commands that modify it."
relay result --last
```

Replace `codex` with your authenticated provider. This is a real model call;
the no-edit request is an instruction, not an enforced security sandbox.
Confirm the banner prints a log path under `~/agent-relay/logs`. Refresh the
dashboard (if running): the task should appear with the correct provider and
workspace. Open its result and inspect `accepted`, summary, verification,
blockers, and incomplete work. Zero exit code alone does not prove acceptance.
An empty dashboard before your first run is normal.

### 6. Optional harness integration

For task-based model selection, see [Task routing](../README.md#task-routing).
`relay config init` creates a repository rules file; `relay config init --global`
creates a personal fallback if `relay install` has not already created one.
Edit the generated provider and model choices before using them.

`relay install` and `relay mcp install` already wire the MCP server into
detected harness configs. For native plugin packages instead (Claude Code,
Codex, Antigravity, OpenCode), follow the [plugin guide](PLUGINS.md). Restart
your harness after either path and confirm `run_agent` and `get_run_result`
appear. Shell usage does not require MCP. Avoid registering the same server
through both a plugin and manual configuration.

### 7. Maintenance and removal

Docker commands run from the install directory:

```bash
docker compose stop
docker compose up -d
docker compose logs --tail=50 agent-dashboard
```

To update an npm install: `npm install -g @akashpandey/agent-relay@latest`,
then rerun `relay install` and restart the dashboard and harnesses. To update
a Git checkout:

```bash
cd "$HOME/agent-relay"
git pull --ff-only
./install-skill
docker compose build agent-dashboard
docker compose up -d --no-build --force-recreate agent-dashboard
relay dashboard
```

Resolve local changes if Git refuses the pull. Review sample Compose changes
without overwriting your customized file. Build completes before replacement.
Back up configuration, logs, and data before updating either way.

To uninstall, stop active tasks and run `docker compose down` (or Ctrl+C for
the foreground dashboard). Remove only `~/.local/bin` symlinks pointing into
this checkout and skill links printed by the installer. Uninstall plugins and
remove relay MCP entries, then restart harnesses. Remove workspace config if
unwanted. Save wanted logs/data before deleting the checkout; Compose down
preserves these folders.

## Troubleshooting

| Symptom | Check |
|---|---|
| Command missing | Check PATH, reopen the terminal, and rerun `relay install` (or the installer) if links are missing. |
| Provider/login failure | Run it directly; check authentication, PATH, and executable overrides. |
| SQLite startup failure | Check host Node version; use Node 24+. |
| Docker permission/connection error | Make `docker info` succeed; check daemon and WSL integration. |
| Dashboard unavailable | Check Compose status/logs or the Node terminal; ensure port 4242 is free. |
| Task absent | Compare its printed log path with dashboard mounts and data overrides. |
| Session details/costs absent | Check provider mounts; not every provider records every metric. |
| Empty summary/verification | Inspect logs and result; missing outcome contracts mean unverified work. |
| MCP tools absent | Restart the harness and check its configured executable path. |
| Doctor reports missing hooks | Doctor checks a specific Docker/post-commit-hook setup. Hooks are optional; use `relay dashboard` and the first-task check for this guide. |

More delegation and takeover examples are in the [README](../README.md).
