# Install agent-relay and its dashboard

## Quickstart

Two commands, if you already have Node.js 24+ and at least one of Claude
Code, Codex, OpenCode, or the Antigravity CLI (`agy`) installed and
authenticated:

```bash
npm install -g @akashpandey/agent-relay
relay install
```

What each line does:

1. **`npm install -g @akashpandey/agent-relay`** — installs the CLI binaries
   (`relay`, `agent`, `claude-agent`, `antigravity-agent`, etc.).
2. **`relay install`** — sets up the shared skill and command symlinks,
   detects which of the four provider CLIs you have on `PATH`, registers
   agent-relay's MCP server with each one it finds, asks whether to also add
   a one-line Claude Code SessionStart hook (opt-in, always asks first, never
   silent), and offers to start the dashboard (Docker if available, otherwise
   a plain foreground process) so you can watch task progress at
   `http://localhost:4242`. It prints a summary per provider, e.g.:

   ```text
   claude: skill+bin ok, mcp registered
   codex: skill+bin ok, mcp registered
   opencode: not found on PATH, skipped
   agy: not found on PATH, skipped
   hooks (Claude Code): registered

   Next steps:
     relay claude "Describe this repository in one sentence."
   ```

   Only providers actually found get configured; nothing else changes.

That's it — setup is done. **Now go to whichever harness `relay install`
configured (Claude Code, Codex, OpenCode, or Antigravity) and just talk to
it.** Ask it in plain language to delegate, review, or hand off a task to
another model, for example:

> Use agent-relay to have Codex describe this repository in one sentence.
> Don't edit any files.

Your assistant calls agent-relay's skill/MCP tool for you — you never leave
that conversation, and you never had to open a second terminal. A minute or
two later it'll come back with a real result: pass, fail, or blocked, not
just "done."

Prefer typing the command yourself, or driving this from a script or CI
instead of a harness conversation? The "Next steps" line `relay install`
printed works directly in a terminal too — swap `claude` for whichever
provider you have. See [Usage](../README.md#usage) in the README for the
full direct/scripting command surface.

That's the whole path for a single-provider, single-repo setup. Everything
below is for cases the quickstart doesn't cover: installing from a Git
checkout instead of npm, running several provider CLIs, persistent Docker
hosting for the dashboard, shared workspace aliases across repos, and
troubleshooting.

## Full setup and reference

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
