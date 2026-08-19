#!/usr/bin/env node
import { registerRunStart, registerRunComplete } from '../dashboard/db.js';

const action = process.argv[2];

if (action === 'start') {
  const [,, filename, pid, provider, model, workspace, session, ...taskParts] = process.argv;
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
  const [,, filename, exitCode, sessionId, durationSec] = process.argv;
  registerRunComplete({
    filename,
    exitCode: parseInt(exitCode, 10),
    sessionId: sessionId || null,
    durationSec: parseInt(durationSec, 10) || null
  });
}
