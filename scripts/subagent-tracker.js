#!/usr/bin/env node
import { registerRunStart, registerRunComplete } from '../dashboard/db.js';

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
  registerRunComplete({
    filename,
    exitCode: parseInt(exitCode, 10),
    sessionId: sessionId || null,
    durationSec: parseInt(durationSec, 10) || null
  });
}
