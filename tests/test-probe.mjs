import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyProbeFailure, parseProbeArgs, parseProbeOutput, probeModel } from '../scripts/model-probe.mjs';

const root = path.resolve(import.meta.dirname, '..');

function fixture(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-probe-test-'));
  const binary = path.join(dir, 'provider');
  fs.writeFileSync(binary, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  const original = { ...process.env };
  for (const name of ['CODEX', 'CLAUDE', 'OPENCODE', 'AGY']) process.env[`AGENT_RELAY_${name}_BIN`] = binary;
  process.env.PROBE_CAPTURE = path.join(dir, 'capture.json');
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, binary };
}

test('probe requires an explicit model and validates all options before launching', () => {
  assert.deepEqual(parseProbeArgs(['agy', '--model', 'gemini-pro', '--json', '--timeout', '5']), {
    provider: 'antigravity', model: 'gemini-pro', json: true, timeoutMs: 5000,
  });
  for (const args of [[], ['unknown'], ['codex'], ['codex', '--model'], ['claude', '--model', ' '],
    ['codex', '--model', 'test', '--fallback'], ['codex', '--model', 'test', '--timeout', 'NaN'],
    ['codex', '--model', 'test', '--timeout', '0'], ['codex', '--model', 'test', '--timeout', '301']]) {
    assert.throws(() => parseProbeArgs(args));
  }
});

test('failure classification distinguishes quota from generic throttling, auth and connectivity', () => {
  const cases = {
    quota_exhausted: ['insufficient_quota', '429 quota_exhausted', 'quota exceeded', 'You exceeded your current quota', 'Usage limit reached', 'insufficient credits', "You've hit your usage limit"],
    rate_limited: ['HTTP 429', 'rate_limit_error', 'RESOURCE_EXHAUSTED: retry later'],
    auth_failed: ['invalid_api_key', 'HTTP 401 unauthorized', 'session expired'],
    model_unavailable: ['model_not_found', 'model is not available', 'You do not have access to this model', 'HTTP 403'],
    network_error: ['fetch failed', 'ECONNRESET', 'getaddrinfo ENOTFOUND'],
    timeout: ['request timed out'],
    unknown_error: ['server error 500', 'quota information unavailable', 'unexpected response'],
  };
  for (const [status, inputs] of Object.entries(cases)) for (const input of inputs) {
    assert.equal(classifyProbeFailure(input), status, input);
  }
});

test('provider envelopes yield assistant text, actual model and explicit retry hints only', () => {
  const cases = [
    [{ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }],
    [{ type: 'result', result: 'OK', modelUsage: { 'claude-test': {} } }],
    [{ type: 'text', part: { type: 'text', text: 'OK' } }],
    [{ event: 'step_update', step_update: { text_delta: 'O' } }, { event: 'step_update', step_update: { text_delta: 'K' } }],
  ];
  for (const events of cases) assert.equal(parseProbeOutput(events.map(x => JSON.stringify(x)).join('\n')).reply, 'OK');
  assert.equal(parseProbeOutput(JSON.stringify(cases[1][0], null, 2)).resolvedModel, 'claude-test');
  assert.equal(parseProbeOutput(JSON.stringify({ type: 'error', error: { code: '429', retry_after: 20 } })).retryAfter, 20);
  assert.equal(parseProbeOutput('OK').reply, '');
  assert.equal(parseProbeOutput('{"type":"tool_use","output":"OK"}').reply, '');
  assert.equal(parseProbeOutput('null\nnot-json').reply, '');
});

test('all providers use exact models in an isolated directory without relay task wrappers', async t => {
  const { dir } = fixture(t, `
const fs = require('node:fs');
fs.writeFileSync(process.env.PROBE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT }));
console.log(JSON.stringify({ type: 'result', result: 'OK', model: 'exact-model' }));
`);
  for (const provider of ['codex', 'claude', 'opencode', 'antigravity']) {
    const result = await probeModel({ provider, model: 'exact-model' });
    assert.equal(result.status, 'ready');
    assert.equal(result.resolvedModel, 'exact-model');
    assert.ok(result.latencyMs >= 0);
    const capture = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json')));
    assert.equal(capture.args[capture.args.indexOf('--model') + 1], 'exact-model');
    assert.equal(capture.args.some(arg => /fallback|dangerously|--continue|--resume/.test(arg)), false);
    assert.notEqual(capture.cwd, root);
    assert.equal(fs.existsSync(capture.cwd), false, 'temporary workspace is removed');
    if (provider === 'claude') {
      assert.equal(capture.args[capture.args.indexOf('--tools') + 1], '');
      assert.ok(capture.args.includes('--no-session-persistence'));
    }
    if (provider === 'codex') assert.ok(capture.args.includes('--ephemeral'));
    if (provider === 'opencode') {
      assert.equal(JSON.parse(capture.config).agent['relay-probe'].tools['*'], false);
      assert.equal(capture.args[capture.args.indexOf('--title') + 1], 'relay-probe');
    }
    if (provider === 'antigravity') assert.ok(capture.args.includes('--sandbox'));
  }
});

test('zero exit without assistant response is not ready; structured errors override OK', async t => {
  const { binary } = fixture(t, 'console.log("OK");');
  assert.equal((await probeModel({ provider: 'codex', model: 'test' })).status, 'unknown_error');
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({type:'result', result:'OK', is_error:true, errors:['insufficient_quota']}));\n`, { mode: 0o755 });
  assert.equal((await probeModel({ provider: 'claude', model: 'test' })).status, 'quota_exhausted');
});

test('JSON failure output exposes classification without credentials or raw provider output', t => {
  const { dir } = fixture(t, `console.error('HTTP 429 Retry-After: 12 secret-token'); process.exitCode = 1;`);
  const result = spawnSync(process.execPath, [root + '/scripts/agent-cli.mjs', 'probe', 'opencode', '--model', 'test', '--json'], {
    env: { ...process.env, AGENT_RELAY_DB_PATH: path.join(dir, 'db.sqlite'), AGENT_RELAY_LOG_DIR: path.join(dir, 'logs') },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'rate_limited');
  assert.equal(JSON.parse(result.stdout).retryAfter, '12');
  assert.equal(result.stdout.includes('secret-token'), false);
  assert.equal(fs.existsSync(path.join(dir, 'logs')), false, 'probe creates no relay run logs');
});

test('CLI emits readable results and machine-readable argument errors with correct exit codes', t => {
  const { dir } = fixture(t, `console.log(JSON.stringify({type:'result',result:'OK'}));`);
  const run = args => spawnSync(process.execPath, [root + '/scripts/agent-cli.mjs', 'probe', ...args], {
    env: { ...process.env, AGENT_RELAY_DB_PATH: path.join(dir, 'db.sqlite') }, encoding: 'utf8', timeout: 5000,
  });
  const success = run(['claude', '--model', 'sonnet']);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /^ready: claude \/ sonnet/);
  const json = run(['claude', '--model', 'sonnet', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).status, 'ready');
  const invalid = run(['codex', '--json']);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).status, 'invalid_arguments');
});

test('missing executable is a reported failure, not an exception', async t => {
  const { dir } = fixture(t, '');
  process.env.AGENT_RELAY_CODEX_BIN = path.join(dir, 'missing');
  const result = await probeModel({ provider: 'codex', model: 'test' });
  assert.equal(result.status, 'unknown_error');
  assert.match(result.message, /not found/);
});

test('explicit quota errors are returned even if the provider keeps retrying', async t => {
  fixture(t, `console.log(JSON.stringify({type:'error',error:{code:'insufficient_quota',retry_after:60}}));setInterval(()=>{},1000);`);
  const result = await probeModel({ provider: 'opencode', model: 'test', timeoutMs: 3000 });
  assert.equal(result.status, 'quota_exhausted');
  assert.equal(result.retryAfter, 60);
  assert.ok(result.latencyMs < 2500);
});

test('excessive provider output is bounded and terminates the probe', async t => {
  fixture(t, `process.stdout.write('x'.repeat(100000));setInterval(()=>{},1000);`);
  const result = await probeModel({ provider: 'codex', model: 'test', timeoutMs: 3000 });
  assert.equal(result.status, 'unknown_error');
  assert.ok(result.latencyMs < 2500);
});

test('timeout kills a provider that ignores TERM and its child processes', { timeout: 5000 }, async t => {
  const { dir } = fixture(t, `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:'ignore'});
fs.writeFileSync(process.env.PROBE_CAPTURE, JSON.stringify({pid:process.pid,child:child.pid,cwd:process.cwd()}));
process.on('SIGTERM',()=>{});
setInterval(()=>{},1000);
`);
  const result = await probeModel({ provider: 'codex', model: 'test', timeoutMs: 400 });
  assert.equal(result.status, 'timeout');
  const capture = JSON.parse(fs.readFileSync(path.join(dir, 'capture.json')));
  for (const pid of [capture.pid, capture.child]) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      assert.match(stat, /\) Z /, 'a killed process may await reaping but must not keep running');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.equal(fs.existsSync(capture.cwd), false);
});
