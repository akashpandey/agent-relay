#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, deleteRun, getRunLogFingerprint, resetRuns, upsertRun } from './db.js';
import { parseLogMetadata } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGS_DIR = process.env.LOGS_DIR || path.resolve(__dirname, '../logs');
const PROC_DIR = process.env.PROC_DIR || '/proc';
const rebuild = process.argv.includes('--rebuild');
const force = rebuild || process.argv.includes('--force');

if (rebuild) {
  resetRuns();
  console.log('[Sync] Rebuilt SQLite cache from scratch.');
}

console.log(`[Sync] Syncing logs from ${LOGS_DIR} into SQLite...`);
const start = performance.now();

if (fs.existsSync(LOGS_DIR)) {
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
  console.log(`[Sync] Found ${files.length} log files to process.`);
  
  let synced = 0;
  let skipped = 0;
  for (const file of files) {
    const filePath = path.join(LOGS_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      const cached = getRunLogFingerprint(file);
      if (!force && cached && cached.log_size === stat.size && cached.log_mtime === Math.floor(stat.mtimeMs)) {
        skipped++;
        continue;
      }
      const meta = parseLogMetadata(file, filePath, PROC_DIR);
      if (meta) {
        upsertRun(meta);
        synced++;
      }
    } catch (e) {
      console.warn(`[Sync] Error syncing ${file}:`, e.message);
    }
  }

  // Prune any records in SQLite whose log file no longer exists
  let pruned = 0;
  try {
    const db = getDatabase();
    const rows = db.prepare('SELECT filename FROM runs').all();
    for (const r of rows) {
      if (!fs.existsSync(path.join(LOGS_DIR, r.filename))) {
        deleteRun(r.filename);
        pruned++;
      }
    }
  } catch (e) {
    console.warn('[Sync] Error checking orphaned DB rows:', e.message);
  }

  const duration = (performance.now() - start).toFixed(2);
  console.log(`[Sync] Synced ${synced} runs, skipped ${skipped} unchanged, pruned ${pruned} missing in ${duration}ms.`);
}
