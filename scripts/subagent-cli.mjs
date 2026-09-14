#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalWorkspacePath, configuredWorkspaceEntries } from '../dashboard/workspaces.js';
import { deleteRun, getFilteredRuns, getRun, getWorkspacesFromDb } from '../dashboard/db.js';

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), '..');
const logsDir = process.env.SUBAGENT_LOG_DIR || path.join(repoDir, 'logs');
const providers = new Map([
  ['opencode', 'opencode-subagent'],
  ['codex', 'codex-subagent'],
  ['claude', 'claude-subagent'],
  ['antigravity', 'antigravity-subagent'],
  ['agy', 'antigravity-subagent'],
]);

function usage() {
  console.log(`Usage:
  subagent <provider> [wrapper-args...] "task"
  subagent <workspace> <provider> [wrapper-args...] "task"
  subagent workspaces
  subagent doctor
  subagent dashboard [restart]
  subagent attention [workspace]
  subagent prune [--confirm] [--older-than 30d] [--workspace name] [--outcome outcome]
  subagent result [--last | workspace | log-or-pid]
  subagent open [--browser] [--last | workspace | log]
  subagent last [workspace]
  subagent continue [workspace] "task"

Providers: ${[...providers.keys()].join(', ')}`);
}

function knownWorkspaces() {
  const byPath = new Map();
  for (const ws of getWorkspacesFromDb()) byPath.set(ws.path, ws);
  for (const ws of configuredWorkspaceEntries()) {
    const canonical = canonicalWorkspacePath(ws.path) || ws.path.replace(/\/+$/, '');
    if (!byPath.has(canonical)) byPath.set(canonical, { path: canonical, name: ws.name, totalRuns: 0, activeRuns: 0 });
  }
  return [...byPath.values()];
}

function resolveWorkspace(value) {
  if (!value) return null;
  const configured = configuredWorkspaceEntries().find(ws => ws.name.toLowerCase() === value.toLowerCase());
  if (configured) return canonicalWorkspacePath(configured.path) || configured.path.replace(/\/+$/, '');
  const direct = canonicalWorkspacePath(value) || (path.isAbsolute(value) ? value.replace(/\/+$/, '') : null);
  if (direct) return direct;
  const lower = value.toLowerCase();
  return knownWorkspaces().find(ws => ws.name.toLowerCase() === lower || path.basename(ws.path).toLowerCase() === lower)?.path || null;
}

function latestRun(workspaceArg = null) {
  const workspace = resolveWorkspace(workspaceArg);
  const result = getFilteredRuns({ workspace: workspace || 'all', limit: 200, offset: 0 });
  return result.runs.find(run => run.sessionId && run.sessionId !== 'new') || result.runs[0] || null;
}

function listAttention(workspaceArg = null) {
  const workspace = resolveWorkspace(workspaceArg);
  const result = getFilteredRuns({ workspace: workspace || 'all', attention: '1', limit: 200, offset: 0 });
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

  const result = getFilteredRuns({ workspace: workspace || 'all', outcome, limit: 5000, offset: 0 });
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
  runScript('subagent-wait', [target]);
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

if (args[0] === 'doctor') {
  runScript('subagent-doctor', args.slice(1));
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

if (args[0] === 'continue') {
  const maybeWorkspace = resolveWorkspace(args[1]);
  const taskArgs = maybeWorkspace ? args.slice(2) : args.slice(1);
  const task = taskArgs.join(' ');
  if (!task) {
    console.error('subagent: continue needs a follow-up task');
    process.exit(2);
  }
  const run = latestRun(maybeWorkspace || null);
  if (!run?.sessionId || run.sessionId === 'new') {
    console.error('subagent: no resumable matching run found');
    process.exit(1);
  }
  runProvider(run.provider, ['--resume', run.sessionId, task], maybeWorkspace || run.workspace);
}

if (providers.has(args[0])) runProvider(args[0], args.slice(1));

const workspace = resolveWorkspace(args[0]);
if (workspace && providers.has(args[1])) runProvider(args[1], args.slice(2), workspace);

console.error(`subagent: unknown command, provider, or workspace: ${args[0]}`);
usage();
process.exit(2);
