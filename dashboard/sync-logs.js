#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, upsertRun } from './db.js';
import { parseLogMetadata } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGS_DIR = process.env.LOGS_DIR || path.resolve(__dirname, '../logs');
const PROC_DIR = process.env.PROC_DIR || '/proc';

console.log(`[Sync] Syncing logs from ${LOGS_DIR} into SQLite...`);
const start = performance.now();

if (fs.existsSync(LOGS_DIR)) {
  const files = fs.readdirSync(LOGS_DIR).filter(f => f.endsWith('.log'));
  console.log(`[Sync] Found ${files.length} log files to process.`);
  
  let synced = 0;
  for (const file of files) {
    const filePath = path.join(LOGS_DIR, file);
    try {
      const meta = parseLogMetadata(file, filePath, PROC_DIR);
      if (meta) {
        upsertRun(meta);
        synced++;
      }
    } catch (e) {
      console.warn(`[Sync] Error syncing ${file}:`, e.message);
    }
  }
  const duration = (performance.now() - start).toFixed(2);
  console.log(`[Sync] Successfully synced ${synced} runs into SQLite in ${duration}ms!`);
}
