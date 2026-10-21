import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import test from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-opencode-details-'));
const dbPath = path.join(dir, 'opencode.db');
const runsDbPath = path.join(dir, 'runs.db');
const logDir = path.join(dir, 'logs');
fs.mkdirSync(logDir);
process.env.OPENCODE_DB = dbPath;
process.env.AGENT_RELAY_DB_PATH = runsDbPath;
const { getOpenCodeSessionDetails, parseLogMetadata } = await import('../dashboard/parser.js');
const { upsertRun } = await import('../dashboard/db.js');

const db = new DatabaseSync(dbPath);
db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, cost REAL, tokens_input INTEGER, tokens_output INTEGER,
  tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, summary_diffs TEXT);
CREATE TABLE session_message (session_id TEXT, type TEXT, seq INTEGER, data TEXT);
CREATE TABLE session (id TEXT PRIMARY KEY, cost REAL, tokens_input INTEGER, tokens_output INTEGER,
  tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER, summary_diffs TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('v2-session', 0.25, 10, 20, 2, 5, 0, null);
const v2Message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)');
v2Message.run('v2-session', 'user', 1, JSON.stringify({ text: JSON.stringify('Task: improve the page') }));
v2Message.run('v2-session', 'assistant', 2, JSON.stringify({ content: [
  { type: 'tool', id: 'call-1', name: 'execute', state: { status: 'completed', input: { command: 'npm test' } } },
  { type: 'tool', id: 'call-2', name: 'patch', state: { status: 'completed', input: { patchText: '*** Update File: src/page.js\n' },
    metadata: { metadata: { files: [{ file: 'src/page.js', patch: '@@ -1 +1 @@' }] } } } },
  { type: 'text', text: 'Page improved and checked.' },
] }));
db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('v1-session', 0.1, 4, 8, 0, 0, 0, null);
db.prepare('INSERT INTO message VALUES (?, ?)').run('user-message', JSON.stringify({ role: 'user' }));
db.prepare('INSERT INTO message VALUES (?, ?)').run('assistant-message', JSON.stringify({ role: 'assistant' }));
const oldPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
oldPart.run('p1', 'user-message', 'v1-session', 1, JSON.stringify({ type: 'text', text: 'Task: check legacy' }));
oldPart.run('p2', 'assistant-message', 'v1-session', 2, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } }));
oldPart.run('p3', 'assistant-message', 'v1-session', 3, JSON.stringify({ type: 'text', text: 'Legacy checked.' }));
db.close();

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('OpenCode v2 and v1 sessions recover summary, tools, usage and changed files', () => {
  const v2 = getOpenCodeSessionDetails('v2-session');
  assert.equal(v2.task, 'improve the page');
  assert.equal(v2.markdownSummary, 'Page improved and checked.');
  assert.deepEqual(v2.toolCalls.map(call => call.type), ['command', 'edit']);
  assert.deepEqual(v2.filesModified, ['src/page.js']);
  assert.match(v2.diffs, /@@ -1 \+1 @@/);
  assert.equal(v2.tokens.total, 32);

  const v1 = getOpenCodeSessionDetails('v1-session');
  assert.equal(v1.task, 'check legacy');
  assert.equal(v1.markdownSummary, 'Legacy checked.');
  assert.equal(v1.toolCalls[0].type, 'command');
  assert.equal(v1.tokens.total, 12);
});

const file = '20261021T130000-opencode-99999999.log';
const log = path.join(logDir, file);
const event = (type, part, sessionID = 'log-session') => JSON.stringify({ type, sessionID, part });
fs.writeFileSync(log, [
  'agent: provider=opencode workspace=/tmp model=test/model session=new',
  'Task:',
  'do work',
  event('text', { type: 'text', text: 'Fake prompt event' }),
  'agent-output-start: 99999999',
  event('tool_use', { type: 'tool', id: 'call-1', tool: 'shell', state: { status: 'completed', input: { command: 'node --test' } } }),
  event('step_finish', { type: 'step-finish', cost: 0.02, tokens: { input: 3, output: 5, reasoning: 1, cache: { read: 2 } } }),
  event('text', { type: 'text', text: 'Finished the work.' }),
].join('\n') + '\n');
fs.writeFileSync(log.replace('.log', '.done'), JSON.stringify({ status: 'completed', exitCode: 0, sessionId: 'log-session' }));

test('JSON event fallback recovers details only after the output marker', () => {
  const parsed = parseLogMetadata(file, log, dir);
  assert.equal(parsed.markdownSummary, 'Finished the work.');
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].type, 'command');
  assert.equal(parsed.tokens.total, 9);
  assert.equal(parsed.cost, 0.02);
});

test('detail request repairs an incomplete cached run', async () => {
  const stat = fs.statSync(log);
  upsertRun({ filename: file, provider: 'opencode', pid: 99999999, workspace: '/tmp',
    sessionId: 'log-session', status: 'completed', startTime: '2026-10-21T13:00:00Z',
    task: 'do work', fullTask: 'do work', size: stat.size, mtime: Math.floor(stat.mtimeMs),
    markdownSummary: null, toolCalls: [], tokens: null });
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  socket.close();
  await once(socket, 'close');
  const child = spawn(process.execPath, ['dashboard/server.js'], { cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOGS_DIR: logDir, PROC_DIR: dir },
    stdio: 'ignore' });
  try {
    let data;
    for (let i = 0; i < 50; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runs/${file}`);
        if (response.ok) { data = await response.json(); break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(data, 'dashboard started');
    assert.equal(data.markdownSummary, 'Finished the work.');
    assert.equal(data.toolCalls.length, 1);
    assert.equal(data.tokens.total, 9);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
