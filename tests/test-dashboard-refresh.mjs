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
