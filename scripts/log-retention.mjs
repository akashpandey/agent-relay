// Log retention for the disposable layer only: raw log files age out
// (opt-in via AGENT_RELAY_LOG_RETENTION, e.g. 30d / 12h / 90m), while the
// SQLite run history — summaries, session IDs, acceptance results — is kept
// indefinitely. The dashboard renders orphaned (log-file-less) runs fine.
import fs from 'node:fs';
import path from 'node:path';
import { getFilteredRuns } from '../dashboard/db.js';

// e.g. '30d' -> 30*24h. Unset or malformed -> null (retention disabled).
export function parseRetention(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d+)([dhm])$/);
  if (!match) return null;
  return Number(match[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2]];
}

// Negative on purpose: only completed/failed runs get their logs reaped, and
// runs without a parseable start time are left alone.
export function applyLogRetention({ retentionMs = null, logsDir = null, write = () => {} } = {}) {
  const ms = retentionMs ?? parseRetention(process.env.AGENT_RELAY_LOG_RETENTION);
  if (!ms || ms <= 0) return null;
  const cutoff = Date.now() - ms;
  try {
    if (!logsDir || !fs.existsSync(logsDir)) return null;
    const runs = getFilteredRuns({ limit: 5000, offset: 0 }).runs;
    const seen = new Set(runs.map(run => run.filename));
    let removed = 0, runningKept = 0;
    for (const run of runs) {
      if (run.status === 'running') { runningKept++; continue; }
      const started = Date.parse(run.startTime || '') || 0;
      // A row without a usable start time is history we do not gamble with.
      if (!started || started > cutoff) continue;
      const logFile = path.join(logsDir, run.filename);
      const doneFile = logFile.replace(/\.log$/, '.done');
      let existed = false;
      for (const file of [logFile, doneFile]) {
        try { fs.unlinkSync(file); existed = true; } catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
      if (existed) removed++;
    }
    // Orphan logs whose run row is already gone (e.g. pruned earlier): decide
    // by the file's own mtime. Only known sidecars — never foreign files. A
    // .done twin of a traceable run is never orphaned, so it is skipped too.
    for (const entry of fs.readdirSync(logsDir)) {
      if (!/\.(log|done)$/.test(entry)) continue;
      if (seen.has(entry) || seen.has(entry.replace(/\.done$/, '.log'))) continue;
      try {
        if (fs.statSync(path.join(logsDir, entry)).mtimeMs < cutoff) {
          fs.unlinkSync(path.join(logsDir, entry));
          removed++;
        }
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    if (removed) {
      const message = `agent-relay: log retention ${process.env.AGENT_RELAY_LOG_RETENTION}${retentionMs ? ' (explicit)' : ''} reaped ${removed} old log file(s)${runningKept ? `, kept ${runningKept} running` : ''}`;
      write(message);
    }
    return { removed, runningKept };
  } catch (err) {
    write(`agent-relay: log retention skipped (${err.message})`, 'WARN');
    return null;
  }
}
