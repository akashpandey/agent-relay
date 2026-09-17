import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');

async function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mcp-'));
  const logs = path.join(dir, 'logs');
  const bin = path.join(dir, 'bin');
  const workspace = path.join(dir, 'fitschool-worktrees', 'feature');
  const codexData = path.join(dir, 'codex');
  for (const p of [logs, bin, workspace, codexData, path.join(dir, 'claude'), path.join(dir, 'gemini')]) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'provider'), `#!/usr/bin/env node
const fs = require('fs');
const prompt = process.argv.at(-1);
console.log('ready');
console.log('session id: session-' + process.pid);
if (prompt.includes('large')) console.log('x'.repeat(1200000));
setTimeout(() => console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({outcome:'done',summary:process.cwd() + ':' + prompt,
 changedFiles:[], verification:[{command:'mock-check',status:'passed'}], blockers:[], incomplete:[], nextSteps:[]})}})),
 prompt.includes('hang task') ? 60000 : prompt.includes('slow') ? 3000 : 100);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH,
      AGENT_RELAY_CODEX_BIN: path.join(bin, 'provider'), AGENT_RELAY_LOG_DIR: logs,
      CODEX_DATA: codexData, CLAUDE_DATA: path.join(dir, 'claude'),
      OPENCODE_DB: path.join(dir, 'opencode.sqlite'), GEMINI_BRAIN: path.join(dir, 'gemini'),
      AGENT_RELAY_DB_PATH: path.join(dir, 'agents.sqlite'), AGENT_RELAY_DATA_DIR: dir };
  const child = spawn(process.execPath, [root + '/scripts/mcp-server.mjs'], {
    cwd: root, env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let id = 0, buffer = '', stderr = '';
  const pending = new Map();
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const response = JSON.parse(line);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  function request(method, params) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('MCP timeout: ' + stderr)); }, 15000);
      pending.set(requestId, response => { clearTimeout(timer); resolve(response); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    });
  }
  async function tool(name, args) {
    const response = await request('tools/call', { name, arguments: args });
    if (response.result?.isError) throw new Error(response.result.content[0].text);
    assert.ok(response.result, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  }
  async function ready() {
    for (let i = 0; i < 100; i++) {
      const file = fs.readdirSync(logs).find(f => f.endsWith('.log') && fs.readFileSync(path.join(logs, f), 'utf8').includes('\nready\n'));
      if (file) return file;
      await delay(50);
    }
    throw new Error('provider did not launch: ' + stderr);
  }
  try { await fn({ dir, logs, workspace, env, tool, request, ready }); }
  finally {
    child.stdin.end();
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('MCP preserves worktree paths, drains verbose output and remains responsive', { timeout: 20000 }, async () => {
  await fixture(async ({ dir, workspace, env, tool, request, ready }) => {
    const queried = path.join(dir, 'history-queried');
    fs.writeFileSync(path.join(dir, 'codex', 'state_5.sqlite'), '');
    fs.writeFileSync(path.join(dir, 'bin', 'sqlite3'), `#!/bin/sh\nprintf called >> '${queried}'\n`, { mode: 0o755 });
    const running = tool('run_agent', { provider: 'codex', workspace, prompt: 'large slow' });
    await ready();
    const ping = await Promise.race([request('ping'), delay(1000).then(() => { throw new Error('ping blocked'); })]);
    assert.deepEqual(ping.result, {});
    const result = await running;
    assert.equal(result.accepted, true);
    assert.equal(result.exitCode, 0);
    assert.ok(result.summary.startsWith(workspace + ':'));
    assert.equal(result.verification[0].command, 'mock-check');
    assert.ok(result.runAgainCommand.startsWith(`cd '${workspace}' && codex-agent`));
    const db = new DatabaseSync(path.join(dir, 'agents.sqlite'));
    try {
      db.prepare("UPDATE runs SET status='running',exit_code=NULL,result_json=NULL,outcome='unknown',tokens_total=900,cost=1.25,tool_calls='[{\"tool\":\"saved-history\"}]' WHERE filename=?").run(result.filename);
      const recovered = await tool('get_run_result', { target: result.filename });
      assert.equal(recovered.accepted, true);
      assert.equal(recovered.summary, result.summary);
      assert.equal(recovered.exitCode, 0);
      const savedHistory = db.prepare('SELECT tokens_total,cost,tool_calls FROM runs WHERE filename=?').get(result.filename);
      assert.equal(savedHistory.tokens_total, 900);
      assert.equal(savedHistory.cost, 1.25);
      assert.equal(JSON.parse(savedHistory.tool_calls)[0].tool, 'saved-history');
      assert.equal(fs.existsSync(queried), false);
      db.prepare('INSERT INTO runs(filename,provider,workspace,status,start_time) VALUES (?,?,?,?,?)')
        .run('newest-no-session.log', 'codex', workspace, 'running', new Date(Date.now() + 1000).toISOString());
      const newest = await tool('get_run_result', { target: '--last' });
      assert.equal(newest.filename, 'newest-no-session.log');
      assert.equal(newest.accepted, false);
      const cli = execFileSync(root + '/relay', ['last', workspace], { env, encoding: 'utf8' });
      assert.ok(cli.startsWith('newest-no-session.log\t'));
      assert.throws(() => execFileSync(root + '/relay', ['continue', workspace, 'follow-up'], { env, stdio: 'pipe' }), /Command failed/);
      db.prepare('DELETE FROM runs WHERE filename=?').run('newest-no-session.log');
      db.prepare('INSERT INTO runs(filename,provider,workspace,status,start_time) VALUES (?,?,?,?,?)')
        .run('sibling.log', 'codex', path.join(dir, 'fitschool-worktrees', 'sibling'), 'completed', new Date().toISOString());
      const listed = await tool('list_runs', { workspace });
      assert.deepEqual(listed.runs.map(r => r.filename), [result.filename]);
    } finally { db.close(); }
    const continuation = await tool('continue_run', { workspace, prompt: 'follow-up' });
    assert.equal(continuation.workspace, workspace);
    assert.equal(continuation.command[1], '--resume');
    const cliRun = execFileSync(root + '/relay', [workspace, 'codex', 'CLI task'], { env, encoding: 'utf8' });
    assert.ok(cliRun.includes(workspace));
    await assert.rejects(tool('continue_run', { workspace: 'unknown-alias', prompt: 'follow-up' }), /unknown workspace/);
    await assert.rejects(tool('get_session_history', { sessionId: 'missing-session', provider: 'codex' }), /not found/);
    assert.equal(fs.existsSync(queried), true);
    await assert.rejects(tool('get_session_history', { sessionId: 'missing-session', provider: 'claude' }), /not found/);
    await assert.rejects(tool('get_session_history', { provider: 'claude' }), /not found|is required/);
    await assert.rejects(tool('get_session_history', { target: 'missing.log', provider: 'codex' }), /not found/);
    await assert.rejects(tool('get_log_tail', { bytes: -1 }), /allowed range/);
    await assert.rejects(tool('get_session_history', { sessionId: 'invalid session id', provider: 'codex' }), /invalid sessionId/);
    const searched = await tool('search_log', { target: result.filename, q: 'mock-check', limit: 1 });
    assert.equal(searched.matches.length, 1);
  });
});

test('MCP background identity and cancellation preserve finalization payload', { timeout: 20000 }, async () => {
  await fixture(async ({ workspace, tool, logs, ready }) => {
    const launched = await tool('run_agent', { provider: 'codex', workspace, prompt: 'slow', wait: false });
    assert.ok(launched.filename.endsWith(`-codex-${launched.pid}.log`));
    await ready();
    const newest = await tool('get_run_result', { target: '--last' });
    assert.equal(newest.filename, launched.filename);
    assert.equal(newest.accepted, false);
    const cancelled = await tool('kill_run', { target: launched.filename });
    assert.equal(cancelled.killed, true);
    assert.equal(cancelled.forced, false);
    const done = JSON.parse(fs.readFileSync(path.join(logs, launched.filename.replace('.log', '.done'))));
    assert.equal(done.exitCode, 143);
    assert.equal(done.result.outcome, 'failed');
    const final = await tool('wait_for_run', { target: launched.filename, timeoutMs: 1000 });
    assert.equal(final.exitCode, 143);
    assert.equal(final.accepted, false);
    assert.equal(final.timedOut, false);
  });
});

test('MCP associates concurrent runs and enforces timeouts asynchronously', { timeout: 20000 }, async () => {
  await fixture(async ({ workspace, tool, request, ready }) => {
    const first = tool('run_agent', { provider: 'codex', workspace, prompt: 'slow first' });
    await ready();
    const second = tool('run_agent', { provider: 'codex', workspace, prompt: 'second' });
    const [a, b] = await Promise.all([first, second]);
    assert.notEqual(a.filename, b.filename);
    assert.match(a.summary, /Task:\s*slow first/);
    assert.match(b.summary, /Task:\s*second/);
    const timed = tool('run_agent', { provider: 'codex', workspace, prompt: 'slow timeout', timeoutSeconds: 1 });
    assert.deepEqual((await request('ping')).result, {});
    const cancelled = await timed;
    assert.equal(cancelled.timedOut, true);
    assert.equal(cancelled.accepted, false);
    assert.equal(cancelled.exitCode, 143);
  });
});

test('MCP takeover selects the exact checkout rather than a newer sibling session', async () => {
  await fixture(async ({ dir, workspace, tool }) => {
    const data = path.join(dir, 'codex');
    const db = new DatabaseSync(path.join(data, 'state_5.sqlite'));
    try {
      db.exec('CREATE TABLE threads(id TEXT, cwd TEXT, model TEXT, tokens_used INTEGER, first_user_message TEXT, rollout_path TEXT, created_at INTEGER)');
      const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,0,?,NULL,?)');
      insert.run('correct-session', workspace, 'mock', 'correct goal', 1);
      insert.run('sibling-session', path.join(dir, 'fitschool-worktrees', 'sibling'), 'mock', 'wrong goal', 2);
    } finally { db.close(); }
    const handoff = await tool('takeover_run', { workspace, provider: 'claude', execute: false });
    assert.equal(handoff.workspace, workspace);
    assert.equal(handoff.goal, 'correct goal');
    assert.equal(handoff.executed, false);
    const continuation = await tool('continue_run', { workspace, provider: 'claude', prompt: 'follow-up' });
    assert.equal(continuation.goal, 'correct goal');
    assert.equal(continuation.executed, false);
  });
});

test('MCP persists a failed result after forced cancellation interrupts finalization', { timeout: 20000 }, async () => {
  await fixture(async ({ dir, workspace, tool, logs, ready }) => {
    const node = process.execPath.replace(/'/g, "'\\''");
    fs.writeFileSync(path.join(dir, 'bin', 'node'), `#!/bin/sh
case "$1" in */write-done.mjs) sleep 9 ;; esac
exec '${node}' "$@"
`, { mode: 0o755 });
    const launched = await tool('run_agent', { provider: 'codex', workspace, prompt: 'slow', wait: false });
    await ready();
    const cancelled = await tool('kill_run', { target: launched.filename });
    assert.equal(cancelled.killed, true);
    assert.equal(cancelled.forced, true);
    const done = JSON.parse(fs.readFileSync(path.join(logs, launched.filename.replace('.log', '.done'))));
    assert.equal(done.exitCode, 137);
    assert.equal(done.result.outcome, 'failed');
    assert.equal(done.result.attentionRequired, true);
  });
});

test('forced cancellation stops a recorded unit whose worker escaped the wrapper group', { timeout: 20000 }, async () => {
  await fixture(async ({ dir, workspace, tool, logs, ready }) => {
    const node = process.execPath.replace(/'/g, "'\\''");
    fs.writeFileSync(path.join(dir, 'bin', 'node'), `#!/bin/sh
case "$1" in */write-done.mjs) sleep 9 ;; esac
exec '${node}' "$@"
`, { mode: 0o755 });
    const launched = await tool('run_agent', { provider: 'codex', workspace, prompt: 'hang task', wait: false });
    await ready();
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const workerExited = once(worker, 'exit');
    const stopped = path.join(dir, 'unit-stopped');
    try {
      const unit = `local-agent-codex-${launched.pid}`;
      const log = path.join(logs, launched.filename);
      fs.writeFileSync(log, fs.readFileSync(log, 'utf8').replace('agent-output-start:', `agent-unit: ${unit}\nagent-output-start:`));
      fs.writeFileSync(path.join(dir, 'bin', 'systemctl'), `#!/usr/bin/env node
const fs=require('fs');
if (process.argv[3] === 'stop') {
  fs.writeFileSync(${JSON.stringify(stopped)}, process.argv[4]);
  process.kill(${worker.pid}, 'SIGTERM');
} else if (process.argv[3] === 'show') {
  console.log('LoadState=loaded');
  console.log('ActiveState=' + (fs.existsSync(${JSON.stringify(stopped)}) ? 'inactive' : 'active'));
} else process.exit(1);
`, { mode: 0o755 });
      const cancelled = await tool('kill_run', { target: launched.filename });
      assert.equal(cancelled.killed, true);
      assert.equal(cancelled.forced, true);
      assert.equal(fs.readFileSync(stopped, 'utf8'), unit);
      await workerExited;
      assert.equal(worker.signalCode, 'SIGTERM');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) { worker.kill('SIGKILL'); await workerExited; }
    }
  });
});
