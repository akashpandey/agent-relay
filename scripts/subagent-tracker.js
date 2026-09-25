#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRunStart, registerRunComplete } from '../dashboard/db.js';

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), '..');
const logsDir = process.env.AGENT_RELAY_LOG_DIR || process.env.SUBAGENT_LOG_DIR || path.join(repoDir, 'logs');

const [action, ...args] = process.argv.slice(2);

if (action === 'start') {
  const [filename, pid, provider, model, workspace, session, ...taskParts] = args;
  registerRunStart({
    filename,
    pid: parseInt(pid, 10) || null,
    provider,
    model,
    workspace,
    session,
    task: taskParts.join(' ')
  });
} else if (action === 'complete') {
  const [filename, exitCode, sessionId, durationSec] = args;

  // Read the .done sentinel (written by write-done.mjs before this script runs)
  // to extract the structured outcome and populate it directly into the DB row.
  let outcome = null;
  let attentionRequired = null;
  let resultJson = null;
  try {
    const donePath = path.join(logsDir, filename.replace(/\.log$/, '.done'));
    if (fs.existsSync(donePath)) {
      const done = JSON.parse(fs.readFileSync(donePath, 'utf8'));
      if (done.result) {
        outcome = done.result.outcome || null;
        attentionRequired = Boolean(done.result.attentionRequired);
        resultJson = JSON.stringify(done.result);
      }
    }
  } catch {}

  registerRunComplete({
    filename,
    exitCode: parseInt(exitCode, 10),
    sessionId: sessionId || null,
    durationSec: parseInt(durationSec, 10) || null,
    outcome,
    attentionRequired,
    resultJson,
  });
}
