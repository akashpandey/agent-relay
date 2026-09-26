#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function getCustomConfigModels(provider) {
  const custom = new Set();
  const searchPaths = [
    path.join(process.cwd(), '.agent-relay.json'),
    path.join(os.homedir(), '.agent-relay', 'models.json'),
    path.join(os.homedir(), '.config', 'agent-relay', 'models.json'),
  ];
  for (const configPath of searchPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const list = parsed.models?.[provider] || parsed.providers?.[provider]?.models;
        if (Array.isArray(list)) {
          for (const m of list) custom.add(String(m).trim());
        }
      } catch {}
    }
  }
  return Array.from(custom);
}

export function getCodexModels() {
  const models = new Set();
  const cacheFile = path.join(os.homedir(), '.codex', 'models_cache.json');
  if (fs.existsSync(cacheFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (Array.isArray(data.models)) {
        for (const m of data.models) {
          if (m && (m.visibility === 'list' || m.supported_in_api) && m.slug) {
            models.add(m.slug.trim());
          }
        }
      }
    } catch {}
  }
  for (const custom of getCustomConfigModels('codex')) {
    models.add(custom);
  }
  if (models.size === 0) {
    return ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
  }
  return Array.from(models);
}

export function getClaudeModels() {
  const models = new Set(['opus', 'sonnet', 'haiku']);
  const claudeJson = path.join(os.homedir(), '.claude.json');
  if (fs.existsSync(claudeJson)) {
    try {
      const data = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      if (Array.isArray(data.additionalModelOptionsCache)) {
        for (const opt of data.additionalModelOptionsCache) {
          if (opt && typeof opt.value === 'string' && opt.value.trim()) {
            models.add(opt.value.trim());
          }
        }
      }
    } catch {}
  }

  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  if (fs.existsSync(settingsFile)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (settings && typeof settings.model === 'string' && settings.model.trim()) {
        models.add(settings.model.trim());
      }
    } catch {}
  }

  for (const custom of getCustomConfigModels('claude')) {
    models.add(custom);
  }

  return Array.from(models);
}

export function getAntigravityModels() {
  const models = new Set();
  const agyBin = process.env.AGENT_RELAY_AGY_BIN || process.env.SUBAGENT_AGY_BIN || 'agy';
  const res = spawnSync(agyBin, ['models'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (res.status === 0 && res.stdout) {
    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.toLowerCase().includes('fetching available models') || trimmed.startsWith('#')) {
        continue;
      }
      const id = trimmed.split(/\s+/)[0];
      if (id) models.add(id);
    }
  }
  for (const custom of getCustomConfigModels('antigravity')) {
    models.add(custom);
  }
  return Array.from(models);
}

export function getOpencodeModels() {
  const models = new Set();
  const opencodeBin = process.env.AGENT_RELAY_OPENCODE_BIN || process.env.SUBAGENT_OPENCODE_BIN || 'opencode';
  const supportedProviders = ['opencode-go', 'openai', 'zai-coding-plan'];
  for (const prov of supportedProviders) {
    const res = spawnSync(opencodeBin, ['models', prov], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (res.status === 0 && res.stdout) {
      for (const line of res.stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('[') || trimmed.startsWith('#') || trimmed.startsWith('Fetching')) {
          continue;
        }
        if (trimmed.includes('/') && !trimmed.includes(' ')) {
          models.add(trimmed);
        }
      }
    }
  }
  for (const custom of getCustomConfigModels('opencode')) {
    models.add(custom);
  }
  return Array.from(models);
}

export function getProviderModels(provider) {
  switch (provider) {
    case 'codex':
      return getCodexModels();
    case 'claude':
      return getClaudeModels();
    case 'antigravity':
      return getAntigravityModels();
    case 'opencode':
      return getOpencodeModels();
    default:
      return [];
  }
}

// CLI entry point
const isDirectCall = process.argv[1] && (
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
  process.argv[1].endsWith('resolve-models.mjs')
);

if (isDirectCall) {
  const providerArg = process.argv[2]?.toLowerCase();
  if (providerArg && providerArg !== 'all') {
    const models = getProviderModels(providerArg);
    for (const m of models) {
      console.log(m);
    }
  } else if (providerArg === 'all' || !process.argv[2]) {
    const all = {
      codex: getCodexModels(),
      claude: getClaudeModels(),
      antigravity: getAntigravityModels(),
      opencode: getOpencodeModels(),
    };
    console.log(JSON.stringify(all, null, 2));
  }
}
