#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getFilteredRuns, getRun, getWorkspacesFromDb } from '../dashboard/db.js';
import { buildRunCommands } from '../dashboard/commands.js';
import { canonicalWorkspacePath, configuredWorkspaceEntries } from '../dashboard/workspaces.js';

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), '..');
const logsDir = process.env.AGENT_RELAY_LOG_DIR || process.env.SUBAGENT_LOG_DIR || path.join(repoDir, 'logs');
const providers = new Set(['opencode', 'codex', 'claude', 'antigravity']);

const tools = [
  {
    name: 'run_agent',
    description: 'Run a delegated coding agent (opencode, codex, claude, antigravity) in a target workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: [...providers],
          description: 'The agent provider to run (opencode, codex, claude, antigravity).',
        },
        prompt: {
          type: 'string',
          description: 'The task instructions for the delegated agent.',
        },
        workspace: {
          type: 'string',
          description: 'Target workspace directory or alias. Defaults to current directory.',
        },
        model: {
          type: 'string',
          description: 'Optional model selector or family alias (e.g. latest, gemini-flash, opus).',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session ID to resume or continue an existing session.',
        },
        timeoutSeconds: {
          type: 'integer',
          minimum: 1,
          maximum: 86400,
          description: 'Timeout in seconds (default 7200).',
        },
        wait: {
          type: 'boolean',
          description: 'Wait for completion and return structured result contract (default true). If false, launches in background.',
        },
      },
      required: ['provider', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_workspaces',
    description: 'List known agent-relay workspaces from configured aliases and run history.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_runs',
    description: 'List indexed agent runs from subagents.db with optional filters.',
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
    description: 'Run agent-doctor and return its output.',
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
  if (name === 'run_agent') {
    if (!args.provider || !providers.has(args.provider)) {
      throw new Error(`unknown provider: ${args.provider}. Supported: ${[...providers].join(', ')}`);
    }
    if (!args.prompt || typeof args.prompt !== 'string') {
      throw new Error('prompt is required');
    }

    const targetWorkspace = resolveWorkspace(args.workspace) || (args.workspace ? path.resolve(args.workspace) : process.cwd());
    if (!fs.existsSync(targetWorkspace)) {
      throw new Error(`workspace directory does not exist: ${targetWorkspace}`);
    }

    const wrapperBin = path.join(repoDir, `${args.provider}-agent`);
    if (!fs.existsSync(wrapperBin)) {
      throw new Error(`agent wrapper not found: ${wrapperBin}`);
    }

    const env = { ...process.env };
    if (args.model) {
      if (args.provider === 'opencode') env.OPENCODE_MODEL = args.model;
      else if (args.provider === 'codex') env.CODEX_MODEL = args.model;
      else if (args.provider === 'claude') env.CLAUDE_MODEL = args.model;
      else if (args.provider === 'antigravity') env.AGY_MODEL = args.model;
    }
    if (args.sessionId) {
      env.AGENT_RELAY_SESSION = args.sessionId;
    }
    if (args.timeoutSeconds) {
      if (args.provider === 'opencode') env.OPENCODE_TIMEOUT = String(args.timeoutSeconds);
      else if (args.provider === 'codex') env.CODEX_TIMEOUT = String(args.timeoutSeconds);
      else if (args.provider === 'claude') env.CLAUDE_TIMEOUT = String(args.timeoutSeconds);
      else if (args.provider === 'antigravity') env.AGY_PRINT_TIMEOUT = `${args.timeoutSeconds}s`;
    }

    const wait = args.wait !== false;
    if (!wait) {
      const child = spawn(wrapperBin, [args.prompt], {
        cwd: targetWorkspace,
        env,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();

      // Brief delay to allow wrapper to initialize and record run start in SQLite
      await new Promise(resolve => setTimeout(resolve, 600));
      const run = latestRun(targetWorkspace);
      return {
        status: 'launched',
        pid: child.pid,
        workspace: targetWorkspace,
        provider: args.provider,
        filename: run?.filename || null,
        message: 'Agent launched in background. Use wait_for_run or get_run_result to check status.',
      };
    }

    const timeoutMs = (args.timeoutSeconds || 7200) * 1000;
    const child = spawnSync(wrapperBin, [args.prompt], {
      cwd: targetWorkspace,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
    });

    const run = latestRun(targetWorkspace);
    if (run) {
      return runResult(run);
    }
    return {
      status: child.status === 0 ? 'completed' : 'failed',
      exitCode: child.status,
      stdout: child.stdout,
      stderr: child.stderr,
    };
  }
  if (name === 'list_workspaces') return { workspaces: knownWorkspaces() };
  if (name === 'list_runs') {
    const workspace = args.workspace ? resolveWorkspace(args.workspace) : 'all';
    if (args.workspace && !workspace) throw new Error('unknown workspace: ' + args.workspace);
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
    if (!fs.existsSync(file)) throw new Error('log file not found: ' + file);
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
    if (!fs.existsSync(file)) throw new Error('log file not found: ' + file);
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
    const command = [path.join(repoDir, 'relay'), 'continue'];
    if (workspace) command.push(path.basename(workspace));
    if (args.provider) command.push('--to', args.provider);
    command.push(args.prompt);
    return maybeExecute(command, Boolean(args.execute));
  }
  if (name === 'takeover_run') {
    const command = [path.join(repoDir, 'relay'), 'takeover'];
    if (args.workspace) {
      const workspace = resolveWorkspace(args.workspace);
      if (!workspace) throw new Error(`unknown workspace: ${args.workspace}`);
      command.push(workspace);
    }
    command.push(args.provider);
    if (args.instructions) command.push(args.instructions);
    return maybeExecute(command, Boolean(args.execute));
  }
  if (name === 'doctor') {
    const child = spawnSync(path.join(repoDir, 'agent-doctor'), [], { cwd: repoDir, encoding: 'utf8', env: process.env });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  }
  throw new Error(`unknown tool: ${name}`);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
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
    result(message.id, { isError: true, content: [{ type: 'text', text: err?.message || String(err) }] });
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); } catch (err) { error(null, err, -32700); }
});
