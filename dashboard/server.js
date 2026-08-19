import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLogFilename, isProcessRunning, parseLogMetadata } from './parser.js';
import {
  getStatsFromDb,
  getFilteredRuns,
  getAnalyticsFromDb,
  getWorkspacesFromDb,
  getRun,
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

// Ensure logs directory exists
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

console.log(`[Dashboard] Initializing SQLite-backed subagent visualizer...`);
console.log(`[Dashboard] Logs Directory: ${LOGS_DIR}`);
console.log(`[Dashboard] Proc Directory: ${PROC_DIR}`);

/**
 * Reconcile active runs with real process table to catch dead / completed jobs
 */
function reconcileActiveRuns(activeRuns) {
  for (const r of activeRuns) {
    if (r.pid) {
      const proc = isProcessRunning(r.pid, PROC_DIR);
      if (!proc.isAlive) {
        // Process is dead, parse full log to finalize tokens, diffs, and summary
        const filePath = path.join(LOGS_DIR, r.filename);
        if (fs.existsSync(filePath)) {
          const meta = parseLogMetadata(r.filename, filePath, PROC_DIR);
          if (meta) {
            upsertRun(meta);
          } else {
            registerRunComplete({ filename: r.filename, exitCode: 0, status: 'completed' });
          }
        } else {
          registerRunComplete({ filename: r.filename, exitCode: 0, status: 'completed' });
        }
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

        if (cmd.includes('server.js') || cmd.includes('local-subagents-dashboard')) {
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

function broadcastDashboardUpdate() {
  if (sseClients.size === 0) return;
  const stats = getStatsFromDb();
  reconcileActiveRuns(stats.activeRuns);

  const payload = JSON.stringify({
    type: 'stats_update',
    activeCount: stats.activeCount,
    totalCount: stats.totalCount,
    todayCount: stats.todayCount,
    byProvider: stats.byProvider,
    activeRuns: stats.activeRuns,
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
    if (!filename || !filename.endsWith('.log')) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const filePath = path.join(LOGS_DIR, filename);
      if (fs.existsSync(filePath)) {
        try {
          const meta = parseLogMetadata(filename, filePath, PROC_DIR);
          if (meta) upsertRun(meta);
        } catch {}
      }
      broadcastDashboardUpdate();
    }, 200);
  });
} catch (e) {
  console.warn('[Dashboard] Could not attach fs.watch to logs dir:', e.message);
}

// Interval broadcast every 2s
setInterval(() => {
  broadcastDashboardUpdate();
}, 2000);

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
    const stats = getStatsFromDb();
    reconcileActiveRuns(stats.activeRuns);
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
    const workspace = parsedUrl.searchParams.get('workspace');
    const q = (parsedUrl.searchParams.get('q') || '').trim();
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
    const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);

    const result = getFilteredRuns({ provider, status, workspace, q, limit, offset });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
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

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(meta));
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

  // GET /api/logs/:filename
  if (pathname.startsWith('/api/logs/') && !pathname.endsWith('/stream') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/logs/', ''));
    const safeFile = path.basename(filename);
    const filePath = path.join(LOGS_DIR, safeFile);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log file not found' }));
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/logs/:filename/stream
  if (pathname.startsWith('/api/logs/') && pathname.endsWith('/stream') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/logs/', '').replace('/stream', ''));
    const safeFile = path.basename(filename);
    const filePath = path.join(LOGS_DIR, safeFile);

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

    let currentPos = 0;
    const sendNewData = () => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size > currentPos) {
          const buf = Buffer.alloc(stat.size - currentPos);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, buf, 0, buf.length, currentPos);
          fs.closeSync(fd);
          currentPos = stat.size;

          const chunk = buf.toString('utf8');
          res.write(`data: ${JSON.stringify({ type: 'data', chunk, size: stat.size })}\n\n`);
        }
      } catch (err) {}
    };

    sendNewData();
    const streamInterval = setInterval(sendNewData, 500);

    req.on('close', () => {
      clearInterval(streamInterval);
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
  console.log(`[Dashboard] Local Subagents Visualizer running with SQLite engine at: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
