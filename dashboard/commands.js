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
  const subagentPrefix = workspaceArg ? `subagent ${shellQuote(workspaceArg)}` : 'subagent';
  const task = run.fullTask || run.task || '';
  const runAgainCommand = `${subagentPrefix} ${provider} ${taskQuote(task)}`;
  const continuation = sessionId && sessionId !== 'new' ? {
    sessionId,
    sameSessionCommand: `${providerBin} --resume ${JSON.stringify(sessionId)} ${followUpPlaceholder()}`,
    continueLastCommand: `${providerBin} --continue ${followUpPlaceholder()}`,
    subagentContinueCommand: workspaceArg
      ? `subagent continue ${shellQuote(workspaceArg)} ${followUpPlaceholder()}`
      : `subagent continue ${followUpPlaceholder()}`,
    runAgainCommand,
    env: { SUBAGENT_SESSION: sessionId },
  } : null;

  return { runAgainCommand, continuation };
}
