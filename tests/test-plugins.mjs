import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import openCodePlugin from '../plugins/opencode/agent-relay.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

test('packaged plugin skill exactly matches the canonical skill directory', () => {
  const source = path.join(root, 'skills/agent-relay');
  const destination = path.join(root, 'plugins/agent-relay/skills/agent-relay');
  assert.ok(fs.existsSync(destination), 'Plugin skill directory missing. Run npm run sync:skills');
  const files = directory => fs.readdirSync(directory, { recursive: true })
    .filter(file => fs.statSync(path.join(directory, file)).isFile()).sort();
  const expected = files(source);
  assert.deepEqual(files(destination), expected, 'Run npm run sync:skills');
  for (const file of expected) {
    assert.equal(fs.readFileSync(path.join(destination, file), 'utf8'),
      fs.readFileSync(path.join(source, file), 'utf8'), `Skill drift in ${file}; run npm run sync:skills`);
  }
});

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
    ['-c', 'if [ -x "$HOME/.local/bin/agent-relay-mcp" ]; then exec "$HOME/.local/bin/agent-relay-mcp"; else exec npx -y @akashpandey/agent-relay agent-relay-mcp; fi']);
  assert.ok(fs.existsSync(path.join(root, codex.mcpServers.replace('./', 'plugins/agent-relay/'))));
  assert.ok(fs.existsSync(path.join(root, claude.hooks.replace('./', 'plugins/agent-relay/'))));
  assert.ok(fs.existsSync(path.join(root, codex.hooks.replace('./', 'plugins/agent-relay/'))));
});

test('OpenCode v2 plugin exposes an id and appends acceptance guidance to the system prompt', async () => {
  assert.equal(openCodePlugin.id, 'agent-relay');
  const hooks = {};
  await openCodePlugin.setup({ session: { hook: async (name, fn) => { hooks[name] = fn; } } });
  const event = { system: [{ type: 'text', text: 'existing instructions' }] };
  await hooks.context(event);
  assert.equal(event.system[0].text, 'existing instructions');
  assert.match(event.system[1].text, /Check accepted, blockers, incomplete work/);
});
