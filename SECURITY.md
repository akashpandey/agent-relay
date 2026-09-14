# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability within `agent-relay`, please report it directly by email to Akash Pandey at `pandeyak12@outlook.com` instead of opening a public issue.

Please include:
- A description of the issue and potential impact
- Reproduction steps or a minimal test case
- Any suggested mitigations

We will review reports promptly and publish patches with proper credit.

## Security Considerations

1. **Subagent Execution & Sandboxing**:
   - `agent-relay` wrappers execute backing CLIs in non-interactive mode. By design, subagents may create, edit, or delete files in the working directory from which they are launched.
   - Always run subagents in trusted repositories or disposable git worktrees (`git worktree add ...`).
2. **Secrets & Logs**:
   - Run logs are saved locally under `~/local-subagents/logs/` (or the directory specified by `SUBAGENT_LOG_DIR`).
   - These logs may contain prompts, tool outputs, and repository snippets generated during subagent execution. They are created with default user file permissions and are never transmitted to external telemetry servers.
3. **Local Dashboard**:
   - The monitoring dashboard binds to `127.0.0.1` by default and is intended solely for local workstation access. Do not expose its port directly to untrusted public networks without an authenticated reverse proxy.
