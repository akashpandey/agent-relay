#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const initCwd = process.env.INIT_CWD && path.resolve(process.env.INIT_CWD);
  const directInstall = process.env.npm_config_global === 'true' || (initCwd && fs.realpathSync(initCwd) === fs.realpathSync(repoDir));
  if (directInstall) {
    const result = spawnSync(path.join(repoDir, 'install-skill'), ['--quiet'], { cwd: repoDir, encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0) console.warn(`agent-relay postinstall warning: ${result.error?.message || result.stderr?.trim() || 'symlink installation failed'}`);
  }
} catch (err) {
  console.warn(`agent-relay postinstall warning: ${err.message}`);
}

process.exit(0);
