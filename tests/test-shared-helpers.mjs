// Unit checks for shared helper modules (provider-env, runs-shared) plus the
// CLI duration parser, which is not importable (agent-cli runs on import).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { applyProviderEnv, providerEnv } from '../scripts/provider-env.mjs';
import { runLogFromText } from '../scripts/runs-shared.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('provider-env covers every canonical provider plus aliases', () => {
  for (const provider of ['opencode', 'codex', 'claude', 'antigravity', 'agy']) {
    const spec = providerEnv(provider);
    assert.ok(spec, `${provider} has env spec`);
    assert.match(spec.model, /^[A-Z][A-Z0-9_]+$/);
    assert.match(spec.timeout, /^[A-Z][A-Z0-9_]+$/);
    // Regression: the agy alias previously produced an env var named "undefined".
    assert.notEqual(providerEnv('agy'), null);
    assert.equal(providerEnv('agy').timeout, 'AGY_PRINT_TIMEOUT');
  }
});

test('applyProviderEnv sets timeout in the provider-specific format', () => {
  const env = {};
  applyProviderEnv(env, 'codex', { timeoutSeconds: 30 });
  assert.equal(env.CODEX_TIMEOUT, '30');
  const agy = {};
  applyProviderEnv(agy, 'agy', { timeoutSeconds: 30 });
  assert.equal(agy.AGY_PRINT_TIMEOUT, '30s');
  assert.equal(agy.AGY_MODEL, undefined);
  const withModel = {};
  applyProviderEnv(withModel, 'agy', { model: 'gemini-3-pro' });
  assert.equal(withModel.AGY_MODEL, 'gemini-3-pro');
});

test('runLogFromText only accepts matching, existing provider-log names', () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-rl-'));
  const name = `20261107T120000-codex-123.log`;
  fs.writeFileSync(path.join(logsDir, name), '');
  const text = `codex-agent: workspace=/x run_log=${logsDir}/${name}`;
  assert.equal(runLogFromText(text, 'codex', 123, logsDir), name);
  // full or partial path both resolve by basename
  assert.equal(runLogFromText(`run_log=${name}`, 'codex', 123, logsDir), name);
  // wrong provider, wrong pid, or missing file -> null
  assert.equal(runLogFromText(text, 'claude', 123, logsDir), null);
  assert.equal(runLogFromText(text, 'codex', 456, logsDir), null);
  assert.equal(runLogFromText(`run_log=${logsDir}/missing-codex-123.log`, 'codex', 123, logsDir), null);
  assert.equal(runLogFromText('', 'codex', 123, logsDir), null);
  fs.rmSync(logsDir, { recursive: true, force: true });
});

test('relay prune --older-than validates duration values', () => {
  const res = spawnSync(process.execPath, [path.join(root, 'scripts/agent-cli.mjs'), 'prune', '--older-than', '45x'], {
    cwd: root, encoding: 'utf8',
  });
  assert.notEqual(res.status, 0);
  assert.match((res.stderr || '') + (res.stdout || ''), /older-than/);
  const good = spawnSync(process.execPath, [path.join(root, 'scripts/agent-cli.mjs'), 'prune', '--older-than', '90m'], {
    cwd: root, encoding: 'utf8',
  });
  assert.notEqual(good.status, undefined);
});
