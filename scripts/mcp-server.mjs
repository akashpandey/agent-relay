#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getFilteredRuns, getRun, getWorkspacesFromDb, upsertRun } from '../dashboard/db.js';
import { buildRunCommands } from '../dashboard/commands.js';
import { resolveWorkspacePath, configuredWorkspaceEntries } from '../dashboard/workspaces.js';
import { findLatestWorkspaceSession, buildRelayTakeoverPrompt, getWorkspaceGitContext } from './relay-handoff.mjs';
import { loadRoutingConfig, matchRoute } from './routing-config.mjs';
import {
  getOpenCodeSessionDetails,
  getClaudeSessionDetails,
  getCodexSessionDetails,
  findAntigravityTranscript,
  parseLogMetadata,
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
          description: 'Explicit provider. Omit to select one from the workspace routing config.',
        },
        route: { type: 'string', description: 'Named routing rule in the workspace config (for example, backend or ui).' },
        targetPath: { type: 'string', description: 'Optional workspace-relative file path for pattern matching when provider and route are omitted.' },
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
      required: ['prompt'],
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
        workspace: { type: 'string', description: 'Optional exact workspace path or alias.' },
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
    const actual = path.resolve(ws.path);
    byPath.set(actual, { totalRuns: 0, activeRuns: 0, ...byPath.get(actual), path: actual, name: ws.name });
  }
  return [...byPath.values()];
}

function resolveWorkspace(value) {
  return resolveWorkspacePath(value, knownWorkspaces());
}

function executionWorkspace(value) {
  const workspace = value ? resolveWorkspace(value) : process.cwd();
  if (!workspace) throw new Error('unknown workspace: ' + value);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error('workspace directory does not exist: ' + workspace);
  }
  return workspace;
}

function refreshRun(run) {
  if (!run) return null;
  const file = path.join(logsDir, run.filename);
  if (!fs.existsSync(file)) return run;
  const meta = parseLogMetadata(run.filename, file, '/proc', { enrich: false });
  if (!meta) return run;
  for (const key of ['tokens', 'cost', 'toolCalls', 'diffs', 'filesModified', 'markdownSummary']) {
    if (run[key] != null) meta[key] = run[key];
  }
  upsertRun(meta);
  return { ...run, ...meta, rawWorkspace: meta.workspace };
}

function latestRun(workspaceArg = null) {
  const workspace = resolveWorkspace(workspaceArg);
  if (workspaceArg && !workspace) throw new Error('unknown workspace: ' + workspaceArg);
  return refreshRun(getFilteredRuns({ rawWorkspace: workspace, limit: 1, offset: 0 }).runs[0]);
}

function resolveRunTarget(target = '--last') {
  if (!target || target === '--last') return latestRun(null);
  const indexed = getRun(path.basename(target));
  if (indexed) return refreshRun(indexed);
  if (/^\d+$/.test(target)) {
    for (const provider of providers) {
      const run = launchedRun(Number(target), provider);
      if (run) return run;
    }
    return null;
  }
  const file = path.join(logsDir, path.basename(target));
  if (fs.existsSync(file)) return refreshRun({ filename: path.basename(target) });
  const workspace = resolveWorkspace(target);
  if (workspace) return latestRun(workspace);
  return null;
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
    accepted: run.status === 'completed' && (run.exitCode == null || run.exitCode === 0) && outcome === 'done' && !attentionRequired,
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

function processIdentity(pid) {
  try {
    if (fs.existsSync('/proc')) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1).split(' ');
      if (stat[0] === 'Z') return null;
      return stat[19] + ' ' + fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    }
    const info = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'args='], { encoding: 'utf8' });
    return info.status === 0 ? info.stdout.trim() || null : null;
  } catch { return null; }
}

function startCommand(command, options = {}) {
  const child = spawn(command[0], command.slice(1), {
    cwd: repoDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], ...options,
  });
  // Keep only the output tail; the wrappers persist the full log themselves.
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-65536); });
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65536); });
  const completion = new Promise(resolve => {
    child.once('error', error => resolve({ status: null, error: error.message, stdout, stderr }));
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, completion };
}

function launchedRun(pid, provider, previousLogs = new Set()) {
  if (!pid || !fs.existsSync(logsDir)) return null;
  const filename = fs.readdirSync(logsDir).sort().reverse().find(f => !previousLogs.has(f) && f.endsWith(`-${provider}-${pid}.log`));
  return filename ? refreshRun(getRun(filename) || { filename }) : null;
}

async function callTool(name, args = {}) {
  const tool = tools.find(tool => tool.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  for (const key of tool.inputSchema.required || []) {
    if (args[key] === undefined) throw new Error(`${key} is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = tool.inputSchema.properties[key];
    if (!schema) throw new Error(`unknown argument: ${key}`);
    if (schema.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== schema.type) {
      throw new Error(`${key} must be ${schema.type}`);
    }
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`unknown ${key}: ${value}`);
    if ((schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum)) {
      throw new Error(`${key} is outside the allowed range`);
    }
  }
  if ('prompt' in args && !args.prompt.trim()) throw new Error('prompt is required');
  if (args.sessionId && !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(args.sessionId)) {
    throw new Error('invalid sessionId');
  }
  if (args.sessionId && args.continueLatest) throw new Error('sessionId and continueLatest cannot be combined');
  if (name === 'run_agent') {
    if (args.provider && !providers.has(args.provider)) {
      throw new Error(`unknown provider: ${args.provider}. Supported: ${[...providers].join(', ')}`);
    }
    if (!args.prompt || typeof args.prompt !== 'string') {
      throw new Error('prompt is required');
    }

    const targetWorkspace = executionWorkspace(args.workspace);
    if (!args.provider) {
      const loaded = loadRoutingConfig(targetWorkspace);
      if (!loaded) throw new Error('no routing config found; specify a provider or run relay config init');
      if (loaded.error) throw new Error(`invalid routing config ${loaded.configFile}: ${loaded.error}`);
      const route = matchRoute(loaded.config, args.prompt, args.targetPath, args.route);
      if (!route) throw new Error(args.route ? `unknown route: ${args.route}` : 'no routing rule matched and no default provider is configured');
      args = { ...args, provider: route.provider, model: args.model || route.model };
    }
    if (!providers.has(args.provider)) throw new Error(`unknown provider in routing config: ${args.provider}`);

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
    } else {
      delete env.AGENT_RELAY_SESSION;
      delete env.SUBAGENT_SESSION;
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

    const previousLogs = new Set(fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : []);
    const { child, completion } = startCommand([wrapperBin, ...wrapperArgs], {
      cwd: targetWorkspace, env, detached: true,
      ...(args.wait === false ? { stdio: 'ignore' } : {}),
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    if (args.wait === false) {
      // Background runs must not keep the MCP process alive through their pipes.
      child.unref();
      let run = null;
      for (let i = 0; i < 20 && !run; i++) {
        run = launchedRun(child.pid, args.provider, previousLogs);
        if (!run) await new Promise(resolve => setTimeout(resolve, 100));
      }
      return {
        status: 'launched',
        pid: child.pid,
        workspace: targetWorkspace,
        provider: args.provider,
        filename: run?.filename || null,
        target: run?.filename || String(child.pid),
        message: 'Agent launched in background. Use wait_for_run or get_run_result to check status.',
      };
    }

    let cancellation = null;
    let escalation = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const stopChild = () => {
        child.kill('SIGTERM');
        escalation = setTimeout(() => child.kill('SIGKILL'), 5000);
      };
      try {
        const run = launchedRun(child.pid, args.provider, previousLogs);
        if (run) {
          cancellation = callTool('kill_run', { target: run.filename })
            .then(result => { if (!result.killed && child.exitCode === null) stopChild(); })
            .catch(() => { if (child.exitCode === null) stopChild(); });
        } else stopChild();
      } catch {
        stopChild();
      }
    }, (args.timeoutSeconds ?? 7200) * 1000);
    const finished = await completion;
    clearTimeout(timer);
    if (cancellation) await cancellation;
    if (escalation) clearTimeout(escalation);
    const run = launchedRun(child.pid, args.provider, previousLogs);
    if (run) {
      return { ...runResult(run), timedOut };
    }
    return {
      ...finished,
      status: finished.status === 0 ? 'completed' : 'failed',
      exitCode: finished.status,
      accepted: false,
      timedOut,
    };
  }
  if (name === 'list_workspaces') return { workspaces: knownWorkspaces() };
  if (name === 'list_runs') {
    const workspace = args.workspace && args.workspace !== 'all' ? resolveWorkspace(args.workspace) : null;
    if (args.workspace && args.workspace !== 'all' && !workspace) throw new Error('unknown workspace: ' + args.workspace);
    return getFilteredRuns({
      rawWorkspace: workspace,
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
    if (args.workspace && !workspace) throw new Error('unknown workspace: ' + args.workspace);

    if (args.target) {
      const run = resolveRunTarget(args.target);
      if (!run) throw new Error('run not found: ' + args.target);
      if (args.provider && args.provider !== run.provider || args.sessionId && args.sessionId !== run.sessionId) {
        throw new Error('target does not match the requested provider/session');
      }
      if (run) {
        provider = provider || run.provider;
        sessionId = sessionId || run.sessionId;
        workspace = workspace || run.rawWorkspace || run.workspace;
      }
    }

    if (!sessionId && !args.target) {
      const run = refreshRun(getFilteredRuns({ provider, rawWorkspace: workspace, limit: 1 }).runs[0]);
      if (run) {
        provider = provider || run.provider;
        sessionId = sessionId || run.sessionId;
        workspace = workspace || run.rawWorkspace || run.workspace;
      }
    }

    if (!sessionId && !provider && !args.target) {
      throw new Error('target, sessionId, or provider is required to retrieve session history');
    }

    let details = null;
    try {
      if (provider === 'opencode' && sessionId) {
        details = getOpenCodeSessionDetails(sessionId);
      } else if (provider === 'claude' && sessionId && sessionId !== 'new') {
        details = getClaudeSessionDetails(sessionId, null, workspace);
      } else if (provider === 'codex' && sessionId && sessionId !== 'new') {
        details = getCodexSessionDetails(sessionId, null, workspace);
      } else if (provider === 'antigravity' && sessionId && sessionId !== 'new') {
        details = findAntigravityTranscript(sessionId, null, workspace);
      }
    } catch {}

    if (details && (details.markdownSummary || details.task || details.tokens || details.toolCalls?.length || details.conversationId)) {
      return {
        provider,
        sessionId,
        workspace,
        ...details,
      };
    }

    // Fallback to indexed SQLite run metadata and summary
    const run = args.sessionId
      ? refreshRun(getFilteredRuns({ sessionId: args.sessionId, provider, rawWorkspace: workspace, limit: 1 }).runs[0])
      : args.target ? resolveRunTarget(args.target)
        : refreshRun(getFilteredRuns({ provider, rawWorkspace: workspace, limit: 1 }).runs[0]);
    if (run) {
      return {
        provider: run.provider,
        sessionId: run.sessionId,
        workspace: run.rawWorkspace || run.workspace,
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
      run = refreshRun(getRun(run.filename) || run);
    }
    return { ...runResult(run), timedOut: run?.status === 'running' };
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
    const matches = [];
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        if (line.toLowerCase().includes(q)) matches.push({ line: lineNumber, text: line.slice(0, 1000) });
        if (matches.length >= limit) break;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return { filename: run.filename, q: args.q, count: matches.length, matches };
  }
  if (name === 'continue_run') {
    const workspace = args.workspace ? executionWorkspace(args.workspace) : null;
    if (args.provider) return callTool('takeover_run', {
      workspace: workspace || process.cwd(), provider: args.provider, instructions: args.prompt, execute: Boolean(args.execute),
    });
    const run = latestRun(workspace);
    if (!run?.sessionId || run.sessionId === 'new') throw new Error('no resumable matching run found');
    const actual = executionWorkspace(run.rawWorkspace || run.workspace);
    const command = [path.join(repoDir, `${run.provider}-agent`), '--resume', run.sessionId, args.prompt];
    if (!args.execute) return { command, workspace: actual, executed: false };
    return callTool('run_agent', { provider: run.provider, prompt: args.prompt, workspace: actual, sessionId: run.sessionId });
  }
  if (name === 'takeover_run') {
    const targetWorkspace = executionWorkspace(args.workspace);

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
    return await startCommand([path.join(repoDir, 'agent-doctor')]).completion;
  }
  if (name === 'list_models') {
    const targetProvider = args.provider || 'all';
    const queryProvider = async (prov) => {
      const bin = path.join(repoDir, `${prov}-agent`);
      if (!fs.existsSync(bin)) return { provider: prov, error: 'wrapper not found' };
      const res = await startCommand([bin, '--models']).completion;
      if (res.status !== 0) return { provider: prov, models: [], error: res.error || res.stderr || `exited ${res.status}` };
      const models = (res.stdout || '')
        .split('\n')
        .map(s => s.trim())
        .filter(s => s && !s.startsWith('#') && !s.toLowerCase().includes('usage:') && !s.toLowerCase().includes('selectors:'));
      return { provider: prov, models };
    };

    if (targetProvider !== 'all') {
      if (!providers.has(targetProvider)) throw new Error(`unknown provider: ${targetProvider}`);
      return await queryProvider(targetProvider);
    }
    const result = {};
    const errors = {};
    for (const p of providers) {
      const response = await queryProvider(p);
      result[p] = response.models || [];
      if (response.error) errors[p] = response.error;
    }
    return { providers: result, ...(Object.keys(errors).length ? { errors } : {}) };
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

    const identity = processIdentity(run.pid);
    const logFile = path.join(logsDir, run.filename);
    const started = spawnSync('ps', ['-p', String(run.pid), '-o', 'lstart='], {
      encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' },
    });
    const startedAt = Date.parse(started.stdout?.trim());
    const logCreatedAt = fs.existsSync(logFile) ? fs.statSync(logFile).birthtimeMs : 0;
    if (!identity || !identity.includes(`${run.provider}-agent`) || !Number.isFinite(startedAt)
      || !logCreatedAt || startedAt > logCreatedAt + 2000) {
      return { filename: run.filename, killed: false, message: "PID no longer identifies the recorded wrapper" };
    }
    try {
      process.kill(run.pid, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (processIdentity(run.pid) === identity && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      let forced = false;
      if (processIdentity(run.pid) === identity) {
        forced = true;
        if (run.systemdUnit) {
          if (run.systemdUnit !== `local-agent-${run.provider}-${run.pid}`) throw new Error('unexpected recorded systemd unit');
          const stopped = await startCommand(['systemctl', '--user', 'stop', run.systemdUnit], { timeout: 5000 }).completion;
          const state = await startCommand(['systemctl', '--user', 'show', run.systemdUnit, '--property=ActiveState', '--property=LoadState'], { timeout: 5000 }).completion;
          if (state.status !== 0 || /ActiveState=(active|activating|deactivating)/.test(state.stdout)) {
            throw new Error(stopped.stderr || state.stderr || 'systemd unit did not stop');
          }
        }
        if (processIdentity(run.pid) === identity) {
          spawnSync("pkill", ["-KILL", "-P", String(run.pid)]);
          try { process.kill(-run.pid, "SIGKILL"); } catch {}
          try { process.kill(run.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        for (let i = 0; i < 10 && processIdentity(run.pid) === identity; i++) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (processIdentity(run.pid) === identity) throw new Error("wrapper did not exit after cancellation");
      if (!fs.existsSync(logFile.replace(/\.log$/, ".done")) && fs.existsSync(logFile)) {
        const saved = await startCommand([process.execPath, path.join(repoDir, "scripts/write-done.mjs"),
          logFile, run.provider, run.rawWorkspace || run.workspace, run.model,
          run.sessionId || "new", forced ? "137" : "143"]).completion;
        if (saved.status !== 0) throw new Error(saved.error || saved.stderr || "failed to persist cancellation");
      }
      const final = refreshRun(run);
      const sessionId = final.sessionId || null;
      const { continuation } = buildRunCommands(final, sessionId);
      return { filename: run.filename, pid: run.pid, killed: true, forced, sessionId, continuation };
    } catch (error) {
      return { filename: run.filename, pid: run.pid, killed: false, error: error.message };
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
        serverInfo: { name: 'agent-relay', version: '1.0.1' },
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
