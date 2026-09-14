#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalWorkspacePath, configuredWorkspaceEntries } from '../dashboard/workspaces.js';
import { getFilteredRuns, getWorkspacesFromDb } from '../dashboard/db.js';

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), '..');
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

function runProvider(provider, args, workspace = null) {
  const bin = providers.get(provider);
  if (!bin) {
    console.error(`subagent: unknown provider: ${provider}`);
    process.exit(2);
  }
  const child = spawnSync(path.join(repoDir, bin), args, { cwd: workspace || process.cwd(), stdio: 'inherit', env: process.env });
  process.exit(child.status ?? 1);
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

if (args[0] === 'last') {
  const run = latestRun(args[1]);
  if (!run) {
    console.error('subagent: no matching runs found');
    process.exit(1);
  }
  console.log(`${run.filename}\t${run.provider}\t${run.workspaceName}\t${run.sessionId || 'new'}\t${run.outcome || 'unknown'}`);
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
