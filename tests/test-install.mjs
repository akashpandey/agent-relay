import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'scripts', 'agent-cli.mjs');

function testEnv(providers = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-install-'));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  for (const command of ['sh', 'dirname', 'mkdir', 'ln', 'readlink', 'realpath', 'rm']) {
    const found = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(found, path.join(bin, command));
  }
  for (const provider of providers) fs.writeFileSync(path.join(bin, provider), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { dir, home, bin, env: { ...process.env, HOME: home, PATH: bin } };
}

function runInstall(env, extraArgs = []) {
  return spawnSync(process.execPath, [cli, 'install', '--no-dashboard', ...extraArgs], { env, encoding: 'utf8' });
}

test('relay install skips MCP setup when no provider CLIs are present', () => {
  const fixture = testEnv();
  try {
    const result = runInstall(fixture.env);
    assert.equal(result.status, 0, result.stderr);
    for (const provider of ['opencode', 'agy', 'claude', 'codex']) assert.match(result.stdout, new RegExp(`${provider}: not found on PATH, skipped`));
    assert.doesNotMatch(result.stdout, /\x1b/);
    assert.match(result.stdout, /Next steps:\n\s*See docs\/GETTING_STARTED\.md/);
    assert.equal(fs.lstatSync(path.join(fixture.home, '.local', 'bin', 'relay')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(fixture.home, '.codex', 'skills', 'agent-relay')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(fixture.home, '.claude.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.home, '.codex', 'config.toml')), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('relay install configures all detected providers idempotently', () => {
  const fixture = testEnv(['opencode', 'agy', 'claude', 'codex']);
  try {
    const first = runInstall(fixture.env);
    const second = runInstall(fixture.env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    for (const provider of ['opencode', 'agy', 'claude', 'codex']) assert.match(second.stdout, new RegExp(`${provider}: skill\\+bin ok, mcp registered`));
    assert.doesNotMatch(second.stdout, /\x1b/);
    assert.match(second.stdout, /Next steps:\n\s*relay opencode "Describe this repository in one sentence\./);

    const claude = JSON.parse(fs.readFileSync(path.join(fixture.home, '.claude.json')));
    const opencode = JSON.parse(fs.readFileSync(path.join(fixture.home, '.config', 'opencode', 'opencode.json')));
    const agy = JSON.parse(fs.readFileSync(path.join(fixture.home, '.gemini', 'antigravity-cli', 'mcp_config.json')));
    const codex = fs.readFileSync(path.join(fixture.home, '.codex', 'config.toml'), 'utf8');
    assert.equal(Object.keys(claude.mcpServers).filter(key => key === 'agent-relay').length, 1);
    assert.equal(Object.keys(opencode.mcp).filter(key => key === 'agent-relay').length, 1);
    assert.equal(Object.keys(agy.mcpServers).filter(key => key === 'agent-relay').length, 1);
    assert.equal((codex.match(/\[mcp_servers\.agent_relay\]/g) || []).length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('postinstall is quiet, succeeds without providers, and does not touch MCP or dashboard', () => {
  const fixture = testEnv();
  const dashboardMarker = path.join(fixture.dir, 'dashboard-ran');
  fs.writeFileSync(path.join(fixture.bin, 'docker'), `#!/bin/sh\ntouch "${dashboardMarker}"\n`, { mode: 0o755 });
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'postinstall.mjs')], {
      env: { ...fixture.env, INIT_CWD: root, npm_config_global: 'false' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(fs.lstatSync(path.join(fixture.home, '.local', 'bin', 'relay')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(fixture.home, '.claude.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.home, '.codex', 'config.toml')), false);
    assert.equal(fs.existsSync(dashboardMarker), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('relay install skips the SessionStart hook non-interactively by default', () => {
  const fixture = testEnv(['claude']);
  try {
    fs.mkdirSync(path.join(fixture.home, '.claude'), { recursive: true });
    const result = runInstall(fixture.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hooks \(Claude Code\): skipped \(non-interactive\)/);
    assert.equal(fs.existsSync(path.join(fixture.home, '.claude', 'settings.json')), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('relay install --hooks registers the SessionStart hook idempotently', () => {
  const fixture = testEnv(['claude']);
  try {
    fs.mkdirSync(path.join(fixture.home, '.claude'), { recursive: true });
    const first = runInstall(fixture.env, ['--hooks']);
    const second = runInstall(fixture.env, ['--hooks']);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /hooks \(Claude Code\): registered/);
    assert.match(second.stdout, /hooks \(Claude Code\): already installed/);

    const settings = JSON.parse(fs.readFileSync(path.join(fixture.home, '.claude', 'settings.json')));
    assert.equal(settings.hooks.SessionStart.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('relay install --no-hooks never writes settings.json', () => {
  const fixture = testEnv(['claude']);
  try {
    fs.mkdirSync(path.join(fixture.home, '.claude'), { recursive: true });
    const result = runInstall(fixture.env, ['--no-hooks']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /hooks \(Claude Code\): skipped$/m);
    assert.equal(fs.existsSync(path.join(fixture.home, '.claude', 'settings.json')), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('postinstall skips dependency installs', () => {
  const fixture = testEnv();
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'postinstall.mjs')], {
      env: { ...fixture.env, INIT_CWD: fixture.dir, npm_config_global: 'false' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.equal(fs.existsSync(path.join(fixture.home, '.local', 'bin', 'relay')), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
