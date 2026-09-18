# Install agent-relay and its dashboard

Install the CLI on your host and a persistent dashboard in Docker. Provider
agents run on the host; the container monitors runs. You need one authenticated
provider. [Harness plugins](PLUGINS.md) are optional.

## 1. Prerequisites

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
  [Docker Desktop with WSL integration](https://docs.docker.com/desktop/features/wsl/).
  Skip Docker for the foreground Node option below.
- Install and authenticate [Codex](https://github.com/openai/codex),
  [Claude Code](https://code.claude.com/docs/en/setup), or
  [OpenCode](https://opencode.ai/docs/) using its setup guide. Open it directly
  and confirm it can answer a prompt. Antigravity requires the
  [Antigravity CLI](https://antigravity.google/docs/cli/) executable `agy`;
  the editor or generic Gemini CLI alone is insufficient.

Check readiness (replace `codex` with your provider; omit Docker checks for Node):

```bash
node --version
git --version
command -v codex
docker info
docker compose version
```

Provider charges and quotas apply; relay does not supply models or credentials.

## 2. Install commands and skills

```bash
git clone https://github.com/akashpandey/agent-relay.git "$HOME/agent-relay"
cd "$HOME/agent-relay"
./install-skill
export PATH="$HOME/.local/bin:$PATH"
relay --help
```

Add the PATH export once to `~/.bashrc` (Bash) or `~/.zshrc` (Zsh). Open a new
terminal and confirm `command -v relay` works. No sudo or npm install is needed.
Keep the checkout: commands and skills are symlinks into it. The installer
replaces existing `agent-relay` skill directories; preserve custom copies first.
This guide uses source installation rather than assuming an npm publication.

### npm installation

The npm package is `@akashpandey/agent-relay`. The unscoped `agent-relay` package
is a different project. Use a writable npm global prefix (for example, through
a Node version manager):

```bash
npm install -g @akashpandey/agent-relay
cd "$(npm root -g)/@akashpandey/agent-relay"
./install-skill
export PATH="$HOME/.local/bin:$PATH"
relay --help
```

Continue with the dashboard steps below from that package directory. Update with
`npm install -g @akashpandey/agent-relay@latest`, then rerun `./install-skill`
and restart the dashboard and harnesses. Back up configuration, logs, and data
before updating; npm may replace files inside the installed package directory.

Wrappers find providers through PATH. For unusual executable locations, set
`AGENT_RELAY_CODEX_BIN`, `AGENT_RELAY_CLAUDE_BIN`, `AGENT_RELAY_OPENCODE_BIN`, or
`AGENT_RELAY_AGY_BIN` to its absolute path in your shell startup file.

## 3. Start the dashboard

### Recommended: persistent Docker dashboard

```bash
cd "$HOME/agent-relay"
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

Open **http://localhost:4242**. The container survives closing the terminal and
restarts with Docker unless explicitly stopped. `relay dashboard` checks HTTP
availability; it does not launch the server.

### Alternative: foreground Node dashboard

In a separate terminal:

```bash
HOST=127.0.0.1 agent-dashboard
```

Open the same URL. Keep this terminal open; Ctrl+C stops it. Run the command
again to restart. No dependency installation is needed. Do not start both
options on the same port.

## 4. Workspaces and shared paths

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

## 5. Verify your first task

In another terminal, use a trusted Git repository:

```bash
cd "/absolute/path/to/your/repository"
relay codex "Describe this repository in one sentence. Do not edit files or run commands that modify it."
relay result --last
```

Replace `codex` with your authenticated provider. This is a real model call;
the no-edit request is an instruction, not an enforced security sandbox.
Confirm the banner prints a log path under `~/agent-relay/logs`. Refresh the
dashboard: the task should appear with the correct provider and workspace.
Open its result and inspect `accepted`, summary, verification, blockers, and
incomplete work. Zero exit code alone does not prove acceptance. An empty
dashboard before your first run is normal.

## 6. Optional harness integration

Follow the [plugin guide](PLUGINS.md) for native packages. Alternatively, back
up harness configs and run `relay mcp install`. It writes Claude config and
updates OpenCode, Codex, and Antigravity configs when their expected directories
exist. Restart your harness and confirm `run_agent` and `get_run_result` appear.
Shell usage does not require MCP. Avoid registering the same server through
both a plugin and manual configuration.

## 7. Maintenance and removal

Docker commands run from `~/agent-relay`:

```bash
docker compose stop
docker compose up -d
docker compose logs --tail=50 agent-dashboard
```

To update, stop active tasks and back up logs, data, and configuration:

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
For Node, omit Docker commands and restart the foreground server. Restart MCP
harnesses and update installed plugins as described in their guide.

To uninstall, stop active tasks and run `docker compose down` (or Ctrl+C for
Node). Remove only `~/.local/bin` symlinks pointing into this checkout and skill
links printed by the installer. Uninstall plugins and remove relay MCP entries,
then restart harnesses. Remove workspace config if unwanted. Save wanted
logs/data before deleting the checkout; Compose down preserves these folders.

## Troubleshooting

| Symptom | Check |
|---|---|
| Command missing | Check PATH, reopen the terminal, and rerun the installer if links are missing. |
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
