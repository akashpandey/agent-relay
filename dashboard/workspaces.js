import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODE_ROOT = process.env.AGENT_RELAY_CODE_ROOT || process.env.SUBAGENT_CODE_ROOT || path.join(os.homedir(), 'Code');

export function configuredWorkspaceEntries() {
  const configPath = process.env.AGENT_RELAY_WORKSPACES_CONFIG || process.env.SUBAGENT_WORKSPACES_CONFIG ||
    path.join(os.homedir(), '.config', 'agent-relay', 'workspaces.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (Array.isArray(parsed)) {
      return parsed.map(value => ({ name: path.basename(String(value)), path: String(value) }));
    }
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).map(([name, value]) => ({ name, path: String(value) }));
    }
  } catch {}
  return [];
}

export function canonicalWorkspacePath(workspace) {
  if (!workspace || workspace === 'Unknown') return null;
  const clean = workspace.replace(/\/+$/, '');

  // Match against user-configured workspace entries
  for (const configured of configuredWorkspaceEntries()) {
    const root = configured.path.replace(/\/+$/, '');
    if (clean === root || clean.startsWith(`${root}/`)) return root;
  }

  // Auto-detect workspaces under CODE_ROOT by first path segment
  if (clean.startsWith(`${CODE_ROOT}/`)) {
    const [, name] = clean.slice(CODE_ROOT.length + 1).match(/^([^/]+)(?:\/|$)/) || [];
    return name ? `${CODE_ROOT}/${name}` : null;
  }

  return null;
}
