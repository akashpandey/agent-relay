// Client application logic
let activeRuns = [];
let allRuns = [];
let danglingProcesses = [];
let totalRunsCount = 0;
let currentFilterProvider = 'all';
let currentFilterStatus = 'all';
let currentSearchQuery = '';
let currentPage = 0;
const pageSize = 50;

let currentStreamingFile = null;
let currentEventSource = null;
let fullLogBuffer = '';

// DOM Elements
const metricActiveCount = document.getElementById('metric-active-count');
const metricTodayCount = document.getElementById('metric-today-count');
const metricTotalCount = document.getElementById('metric-total-count');
const metricDanglingChip = document.getElementById('metric-dangling-chip');
const metricDanglingCount = document.getElementById('metric-dangling-count');
const btnKillAllDangling = document.getElementById('btn-kill-all-dangling');

const activeBadge = document.getElementById('active-badge');
const activeContainer = document.getElementById('active-container');
const historyTbody = document.getElementById('history-tbody');
const historyTotalBadge = document.getElementById('history-total-badge');
const paginationInfo = document.getElementById('pagination-info');
const btnPrevPage = document.getElementById('btn-prev-page');
const btnNextPage = document.getElementById('btn-next-page');
const filterSearch = document.getElementById('filter-search');
const btnRefresh = document.getElementById('btn-refresh');

// Drawer elements
const drawerOverlay = document.getElementById('drawer-overlay');
const logDrawer = document.getElementById('log-drawer');
const btnCloseDrawer = document.getElementById('btn-close-drawer');
const drawerFilename = document.getElementById('drawer-filename');
const drawerProvider = document.getElementById('drawer-provider');
const drawerStatusPill = document.getElementById('drawer-status-pill');
const drawerWorkspace = document.getElementById('drawer-workspace');
const drawerModel = document.getElementById('drawer-model');
const drawerPid = document.getElementById('drawer-pid');
const drawerStartTime = document.getElementById('drawer-start-time');
const drawerDuration = document.getElementById('drawer-duration');
const drawerBtnKill = document.getElementById('drawer-btn-kill');
const drawerTaskContent = document.getElementById('drawer-task-content');
const terminalContent = document.getElementById('terminal-content');
const logTerminal = document.getElementById('log-terminal');
const chkAutoscroll = document.getElementById('chk-autoscroll');
const logSearchInput = document.getElementById('log-search-input');
const logLinesCount = document.getElementById('log-lines-count');
const btnCopyPrompt = document.getElementById('btn-copy-prompt');
const btnCopyLog = document.getElementById('btn-copy-log');
const btnDownloadLog = document.getElementById('btn-download-log');

// Dangling Modal elements
const danglingModalOverlay = document.getElementById('dangling-modal-overlay');
const danglingModal = document.getElementById('dangling-modal');
const btnCloseDanglingModal = document.getElementById('btn-close-dangling-modal');
const btnDismissDangling = document.getElementById('btn-dismiss-dangling');
const danglingListContainer = document.getElementById('dangling-list-container');
const btnModalKillAll = document.getElementById('btn-modal-kill-all');

/**
 * ANSI Color / Control Sequence to HTML Converter
 */
function ansiToHtml(text) {
  if (!text) return '';
  
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const ansiMap = {
    '0': '</span>',
    '1': '<span style="font-weight:bold;">',
    '30': '<span style="color:#64748b;">',
    '31': '<span style="color:#f43f5e;">',
    '32': '<span style="color:#10b981;">',
    '33': '<span style="color:#f59e0b;">',
    '34': '<span style="color:#38bdf8;">',
    '35': '<span style="color:#c084fc;">',
    '36': '<span style="color:#2dd4bf;">',
    '37': '<span style="color:#f8fafc;">',
    '90': '<span style="color:#475569;">',
    '91': '<span style="color:#fb7185;">',
    '92': '<span style="color:#34d399;">',
    '93': '<span style="color:#fbbf24;">',
    '94': '<span style="color:#60a5fa;">',
    '95': '<span style="color:#e879f9;">',
    '96': '<span style="color:#5eead4;">',
    '97': '<span style="color:#ffffff;">',
  };

  html = html.replace(/\x1B\[([0-9;]+)m/g, (match, codeStr) => {
    const codes = codeStr.split(';');
    let tag = '';
    for (const code of codes) {
      if (ansiMap[code]) {
        tag += ansiMap[code];
      }
    }
    return tag;
  });

  html = html.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');

  return html;
}

/**
 * Format timestamp strictly in IST (Asia/Kolkata)
 */
function formatTimeIST(isoStr) {
  if (!isoStr) return 'N/A';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: true,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      day: '2-digit',
      month: 'short',
    }) + ' IST';
  } catch {
    return isoStr;
  }
}

/**
 * Fetch Stats & Initial Data
 */
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    
    metricActiveCount.textContent = data.activeCount;
    metricTodayCount.textContent = data.todayCount;
    metricTotalCount.textContent = data.totalCount;
    activeBadge.textContent = `${data.activeCount} Running`;
    historyTotalBadge.textContent = `${data.totalCount} Total`;

    danglingProcesses = data.danglingProcesses || [];
    if (data.danglingCount > 0) {
      metricDanglingChip.style.display = 'inline-flex';
      metricDanglingChip.className = 'metric-chip dangling-chip';
      metricDanglingCount.textContent = data.danglingCount;
    } else {
      metricDanglingChip.style.display = 'none';
      closeDanglingModal();
    }

    renderActiveSubagents(data.activeRuns || []);
    if (danglingModal.classList.contains('open')) {
      renderDanglingModal();
    }
  } catch (err) {
    console.error('Failed to fetch stats:', err);
  }
}

/**
 * Fetch Paginated Runs History
 */
async function fetchRuns() {
  try {
    const offset = currentPage * pageSize;
    let url = `/api/runs?limit=${pageSize}&offset=${offset}`;
    if (currentFilterProvider !== 'all') url += `&provider=${encodeURIComponent(currentFilterProvider)}`;
    if (currentFilterStatus !== 'all') url += `&status=${encodeURIComponent(currentFilterStatus)}`;
    if (currentSearchQuery) url += `&q=${encodeURIComponent(currentSearchQuery)}`;

    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();

    totalRunsCount = data.total;
    renderHistoryTable(data.runs);
    updatePagination();
  } catch (err) {
    console.error('Failed to fetch runs:', err);
  }
}

/**
 * Render Active Subagents Grid
 */
function renderActiveSubagents(runs) {
  activeRuns = runs;
  if (!runs || runs.length === 0) {
    activeContainer.innerHTML = `
      <div class="empty-active-state">
        <div class="radar-scan"></div>
        <div class="empty-active-text">
          <h3>No Active Subagent Calls</h3>
          <p>Whenever you run <code>opencode-subagent</code>, <code>antigravity-subagent</code>, <code>claude-subagent</code>, or <code>codex-subagent</code>, live progress will appear here automatically.</p>
        </div>
      </div>
    `;
    return;
  }

  activeContainer.innerHTML = runs.map(run => `
    <div class="active-card" data-filename="${run.filename}">
      <div class="active-card-top">
        <span class="provider-tag provider-${run.provider}">${run.provider}</span>
        <div class="time-ticker">
          <span class="pulse-dot"></span>
          <span class="elapsed-counter" data-start="${run.startTime}">${run.durationHuman}</span>
        </div>
      </div>

      <div class="active-card-title">
        <span class="ws-name" title="${run.workspace}">📁 ${run.workspaceName}</span>
        <span class="meta-sep">•</span>
        <span class="model-name">🤖 ${run.model}</span>
      </div>

      <div class="active-task-preview" title="${escapeHtml(run.fullTask || run.task)}">
        ${escapeHtml(run.task)}
      </div>

      <div class="active-action-bar">
        <div class="spinner"></div>
        <span class="action-text">${escapeHtml(run.currentAction || 'Running...')}</span>
      </div>

      <div class="active-card-footer">
        <span class="pid-pill">PID: ${run.pid}</span>
        <div style="display: flex; gap: 0.5rem;">
          <button class="btn btn-sm btn-danger" onclick="terminateSubagent(${run.pid}, event)">Stop</button>
          <button class="btn btn-sm btn-primary" onclick="openLogDrawer('${run.filename}')">Live Stream</button>
        </div>
      </div>
    </div>
  `).join('');
}

/**
 * Render Runs History Table
 */
function renderHistoryTable(runs) {
  if (!runs || runs.length === 0) {
    historyTbody.innerHTML = `
      <tr>
        <td colspan="7" class="table-loading">No matching subagent logs found.</td>
      </tr>
    `;
    return;
  }

  historyTbody.innerHTML = runs.map(run => {
    let statusClass = 'completed';
    if (run.isAlive) statusClass = 'running';
    else if (run.status === 'failed') statusClass = 'failed';

    const displayTask = run.task && run.task !== 'No task prompt specified' ? run.task : (run.workspaceName ? `Task in ${run.workspaceName}` : 'Subagent execution');

    return `
      <tr onclick="openLogDrawer('${run.filename}')" style="cursor: pointer;">
        <td>
          <span class="status-dot ${statusClass}"></span>
          <span style="color: var(--text-dim); font-size: 0.75rem;">${formatTimeIST(run.startTime)}</span>
        </td>
        <td>
          <span class="provider-tag provider-${run.provider}">${run.provider}</span>
          <div style="font-size: 0.72rem; color: var(--text-dim); margin-top: 2px;">${escapeHtml(run.model)}</div>
        </td>
        <td>
          <div class="table-ws-text" title="${run.workspace}">${escapeHtml(run.workspaceName)}</div>
        </td>
        <td>
          <div class="table-task-text" title="${escapeHtml(run.fullTask || displayTask)}">${escapeHtml(displayTask)}</div>
        </td>
        <td style="font-family: var(--font-mono); font-size: 0.75rem;">${run.durationHuman}</td>
        <td style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-dim);">${run.fileSizeHuman}</td>
        <td style="text-align: right;">
          <div style="display: inline-flex; gap: 0.35rem;">
            ${run.isAlive ? `<button class="btn btn-sm btn-danger" onclick="event.stopPropagation(); terminateSubagent(${run.pid}, event)">Stop</button>` : ''}
            <button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); openLogDrawer('${run.filename}')">View</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function updatePagination() {
  const start = totalRunsCount === 0 ? 0 : currentPage * pageSize + 1;
  const end = Math.min((currentPage + 1) * pageSize, totalRunsCount);
  paginationInfo.textContent = `Showing ${start} - ${end} of ${totalRunsCount} runs`;
  btnPrevPage.disabled = currentPage === 0;
  btnNextPage.disabled = (currentPage + 1) * pageSize >= totalRunsCount;
}

/**
 * Open Slide-over Log Viewer Drawer
 */
async function openLogDrawer(filename) {
  currentStreamingFile = filename;
  drawerOverlay.classList.add('open');
  logDrawer.classList.add('open');

  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(filename)}`);
    if (res.ok) {
      const meta = await res.json();
      drawerFilename.textContent = meta.filename;
      drawerProvider.textContent = meta.provider;
      drawerProvider.className = `provider-tag provider-${meta.provider}`;
      drawerStatusPill.textContent = meta.isAlive ? 'Running' : (meta.status === 'failed' ? 'Failed' : 'Completed');
      drawerStatusPill.className = `status-pill ${meta.isAlive ? 'running' : (meta.status === 'failed' ? 'failed' : 'completed')}`;
      drawerWorkspace.textContent = `📁 ${meta.workspace}`;
      drawerModel.textContent = `🤖 ${meta.model}`;
      drawerPid.textContent = `PID: ${meta.pid}`;
      drawerStartTime.textContent = `🕒 ${formatTimeIST(meta.startTime)}`;
      drawerDuration.textContent = `⏱️ ${meta.durationHuman}`;
      drawerTaskContent.textContent = meta.fullTask || meta.task || 'No task prompt captured.';
      
      btnDownloadLog.href = `/api/logs/${encodeURIComponent(filename)}`;
      btnDownloadLog.setAttribute('download', filename);

      if (meta.isAlive) {
        drawerBtnKill.style.display = 'inline-flex';
        drawerBtnKill.onclick = () => terminateSubagent(meta.pid);
      } else {
        drawerBtnKill.style.display = 'none';
      }

      btnCopyPrompt.onclick = () => {
        navigator.clipboard.writeText(meta.fullTask || meta.task || '');
        btnCopyPrompt.textContent = 'Copied!';
        setTimeout(() => { btnCopyPrompt.textContent = 'Copy Prompt'; }, 1500);
      };
    }
  } catch (err) {
    console.error(err);
  }

  startStreaming(filename);
}

function closeLogDrawer() {
  drawerOverlay.classList.remove('open');
  logDrawer.classList.remove('open');
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
  currentStreamingFile = null;
}

/**
 * Dangling Processes Modal Handlers
 */
function openDanglingModal() {
  renderDanglingModal();
  danglingModalOverlay.classList.add('open');
  danglingModal.classList.add('open');
}

function closeDanglingModal() {
  danglingModalOverlay.classList.remove('open');
  danglingModal.classList.remove('open');
}

function renderDanglingModal() {
  if (!danglingProcesses || danglingProcesses.length === 0) {
    danglingListContainer.innerHTML = `<div style="text-align:center; color: var(--text-dim); padding: 1rem;">No dangling processes found.</div>`;
    return;
  }

  danglingListContainer.innerHTML = danglingProcesses.map(p => `
    <div class="dangling-item">
      <div class="dangling-item-info">
        <span class="dangling-item-pid">PID ${p.pid}</span>
        <span class="dangling-item-cmd" title="${escapeHtml(p.cmd)}">${escapeHtml(p.cmd)}</span>
      </div>
      <button class="btn btn-sm btn-danger" onclick="terminateSubagent(${p.pid})">Kill</button>
    </div>
  `).join('');
}

metricDanglingChip.addEventListener('click', (e) => {
  if (e.target.id !== 'btn-kill-all-dangling') {
    openDanglingModal();
  }
});

btnCloseDanglingModal.addEventListener('click', closeDanglingModal);
btnDismissDangling.addEventListener('click', closeDanglingModal);
danglingModalOverlay.addEventListener('click', closeDanglingModal);

btnModalKillAll.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to terminate all dangling subagent processes?')) return;
  try {
    const res = await fetch('/api/kill-dangling', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert(`Successfully terminated ${data.killedCount} dangling process(es).`);
      fetchStats();
      fetchRuns();
      closeDanglingModal();
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

/**
 * Stream Log Content via SSE
 */
function startStreaming(filename) {
  if (currentEventSource) {
    currentEventSource.close();
  }

  terminalContent.innerHTML = 'Connecting to log stream...';
  fullLogBuffer = '';

  currentEventSource = new EventSource(`/api/logs/${encodeURIComponent(filename)}/stream`);

  currentEventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.chunk) {
        fullLogBuffer += data.chunk;
        renderTerminal();
      }
    } catch (e) {
      console.error('Error parsing SSE data:', e);
    }
  };
}

function renderTerminal() {
  const filter = logSearchInput.value.toLowerCase();
  let textToRender = fullLogBuffer;

  if (filter) {
    const lines = fullLogBuffer.split('\n');
    const filteredLines = lines.filter(l => l.toLowerCase().includes(filter));
    textToRender = filteredLines.join('\n');
    logLinesCount.textContent = `${filteredLines.length} / ${lines.length} lines`;
  } else {
    const lineCount = (fullLogBuffer.match(/\n/g) || []).length + 1;
    logLinesCount.textContent = `${lineCount} lines`;
  }

  terminalContent.innerHTML = ansiToHtml(textToRender);

  if (chkAutoscroll.checked) {
    logTerminal.scrollTop = logTerminal.scrollHeight;
  }
}

btnCopyLog.onclick = () => {
  navigator.clipboard.writeText(fullLogBuffer);
  btnCopyLog.textContent = 'Copied!';
  setTimeout(() => { btnCopyLog.textContent = 'Copy Log'; }, 1500);
};

logSearchInput.addEventListener('input', renderTerminal);

/**
 * Terminate Subagent / Process
 */
window.terminateSubagent = async function(pid, e) {
  if (e) e.stopPropagation();
  if (!confirm(`Are you sure you want to terminate subagent process tree (PID ${pid})?`)) return;

  try {
    const res = await fetch(`/api/runs/${pid}/kill`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      fetchStats();
      fetchRuns();
      if (currentStreamingFile) {
        openLogDrawer(currentStreamingFile);
      }
    } else {
      alert(`Error: ${data.error}`);
    }
  } catch (err) {
    alert(`Failed to kill process: ${err.message}`);
  }
};

/**
 * Kill all dangling subagent processes from header button
 */
btnKillAllDangling.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!confirm('Are you sure you want to terminate all dangling subagent processes?')) return;
  try {
    const res = await fetch('/api/kill-dangling', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      alert(`Successfully terminated ${data.killedCount} dangling process(es).`);
      fetchStats();
      fetchRuns();
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

window.openLogDrawer = openLogDrawer;

/**
 * Connect to Global SSE for Real-Time Updates
 */
function connectGlobalEvents() {
  const evtSource = new EventSource('/api/events');
  const liveIndicator = document.getElementById('live-indicator');

  evtSource.onopen = () => {
    liveIndicator.style.opacity = '1';
  };

  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'stats_update') {
        metricActiveCount.textContent = data.activeCount;
        metricTodayCount.textContent = data.todayCount;
        metricTotalCount.textContent = data.totalCount;
        activeBadge.textContent = `${data.activeCount} Running`;
        historyTotalBadge.textContent = `${data.totalCount} Total`;
        renderActiveSubagents(data.activeRuns || []);
        fetchStats();
      }
    } catch (e) {}
  };

  evtSource.onerror = () => {
    liveIndicator.style.opacity = '0.5';
    evtSource.close();
    setTimeout(connectGlobalEvents, 3000);
  };
}

// Helper escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Event Listeners
drawerOverlay.addEventListener('click', closeLogDrawer);
btnCloseDrawer.addEventListener('click', closeLogDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (danglingModal.classList.contains('open')) closeDanglingModal();
    if (logDrawer.classList.contains('open')) closeLogDrawer();
  }
});

btnRefresh.addEventListener('click', () => {
  fetchStats();
  fetchRuns();
});

// Search input with debounce
let searchDebounce = null;
filterSearch.addEventListener('input', (e) => {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    currentSearchQuery = e.target.value.trim();
    currentPage = 0;
    fetchRuns();
  }, 250);
});

// Provider segmented buttons
document.querySelectorAll('#provider-filters .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#provider-filters .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilterProvider = btn.dataset.provider;
    currentPage = 0;
    fetchRuns();
  });
});

// Status segmented buttons
document.querySelectorAll('#status-filters .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#status-filters .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilterStatus = btn.dataset.status;
    currentPage = 0;
    fetchRuns();
  });
});

// Pagination buttons
btnPrevPage.addEventListener('click', () => {
  if (currentPage > 0) {
    currentPage--;
    fetchRuns();
  }
});

btnNextPage.addEventListener('click', () => {
  if ((currentPage + 1) * pageSize < totalRunsCount) {
    currentPage++;
    fetchRuns();
  }
});

// Initial boot
fetchStats();
fetchRuns();
connectGlobalEvents();
