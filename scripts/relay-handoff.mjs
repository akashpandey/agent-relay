#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { canonicalWorkspacePath } from '../dashboard/workspaces.js';

const homedir = os.homedir();

// Provider session data directory paths (supports docker/env overrides)
const CODEX_DB_PATH = process.env.CODEX_DATA
  ? path.join(process.env.CODEX_DATA, 'state_5.sqlite')
  : path.join(homedir, '.codex', 'state_5.sqlite');

const OPENCODE_DB_PATH = process.env.OPENCODE_DB ||
  path.join(homedir, '.local', 'share', 'opencode', 'opencode.db');

const CLAUDE_DATA_DIR = process.env.CLAUDE_DATA || path.join(homedir, '.claude');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DATA_DIR, 'projects');

const GEMINI_BRAIN_DIR = process.env.GEMINI_BRAIN ||
  path.join(homedir, '.gemini', 'antigravity-cli', 'brain');

/**
 * Normalizes and checks if a path matches a workspace
 */
function isWorkspaceMatch(sessionPath, workspace) {
  if (!sessionPath || !workspace) return false;
  const normSession = canonicalWorkspacePath(sessionPath) || sessionPath.replace(/\/+$/, '');
  const normWorkspace = canonicalWorkspacePath(workspace) || workspace.replace(/\/+$/, '');
  return normSession.toLowerCase() === normWorkspace.toLowerCase();
}

/**
 * Finds the latest Codex session for a workspace
 */
export function getLatestCodexSession(workspace) {
  if (!fs.existsSync(CODEX_DB_PATH)) return null;
  try {
    const db = new DatabaseSync(CODEX_DB_PATH, { readOnly: true });
    const rows = db.prepare(`
      SELECT id, cwd, model, tokens_used, first_user_message, rollout_path, created_at
      FROM threads
      ORDER BY created_at DESC
      LIMIT 100
    `).all();

    for (const row of rows) {
      if (isWorkspaceMatch(row.cwd, workspace)) {
        let lastAssistantMessage = null;
        let touchedFiles = [];
        let rolloutFile = row.rollout_path;

        if (rolloutFile && fs.existsSync(rolloutFile)) {
          try {
            const content = fs.readFileSync(rolloutFile, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const parsed = JSON.parse(lines[i]);
                if (!lastAssistantMessage && (parsed.type === 'assistant' || parsed.role === 'assistant')) {
                  lastAssistantMessage = parsed.content || parsed.message || null;
                }
                if (parsed.tool || parsed.command || parsed.file) {
                  const f = parsed.file || parsed.path;
                  if (f && !touchedFiles.includes(f)) touchedFiles.push(f);
                }
              } catch {}
            }
          } catch {}
        }

        return {
          provider: 'codex',
          sessionId: row.id,
          model: row.model,
          updatedAt: row.created_at ? new Date(row.created_at * 1000) : new Date(),
          goal: row.first_user_message || 'Codex task execution',
          lastAssistantMessage,
          touchedFiles,
        };
      }
    }
  } catch {}
  return null;
}

/**
 * Finds the latest OpenCode session for a workspace
 */
export function getLatestOpenCodeSession(workspace) {
  if (!fs.existsSync(OPENCODE_DB_PATH)) return null;
  try {
    const db = new DatabaseSync(OPENCODE_DB_PATH, { readOnly: true });
    const rows = db.prepare(`
      SELECT id, directory, title, model, time_updated
      FROM session
      ORDER BY time_updated DESC
      LIMIT 100
    `).all();

    for (const row of rows) {
      if (isWorkspaceMatch(row.directory, workspace)) {
        let goal = row.title;
        let lastAssistantMessage = null;
        const touchedFiles = [];

        try {
          const parts = db.prepare(`
            SELECT data FROM part WHERE session_id = ? ORDER BY time_created ASC
          `).all(row.id);

          for (const p of parts) {
            try {
              const d = JSON.parse(p.data);
              if (d.type === 'text' && d.text) {
                if (!goal || goal === row.title) {
                  goal = d.text;
                }
                lastAssistantMessage = d.text;
              }
              if (d.type === 'tool' && d.state?.input?.path) {
                if (!touchedFiles.includes(d.state.input.path)) {
                  touchedFiles.push(d.state.input.path);
                }
              }
            } catch {}
          }
        } catch {}

        return {
          provider: 'opencode',
          sessionId: row.id,
          model: row.model,
          updatedAt: row.time_updated ? new Date(row.time_updated) : new Date(),
          goal: goal || row.title || 'OpenCode task execution',
          lastAssistantMessage,
          touchedFiles,
        };
      }
    }
  } catch {}
  return null;
}

/**
 * Finds the latest Claude Code session for a workspace
 */
export function getLatestClaudeSession(workspace) {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  const slug = workspace.replace(/\//g, '-');
  const projectDirs = [
    path.join(CLAUDE_PROJECTS_DIR, slug),
    ...fs.readdirSync(CLAUDE_PROJECTS_DIR).map(d => path.join(CLAUDE_PROJECTS_DIR, d)),
  ].filter((d, idx, arr) => arr.indexOf(d) === idx && fs.existsSync(d));

  let candidateFiles = [];
  for (const dir of projectDirs) {
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({
          path: path.join(dir, f),
          mtime: fs.statSync(path.join(dir, f)).mtime,
        }));
      candidateFiles.push(...files);
    } catch {}
  }

  candidateFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  for (const fileObj of candidateFiles) {
    try {
      const content = fs.readFileSync(fileObj.path, 'utf8');
      if (!content.includes(workspace) && !fileObj.path.includes(slug)) continue;

      const lines = content.split('\n').filter(Boolean);
      let goal = null;
      let lastAssistantMessage = null;
      let sessionId = path.basename(fileObj.path, '.jsonl');
      const touchedFiles = [];

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'user' && !goal) {
            const text = typeof parsed.message?.content === 'string'
              ? parsed.message.content
              : (parsed.text || '');
            if (!text.includes('Caveat:')) {
              goal = text;
            }
          }
          if (parsed.type === 'assistant') {
            const c = parsed.message?.content;
            if (Array.isArray(c)) {
              const textParts = c.filter(b => b.type === 'text').map(b => b.text).join('\n');
              if (textParts) lastAssistantMessage = textParts;
              for (const b of c) {
                if (b.type === 'tool_use' && (b.input?.file_path || b.input?.path)) {
                  const p = b.input.file_path || b.input.path;
                  if (!touchedFiles.includes(p)) touchedFiles.push(p);
                }
              }
            } else if (typeof c === 'string') {
              lastAssistantMessage = c;
            }
          }
        } catch {}
      }

      return {
        provider: 'claude',
        sessionId,
        updatedAt: fileObj.mtime,
        goal: goal || 'Claude Code task execution',
        lastAssistantMessage,
        touchedFiles,
      };
    } catch {}
  }
  return null;
}

/**
 * Finds the latest Antigravity CLI session for a workspace
 */
export function getLatestAntigravitySession(workspace) {
  if (!fs.existsSync(GEMINI_BRAIN_DIR)) return null;
  try {
    const entries = fs.readdirSync(GEMINI_BRAIN_DIR)
      .map(e => ({
        id: e,
        dir: path.join(GEMINI_BRAIN_DIR, e),
        mtime: fs.statSync(path.join(GEMINI_BRAIN_DIR, e)).mtime,
      }))
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    for (const item of entries.slice(0, 30)) {
      const transcript = path.join(item.dir, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcript)) continue;

      try {
        const text = fs.readFileSync(transcript, 'utf8');
        if (!text.includes(workspace)) continue;

        const lines = text.split('\n').filter(Boolean);
        let goal = null;
        let lastAssistantMessage = null;
        const touchedFiles = [];

        for (const line of lines) {
          try {
            const step = JSON.parse(line);
            if (step.type === 'USER_INPUT' && !goal) {
              goal = step.content;
            }
            if (step.type === 'PLANNER_RESPONSE' && step.content) {
              lastAssistantMessage = step.content;
            }
            if (step.tool_calls && Array.isArray(step.tool_calls)) {
              for (const call of step.tool_calls) {
                const target = call.args?.TargetFile || call.args?.path || call.args?.file;
                if (target && !touchedFiles.includes(target)) {
                  touchedFiles.push(target);
                }
              }
            }
          } catch {}
        }

        return {
          provider: 'antigravity',
          sessionId: item.id,
          updatedAt: item.mtime,
          goal: goal || 'Antigravity task execution',
          lastAssistantMessage,
          touchedFiles,
        };
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Compares sessions across all 4 providers and finds the most recent one for the workspace
 */
export function findLatestWorkspaceSession(workspace) {
  const sessions = [
    getLatestClaudeSession(workspace),
    getLatestCodexSession(workspace),
    getLatestOpenCodeSession(workspace),
    getLatestAntigravitySession(workspace),
  ].filter(Boolean);

  if (sessions.length === 0) return null;
  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return sessions[0];
}

/**
 * Gets uncommitted git state from the workspace directory
 */
export function getWorkspaceGitContext(workspace) {
  try {
    const status = execSync('git status --porcelain', {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 3000,
    }).trim();

    const diffStat = execSync('git diff --stat', {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 3000,
    }).trim();

    let diffSample = '';
    try {
      diffSample = execSync('git diff -U2 | head -n 80', {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
    } catch {}

    return { status, diffStat, diffSample };
  } catch {
    return { status: '', diffStat: '', diffSample: '' };
  }
}

/**
 * Detects if the last message indicated a rate limit, quota exhaustion, or error
 */
export function detectExhaustionReason(lastAssistantMessage) {
  if (!lastAssistantMessage) return 'Session interrupted';
  const text = String(lastAssistantMessage).toLowerCase();

  if (text.includes('weekly limit') || text.includes('rate limit') || text.includes('quota') || text.includes('exhausted') || text.includes('resets')) {
    return 'Token / Quota Limit reached';
  }
  if (text.includes('context length') || text.includes('context window') || text.includes('maximum context')) {
    return 'Context Window Exceeded';
  }
  if (text.includes('timed out') || text.includes('timeout')) {
    return 'Execution Timeout';
  }
  return 'Previous agent stopped / interrupted';
}

/**
 * Synthesizes the Relay Baton prompt for the receiving subagent
 */
export function buildRelayTakeoverPrompt({
  sourceProvider,
  goal,
  lastAssistantMessage,
  touchedFiles = [],
  workspace,
  userInstruction = '',
}) {
  const git = getWorkspaceGitContext(workspace);
  const reason = detectExhaustionReason(lastAssistantMessage);

  let prompt = `You are taking over an in-progress coding task handed off from ${sourceProvider.toUpperCase()}.
Reason for handoff: ${reason}.

## Original Goal
${goal.trim()}

## Progress & Context Left by ${sourceProvider.toUpperCase()}
`;

  if (touchedFiles.length > 0) {
    prompt += `Touched files:\n${touchedFiles.map(f => `- ${f}`).join('\n')}\n\n`;
  }

  if (lastAssistantMessage) {
    const cleanLast = String(lastAssistantMessage).trim().slice(-1000);
    prompt += `Last activity/message before interruption:\n"""\n${cleanLast}\n"""\n\n`;
  }

  if (git.status) {
    prompt += `## Current Uncommitted Git Status in Workspace\n\`\`\`text\n${git.status}\n\`\`\`\n\n`;
  }

  if (git.diffStat) {
    prompt += `## Diff Summary\n\`\`\`text\n${git.diffStat}\n\`\`\`\n\n`;
  }

  if (userInstruction && userInstruction.trim()) {
    prompt += `## Additional User Instructions for this Takeover\n${userInstruction.trim()}\n\n`;
  }

  prompt += `## Your Mission
Continue directly from this workspace state. Inspect the current modified files, complete any unfinished implementations or fixes to fulfill the original goal, verify your changes with appropriate test commands, and provide a concise summary when done.`;

  return { prompt, reason, sourceProvider };
}
