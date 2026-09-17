function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function followUpPlaceholder() {
  return shellQuote('<follow-up task>');
}

function taskQuote(task) {
  return shellQuote(task || '<task>');
}

export function buildRunCommands(run, sessionId = null) {
  const workspace = run.rawWorkspace || run.workspace;
  const cwdPrefix = workspace?.startsWith('/') ? `cd ${shellQuote(workspace)} && ` : '';
  const providerBin = `${run.provider}-agent`;
  const task = run.fullTask || run.task || '';
  const runAgainCommand = `${cwdPrefix}${providerBin} ${taskQuote(task)}`;

  const alternateProviders = ['codex', 'opencode', 'claude', 'antigravity'].filter(
    p => p !== run.provider && (run.provider !== 'agy' || p !== 'antigravity')
  );
  const relayCommands = {};
  for (const p of alternateProviders) {
    relayCommands[p] = `${cwdPrefix}relay takeover ${p}`;
  }

  const continuation = sessionId && sessionId !== 'new' ? {
    sessionId,
    sameSessionCommand: `${cwdPrefix}${providerBin} --resume ${shellQuote(sessionId)} ${followUpPlaceholder()}`,
    continueLastCommand: `${cwdPrefix}${providerBin} --continue ${followUpPlaceholder()}`,
    agentContinueCommand: `${cwdPrefix}${providerBin} --resume ${shellQuote(sessionId)} ${followUpPlaceholder()}`,
    relayCommands,
    runAgainCommand,
    env: { AGENT_RELAY_SESSION: sessionId },
  } : {
    relayCommands,
    runAgainCommand,
  };

  return { runAgainCommand, continuation };
}
