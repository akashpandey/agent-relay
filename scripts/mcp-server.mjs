#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getFilteredRuns, getRun, getWorkspacesFromDb, registerRunComplete } from '../dashboard/db.js';
import { buildRunCommands } from '../dashboard/commands.js';
import { canonicalWorkspacePath, configuredWorkspaceEntries } from '../dashboard/workspaces.js';
import { findLatestWorkspaceSession, buildRelayTakeoverPrompt, getWorkspaceGitContext } from './relay-handoff.mjs';
import {
  getOpenCodeSessionDetails,
  getClaudeSessionDetails,
  getCodexSessionDetails,
  findAntigravityTranscript,
} from '../dashboard/parser.js';

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
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          description: 'Optional reasoning effort for supported providers (codex, claude).',
        },
        continueLatest: {
          type: 'boolean',
          description: 'Continue/resume the latest session in target workspace without specifying sessionId.',
        },
        sandbox: {
          type: 'string',
          enum: ['workspace-write', 'danger-full-access'],
          description: 'Sandbox mode for Codex (defaults to workspace-write).',
        },
        fallbackChain: {
          type: 'string',
          description: 'Comma-separated model chain for OpenCode fallback (e.g. zai-coding-plan/glm-5.3,openai/gpt-5.4-mini).',
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
        since: { type: 'string', description: 'Filter runs started on or after this ISO date/time (e.g. 2026-09-16).' },
        until: { type: 'string', description: 'Filter runs started on or before this ISO date/time.' },
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
    name: 'get_session_history',
    description: 'Retrieve detailed conversation history, goals, touched files, tokens, and assistant reasoning for a past session or run.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Run filename, workspace name, or --last.' },
        sessionId: { type: 'string', description: 'Provider session ID if known.' },
        provider: { type: 'string', enum: [...providers], description: 'Optional provider name if sessionId is provided directly.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'takeover_run',
    description: 'Synthesize or execute a cross-harness relay handoff baton prompt (goal, touched files, last activity, uncommitted diffs) to transition tasks between agents.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Target workspace directory or alias. Defaults to current directory.' },
        provider: { type: 'string', enum: [...providers], description: 'Target provider that will receive the baton.' },
        instructions: { type: 'string', description: 'Additional instructions for the takeover agent.' },
        execute: { type: 'boolean', description: 'Default false. When false, returns the complete baton prompt and context. When true, immediately executes the takeover.' },
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
  {
    name: 'list_models',
    description: 'List available models and dynamic family aliases for coding agent providers.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          enum: ['all', ...providers],
          description: 'Optional provider to query (opencode, codex, claude, antigravity, or all). Defaults to all.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'kill_run',
    description: 'Safely terminate a running agent process tree by filename, workspace, or --last.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Run filename, workspace name, or --last. Defaults to --last.',
        },
      },
      additionalProperties: false,
    },
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

    let wrapperName = `${args.provider}-agent`;
    const env = { ...process.env };

    if (args.provider === 'opencode' && args.fallbackChain) {
      wrapperName = 'opencode-agent-fallback';
      env.OPENCODE_MODEL_CHAIN = args.fallbackChain;
    }

    const wrapperBin = path.join(repoDir, wrapperName);
    if (!fs.existsSync(wrapperBin)) {
      throw new Error(`agent wrapper not found: ${wrapperBin}`);
    }

    if (args.model) {
      if (args.provider === 'opencode') env.OPENCODE_MODEL = args.model;
      else if (args.provider === 'codex') env.CODEX_MODEL = args.model;
      else if (args.provider === 'claude') env.CLAUDE_MODEL = args.model;
      else if (args.provider === 'antigravity') env.AGY_MODEL = args.model;
    }
    if (args.effort) {
      if (args.provider === 'codex') env.CODEX_EFFORT = args.effort;
      else if (args.provider === 'claude') env.CLAUDE_EFFORT = args.effort;
    }
    if (args.sandbox && args.provider === 'codex') {
      env.CODEX_SANDBOX = args.sandbox;
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

    const wrapperArgs = [];
    if (args.continueLatest) {
      wrapperArgs.push('--continue');
    }
    wrapperArgs.push(args.prompt);

    const wait = args.wait !== false;
    if (!wait) {
      const child = spawn(wrapperBin, wrapperArgs, {
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
    const child = spawnSync(wrapperBin, wrapperArgs, {
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
      since: args.since,
      until: args.until,
      q: args.q || '',
      limit: args.limit || 50,
      offset: 0,
    });
  }
  if (name === 'get_session_history') {
    let provider = args.provider;
    let sessionId = args.sessionId;
    let workspace = args.workspace ? resolveWorkspace(args.workspace) : null;
    let startTime = null;

    if (args.target) {
      const run = resolveRunTarget(args.target);
      if (run) {
        provider = provider || run.provider;
        sessionId = sessionId || run.sessionId;
        workspace = workspace || run.workspace;
        startTime = run.startTime;
      }
    }

    if (!sessionId && !args.target) {
      const run = latestRun(workspace || null);
      if (run) {
        provider = provider || run.provider;
        sessionId = sessionId || run.sessionId;
        workspace = workspace || run.workspace;
        startTime = run.startTime;
      }
    }

    if (!sessionId && !provider && !args.target) {
      throw new Error('target, sessionId, or provider is required to retrieve session history');
    }

    let details = null;
    try {
      if (provider === 'opencode' && sessionId) {
        details = getOpenCodeSessionDetails(sessionId);
      } else if (provider === 'claude') {
        details = getClaudeSessionDetails(sessionId, startTime, workspace);
      } else if (provider === 'codex') {
        details = getCodexSessionDetails(sessionId, startTime, workspace);
      } else if (provider === 'antigravity') {
        details = findAntigravityTranscript(sessionId, startTime, workspace);
      }
    } catch {}

    if (details) {
      return {
        provider,
        sessionId,
        workspace,
        ...details,
      };
    }

    // Fallback to indexed SQLite run metadata and summary
    const run = resolveRunTarget(args.target || '--last');
    if (run) {
      return {
        provider: run.provider,
        sessionId: run.sessionId,
        workspace: run.workspace,
        task: run.task,
        model: run.model,
        startTime: run.startTime,
        status: run.status,
        outcome: run.outcome,
        summary: run.markdownSummary || run.result?.summary || '',
        filesModified: run.filesModified || run.result?.changedFiles || [],
        source: 'subagents.db',
      };
    }

    throw new Error(`session history not found for session: ${sessionId || args.target}`);
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
    const targetWorkspace = resolveWorkspace(args.workspace) || (args.workspace ? path.resolve(args.workspace) : process.cwd());
    if (!fs.existsSync(targetWorkspace)) {
      throw new Error(`workspace directory does not exist: ${targetWorkspace}`);
    }

    const session = findLatestWorkspaceSession(targetWorkspace);
    if (!session) {
      throw new Error(`no previous session found for workspace: ${targetWorkspace}`);
    }

    const handoff = buildRelayTakeoverPrompt({
      sourceProvider: session.provider,
      goal: session.goal,
      lastAssistantMessage: session.lastAssistantMessage,
      touchedFiles: session.touchedFiles,
      workspace: targetWorkspace,
      userInstruction: args.instructions || '',
    });

    const git = getWorkspaceGitContext(targetWorkspace);

    if (!args.execute) {
      return {
        sourceProvider: session.provider,
        targetProvider: args.provider,
        workspace: targetWorkspace,
        goal: session.goal,
        reason: handoff.reason,
        touchedFiles: session.touchedFiles,
        lastAssistantMessage: session.lastAssistantMessage ? String(session.lastAssistantMessage).slice(-1000) : null,
        prompt: handoff.prompt,
        git,
        executed: false,
      };
    }

    return await callTool('run_agent', {
      provider: args.provider,
      prompt: handoff.prompt,
      workspace: targetWorkspace,
      wait: true,
    });
  }
  if (name === 'doctor') {
    const child = spawnSync(path.join(repoDir, 'agent-doctor'), [], { cwd: repoDir, encoding: 'utf8', env: process.env });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  }
  if (name === 'list_models') {
    const targetProvider = args.provider || 'all';
    const queryProvider = (prov) => {
      const bin = path.join(repoDir, `${prov}-agent`);
      if (!fs.existsSync(bin)) return { provider: prov, error: 'wrapper not found' };
      const res = spawnSync(bin, ['--models'], { encoding: 'utf8', env: process.env });
      const models = (res.stdout || '')
        .split('\n')
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#') && !s.toLowerCase().includes('usage:') && !s.toLowerCase().includes('selectors:'));
      return { provider: prov, models };
    };

    if (targetProvider !== 'all') {
      if (!providers.has(targetProvider)) throw new Error(`unknown provider: ${targetProvider}`);
      return queryProvider(targetProvider);
    }
    const result = {};
    for (const p of providers) {
      result[p] = queryProvider(p).models;
    }
    return { providers: result };
  }
  if (name === 'kill_run') {
    const run = resolveRunTarget(args.target || '--last');
    if (!run) throw new Error('run not found');
    if (run.status !== 'running') {
      return { filename: run.filename, killed: false, message: `Run is not running (status: ${run.status})` };
    }
    if (!run.pid) {
      return { filename: run.filename, killed: false, message: 'Run has no recorded PID' };
    }

    try {
      spawnSync('pkill', ['-TERM', '-P', String(run.pid)]);
      process.kill(run.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          spawnSync('pkill', ['-KILL', '-P', String(run.pid)]);
          process.kill(run.pid, 'SIGKILL');
        } catch {}
      }, 500);

      // Extract session ID from log file if missing
      let sessionId = (run.sessionId && run.sessionId !== 'new') ? run.sessionId : null;
      const logFilePath = path.join(logsDir, run.filename);
      const doneFilePath = logFilePath.replace(/\.log$/, '.done');
      if (!sessionId && fs.existsSync(logFilePath)) {
        try {
          const content = fs.readFileSync(logFilePath, 'utf8');
          const m = content.match(/session\.id=([^\s]+)/i) ||
                    content.match(/"conversation_id":"([^"]+)"/i) ||
                    content.match(/"session_id":"([^"]+)"/i) ||
                    content.match(/session id:\s*([^\r\n]+)/i);
          if (m) sessionId = m[1].trim();
        } catch {}
      }

      if (!fs.existsSync(doneFilePath) && fs.existsSync(logFilePath)) {
        try {
          fs.writeFileSync(doneFilePath, JSON.stringify({
            status: 'failed',
            exitCode: 143,
            provider: run.provider,
            workspace: run.workspace,
            model: run.model,
            sessionId: sessionId || 'new',
            logFile: logFilePath,
            completedAt: new Date().toISOString()
          }, null, 2) + '\n');
        } catch {}
      }

      try {
        registerRunComplete({
          filename: run.filename,
          exitCode: 143,
          status: 'failed',
          sessionId: sessionId || null,
        });
      } catch {}

      const { continuation } = buildRunCommands(run, sessionId);
      return {
        filename: run.filename,
        pid: run.pid,
        killed: true,
        sessionId: sessionId || null,
        continuation,
        message: `Killed process tree of PID ${run.pid}. Session ID ${sessionId ? `captured (${sessionId})` : 'not found'}.`
      };
    } catch (err) {
      return { filename: run.filename, pid: run.pid, killed: false, error: err.message };
    }
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
