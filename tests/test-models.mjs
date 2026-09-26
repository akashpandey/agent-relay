import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCodexModels,
  getClaudeModels,
  getAntigravityModels,
  getOpencodeModels,
  getProviderModels,
} from '../scripts/resolve-models.mjs';

test('getCodexModels returns a non-empty array of model strings', () => {
  const models = getCodexModels();
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);
  for (const m of models) {
    assert.equal(typeof m, 'string');
    assert.ok(m.length > 0);
  }
});

test('getClaudeModels returns documented and discovered model strings', () => {
  const models = getClaudeModels();
  assert.ok(Array.isArray(models));
  assert.ok(models.includes('opus'));
  assert.ok(models.includes('sonnet'));
  for (const m of models) {
    assert.equal(typeof m, 'string');
  }
});

test('getProviderModels returns appropriate arrays for all valid providers', () => {
  for (const prov of ['codex', 'claude', 'antigravity', 'opencode']) {
    const models = getProviderModels(prov);
    assert.ok(Array.isArray(models));
  }
  assert.deepEqual(getProviderModels('unknown-provider'), []);
});
