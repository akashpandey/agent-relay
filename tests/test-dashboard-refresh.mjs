import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const serverSource = fs.readFileSync(new URL('../dashboard/server.js', import.meta.url), 'utf8');
const appSource = fs.readFileSync(new URL('../dashboard/public/app.js', import.meta.url), 'utf8');

test('dashboard batches every changed log without postponing updates during continuous output', () => {
  let watch;
  const timers = [];
  const intervals = [];
  const synced = [];
  let broadcasts = 0;
  vm.runInNewContext(serverSource.slice(serverSource.indexOf('let debounceTimer = null;'),
    serverSource.indexOf('setTimeout(() => {\n  try {\n    let changed = false;')), {
    fs: { watch: (_dir, callback) => { watch = callback; } },
    LOGS_DIR: '/logs',
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout: () => assert.fail('continuous output must not reset the flush timer'),
    setInterval: (callback, delay) => intervals.push({ callback, delay }),
    syncLogFile: filename => synced.push(filename),
    broadcastDashboardUpdate: () => { broadcasts++; },
    console,
  });
  watch('change', 'first.log');
  watch('change', 'second.log');
  watch('change', 'first.log');
  watch('rename', 'second.done');
  assert.equal(timers.length, 1);
  timers[0]();
  assert.deepEqual(synced, ['first.log', 'second.log']);
  assert.equal(broadcasts, 1);
  watch('change', 'third.log');
  timers[1]();
  assert.deepEqual(synced, ['first.log', 'second.log', 'third.log']);
  assert.equal(intervals[0].delay, 15000);
  intervals[0].callback();
  assert.equal(broadcasts, 3, 'idle clients and direct DB updates receive periodic updates');
});

test('dashboard catches up on reconnect and polls while the event stream is disconnected', () => {
  let stream;
  let poll;
  const calls = [];
  class EventSource {
    static OPEN = 1;
    constructor() { stream = this; this.readyState = 0; }
  }
  const context = {
    EventSource,
    el: { liveIndicator: {} },
    setInterval: callback => { poll = callback; },
  };
  for (const name of ['fetchStats', 'fetchAnalytics', 'fetchRuns', 'fetchWorkspaces', 'scheduleModalMetadataRefresh']) {
    context[name] = () => calls.push(name);
  }
  vm.runInNewContext(appSource.slice(appSource.indexOf('function initSSE()'),
    appSource.indexOf('function scheduleDashboardRefresh()')) + '\ninitSSE();', context);
  const refreshCalls = Object.keys(context).filter(name => name.startsWith('fetch') || name === 'scheduleModalMetadataRefresh');
  stream.readyState = EventSource.OPEN;
  stream.onopen();
  assert.deepEqual(calls, refreshCalls);
  calls.length = 0;
  poll();
  assert.deepEqual(calls, []);
  stream.readyState = 0;
  stream.onerror();
  poll();
  assert.deepEqual(calls, refreshCalls);
  assert.match(context.el.liveIndicator.innerHTML, /Reconnecting/);
});

function extractAppFn(name) {
  const marker = `function ${name}(`;
  const start = appSource.indexOf(marker);
  assert.ok(start >= 0, `not found in app.js: ${name}`);
  const rest = appSource.slice(start);
  const next = rest.slice(1).match(/^function [a-zA-Z_$]+|^const [a-zA-Z_$]+|^let [a-zA-Z_$]+/m);
  return next ? rest.slice(0, next.index + 1) : rest;
}

test('formatLogLine and appendLogChunk cap oversized lines, drop broken initial slices, and filter noise', () => {
  const ansiFg = (appSource.match(/^const ANSI_FG = \{[^}]+\}/m) || [])[0];
  assert.ok(ansiFg, 'ANSI_FG must exist in app.js');

  const state = {
    logViewMode: 'live',
    rawLogLines: [],
    formattedLogLines: [],
    logPartialLine: '',
    logStartOffset: 100,
    logTruncatedLines: 0,
  };
  const script = [
    'const MAX_TERMINAL_LINES = 2000;',
    'const MAX_RAW_LINE_CHARS = 4096;',
    ansiFg,
    extractAppFn('ansiToHtml'),
    extractAppFn('streamBadge'),
    extractAppFn('dimText'),
    extractAppFn('clipEscaped'),
    extractAppFn('formatCodexItem'),
    extractAppFn('formatClaudeBlocks'),
    extractAppFn('formatLogLine'),
    extractAppFn('escapeHtml'),
    extractAppFn('formatNumber'),
    extractAppFn('capRawLogLine'),
    extractAppFn('appendLogChunk'),
    'return { formatLogLine, appendLogChunk };',
  ].join('\n');

  const { formatLogLine, appendLogChunk } = new Function('state', 'TextEncoder', script)(state, TextEncoder);

  // Oversized raw non-JSON line should be truncated with marker
  const rawFormatted = formatLogLine('x'.repeat(10000));
  assert.ok(rawFormatted.length < 2200, `rawFormatted length was ${rawFormatted.length}`);
  assert.match(rawFormatted, /\+8,000 chars/);

  // Oversized structured prose should be truncated with marker
  const bigProse = JSON.stringify({ type: 'text', part: { text: 'y'.repeat(10000) } });
  const proseFormatted = formatLogLine(bigProse);
  assert.ok(proseFormatted.length < 4300, `proseFormatted length was ${proseFormatted.length}`);
  assert.match(proseFormatted, /\+6,000 chars/);

  // Initial tail slice starting mid-line drops broken prefix, skips noise lines, caps stored raw lines
  const chunk =
    'broken-mid-line-fragment"}\n' +
    JSON.stringify({ type: 'step_start' }) + '\n' +
    JSON.stringify({ type: 'text', part: { text: 'visible line' } }) + '\n' +
    'z'.repeat(8000) + '\n';

  appendLogChunk(chunk, true, true);

  assert.equal(state.logStartOffset, 100 + Buffer.byteLength('broken-mid-line-fragment"}\n'));
  assert.equal(state.rawLogLines.length, 2, 'broken prefix and step_start noise should not be stored');
  assert.equal(state.formattedLogLines.length, 2);
  assert.ok(state.rawLogLines[1].length < 4200, 'raw stored line must be capped at MAX_RAW_LINE_CHARS');
  assert.ok(state.formattedLogLines[1].length < 2200, 'formatted line must be capped');
});

test('closeWorkspaceModal releases buffers, timers, stream, and modal DOM nodes', () => {
  let streamClosed = false;
  let clearedTimeoutId = null;
  let clearedIntervalId = null;
  const state = {
    selectedRun: 'run.log',
    activeRunData: { filename: 'run.log', toolCalls: [1, 2, 3] },
    filteredToolCalls: [1, 2],
    lastModalHeavySig: 'sig',
    dirtyModalTabs: new Set(),
    rawLogLines: ['a', 'b'],
    formattedLogLines: ['<span>a</span>', '<span>b</span>'],
    logPartialLine: 'c',
    logStartOffset: 500,
    logTotalBytes: 1000,
    logTruncatedLines: 10,
    modalPollInterval: 101,
    modalRefreshTimer: 202,
    activeLogStream: { close: () => { streamClosed = true; } },
  };
  const removedClasses = [];
  const el = {
    workspaceModalOverlay: { classList: { remove: c => removedClasses.push(['overlay', c]) } },
    workspaceModal: { classList: { remove: c => removedClasses.push(['modal', c]) } },
    modalTerminalContent: { textContent: 'huge terminal' },
    modalToolsContainer: { innerHTML: '<div>tools</div>' },
    modalMarkdownContainer: { innerHTML: '<p>md</p>' },
    modalDiffContainer: { innerHTML: '<pre>diff</pre>' },
    modalFilesChips: { innerHTML: '<span>file</span>' },
    modalRelayActions: { innerHTML: '<button>relay</button>' },
  };
  const script = [
    'let terminalRenderTimer = 303;',
    extractAppFn('closeWorkspaceModal'),
    'return { closeWorkspaceModal, getRenderTimer: () => terminalRenderTimer };',
  ].join('\n');

  const { closeWorkspaceModal, getRenderTimer } = new Function(
    'state',
    'el',
    'clearTimeout',
    'clearInterval',
    script
  )(
    state,
    el,
    id => { clearedTimeoutId = id; },
    id => { clearedIntervalId = id; }
  );

  closeWorkspaceModal();

  assert.equal(state.selectedRun, null);
  assert.equal(state.activeRunData, null);
  assert.deepEqual(state.filteredToolCalls, []);
  assert.deepEqual(state.rawLogLines, []);
  assert.deepEqual(state.formattedLogLines, []);
  assert.equal(state.logPartialLine, '');
  assert.equal(state.activeLogStream, null);
  assert.equal(streamClosed, true);
  assert.equal(getRenderTimer(), null);
  assert.equal(clearedTimeoutId, 202);
  assert.equal(clearedIntervalId, 101);
  assert.equal(el.modalTerminalContent.textContent, '');
  assert.equal(el.modalToolsContainer.innerHTML, '');
  assert.equal(el.modalMarkdownContainer.innerHTML, '');
  assert.equal(el.modalDiffContainer.innerHTML, '');
  assert.equal(el.modalFilesChips.innerHTML, '');
  assert.equal(el.modalRelayActions.innerHTML, '');
  assert.deepEqual(removedClasses, [['overlay', 'open'], ['modal', 'open']]);
});

test('stats_update ignores duplicate idle heartbeats and refreshes only on state transitions', () => {
  let stream;
  let dashRefreshes = 0;
  let wsRefreshes = 0;
  let modalRefreshes = 0;
  class EventSource {
    static OPEN = 1;
    constructor() { stream = this; this.readyState = 1; }
  }
  const state = {
    lastStatsSig: null,
    selectedRun: null,
    activeRunData: null,
  };
  const context = {
    EventSource,
    state,
    el: {
      liveIndicator: {},
      activeCount: {},
      todayCount: {},
      totalCount: {},
      activeBadge: {},
      kpiTokensVal: {},
      kpiDurationVal: {},
      kpiSuccessVal: {},
      attentionCount: {},
    },
    renderActiveCards: () => {},
    formatNumber: n => String(n),
    setInterval: () => {},
    fetchStats: () => {},
    fetchAnalytics: () => {},
    fetchRuns: () => {},
    fetchWorkspaces: () => {},
    scheduleDashboardRefresh: () => { dashRefreshes++; },
    scheduleWorkspaceRefresh: () => { wsRefreshes++; },
    scheduleModalMetadataRefresh: () => { modalRefreshes++; },
  };
  vm.runInNewContext(appSource.slice(appSource.indexOf('function initSSE()'),
    appSource.indexOf('function scheduleDashboardRefresh()')) + '\ninitSSE();', context);

  const idlePayload = JSON.stringify({
    type: 'stats_update',
    activeCount: 0,
    todayCount: 2,
    totalCount: 100,
    activeRuns: [],
    analytics: { totalTokens: 1000, avgDurationSec: 12, successRate: 98, attentionCount: 1 },
  });

  stream.onmessage({ data: idlePayload });
  stream.onmessage({ data: idlePayload });
  stream.onmessage({ data: idlePayload });

  assert.equal(dashRefreshes, 1, 'duplicate idle heartbeats must not rebuild runs table');
  assert.equal(wsRefreshes, 1, 'duplicate idle heartbeats must not rebuild workspace chips');
  assert.equal(modalRefreshes, 0);

  const activePayload = JSON.stringify({
    type: 'stats_update',
    activeCount: 1,
    todayCount: 3,
    totalCount: 101,
    activeRuns: [{ filename: '20261119T120000-codex-1.log', status: 'running' }],
    analytics: { totalTokens: 1000, avgDurationSec: 12, successRate: 98, attentionCount: 1 },
  });
  stream.onmessage({ data: activePayload });
  assert.equal(dashRefreshes, 2, 'state change must schedule dashboard refresh');
  assert.equal(wsRefreshes, 2, 'state change must schedule workspace refresh');
});
