// Native OpenCode plugin. Execution stays in the installed CLI/MCP server.
import os from "node:os";
import path from "node:path";

export const AgentRelayPlugin = async () => ({
  config: async (config) => {
    config.mcp ??= {};
    config.mcp["agent-relay"] ??= {
      type: "local",
      command: [path.join(os.homedir(), ".local/bin/agent-relay-mcp")],
      enabled: true,
    };
  },
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push(
      "Agent Relay is available through the installed relay CLI and optional " +
      "agent-relay MCP tools. Delegate only bounded tasks with explicit workspace, " +
      "file ownership, and verification. Prefer run_agent/get_run_result/wait_for_run " +
      "when available; otherwise run relay <provider> <task> in the target repository " +
      "and relay result --last. Providers: codex, claude, opencode, antigravity. " +
      "Check accepted, blockers, incomplete work, and verification; exit code alone " +
      "does not prove success. Use relay continue for related work and relay takeover " +
      "to switch providers. Do not commit or deploy without authorization. " +
      "Dashboard: http://localhost:4242; relay dashboard checks availability."
    );
  },
});
