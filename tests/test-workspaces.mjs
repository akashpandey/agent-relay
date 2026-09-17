import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { canonicalWorkspacePath } from '../dashboard/workspaces.js';

describe('Workspace Canonicalization', () => {
  const codeRoot = process.env.AGENT_RELAY_CODE_ROOT || process.env.SUBAGENT_CODE_ROOT || path.join(os.homedir(), 'Code');

  it('handles null, empty, and Unknown workspaces', () => {
    assert.equal(canonicalWorkspacePath(null), null);
    assert.equal(canonicalWorkspacePath(''), null);
    assert.equal(canonicalWorkspacePath('Unknown'), null);
  });

  it('preserves clean base repositories under codeRoot', () => {
    assert.equal(canonicalWorkspacePath(`${codeRoot}/agent-relay`), `${codeRoot}/agent-relay`);
    assert.equal(canonicalWorkspacePath(`${codeRoot}/agent-relay/`), `${codeRoot}/agent-relay`);
    assert.equal(canonicalWorkspacePath(`${codeRoot}/fitschool`), `${codeRoot}/fitschool`);
  });

  it('collapses feature branches and subdirectories into base repository', () => {
    assert.equal(canonicalWorkspacePath(`${codeRoot}/fitschool-fix`), `${codeRoot}/fitschool`);
    assert.equal(canonicalWorkspacePath(`${codeRoot}/fitschool-fix/nested/dir`), `${codeRoot}/fitschool`);
    assert.equal(canonicalWorkspacePath(`${codeRoot}/fitschool-feature-auth`), `${codeRoot}/fitschool`);
  });

  it('collapses tmp worktrees with -worktrees suffix into base repository', () => {
    assert.equal(canonicalWorkspacePath('/tmp/fitschool-worktrees/task-1'), `${codeRoot}/fitschool`);
    assert.equal(canonicalWorkspacePath('/tmp/agent-relay-worktrees/patch-1'), `${codeRoot}/agent-relay`);
  });

  it('collapses tmp worktrees with feature suffix into base repository', () => {
    assert.equal(canonicalWorkspacePath('/tmp/fitschool-fix-worktrees/branch'), `${codeRoot}/fitschool`);
    assert.equal(canonicalWorkspacePath('/tmp/worktrees/fitschool-fix/branch'), `${codeRoot}/fitschool`);
  });

  it('collapses embedded git/claude worktrees to base repository', () => {
    assert.equal(
      canonicalWorkspacePath(`${codeRoot}/fitschool/.worktrees/feature-x`),
      `${codeRoot}/fitschool`
    );
    assert.equal(
      canonicalWorkspacePath(`${codeRoot}/agent-relay/.claude/worktrees/sub-branch`),
      `${codeRoot}/agent-relay`
    );
  });

  it('maps container paths (/root/Code) with feature branches correctly', () => {
    assert.equal(canonicalWorkspacePath('/root/Code/fitschool'), '/root/Code/fitschool');
    assert.equal(canonicalWorkspacePath('/root/Code/fitschool-fix'), '/root/Code/fitschool');
    assert.equal(canonicalWorkspacePath('/root/Code/fitschool-payment/nested'), '/root/Code/fitschool');
  });

  it('routes scratch, test, and ad-hoc /tmp directories to Other / Scratch', () => {
    assert.equal(canonicalWorkspacePath('/tmp/test-subagent-abc'), 'Other / Scratch');
    assert.equal(canonicalWorkspacePath('/tmp/random-scratchpad'), 'Other / Scratch');
    assert.equal(canonicalWorkspacePath('/tmp/scratch-runner-123'), 'Other / Scratch');
    assert.equal(canonicalWorkspacePath('/home/akey/Code/local-subagents'), 'Other / Scratch');
    assert.equal(canonicalWorkspacePath(`${codeRoot}/subagents`), 'Other / Scratch');
  });
});
