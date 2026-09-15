#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
/**
 * agent-relay -> claude-mem Ingestion Bridge
 * Automatically captures subagent executions across OpenCode, Antigravity, Claude Code, and Codex.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import { Database } from 'bun:sqlite';

const WORKER_URL = process.env.CLAUDE_MEM_WORKER_URL || 'http://127.0.0.1:37777';
const SETTINGS_PATH = join(homedir(), '.claude-mem', 'settings.json');
const DB_PATH = join(homedir(), '.claude-mem', 'claude-mem.db');

// 1. Check if claude-mem worker is reachable
async function isWorkerAlive() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${WORKER_URL}/api/projects`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

// 2. Check if project is excluded in settings
function isProjectExcluded(workspacePath) {
  if (!existsSync(SETTINGS_PATH)) return false;
  try {
    const settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
    const excludedStr = settings.CLAUDE_MEM_EXCLUDED_PROJECTS || '';
    if (!excludedStr.trim()) return false;
    const excluded = excludedStr.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
    const projectName = basename(workspacePath).toLowerCase();
    return excluded.includes(projectName);
  } catch {
    return false;
  }
}

// 3. Check if session was already ingested
function isSessionAlreadyIngested(contentSessionId) {
  if (!existsSync(DB_PATH)) return false;
  try {
    const db = new Database(DB_PATH);
    const row = db.query(`
      SELECT COUNT(*) as count FROM observations WHERE memory_session_id LIKE ?
    `).get(`%${contentSessionId}%`);
    return (row?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

// 4. Extract Task Prompt from log file
function extractTaskPrompt(logPath) {
  if (!existsSync(logPath)) return '';
  try {
    const content = readFileSync(logPath, 'utf-8');
    const taskMatch = content.match(/Task:\s*\n([\s\S]*?)(?=\n---\n|\ntimestamp=|\n\[|\n>|$)/i);
    if (taskMatch && taskMatch[1].trim()) {
      return taskMatch[1].trim();
    }
  } catch {}
  return '';
}

// 5. Provider-Specific Tool Action Extractors
function extractOpenCodeActions(done) {
  const opencodeDbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  const actions = [];
  let summary = '';

  if (existsSync(opencodeDbPath) && done.sessionId && done.sessionId !== 'new') {
    try {
      const db = new Database(opencodeDbPath);
      const sessionRow = db.query(`SELECT title FROM session WHERE id = ?`).get(done.sessionId);
      if (sessionRow?.title) {
        summary = sessionRow.title;
      }

      const parts = db.query(`
        SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC
      `).all(done.sessionId);

      for (const p of parts) {
        try {
          const d = JSON.parse(p.data);
          if (d.type === 'tool') {
            actions.push({
              name: d.tool || 'tool',
              input: d.state?.input || { title: d.state?.title },
              output: d.state?.output ? { output: d.state.output } : { status: d.state?.status || 'completed' },
            });
          }
        } catch {}
      }
    } catch {}
  }

  // Fallback to log file parsing if DB didn't return actions
  if (actions.length === 0 && existsSync(done.logFile)) {
    try {
      const content = readFileSync(done.logFile, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (line.includes('message="tool call"') || line.includes('message=execute')) {
          actions.push({
            name: 'execute',
            input: { line: line.slice(0, 300) },
            output: { status: 'completed' },
          });
        }
      }
    } catch {}
  }

  return { actions, summary: summary || 'OpenCode subagent execution' };
}

function extractAntigravityActions(done) {
  const actions = [];
  const transcriptPath = join(homedir(), '.gemini', 'antigravity-cli', 'brain', done.sessionId, '.system_generated', 'logs', 'transcript.jsonl');
  let summary = 'Antigravity subagent execution';

  const tryPaths = [transcriptPath, done.logFile];
  for (const tPath of tryPaths) {
    if (existsSync(tPath)) {
      try {
        const lines = readFileSync(tPath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const step = JSON.parse(line);
            if (step.tool_calls && Array.isArray(step.tool_calls)) {
              for (const call of step.tool_calls) {
                actions.push({
                  name: call.tool_name || call.name || 'tool',
                  input: call.tool_input || call.args || {},
                  output: { status: 'completed' },
                });
              }
            }
          } catch {}
        }
        if (actions.length > 0) break;
      } catch {}
    }
  }

  return { actions, summary };
}

function extractGenericActions(done) {
  const actions = [];
  if (existsSync(done.logFile)) {
    try {
      const content = readFileSync(done.logFile, 'utf-8');
      actions.push({
        name: 'subagent_execution',
        input: { logFile: done.logFile, model: done.model, status: done.status },
        output: { status: done.status, exitCode: done.exitCode },
      });
    } catch {}
  }
  return { actions, summary: `${done.provider} subagent execution (${done.status})` };
}

// 6. Ingest single .done file
export async function ingestDoneFile(donePath, options = {}) {
  if (!existsSync(donePath)) {
    console.error(`Done file not found: ${donePath}`);
    return false;
  }

  let done;
  try {
    done = JSON.parse(readFileSync(donePath, 'utf-8'));
  } catch (e) {
    console.error(`Invalid JSON in ${donePath}:`, e);
    return false;
  }

  if (isProjectExcluded(done.workspace)) {
    console.log(`[claude-mem-bridge] Project ${basename(done.workspace)} is excluded in settings. Skipping.`);
    return true;
  }

  const contentSessionId = `subagent-${done.provider}-${done.sessionId || basename(donePath, '.done')}`;

  if (!options.force && isSessionAlreadyIngested(contentSessionId)) {
    console.log(`[claude-mem-bridge] Session ${contentSessionId} already ingested. Skipping.`);
    return true;
  }

  if (!await isWorkerAlive()) {
    console.log(`[claude-mem-bridge] Worker offline at ${WORKER_URL}. Skipping.`);
    return false;
  }

  let extracted;
  switch (done.provider) {
    case 'opencode':
      extracted = extractOpenCodeActions(done);
      break;
    case 'antigravity':
      extracted = extractAntigravityActions(done);
      break;
    default:
      extracted = extractGenericActions(done);
      break;
  }

  const taskPrompt = extractTaskPrompt(done.logFile);
  const platformSource = done.provider === 'antigravity' ? 'antigravity-cli' : done.provider;

  if (options.dryRun) {
    console.log(`[DRY RUN] Would ingest ${extracted.actions.length} action(s) for session ${contentSessionId} (${done.workspace})`);
    return true;
  }

  // Dispatch tool observations
  for (const act of extracted.actions) {
    try {
      await fetch(`${WORKER_URL}/api/sessions/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentSessionId,
          platformSource,
          tool_name: act.name,
          tool_input: act.input,
          tool_response: act.output || { status: 'completed' },
          cwd: done.workspace,
          agentId: `${done.provider}-subagent`,
          agentType: 'local-subagent',
        }),
      });
    } catch {}
  }

  // Dispatch summarize request
  const summaryMessage = taskPrompt ? `Task: ${taskPrompt}\n\n${extracted.summary}` : extracted.summary;
  try {
    await fetch(`${WORKER_URL}/api/sessions/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contentSessionId,
        platformSource,
        cwd: done.workspace,
        last_assistant_message: summaryMessage,
      }),
    });
  } catch {}

  console.log(`[claude-mem-bridge] Ingested ${extracted.actions.length} observation(s) from ${basename(donePath)} (${done.provider} -> ${basename(done.workspace)}).`);
  return true;
}

// 7. Ingest all recent .done files
export async function ingestAllDoneFiles(logsDir, options = {}) {
  if (!existsSync(logsDir)) {
    console.error(`Logs directory not found: ${logsDir}`);
    return;
  }

  const files = readdirSync(logsDir).filter(f => f.endsWith('.done'));
  console.log(`[claude-mem-bridge] Found ${files.length} .done file(s) in ${logsDir}. Processing...`);

  let count = 0;
  for (const f of files) {
    const fullPath = join(logsDir, f);
    const success = await ingestDoneFile(fullPath, options);
    if (success) count++;
  }
  console.log(`[claude-mem-bridge] Completed backfill: ${count}/${files.length} processed.`);
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isForce = args.includes('--force');
  const logsDir = join(homedir(), 'agent-relay', 'logs');

  if (args.includes('--all') || args.includes('-a')) {
    await ingestAllDoneFiles(logsDir, { dryRun: isDryRun, force: isForce });
  } else if (args[0] && !args[0].startsWith('--')) {
    await ingestDoneFile(resolve(args[0]), { dryRun: isDryRun, force: isForce });
  } else {
    console.log(`Usage:
  bun ingest-to-claude-mem.js <path/to/session.done>
  bun ingest-to-claude-mem.js --all [--force] [--dry-run]
`);
  }
}
