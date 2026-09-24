import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  generateConfigFileContent,
  matchRoute,
  loadRoutingConfig,
  findRoutingConfigFile,
  stripJsonComments,
} from '../scripts/routing-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), '..');

test('generateConfigFileContent creates structured routing config without hardcoded models', () => {
  const mockDiscovered = {
    antigravity: ['gemini-3.8-flash-high', 'gemini-3.1-pro-high'],
    opencode: ['opencode-go/glm-5.3', 'openai/gpt-5.5'],
    codex: ['gpt-5.6-sol'],
    claude: ['opus', 'sonnet']
  };

  const content = generateConfigFileContent(mockDiscovered);

  // Check that "model" properties are commented out and not hardcoded
  assert.match(content, /\/\/\s*"model":/);
  assert.doesNotMatch(content, /"model":\s*"gemini/);
  assert.doesNotMatch(content, /"model":\s*"gpt/);
  assert.doesNotMatch(content, /"model":\s*"opus/);

  // Check that available_models_on_host is present with the discovered models
  assert.match(content, /"available_models_on_host"/);
  assert.match(content, /"gemini-3.8-flash-high"/);
  assert.match(content, /"opencode-go\/glm-5.3"/);
  assert.match(content, /"gpt-5.6-sol"/);
  assert.match(content, /"opus"/);

  // Verify it is parseable JSON when comments are stripped
  const stripped = stripJsonComments(content);
  const parsed = JSON.parse(stripped);
  assert.ok(parsed.routing);
  assert.ok(parsed.routing.frontend);
  assert.ok(parsed.routing.backend);
  assert.ok(parsed.default);
  assert.deepEqual(parsed.available_models_on_host, mockDiscovered);
});

test('matchRoute resolves provider based on prompt keywords and file patterns', () => {
  const config = {
    routing: {
      frontend: {
        keywords: ['ui', 'frontend', 'css', 'react'],
        patterns: ['src/components/**', '*.tsx'],
        provider: 'opencode'
      },
      backend: {
        keywords: ['api', 'database', 'sql'],
        patterns: ['server/**', 'api/**'],
        provider: 'codex'
      }
    },
    default: {
      provider: 'antigravity'
    }
  };

  // Keyword match
  const match1 = matchRoute(config, 'Please update the React component layout');
  assert.equal(match1?.provider, 'opencode');
  assert.equal(match1?.routeName, 'frontend');

  const match2 = matchRoute(config, 'Fix the database query in migration');
  assert.equal(match2?.provider, 'codex');
  assert.equal(match2?.routeName, 'backend');

  // File pattern match
  const match3 = matchRoute(config, 'Fix this file', 'server/routes/auth.js');
  assert.equal(match3?.provider, 'codex');
  assert.equal(match3?.routeName, 'backend');

  // Default fallback
  const match4 = matchRoute(config, 'Something completely different');
  assert.equal(match4?.provider, 'antigravity');
  assert.equal(match4?.routeName, 'default');

  const named = matchRoute(config, 'Unrelated text', '', 'backend');
  assert.equal(named?.provider, 'codex');
  assert.equal(matchRoute(config, '', '', 'missing'), null);
});

test('loadRoutingConfig finds and parses JSONC config files with comments', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-test-'));
  try {
    const configPath = path.join(tmpDir, '.agent-relay.json');
    const content = `{
      // Some comment
      "routing": {
        "review": {
          "keywords": ["audit"],
          "provider": "claude"
          /* "model": "opus" */
        }
      },
      "default": {
        "provider": "codex"
      }
    }`;
    fs.writeFileSync(configPath, content);

    const loaded = loadRoutingConfig(tmpDir);
    assert.ok(loaded);
    assert.equal(loaded.configFile, configPath);
    assert.equal(loaded.config.routing.review.provider, 'claude');
    assert.equal(loaded.config.default.provider, 'codex');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('relay config init writes valid .agent-relay.json to target directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-cli-config-'));
  try {
    const result = spawnSync(process.execPath, [path.join(repoDir, 'scripts', 'agent-cli.mjs'), 'config', 'init'], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /✓ Wrote routing config to/);

    const targetFile = path.join(tmpDir, '.agent-relay.json');
    assert.equal(fs.existsSync(targetFile), true);

    const raw = fs.readFileSync(targetFile, 'utf8');
    const stripped = stripJsonComments(raw);
    const parsed = JSON.parse(stripped);

    assert.ok(parsed.routing);
    assert.ok(parsed.available_models_on_host);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
