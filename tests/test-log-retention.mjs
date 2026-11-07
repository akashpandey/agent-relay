// Log retention helper: raw logs age out opt-in, SQLite history stays.
// Runs fixtures in spawned processes so the dashboard/db.js env vars
// (read at import time) point at a temporary database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function spawnWithDb(logs, fixtureBody) {
  const dir = path.dirname(logs);
  fs.mkdirSync(logs, { recursive: true });
  const res = spawnSync(process.execPath, ['--input-type=module', '--eval', fixtureBody], {
    encoding: 'utf8',
    env: {
      ...process.env,
      AGENT_RELAY_DB_PATH: path.join(dir, 'agents.sqlite'),
      AGENT_RELAY_DATA_DIR: path.join(dir, 'data'),
    },
  });
  return { dir, logs, res, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('applyLogRetention ages out only old, finished logs; history rows stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-retention-'));
  const logs = path.join(dir, 'logs');
  const past = new Date(Date.now() - 25 * 86400000).toISOString();
  const { res, cleanup } = spawnWithDb(logs, `
    const fs = await import('node:fs');
    const path = await import('node:path');
    const LOGS = ${JSON.stringify(logs)};
    const { upsertRun, getRun } = await import(${JSON.stringify(path.join(root, 'dashboard/db.js'))});
    const { applyLogRetention } = await import(${JSON.stringify(path.join(root, 'scripts/log-retention.mjs'))});
    for (const f of ['old.log', 'old.done', 'recent.log', 'recent.done', 'busy.log', 'busy.done', 'orphan.log', 'orphan.done', 'custom-notes.md'])
      fs.writeFileSync(path.join(LOGS, f), 'x');
    // Backdate the orphan sidecars past the horizon: their reaping is
    // mtime-based because no DB row records their start time.
    const pastSecs = Math.floor((Date.now() - 25 * 86400000) / 1000);
    for (const f of ['orphan.log', 'orphan.done']) fs.utimesSync(path.join(LOGS, f), pastSecs, pastSecs);
    upsertRun({ filename: 'old.log', provider: 'codex', status: 'completed', startTime: ${JSON.stringify(past)}, workspace: '/x' });
    upsertRun({ filename: 'recent.log', provider: 'codex', status: 'completed', startTime: new Date().toISOString(), workspace: '/x' });
    upsertRun({ filename: 'busy.log', provider: 'codex', status: 'running', startTime: ${JSON.stringify(past)}, workspace: '/x' });
    const result = applyLogRetention({ logsDir: LOGS, retentionMs: 20 * 86400000, write: () => {} });
    console.log('RESULT ' + JSON.stringify(result));
    console.log('OLD-ROW ' + JSON.stringify(Boolean(getRun('old.log'))));
    console.log('REMAIN ' + fs.readdirSync(LOGS).sort().join(','));
  `);
  try {
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /RESULT {"removed":3,"runningKept":1}/);
    assert.match(res.stdout, /OLD-ROW true/);
    assert.match(res.stdout, /REMAIN busy\.done,busy\.log,custom-notes\.md,recent\.done,recent\.log/);
  } finally {
    cleanup();
  }
});

test('retention is a no-op when unset, zero, or malformed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-retention-off-'));
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(path.join(logs, 'x.log'), 'keep');
  const fixture = `
    const fs = await import('node:fs');
    const { parseRetention, applyLogRetention } = await import(${JSON.stringify(path.join(root, 'scripts/log-retention.mjs'))});
    const LOGS = ${JSON.stringify(logs)};
    console.log('P ' + JSON.stringify([
      parseRetention(process.env.AGENT_RELAY_LOG_RETENTION || null),
      parseRetention('30d'), parseRetention('12h'), parseRetention('90m'),
      parseRetention('45x'), parseRetention(''), parseRetention('0d'),
    ].map(String)));
    const result = applyLogRetention({ logsDir: LOGS }); // retention unset in env
    console.log('R ' + JSON.stringify(result));
    console.log('REMAIN ' + fs.readdirSync(LOGS).sort().join(','));
  `;
  const env = { ...process.env };
  delete env.AGENT_RELAY_LOG_RETENTION;
  const res = spawnSync(process.execPath, ['--input-type=module', '--eval', fixture], { encoding: 'utf8', env });
  try {
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.match(res.stdout, /P \["null","2592000000","43200000","5400000","null","null","0"\]/);
    assert.match(res.stdout, /R null\n/);
    assert.match(res.stdout, /REMAIN x\.log/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
