import fs from 'node:fs';
import path from 'node:path';

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
  // Local IST ISO string (+05:30)
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
  if (!pid || isNaN(pid)) return false;
  try {
    const pidPath = path.join(procDir, String(pid));
    if (!fs.existsSync(pidPath)) return false;
    
    // Check if we can read stat or status
    const statPath = path.join(pidPath, 'stat');
    if (fs.existsSync(statPath)) {
      const statContent = fs.readFileSync(statPath, 'utf8');
      // A zombie process (Z) is essentially dead
      if (statContent.includes(') Z ') || statContent.includes(') X ')) return false;
      return true;
    }
    return true;
  } catch {
    // If proc is not mounted or permission denied, fallback to kill -0 if on host
    try {
      if (procDir === '/proc') {
        process.kill(pid, 0);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}

/**
 * Get process command line or status if alive
 */
export function getProcessInfo(pid, procDir = '/proc') {
  if (!isProcessRunning(pid, procDir)) return null;
  try {
    const cmdlinePath = path.join(procDir, String(pid), 'cmdline');
    if (fs.existsSync(cmdlinePath)) {
      const raw = fs.readFileSync(cmdlinePath, 'utf8');
      return raw.replace(/\0/g, ' ').trim();
    }
  } catch {}
  return 'running';
}

/**
 * Parses full or partial log file content for rich metadata
 */
export function parseLogMetadata(filename, filepath, procDir = '/proc') {
  const parsedName = parseLogFilename(filename);
  if (!parsedName) return null;

  let stats;
  try {
    stats = fs.statSync(filepath);
  } catch {
    return null;
  }

  const isAlive = isProcessRunning(parsedName.pid, procDir);
  const processCmd = isAlive ? getProcessInfo(parsedName.pid, procDir) : null;
  
  // Read first 24KB for headers/prompt and last 24KB for status/last action
  const fileSize = stats.size;
  let headContent = '';
  let tailContent = '';

  try {
    const fd = fs.openSync(filepath, 'r');
    const headBuf = Buffer.alloc(Math.min(fileSize, 24576));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    headContent = headBuf.toString('utf8');

    if (fileSize > 24576) {
      const tailLength = Math.min(fileSize, 24576);
      const tailBuf = Buffer.alloc(tailLength);
      fs.readSync(fd, tailBuf, 0, tailLength, fileSize - tailLength);
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
    workspace = wsMatch[1].trim();
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

  // Fallback for historical logs without explicit Task: header
  if (!task) {
    const cleanSample = combinedSample.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').trim();
    if (parsedName.provider === 'antigravity') {
      const firstLines = cleanSample.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('antigravity-subagent:'));
      if (firstLines.length > 0) {
        task = firstLines.slice(0, 2).join(' ');
      }
    } else if (parsedName.provider === 'opencode') {
      const toolMatch = cleanSample.match(/(?:→\s*Read|✱\s*Grep|\$\s*|message="touching file" file=)([^\r\n]+)/i) ||
                        cleanSample.match(/commit\s+[a-f0-9]+\s*\nAuthor:[^\n]+\nDate:[^\n]+\n\s+([^\r\n]+)/i);
      if (toolMatch) {
        task = toolMatch[0].trim();
      } else {
        const titleMatch = cleanSample.match(/title="([^"]+)"/i);
        if (titleMatch && !titleMatch[1].startsWith('New session')) {
          task = titleMatch[1];
        }
      }
    } else if (parsedName.provider === 'claude') {
      const firstLine = cleanSample.split('\n').find(l => l && !l.startsWith('claude-subagent:'));
      if (firstLine) task = firstLine;
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
      // Fallback: estimate from birthtime vs mtime if available
      const altDiff = Math.round((stats.mtimeMs - stats.birthtimeMs) / 1000);
      if (altDiff > 0 && altDiff < 86400) durationSec = altDiff;
    }
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
