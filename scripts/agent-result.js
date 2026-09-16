#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRun, upsertRun } from '../dashboard/db.js';
import { parseLogMetadata } from '../dashboard/parser.js';
import { buildRunCommands } from '../dashboard/commands.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoDir = path.resolve(__dirname, '..');
const logsDir = process.env.AGENT_RELAY_LOG_DIR || process.env.SUBAGENT_LOG_DIR || path.join(repoDir, 'logs');
const procDir = process.env.PROC_DIR || '/proc';
const input = process.argv[2];

if (!input) {
  console.error('agent-result: missing log file');
  process.exit(2);
}

const filename = path.basename(input);
const logFile = path.isAbsolute(input) ? input : path.join(logsDir, filename);
let run = null;

try {
  const meta = parseLogMetadata(filename, logFile, procDir);
  if (meta) {
    upsertRun(meta);
    run = meta;
  }
} catch {}

if (!run) run = getRun(filename);
if (!run) {
  console.error(`agent-result: run not found: ${filename}`);
  process.exit(1);
}

const result = run.result || null;
const sessionId = run.sessionId || run.session || null;
const outcome = run.outcome || result?.outcome || 'unknown';
const attentionRequired = Boolean(run.attentionRequired || result?.attentionRequired);
const { runAgainCommand, continuation } = buildRunCommands(run, sessionId);
console.log(JSON.stringify({
  filename: run.filename,
  processStatus: run.status,
  exitCode: run.exitCode ?? null,
  outcome,
  attentionRequired,
  accepted: outcome === 'done' && !attentionRequired,
  blockers: result?.blockers || [],
  incomplete: result?.incomplete || [],
  verification: result?.verification || [],
  changedFiles: result?.changedFiles?.length ? result.changedFiles : (run.filesModified || []),
  nextSteps: result?.nextSteps || [],
  summary: result?.summary || run.markdownSummary || '',
  logFile: logFile,
  sessionId,
  continuation,
  runAgainCommand,
  provider: run.provider,
  model: run.model,
}, null, 2));
