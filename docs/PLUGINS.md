# Harness plugins

The repository includes native integrations for Claude Code, Codex,
Antigravity CLI (`agy`), and OpenCode. First complete the
[host installation and dashboard setup](GETTING_STARTED.md). Plugins provide
delegation instructions and MCP access; they do not install Node, authenticate
providers, or launch the dashboard. Keep `~/.local/bin/agent-relay-mcp` installed.

The Claude/Codex/Antigravity bundle is `plugins/agent-relay`; OpenCode uses
`plugins/opencode/agent-relay.js`. All launch the host server so logs and data
stay in the installed relay checkout, outside harness plugin caches.

The plugin files and catalogs are pushed to the repository. Remote installation
requires repository access while it remains private. Local checkout commands
below are also available; remote marketplace installation is still unverified.

## Claude Code

Install the local marketplace and plugin:

```bash
claude plugin marketplace add "$HOME/agent-relay"
claude plugin install agent-relay@agent-relay
claude plugin list
```

After publication, the marketplace source can instead be
`akashpandey/agent-relay`. For a temporary local test, use
`claude --plugin-dir "$HOME/agent-relay/plugins/agent-relay"`.

The bundle follows [Claude's plugin format](https://code.claude.com/docs/en/plugins-reference)
and includes its skill and `.mcp.json`. Restart Claude; confirm
`/agent-relay:agent-relay` and relay MCP tools are available.

## Codex

Requires a Codex version with `codex plugin` support. Check `codex plugin --help`.
Register this repository's marketplace explicitly:

```bash
codex plugin marketplace add "$HOME/agent-relay"
codex plugin add agent-relay@agent-relay
codex plugin list
```

After publication, `codex plugin marketplace add akashpandey/agent-relay` is
the remote equivalent. The `.codex-plugin/plugin.json` declares the skill and
MCP companion file. Restart Codex or open a new session and confirm the skill
and relay tools are loaded. Older Codex installations can use
`relay mcp install` and the installed shared skill instead.

## Antigravity CLI

This targets `agy`, not the Antigravity editor's extension marketplace:

```bash
agy plugin install "$HOME/agent-relay/plugins/agent-relay"
agy plugin list
```

The bundle follows [Antigravity's CLI plugin format](https://antigravity.google/docs/cli/plugins.md):
root `plugin.json`, `mcp_config.json`, and `skills/`. Restart the CLI and confirm
the skill and relay MCP tools load. Use the installed CLI's `agy plugin` commands
to manage the bundle; do not assume Claude marketplace commands work here.
The staging directory is version-dependent: CLI 1.2.5 on this host used
`~/.gemini/config/plugins/agent-relay`, rather than the older documented
`~/.gemini/antigravity-cli/plugins/` path. Use the plugin manager, not manual
directory copying.
For model tool calls, Antigravity names the server `agent-relay_agent-relay`
(plugin name plus MCP server name), even though `/mcp` displays `agent-relay`.
Use the discovered tool identifier rather than forcing the display name.

## OpenCode

Install the native JavaScript plugin globally:

```bash
mkdir -p "$HOME/.config/opencode/plugins"
ln -s "$HOME/agent-relay/plugins/opencode/agent-relay.js" "$HOME/.config/opencode/plugins/agent-relay.js"
```

If that target already exists, inspect it before replacing it. For project-only
installation, put the link in the repository's `.opencode/plugins/` instead;
do not install both. Restart OpenCode.

The [native plugin](https://opencode.ai/docs/plugins/) adds delegation guidance
through the system-prompt hook and registers the host MCP server through the
config hook. Existing `agent-relay` MCP settings are preserved. There is no new
npm dependency and no assumed published npm plugin. Confirm relay MCP tools
appear; the shared skill from `./install-skill` remains available too.

## Verify, update, and remove

Ask the harness to list workspaces using relay's `list_workspaces` tool, then
delegate the small first task in the getting-started guide. Verify the result
and its dashboard entry. Loading a skill alone does not prove provider login
or execution works. Use trusted workspaces; these plugins are not a sandbox.

If you previously ran `relay mcp install`, remove redundant relay server entries
from the relevant harness config before enabling a bundled MCP server. Back up
configs and preserve other servers. Standalone and plugin skills can also appear
twice; remove only the standalone skill link for a harness if you prefer its
plugin copy.

After updating the checkout, refresh marketplace plugins with the harness's
plugin manager. For Claude use `claude plugin marketplace update agent-relay`
then `claude plugin update agent-relay@agent-relay`. For a Git Codex marketplace,
use `codex plugin marketplace upgrade agent-relay`; local marketplaces read
the checkout directly. Remove/add the Codex plugin if its version is cached.
Reinstall the local Antigravity bundle. OpenCode's
symlink uses the updated source. Restart each harness after changes.

### Updating skill instructions

`skills/agent-relay/` is the canonical source for both standalone and bundled
skills, including companion files such as `agents/openai.yaml`. Edit that
directory only. `plugins/agent-relay/skills/agent-relay/` is generated:

```bash
npm run sync:skills
node --test tests/test-plugins.mjs
```

Commit the source and generated copy together so Git marketplaces receive the
same instructions. CI rejects mismatched files. `npm pack` also synchronizes
the copy automatically through `prepack`; npm publication is not required.

Standalone installations use symlinks, so changes reach the installed files as
soon as the checkout is updated. A harness may already have read the old skill
into its session: start a new session or restart it to reliably load the update.
Existing conversation context is not rewritten by changing a file.

Installed marketplace plugins usually contain cached copies. A checkout update
alone does not refresh those copies. Publish a new plugin version, refresh the
marketplace, update/reinstall the plugin, and restart the harness. Antigravity's
local bundle must likewise be reinstalled. Claude's temporary `--plugin-dir`
loading reads the checkout on the next session. OpenCode's plugin and standalone
skill links read the updated checkout on restart.

For a published skill change, bump `package.json`, both versioned plugin
manifests, and the Claude marketplace entry together before release. Version
bumps let caches distinguish updates; resynchronizing instructions alone does
not force already installed plugins to reload. Skill-only updates change
instructions, not provider credentials, run history, or the dashboard database.

To remove:

```bash
claude plugin uninstall agent-relay@agent-relay
codex plugin remove agent-relay@agent-relay
agy plugin uninstall agent-relay
```

For OpenCode, remove only the plugin link you created and restart. Remove any
manually configured MCP entry separately. Removing plugins leaves the host CLI,
dashboard, logs, and database intact. See the installation guide to remove them.

Manifests, packaged files, and OpenCode hooks pass automated validation.
[Interactive loading was verified](PLUGIN_VERIFICATION.md) in all four installed
harnesses on Linux, including real model calls to the workspace-listing tool
and OpenCode system-prompt injection. Delegated task execution and WSL2 behavior
still require verification on your machine. See [GitHub release steps](RELEASES.md)
for publishing a versioned release of the bundles.
