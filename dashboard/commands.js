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
  const provider = run.provider === 'antigravity' ? 'agy' : run.provider;
  const workspace = run.workspaceName || run.workspace;
  const workspaceArg = workspace && workspace !== 'Unknown' ? workspace : null;
  const providerBin = `${run.provider}-subagent`;
  const subagentPrefix = workspaceArg ? `relay ${shellQuote(workspaceArg)}` : 'relay';
  const task = run.fullTask || run.task || '';
  const runAgainCommand = `${subagentPrefix} ${provider} ${taskQuote(task)}`;

  const alternateProviders = ['codex', 'opencode', 'claude', 'antigravity'].filter(
    p => p !== run.provider && (run.provider !== 'agy' || p !== 'antigravity')
  );
  const relayCommands = {};
  for (const p of alternateProviders) {
    relayCommands[p] = workspaceArg
      ? `relay takeover ${shellQuote(workspaceArg)} ${p}`
      : `relay takeover ${p}`;
  }

  const continuation = sessionId && sessionId !== 'new' ? {
    sessionId,
    sameSessionCommand: `${providerBin} --resume ${JSON.stringify(sessionId)} ${followUpPlaceholder()}`,
    continueLastCommand: `${providerBin} --continue ${followUpPlaceholder()}`,
    subagentContinueCommand: workspaceArg
      ? `relay continue ${shellQuote(workspaceArg)} ${followUpPlaceholder()}`
      : `relay continue ${followUpPlaceholder()}`,
    relayCommands,
    runAgainCommand,
    env: { SUBAGENT_SESSION: sessionId },
  } : {
    relayCommands,
    runAgainCommand,
  };

  return { runAgainCommand, continuation };
}
