import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('runs table persists fullTask and preserves complete prompt on read and search', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-task-test-'));
  const origDbPath = process.env.AGENT_RELAY_DB_PATH;
  process.env.AGENT_RELAY_DB_PATH = path.join(tmpDir, 'test-runs.sqlite');

  try {
    // Dynamic import to pick up isolated AGENT_RELAY_DB_PATH
    const dbModule = await import('../dashboard/db.js?test=' + Date.now());
    const { upsertRun, getRun, registerRunStart, getFilteredRuns } = dbModule;

    const longPrompt = 'Implement a comprehensive real-time notification engine with SSE and WebSocket fallbacks. ' +
      'Ensure that all message types are strongly validated, including heartbeat signals and disconnect reconnect loops. ' +
      'Extra requirements: ' + 'unique-keyword-beyond-300-chars '.repeat(10) + 'must pass all edge-case tests.';

    assert.ok(longPrompt.length > 300, 'Test prompt should be longer than 300 chars');

    // 1. Test upsertRun with fullTask
    const runObj = {
      filename: '20260930T220000-opencode-12345.log',
      pid: 12345,
      provider: 'opencode',
      model: 'glm-5.2',
      workspace: '/home/akey/Code/agent-relay',
      session: 'sess-12345',
      task: longPrompt.slice(0, 300) + '...',
      fullTask: longPrompt,
      status: 'completed',
      startTime: new Date().toISOString(),
      currentAction: 'Finished',
    };

    upsertRun(runObj);

    const fetched = getRun(runObj.filename);
    assert.ok(fetched, 'Run record should exist');
    assert.equal(fetched.task, longPrompt.slice(0, 300) + '...');
    assert.equal(fetched.fullTask, longPrompt, 'fullTask must equal complete long prompt without truncation');

    // 2. Test search matches text occurring beyond 300 characters in full_task
    const searchRes = getFilteredRuns({ q: 'unique-keyword-beyond-300-chars', limit: 10, offset: 0 });
    assert.equal(searchRes.total, 1, 'Search query must find run by keyword in full_task');
    assert.equal(searchRes.runs[0].filename, runObj.filename);
    assert.equal(searchRes.runs[0].fullTask, longPrompt);

    // 3. Test registerRunStart with long prompt
    const run2Name = '20260930T220100-antigravity-67890.log';
    registerRunStart({
      filename: run2Name,
      pid: 67890,
      provider: 'antigravity',
      model: 'default',
      workspace: '/home/akey/Code/agent-relay',
      session: 'sess-67890',
      task: longPrompt.slice(0, 300) + '...',
      fullTask: longPrompt,
    });

    const fetched2 = getRun(run2Name);
    assert.ok(fetched2, 'Run 2 should exist');
    assert.equal(fetched2.task, longPrompt.slice(0, 300) + '...');
    assert.equal(fetched2.fullTask, longPrompt, 'registerRunStart must store complete long prompt in fullTask');
  } finally {
    if (origDbPath !== undefined) {
      process.env.AGENT_RELAY_DB_PATH = origDbPath;
    } else {
      delete process.env.AGENT_RELAY_DB_PATH;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
