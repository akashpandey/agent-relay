// Exercises the MCP stdio server protocol over NDJSON while mocking dashboard modules so no SQLite database is required.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';

const tools = [
  'run_agent',
  'list_workspaces',
  'list_runs',
  'get_run_result',
  'wait_for_run',
  'get_log_tail',
  'search_log',
  'continue_run',
  'get_session_history',
  'takeover_run',
  'doctor',
  'list_models',
  'kill_run',
];

const mockModules = {
  '/dashboard/db.js': `
    const runs = [{
      filename: 'mock-run.log',
      sessionId: 'mock-session',
      status: 'completed',
      exitCode: 0,
      outcome: 'done',
      provider: 'codex',
      model: 'mock',
      result: { outcome: 'done', summary: 'mock run', verification: [], changedFiles: [] },
      logAvailable: false
    }];
    export function getFilteredRuns(args = {}) {
      return { runs: args.workspace && args.workspace !== 'all' ? [] : runs, total: runs.length };
    }
    export function getRun(filename) {
      return runs.find(run => run.filename === filename) || null;
    }
    export function getWorkspacesFromDb() {
      return [{ name: 'mock', path: '/tmp/agent-relay-mock', totalRuns: 1, activeRuns: 0 }];
    }
    export function registerRunComplete() {}
    export function upsertRun() {}
  `,
  '/dashboard/commands.js': `
    export function buildRunCommands(run, sessionId) {
      return { runAgainCommand: 'relay mock', continuation: sessionId ? 'continue mock' : null };
    }
  `,
  '/dashboard/workspaces.js': `
    export function canonicalWorkspacePath(value) {
      if (!value) return null;
      if (String(value).startsWith('/')) return String(value).replace(/\\/+$/, '');
      return null;
    }
    export function configuredWorkspaceEntries() {
      return [{ name: 'mock', path: '/tmp/agent-relay-mock' }];
    }
  `,
};

const loaderSource = `
  const mocks = new Map(${JSON.stringify(Object.entries(mockModules))});
  export async function resolve(specifier, context, nextResolve) {
    const resolved = specifier.startsWith('.') ? new URL(specifier, context.parentURL).pathname : specifier;
    for (const [suffix, source] of mocks) {
      if (resolved.endsWith(suffix)) {
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
`;

const loaderUrl = 'data:text/javascript,' + encodeURIComponent(loaderSource);

function createMcpServer() {
  const child = spawn(process.execPath, ['--loader', loaderUrl, 'scripts/mcp-server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  const errors = [];
  let stdout = '';
  let stderr = '';
  let lineBuffer = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    lineBuffer += chunk;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  child.on('error', error => {
    errors.push(error);
  });

  function write(value) {
    child.stdin.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n');
  }

  function waitForResponses(count, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const timer = setInterval(() => {
        if (responses.length >= count) {
          clearInterval(timer);
          resolve(responses.slice());
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error(`timed out waiting for ${count} responses; got ${responses.length}; stderr=${stderr}`));
        }
      }, 10);
    });
  }

  async function close() {
    child.stdin.end();
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 500);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    child,
    errors,
    get rawStdout() {
      return stdout;
    },
    get rawStderr() {
      return stderr;
    },
    get responses() {
      return responses;
    },
    write,
    waitForResponses,
    close,
  };
}

async function withServer(run) {
  const server = createMcpServer();
  try {
    await run(server);
    assert.deepEqual(server.errors, []);
  } finally {
    await server.close();
  }
}

describe('MCP server protocol', () => {
  it('responds to initialize with protocol metadata', async () => {
    await withServer(async server => {
      server.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
      const [response] = await server.waitForResponses(1);

      assert.equal(response.id, 1);
      assert.equal(response.result.protocolVersion, '2024-11-05');
      assert.ok(response.result.capabilities.tools);
      assert.equal(response.result.serverInfo.name, 'agent-relay');
    });
  });

  it('responds to ping with an empty result', async () => {
    await withServer(async server => {
      server.write({ jsonrpc: '2.0', id: 2, method: 'ping' });
      const [response] = await server.waitForResponses(1);

      assert.deepEqual(response.result, {});
    });
  });

  it('returns method-not-found for unknown methods with ids', async () => {
    await withServer(async server => {
      server.write({ jsonrpc: '2.0', id: 3, method: 'missing/method' });
      const [response] = await server.waitForResponses(1);

      assert.equal(response.id, 3);
      assert.equal(response.error.code, -32601);
    });
  });

  it('returns parse errors for malformed JSON', async () => {
    await withServer(async server => {
      server.write('{"jsonrpc":"2.0","id":4,"method":\n');
      const [response] = await server.waitForResponses(1);

      assert.equal(response.id, null);
      assert.equal(response.error.code, -32700);
    });
  });

  it('does not respond to notifications', async () => {
    await withServer(async server => {
      server.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.equal(server.responses.length, 0);
      assert.equal(server.rawStdout, '');
    });
  });
});

describe('MCP tool listing', () => {
  it('lists all tools with schemas', async () => {
    await withServer(async server => {
      server.write({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
      const [response] = await server.waitForResponses(1);

      assert.equal(response.result.tools.length, 13);
      assert.deepEqual(response.result.tools.map(tool => tool.name), tools);
      for (const tool of response.result.tools) {
        assert.equal(typeof tool.name, 'string');
        assert.equal(typeof tool.description, 'string');
        assert.equal(tool.inputSchema.type, 'object');
      }
    });
  });
});

describe('MCP tool errors', () => {
  it('returns tool errors as MCP tool results, not protocol errors', async () => {
    await withServer(async server => {
      server.write({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'not_a_tool', arguments: {} } });
      const [response] = await server.waitForResponses(1);

      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /unknown tool/);
    });
  });

  it('returns thrown tool failures as MCP tool results', async () => {
    await withServer(async server => {
      server.write({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'list_runs', arguments: { workspace: 'does-not-exist' } },
      });
      const [response] = await server.waitForResponses(1);

      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /unknown workspace/);
    });
  });

  it('returns validation errors for run_agent invalid parameters', async () => {
    await withServer(async server => {
      server.write({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'run_agent', arguments: { provider: 'invalid-provider', prompt: 'test' } },
      });
      const [response] = await server.waitForResponses(1);

      assert.equal(response.error, undefined);
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /unknown provider/);
    });
  });

  it('supports list_models and kill_run', async () => {
    await withServer(async server => {
      server.write({
        jsonrpc: '2.0',
        id: 23,
        method: 'tools/call',
        params: { name: 'list_models', arguments: { provider: 'invalid-provider' } },
      });
      const [response] = await server.waitForResponses(1);
      assert.equal(response.result.isError, true);
      assert.match(response.result.content[0].text, /unknown provider/);

      server.write({
        jsonrpc: '2.0',
        id: 24,
        method: 'tools/call',
        params: { name: 'kill_run', arguments: { target: 'missing-run' } },
      });
      const [, response2] = await server.waitForResponses(2);
      assert.equal(response2.result.isError, true);
      assert.match(response2.result.content[0].text, /run not found/);

      server.write({
        jsonrpc: '2.0',
        id: 25,
        method: 'tools/call',
        params: { name: 'get_session_history', arguments: { target: 'mock-run.log' } },
      });
      const [, , response3] = await server.waitForResponses(3);
      assert.equal(response3.error, undefined);
      const data3 = JSON.parse(response3.result.content[0].text);
      assert.equal(data3.provider, 'codex');
      assert.equal(data3.sessionId, 'mock-session');

      server.write({
        jsonrpc: '2.0',
        id: 26,
        method: 'tools/call',
        params: { name: 'takeover_run', arguments: { workspace: 'does-not-exist', provider: 'codex' } },
      });
      const [, , , response4] = await server.waitForResponses(4);
      assert.equal(response4.result.isError, true);
      assert.match(response4.result.content[0].text, /workspace/);
    });
  });
});

describe('MCP NDJSON framing', () => {
  it('handles rapid messages and writes newline-delimited JSON without Content-Length headers', async () => {
    await withServer(async server => {
      server.write({ jsonrpc: '2.0', id: 30, method: 'ping' });
      server.write({ jsonrpc: '2.0', id: 31, method: 'tools/list' });
      server.write({ jsonrpc: '2.0', id: 32, method: 'initialize' });
      const responses = await server.waitForResponses(3);

      assert.deepEqual(responses.map(response => response.id), [30, 31, 32]);
      assert.equal(server.rawStdout.endsWith('\n'), true);
      assert.equal(server.rawStdout.includes('Content-Length'), false);
      for (const line of server.rawStdout.split('\n').filter(Boolean)) {
        assert.doesNotThrow(() => JSON.parse(line));
      }
    });
  });
});
