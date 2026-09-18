#!/usr/bin/env node
const message = 'Agent Relay available: delegate tasks to opencode/codex/claude/antigravity. Check agent-relay skill or run relay --help for details.';

try {
  if (process.env.PLUGIN_DATA) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: message,
      },
    }));
  } else {
    process.stdout.write(message);
  }
} catch (e) {
  // Silent fail
}
