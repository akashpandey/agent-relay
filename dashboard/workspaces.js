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

  const codeRoot = process.env.AGENT_RELAY_CODE_ROOT || process.env.SUBAGENT_CODE_ROOT || path.join(os.homedir(), 'Code');

  // Helper to collapse ephemeral feature folders into base repo
  const resolveProjectFolder = (parentDir, projectName) => {
    if (projectName.startsWith('fitschool-') && projectName !== 'fitschool-waitlist') {
      return `${parentDir}/fitschool`;
    }
    return `${parentDir}/${projectName}`;
  };

  // 2. Tmp worktrees: /tmp/<proj>-worktrees/* or /tmp/worktrees/<proj>/*
  const tmpMatch = clean.match(/^\/tmp\/([^/]+)-worktrees(?:\/.*)?$/);
  if (tmpMatch) {
    return resolveProjectFolder(codeRoot, tmpMatch[1]);
  }
  const tmpWorktreeMatch = clean.match(/^\/tmp\/worktrees\/([^/]+)(?:\/.*)?$/);
  if (tmpWorktreeMatch) {
    return resolveProjectFolder(codeRoot, tmpWorktreeMatch[1]);
  }

  // 3. Embedded worktrees (.worktrees or .claude/worktrees)
  const embeddedWorktree = clean.match(/^(.+?)\/(?:\.claude|\.worktrees|\.git)\/worktrees(?:\/.*)?$/);
  if (embeddedWorktree) {
    return canonicalWorkspacePath(embeddedWorktree[1]);
  }

  // 4. Scratch & Test paths: any path under /tmp that wasn't a project worktree, or test/scratchpad paths
  if (
    clean.startsWith('/tmp/') ||
    clean === '/tmp' ||
    clean.includes('test-subagent') ||
    clean.includes('local-subagents') ||
    clean.endsWith('/subagents') ||
    /\b(?:scratch|scratchpad)\b/i.test(clean)
  ) {
    return 'Other / Scratch';
  }

  // 5. Explicit CODE_ROOT check if provided via environment
  const envCodeRoot = process.env.AGENT_RELAY_CODE_ROOT || process.env.SUBAGENT_CODE_ROOT;
  if (envCodeRoot) {
    const normRoot = envCodeRoot.replace(/\/+$/, '');
    if (clean === normRoot) return 'Other / Scratch';
    if (clean.startsWith(`${normRoot}/`)) {
      const rest = clean.slice(normRoot.length + 1);
      const [, name] = rest.match(/^([^/]+)(?:\/|$)/) || [];
      return name ? resolveProjectFolder(normRoot, name) : normRoot;
    }
  }

  // 6. Auto-detect common developer repository parent directories (Linux / macOS / container)
  // e.g. /home/<user>/Code/<project>, /Users/<user>/Projects/<project>, /root/Code/<project>
  const devRootMatch = clean.match(/^((?:\/(?:home|Users)\/[^/]+|\/root)\/(?:Code|Projects|projects|src|repos|workspace|workspaces))(?:\/([^/]+))?/);
  if (devRootMatch) {
    const [, parentDir, projectName] = devRootMatch;
    if (projectName) {
      return resolveProjectFolder(parentDir, projectName);
    }
    return 'Other / Scratch';
  }

  // 7. If under homedir Code
  const homeCodeRoot = path.join(os.homedir(), 'Code');
  if (clean === homeCodeRoot) return 'Other / Scratch';
  if (clean.startsWith(`${homeCodeRoot}/`)) {
    const [, name] = clean.slice(homeCodeRoot.length + 1).match(/^([^/]+)(?:\/|$)/) || [];
    if (name) {
      return resolveProjectFolder(homeCodeRoot, name);
    }
    return homeCodeRoot;
  }

  // 8. Fallback: If it is an absolute path, treat as canonical
  return clean.startsWith('/') ? clean : null;
}
