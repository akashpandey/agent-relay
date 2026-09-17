import fs from 'node:fs';
import { parseOutcomeJson, extractStructuredOutcome } from '../dashboard/parser.js';

const [logFile, provider, workspace, model, fallbackSession, code] = process.argv.slice(2);
try {
  const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  // Decode provider stream envelopes; never parse tool output or the echoed prompt.
  const body = text.split(/^---\s*$/m).slice(1).join('\n');
  const messages = [];
  for (const line of body.split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'result' && typeof event.result === 'string') messages.push(event.result);
      if (event.type === 'assistant') {
        for (const part of event.message?.content || []) {
          if (part.type === 'text') messages.push(part.text);
        }
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') messages.push(event.item.text);
    } catch {}
  }
  const explicit = parseOutcomeJson(messages.length ? messages.at(-1) : body);
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
  const sessionId = text.match(/"(?:session_id|conversation_id)"\s*:\s*"([^"]+)"/)?.[1]
    || text.match(/session\.id=([^\s]+)/)?.[1]
    || text.match(/^session id:\s*(.+)$/mi)?.[1]?.trim()
    || fallbackSession || 'new';
  const doneFile = logFile.replace(/\.log$/, '.done');
  const temp = `${doneFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ status, exitCode, provider, workspace, model,
    sessionId, logFile, completedAt: new Date().toISOString(), result }, null, 2) + '\n');
  fs.renameSync(temp, doneFile);
} catch (error) {
  console.error(`write-done: ${error.message}`);
  process.exitCode = 1;
}
