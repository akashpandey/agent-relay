// Headless format check for the dashboard terminal renderer. app.js is a
// browser script, top-level functions are extracted and run against fixture
// lines taken from a real codex stream ("type": item.completed etc.).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'dashboard/public/app.js'), 'utf8');

function grab(name) {
  // Top-level functions sit at column 0; take text up to the next declaration.
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `not found: ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(1).match(/^function [a-zA-Z_$]+|^const [a-zA-Z_$]+|^let [a-zA-Z_$]+/m);
  return next ? rest.slice(0, next.index + 1) : rest;
}

const script = [
  'const ANSI_FG = ' + (source.match(/^const ANSI_FG = \{[^}]+\}/m) || [])[0].slice('const ANSI_FG = '.length),
  grab('ansiToHtml'),
  grab('streamBadge'),
  grab('dimText'),
  grab('clipEscaped'),
  grab('formatCodexItem'),
  grab('formatClaudeBlocks'),
  grab('formatLogLine'),
  `function escapeHtml(str) { return String(str).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'); }
   function formatNumber(n) { return String(n); }
   return { formatLogLine };`,
].join('\n');
const { formatLogLine } = new Function(script)();
const strip = html => String(html ?? '').replace(/<[^>]+>/g, '');

test('ANSI color walker renders composed SGR sequences', () => {
  const out = formatLogLine('\x1b[1;31mbold-red\x1b[0m plain');
  assert.match(out, /font-weight: bold/);
  assert.match(out, /#f87171/);
  assert.equal(strip(out), 'bold-red plain');
});

test('wrapper chrome is styled or hidden, not raw noise', () => {
  assert.match(strip(formatLogLine('agent: provider=codex workspace=/x model=m session=new')), /agent: provider=codex/);
  assert.equal(formatLogLine('agent-output-start: 81360'), '');
});

const codexEvents = [
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'pwd', status: 'in_progress' } }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Inspecting the fixture helpers first.' } }),
  JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: '/bin/bash -lc password-command', aggregated_output: '/etc/secret\n' + 'x'.repeat(2000), exit_code: 0 } }),
  JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'ctx', tool: 'ctx_execute', arguments: { code: 'z'.repeat(5000) }, result: { content: [{ type: 'text', text: 'y'.repeat(9000) }] }, error: null } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1234, cached_input_tokens: 0, output_tokens: 567 } }),
  JSON.stringify({ type: 'brand.new.event', payload: { a: 1 } }),
];

test('codex agent_message renders as prose, not JSON', () => {
  const line = codexEvents.map(formatLogLine).find(l => l.includes('Inspecting the fixture helpers'));
  assert.ok(line);
  assert.ok(!line.includes('&quot;type&quot;'));
  assert.match(line, /term-msg/);
});

test('command output and tool payloads are compacted with a marker', () => {
  const rendered = codexEvents.map(l => strip(formatLogLine(l))).join('\n');
  assert.match(rendered, /EXEC/);
  assert.match(rendered, /\(\+[\d,]+ chars\)/);
  assert.ok(!rendered.includes('{"type"'));
  assert.ok(rendered.length < 4000, 'no wall of raw JSON');
});

test('noise events are hidden, usage events stay dim', () => {
  assert.equal(formatLogLine(codexEvents[0]), '');            // turn.started
  assert.equal(formatLogLine(codexEvents[1]), '');            // item.started
  assert.match(strip(formatLogLine(codexEvents[5])), /1234/); // token usage visible
});

test('unknown future events fold into a compact card', () => {
  const line = formatLogLine(codexEvents[6]);
  assert.match(line, /\[compact brand\.new\.event\]/);
  assert.ok(strip(line).length < 400);
});

test('claude assistant/user/result lines render as blocks', () => {
  const claudeLines = [
    JSON.stringify({ type: 'system', subtype: 'init', model: 'opus', cwd: '/ws' }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'checking the schema' },
      { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } },
      { type: 'text', text: 'Done.' },
    ] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'tests passed' }] } }),
  ];
  const out = claudeLines.map(l => formatLogLine(l));
  assert.match(out[0], /INIT.*init.*opus/);
  assert.match(out[1], /THOUGHT/);
  assert.match(out[1], /Bash/);
  assert.match(strip(out[1]), /Done\./);
  assert.match(strip(out[2]), /tests passed/);
});

test('opencode JSONL events render as readable blocks', () => {
  const ocLines = [
    JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_x', part: { type: 'step-start', messageID: 'm1' } }),
    JSON.stringify({ type: 'tool_use', timestamp: 1, part: { type: 'tool', tool: 'execute', state: { status: 'completed', input: { code: 'return 1'.repeat(400) }, output: '{"items":[]}' } } }),
    JSON.stringify({ type: 'tool_use', timestamp: 2, part: { type: 'tool', tool: 'bash', state: { status: 'pending', input: { command: 'pnpm vitest' } } } }),
    JSON.stringify({ type: 'text', timestamp: 1, part: { type: 'text', text: 'Merging the lanes after the review passes.\n' } }),
    JSON.stringify({ type: 'step_finish', timestamp: 1, part: { type: 'step-finish', tokens: { input: 44665, output: 34, reason: 'tool-calls' }, cost: 0 } }),
  ];
  const out = ocLines.map(l => formatLogLine(l));
  const unesc = s => String(s ?? '').replace(/&quot;/g, '"');
  assert.equal(out[0], '');                       // step_start noise
  assert.match(unesc(strip(out[1])), /EXEC execute/);
  assert.match(unesc(strip(out[1])), /\{"items":\[\]\}/); // compact output shown
  assert.ok(strip(out[1]).length < 500, 'giant input compacted');
  assert.match(strip(out[2]), /\(running\)/);      // pending input too
  assert.match(strip(out[3]), /^Merging the lanes/);
  assert.match(strip(out[4]), /44665/);
});

test('bare claude tool_use still renders; opencode part forms take priority', () => {
  const bare = JSON.stringify({ type: 'tool_use', name: 'Read', input: { file: 'a.ts' } });
  assert.match(strip(formatLogLine(bare)), /Read/);
});

test('logfmt harness lines: INFO hidden, WARN kept', () => {
  const info = 'timestamp=2026-11-07T11:39:11.478Z level=INFO run=4ac52d0f message=event event.type=config.updated';
  const warn = 'timestamp=2026-11-07T11:39:11.478Z level=ERROR run=4ac52d0f message=db connection failed';
  assert.equal(formatLogLine(info), '');
  assert.match(strip(formatLogLine(warn)), /message=db connection failed|level=ERROR/);
});
