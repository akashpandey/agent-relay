import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { parseLogMetadata } from '../dashboard/parser.js';

const root = path.resolve(import.meta.dirname, '..');
const result = { outcome: 'done', summary: 'Verified {literal} braces', changedFiles: [],
  verification: [{ command: 'check', status: 'passed' }], blockers: [], incomplete: [], nextSteps: [] };

test('sentinel persists final result and parser preserves exit code without history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-done-'));
  try {
    const log = path.join(dir, '20260917T100000-codex-99999999.log');
    const event = { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } };
    fs.writeFileSync(log, `Task: ${JSON.stringify({ ...result, summary: 'prompt example' })}\n---\n${JSON.stringify(event)}\n${'noise\n'.repeat(6000)}`);
    const written = spawnSync(process.execPath, [root + '/scripts/write-done.mjs', log, 'codex', dir, 'test', 'new', '0']);
    assert.equal(written.status, 0, written.stderr.toString());
    const done = JSON.parse(fs.readFileSync(log.replace('.log', '.done')));
    assert.equal(done.result.summary, result.summary);
    assert.equal(done.result.verification[0].status, 'passed');
    const parsed = parseLogMetadata(path.basename(log), log, dir);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.result.summary, result.summary);
    fs.writeFileSync(log, 'header\n---\nprovider exited without a final response\n');
    spawnSync(process.execPath, [root + '/scripts/write-done.mjs', log, 'codex', dir, 'test', 'new', '0']);
    const missing = JSON.parse(fs.readFileSync(log.replace('.log', '.done')));
    assert.equal(missing.result.outcome, 'unknown');
    assert.equal(missing.result.attentionRequired, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every wrapper writes a failed sentinel on TERM', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-signal-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'provider'), '#!/bin/sh\nprintf "ready\\n"\nsleep 60\n', { mode: 0o755 });
  try {
    for (const [provider, variable] of [['codex', 'CODEX'], ['claude', 'CLAUDE'], ['opencode', 'OPENCODE'], ['antigravity', 'AGY']]) {
      const logs = path.join(dir, provider);
      fs.mkdirSync(logs);
      const child = spawn(root + '/' + provider + '-agent', ['--workspace', dir, 'test'], {
        env: { ...process.env, PATH: bin + ':' + process.env.PATH,
          [`AGENT_RELAY_${variable}_BIN`]: path.join(bin, 'provider'),
          AGENT_RELAY_LOG_DIR: logs, AGENT_RELAY_DB_PATH: path.join(dir, 'db.sqlite') },
        stdio: 'ignore',
      });
      const exited = once(child, 'exit');
      try {
        let ready = false;
        for (let i = 0; i < 100; i++) {
          const log = fs.readdirSync(logs).find(f => f.endsWith('.log'));
          if (log && fs.readFileSync(path.join(logs, log), 'utf8').includes('\nready\n')) { ready = true; break; }
          if (child.exitCode !== null) break;
          await delay(50);
        }
        assert.equal(ready, true, `${provider} did not launch`);
        child.kill('SIGTERM');
        await exited;
        const done = fs.readdirSync(logs).find(f => f.endsWith('.done'));
        assert.ok(done, `${provider} missing sentinel`);
        const payload = JSON.parse(fs.readFileSync(path.join(logs, done)));
        assert.equal(payload.exitCode, 143);
        assert.equal(payload.result.outcome, 'failed');
      } finally { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
