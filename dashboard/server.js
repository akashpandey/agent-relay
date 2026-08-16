import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLogFilename, isProcessRunning, parseLogMetadata } from './parser.js';

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

console.log(`[Dashboard] Initializing subagent visualizer...`);
console.log(`[Dashboard] Logs Directory: ${LOGS_DIR}`);
console.log(`[Dashboard] Proc Directory: ${PROC_DIR}`);

/**
 * Returns all log entries sorted newest first
 */
function getAllRuns() {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
  // Sort descending by filename timestamp
  files.sort((a, b) => b.localeCompare(a));
  
  const runs = [];
  for (const file of files) {
    const filePath = path.join(LOGS_DIR, file);
    const meta = parseLogMetadata(file, filePath, PROC_DIR);
    if (meta) {
      runs.push(meta);
    }
  }
  return runs;
}

/**
 * Find all dangling subagent processes on the system
 * Strictly scoped to local-subagent wrapper scripts and local-subagent systemd units.
 */
function findDanglingSubagentProcesses() {
  const dangling = [];
  if (!fs.existsSync(PROC_DIR)) return dangling;

  try {
    const entries = fs.readdirSync(PROC_DIR);
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      try {
        const cmdlinePath = path.join(PROC_DIR, entry, 'cmdline');
        const cgroupPath = path.join(PROC_DIR, entry, 'cgroup');

        let isSubagent = false;
        let cmd = '';

        // Check if part of local-subagent systemd unit
        if (fs.existsSync(cgroupPath)) {
          const cgroupContent = fs.readFileSync(cgroupPath, 'utf8');
          if (cgroupContent.includes('local-subagent-')) {
            isSubagent = true;
          }
        }

        // Check cmdline
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
          }
        }

        // Exclude the visualizer dashboard server itself
        if (cmd.includes('server.js') || cmd.includes('local-subagents-dashboard')) {
          isSubagent = false;
        }

        if (isSubagent) {
          dangling.push({
            pid,
            cmd: cmd.slice(0, 140) || 'local-subagent process',
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
      // Try kill process group and children via pkill/kill
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

/**
 * MIME type helper
 */
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
  const runs = getAllRuns();
  const activeRuns = runs.filter(r => r.isAlive);
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const todayRuns = runs.filter(r => r.startTime.startsWith(todayPrefix));
  
  const byProvider = {};
  for (const r of runs) {
    byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;
  }

  const payload = JSON.stringify({
    type: 'stats_update',
    activeCount: activeRuns.length,
    totalCount: runs.length,
    todayCount: todayRuns.length,
    byProvider,
    activeRuns,
    timestamp: new Date().toISOString(),
  });

  for (const res of sseClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

// Watch directory for changes and broadcast
let debounceTimer = null;
try {
  fs.watch(LOGS_DIR, (eventType, filename) => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      broadcastDashboardUpdate();
    }, 400);
  });
} catch (e) {
  console.warn('[Dashboard] Could not attach fs.watch to logs dir:', e.message);
}

// Interval broadcast every 2s for elapsed time & alive status changes
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
    const runs = getAllRuns();
    const activeRuns = runs.filter(r => r.isAlive);
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const todayRuns = runs.filter(r => r.startTime.startsWith(todayPrefix));
    
    const byProvider = {};
    for (const r of runs) {
      byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;
    }

    const dangling = findDanglingSubagentProcesses();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      activeCount: activeRuns.length,
      danglingCount: dangling.length,
      totalCount: runs.length,
      todayCount: todayRuns.length,
      byProvider,
      activeRuns,
      danglingProcesses: dangling,
      recentRuns: runs.slice(0, 50),
    }));
    return;
  }

  // GET /api/workspaces
  if (pathname === '/api/workspaces' && req.method === 'GET') {
    const runs = getAllRuns();
    const map = {};
    for (const r of runs) {
      const ws = r.workspace || 'Unknown';
      if (!map[ws]) {
        map[ws] = {
          path: ws,
          name: r.workspaceName || path.basename(ws),
          totalRuns: 0,
          activeRuns: 0,
          lastRun: r.startTime,
        };
      }
      map[ws].totalRuns++;
      if (r.isAlive) map[ws].activeRuns++;
    }
    const workspaces = Object.values(map).sort((a, b) => b.totalRuns - a.totalRuns);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ workspaces }));
    return;
  }

  // GET /api/analytics
  if (pathname === '/api/analytics' && req.method === 'GET') {
    const runs = getAllRuns();
    let totalTokens = 0;
    let totalCost = 0;
    let totalDurationSec = 0;
    let completedCount = 0;
    let failedCount = 0;
    const modelDistribution = {};
    const providerDistribution = {};

    for (const r of runs) {
      if (r.tokens && r.tokens.total) totalTokens += r.tokens.total;
      if (r.cost) totalCost += r.cost;
      if (r.durationSec) totalDurationSec += r.durationSec;
      if (r.status === 'completed') completedCount++;
      if (r.status === 'failed') failedCount++;
      if (r.model) modelDistribution[r.model] = (modelDistribution[r.model] || 0) + 1;
      if (r.provider) providerDistribution[r.provider] = (providerDistribution[r.provider] || 0) + 1;
    }

    const avgDurationSec = runs.length > 0 ? Math.round(totalDurationSec / runs.length) : 0;
    const successRate = (completedCount + failedCount) > 0 ? Math.round((completedCount / (completedCount + failedCount)) * 100) : 100;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalRuns: runs.length,
      totalTokens,
      totalCost,
      avgDurationSec,
      successRate,
      completedCount,
      failedCount,
      modelDistribution,
      providerDistribution,
    }));
    return;
  }

  // GET /api/runs
  if (pathname === '/api/runs' && req.method === 'GET') {
    let runs = getAllRuns();
    const provider = parsedUrl.searchParams.get('provider');
    const status = parsedUrl.searchParams.get('status');
    const workspace = parsedUrl.searchParams.get('workspace');
    const q = (parsedUrl.searchParams.get('q') || '').toLowerCase();
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
    const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);

    if (provider && provider !== 'all') {
      runs = runs.filter(r => r.provider.toLowerCase() === provider.toLowerCase());
    }
    if (status && status !== 'all') {
      runs = runs.filter(r => r.status.toLowerCase() === status.toLowerCase());
    }
    if (workspace && workspace !== 'all') {
      runs = runs.filter(r => (r.workspace || '').includes(workspace) || (r.workspaceName || '').toLowerCase() === workspace.toLowerCase());
    }
    if (q) {
      runs = runs.filter(r => 
        r.filename.toLowerCase().includes(q) ||
        r.workspace.toLowerCase().includes(q) ||
        r.model.toLowerCase().includes(q) ||
        r.task.toLowerCase().includes(q) ||
        String(r.pid).includes(q)
      );
    }

    const total = runs.length;
    const paginated = runs.slice(offset, offset + limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      total,
      limit,
      offset,
      runs: paginated,
    }));
    return;
  }

  // GET /api/runs/:filename
  if (pathname.startsWith('/api/runs/') && !pathname.endsWith('/kill') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/runs/', ''));
    const safeFile = path.basename(filename);
    const filePath = path.join(LOGS_DIR, safeFile);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log file not found' }));
      return;
    }

    const meta = parseLogMetadata(safeFile, filePath, PROC_DIR);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(meta));
    return;
  }

  // GET /api/logs/:filename
  if (pathname.startsWith('/api/logs/') && !pathname.endsWith('/stream') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/logs/', ''));
    const safeFile = path.basename(filename);
    const filePath = path.join(LOGS_DIR, safeFile);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Log file not found');
      return;
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': stat.size,
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    return;
  }

  // GET /api/logs/:filename/stream (SSE real-time streaming)
  if (pathname.startsWith('/api/logs/') && pathname.endsWith('/stream') && req.method === 'GET') {
    const filename = decodeURIComponent(pathname.replace('/api/logs/', '').replace('/stream', ''));
    const safeFile = path.basename(filename);
    const filePath = path.join(LOGS_DIR, safeFile);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log file not found' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let currentPos = 0;
    const sendNewData = () => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size > currentPos) {
          const len = stat.size - currentPos;
          const buf = Buffer.alloc(len);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, buf, 0, len, currentPos);
          fs.closeSync(fd);
          currentPos = stat.size;

          const chunk = buf.toString('utf8');
          res.write(`data: ${JSON.stringify({ type: 'data', chunk, size: stat.size })}\n\n`);
        }
      } catch (err) {}
    };

    // Initial send
    sendNewData();

    // Polling file interval for active streaming
    const streamInterval = setInterval(sendNewData, 500);

    req.on('close', () => {
      clearInterval(streamInterval);
    });
    return;
  }

  // GET /api/events (SSE for global dashboard updates)
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

  // POST /api/runs/:pid/kill
  if (pathname.startsWith('/api/runs/') && pathname.endsWith('/kill') && req.method === 'POST') {
    const match = pathname.match(/\/api\/runs\/(\d+)\/kill/);
    if (!match) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid PID' }));
      return;
    }

    const pid = parseInt(match[1], 10);
    const result = await terminateProcessTree(pid);
    
    // Broadcast update immediately
    setTimeout(broadcastDashboardUpdate, 500);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      message: `Process tree termination signal sent to PID ${pid}`,
      details: result,
    }));
    return;
  }

  // POST /api/kill-dangling (Kill all dangling subagent processes)
  if (pathname === '/api/kill-dangling' && req.method === 'POST') {
    const dangling = findDanglingSubagentProcesses();
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

  // --- Static Files Serving ---
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  const staticFilePath = path.join(PUBLIC_DIR, reqPath);

  // Prevent directory traversal
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

  // Fallback to index.html for single page app routes
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
  console.log(`[Dashboard] Local Subagents Visualizer running at: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
