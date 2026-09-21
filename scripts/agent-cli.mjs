#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveWorkspacePath, configuredWorkspaceEntries } from '../dashboard/workspaces.js';
import { deleteRun, getFilteredRuns, getRun, getWorkspacesFromDb } from '../dashboard/db.js';
import { findLatestWorkspaceSession, buildRelayTakeoverPrompt } from './relay-handoff.mjs';
import {
  GLOBAL_CONFIG_PATH,
  discoverHostModels,
  generateConfigFileContent,
} from './routing-config.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), '..');
const logsDir = process.env.AGENT_RELAY_LOG_DIR || process.env.SUBAGENT_LOG_DIR || path.join(repoDir, 'logs');
const providers = new Map([
  ['opencode', 'opencode-agent'],
  ['codex', 'codex-agent'],
  ['claude', 'claude-agent'],
  ['antigravity', 'antigravity-agent'],
  ['agy', 'antigravity-agent'],
]);

const cmdName = process.env.AGENT_RELAY_CLI_NAME || process.env.SUBAGENT_CLI_NAME || 'relay';

function usage() {
  console.log(`Usage:
  ${cmdName} <provider> [wrapper-args...] "task"
  ${cmdName} <workspace> <provider> [wrapper-args...] "task"
  ${cmdName} takeover [workspace] <provider> [instructions...]
  ${cmdName} init
  ${cmdName} config init [--global]
  ${cmdName} install [--dashboard|--no-dashboard] [--hooks|--no-hooks]
  ${cmdName} mcp install
  ${cmdName} workspaces
  ${cmdName} doctor
  ${cmdName} dashboard [restart]
  ${cmdName} attention [workspace]
  ${cmdName} prune [--confirm] [--older-than 30d] [--workspace name] [--outcome outcome]
  ${cmdName} result [--last | workspace | log-or-pid]
  ${cmdName} open [--browser] [--last | workspace | log]
  ${cmdName} last [workspace]
  ${cmdName} continue [workspace] "task" [--to <provider>]

Aliases: relay, agent (takeover alias: handoff)
Providers: ${[...providers.keys()].join(', ')}`);
}

function knownWorkspaces() {
  const byPath = new Map();
  for (const ws of getWorkspacesFromDb()) byPath.set(ws.path, ws);
  for (const ws of configuredWorkspaceEntries()) {
    const actual = path.resolve(ws.path);
    byPath.set(actual, { totalRuns: 0, activeRuns: 0, ...byPath.get(actual), path: actual, name: ws.name });
  }
  return [...byPath.values()];
}

function displayPath(value) {
  const home = os.homedir();
  return value === home || value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value;
}

function discoverWorkspaces(codeRoot) {
  try {
    return fs.readdirSync(codeRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => ({ name: entry.name, path: path.join(codeRoot, entry.name) }))
      .filter(entry => fs.existsSync(path.join(entry.path, '.git')))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error(`${cmdName}: cannot scan ${codeRoot}: ${err.message}`);
    process.exit(1);
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

async function initWorkspaces() {
  const configPath = process.env.AGENT_RELAY_WORKSPACES_CONFIG || process.env.SUBAGENT_WORKSPACES_CONFIG ||
    path.join(os.homedir(), '.config', 'agent-relay', 'workspaces.json');
  if (fs.existsSync(configPath)) {
    console.log(`${cmdName}: ${configPath} already exists`);
    return;
  }

  const codeRoot = path.resolve(process.env.CODE_ROOT || process.env.AGENT_RELAY_CODE_ROOT || process.env.SUBAGENT_CODE_ROOT || path.join(os.homedir(), 'Code'));
  console.log(`Scanning ${displayPath(codeRoot)} for git repositories...`);
  const workspaces = discoverWorkspaces(codeRoot);
  console.log(`Found ${workspaces.length} workspaces:`);
  const width = String(workspaces.length).length;
  const nameWidth = Math.max(1, ...workspaces.map(ws => ws.name.length));
  workspaces.forEach((ws, index) => {
    console.log(`  ${String(index + 1).padStart(width)}. ${ws.name.padEnd(nameWidth)}  ${ws.path}`);
  });

  const answer = await ask(`\nWrite these to ${configPath}? [Y/n] `);
  if (answer && !['y', 'yes'].includes(answer.toLowerCase())) {
    console.log('Cancelled');
    return;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(Object.fromEntries(workspaces.map(ws => [ws.name, ws.path])), null, 2)}\n`);
  console.log(`✓ Wrote ${workspaces.length} workspaces to ${configPath}`);
}

async function installMcp(onlyProviders = null) {
  const home = os.homedir();
  const mcpBin = path.join(home, '.local', 'bin', 'agent-relay-mcp');
  const fallbackBin = path.join(repoDir, 'agent-relay-mcp');
  const targetBin = fs.existsSync(mcpBin) ? mcpBin : fallbackBin;

  console.log(`Setting up agent-relay MCP server (${targetBin})...\n`);
  let configuredCount = 0;
  const results = new Map();
  const enabled = provider => !onlyProviders || onlyProviders.has(provider);

  // 1. Claude Code (~/.claude.json)
  if (enabled('claude')) try {
    const claudePath = path.join(home, '.claude.json');
    let claudeConfig = {};
    if (fs.existsSync(claudePath)) {
      try { claudeConfig = JSON.parse(fs.readFileSync(claudePath, 'utf8')); } catch {}
    }
    claudeConfig.mcpServers = claudeConfig.mcpServers || {};
    claudeConfig.mcpServers['agent-relay'] = { command: targetBin };
    fs.writeFileSync(claudePath, JSON.stringify(claudeConfig, null, 2) + '\n');
    console.log(`✓ Configured Claude Code (${displayPath(claudePath)})`);
    configuredCount++;
    results.set('claude', 'registered');
  } catch (err) {
    console.error(`✗ Claude Code: ${err.message}`);
    results.set('claude', `failed: ${err.message}`);
  }

  // 2. OpenCode (~/.config/opencode/opencode.json)
  if (enabled('opencode')) try {
    const opencodeDir = path.join(home, '.config', 'opencode');
    const opencodePath = path.join(opencodeDir, 'opencode.json');
    if (onlyProviders || fs.existsSync(opencodeDir) || fs.existsSync(opencodePath)) {
      let opencodeConfig = {};
      if (fs.existsSync(opencodePath)) {
        try { opencodeConfig = JSON.parse(fs.readFileSync(opencodePath, 'utf8')); } catch {}
      }
      opencodeConfig.mcp = opencodeConfig.mcp || {};
      opencodeConfig.mcp['agent-relay'] = {
        type: 'local',
        command: [targetBin],
        enabled: true,
      };
      fs.mkdirSync(opencodeDir, { recursive: true });
      fs.writeFileSync(opencodePath, JSON.stringify(opencodeConfig, null, 2) + '\n');
      console.log(`✓ Configured OpenCode (${displayPath(opencodePath)})`);
      configuredCount++;
      results.set('opencode', 'registered');
    }
  } catch (err) {
    console.error(`✗ OpenCode: ${err.message}`);
    results.set('opencode', `failed: ${err.message}`);
  }

  // 3. Antigravity CLI (~/.gemini/antigravity-cli/mcp_config.json)
  if (enabled('agy')) try {
    const agyCliDir = path.join(home, '.gemini', 'antigravity-cli');
    const agyConfigPath = path.join(agyCliDir, 'mcp_config.json');
    if (onlyProviders || fs.existsSync(path.join(home, '.gemini'))) {
      let agyConfig = {};
      if (fs.existsSync(agyConfigPath)) {
        try { agyConfig = JSON.parse(fs.readFileSync(agyConfigPath, 'utf8')); } catch {}
      }
      agyConfig.mcpServers = agyConfig.mcpServers || {};
      agyConfig.mcpServers['agent-relay'] = { command: targetBin };
      fs.mkdirSync(agyCliDir, { recursive: true });
      fs.writeFileSync(agyConfigPath, JSON.stringify(agyConfig, null, 2) + '\n');
      console.log(`✓ Configured Antigravity CLI (${displayPath(agyConfigPath)})`);
      configuredCount++;
      results.set('agy', 'registered');
    }
  } catch (err) {
    console.error(`✗ Antigravity: ${err.message}`);
    results.set('agy', `failed: ${err.message}`);
  }

  // 4. OpenAI Codex CLI (~/.codex/config.toml)
  if (enabled('codex')) try {
    const codexDir = path.join(home, '.codex');
    const codexPath = path.join(codexDir, 'config.toml');
    if (onlyProviders || fs.existsSync(codexDir)) {
      fs.mkdirSync(codexDir, { recursive: true });
      let content = fs.existsSync(codexPath) ? fs.readFileSync(codexPath, 'utf8') : '';
      if (!content.includes('[mcp_servers.agent_relay]') && !content.includes('[mcp_servers.agent-relay]')) {
        const tomlSnippet = `\n[mcp_servers.agent_relay]\ncommand = "${targetBin}"\nstartup_timeout_sec = 60\n`;
        fs.appendFileSync(codexPath, tomlSnippet);
        console.log(`✓ Configured OpenAI Codex (${displayPath(codexPath)})`);
        configuredCount++;
      } else {
        console.log(`✓ OpenAI Codex already configured (${displayPath(codexPath)})`);
        configuredCount++;
      }
      results.set('codex', 'registered');
    }
  } catch (err) {
    console.error(`✗ Codex: ${err.message}`);
    results.set('codex', `failed: ${err.message}`);
  }

  console.log(`\nMCP setup complete across ${configuredCount} detected harness(es).`);
  return results;
}

const installHarnesses = [
  ['opencode', 'opencode'],
  ['agy', 'agy'],
  ['claude', 'claude'],
  ['codex', 'codex'],
];

function commandOnPath(command) {
  const mode = fs.constants.X_OK;
  return (process.env.PATH || '').split(path.delimiter).some(dir => {
    try {
      const candidate = path.join(dir || '.', command);
      fs.accessSync(candidate, mode);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function printDashboardCommands() {
  console.log(`Dashboard (Docker, from ${repoDir}): docker compose up -d`);
  console.log(`Dashboard (foreground): ${path.join(repoDir, 'agent-dashboard')}`);
}

async function installDashboard(mode) {
  if (!process.stdout.isTTY || mode === 'no') {
    printDashboardCommands();
    return;
  }

  const dockerReady = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
  const composePath = path.join(repoDir, 'docker-compose.yml');
  if (dockerReady && fs.existsSync(composePath)) {
    const answer = mode === 'yes' ? 'yes' : await ask('Start the dashboard with Docker? [y/N] ');
    if (['y', 'yes'].includes(answer.toLowerCase())) {
      const child = spawnSync('docker', ['compose', 'up', '-d'], { cwd: repoDir, stdio: 'inherit' });
      if (child.status === 0) return;
      console.error(`${cmdName}: docker compose failed`);
    }
  } else if (dockerReady) {
    console.log('No docker-compose.yml found. Run: cp docker-compose.sample.yml docker-compose.yml');
  }

  const answer = mode === 'yes' ? 'yes' : await ask('Launch the dashboard in the background instead? [y/N] ');
  if (['y', 'yes'].includes(answer.toLowerCase())) {
    const child = spawn(path.join(repoDir, 'agent-dashboard'), [], { cwd: repoDir, detached: true, stdio: 'ignore' });
    child.unref();
    console.log('Dashboard started: http://127.0.0.1:4242');
    return;
  }
  printDashboardCommands();
}

async function installHooks(mode) {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  if (!fs.existsSync(claudeDir)) return 'skipped: claude not detected';

  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  }
  const hookCommand = `node "${path.join(repoDir, 'plugins', 'agent-relay', 'hooks', 'agent-relay-activate.js')}"`;
  const existingEntries = settings.hooks?.SessionStart || [];
  const already = existingEntries.some(entry => (entry.hooks || []).some(h => h.command === hookCommand));
  if (already) return 'already installed';

  if (mode === 'no') return 'skipped';
  let confirmed = mode === 'yes';
  if (!confirmed) {
    if (!process.stdout.isTTY) return 'skipped (non-interactive)';
    const answer = await ask('Install a SessionStart hook so Claude Code reminds itself agent-relay is available? [y/N] ');
    confirmed = ['y', 'yes'].includes(answer.toLowerCase());
  }
  if (!confirmed) return 'skipped (not confirmed)';

  settings.hooks = settings.hooks || {};
  settings.hooks.SessionStart = existingEntries.concat([{
    matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: hookCommand, timeout: 5 }],
  }]);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return 'registered';
}

function colorSummaryLine(line, useColor) {
  if (!useColor) return line;
  if (line.includes('failed')) return `\x1b[31m${line}\x1b[0m`;
  if (line.includes('skill+bin ok') && line.includes('mcp registered')) return `\x1b[32m${line}\x1b[0m`;
  if (line.includes('not found on PATH, skipped')) return `\x1b[33m${line}\x1b[0m`;
  return line;
}

async function installRelay(argv) {
  const validFlags = ['--dashboard', '--no-dashboard', '--hooks', '--no-hooks'];
  const invalid = argv.filter(arg => !validFlags.includes(arg));
  if (invalid.length || (argv.includes('--dashboard') && argv.includes('--no-dashboard')) ||
      (argv.includes('--hooks') && argv.includes('--no-hooks'))) {
    console.error(`Usage: ${cmdName} install [--dashboard|--no-dashboard] [--hooks|--no-hooks]`);
    process.exit(2);
  }

  const detected = new Set(installHarnesses.filter(([, command]) => commandOnPath(command)).map(([provider]) => provider));
  const links = spawnSync(path.join(repoDir, 'install-skill'), [], { cwd: repoDir, stdio: 'inherit', env: process.env });
  const linksOk = links.status === 0;
  const mcp = await installMcp(detected);

  const useColor = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env && process.env.NO_COLOR !== '');

  console.log('\nInstall summary:');
  for (const [provider] of installHarnesses) {
    const line = !detected.has(provider)
      ? `${provider}: not found on PATH, skipped`
      : `${provider}: skill+bin ${linksOk ? 'ok' : 'failed'}, mcp ${mcp.get(provider) || 'failed'}`;
    console.log(colorSummaryLine(line, useColor));
  }

  const hooksMode = argv.includes('--hooks') ? 'yes' : argv.includes('--no-hooks') ? 'no' : 'ask';
  const hooksResult = await installHooks(hooksMode);
  console.log(`hooks (Claude Code): ${hooksResult}`);

  console.log('\nAuto-discovering host models and setting up routing config...');
  const discovered = discoverHostModels(repoDir);
  const totalModels = Object.values(discovered).reduce((sum, list) => sum + list.length, 0);
  const providersWithModels = Object.keys(discovered).filter(k => discovered[k]?.length > 0);

  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(GLOBAL_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(GLOBAL_CONFIG_PATH, generateConfigFileContent(discovered));
    console.log(`✓ Discovered ${totalModels} model(s) across ${providersWithModels.join(', ') || 'installed harnesses'}`);
    console.log(`✓ Created global routing config: ${displayPath(GLOBAL_CONFIG_PATH)}`);
  } else {
    console.log(`✓ Routing config exists: ${displayPath(GLOBAL_CONFIG_PATH)} (${totalModels} host model(s) detected)`);
  }

  if (!linksOk || [...mcp.values()].some(result => result.startsWith('failed:'))) process.exitCode = 1;
  const dashboardMode = argv.includes('--dashboard') ? 'yes' : argv.includes('--no-dashboard') ? 'no' : 'ask';
  await installDashboard(dashboardMode);

  console.log('\nNext steps:');
  const firstSuccess = installHarnesses.find(([p]) => detected.has(p) && linksOk && mcp.get(p) === 'registered');
  if (firstSuccess) {
    console.log(`  relay ${firstSuccess[0]} "Describe this repository in one sentence. Do not edit files or run commands that modify it."`);
  } else {
    console.log('  See docs/GETTING_STARTED.md for provider setup and verification.');
  }
  console.log(`  Routing config: ${displayPath(GLOBAL_CONFIG_PATH)} (task-based provider & model routing)`);
}

function resolveWorkspace(value) {
  return resolveWorkspacePath(value, knownWorkspaces());
}

function latestRun(workspaceArg = null) {
  const workspace = resolveWorkspace(workspaceArg);
  if (workspaceArg && workspaceArg !== 'all' && !workspace) throw new Error('unknown workspace: ' + workspaceArg);
  return getFilteredRuns({ rawWorkspace: workspace, limit: 1, offset: 0 }).runs[0] || null;
}

function listAttention(workspaceArg = null) {
  const workspace = resolveWorkspace(workspaceArg);
  if (workspaceArg && workspaceArg !== 'all' && !workspace) throw new Error('unknown workspace: ' + workspaceArg);
  const result = getFilteredRuns({ rawWorkspace: workspace, attention: '1', limit: 200, offset: 0 });
  for (const run of result.runs) {
    const workspaceName = run.workspaceName || run.workspace || 'workspace';
    const continueCommand = run.sessionId && run.sessionId !== 'new'
      ? `subagent continue ${JSON.stringify(workspaceName)} "<follow-up task>"`
      : '';
    console.log([
      run.filename,
      run.provider,
      workspaceName,
      run.outcome || 'unknown',
      continueCommand,
    ].join('\t'));
  }
  if (result.total > result.runs.length) {
    console.error(`subagent: showing ${result.runs.length} of ${result.total} attention runs`);
  }
}

function parseDurationMs(value) {
  const match = String(value || '').match(/^(\d+)([dhm])$/);
  if (!match) return null;
  const n = Number(match[1]);
  return n * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]);
}

function pruneRuns(argv) {
  let confirm = false;
  let olderThan = null;
  let workspace = null;
  let outcome = 'all';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--confirm') {
      confirm = true;
    } else if (arg === '--dry-run') {
      confirm = false;
    } else if (arg === '--older-than') {
      olderThan = parseDurationMs(argv[++i]);
      if (olderThan === null) {
        console.error('subagent: --older-than expects value like 30d, 12h, or 90m');
        process.exit(2);
      }
    } else if (arg === '--workspace') {
      workspace = resolveWorkspace(argv[++i]);
      if (!workspace) {
        console.error('subagent: unknown workspace');
        process.exit(2);
      }
    } else if (arg === '--outcome') {
      outcome = argv[++i] || 'all';
    } else {
      console.error(`subagent: unknown prune option: ${arg}`);
      process.exit(2);
    }
  }

  const result = getFilteredRuns({ rawWorkspace: workspace === 'all' ? null : workspace, outcome, limit: 5000, offset: 0 });
  const cutoff = olderThan ? Date.now() - olderThan : null;
  const targets = result.runs.filter(run => {
    if (run.status === 'running') return false;
    if (cutoff && new Date(run.startTime).getTime() >= cutoff) return false;
    return true;
  });

  for (const run of targets) {
    const logPath = path.join(logsDir, run.filename);
    const donePath = logPath.replace(/\.log$/, '.done');
    console.log(`${confirm ? 'delete' : 'would-delete'}\t${run.filename}\t${run.workspaceName}\t${run.outcome || 'unknown'}`);
    if (confirm) {
      for (const file of [logPath, donePath]) {
        try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
      deleteRun(run.filename);
    }
  }

  console.error(`subagent: ${confirm ? 'deleted' : 'would delete'} ${targets.length} runs${confirm ? '' : ' (dry run; add --confirm)'}`);
}

function runProvider(provider, args, workspace = null) {
  const bin = providers.get(provider);
  if (!bin) {
    console.error(`subagent: unknown provider: ${provider}`);
    process.exit(2);
  }
  const child = spawnSync(path.join(repoDir, bin), args, { cwd: workspace || process.cwd(), stdio: 'inherit', env: process.env });
  process.exit(child.status ?? 1);
}

function runScript(script, args = []) {
  const child = spawnSync(path.join(repoDir, script), args, { cwd: repoDir, stdio: 'inherit', env: process.env });
  process.exit(child.status ?? 1);
}

function showResult(target = '--last') {
  if (target !== '--last') {
    const workspace = resolveWorkspace(target);
    if (workspace) {
      const run = latestRun(workspace);
      if (!run) {
        console.error('subagent: no matching runs found');
        process.exit(1);
      }
      target = run.filename;
    }
  }
  runScript('agent-wait', [target]);
}

function resolveRunTarget(target = '--last') {
  if (target === '--last') return latestRun(null);
  const workspace = resolveWorkspace(target);
  if (workspace) return latestRun(workspace);
  const filename = path.basename(target);
  return getRun(filename) || null;
}

function openRun(argv) {
  const browser = argv[0] === '--browser';
  const target = browser ? (argv[1] || '--last') : (argv[0] || '--last');
  const run = resolveRunTarget(target);
  if (!run?.filename) {
    console.error('subagent: no matching runs found');
    process.exit(1);
  }
  const baseUrl = (process.env.DASHBOARD_URL || 'http://localhost:4242').replace(/\/+$/, '');
  const url = `${baseUrl}/#run=${encodeURIComponent(run.filename)}`;
  console.log(url);
  if (browser) {
    const child = spawnSync('xdg-open', [url], { stdio: 'ignore' });
    if (child.status !== 0) console.error('subagent: xdg-open failed');
  }
}

async function dashboardStatus() {
  const url = process.env.DASHBOARD_URL || 'http://localhost:4242';
  try {
    const res = await fetch(`${url}/api/stats`);
    console.log(`${res.ok ? 'OK' : 'FAIL'}\t${url}`);
    process.exit(res.ok ? 0 : 1);
  } catch (err) {
    console.log(`FAIL\t${url}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  usage();
  process.exit(0);
}

if (args[0] === 'workspaces') {
  for (const ws of knownWorkspaces()) {
    console.log(`${ws.name}\t${ws.path}\t${ws.totalRuns || 0} runs`);
  }
  process.exit(0);
}

if (args[0] === 'init') {
  await initWorkspaces();
  process.exit(0);
}

if (args[0] === 'install') {
  await installRelay(args.slice(1));
  process.exit(process.exitCode || 0);
}

if (args[0] === 'mcp') {
  if (args[1] === 'install' || !args[1]) {
    await installMcp();
    process.exit(0);
  }
  console.error(`${cmdName}: unknown mcp command: ${args[1]}`);
  process.exit(2);
}

if (args[0] === 'config') {
  if (args[1] === 'init') {
    const isGlobal = args.includes('--global');
    const targetPath = isGlobal ? GLOBAL_CONFIG_PATH : path.join(process.cwd(), '.agent-relay.json');
    console.log('Auto-discovering host models...');
    const discovered = discoverHostModels(repoDir);
    const totalModels = Object.values(discovered).reduce((sum, list) => sum + list.length, 0);
    const providersWithModels = Object.keys(discovered).filter(k => discovered[k]?.length > 0);

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, generateConfigFileContent(discovered));
    console.log(`✓ Discovered ${totalModels} model(s) across ${providersWithModels.join(', ') || 'installed harnesses'}`);
    console.log(`✓ Wrote routing config to ${displayPath(targetPath)}`);
    process.exit(0);
  }
  console.error(`Usage: ${cmdName} config init [--global]`);
  process.exit(2);
}

if (args[0] === 'doctor') {
  runScript('agent-doctor', args.slice(1));
}

if (args[0] === 'dashboard') {
  if (args[1] === 'restart') runScript('scripts/restart-dashboard', args.slice(2));
  if (args.length > 1) {
    console.error(`subagent: unknown dashboard command: ${args[1]}`);
    process.exit(2);
  }
  await dashboardStatus();
}

if (args[0] === 'last') {
  const run = latestRun(args[1]);
  if (!run) {
    console.error('subagent: no matching runs found');
    process.exit(1);
  }
  console.log(`${run.filename}\t${run.provider}\t${run.workspaceName}\t${run.sessionId || 'new'}\t${run.outcome || 'unknown'}`);
  process.exit(0);
}

if (args[0] === 'result') {
  showResult(args[1] || '--last');
}

if (args[0] === 'open') {
  openRun(args.slice(1));
  process.exit(0);
}

if (args[0] === 'attention') {
  listAttention(args[1]);
  process.exit(0);
}

if (args[0] === 'prune') {
  pruneRuns(args.slice(1));
  process.exit(0);
}

if (args[0] === 'takeover' || args[0] === 'handoff') {
  if (args.length < 2) {
    console.error(`Usage: ${cmdName} takeover [workspace] <provider> [instructions...]`);
    process.exit(2);
  }

  let targetWorkspace = null;
  let targetProvider = null;
  let userInstructions = '';

  if (providers.has(args[1])) {
    targetProvider = args[1];
    targetWorkspace = process.cwd();
    userInstructions = args.slice(2).join(' ');
  } else {
    targetWorkspace = resolveWorkspace(args[1]);
    if (!targetWorkspace) {
      console.error(`${cmdName}: unknown workspace or provider: ${args[1]}`);
      process.exit(2);
    }
    if (!args[2] || !providers.has(args[2])) {
      console.error(`${cmdName}: takeover requires a valid target provider (${[...providers.keys()].join(', ')}). Received: ${args[2] || '(none)'}`);
      process.exit(2);
    }
    targetProvider = args[2];
    userInstructions = args.slice(3).join(' ');
  }

  const session = findLatestWorkspaceSession(targetWorkspace);
  if (!session) {
    console.error(`${cmdName}: no previous session found for workspace: ${targetWorkspace}`);
    process.exit(1);
  }

  const handoff = buildRelayTakeoverPrompt({
    sourceProvider: session.provider,
    goal: session.goal,
    lastAssistantMessage: session.lastAssistantMessage,
    touchedFiles: session.touchedFiles,
    workspace: targetWorkspace,
    userInstruction: userInstructions,
  });

  console.log(`[relay] transferring baton: ${session.provider.toUpperCase()} -> ${targetProvider.toUpperCase()}`);
  console.log(`[relay] workspace: ${targetWorkspace}`);
  console.log(`[relay] handoff reason: ${handoff.reason}`);
  if (session.touchedFiles?.length) {
    console.log(`[relay] files in flight: ${session.touchedFiles.length}`);
  }

  runProvider(targetProvider, [handoff.prompt], targetWorkspace);
}

if (args[0] === 'continue') {
  const toIndex = args.findIndex(a => a === '--to' || a === '--with');
  if (toIndex !== -1 && args[toIndex + 1]) {
    const targetProvider = args[toIndex + 1];
    if (!providers.has(targetProvider)) {
      console.error(`${cmdName}: unknown target provider for continue: ${targetProvider}`);
      process.exit(2);
    }
    const remainingArgs = args.filter((_, idx) => idx !== toIndex && idx !== toIndex + 1);
    const maybeWorkspace = resolveWorkspace(remainingArgs[1]);
    const userInstructions = (maybeWorkspace ? remainingArgs.slice(2) : remainingArgs.slice(1)).join(' ');
    const targetWorkspace = maybeWorkspace || process.cwd();

    const session = findLatestWorkspaceSession(targetWorkspace);
    if (!session) {
      console.error(`${cmdName}: no previous session found for workspace: ${targetWorkspace}`);
      process.exit(1);
    }

    const handoff = buildRelayTakeoverPrompt({
      sourceProvider: session.provider,
      goal: session.goal,
      lastAssistantMessage: session.lastAssistantMessage,
      touchedFiles: session.touchedFiles,
      workspace: targetWorkspace,
      userInstruction: userInstructions,
    });

    console.log(`[relay] transferring baton: ${session.provider.toUpperCase()} -> ${targetProvider.toUpperCase()}`);
    console.log(`[relay] workspace: ${targetWorkspace}`);
    console.log(`[relay] handoff reason: ${handoff.reason}`);
    runProvider(targetProvider, [handoff.prompt], targetWorkspace);
  }

  const maybeWorkspace = resolveWorkspace(args[1]);
  const taskArgs = maybeWorkspace ? args.slice(2) : args.slice(1);
  const task = taskArgs.join(' ');
  if (!task) {
    console.error(`${cmdName}: continue needs a follow-up task`);
    process.exit(2);
  }
  const run = latestRun(maybeWorkspace || null);
  if (!run?.sessionId || run.sessionId === 'new') {
    console.error(`${cmdName}: no resumable matching run found`);
    process.exit(1);
  }
  runProvider(run.provider, ['--resume', run.sessionId, task], maybeWorkspace || run.rawWorkspace || run.workspace);
}

if (providers.has(args[0])) runProvider(args[0], args.slice(1));

const workspace = resolveWorkspace(args[0]);
if (workspace && providers.has(args[1])) runProvider(args[1], args.slice(2), workspace);

console.error(`subagent: unknown command, provider, or workspace: ${args[0]}`);
usage();
process.exit(2);
