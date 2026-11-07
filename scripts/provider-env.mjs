// Single source of truth for per-provider environment variable names.
// Canonical provider keys are the ones exposed by MCP/CLI; aliases normalize to them.
const PROVIDER_ENV = {
  opencode: { model: 'OPENCODE_MODEL', timeout: 'OPENCODE_TIMEOUT', timeoutStyle: 'plain' },
  codex: { model: 'CODEX_MODEL', timeout: 'CODEX_TIMEOUT', timeoutStyle: 'plain' },
  claude: { model: 'CLAUDE_MODEL', timeout: 'CLAUDE_TIMEOUT', timeoutStyle: 'plain' },
  antigravity: { model: 'AGY_MODEL', timeout: 'AGY_PRINT_TIMEOUT', timeoutStyle: 'seconds-suffix' },
};

export const providerAliases = { agy: 'antigravity' };

export function canonicalProvider(provider) {
  return providerAliases[provider] || provider;
}

export function providerEnv(provider) {
  return PROVIDER_ENV[canonicalProvider(provider)] || null;
}

export function applyProviderEnv(env, provider, { model, timeoutSeconds } = {}) {
  const spec = providerEnv(provider);
  if (!spec) return false;
  if (model) env[spec.model] = model;
  if (timeoutSeconds != null) {
    env[spec.timeout] = spec.timeoutStyle === 'seconds-suffix' ? `${timeoutSeconds}s` : String(timeoutSeconds);
  }
  return true;
}
