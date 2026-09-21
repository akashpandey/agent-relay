import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import os from 'node:os';

const CONFIG_FILENAMES = ['.agent-relay.json', '.agent-relay.jsonc', 'agent-relay.json'];
export const GLOBAL_CONFIG_PATH = process.env.AGENT_RELAY_ROUTING_CONFIG || path.join(os.homedir(), '.config', 'agent-relay', 'routing.json');

export function findRoutingConfigFile(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(current, filename);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) {
    return GLOBAL_CONFIG_PATH;
  }
  return null;
}

export function stripJsonComments(text) {
  let result = '';
  let inString = false;
  let escape = false;
  let inSingleComment = false;
  let inMultiComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inSingleComment) {
      if (ch === '\n') {
        inSingleComment = false;
        result += ch;
      }
      continue;
    }

    if (inMultiComment) {
      if (ch === '*' && next === '/') {
        inMultiComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      result += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      inSingleComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inMultiComment = true;
      i++;
      continue;
    }

    result += ch;
  }

  return result;
}

export function loadRoutingConfig(workspace = process.cwd()) {
  const configFile = findRoutingConfigFile(workspace);
  if (!configFile) return null;
  try {
    const raw = fs.readFileSync(configFile, 'utf8');
    const stripped = stripJsonComments(raw);
    const parsed = JSON.parse(stripped);
    return { configFile, config: parsed };
  } catch (err) {
    return { configFile, error: err.message };
  }
}

export function matchRoute(config, prompt = '', targetPath = '') {
  if (!config || !config.routing) return null;
  const promptLower = String(prompt).toLowerCase();
  const pathLower = String(targetPath).toLowerCase();

  for (const [routeName, route] of Object.entries(config.routing)) {
    if (!route || typeof route !== 'object') continue;

    // Match keywords against prompt
    if (Array.isArray(route.keywords)) {
      const matchedKeyword = route.keywords.some(kw => {
        const regex = new RegExp(`\\b${escapeRegex(kw.toLowerCase())}\\b`, 'i');
        return regex.test(promptLower);
      });
      if (matchedKeyword) {
        return { routeName, provider: route.provider, model: route.model, reason: `keyword match` };
      }
    }

    // Match path patterns if targetPath exists
    if (pathLower && Array.isArray(route.patterns)) {
      const matchedPattern = route.patterns.some(pat => {
        return simpleGlobMatch(pathLower, pat.toLowerCase());
      });
      if (matchedPattern) {
        return { routeName, provider: route.provider, model: route.model, reason: `pattern match: ${targetPath}` };
      }
    }
  }

  // Fallback to default in config if defined
  if (config.default && config.default.provider) {
    return { routeName: 'default', provider: config.default.provider, model: config.default.model, reason: 'default fallback' };
  }

  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function simpleGlobMatch(filePath, pattern) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');
  const regexPattern = normalizedPattern
    .replace(/\*\*/g, '.*')
    .replace(/(?<!\.)\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`, 'i').test(normalizedPath);
}

function findProviderBinary(name, repoDir) {
  const candidate = path.join(repoDir, name);
  if (fs.existsSync(candidate)) return candidate;
  const mode = fs.constants.X_OK;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    try {
      const p = path.join(dir, name);
      fs.accessSync(p, mode);
      return p;
    } catch {}
  }
  return null;
}

export function discoverHostModels(repoDir) {
  const discovered = {};

  // 1. Antigravity
  const agyBin = findProviderBinary('antigravity-agent', repoDir);
  if (agyBin) {
    try {
      const agyCmd = spawnSync(agyBin, ['--models'], { encoding: 'utf8', timeout: 15000 });
      if (agyCmd.stdout) {
        const clean = agyCmd.stdout.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');
        discovered.antigravity = clean.split(/[\r\n]+/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('Usage:') && !line.startsWith('antigravity-agent:') && !line.includes('Fetching available models'))
          .map(line => line.split(/[\t\s]+/)[0].trim())
          .filter(id => /^[a-zA-Z0-9_.-]+$/.test(id));
      }
    } catch {}
  }

  // 2. OpenCode
  const opencodeBin = findProviderBinary('opencode-agent', repoDir);
  if (opencodeBin) {
    try {
      const opencodeCmd = spawnSync(opencodeBin, ['--models'], { encoding: 'utf8', timeout: 20000 });
      if (opencodeCmd.stdout) {
        discovered.opencode = opencodeCmd.stdout.split(/[\r\n]+/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('[') && !line.startsWith('Usage:') && !line.startsWith('opencode-agent:') && line.includes('/'));
      }
    } catch {}
  }

  // 3. Codex
  const codexBin = findProviderBinary('codex-agent', repoDir);
  if (codexBin) {
    try {
      const codexCmd = spawnSync(codexBin, ['--models'], { encoding: 'utf8', timeout: 5000 });
      if (codexCmd.stdout) {
        discovered.codex = codexCmd.stdout.split(/[\r\n]+/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('Usage:') && !line.startsWith('codex-agent:') && /^[a-zA-Z0-9_.-]+$/.test(line));
      }
    } catch {}
  }

  // 4. Claude
  const claudeBin = findProviderBinary('claude-agent', repoDir);
  if (claudeBin) {
    try {
      const claudeCmd = spawnSync(claudeBin, ['--models'], { encoding: 'utf8', timeout: 5000 });
      if (claudeCmd.stdout) {
        discovered.claude = claudeCmd.stdout.split(/[\r\n]+/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('Usage:') && !line.startsWith('claude-agent:') && /^[a-zA-Z0-9_.-]+$/.test(line));
      }
    } catch {}
  }

  return discovered;
}

export function generateConfigFileContent(discovered = {}) {
  const providersFound = Object.keys(discovered).filter(k => discovered[k]?.length > 0);

  const sampleFrontendProvider = discovered.opencode?.length ? 'opencode' : (discovered.codex?.length ? 'codex' : (providersFound[0] || 'codex'));
  const sampleBackendProvider = discovered.codex?.length ? 'codex' : (discovered.claude?.length ? 'claude' : (providersFound[0] || 'codex'));
  const sampleReviewProvider = discovered.claude?.length ? 'claude' : (providersFound[0] || 'claude');
  const sampleSearchProvider = discovered.antigravity?.length ? 'antigravity' : (providersFound[0] || 'antigravity');

  const lines = [
    '{',
    '  // Task routing rules for agent-relay. When a task is delegated without an explicit provider,',
    '  // agent-relay evaluates prompt keywords and target file patterns to pick the best provider & model.',
    '  "routing": {',
    '    "frontend": {',
    '      "description": "UI, components, styling, layout",',
    '      "keywords": ["ui", "frontend", "css", "component", "page", "react", "tailwind", "html"],',
    '      "patterns": ["src/components/**", "apps/web/**", "*.tsx", "*.jsx", "*.css"],',
    `      "provider": "${sampleFrontendProvider}"`,
    '      // "model": "/* pick from available_models_on_host below */"',
    '    },',
    '    "backend": {',
    '      "description": "APIs, database, migrations, server business logic",',
    '      "keywords": ["api", "backend", "db", "database", "migration", "sql", "server", "endpoint"],',
    '      "patterns": ["server/**", "api/**", "src/db/**", "migrations/**"],',
    `      "provider": "${sampleBackendProvider}"`,
    '      // "model": "/* pick from available_models_on_host below */"',
    '    },',
    '    "review": {',
    '      "description": "Code review, security inspection, edge-case audit",',
    '      "keywords": ["review", "audit", "security", "inspect", "check"],',
    `      "provider": "${sampleReviewProvider}"`,
    '      // "model": "/* pick from available_models_on_host below */"',
    '    },',
    '    "search": {',
    '      "description": "Fast repository exploration, search, and explanation",',
    '      "keywords": ["search", "find", "explain", "where is", "investigate"],',
    `      "provider": "${sampleSearchProvider}"`,
    '      // "model": "/* pick from available_models_on_host below */"',
    '    }',
    '  },',
    '  "default": {',
    `    "provider": "${providersFound[0] || 'codex'}"`,
    '    // "model": "/* optional default model */"',
    '  },',
    '  // Auto-discovered models present on this machine (use any of these in your routes above):',
    '  "available_models_on_host": ' + JSON.stringify(discovered, null, 4).split('\n').join('\n  '),
    '}',
    '',
  ];

  return lines.join('\n');
}
