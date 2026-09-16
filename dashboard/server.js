import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLogFilename, isProcessRunning, parseLogMetadata, parseLogProgress } from './parser.js';
import { buildRunCommands } from './commands.js';
import {
  getDatabase,
  getStatsFromDb,
  getFilteredRuns,
  getAnalyticsFromDb,
  getWorkspacesFromDb,
  getRun,
  getRunSyncState,
  markRunLogMissing,
  updateRunProgress,
  upsertRun,
  registerRunComplete
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '4242', 10);
const HOST = process.env.HOST || '0.0.0.0';
const LOGS_DIR = process.env.LOGS_DIR || path.resolve(__dirname, '../logs');
const PROC_DIR = process.env.PROC_DIR || '/proc';
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const LOG_STREAM_CHUNK_BYTES = 256 * 1024;
const LOG_SEARCH_MAX_RESULTS = 200;

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

console.log(`[Dashboard] Initializing SQLite-backed subagent visualizer...`);
console.log(`[Dashboard] Logs Directory: ${LOGS_DIR}`);
console.log(`[Dashboard] Proc Directory: ${PROC_DIR}`);

// Keep DB history even when raw logs are pruned; mark only the byte stream unavailable.
try {
  const db = getDatabase();
  const rows = db.prepare('SELECT filename FROM runs').all();
  let missing = 0;
  for (const r of rows) {
    if (!fs.existsSync(path.join(LOGS_DIR, r.filename))) {
      markRunLogMissing(r.filename);
      missing++;
    }
  }
  if (missing > 0) {
    console.log(`[Dashboard] Marked ${missing} runs with missing raw log files.`);
  }
} catch (err) {
  console.warn('[Dashboard] Could not verify raw log availability:', err.message);
}

/**
 * Reconcile active runs with real process table to catch dead / completed jobs
 */
function reconcileActiveRuns(activeRuns) {
  if (!activeRuns || activeRuns.length === 0) return;
  for (const r of activeRuns) {
    if (r.pid) {
      const proc = isProcessRunning(r.pid, PROC_DIR);
      if (!proc.isAlive) {
        // Process is dead, parse full log to finalize tokens, diffs, and summary
        const filePath = path.join(LOGS_DIR, r.filename);
        const doneFile = filePath.replace(/\.log$/, '.done');
        let exitCode = 0;
        let finalStatus = 'completed';
        let hasDone = false;

        if (fs.existsSync(doneFile)) {
          try {
            const doneData = JSON.parse(fs.readFileSync(doneFile, 'utf8'));
            if (doneData.exitCode !== undefined) exitCode = doneData.exitCode;
            if (doneData.status) finalStatus = doneData.status;
            hasDone = true;
          } catch {}
        } else {
          exitCode = 1;
          finalStatus = 'failed';
        }

        if (fs.existsSync(filePath)) {
          try {
            const meta = parseLogMetadata(r.filename, filePath, PROC_DIR);
            if (meta) {
              meta.status = finalStatus;
              meta.exitCode = exitCode;
              if (!hasDone) {
                meta.outcome = 'unknown';
                meta.attentionRequired = true;
                meta.result = {
                  outcome: 'unknown',
                  summary: 'Process exited before writing a .done sentinel.',
                  changedFiles: [],
                  verification: [],
                  blockers: ['Missing .done sentinel; task completion could not be verified.'],
                  incomplete: [],
                  nextSteps: [],
                  attentionRequired: true,
                };
              }
              upsertRun(meta);
              continue;
            }
          } catch {}
        }
        registerRunComplete({ filename: r.filename, exitCode, status: finalStatus });
      }
    }
  }
}

/**
 * Find all dangling (orphaned) subagent processes on the system
 */
function findDanglingSubagentProcesses(activeRuns = []) {
  const dangling = [];
  if (!fs.existsSync(PROC_DIR)) return dangling;

  const activePids = new Set();
  const activeUnits = new Set();

  for (const r of activeRuns) {
    if (r.pid) {
      activePids.add(r.pid);
      activeUnits.add(`local-subagent-${r.provider}-${r.pid}`);
      activeUnits.add(`local-subagent-${r.pid}`);
    }
  }

  try {
    const entries = fs.readdirSync(PROC_DIR);
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      try {
        const cmdlinePath = path.join(PROC_DIR, entry, 'cmdline');
        const cgroupPath = path.join(PROC_DIR, entry, 'cgroup');

        let isSubagent = false;
        let isPartOfActiveRun = false;
        let cmd = '';

        if (fs.existsSync(cgroupPath)) {
          const cgroupContent = fs.readFileSync(cgroupPath, 'utf8');
          if (cgroupContent.includes('local-subagent-')) {
            isSubagent = true;
            for (const unit of activeUnits) {
              if (cgroupContent.includes(unit)) {
                isPartOfActiveRun = true;
                break;
              }
            }
          }
        }

        if (fs.existsSync(cmdlinePath)) {
          const raw = fs.readFileSync(cmdlinePath, 'utf8');
          cmd = raw.replace(/\0/g, ' ').trim();

          if (
            cmd.includes('antigravity-subagent') ||
            cmd.includes('opencode-subagent') ||
            cmd.includes('claude-subagent') ||
            cmd.includes('codex-subagent')
          ) {
            isSubagent = true;
            if (activePids.has(pid)) {
              isPartOfActiveRun = true;
            }
          }
        }

        if (cmd.includes('server.js') || cmd.includes('agent-relay-dashboard')) {
          isSubagent = false;
        }

        if (isSubagent && !isPartOfActiveRun) {
          dangling.push({
            pid,
            cmd: cmd.slice(0, 140) || 'orphaned subagent process',
          });
        }
      } catch {}
    }
  } catch (err) {
    console.error('Error scanning proc:', err);
  }
  return dangling;
}

/**
 * Safely kill a process and its child tree
 */
function terminateProcessTree(pid) {
  return new Promise((resolve) => {
    try {
      exec(`pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null`, () => {
        setTimeout(() => {
          exec(`pkill -KILL -P ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null`, () => {
            resolve({ success: true });
          });
        }, 800);
      });
    } catch (err) {
      try {
        process.kill(pid, 'SIGTERM');
        setTimeout(() => {
          try { process.kill(pid, 'SIGKILL'); } catch {}
          resolve({ success: true });
        }, 800);
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    }
  });
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * SSE Clients for dashboard global updates
 */
const sseClients = new Set();

function getSafeLogPath(filename) {
  const safeFile = path.basename(filename);
  return { safeFile, filePath: path.join(LOGS_DIR, safeFile) };
}

function syncLogFile(filename, { force = false } = {}) {
  const { safeFile, filePath } = getSafeLogPath(filename);
  if (!safeFile.endsWith('.log') || !fs.existsSync(filePath)) return false;

  const stat = fs.statSync(filePath);
  const cached = getRunSyncState(safeFile);
  const doneFile = filePath.replace(/\.log$/, '.done');
  if (!force && cached && cached.log_size === stat.size && cached.log_mtime === Math.floor(stat.mtimeMs)) {
    if (!(cached.status === 'running' && fs.existsSync(doneFile))) return false;
  }

  if (!force && cached?.status === 'running' && !fs.existsSync(doneFile)) {
    const progress = parseLogProgress(safeFile, filePath, PROC_DIR);
    if (progress) {
      updateRunProgress(progress);
      return true;
    }
  }

  const meta = parseLogMetadata(safeFile, filePath, PROC_DIR);
  if (meta) {
    upsertRun(meta);
    return true;
  }
  return false;
}

function searchLogFile(filePath, query, limit = LOG_SEARCH_MAX_RESULTS) {
  return new Promise((resolve, reject) => {
    const needle = query.toLowerCase();
    const matches = [];
    let carry = '';
    let lineNo = 0;
    let byteOffset = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(matches);
    };

    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => {
      const lines = (carry + chunk).split('\n');
      carry = lines.pop() || '';

      for (const line of lines) {
        lineNo++;
        if (line.toLowerCase().includes(needle)) {
          matches.push({ line: lineNo, offset: byteOffset, text: line.slice(0, 1000) });
          if (matches.length >= limit) {
            stream.destroy();
            break;
          }
        }
        byteOffset += Buffer.byteLength(line + '\n');
      }
    });
    stream.on('close', finish);
    stream.on('error', reject);
    stream.on('end', () => {
      if (carry) {
        lineNo++;
        if (carry.toLowerCase().includes(needle) && matches.length < limit) {
          matches.push({ line: lineNo, offset: byteOffset, text: carry.slice(0, 1000) });
        }
      }
      finish();
    });
  });
}

function broadcastDashboardUpdate() {
  if (sseClients.size === 0) return;
  let stats = getStatsFromDb();
  reconcileActiveRuns(stats.activeRuns);
  stats = getStatsFromDb();
  const analytics = getAnalyticsFromDb();

  const payload = JSON.stringify({
    type: 'stats_update',
    activeCount: stats.activeCount,
    totalCount: stats.totalCount,
    todayCount: stats.todayCount,
    byProvider: stats.byProvider,
    activeRuns: stats.activeRuns,
    analytics: {
      totalTokens: analytics.totalTokens,
      avgDurationSec: analytics.avgDurationSec,
      successRate: analytics.successRate,
      totalCost: analytics.totalCost,
      attentionCount: analytics.attentionCount,
    },
    timestamp: new Date().toISOString(),
  });

  for (const res of sseClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

// Watch directory for changes and update SQLite
let debounceTimer = null;
try {
  fs.watch(LOGS_DIR, (eventType, filename) => {
    if (!filename || (!filename.endsWith('.log') && !filename.endsWith('.done'))) return;
    const logFilename = filename.endsWith('.done') ? filename.replace(/\.done$/, '.log') : filename;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try { syncLogFile(logFilename); } catch {}
      broadcastDashboardUpdate();
    }, 200);
  });
} catch (e) {
  console.warn('[Dashboard] Could not attach fs.watch to logs dir:', e.message);
}

setTimeout(() => {
  try {
    let changed = false;
    for (const filename of fs.readdirSync(LOGS_DIR)) {
      if (filename.endsWith('.log')) {
        changed = syncLogFile(filename) || changed;
      }
    }
    if (changed) broadcastDashboardUpdate();
  } catch (err) {
    console.warn('[Dashboard] Initial log sync failed:', err.message);
  }
}, 100);

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Routes ---

  // GET /api/stats
  if (pathname === '/api/stats' && req.method === 'GET') {
    let stats = getStatsFromDb();
    reconcileActiveRuns(stats.activeRuns);
    stats = getStatsFromDb();
    const dangling = findDanglingSubagentProcesses(stats.activeRuns);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ...stats,
      danglingCount: dangling.length,
      danglingProcesses: dangling,
    }));
    return;
  }

  // GET /api/workspaces
  if (pathname === '/api/workspaces' && req.method === 'GET') {
    const workspaces = getWorkspacesFromDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ workspaces }));
    return;
  }

  // GET /api/analytics
  if (pathname === '/api/analytics' && req.method === 'GET') {
    const analytics = getAnalyticsFromDb();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(analytics));
    return;
  }

  // GET /api/runs
  if (pathname === '/api/runs' && req.method === 'GET') {
    const provider = parsedUrl.searchParams.get('provider');
    const status = parsedUrl.searchParams.get('status');
    const outcome = parsedUrl.searchParams.get('outcome');
    const workspace = parsedUrl.searchParams.get('workspace');
    const attention = parsedUrl.searchParams.get('attention');
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
    const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);

    const result = getFilteredRuns({ provider, status, outcome, workspace, attention, q, limit, offset });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // GET /api/runs/:filename/result
  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/result') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/runs/', '').replace('/result', ''));
    const safeFile = path.basename(filename);
    syncLogFile(safeFile, { force: true });
    const run = getRun(safeFile);

    if (!run) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log file not found' }));
      return;
    }

    const result = run.result || null;
    const sessionId = run.sessionId || run.session || null;
    const outcome = run.outcome || result?.outcome || 'unknown';
    const attentionRequired = Boolean(run.attentionRequired || result?.attentionRequired);
    const { runAgainCommand, continuation } = buildRunCommands(run, sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      filename: run.filename,
      processStatus: run.status,
      exitCode: run.exitCode,
      outcome,
      attentionRequired,
      accepted: outcome === 'done' && !attentionRequired,
      blockers: result?.blockers || [],
      incomplete: result?.incomplete || [],
      verification: result?.verification || [],
      changedFiles: result?.changedFiles?.length ? result.changedFiles : (run.filesModified || []),
      nextSteps: result?.nextSteps || [],
      summary: result?.summary || run.markdownSummary || '',
      logFile: path.join(LOGS_DIR, safeFile),
      sessionId,
      continuation,
      runAgainCommand,
      provider: run.provider,
      model: run.model,
    }));
    return;
  }

  // GET /api/runs/:filename
  if (pathname.startsWith('/api/runs/') && !pathname.endsWith('/kill') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/runs/', ''));
    const safeFile = path.basename(filename);
    const filePath = path.join(LOGS_DIR, safeFile);

    // Try SQLite first
    let meta = getRun(safeFile);
    if (!meta && fs.existsSync(filePath)) {
      meta = parseLogMetadata(safeFile, filePath, PROC_DIR);
      if (meta) upsertRun(meta);
    }

    if (!meta) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log file not found' }));
      return;
    }

    const sessionId = meta.sessionId || meta.session || null;
    const { runAgainCommand, continuation } = buildRunCommands(meta, sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...meta, continuation, runAgainCommand }));
    return;
  }

  // POST /api/runs/:filename/kill
  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/kill') && req.method === 'POST') {
    const filename = decodeURIComponent(pathname.replace('/api/runs/', '').replace('/kill', ''));
    const safeFile = path.basename(filename);
    const run = getRun(safeFile);

    if (!run || !run.pid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active PID associated with this run' }));
      return;
    }

    const unit = `local-subagent-${run.provider}-${run.pid}`;
    exec(`systemctl --user stop ${unit} 2>/dev/null`, () => {});
    const result = await terminateProcessTree(run.pid);
    registerRunComplete({ filename: safeFile, exitCode: 143, status: 'failed' });
    setTimeout(broadcastDashboardUpdate, 300);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `Subagent run ${safeFile} (PID ${run.pid}) stopped`,
      details: result,
    }));
    return;
  }

  // GET /api/logs/:filename/search
  if (pathname.startsWith('/api/logs/') && pathname.endsWith('/search') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/logs/', '').replace('/search', ''));
    const { safeFile, filePath } = getSafeLogPath(filename);
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || String(LOG_SEARCH_MAX_RESULTS), 10) || LOG_SEARCH_MAX_RESULTS, LOG_SEARCH_MAX_RESULTS);

    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing q search parameter' }));
      return;
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log file not found' }));
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      const matches = await searchLogFile(filePath, q, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ filename: safeFile, q, count: matches.length, limit, logSize: stat.size, matches }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/logs/:filename
  if (pathname.startsWith('/api/logs/') && !pathname.endsWith('/stream') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/logs/', ''));
    const { filePath } = getSafeLogPath(filename);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log file not found' }));
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      const requestedOffset = parseInt(parsedUrl.searchParams.get('offset') || '', 10);
      const requestedLimit = parseInt(parsedUrl.searchParams.get('limit') || '', 10);
      const tailBytes = parseInt(parsedUrl.searchParams.get('tailBytes') || '0', 10);
      const start = Number.isFinite(requestedOffset) && requestedOffset >= 0
        ? Math.min(requestedOffset, stat.size)
        : Number.isFinite(tailBytes) && tailBytes > 0
        ? Math.max(0, stat.size - tailBytes)
        : 0;
      const streamOptions = { start };
      if (Number.isFinite(requestedLimit) && requestedLimit > 0) {
        streamOptions.end = Math.min(stat.size - 1, start + requestedLimit - 1);
      }

      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Log-Offset': String(start),
        'X-Log-Size': String(stat.size),
      });
      if (start >= stat.size) {
        res.end('');
        return;
      }
      fs.createReadStream(filePath, streamOptions).pipe(res);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/logs/:filename/stream
  if (pathname.startsWith('/api/logs/') && pathname.endsWith('/stream') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/logs/', '').replace('/stream', ''));
    const { filePath } = getSafeLogPath(filename);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    if (!fs.existsSync(filePath)) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'File does not exist' })}\n\n`);
      res.end();
      return;
    }

    const initialSize = fs.statSync(filePath).size;
    const requestedOffset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
    let currentPos = Number.isFinite(requestedOffset) && requestedOffset > 0
      ? Math.min(requestedOffset, initialSize)
      : 0;
    const sendNewData = () => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size > currentPos) {
          const toRead = Math.min(stat.size - currentPos, LOG_STREAM_CHUNK_BYTES);
          const buf = Buffer.alloc(toRead);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, buf, 0, buf.length, currentPos);
          fs.closeSync(fd);
          currentPos += toRead;

          const chunk = buf.toString('utf8');
          res.write(`data: ${JSON.stringify({ type: 'data', chunk, size: stat.size })}\n\n`);
          if (stat.size > currentPos) setImmediate(sendNewData);
        }
      } catch (err) {}
    };

    sendNewData();

    let watcher = null;
    try {
      watcher = fs.watch(filePath, sendNewData);
    } catch {}

    const fallbackInterval = watcher ? null : setInterval(sendNewData, 2000);
    const keepAliveInterval = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'ping' })}\n\n`);
    }, 15000);

    req.on('close', () => {
      if (watcher) watcher.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
      clearInterval(keepAliveInterval);
    });
    return;
  }

  // GET /api/events
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // POST /api/dangling/kill-all
  if ((pathname === '/api/dangling/kill-all' || pathname === '/api/kill-dangling') && req.method === 'POST') {
    const stats = getStatsFromDb();
    const dangling = findDanglingSubagentProcesses(stats.activeRuns);
    const results = [];
    for (const proc of dangling) {
      await terminateProcessTree(proc.pid);
      results.push(proc.pid);
    }

    setTimeout(broadcastDashboardUpdate, 500);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      killedCount: results.length,
      killedPids: results,
    }));
    return;
  }

  // 404 for unmatched API
  if (pathname.startsWith('/api/')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API endpoint not found', path: pathname }));
    return;
  }

  // --- Static Files Serving ---
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  const staticFilePath = path.join(PUBLIC_DIR, reqPath);

  if (!staticFilePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(staticFilePath) && fs.statSync(staticFilePath).isFile()) {
    const contentType = getMimeType(staticFilePath);
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(staticFilePath).pipe(res);
    return;
  }

  const fallbackIndex = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(fallbackIndex)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(fallbackIndex).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  console.log(`[Dashboard] Agent Relay Visualizer running with SQLite engine at: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
