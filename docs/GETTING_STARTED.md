# Getting Started with agent-relay

Welcome to **agent-relay**! This guide gets you from zero to orchestrating local coding agents (Claude Code, OpenAI Codex, OpenCode, and Antigravity) in under 5 minutes.

---

## 1. Prerequisites

- **Node.js**: Version 22.5.0 or higher (uses native `node:sqlite`).
- **One or more AI coding agent CLIs installed**:
  - [Claude Code](https://claude.ai/code): `claude`
  - [OpenAI Codex CLI](https://github.com/openai/codex): `codex`
  - [OpenCode](https://opencode.ai): `opencode`
  - [Antigravity / Gemini CLI](https://cloud.google.com): `agy`

---

## 2. Installation

Clone the repository and install the shared skill and CLI symlinks:

```bash
git clone https://github.com/akashpandey/agent-relay.git
cd agent-relay

# Links relay, agent, and wrapper binaries into ~/.local/bin
./install-skill
```

Ensure `~/.local/bin` is in your `PATH`:
```bash
export PATH="$HOME/.local/bin:$PATH"
```

*(Alternatively, if installing via npm: `npm install -g agent-relay`)*

---

## 3. Quick Setup

### Step 3.1: Discover Your Workspaces
Run the interactive workspace setup to scan your repositories (default: `~/Code`):

```bash
relay init
```

This generates `~/.config/agent-relay/workspaces.json`, allowing you to reference projects by canonical names (e.g. `relay my-app opencode "fix bug"`).

### Step 3.2: Connect Your AI Harnesses (MCP)
To enable Claude Code, Codex, Antigravity, and OpenCode to call each other natively through MCP:

```bash
relay mcp install
```

This auto-detects installed coding tools and registers the `agent-relay` MCP server in:
- Claude Code (`~/.claude.json`)
- OpenCode (`~/.config/opencode/opencode.json`)
- Antigravity CLI (`~/.gemini/antigravity-cli/mcp_config.json`)
- OpenAI Codex CLI (`~/.codex/config.toml`)

---

## 4. Usage Patterns

### A. Direct Terminal Delegation
Run tasks against the current directory or a named workspace:

```bash
# Run a task using Claude Code
relay claude "Write unit tests for auth middleware"

# Run a task using OpenCode in a named workspace
relay my-project opencode "Refactor database migrations"

# Run with dynamic model family aliases
CODEX_MODEL='latest' relay codex "Review recent git diff"
```

### B. Structured MCP Tool Calls
Inside any AI coding session (e.g., Claude Code or Codex), the model can call `agent-relay` MCP tools:

- `run_agent`: Delegate tasks directly (`provider`, `prompt`, `workspace`, `model`, `wait`).
- `list_models`: Check which models and dynamic aliases are available on this host.
- `list_runs`: Query previous runs, filter by status, outcome, or workspace.
- `get_run_result`: Retrieve the machine-readable acceptance contract for a run.
- `takeover_run`: Transfer a task and context to another harness.
- `kill_run`: Terminate a runaway agent process tree.

### C. Cross-Harness Relay Takeover (Token / Quota Exhaustion)
Hit a rate limit or context ceiling in Claude Code? Transfer the baton to Codex without losing progress:

```bash
relay takeover codex "Finish the remaining unit tests and verify build"
```

The handoff engine automatically:
1. Inspects the active session logs and user goal.
2. Extracts touched files and the last assistant reasoning.
3. Captures uncommitted workspace changes (`git status` and `git diff`).
4. Synthesizes a structured baton-pass prompt for the target agent.

---

## 5. Web Dashboard (Real-Time Monitor)

Launch the visualizer dashboard to track live runs, inspect diffs, token counts, and costs:

```bash
# Start dashboard via docker
cp docker-compose.sample.yml docker-compose.yml
docker compose up -d

# Or run directly with Node:
npm run dashboard
```

Open **`http://localhost:4242`** in your browser.

---

## 6. Health Check

Verify your setup at any time with:

```bash
relay doctor
```
