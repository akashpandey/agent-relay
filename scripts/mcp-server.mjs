#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getFilteredRuns, getRun, getWorkspacesFromDb } from '../dashboard/db.js';
import { buildRunCommands } from '../dashboard/commands.js';
import { canonicalWorkspacePath, configuredWorkspaceEntries } from '../dashboard/workspaces.js';

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), '..');
const logsDir = process.env.SUBAGENT_LOG_DIR || path.join(repoDir, 'logs');
const providers = new Set(['opencode', 'codex', 'claude', 'antigravity']);

const tools = [
  {
    name: 'list_workspaces',
    description: 'List known agent-relay workspaces from configured aliases and run history.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_runs',
    description: 'List indexed subagent runs from subagents.db with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name or absolute path, or all.' },
        provider: { type: 'string', enum: ['all', ...providers] },
        status: { type: 'string', enum: ['all', 'running', 'completed', 'failed', 'empty'] },
        outcome: { type: 'string', enum: ['all', 'done', 'partial', 'blocked', 'failed', 'unknown'] },
        attention: { type: 'boolean' },
        q: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_run_result',
    description: 'Return the structured acceptance contract for a run. Use this instead of tailing logs.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Run filename, workspace name, or --last.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for_run',
    description: 'Wait until a run is no longer running, then return its structured result.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Run filename, workspace name, or --last.' },
        timeoutMs: { type: 'integer', minimum: 0, maximum: 600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_log_tail',
    description: 'Return the tail of a raw run log for diagnostics only.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Run filename, workspace name, or --last.' },
        bytes: { type: 'integer', minimum: 1, maximum: 1048576 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_log',
    description: 'Search a raw run log for diagnostic text.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Run filename, workspace name, or --last.' },
        q: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
  {
    name: 'continue_run',
    description: 'Build or execute a same-workspace continuation command for the latest run.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        prompt: { type: 'string' },
        provider: { type: 'string', enum: [...providers] },
        execute: { type: 'boolean', description: 'Default false. When false, returns the command only.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'takeover_run',
    description: 'Build or execute a cross-harness relay takeover command.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        provider: { type: 'string', enum: [...providers] },
        instructions: { type: 'string' },
        execute: { type: 'boolean', description: 'Default false. When false, returns the command only.' },
      },
      required: ['provider'],
      additionalProperties: false,
    },
  },
  {
    name: 'doctor',
    description: 'Run subagent-doctor and return its output.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

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
  if (!value || value === 'all') return null;
  const configured = configuredWorkspaceEntries().find(ws => ws.name.toLowerCase() === String(value).toLowerCase());
  if (configured) return canonicalWorkspacePath(configured.path) || configured.path.replace(/\/+$/, '');
  const direct = canonicalWorkspacePath(value) || (path.isAbsolute(value) ? value.replace(/\/+$/, '') : null);
  if (direct) return direct;
  const lower = String(value).toLowerCase();
  return knownWorkspaces().find(ws => ws.name.toLowerCase() === lower || path.basename(ws.path).toLowerCase() === lower)?.path || null;
}

function latestRun(workspaceArg = null) {
  const workspace = resolveWorkspace(workspaceArg);
  const result = getFilteredRuns({ workspace: workspace || 'all', limit: 200, offset: 0 });
  return result.runs.find(run => run.sessionId && run.sessionId !== 'new') || result.runs[0] || null;
}

function resolveRunTarget(target = '--last') {
  if (!target || target === '--last') return latestRun(null);
  const workspace = resolveWorkspace(target);
  if (workspace) return latestRun(workspace);
  return getRun(path.basename(target)) || null;
}

function runResult(run) {
  if (!run) throw new Error('run not found');
  const result = run.result || null;
  const sessionId = run.sessionId || run.session || null;
  const outcome = run.outcome || result?.outcome || 'unknown';
  const attentionRequired = Boolean(run.attentionRequired || result?.attentionRequired);
  const { runAgainCommand, continuation } = buildRunCommands(run, sessionId);
  return {
    filename: run.filename,
    processStatus: run.status,
    exitCode: run.exitCode ?? null,
    outcome,
    attentionRequired,
    accepted: outcome === 'done' && !attentionRequired,
    blockers: result?.blockers || [],
    incomplete: result?.incomplete || [],
    verification: result?.verification || [],
    changedFiles: result?.changedFiles?.length ? result.changedFiles : (run.filesModified || []),
    nextSteps: result?.nextSteps || [],
    summary: result?.summary || run.markdownSummary || '',
    logAvailable: run.logAvailable !== false,
    logFile: path.join(logsDir, run.filename),
    sessionId,
    continuation,
    runAgainCommand,
    provider: run.provider,
    model: run.model,
  };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

function maybeExecute(command, execute) {
  if (!execute) return { command, executed: false };
  const child = spawnSync(command[0], command.slice(1), { cwd: repoDir, encoding: 'utf8', env: process.env });
  return { command: command.map(shellQuote).join(' '), executed: true, status: child.status, stdout: child.stdout, stderr: child.stderr };
}

async function callTool(name, args = {}) {
  if (name === 'list_workspaces') return { workspaces: knownWorkspaces() };
  if (name === 'list_runs') {
    const workspace = resolveWorkspace(args.workspace) || 'all';
    return getFilteredRuns({
      workspace,
      provider: args.provider || 'all',
      status: args.status || 'all',
      outcome: args.outcome || 'all',
      attention: args.attention ? '1' : undefined,
      q: args.q || '',
      limit: args.limit || 50,
      offset: 0,
    });
  }
  if (name === 'get_run_result') return runResult(resolveRunTarget(args.target || '--last'));
  if (name === 'wait_for_run') {
    const timeoutMs = args.timeoutMs ?? 120000;
    const deadline = Date.now() + timeoutMs;
    let run = resolveRunTarget(args.target || '--last');
    while (run?.status === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      run = getRun(run.filename) || run;
    }
    return runResult(run);
  }
  if (name === 'get_log_tail') {
    const run = resolveRunTarget(args.target || '--last');
    if (!run) throw new Error('run not found');
    const file = path.join(logsDir, run.filename);
    const stat = fs.statSync(file);
    const bytes = Math.min(args.bytes || 65536, stat.size);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    fs.readSync(fd, buf, 0, bytes, stat.size - bytes);
    fs.closeSync(fd);
    return { filename: run.filename, offset: stat.size - bytes, size: stat.size, text: buf.toString('utf8') };
  }
  if (name === 'search_log') {
    const run = resolveRunTarget(args.target || '--last');
    if (!run) throw new Error('run not found');
    const file = path.join(logsDir, run.filename);
    const q = String(args.q || '').toLowerCase();
    const limit = args.limit || 50;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const matches = [];
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      if (lines[i].toLowerCase().includes(q)) matches.push({ line: i + 1, text: lines[i].slice(0, 1000) });
    }
    return { filename: run.filename, q: args.q, count: matches.length, matches };
  }
  if (name === 'continue_run') {
    const workspace = args.workspace ? resolveWorkspace(args.workspace) : null;
    const command = ['relay', 'continue'];
    if (workspace) command.push(path.basename(workspace));
    if (args.provider) command.push('--to', args.provider);
    command.push(args.prompt);
    return maybeExecute(command, Boolean(args.execute));
  }
  if (name === 'takeover_run') {
    const command = ['relay', 'takeover'];
    if (args.workspace) command.push(args.workspace);
    command.push(args.provider);
    if (args.instructions) command.push(args.instructions);
    return maybeExecute(command, Boolean(args.execute));
  }
  if (name === 'doctor') {
    const child = spawnSync(path.join(repoDir, 'subagent-doctor'), [], { cwd: repoDir, encoding: 'utf8', env: process.env });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  }
  throw new Error(`unknown tool: ${name}`);
}

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, err, code = -32000) {
  send({ jsonrpc: '2.0', id, error: { code, message: err?.message || String(err) } });
}

async function handle(message) {
  if (!message || !message.method) return;
  try {
    if (message.method === 'initialize') {
      result(message.id, {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-relay', version: '1.0.0' },
      });
    } else if (message.method === 'tools/list') {
      result(message.id, { tools });
    } else if (message.method === 'tools/call') {
      const payload = await callTool(message.params?.name, message.params?.arguments || {});
      result(message.id, { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });
    } else if (message.method === 'ping') {
      result(message.id, {});
    } else if (message.id !== undefined) {
      error(message.id, `unsupported method: ${message.method}`, -32601);
    }
  } catch (err) {
    error(message.id, err);
  }
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep === -1) return;
    const header = buffer.slice(0, sep).toString('utf8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(sep + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = sep + 4;
    if (buffer.length < start + length) return;
    const body = buffer.slice(start, start + length).toString('utf8');
    buffer = buffer.slice(start + length);
    try { handle(JSON.parse(body)); } catch (err) { error(null, err, -32700); }
  }
});
