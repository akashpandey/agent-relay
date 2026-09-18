import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('dashboard restart builds before replacement and leaves the service alone on build failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-restart-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
for arg in "$@"; do
  if [ "$arg" = build ]; then exit "$BUILD_EXIT"; fi
done
`, { mode: 0o755 });
    for (const buildExit of [42, 0]) {
      const composeDir = path.join(dir, 'compose-' + buildExit);
      const calls = path.join(dir, 'calls-' + buildExit);
      const run = spawnSync(root + '/scripts/restart-dashboard', [], {
        env: { ...process.env, PATH: bin + ':' + process.env.PATH,
          AGENT_RELAY_DOCKER_DIR: composeDir, AGENT_RELAY_DOCKER_SERVICE: 'agent-dashboard',
          AGENT_RELAY_DOCKER_PROJECT: 'agent-relay', CALLS: calls, BUILD_EXIT: String(buildExit) },
        encoding: 'utf8',
      });
      assert.equal(run.status, buildExit, run.stderr);
      const commands = fs.readFileSync(calls, 'utf8').trim().split('\n');
      assert.equal(commands.length, buildExit ? 1 : 2);
      assert.match(commands[0], / build agent-dashboard$/);
      if (!buildExit) assert.match(commands[1], / up -d --no-build --force-recreate agent-dashboard$/);
      assert.ok(commands.every(command => !/\b(stop|down)\b/.test(command)));
      assert.equal(fs.existsSync(path.join(composeDir, 'restart.lock')), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
