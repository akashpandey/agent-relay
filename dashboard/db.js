import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DB_DIR = process.env.SUBAGENT_DATA_DIR || path.resolve(__dirname, '../data');
export const DB_PATH = process.env.SUBAGENT_DB_PATH || path.join(DB_DIR, 'subagents.db');

// Ensure directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let dbInstance = null;

export function getDatabase() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    
    // Performance tuning: WAL mode and normal synchronous for ultra-fast concurrency
    dbInstance.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS runs (
        filename TEXT PRIMARY KEY,
        pid INTEGER,
        provider TEXT NOT NULL,
        model TEXT,
        workspace TEXT,
        workspace_name TEXT,
        session_id TEXT,
        task TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        start_time TEXT NOT NULL,
        end_time TEXT,
        duration_sec INTEGER DEFAULT 0,
        current_action TEXT,
        tokens_total INTEGER DEFAULT 0,
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        tokens_reasoning INTEGER DEFAULT 0,
        tokens_cache_read INTEGER DEFAULT 0,
        tokens_cache_write INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        markdown_summary TEXT,
        files_modified TEXT, -- JSON array
        diffs TEXT,
        tool_calls TEXT, -- JSON array
        cli_command TEXT,
        exit_code INTEGER,
        log_size INTEGER DEFAULT 0,
        log_mtime INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_start_time ON runs(start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_provider ON runs(provider);
      CREATE INDEX IF NOT EXISTS idx_runs_workspace ON runs(workspace);
      CREATE INDEX IF NOT EXISTS idx_runs_pid ON runs(pid);
    `);
  }
  return dbInstance;
}

/**
 * Format DB row back into dashboard run metadata object
 */
export function rowToRunMeta(row, isAlive = false) {
  if (!row) return null;
  return {
    filename: row.filename,
    provider: row.provider,
    pid: row.pid,
    model: row.model || 'default',
    workspace: row.workspace || 'Unknown',
    workspaceName: row.workspace_name || (row.workspace ? path.basename(row.workspace) : 'Unknown'),
    session: row.session_id || 'new',
    sessionId: row.session_id || null,
    task: row.task || '',
    status: isAlive ? 'running' : row.status,
    isAlive: isAlive,
    startTime: row.start_time,
    endTime: row.end_time,
    durationSec: row.duration_sec || 0,
    currentAction: row.current_action || (isAlive ? 'Running...' : 'Finished'),
    tokens: row.tokens_total > 0 ? {
      total: row.tokens_total,
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cacheRead: row.tokens_cache_read,
      cacheWrite: row.tokens_cache_write,
    } : null,
    cost: row.cost || 0,
    markdownSummary: row.markdown_summary || null,
    filesModified: row.files_modified ? JSON.parse(row.files_modified) : [],
    diffs: row.diffs || null,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : [],
    cliCommand: row.cli_command || '',
    exitCode: row.exit_code,
    size: row.log_size || 0,
    mtime: row.log_mtime || 0,
  };
}

/**
 * Upsert a run record into SQLite
 */
export function upsertRun(run) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO runs (
      filename, pid, provider, model, workspace, workspace_name, session_id,
      task, status, start_time, end_time, duration_sec, current_action,
      tokens_total, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      cost, markdown_summary, files_modified, diffs, tool_calls, cli_command,
      exit_code, log_size, log_mtime, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, datetime('now')
    )
    ON CONFLICT(filename) DO UPDATE SET
      pid = excluded.pid,
      provider = excluded.provider,
      model = excluded.model,
      workspace = excluded.workspace,
      workspace_name = excluded.workspace_name,
      session_id = excluded.session_id,
      task = CASE WHEN excluded.task IS NOT NULL AND excluded.task != '' THEN excluded.task ELSE runs.task END,
      status = excluded.status,
      end_time = excluded.end_time,
      duration_sec = excluded.duration_sec,
      current_action = excluded.current_action,
      tokens_total = excluded.tokens_total,
      tokens_input = excluded.tokens_input,
      tokens_output = excluded.tokens_output,
      tokens_reasoning = excluded.tokens_reasoning,
      tokens_cache_read = excluded.tokens_cache_read,
      tokens_cache_write = excluded.tokens_cache_write,
      cost = excluded.cost,
      markdown_summary = CASE WHEN excluded.markdown_summary IS NOT NULL THEN excluded.markdown_summary ELSE runs.markdown_summary END,
      files_modified = excluded.files_modified,
      diffs = CASE WHEN excluded.diffs IS NOT NULL THEN excluded.diffs ELSE runs.diffs END,
      tool_calls = excluded.tool_calls,
      cli_command = excluded.cli_command,
      exit_code = excluded.exit_code,
      log_size = excluded.log_size,
      log_mtime = excluded.log_mtime,
      updated_at = datetime('now')
  `);

  const filesJson = JSON.stringify(run.filesModified || []);
  const toolsJson = JSON.stringify(run.toolCalls || []);
  const tokens = run.tokens || {};

  stmt.run(
    run.filename,
    run.pid || null,
    run.provider,
    run.model || 'default',
    run.workspace || 'Unknown',
    run.workspaceName || (run.workspace ? path.basename(run.workspace) : 'Unknown'),
    run.session || run.sessionId || null,
    run.task || '',
    run.status || 'running',
    run.startTime,
    run.endTime || null,
    run.durationSec || 0,
    run.currentAction || (run.status === 'running' ? 'Running...' : 'Finished'),
    tokens.total || 0,
    tokens.input || 0,
    tokens.output || 0,
    tokens.reasoning || 0,
    tokens.cacheRead || 0,
    tokens.cacheWrite || 0,
    run.cost || 0,
    run.markdownSummary || null,
    filesJson,
    run.diffs || null,
    toolsJson,
    run.cliCommand || '',
    run.exitCode !== undefined ? run.exitCode : null,
    run.size || 0,
    run.mtime || 0
  );
}

/**
 * Register a subagent run start immediately
 */
export function registerRunStart({ filename, pid, provider, model, workspace, session, task, startTime }) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO runs (
      filename, pid, provider, model, workspace, workspace_name, session_id,
      task, status, start_time, current_action, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 'Starting subagent...', datetime('now'))
    ON CONFLICT(filename) DO UPDATE SET
      pid = excluded.pid,
      provider = excluded.provider,
      model = excluded.model,
      workspace = excluded.workspace,
      workspace_name = excluded.workspace_name,
      session_id = excluded.session_id,
      task = excluded.task,
      status = 'running',
      updated_at = datetime('now')
  `);

  stmt.run(
    filename,
    pid || null,
    provider,
    model || 'default',
    workspace || 'Unknown',
    workspace ? path.basename(workspace) : 'Unknown',
    session || 'new',
    task || '',
    startTime || new Date().toISOString()
  );
}

/**
 * Register a subagent run completion
 */
export function registerRunComplete({ filename, exitCode, status, sessionId, endTime, markdownSummary, durationSec }) {
  const db = getDatabase();
  const stmt = db.prepare(`
    UPDATE runs SET
      status = ?,
      exit_code = ?,
      session_id = COALESCE(?, session_id),
      end_time = ?,
      duration_sec = COALESCE(?, duration_sec),
      markdown_summary = COALESCE(?, markdown_summary),
      current_action = 'Finished',
      updated_at = datetime('now')
    WHERE filename = ?
  `);

  stmt.run(
    status || (exitCode === 0 ? 'completed' : 'failed'),
    exitCode !== undefined ? exitCode : null,
    sessionId || null,
    endTime || new Date().toISOString(),
    durationSec !== undefined ? durationSec : null,
    markdownSummary || null,
    filename
  );
}

/**
 * Fast indexed queries
 */
export function getAllRunsFromDb(limit = 1000, offset = 0) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM runs ORDER BY start_time DESC LIMIT ? OFFSET ?');
  const rows = stmt.all(limit, offset);
  return rows.map(r => rowToRunMeta(r, r.status === 'running'));
}

export function getFilteredRuns({ provider, status, workspace, q, limit = 50, offset = 0 }) {
  const db = getDatabase();
  let whereClauses = [];
  let params = [];

  if (provider && provider !== 'all') {
    whereClauses.push('LOWER(provider) = LOWER(?)');
    params.push(provider);
  }
  if (status && status !== 'all') {
    whereClauses.push('LOWER(status) = LOWER(?)');
    params.push(status);
  }
  if (workspace && workspace !== 'all') {
    whereClauses.push('(workspace LIKE ? OR LOWER(workspace_name) = LOWER(?))');
    params.push(`%${workspace}%`, workspace);
  }
  if (q) {
    whereClauses.push('(filename LIKE ? OR workspace LIKE ? OR model LIKE ? OR task LIKE ? OR CAST(pid AS TEXT) LIKE ?)');
    const qPattern = `%${q}%`;
    params.push(qPattern, qPattern, qPattern, qPattern, qPattern);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  
  const countStmt = db.prepare(`SELECT COUNT(*) as count FROM runs ${whereSql}`);
  const total = countStmt.get(...params)?.count || 0;

  const dataStmt = db.prepare(`
    SELECT * FROM runs ${whereSql}
    ORDER BY start_time DESC
    LIMIT ? OFFSET ?
  `);
  const rows = dataStmt.all(...params, limit, offset);

  return {
    total,
    limit,
    offset,
    runs: rows.map(r => rowToRunMeta(r, r.status === 'running'))
  };
}

export function getStatsFromDb() {
  const db = getDatabase();
  const todayPrefix = new Date().toISOString().slice(0, 10);
  
  const totalCount = db.prepare('SELECT COUNT(*) as count FROM runs').get()?.count || 0;
  const activeRows = db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY start_time DESC").all();
  const todayCount = db.prepare('SELECT COUNT(*) as count FROM runs WHERE start_time LIKE ?').get(`${todayPrefix}%`)?.count || 0;
  
  const providerRows = db.prepare('SELECT provider, COUNT(*) as count FROM runs GROUP BY provider').all();
  const byProvider = {};
  for (const r of providerRows) {
    byProvider[r.provider] = r.count;
  }

  const recentRows = db.prepare('SELECT * FROM runs ORDER BY start_time DESC LIMIT 50').all();

  return {
    totalCount,
    activeCount: activeRows.length,
    activeRuns: activeRows.map(r => rowToRunMeta(r, true)),
    todayCount,
    byProvider,
    recentRuns: recentRows.map(r => rowToRunMeta(r, r.status === 'running'))
  };
}

export function getAnalyticsFromDb() {
  const db = getDatabase();
  const totalRow = db.prepare(`
    SELECT 
      COUNT(*) as total_runs,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as active_count,
      SUM(tokens_total) as total_tokens,
      SUM(cost) as total_cost,
      AVG(duration_sec) as avg_duration,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
    FROM runs
  `).get();

  const modelRows = db.prepare('SELECT model, COUNT(*) as count FROM runs WHERE model IS NOT NULL GROUP BY model').all();
  const modelDistribution = {};
  for (const r of modelRows) {
    modelDistribution[r.model] = r.count;
  }

  const providerRows = db.prepare('SELECT provider, COUNT(*) as count FROM runs GROUP BY provider').all();
  const providerDistribution = {};
  for (const r of providerRows) {
    providerDistribution[r.provider] = r.count;
  }

  const completed = totalRow?.completed_count || 0;
  const failed = totalRow?.failed_count || 0;
  const successRate = (completed + failed) > 0 ? Math.round((completed / (completed + failed)) * 100) : 100;

  return {
    totalRuns: totalRow?.total_runs || 0,
    activeCount: totalRow?.active_count || 0,
    totalTokens: totalRow?.total_tokens || 0,
    totalCost: Number((totalRow?.total_cost || 0).toFixed(4)),
    avgDurationSec: Math.round(totalRow?.avg_duration || 0),
    successRate,
    completedCount: completed,
    failedCount: failed,
    modelDistribution,
    providerDistribution
  };
}

export function getWorkspacesFromDb() {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT 
      workspace as path,
      workspace_name as name,
      COUNT(*) as totalRuns,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as activeRuns,
      MAX(start_time) as lastRun
    FROM runs
    WHERE workspace IS NOT NULL AND workspace != 'Unknown'
    GROUP BY workspace
    ORDER BY totalRuns DESC
  `).all();

  return rows;
}

export function getRun(filename) {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM runs WHERE filename = ? LIMIT 1');
  const row = stmt.get(filename);
  return row ? rowToRunMeta(row, row.status === 'running') : null;
}
