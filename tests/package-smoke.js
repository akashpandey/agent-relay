// Run with npm run test:package; Docker isolates installer links and runtime data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--inside')) {
  const bin = path.join(os.homedir(), '.local/bin');
  execFileSync(path.join(bin, 'relay'), ['--help'], { stdio: 'ignore' });
  const response = execFileSync(path.join(bin, 'agent-relay-mcp'), [], {
    encoding: 'utf8', timeout: 5000,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n',
  });
  assert.equal(JSON.parse(response.trim()).result.serverInfo.name, 'agent-relay');
  const server = spawn(path.join(bin, 'agent-dashboard'), [], {
    env: { ...process.env, HOST: '127.0.0.1' }, stdio: 'ignore',
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const res = await fetch('http://127.0.0.1:4242/api/stats', {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'installed dashboard must serve HTTP');
    console.log('Package install, relay command, MCP handshake, and dashboard HTTP passed');
  } finally {
    server.kill('SIGTERM');
  }
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-relay-package-'));
  try {
    execFileSync('npm', ['pack', '--silent', '--pack-destination', temporary], {
      cwd: root, stdio: 'ignore',
    });
    const archive = fs.readdirSync(temporary).find(file => file.endsWith('.tgz'));
    assert.ok(archive, 'npm pack must produce an archive');
    execFileSync('tar', ['-xzf', path.join(temporary, archive), '-C', temporary]);
    execFileSync('docker', [
      'run', '--rm', '--network', 'none',
      '--mount', `type=bind,source=${path.join(temporary, 'package')},target=/package,readonly`,
      '--mount', `type=bind,source=${fileURLToPath(import.meta.url)},target=/package-smoke.mjs,readonly`,
      '--entrypoint', 'sh', process.env.AGENT_RELAY_TEST_IMAGE || 'node:22-slim', '-c',
      'cp -a /package /root/agent-relay && cd /root/agent-relay && ./install-skill >/dev/null && node /package-smoke.mjs --inside',
    ], { stdio: 'inherit', timeout: 60000 });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
