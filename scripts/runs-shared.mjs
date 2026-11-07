// Workspace helpers shared by agent-cli.mjs and mcp-server.mjs.
import path from 'node:path';
import fs from 'node:fs';
import { getWorkspacesFromDb } from '../dashboard/db.js';
import { resolveWorkspacePath, configuredWorkspaceEntries } from '../dashboard/workspaces.js';

export function knownWorkspaces() {
  const byPath = new Map();
  for (const ws of getWorkspacesFromDb()) byPath.set(ws.path, ws);
  for (const ws of configuredWorkspaceEntries()) {
    const actual = path.resolve(ws.path);
    byPath.set(actual, { totalRuns: 0, activeRuns: 0, ...byPath.get(actual), path: actual, name: ws.name });
  }
  return [...byPath.values()];
}

export function resolveWorkspace(value) {
  return resolveWorkspacePath(value, knownWorkspaces());
}

// Resolve a log filename from a wrapper's run_log=<file> stderr marker.
// Only accepts provider-specific names that exist in logsDir.
export function runLogFromText(text, provider, pid, logsDir) {
  const match = /run_log=(\S+\.log)/.exec(text || '');
  if (!match) return null;
  const base = path.basename(match[1]);
  if (!base.endsWith(`-${provider}-${pid}.log`)) return null;
  return fs.existsSync(path.join(logsDir, base)) ? base : null;
}

