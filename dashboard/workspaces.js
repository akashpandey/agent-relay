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
  const clean = String(workspace).replace(/\/+$/, '');
  if (!clean) return null;

  // 1. Match against user-configured workspace entries
  for (const configured of configuredWorkspaceEntries()) {
    const root = configured.path.replace(/\/+$/, '');
    if (clean === root || clean.startsWith(`${root}/`)) return root;
  }

  // 2. Explicit CODE_ROOT check if provided via environment
  const envCodeRoot = process.env.AGENT_RELAY_CODE_ROOT || process.env.SUBAGENT_CODE_ROOT;
  if (envCodeRoot) {
    const normRoot = envCodeRoot.replace(/\/+$/, '');
    if (clean === normRoot) return normRoot;
    if (clean.startsWith(`${normRoot}/`)) {
      const [, name] = clean.slice(normRoot.length + 1).match(/^([^/]+)(?:\/|$)/) || [];
      return name ? `${normRoot}/${name}` : normRoot;
    }
  }

  // 3. Auto-detect common developer repository parent directories (Linux / macOS / container)
  // e.g. /home/<user>/Code/<project>, /Users/<user>/Projects/<project>, /root/Code/<project>
  const devRootMatch = clean.match(/^((?:\/(?:home|Users)\/[^/]+|\/root)\/(?:Code|Projects|projects|src|repos|workspace|workspaces))(?:\/([^/]+))?/);
  if (devRootMatch) {
    const [, parentDir, projectName] = devRootMatch;
    return projectName ? `${parentDir}/${projectName}` : parentDir;
  }

  // 4. If under homedir Code
  const homeCodeRoot = path.join(os.homedir(), 'Code');
  if (clean === homeCodeRoot) return homeCodeRoot;
  if (clean.startsWith(`${homeCodeRoot}/`)) {
    const [, name] = clean.slice(homeCodeRoot.length + 1).match(/^([^/]+)(?:\/|$)/) || [];
    return name ? `${homeCodeRoot}/${name}` : homeCodeRoot;
  }

  // 5. Fallback: If it is an absolute path, treat as canonical
  return clean.startsWith('/') ? clean : null;
}
