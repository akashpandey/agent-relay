import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const opencodeDbPaths = [
  process.env.OPENCODE_DB,
  '/opencode_data/opencode.db',
  path.join(process.env.HOME || '/home/akey', '.local/share/opencode/opencode.db'),
  '/home/akey/.local/share/opencode/opencode.db',
].filter(Boolean);

/**
 * Recovers full session details (tokens, cost, files, prompt, summary) from OpenCode SQLite database
 */
export function getOpenCodeSessionDetails(sessionId) {
  if (!sessionId) return null;
  const dbPath = opencodeDbPaths.find(p => fs.existsSync(p));
  if (!dbPath) return null;

  try {
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    const sessionCmd = `sqlite3 -json "file:${dbPath}?immutable=1" "SELECT id, title, summary_files, summary_additions, summary_deletions, summary_diffs, cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write FROM session WHERE id = '${safeSession}';\" 2>/dev/null`;
    const sessionOut = execSync(sessionCmd, { encoding: 'utf8', timeout: 1500 }).trim();
    
    let sessionRow = null;
    if (sessionOut) {
      const rows = JSON.parse(sessionOut);
      if (Array.isArray(rows) && rows.length > 0) sessionRow = rows[0];
    }

    // Query parts for prompt and final assistant response
    const partsCmd = `sqlite3 -json "file:${dbPath}?immutable=1" "SELECT data FROM part WHERE session_id = '${safeSession}' AND data LIKE '%\\"type\\":\\"text\\"%' ORDER BY time_created ASC;" 2>/dev/null`;
    const partsOut = execSync(partsCmd, { encoding: 'utf8', timeout: 2000 }).trim();

    let task = null;
    let markdownSummary = null;

    if (partsOut) {
      const partRows = JSON.parse(partsOut);
      if (Array.isArray(partRows) && partRows.length > 0) {
        // First part is user prompt
        try {
          const firstPart = JSON.parse(partRows[0].data);
          if (firstPart && firstPart.text) {
            let rawText = firstPart.text;
            if (typeof rawText === 'string') {
              if (rawText.startsWith('"') && rawText.endsWith('"')) {
                try { rawText = JSON.parse(rawText); } catch {}
              }
              const taskMatch = rawText.match(/Task:\s*([\s\S]*)/i);
              task = taskMatch ? taskMatch[1].trim() : rawText.trim();
            }
          }
        } catch {}

        // Last part is assistant final summary if more than 1 part
        if (partRows.length > 1) {
          try {
            const lastPart = JSON.parse(partRows[partRows.length - 1].data);
            if (lastPart && lastPart.text) {
              let summaryText = lastPart.text;
              if (typeof summaryText === 'string') {
                if (summaryText.startsWith('"') && summaryText.endsWith('"')) {
                  try { summaryText = JSON.parse(summaryText); } catch {}
                }
                markdownSummary = summaryText.trim();
              }
            }
          } catch {}
        }
      }
    }

    let tokens = null;
    let cost = 0;
    let diffs = null;

    if (sessionRow) {
      const totalTokens = (sessionRow.tokens_input || 0) + (sessionRow.tokens_output || 0) + (sessionRow.tokens_reasoning || 0);
      tokens = {
        total: totalTokens,
        input: sessionRow.tokens_input || 0,
        output: sessionRow.tokens_output || 0,
        reasoning: sessionRow.tokens_reasoning || 0,
        cacheRead: sessionRow.tokens_cache_read || 0,
        cacheWrite: sessionRow.tokens_cache_write || 0,
      };
      cost = sessionRow.cost || 0;
      diffs = sessionRow.summary_diffs || null;
    }

    return {
      task,
      markdownSummary,
      tokens,
      cost,
      diffs,
    };
  } catch (err) {}
  return null;
}

const geminiBrainDirs = [
  process.env.GEMINI_BRAIN,
  '/gemini_brain',
  path.join(process.env.HOME || '/home/akey', '.gemini/antigravity-cli/brain'),
  '/home/akey/.gemini/antigravity-cli/brain',
].filter(Boolean);

/**
 * Matches Antigravity session transcript by timestamp and workspace
 */
export function findAntigravityTranscript(startTimeIso, workspace) {
  if (!startTimeIso) return null;
  const brainDir = geminiBrainDirs.find(d => fs.existsSync(d));
  if (!brainDir) return null;

  try {
    const targetTime = new Date(startTimeIso).getTime();
    if (isNaN(targetTime)) return null;

    const entries = fs.readdirSync(brainDir);
    for (const entry of entries) {
      const transcriptPath = path.join(brainDir, entry, '.system_generated/logs/transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;

      try {
        const fd = fs.openSync(transcriptPath, 'r');
        const buf = Buffer.alloc(32768);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);

        const text = buf.toString('utf8', 0, bytesRead);
        if (workspace && !text.includes(workspace)) continue;

        const firstLine = text.split('\n')[0];
        const parsed = JSON.parse(firstLine);
        if (parsed && parsed.created_at) {
          const tTime = new Date(parsed.created_at).getTime();
          if (Math.abs(tTime - targetTime) <= 180000) {
            const wsMatch = text.match(/Workspace:\s*([^\r\n<\\"]+)/i) ||
                            text.match(/Repo:\s*([^\r\n<\s\)]+)/i);
            let agyWorkspace = wsMatch ? wsMatch[1].trim() : null;

            let model = null;
            const modelMatch = text.match(/setting \`Model Selection\` from [^\n]+ to (.*?)\.\s*No need to/i) ||
                               text.match(/setting \`Model Selection\` from [^\n]+ to ([^\n<]+)/i) ||
                               text.match(/model:\s*([^\n<]+)/i);
            if (modelMatch) {
              model = modelMatch[1].trim();
            }

            const taskMatch = text.match(/Task:\s*([\s\S]*?)(?=(?:\\n=== File|\n=== File|\\nRules:|\nRules:|<\/USER_REQUEST>|\\nWhen done|\nWhen done))/i);
            let task = taskMatch ? taskMatch[1].trim() : null;
            if (task) {
              task = task.replace(/\\n/g, '\n').replace(/^[\r\n]+/, '').trim();
            }

            // Extract touched files and last planner markdown response
            const touchedFiles = new Set();
            let markdownSummary = null;

            const lines = text.split('\n').filter(Boolean);
            for (const line of lines) {
              try {
                const step = JSON.parse(line);
                if (step.tool_calls) {
                  for (const tc of step.tool_calls) {
                    if (tc.arguments && tc.arguments.TargetFile) {
                      touchedFiles.add(tc.arguments.TargetFile);
                    }
                  }
                }
                if (step.type === 'PLANNER_RESPONSE' && step.content) {
                  markdownSummary = step.content;
                }
              } catch {}
            }

            return {
              conversationId: entry,
              workspace: agyWorkspace || null,
              model: model || null,
              task: task || null,
              markdownSummary: markdownSummary || null,
              filesModified: Array.from(touchedFiles),
            };
          }
        }
      } catch (err) {}
    }
  } catch (err) {}
  return null;
}

const claudeDataDirs = [
  process.env.CLAUDE_DATA,
  '/claude_data',
  path.join(process.env.HOME || '/home/akey', '.claude'),
  '/home/akey/.claude',
].filter(Boolean);

/**
 * Matches historical Claude Code runs by timestamp from history.jsonl
 */
export function findClaudeHistory(startTimeIso) {
  if (!startTimeIso) return null;
  const dataDir = claudeDataDirs.find(d => fs.existsSync(d));
  if (!dataDir) return null;

  const historyPath = path.join(dataDir, 'history.jsonl');
  if (!fs.existsSync(historyPath)) return null;

  try {
    const targetTime = new Date(startTimeIso).getTime();
    if (isNaN(targetTime)) return null;

    const content = fs.readFileSync(historyPath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.timestamp && Math.abs(entry.timestamp - targetTime) <= 180000) {
          return {
            sessionId: entry.sessionId || null,
            workspace: entry.project || null,
            task: entry.display || null,
          };
        }
      } catch {}
    }
  } catch {}
  return null;
}

const codexDataDirs = [
  process.env.CODEX_DATA,
  '/codex_data',
  path.join(os.homedir(), '.codex'),
  '/home/akey/.codex',
].filter(Boolean);

/**
 * Queries Codex state_5.sqlite for tokens, cost, prompt, and rollout summary
 */
export function getCodexSessionDetails(sessionId, startTimeIso, workspace) {
  const codexDir = codexDataDirs.find(d => fs.existsSync(d));
  if (!codexDir) return null;

  const dbPath = path.join(codexDir, 'state_5.sqlite');
  if (!fs.existsSync(dbPath)) return null;

  try {
    let row = null;
    if (sessionId) {
      const safeId = sessionId.replace(/'/g, "''");
      const cmd = `sqlite3 -json "file:${dbPath}?immutable=1" "SELECT id, model, tokens_used, cwd, first_user_message, rollout_path, created_at FROM threads WHERE id = '${safeId}' LIMIT 1;" 2>/dev/null`;
      const out = execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim();
      if (out) {
        const rows = JSON.parse(out);
        if (Array.isArray(rows) && rows.length > 0) row = rows[0];
      }
    }

    if (!row && startTimeIso) {
      const startSec = Math.floor(new Date(startTimeIso).getTime() / 1000);
      if (!isNaN(startSec)) {
        const minSec = startSec - 180;
        const maxSec = startSec + 180;
        const cmd = `sqlite3 -json "file:${dbPath}?immutable=1" "SELECT id, model, tokens_used, cwd, first_user_message, rollout_path, created_at FROM threads WHERE created_at BETWEEN ${minSec} AND ${maxSec} ORDER BY ABS(created_at - ${startSec}) ASC LIMIT 1;" 2>/dev/null`;
        const out = execSync(cmd, { encoding: 'utf8', timeout: 2000 }).trim();
        if (out) {
          const rows = JSON.parse(out);
          if (Array.isArray(rows) && rows.length > 0) row = rows[0];
        }
      }
    }

    if (!row) return null;

    let task = null;
    if (row.first_user_message) {
      const taskMatch = row.first_user_message.match(/Task:\s*([\s\S]*)/i);
      task = taskMatch ? taskMatch[1].trim() : row.first_user_message.trim();
    }

    const totalTokens = row.tokens_used || 0;
    const tokens = {
      total: totalTokens,
      input: Math.round(totalTokens * 0.8),
      output: Math.round(totalTokens * 0.2),
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };

    // Calculate estimated cost for OpenAI models ($5/M in, $15/M out)
    const cost = Number(((tokens.input * 0.000005) + (tokens.output * 0.000015)).toFixed(4));

    let markdownSummary = null;
    let rolloutPath = row.rollout_path;
    if (rolloutPath) {
      if (!fs.existsSync(rolloutPath) && rolloutPath.includes('.codex')) {
        const relativePart = rolloutPath.split('.codex')[1];
        const containerPath = path.join(codexDir, relativePart);
        if (fs.existsSync(containerPath)) rolloutPath = containerPath;
      }

      if (fs.existsSync(rolloutPath)) {
        try {
          const tailBuf = execSync(`tail -n 40 "${rolloutPath}"`, { encoding: 'utf8', timeout: 2000 });
          const lines = tailBuf.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const item = JSON.parse(lines[i]);
              if (item?.payload?.role === 'assistant' && Array.isArray(item.payload.content)) {
                const textObj = item.payload.content.find(c => c.type === 'output_text');
                if (textObj && textObj.text) {
                  markdownSummary = textObj.text.trim();
                  break;
                }
              }
            } catch {}
          }
        } catch {}
      }
    }

    return {
      model: row.model,
      workspace: row.cwd,
      task,
      tokens,
      cost,
      markdownSummary,
    };
  } catch (err) {}
  return null;
}

/**
 * Parses the filename format: YYYYMMDDTHHMMSS-provider-pid.log
 * All subagent wrappers generate timestamp using local system time (IST, +05:30).
 */
export function parseLogFilename(filename) {
  const match = filename.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-([a-zA-Z0-9_-]+)-(\d+)\.log$/);
  if (!match) {
    const fallbackMatch = filename.match(/^(\d{8}T\d{6})-([a-zA-Z0-9_-]+)-(\d+)\.log$/);
    if (fallbackMatch) {
      return {
        timestampRaw: fallbackMatch[1],
        startTime: new Date().toISOString(),
        provider: fallbackMatch[2],
        pid: parseInt(fallbackMatch[3], 10),
      };
    }
    return null;
  }

  const [_, year, month, day, hour, minute, second, provider, pid] = match;
  const istIsoStr = `${year}-${month}-${day}T${hour}:${minute}:${second}+05:30`;
  const dateObj = new Date(istIsoStr);

  return {
    timestampRaw: `${year}${month}${day}T${hour}${minute}${second}`,
    startTime: !isNaN(dateObj.getTime()) ? dateObj.toISOString() : `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
    startTimeLocalIST: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
    provider: provider.toLowerCase(),
    pid: parseInt(pid, 10),
  };
}

/**
 * Checks if the process is alive on the host or in mounted /proc
 */
export function isProcessRunning(pid, procDir = '/proc') {
  if (!pid || isNaN(pid)) return { isAlive: false, cmd: null };

  const pidStr = String(pid);
  const pidDir = path.join(procDir, pidStr);

  try {
    if (fs.existsSync(pidDir)) {
      const statFile = path.join(pidDir, 'stat');
      if (fs.existsSync(statFile)) {
        const stat = fs.readFileSync(statFile, 'utf8');
        const parts = stat.split(' ');
        const state = parts[2];
        if (state !== 'Z') {
          let cmd = null;
          try {
            const cmdline = fs.readFileSync(path.join(pidDir, 'cmdline'), 'utf8');
            cmd = cmdline.replace(/\0/g, ' ').trim();
          } catch {}
          return { isAlive: true, cmd };
        }
      }
    }
  } catch {}

  try {
    process.kill(pid, 0);
    return { isAlive: true, cmd: null };
  } catch (e) {
    if (e.code === 'EPERM') return { isAlive: true, cmd: null };
  }

  return { isAlive: false, cmd: null };
}

/**
 * Extract touched files and git diffs from raw log content
 */
function extractFilesAndDiffs(rawContent) {
  const files = new Set();
  const diffHunks = [];

  // Match file touched/edited lines
  const fileRegexes = [
    /(?:file=|touching file\s+file=|Writing\s+|Editing\s+|diff --git a\/|=== File \d+:\s*)([^\s\r\n",]+)/gi,
    /(?:Replacing content in |Created file |Updated |Modified )([^\s\r\n",]+\.[a-zA-Z0-9]+)/gi
  ];

  for (const regex of fileRegexes) {
    const matches = rawContent.matchAll(regex);
    for (const m of matches) {
      let p = m[1].trim();
      if (p.startsWith('b/')) p = p.slice(2);
      if (p.includes('/') || /\.(ts|tsx|js|jsx|json|md|py|sh|css|html|sql|yaml|yml)$/.test(p)) {
        if (!p.startsWith('/host_proc') && !p.startsWith('/proc') && !p.startsWith('node_modules') && !p.startsWith('.git/')) {
          files.add(p);
        }
      }
    }
  }

  // Look for diff blocks
  const diffStart = rawContent.indexOf('diff --git');
  if (diffStart !== -1) {
    diffHunks.push(rawContent.slice(diffStart, diffStart + 20000));
  } else {
    const diffBlockStart = rawContent.indexOf('[diff_block_start]');
    if (diffBlockStart !== -1) {
      const diffBlockEnd = rawContent.indexOf('[diff_block_end]', diffBlockStart);
      if (diffBlockEnd !== -1) {
        diffHunks.push(rawContent.slice(diffBlockStart, diffBlockEnd + 16));
      }
    }
  }

  return {
    filesModified: Array.from(files),
    diffs: diffHunks.join('\n\n') || null
  };
}

/**
 * Parse metadata from a single log file
 */
export function parseLogMetadata(filename, logFilePath, procDir = '/proc') {
  const parsedName = parseLogFilename(filename);
  if (!parsedName) return null;

  let stats;
  try {
    stats = fs.statSync(logFilePath);
  } catch (err) {
    return null;
  }

  const { isAlive, cmd: processCmd } = isProcessRunning(parsedName.pid, procDir);
  const fileSize = stats.size;

  let headContent = '';
  let tailContent = '';

  try {
    const fd = fs.openSync(logFilePath, 'r');
    const readSize = Math.min(fileSize, 24576);

    const headBuf = Buffer.alloc(readSize);
    fs.readSync(fd, headBuf, 0, readSize, 0);
    headContent = headBuf.toString('utf8');

    if (fileSize > 24576) {
      const tailBuf = Buffer.alloc(readSize);
      fs.readSync(fd, tailBuf, 0, readSize, fileSize - readSize);
      tailContent = tailBuf.toString('utf8');
    } else {
      tailContent = headContent;
    }
    fs.closeSync(fd);
  } catch (err) {
    headContent = '';
    tailContent = '';
  }

  const combinedSample = headContent + '\n---SPLIT---\n' + tailContent;

  // Extract Workspace
  let workspace = null;
  const wsMatch = combinedSample.match(/Workspace:\s*([^\r\n]+)/i) ||
                  combinedSample.match(/workspace=([^\s]+)/i) ||
                  combinedSample.match(/workdir:\s*([^\r\n]+)/i) ||
                  combinedSample.match(/directory=([^\s]+)/i) ||
                  combinedSample.match(/cwd=([^\s]+)/i);
  if (wsMatch) {
    let clean = wsMatch[1].trim();
    if (clean.includes(' ')) {
      const token = clean.split(/\s+/)[0];
      if (token.startsWith('/') || token.startsWith('~')) {
        clean = token;
      }
    }
    workspace = clean;
  }

  // Extract Model
  let model = null;
  const modelMatch = combinedSample.match(/modelID=([^\s]+)/i) ||
                     combinedSample.match(/llm\.model=([^\s]+)/i) ||
                     combinedSample.match(/> build · ([^\r\n]+)/i) ||
                     combinedSample.match(/model:\s*([^\r\n]+)/i) ||
                     combinedSample.match(/model=([^\s,]+)/i) ||
                     combinedSample.match(/AGY_MODEL='([^']+)'/i) ||
                     combinedSample.match(/OPENCODE_MODEL='([^']+)'/i) ||
                     combinedSample.match(/CODEX_MODEL='([^']+)'/i) ||
                     combinedSample.match(/CLAUDE_MODEL='([^']+)'/i);
  if (modelMatch) {
    const rawModel = modelMatch[1].trim();
    if (rawModel && rawModel !== 'default' && rawModel !== 'undefined' && rawModel !== 'null') {
      model = rawModel;
    }
  }

  // Extract Session ID
  let session = null;
  const sessionMatch = combinedSample.match(/session=([^\s,]+)/i) ||
                        combinedSample.match(/session id:\s*([^\r\n]+)/i) ||
                        combinedSample.match(/session\.id=([^\s]+)/i) ||
                        combinedSample.match(/created id=([^\s]+)/i) ||
                        combinedSample.match(/thread_id=([^\s,]+)/i);
  if (sessionMatch) {
    session = sessionMatch[1].trim();
    if (session === 'new') session = null;
  }

  // Extract Task / Prompt
  let task = null;
  const taskMatch = headContent.match(/Task:\s*([\s\S]*?)(?=\n(?:hook:|\ntimestamp=|\nuser\n|\ncodex|\nLet me|\nI'll|\n\*\*Step|\nRules:|---|---\n|$))/i);
  if (taskMatch) {
    task = taskMatch[1].trim();
  } else {
    const altTask = headContent.match(/Task:\s*([^\r\n]+)/i);
    if (altTask) task = altTask[1].trim();
  }

  let tokens = null;
  let cost = 0;
  let markdownSummary = null;
  let diffs = null;
  let filesModified = [];

  // Check explicit standardized wrapper subagent: header
  const headerMatch = headContent.match(/subagent:\s*provider=([^\s]+)\s+workspace=([^\s]+)\s+model=([^\s]+)\s+session=([^\s]+)/i);
  if (headerMatch) {
    if (!workspace || workspace === 'Unknown') workspace = headerMatch[2].trim();
    if (!model && headerMatch[3] !== 'default') model = headerMatch[3].trim();
    if (!session && headerMatch[4] !== 'new') session = headerMatch[4].trim();
  }

  // If Antigravity provider, resolve transcript for workspace, model, prompt, and summary
  if (parsedName.provider === 'antigravity') {
    const agyMatch = findAntigravityTranscript(parsedName.startTime, workspace);
    if (agyMatch) {
      if (!workspace || workspace === 'Unknown') workspace = agyMatch.workspace;
      if (!model && agyMatch.model) model = agyMatch.model;
      if (!task && agyMatch.task) task = agyMatch.task;
      if (!session && agyMatch.conversationId) session = agyMatch.conversationId;
      if (agyMatch.markdownSummary) markdownSummary = agyMatch.markdownSummary;
      if (agyMatch.filesModified && agyMatch.filesModified.length > 0) filesModified = agyMatch.filesModified;
    }
  }

  // If Claude provider, check historical Claude history
  if (parsedName.provider === 'claude') {
    const claudeMatch = findClaudeHistory(parsedName.startTime);
    if (claudeMatch) {
      if (!workspace || workspace === 'Unknown') workspace = claudeMatch.workspace;
      if (!task) task = claudeMatch.task;
      if (!session) session = claudeMatch.sessionId;
    }
  }

  // If OpenCode provider, query SQLite for tokens, cost, diffs, prompt, and summary
  if (parsedName.provider === 'opencode' && session) {
    const opencodeDetails = getOpenCodeSessionDetails(session);
    if (opencodeDetails) {
      if (!task && opencodeDetails.task) task = opencodeDetails.task;
      if (opencodeDetails.tokens) tokens = opencodeDetails.tokens;
      if (opencodeDetails.cost) cost = opencodeDetails.cost;
      if (opencodeDetails.markdownSummary) markdownSummary = opencodeDetails.markdownSummary;
      if (opencodeDetails.diffs) diffs = opencodeDetails.diffs;
    }
  }

  // If Codex provider, query state_5.sqlite for tokens, cost, prompt, and summary
  if (parsedName.provider === 'codex') {
    const codexDetails = getCodexSessionDetails(session, parsedName.startTime, workspace);
    if (codexDetails) {
      if (!workspace || workspace === 'Unknown') workspace = codexDetails.workspace;
      if (!model && codexDetails.model) model = codexDetails.model;
      if (!task && codexDetails.task) task = codexDetails.task;
      if (codexDetails.tokens) tokens = codexDetails.tokens;
      if (codexDetails.cost) cost = codexDetails.cost;
      if (codexDetails.markdownSummary) markdownSummary = codexDetails.markdownSummary;
    }
  }

  // Fallback file & diff extraction from log text
  const extracted = extractFilesAndDiffs(combinedSample);
  if (filesModified.length === 0 && extracted.filesModified.length > 0) {
    filesModified = extracted.filesModified;
  }
  if (!diffs && extracted.diffs) {
    diffs = extracted.diffs;
  }

  // Fallback for historical logs without explicit Task: header
  if (!task) {
    const cleanSample = combinedSample.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (parsedName.provider === 'antigravity') {
      const firstLines = cleanSample.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('antigravity-subagent:'));
      if (firstLines.length > 0) {
        task = firstLines.slice(0, 2).join(' ');
      }
    } else if (parsedName.provider === 'opencode') {
      const commitMatch = cleanSample.match(/commit\s+[a-f0-9]+\s*\nAuthor:[^\n]+\nDate:[^\n]+\n\s+([^\r\n]+)/i);
      if (commitMatch) {
        task = commitMatch[1].trim();
      }
    } else if (parsedName.provider === 'claude') {
      const firstLine = cleanSample.split('\n').find(l => l && !l.startsWith('claude-subagent:'));
      if (firstLine) task = firstLine;
    }
  }

  // Fallback markdown summary from assistant response in log if available
  if (!markdownSummary) {
    const cleanSample = tailContent.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
    const dividerIdx = cleanSample.lastIndexOf('\n---\n');
    if (dividerIdx !== -1 && dividerIdx < cleanSample.length - 10) {
      markdownSummary = cleanSample.slice(dividerIdx + 5).trim();
    } else if (cleanSample.includes('## Diff Summary') || cleanSample.includes('Files touched:') || cleanSample.includes('### Summary')) {
      const summaryStart = cleanSample.search(/(?:## Diff Summary|### Summary|Both files look correct|Files touched:)/i);
      if (summaryStart !== -1) {
        markdownSummary = cleanSample.slice(summaryStart).trim();
      }
    }
  }

  // Extract Current Activity / Last Action
  let currentAction = 'Initializing...';
  const lines = tailContent.split('\n').map(l => l.trim()).filter(Boolean);
  
  if (lines.length > 0) {
    for (let i = lines.length - 1; i >= 0; i--) {
      let line = lines[i];
      // Strip ANSI escape codes
      line = line.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
      if (!line) continue;

      if (line.includes('→ Read') || line.includes('✱ Grep') || line.startsWith('$ ') || line.includes('Edit ') || line.includes('Write ')) {
        currentAction = line.slice(0, 120);
        break;
      }
      if (line.includes('message=stream')) {
        currentAction = 'Streaming LLM response...';
        break;
      }
      if (line.includes('message=tracking')) {
        currentAction = 'Snapshotting workspace state...';
        break;
      }
      if (line.includes('message="shell tool using shell"') || line.includes('message=exec')) {
        currentAction = 'Executing shell command...';
        break;
      }
      if (line.includes('message=tool') || line.includes('tool:')) {
        currentAction = line.slice(0, 120);
        break;
      }
      if (line.startsWith('/bin/bash') || line.startsWith('exec') || line.startsWith('>')) {
        currentAction = line.slice(0, 120);
        break;
      }
      if (line.startsWith('**Step') || line.startsWith('Step ') || line.startsWith('Let me') || line.startsWith('Diff Summary')) {
        currentAction = line.slice(0, 120);
        break;
      }
      if (line.includes('session limit') || line.includes('error') || line.includes('Error')) {
        currentAction = line.slice(0, 120);
        break;
      }
    }
  }

  // Determine Overall Status
  let status = 'completed';
  if (isAlive) {
    status = 'running';
  } else if (fileSize === 0) {
    status = 'empty';
  } else if (tailContent.includes('session limit') || tailContent.includes('failed to') || tailContent.includes('Error:') || tailContent.includes('FATAL')) {
    status = 'failed';
  } else {
    status = 'completed';
  }

  // Accurate Duration Calculation (IST epoch vs mtime epoch)
  const startTimeMs = new Date(parsedName.startTime).getTime();
  const endTimeMs = isAlive ? Date.now() : stats.mtimeMs;
  let durationSec = 0;

  if (!isNaN(startTimeMs) && !isNaN(endTimeMs)) {
    const diff = Math.round((endTimeMs - startTimeMs) / 1000);
    if (diff >= 0 && diff < 86400 * 7) {
      durationSec = diff;
    } else if (fileSize > 0) {
      const altDiff = Math.round((stats.mtimeMs - stats.birthtimeMs) / 1000);
      if (altDiff > 0 && altDiff < 86400) durationSec = altDiff;
    }
  }

  // Reproducible CLI command
  const cleanPrompt = (task || '').replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 250);
  let cliCommand = '';
  if (parsedName.provider === 'opencode') {
    cliCommand = `OPENCODE_MODEL='${model || 'glm-5.2'}' opencode-subagent "${cleanPrompt}"`;
  } else if (parsedName.provider === 'antigravity') {
    cliCommand = `AGY_MODEL='${model || 'default'}' antigravity-subagent "${cleanPrompt}"`;
  } else if (parsedName.provider === 'claude') {
    cliCommand = `CLAUDE_MODEL='${model || 'sonnet'}' claude-subagent "${cleanPrompt}"`;
  } else if (parsedName.provider === 'codex') {
    cliCommand = `CODEX_MODEL='${model || 'gpt-5.5'}' codex-subagent "${cleanPrompt}"`;
  }

  return {
    id: filename,
    filename,
    provider: parsedName.provider,
    pid: parsedName.pid,
    isAlive,
    processCmd,
    status,
    workspace: workspace || 'Unknown',
    workspaceName: workspace ? path.basename(workspace) : 'workspace',
    model: model || 'Default Model',
    session,
    task: task ? (task.length > 300 ? task.slice(0, 300) + '...' : task) : 'No task prompt specified',
    fullTask: task || '',
    markdownSummary: markdownSummary || null,
    filesModified: filesModified || [],
    diffs: diffs || null,
    tokens: tokens || null,
    cost: cost || 0,
    cliCommand,
    currentAction,
    fileSize,
    fileSizeHuman: formatBytes(fileSize),
    startTime: parsedName.startTime,
    startTimeIST: parsedName.startTimeLocalIST,
    lastModified: stats.mtime.toISOString(),
    durationSec,
    durationHuman: formatDuration(durationSec),
  };
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  if (seconds <= 0) return '< 1s';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(seconds / 3600);
  const remM = Math.floor((seconds % 3600) / 60);
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}
