import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const prompt = 'Connectivity check only. Do not use any tools or inspect files. Reply with exactly OK.';
const providers = new Set(['codex', 'claude', 'opencode', 'antigravity']);

export function parseProbeArgs(args) {
  const options = { provider: args[0]?.toLowerCase(), model: '', timeoutMs: 30000, json: false };
  if (options.provider === 'agy') options.provider = 'antigravity';
  if (!providers.has(options.provider)) throw new Error('probe requires a provider: codex, claude, opencode, or antigravity');
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--model' || arg === '--timeout') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      if (arg === '--model') options.model = value.trim();
      else {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) throw new Error('--timeout must be between 1 and 300 seconds');
        options.timeoutMs = seconds * 1000;
      }
    } else throw new Error(`unknown probe option: ${arg}`);
  }
  if (!options.model) throw new Error('probe requires --model <model> (use relay models to discover IDs)');
  return options;
}

function probeCommand(provider, model) {
  switch (provider) {
    case 'codex': return ['codex', [
      '--ask-for-approval', 'never', 'exec', '--json', '--ephemeral', '--ignore-user-config',
      '--skip-git-repo-check', '--sandbox', 'read-only', '--disable', 'shell_tool',
      '--disable', 'hooks', '-c', 'web_search="disabled"', '--model', model, prompt,
    ]];
    case 'claude': return ['claude', [
      '--print', '--output-format', 'json', '--model', model, '--tools', '',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--max-turns', '1', prompt,
    ]];
    case 'opencode': return ['opencode', [
      'run', '--standalone', '--format', 'json', '--title', 'relay-probe', '--agent', 'relay-probe', '--model', model, prompt,
    ]];
    case 'antigravity': return ['agy', [
      '--print', prompt, '--output-format', 'stream-json', '--model', model,
      '--mode', 'plan', '--sandbox', '--disable-slash-commands',
    ]];
    default: throw new Error('unsupported probe provider');
  }
}

export function classifyProbeFailure(text) {
  if (/insufficient[_ -](?:quota|balance)|quota[_ -](?:exhausted|exceeded)|quota.{0,30}(?:has been exceeded|has been exhausted)|exhausted.{0,30}(quota|credits)|(?:usage|spending|credit|billing) (?:limit|balance).{0,40}(?:exceeded|reached|exhausted|insufficient)|(?:exceeded|reached).{0,30}(?:usage|spending|billing|current quota)|(?:out of|insufficient|no remaining) credits|resource_exhausted.{0,80}quota|hit your (?:usage )?limit/i.test(text)) return 'quota_exhausted';
  if (/invalid[_ -](?:api[_ -]?key|authentication|credentials)|authentication[_ -](?:error|failed|required)|unauthenticated|unauthorized|not logged in|(?:login|log in|sign in) (?:required|again)|(?:session|token).{0,30}expired|\b401\b/i.test(text)) return 'auth_failed';
  if (/model[_ -]not[_ -]found|model.{0,80}(?:not found|does not exist|not available|unavailable|not supported|access denied)|(?:unknown|invalid|unsupported) model|(?:no access|do not have access).{0,60}model|permission_denied|\b403\b/i.test(text)) return 'model_unavailable';
  if (/rate[_ -]?limit|too many requests|\b429\b|resource_exhausted/i.test(text)) return 'rate_limited';
  if (/ETIMEDOUT|timed? out|timeout/i.test(text)) return 'timeout';
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network[_ -]error|network connection|connection (?:refused|reset)|unable to connect/i.test(text)) return 'network_error';
  return 'unknown_error';
}

export function parseProbeOutput(stdout) {
  let reply = '';
  let resolvedModel = null;
  const errors = [];
  let retryAfter = null;
  let events;
  try { events = [JSON.parse(stdout)]; }
  catch { events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (typeof event.model === 'string') resolvedModel = event.model;
    if (typeof event.message?.model === 'string') resolvedModel = event.message.model;
    if (event.modelUsage && typeof event.modelUsage === 'object') resolvedModel = Object.keys(event.modelUsage).at(-1) || resolvedModel;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') reply = event.item.text || '';
    if (event.type === 'text' && event.part?.type === 'text') reply += event.part.text || '';
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      reply = event.message.content.filter(part => part?.type === 'text').map(part => part.text || '').join('');
    }
    if (event.event === 'step_update' && typeof event.step_update?.text_delta === 'string') reply += event.step_update.text_delta;
    if (event.type === 'result' && typeof event.result === 'string') reply = event.result;
    if (event.type === 'error' || event.type === 'turn.failed' || event.is_error || event.error) {
      errors.push(JSON.stringify(event.error || event.errors || event));
    }
    const retry = event.retry_after ?? event.retryAfter ?? event.error?.retry_after ?? event.error?.data?.retry_after;
    if (typeof retry === 'string' || typeof retry === 'number') retryAfter = retry;
  }
  return { reply: reply.trim(), resolvedModel, errors, retryAfter };
}

const messages = {
  ready: 'Model answered the probe.',
  quota_exhausted: 'Provider explicitly reported exhausted quota or credits.',
  rate_limited: 'Provider reported throttling; exhausted quota was not confirmed.',
  auth_failed: 'Provider rejected authentication; check the CLI login.',
  model_unavailable: 'Requested model was not found or access was denied.',
  timeout: 'No completed probe response within the time limit.',
  network_error: 'Provider connection failed.',
  unknown_error: 'No valid probe reply; check the provider CLI separately.',
};

export async function probeModel({ provider, model, timeoutMs = 30000 }) {
  if (!providers.has(provider) || typeof model !== 'string' || !model.trim() || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error('invalid probe options');
  const [name, args] = probeCommand(provider, model);
  const binKey = name.toUpperCase();
  const binary = process.env[`AGENT_RELAY_${binKey}_BIN`] || process.env[`SUBAGENT_${binKey}_BIN`] || name;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-probe-'));
  const start = performance.now();
  const env = { ...process.env };
  if (provider === 'opencode') {
    env.OPENCODE_PERMISSION = JSON.stringify({ '*': 'deny' });
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      permission: { '*': 'deny' },
      agent: { 'relay-probe': { mode: 'primary', prompt, tools: { '*': false }, permission: { '*': 'deny' } } },
    });
  }
  try {
    return await new Promise(resolve => {
      const child = spawn(binary, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let forcedStatus = null;
      let spawnError = null;
      let killTimer;
      const kill = signal => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {}
      };
      const stop = status => {
        if (forcedStatus) return;
        forcedStatus = status;
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), 250);
      };
      const interrupted = () => stop('unknown_error');
      process.once('SIGINT', interrupted);
      process.once('SIGTERM', interrupted);
      const timer = setTimeout(() => stop('timeout'), timeoutMs);
      const collect = stream => chunk => {
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 65536) {
          stop('unknown_error');
          return;
        }
        if (stream === 'stdout') stdout += chunk.toString();
        else stderr += chunk.toString();
        const parsed = parseProbeOutput(stdout);
        if (parsed.errors.length) stop(classifyProbeFailure(parsed.errors.join('\n')));
      };
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.on('error', error => { spawnError = error; });
      // Provider helpers must not keep pipes or processes alive after the CLI exits.
      child.on('exit', () => kill('SIGKILL'));
      child.on('close', code => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.removeListener('SIGINT', interrupted);
        process.removeListener('SIGTERM', interrupted);
        const parsed = parseProbeOutput(stdout);
        const failures = [...parsed.errors, stderr, spawnError?.message || ''].join('\n');
        const retryAfter = parsed.retryAfter ?? failures.match(/retry-after\s*[:=]\s*(\d+)/i)?.[1];
        const status = forcedStatus || (code === 0 && !spawnError && parsed.errors.length === 0 && /^OK[.!]?$/i.test(parsed.reply)
          ? 'ready' : classifyProbeFailure(failures));
        resolve({ provider, requestedModel: model, resolvedModel: parsed.resolvedModel, status,
          latencyMs: Math.round(performance.now() - start),
          message: spawnError?.code === 'ENOENT' ? 'Provider CLI executable was not found.' : messages[status],
          ...(retryAfter !== undefined ? { retryAfter } : {}),
        });
      });
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

export async function runProbeCommand(args) {
  try {
    const options = parseProbeArgs(args);
    const result = await probeModel(options);
    console.log(options.json ? JSON.stringify(result) :
      `${result.status}: ${result.provider} / ${result.requestedModel} (${result.latencyMs} ms)\n${result.message}` +
      (result.resolvedModel ? `\nResolved model: ${result.resolvedModel}` : '') +
      (result.retryAfter !== undefined ? `\nRetry after (provider value): ${result.retryAfter}` : ''));
    return result.status === 'ready' ? 0 : 1;
  } catch (error) {
    if (args.includes('--json')) console.log(JSON.stringify({ status: 'invalid_arguments', message: error.message }));
    else console.error(`relay probe: ${error.message}`);
    return 2;
  }
}
