import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODE_ROOT = process.env.SUBAGENT_CODE_ROOT || '/home/akey/Code';

export function configuredWorkspaceEntries() {
  const configPath = process.env.SUBAGENT_WORKSPACES_CONFIG ||
    path.join(os.homedir(), '.config', 'local-subagents', 'workspaces.json');
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

  for (const configured of configuredWorkspaceEntries()) {
    const root = configured.path.replace(/\/+$/, '');
    if (clean === root || clean.startsWith(`${root}/`)) return root;
  }

  if (clean === '/home/akey/local-subagents' || clean.startsWith('/home/akey/local-subagents/')) {
    return `${CODE_ROOT}/local-subagents`;
  }
  if (clean === `${CODE_ROOT}/OfdcParser` || clean.startsWith(`${CODE_ROOT}/OfdcParser/`)) {
    return `${CODE_ROOT}/OfdcApplication`;
  }
  if (clean.startsWith('/tmp/fitschool-worktrees/') ||
      clean.startsWith(`${CODE_ROOT}/fitschool/.worktrees/`) ||
      clean.startsWith(`${CODE_ROOT}/fitschool/.claude/worktrees/`) ||
      clean.startsWith(`${CODE_ROOT}/fitschool/`)) {
    return `${CODE_ROOT}/fitschool`;
  }
  if (clean.startsWith(`${CODE_ROOT}/fitschool-`) && clean !== `${CODE_ROOT}/fitschool-waitlist` && !clean.startsWith(`${CODE_ROOT}/fitschool-waitlist/`)) {
    return `${CODE_ROOT}/fitschool`;
  }
  if (clean.startsWith(`${CODE_ROOT}/`)) {
    const [, name] = clean.slice(CODE_ROOT.length + 1).match(/^([^/]+)(?:\/|$)/) || [];
    return name ? `${CODE_ROOT}/${name}` : null;
  }

  return null;
}
