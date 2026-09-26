#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), '..');

// Terminal styling
const isTTY = Boolean(process.stdout.isTTY) && !('NO_COLOR' in process.env && process.env.NO_COLOR !== '');
const c = {
  reset: isTTY ? '\x1b[0m' : '',
  bold: isTTY ? '\x1b[1m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  blue: isTTY ? '\x1b[34m' : '',
  magenta: isTTY ? '\x1b[35m' : '',
  red: isTTY ? '\x1b[31m' : '',
};

function clearScreen() {
  if (isTTY) {
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  }
}

function promptRawKey() {
  return new Promise(resolve => {
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', data => {
      const str = data.toString();
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      resolve(str);
    });
  });
}

function displayPath(val) {
  const home = os.homedir();
  return val === home || val.startsWith(`${home}/`) ? `~${val.slice(home.length)}` : val;
}

function checkCommand(command) {
  const mode = fs.constants.X_OK;
  return (process.env.PATH || '').split(path.delimiter).some(dir => {
    try {
      const candidate = path.join(dir || '.', command);
      fs.accessSync(candidate, mode);
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

const HARNESSES = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', desc: 'Anthropic Claude Code CLI' },
  { id: 'codex', name: 'OpenAI Codex', bin: 'codex', desc: 'OpenAI Codex CLI' },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', desc: 'OpenCode multi-provider harness' },
  { id: 'agy', name: 'Antigravity CLI', bin: 'agy', desc: 'Google Gemini Antigravity CLI' },
];

/**
 * Interactive Checkbox Multi-Select Menu
 */
async function selectCheckboxes(title, items, initialChecked = []) {
  if (!isTTY) {
    return initialChecked;
  }

  let cursor = 0;
  const checked = new Set(initialChecked);

  while (true) {
    let output = `\n${c.bold}${c.cyan}? ${title}${c.reset} ${c.dim}(Space to toggle, Enter to confirm, A to toggle all)${c.reset}\n`;
    items.forEach((item, idx) => {
      const isCursor = idx === cursor;
      const isChecked = checked.has(item.id);
      const pointer = isCursor ? `${c.cyan}❯${c.reset}` : ' ';
      const box = isChecked ? `${c.green}◉${c.reset}` : `${c.dim}◯${c.reset}`;
      const label = isCursor ? `${c.bold}${item.name}${c.reset}` : item.name;
      const badge = item.status ? ` ${item.status}` : '';
      output += `  ${pointer} ${box} ${label}${badge} ${c.dim}${item.desc || ''}${c.reset}\n`;
    });

    process.stdout.write(output);

    const key = await promptRawKey();

    // Clear printed menu lines
    const lineCount = items.length + 2;
    process.stdout.write(`\x1b[${lineCount}A\r\x1b[0J`);

    if (key === '\u0003') { // Ctrl+C
      process.exit(130);
    } else if (key === '\r' || key === '\n') { // Enter
      break;
    } else if (key === ' ' || key === 'x') { // Space
      const id = items[cursor].id;
      if (checked.has(id)) checked.delete(id);
      else checked.add(id);
    } else if (key === 'a' || key === 'A') { // Toggle All
      if (checked.size === items.length) checked.clear();
      else items.forEach(it => checked.add(it.id));
    } else if (key === '\u001b[A' || key === 'k') { // Up
      cursor = (cursor - 1 + items.length) % items.length;
    } else if (key === '\u001b[B' || key === 'j') { // Down
      cursor = (cursor + 1) % items.length;
    }
  }

  return [...checked];
}

/**
 * Single-select radio menu
 */
async function selectRadio(title, items, defaultIndex = 0) {
  if (!isTTY) {
    return items[defaultIndex].id;
  }

  let cursor = defaultIndex;

  while (true) {
    let output = `\n${c.bold}${c.cyan}? ${title}${c.reset} ${c.dim}(Use arrow keys, Enter to confirm)${c.reset}\n`;
    items.forEach((item, idx) => {
      const isCursor = idx === cursor;
      const pointer = isCursor ? `${c.cyan}❯${c.reset}` : ' ';
      const circle = isCursor ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
      const label = isCursor ? `${c.bold}${item.name}${c.reset}` : item.name;
      output += `  ${pointer} ${circle} ${label} ${c.dim}${item.desc || ''}${c.reset}\n`;
    });

    process.stdout.write(output);

    const key = await promptRawKey();

    const lineCount = items.length + 2;
    process.stdout.write(`\x1b[${lineCount}A\r\x1b[0J`);

    if (key === '\u0003') {
      process.exit(130);
    } else if (key === '\r' || key === '\n') {
      break;
    } else if (key === '\u001b[A' || key === 'k') {
      cursor = (cursor - 1 + items.length) % items.length;
    } else if (key === '\u001b[B' || key === 'j') {
      cursor = (cursor + 1) % items.length;
    }
  }

  return items[cursor].id;
}

export async function runInstallationTui() {
  clearScreen();

  console.log(`
${c.bold}${c.cyan}   ___                    __       ___      __           ${c.reset}
${c.bold}${c.cyan}  / _ | ___ ____ ___  ___/ /____  / _ \\___ / /__ ___ __  ${c.reset}
${c.bold}${c.cyan} / __ |/ _ \`/ -_) _ \\/ _  /___/  / , _/ -_) / _ \`/ // /  ${c.reset}
${c.bold}${c.cyan}/_/ |_|\\_, /\\__/_//_/\\_,_/      /_/|_|\\__/_/\\_,_/\\_, /   ${c.reset}
${c.bold}${c.cyan}      /___/                                     /___/    ${c.reset}
${c.dim}Interactive Setup Wizard & Environment Configurator${c.reset}
`);

  console.log(`${c.bold}Scanning your environment for AI harnesses...${c.reset}\n`);

  // Detect harnesses
  const detectedHarnesses = HARNESSES.map(h => {
    const found = checkCommand(h.bin);
    return {
      ...h,
      found,
      status: found ? `${c.green}[Found on PATH]${c.reset}` : `${c.yellow}[Not on PATH]${c.reset}`,
    };
  });

  const initiallyChecked = detectedHarnesses.filter(h => h.found).map(h => h.id);

  // 1. Select Harnesses to Configure
  const selectedHarnessIds = await selectCheckboxes(
    'Select AI harnesses to configure for agent-relay:',
    detectedHarnesses,
    initiallyChecked
  );

  // 2. Claude Code SessionStart Hook
  let enableClaudeHook = false;
  if (selectedHarnessIds.includes('claude')) {
    const hookChoice = await selectRadio(
      'Install Claude Code SessionStart reminder hook?',
      [
        { id: 'yes', name: 'Yes (Recommended)', desc: 'Claude will automatically remember agent-relay is available upon starting a session' },
        { id: 'no', name: 'No', desc: 'Skip Claude Code session hook setup' },
      ],
      0
    );
    enableClaudeHook = hookChoice === 'yes';
  }

  // 3. Dashboard Deployment Option
  const dockerAvailable = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
  const dashboardChoices = [];
  if (dockerAvailable) {
    dashboardChoices.push({
      id: 'docker',
      name: 'Docker Container (Recommended)',
      desc: 'Runs persistent background web dashboard via Docker on port 4242',
    });
  }
  dashboardChoices.push(
    { id: 'background', name: 'Background Node Process', desc: 'Runs agent-dashboard in background using native Node.js' },
    { id: 'manual', name: 'Manual / Skip', desc: 'Do not start dashboard now (run `relay dashboard` later)' }
  );

  const dashboardChoice = await selectRadio(
    'How would you like to run the Web Dashboard (http://localhost:4242)?',
    dashboardChoices,
    0
  );

  // Confirmation screen
  console.log(`\n${c.bold}Configuration Summary:${c.reset}`);
  console.log(`  • Configured harnesses: ${selectedHarnessIds.length ? selectedHarnessIds.map(h => `${c.green}${h}${c.reset}`).join(', ') : `${c.yellow}None${c.reset}`}`);
  if (selectedHarnessIds.includes('claude')) {
    console.log(`  • Claude Code SessionStart hook: ${enableClaudeHook ? `${c.green}Enabled${c.reset}` : `${c.dim}Disabled${c.reset}`}`);
  }
  console.log(`  • Dashboard setup: ${c.cyan}${dashboardChoice}${c.reset}`);

  const proceedChoice = await selectRadio(
    'Proceed with setup?',
    [
      { id: 'proceed', name: 'Proceed with installation', desc: 'Apply all settings and register tools' },
      { id: 'cancel', name: 'Cancel', desc: 'Exit without making changes' },
    ],
    0
  );

  if (proceedChoice === 'cancel') {
    console.log(`\n${c.yellow}Installation cancelled.${c.reset}\n`);
    process.exit(0);
  }

  console.log(`\n${c.bold}Applying configuration...${c.reset}\n`);

  // Build flags for relay install
  const flags = [];
  if (enableClaudeHook) flags.push('--hooks');
  else flags.push('--no-hooks');

  if (dashboardChoice === 'docker' || dashboardChoice === 'background') {
    flags.push('--dashboard');
  } else {
    flags.push('--no-dashboard');
  }

  // Execute skill link and MCP registration
  const installSkillScript = path.join(repoDir, 'install-skill');
  console.log(`• Linking skills...`);
  spawnSync(installSkillScript, [], { cwd: repoDir, stdio: 'inherit' });

  // Execute relay install CLI internally with selected arguments
  const agentCliScript = path.join(repoDir, 'scripts', 'agent-cli.mjs');
  const installChild = spawnSync(process.execPath, [agentCliScript, 'install', ...flags], {
    cwd: repoDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENT_RELAY_SELECTED_PROVIDERS: selectedHarnessIds.join(','),
    },
  });

  if (installChild.status === 0) {
    console.log(`\n${c.bold}${c.green}✓ Agent Relay installation completed successfully!${c.reset}`);
    console.log(`\n${c.bold}Try delegating your first task:${c.reset}`);
    const first = selectedHarnessIds[0] || 'claude';
    console.log(`  ${c.cyan}relay ${first} "Review this repository and summarize key features."${c.reset}\n`);
  } else {
    console.log(`\n${c.red}Installation completed with warnings or errors (exit code: ${installChild.status}).${c.reset}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runInstallationTui().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
