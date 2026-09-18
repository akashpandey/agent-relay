import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentRelayPlugin } from '../plugins/opencode/agent-relay.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

test('native plugin bundles point to real skills and the installed host server', () => {
  for (const marketplace of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) {
    const entry = json(marketplace).plugins[0];
    const source = typeof entry.source === 'string' ? entry.source : entry.source.path;
    assert.ok(fs.existsSync(path.join(root, source, 'skills/agent-relay/SKILL.md')));
  }
  for (const manifest of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'plugin.json']) {
    assert.equal(json(`plugins/agent-relay/${manifest}`).name, 'agent-relay');
  }
  const claude = json('plugins/agent-relay/.claude-plugin/plugin.json');
  const codex = json('plugins/agent-relay/.codex-plugin/plugin.json');
  assert.equal(claude.version, json('package.json').version);
  assert.equal(codex.version, claude.version);
  const mcp = json('plugins/agent-relay/.mcp.json');
  assert.deepEqual(json('plugins/agent-relay/mcp_config.json'), mcp);
  assert.equal(mcp.mcpServers['agent-relay'].command, 'sh');
  assert.deepEqual(mcp.mcpServers['agent-relay'].args,
    ['-c', 'exec "$HOME/.local/bin/agent-relay-mcp"']);
  assert.ok(fs.existsSync(path.join(root, codex.mcpServers.replace('./', 'plugins/agent-relay/'))));
});

test('OpenCode registers MCP, preserves user configuration, and adds acceptance guidance', async () => {
  const hooks = await AgentRelayPlugin();
  const config = { mcp: { other: { enabled: true } } };
  await hooks.config(config);
  assert.deepEqual(config.mcp['agent-relay'], {
    type: 'local', command: [path.join(os.homedir(), '.local/bin/agent-relay-mcp')], enabled: true,
  });
  assert.equal(config.mcp.other.enabled, true);
  const custom = { enabled: false, command: ['/custom/server'] };
  config.mcp['agent-relay'] = custom;
  await hooks.config(config);
  assert.equal(config.mcp['agent-relay'], custom);
  const output = { system: ['existing instructions'] };
  await hooks['experimental.chat.system.transform']({}, output);
  assert.equal(output.system[0], 'existing instructions');
  assert.match(output.system[1], /Check accepted, blockers, incomplete work/);
});
