import fs from 'node:fs';
import { extractStructuredOutcome } from '../dashboard/parser.js';

const [logFile, provider, workspace, model, fallbackSession, code, offset] = process.argv.slice(2);
try {
  const buffer = fs.existsSync(logFile) ? fs.readFileSync(logFile) : Buffer.alloc(0);
  const text = buffer.toString('utf8');
  // Decode provider stream envelopes; never parse tool output or the echoed prompt.
  const pid = logFile.match(/-(\d+)\.log$/)?.[1];
  const marker = `agent-output-start: ${pid}\n`;
  const markerIndex = text.indexOf(marker);
  const start = offset && Number.isSafeInteger(Number(offset)) ? Number(offset)
    : markerIndex < 0 ? buffer.length : Buffer.byteLength(text.slice(0, markerIndex + marker.length));
  const body = buffer.subarray(start).toString('utf8');
  const systemdUnit = text.slice(0, markerIndex < 0 ? 0 : markerIndex).match(/^agent-unit: ([^\r\n]+)$/m)?.[1] || null;
  const messages = [];
  let recordedSession = null;
  let runningStreamText = '';
  for (const line of body.split('\n')) {
    try {
      const event = JSON.parse(line);
      recordedSession = event.session_id || event.conversation_id || event.sessionID || event.thread_id || event.init?.conversation_id || recordedSession;
      if (event.type === 'result' && typeof event.result === 'string') messages.push(event.result);
      if (event.type === 'assistant') {
        messages.push((event.message?.content || []).filter(part => part.type === 'text').map(part => part.text).join(''));
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') messages.push(event.item.text);
      if (event.type === 'text' && event.part?.type === 'text' && typeof event.part.text === 'string') messages.push(event.part.text);
      if (event.event === 'step_update' && event.step_update?.text_delta) {
        runningStreamText += event.step_update.text_delta;
      }
    } catch {}
  }
  if (runningStreamText.trim()) messages.push(runningStreamText.trim());
  const final = (messages.at(-1) || '').trim().replace(/\s*```\s*$/, '').trim();
  let explicit = null;
  for (let i = final.lastIndexOf('{'); i >= 0; i = final.lastIndexOf('{', i - 1)) {
    try {
      const candidate = JSON.parse(final.slice(i));
      if (['done', 'partial', 'blocked', 'failed'].includes(candidate.outcome)
        && typeof candidate.summary === 'string' && candidate.summary.trim()
        && ['changedFiles', 'verification', 'blockers', 'incomplete', 'nextSteps'].every(key => Array.isArray(candidate[key]))
        && ['changedFiles', 'blockers', 'incomplete', 'nextSteps'].every(key => candidate[key].every(item => typeof item === 'string'))
        && candidate.verification.every(item => item && typeof item.command === 'string' && item.command.trim()
          && ['passed', 'failed', 'skipped'].includes(item.status))) {
        explicit = candidate;
      }
      break;
    } catch {}
    if (i === 0) break;
  }
  const exitCode = Number(code);
  const status = exitCode === 0 ? 'completed' : 'failed';
  const result = explicit ? extractStructuredOutcome(JSON.stringify(explicit)) : {
    outcome: 'unknown', summary: 'No structured final task result was recorded.',
    changedFiles: [], verification: [], blockers: ['Missing structured final task result.'],
    incomplete: [], nextSteps: [], attentionRequired: true,
  };
  if (exitCode !== 0) {
    result.outcome = 'failed';
    result.attentionRequired = true;
    result.blockers.push(`Wrapper exited with code ${exitCode}.`);
  }
  const sessionId = recordedSession
    || body.match(/session\.id=([^\s]+)/)?.[1]
    || body.match(/^session id:\s*(.+)$/mi)?.[1]?.trim()
    || fallbackSession || 'new';
  const doneFile = logFile.replace(/\.log$/, '.done');
  const temp = `${doneFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ status, exitCode, provider, workspace, model,
    sessionId, logFile, systemdUnit, completedAt: new Date().toISOString(), result }, null, 2) + '\n');
  fs.renameSync(temp, doneFile);
  console.log(sessionId);
} catch (error) {
  console.error(`write-done: ${error.message}`);
  process.exitCode = 1;
}
