# Interactive plugin loading verification

Verified on this Linux host on 2026-09-18 with the local, unpublished checkout.
Each harness was started in an actual terminal session, without a model prompt.

| Harness | Version | Evidence |
|---|---|---|
| Claude Code | 2.1.276 | Started with `--plugin-dir plugins/agent-relay`. Debug log loaded the bundle's skills directory and connected `plugin:agent-relay:agent-relay` over stdio. `/mcp` showed that plugin server connected with 13 tools. Slash completion showed `/agent-relay:agent-relay`. |
| Codex | 0.154.0 | Added the local marketplace and installed `agent-relay@agent-relay` 1.0.0. A fresh interactive session showed the namespaced plugin skill through `$agent-relay` completion. `/mcp` showed the plugin's `agent-relay` server connected with 13 tools, separately from the existing manual `agent_relay` server. |
| Antigravity CLI | 1.2.5 | `agy plugin install` processed one skill and one MCP server. `agy plugin list` recorded the imported bundle. The staged skill matched the repository file byte for byte. Interactive `/mcp` showed plugin server `agent-relay` connected with `run_agent`, `list_workspaces`, `list_runs`, `get_run_result`, `wait_for_run`, and eight more tools. Skill completion was also available, although this host's preexisting standalone skill used the same name. |
| OpenCode | 1.18.31 | Installed the native JavaScript plugin link. Fresh interactive startup succeeded. Resolved configuration included `file:///home/akey/.config/opencode/plugins/agent-relay.js`; `/mcps` showed `agent-relay` connected and enabled. This host already had a relay MCP entry, which the plugin preserved. |

Claude's startup log additionally recorded zero plugin-loading errors.
Its plugin MCP connection negotiated protocol `2025-11-25` with relay 1.0.0.

The temporary Codex marketplace/plugin, Antigravity bundle, and OpenCode plugin
link were removed after verification. Existing manual MCP registrations and
standalone skills were retained. All verification terminal sessions were closed.

## Real model turns and release archive

Additional checks used real provider model turns in each harness's batch mode,
after the interactive loading checks above:

| Harness | Actual tool evidence |
|---|---|
| Claude Code | `mcp__plugin_agent-relay_agent-relay__list_workspaces` completed successfully; the returned JSON contained eight workspaces. |
| Codex | With manual server `agent_relay` disabled for this invocation, plugin server `agent-relay` completed `list_workspaces`. Its JSON contained eight workspaces; the model's final summary incorrectly claimed one. |
| Antigravity | Plugin-namespaced `agent-relay_agent-relay` completed `list_workspaces` and returned eight workspaces. An earlier forced call using unprefixed `agent-relay` failed despite its interactive display name. The model marked that failed attempt successful; it was rejected and rerun with the actual identifier. |
| OpenCode | `agent-relay_list_workspaces` completed and returned eight workspaces. A separate turn echoed an unpredictable nonce injected only through the native system-prompt hook, proving that hook executes during a real model request. The temporary nonce was then removed. |

The tests requested read-only workspace listing, not delegated execution. No
worker agents were launched, and no repository edits were requested from the
harnesses. Antigravity also read its local tool schema to discover the tool.

The npm archive was installed in a fresh, network-isolated Node 22.23.2 Docker
container without host credentials. This exposed npm's omission of the `relay`
symlink; the installer now links `relay` to the packaged `agent` entrypoint when
needed. The repeatable `npm run test:package` check verifies command installation,
MCP initialization, and dashboard HTTP from the packed archive.

These checks verify real model/tool round trips and OpenCode prompt injection,
but not delegated provider task execution or delegated-result acceptance.
The plugin files have since been pushed in `488d322`; remote marketplace
installation still needs a separate check. Windows/WSL2/macOS behavior is
also outside this host verification. The repository is now public, and npm
`1.0.0` installation by package name passed CLI, MCP, and dashboard checks in a
fresh Node 22 container. No GitHub releases exist yet; see [release steps](RELEASES.md).

Final checks: 36/36 Node tests passed when run alone, 16/16 wrapper checks
passed, and the clean archive installation/dashboard check passed. One
cancellation test timed out in the earlier concurrent-suite run; the standalone
rerun passed. Release checks are documented sequentially for that reason.
