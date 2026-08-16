/**
 * Subagents Monitor - Client Application
 * Features: Full-Page Modal Workspace, Real-time SSE streaming, Multi-theme support,
 * Markdown & Diff viewer, Sound & Desktop notifications, Keyboard shortcuts, Workspace filtering, Analytics.
 */

// --- Application State ---
const state = {
  activeRuns: [],
  historyRuns: [],
  workspaces: [],
  analytics: null,
  danglingProcesses: [],
  selectedRun: null,
  selectedRowIndex: -1,
  
  // Filters & Pagination
  filterProvider: 'all',
  filterStatus: 'all',
  filterWorkspace: 'all',
  filterSearch: '',
  pageLimit: 30,
  pageOffset: 0,
  totalRuns: 0,

  // Settings
  theme: localStorage.getItem('subagent_theme') || 'midnight',
  density: localStorage.getItem('subagent_density') || 'comfortable',
  notificationsEnabled: localStorage.getItem('subagent_notif') === 'true',
  activeModalTab: 'terminal',
  isFullscreen: false,
  
  // Terminal
  activeLogStream: null,
  rawLogLines: [],
  filterLogQuery: '',
  autoscroll: true,
  wordWrap: true,
};

// --- DOM Elements ---
const el = {
  // Navigation & Metrics
  activeCount: document.getElementById('metric-active-count'),
  danglingChip: document.getElementById('metric-dangling-chip'),
  danglingCount: document.getElementById('metric-dangling-count'),
  btnKillAllDangling: document.getElementById('btn-kill-all-dangling'),
  todayCount: document.getElementById('metric-today-count'),
  totalCount: document.getElementById('metric-total-count'),
  themeSelector: document.getElementById('theme-selector'),
  btnToggleNotif: document.getElementById('btn-toggle-notif'),
  iconNotifOff: document.getElementById('icon-notif-off'),
  iconNotifOn: document.getElementById('icon-notif-on'),
  btnShortcuts: document.getElementById('btn-shortcuts'),
  btnRefresh: document.getElementById('btn-refresh'),
  liveIndicator: document.getElementById('live-indicator'),

  // KPI Analytics
  kpiActiveVal: document.getElementById('kpi-active-val'),
  kpiActiveSub: document.getElementById('kpi-active-sub'),
  kpiTokensVal: document.getElementById('kpi-tokens-val'),
  kpiTokensSub: document.getElementById('kpi-tokens-sub'),
  kpiDurationVal: document.getElementById('kpi-duration-val'),
  kpiDurationSub: document.getElementById('kpi-duration-sub'),
  kpiSuccessVal: document.getElementById('kpi-success-val'),
  kpiSuccessSub: document.getElementById('kpi-success-sub'),

  // Sections
  activeBadge: document.getElementById('active-badge'),
  activeContainer: document.getElementById('active-container'),
  historyTotalBadge: document.getElementById('history-total-badge'),
  filterSearch: document.getElementById('filter-search'),
  providerFilters: document.getElementById('provider-filters'),
  statusFilters: document.getElementById('status-filters'),
  workspaceChipsContainer: document.getElementById('workspace-chips-container'),
  btnDensityComfortable: document.getElementById('btn-density-comfortable'),
  btnDensityCompact: document.getElementById('btn-density-compact'),
  historyTable: document.getElementById('history-table'),
  historyTbody: document.getElementById('history-tbody'),
  paginationInfo: document.getElementById('pagination-info'),
  btnPrevPage: document.getElementById('btn-prev-page'),
  btnNextPage: document.getElementById('btn-next-page'),

  // Full-Page Workspace Modal
  workspaceModalOverlay: document.getElementById('workspace-modal-overlay'),
  workspaceModal: document.getElementById('workspace-modal'),
  modalProvider: document.getElementById('modal-provider'),
  modalFilename: document.getElementById('modal-filename'),
  modalStatusPill: document.getElementById('modal-status-pill'),
  modalWorkspace: document.getElementById('modal-workspace'),
  modalModel: document.getElementById('modal-model'),
  modalPid: document.getElementById('modal-pid'),
  modalStartTime: document.getElementById('modal-start-time'),
  modalDuration: document.getElementById('modal-duration'),
  modalBtnKill: document.getElementById('modal-btn-kill'),
  btnModalCopyCli: document.getElementById('btn-modal-copy-cli'),
  btnModalCopyPrompt: document.getElementById('btn-modal-copy-prompt'),
  btnModalCopyLog: document.getElementById('btn-modal-copy-log'),
  btnModalDownloadLog: document.getElementById('btn-modal-download-log'),
  btnToggleFullscreen: document.getElementById('btn-toggle-fullscreen'),
  btnCloseWorkspaceModal: document.getElementById('btn-close-workspace-modal'),

  // Left Sidebar
  modalTaskContent: document.getElementById('modal-task-content'),
  btnTaskCopySmall: document.getElementById('btn-task-copy-small'),
  miniTokensInput: document.getElementById('mini-tokens-input'),
  miniTokensOutput: document.getElementById('mini-tokens-output'),
  miniTokensReasoning: document.getElementById('mini-tokens-reasoning'),
  miniTokensCache: document.getElementById('mini-tokens-cache'),
  miniTokensTotal: document.getElementById('mini-tokens-total'),
  miniCost: document.getElementById('mini-cost'),
  modalFilesCount: document.getElementById('modal-files-count'),
  modalFilesChips: document.getElementById('modal-files-chips'),
  modalCliCode: document.getElementById('modal-cli-code'),
  btnCliCopySmall: document.getElementById('btn-cli-copy-small'),

  // Right Viewport Tabs
  fsTabs: document.querySelectorAll('.fs-tab'),
  fsTabPanes: document.querySelectorAll('.fs-tab-pane'),
  tabModalToolsCount: document.getElementById('tab-modal-tools-count'),
  tabModalDiffsCount: document.getElementById('tab-modal-diffs-count'),
  streamStatusBadge: document.getElementById('stream-status-badge'),
  chkAutoscroll: document.getElementById('chk-autoscroll'),
  chkWrap: document.getElementById('chk-wrap'),
  logSearchInput: document.getElementById('log-search-input'),
  logLinesCount: document.getElementById('log-lines-count'),
  modalTerminalBox: document.getElementById('modal-terminal-box'),
  modalTerminalContent: document.getElementById('modal-terminal-content'),
  modalToolsContainer: document.getElementById('modal-tools-container'),
  toolsFilterPills: document.getElementById('tools-filter-pills'),
  toolSearchInput: document.getElementById('tool-search-input'),
  countToolsAll: document.getElementById('count-tools-all'),
  countToolsCmd: document.getElementById('count-tools-cmd'),
  countToolsEdit: document.getElementById('count-tools-edit'),
  countToolsRead: document.getElementById('count-tools-read'),
  countToolsGrep: document.getElementById('count-tools-grep'),
  modalMarkdownContainer: document.getElementById('modal-markdown-container'),
  modalDiffContainer: document.getElementById('modal-diff-container'),

  // Modals
  shortcutsModalOverlay: document.getElementById('shortcuts-modal-overlay'),
  shortcutsModal: document.getElementById('shortcuts-modal'),
  btnCloseShortcutsModal: document.getElementById('btn-close-shortcuts-modal'),
  btnDismissShortcuts: document.getElementById('btn-dismiss-shortcuts'),

  danglingModalOverlay: document.getElementById('dangling-modal-overlay'),
  danglingModal: document.getElementById('dangling-modal'),
  btnCloseDanglingModal: document.getElementById('btn-close-dangling-modal'),
  btnDismissDangling: document.getElementById('btn-dismiss-dangling'),
  btnModalKillAll: document.getElementById('btn-modal-kill-all'),
  danglingListContainer: document.getElementById('dangling-list-container'),
};

// --- Web Audio API Synth Chimes ---
let audioCtx = null;
function playChime(type = 'success') {
  if (!state.notificationsEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (type === 'success') {
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.setValueAtTime(880, now + 0.1); // A5
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else {
      osc.frequency.setValueAtTime(329.63, now); // E4
      osc.frequency.setValueAtTime(220, now + 0.15); // A3
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    }
  } catch {}
}

function sendDesktopNotification(title, body) {
  if (!state.notificationsEnabled) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.svg' });
  }
}

// --- Theme & Density Management ---
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  if (el.themeSelector) el.themeSelector.value = theme;
  localStorage.setItem('subagent_theme', theme);
}

function applyDensity(density) {
  state.density = density;
  localStorage.setItem('subagent_density', density);
  if (density === 'compact') {
    el.historyTable.classList.add('compact-mode');
    el.btnDensityCompact.classList.add('active');
    el.btnDensityComfortable.classList.remove('active');
  } else {
    el.historyTable.classList.remove('compact-mode');
    el.btnDensityComfortable.classList.add('active');
    el.btnDensityCompact.classList.remove('active');
  }
}

// --- API Calls ---
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const data = await res.json();

    el.activeCount.textContent = data.activeCount || 0;
    el.todayCount.textContent = data.todayCount || 0;
    el.totalCount.textContent = data.totalCount || 0;
    el.activeBadge.textContent = `${data.activeCount || 0} Running`;

    if (data.danglingCount > 0) {
      el.danglingChip.style.display = 'flex';
      el.danglingCount.textContent = data.danglingCount;
      state.danglingProcesses = data.danglingProcesses || [];
    } else {
      el.danglingChip.style.display = 'none';
      state.danglingProcesses = [];
    }

    renderActiveCards(data.activeRuns || []);
  } catch (err) {
    console.error('Failed to fetch stats:', err);
  }
}

async function fetchAnalytics() {
  try {
    const res = await fetch('/api/analytics');
    if (!res.ok) return;
    const data = await res.json();
    state.analytics = data;

    el.kpiActiveVal.textContent = state.activeRuns.length;
    el.kpiActiveSub = `${state.activeRuns.length} tasks executing`;
    el.kpiTokensVal.textContent = formatNumber(data.totalTokens || 0);
    el.kpiDurationVal.textContent = `${data.avgDurationSec || 0}s`;
    el.kpiSuccessVal.textContent = `${data.successRate || 100}%`;
  } catch (err) {
    console.error('Failed to fetch analytics:', err);
  }
}

async function fetchWorkspaces() {
  try {
    const res = await fetch('/api/workspaces');
    if (!res.ok) return;
    const data = await res.json();
    state.workspaces = data.workspaces || [];
    renderWorkspaceChips();
  } catch (err) {
    console.error('Failed to fetch workspaces:', err);
  }
}

async function fetchRuns() {
  try {
    const params = new URLSearchParams({
      provider: state.filterProvider,
      status: state.filterStatus,
      workspace: state.filterWorkspace,
      q: state.filterSearch,
      limit: state.pageLimit,
      offset: state.pageOffset,
    });

    const res = await fetch(`/api/runs?${params.toString()}`);
    if (!res.ok) return;
    const data = await res.json();

    state.historyRuns = data.runs || [];
    state.totalRuns = data.total || 0;

    renderHistoryTable();
    updatePagination();
  } catch (err) {
    console.error('Failed to fetch runs:', err);
  }
}

// --- Rendering Functions ---

function renderWorkspaceChips() {
  el.workspaceChipsContainer.innerHTML = '';
  
  const allBtn = document.createElement('button');
  allBtn.className = `workspace-chip ${state.filterWorkspace === 'all' ? 'active' : ''}`;
  allBtn.textContent = 'All Workspaces';
  allBtn.addEventListener('click', () => {
    state.filterWorkspace = 'all';
    state.pageOffset = 0;
    renderWorkspaceChips();
    fetchRuns();
  });
  el.workspaceChipsContainer.appendChild(allBtn);

  for (const ws of state.workspaces) {
    if (ws.path === 'Unknown') continue;
    const chip = document.createElement('button');
    chip.className = `workspace-chip ${state.filterWorkspace === ws.path ? 'active' : ''}`;
    
    let activePulse = ws.activeRuns > 0 ? '<span class="pulse-dot" style="margin-right: 4px;"></span>' : '';
    chip.innerHTML = `${activePulse}📁 ${escapeHtml(ws.name)} <span class="chip-count">${ws.totalRuns}</span>`;
    
    chip.addEventListener('click', () => {
      state.filterWorkspace = ws.path;
      state.pageOffset = 0;
      renderWorkspaceChips();
      fetchRuns();
    });
    el.workspaceChipsContainer.appendChild(chip);
  }
}

function renderActiveCards(activeRuns) {
  const prevActiveCount = state.activeRuns.length;
  state.activeRuns = activeRuns;

  if (activeRuns.length > prevActiveCount && prevActiveCount === 0) {
    // New run started
  } else if (activeRuns.length < prevActiveCount) {
    // A run completed
    playChime('success');
    sendDesktopNotification('Subagent Completed', 'A local LLM subagent run finished execution.');
  }

  el.activeContainer.innerHTML = '';

  if (activeRuns.length === 0) {
    el.activeContainer.innerHTML = `
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

  for (const run of activeRuns) {
    const card = document.createElement('div');
    card.className = 'active-card';

    const providerClass = `provider-${run.provider.toLowerCase()}`;
    const workspaceName = run.workspaceName || run.workspace || 'workspace';

    card.innerHTML = `
      <div class="active-card-top">
        <div class="card-provider-group">
          <span class="provider-pill ${providerClass}">${escapeHtml(run.provider)}</span>
          <span class="model-badge">${escapeHtml(run.model)}</span>
        </div>
        <span class="active-clock" data-start="${run.startTime}">⏱️ ${run.durationHuman}</span>
      </div>

      <div class="active-workspace">
        <span>📁</span>
        <strong>${escapeHtml(workspaceName)}</strong>
        <span style="color: var(--text-dim); font-size: 0.75rem;">(PID: ${run.pid})</span>
      </div>

      <div class="active-prompt-preview">
        ${escapeHtml(run.task || 'Executing subagent instructions...')}
      </div>

      <div class="active-action-row">
        <span>⚡</span>
        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(run.currentAction || 'Running...')}</span>
      </div>

      <div class="active-card-actions">
        <button class="btn btn-sm btn-secondary btn-card-cli" title="Copy CLI Command">Copy CLI</button>
        <button class="btn btn-sm btn-danger btn-card-kill">Stop</button>
        <button class="btn btn-sm btn-secondary btn-card-view">Inspect Run</button>
      </div>
    `;

    card.querySelector('.btn-card-view').addEventListener('click', () => openWorkspaceModal(run.filename));
    card.querySelector('.btn-card-cli').addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(run.cliCommand || `opencode-subagent "${run.task || ''}"`, 'CLI command copied!');
    });
    card.querySelector('.btn-card-kill').addEventListener('click', (e) => {
      e.stopPropagation();
      killProcess(run.pid, run.filename);
    });

    el.activeContainer.appendChild(card);
  }
}

function renderHistoryTable() {
  el.historyTbody.innerHTML = '';
  el.historyTotalBadge.textContent = `${state.totalRuns} Total`;

  if (state.historyRuns.length === 0) {
    el.historyTbody.innerHTML = `
      <tr>
        <td colspan="7" class="table-empty" style="text-align: center; padding: 2.5rem; color: var(--text-muted);">
          No matching subagent runs found.
        </td>
      </tr>
    `;
    return;
  }

  state.historyRuns.forEach((run, idx) => {
    const tr = document.createElement('tr');
    if (idx === state.selectedRowIndex) tr.classList.add('selected-row');

    const providerClass = `provider-${run.provider.toLowerCase()}`;
    const statusClass = `status-${run.status.toLowerCase()}`;
    const workspaceName = run.workspaceName || run.workspace || 'workspace';

    const tokenDisplay = run.tokens && run.tokens.total ? `${formatNumber(run.tokens.total)} tok` : run.fileSizeHuman;

    tr.innerHTML = `
      <td>
        <div style="display: flex; flex-direction: column; gap: 0.2rem;">
          <span style="font-family: var(--font-mono); font-size: 0.75rem;">${formatISTTime(run.startTimeIST || run.startTime)}</span>
          <div><span class="status-pill ${statusClass}">${escapeHtml(run.status)}</span></div>
        </div>
      </td>
      <td>
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          <span class="provider-pill ${providerClass}" style="align-self: flex-start;">${escapeHtml(run.provider)}</span>
          <span class="model-badge" style="font-size: 0.7rem;">${escapeHtml(run.model)}</span>
        </div>
      </td>
      <td>
        <div style="display: flex; flex-direction: column;">
          <strong style="color: var(--text-main); font-size: 0.8rem;">📁 ${escapeHtml(workspaceName)}</strong>
          <span style="color: var(--text-dim); font-size: 0.7rem;">PID: ${run.pid}</span>
        </div>
      </td>
      <td>
        <div class="task-preview-cell" title="${escapeHtml(run.fullTask || run.task)}">
          ${escapeHtml(run.task || 'No task specified')}
        </div>
      </td>
      <td>
        <span style="font-family: var(--font-mono); font-weight: 600;">${run.durationHuman}</span>
      </td>
      <td>
        <span style="font-family: var(--font-mono); color: var(--text-dim); font-size: 0.75rem;">${tokenDisplay}</span>
      </td>
      <td style="text-align: right;">
        <div style="display: flex; align-items: center; justify-content: flex-end; gap: 0.35rem;">
          <button class="btn btn-sm btn-secondary btn-row-cli" title="Copy CLI Command">CLI</button>
          <button class="btn btn-sm btn-secondary btn-row-inspect">Inspect</button>
        </div>
      </td>
    `;

    tr.addEventListener('click', () => {
      state.selectedRowIndex = idx;
      renderHistoryTable();
      openWorkspaceModal(run.filename);
    });

    tr.querySelector('.btn-row-cli').addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(run.cliCommand || `opencode-subagent "${run.task || ''}"`, 'CLI command copied!');
    });

    tr.querySelector('.btn-row-inspect').addEventListener('click', (e) => {
      e.stopPropagation();
      openWorkspaceModal(run.filename);
    });

    el.historyTbody.appendChild(tr);
  });
}

function updatePagination() {
  const start = state.totalRuns === 0 ? 0 : state.pageOffset + 1;
  const end = Math.min(state.pageOffset + state.pageLimit, state.totalRuns);
  el.paginationInfo.textContent = `Showing ${start}-${end} of ${state.totalRuns} runs`;

  el.btnPrevPage.disabled = state.pageOffset <= 0;
  el.btnNextPage.disabled = state.pageOffset + state.pageLimit >= state.totalRuns;
}

// --- Full-Page Workspace Modal Dialog ---

async function openWorkspaceModal(filename) {
  state.selectedRun = filename;
  state.rawLogLines = [];
  el.modalTerminalContent.textContent = 'Loading log stream...';
  el.modalMarkdownContainer.innerHTML = '<div class="markdown-empty">Loading markdown summary...</div>';
  el.modalDiffContainer.innerHTML = '<div class="diff-empty">Loading diffs...</div>';
  el.modalFilesChips.innerHTML = '';

  // Open Fullscreen Modal
  el.workspaceModalOverlay.classList.add('open');
  el.workspaceModal.classList.add('open');

  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(filename)}`);
    if (!res.ok) return;
    const meta = await res.json();

    // Header Meta
    el.modalProvider.textContent = meta.provider;
    el.modalProvider.className = `provider-tag provider-${meta.provider.toLowerCase()}`;
    el.modalFilename.textContent = meta.filename;
    el.modalStatusPill.textContent = meta.status;
    el.modalStatusPill.className = `status-pill status-${meta.status.toLowerCase()}`;
    el.modalWorkspace.textContent = `📁 ${meta.workspaceName || meta.workspace}`;
    el.modalModel.textContent = `🤖 ${meta.model}`;
    el.modalPid.textContent = `PID: ${meta.pid}`;
    el.modalStartTime.textContent = `🕒 ${formatISTTime(meta.startTimeIST || meta.startTime)}`;
    el.modalDuration.textContent = `⏱️ ${meta.durationHuman}`;
    el.btnModalDownloadLog.href = `/api/logs/${encodeURIComponent(meta.filename)}`;

    // Kill button
    if (meta.isAlive) {
      el.modalBtnKill.style.display = 'inline-flex';
      el.modalBtnKill.onclick = () => killProcess(meta.pid, meta.filename);
    } else {
      el.modalBtnKill.style.display = 'none';
    }

    // Left Sidebar: Task Prompt
    el.modalTaskContent.textContent = meta.fullTask || meta.task || 'No task prompt recorded';
    el.btnTaskCopySmall.onclick = () => copyToClipboard(meta.fullTask || meta.task, 'Task prompt copied!');
    el.btnModalCopyPrompt.onclick = () => copyToClipboard(meta.fullTask || meta.task, 'Task prompt copied!');

    // Left Sidebar: CLI Command
    el.modalCliCode.textContent = meta.cliCommand || 'No command available';
    el.btnCliCopySmall.onclick = () => copyToClipboard(meta.cliCommand, 'CLI command copied!');
    el.btnModalCopyCli.onclick = () => copyToClipboard(meta.cliCommand, 'CLI command copied!');

    // Left Sidebar: Tokens & Cost Mini Stats
    if (meta.tokens) {
      el.miniTokensInput.textContent = formatNumber(meta.tokens.input || 0);
      el.miniTokensOutput.textContent = formatNumber(meta.tokens.output || 0);
      el.miniTokensReasoning.textContent = formatNumber(meta.tokens.reasoning || 0);
      el.miniTokensCache.textContent = formatNumber(meta.tokens.cacheRead || 0);
      el.miniTokensTotal.textContent = formatNumber(meta.tokens.total || 0);
    } else {
      el.miniTokensInput.textContent = '-';
      el.miniTokensOutput.textContent = '-';
      el.miniTokensReasoning.textContent = '-';
      el.miniTokensCache.textContent = '-';
      el.miniTokensTotal.textContent = '-';
    }
    el.miniCost.textContent = meta.cost ? `$${meta.cost.toFixed(4)}` : '$0.00';

    // Left Sidebar: Touched Files Chips
    if (meta.filesModified && meta.filesModified.length > 0) {
      el.modalFilesCount.textContent = meta.filesModified.length;
      el.tabModalDiffsCount.style.display = 'inline-block';
      el.tabModalDiffsCount.textContent = meta.filesModified.length;
      el.modalFilesChips.innerHTML = meta.filesModified.map(f => `<span class="touched-file-chip">${escapeHtml(f)}</span>`).join('');
    } else {
      el.modalFilesCount.textContent = '0';
      el.tabModalDiffsCount.style.display = 'none';
      el.modalFilesChips.innerHTML = '<span style="color: var(--text-dim); font-size: 0.75rem;">No files modified</span>';
    }

    // Right Viewport: Tools & Commands
    state.activeRunData = meta;
    state.toolFilterType = 'all';
    state.toolFilterQuery = '';
    if (el.toolSearchInput) el.toolSearchInput.value = '';
    if (el.toolsFilterPills) {
      el.toolsFilterPills.querySelectorAll('.tool-pill').forEach(p => p.classList.toggle('active', p.dataset.toolType === 'all'));
    }
    renderToolsTab();

    // Right Viewport: Markdown Output
    if (meta.markdownSummary) {
      el.modalMarkdownContainer.innerHTML = renderMarkdownToHtml(meta.markdownSummary);
    } else {
      el.modalMarkdownContainer.innerHTML = '<div class="markdown-empty">No structured markdown summary recorded for this run. Check the Live Terminal tab for full raw output.</div>';
    }

    // Right Viewport: Diffs
    if (meta.diffs) {
      el.modalDiffContainer.innerHTML = renderDiffToHtml(meta.diffs);
    } else {
      el.modalDiffContainer.innerHTML = '<div class="diff-empty">No git diff captured for this run.</div>';
    }

    // Start Log Streaming
    startLogStream(meta.filename);
  } catch (err) {
    console.error('Error opening workspace modal:', err);
  }
}

function renderToolsTab() {
  const tools = state.activeRunData?.toolCalls || [];
  const query = (state.toolFilterQuery || '').toLowerCase();
  const selectedType = state.toolFilterType || 'all';

  const counts = {
    all: tools.length,
    command: tools.filter(t => t.type === 'command').length,
    edit: tools.filter(t => t.type === 'edit').length,
    read: tools.filter(t => t.type === 'read').length,
    grep: tools.filter(t => t.type === 'grep').length,
  };

  if (el.countToolsAll) el.countToolsAll.textContent = counts.all;
  if (el.countToolsCmd) el.countToolsCmd.textContent = counts.command;
  if (el.countToolsEdit) el.countToolsEdit.textContent = counts.edit;
  if (el.countToolsRead) el.countToolsRead.textContent = counts.read;
  if (el.countToolsGrep) el.countToolsGrep.textContent = counts.grep;

  if (tools.length > 0) {
    el.tabModalToolsCount.style.display = 'inline-block';
    el.tabModalToolsCount.textContent = tools.length;
  } else {
    el.tabModalToolsCount.style.display = 'none';
  }

  let filtered = tools;
  if (selectedType !== 'all') {
    filtered = filtered.filter(t => t.type === selectedType);
  }
  if (query) {
    filtered = filtered.filter(t => 
      (t.summary && t.summary.toLowerCase().includes(query)) ||
      (t.detail && t.detail.toLowerCase().includes(query)) ||
      (t.tool && t.tool.toLowerCase().includes(query))
    );
  }

  if (filtered.length === 0) {
    el.modalToolsContainer.innerHTML = `<div class="tools-empty">${tools.length === 0 ? 'No tools or shell commands recorded for this run.' : 'No tools match your filter.'}</div>`;
    return;
  }

  const iconMap = {
    command: '💻',
    edit: '✏️',
    read: '📄',
    grep: '🔍',
    tool: '⚙️',
    other: '🔧',
  };

  const badgeClassMap = {
    command: 'tool-badge-cmd',
    edit: 'tool-badge-edit',
    read: 'tool-badge-read',
    grep: 'tool-badge-grep',
    tool: 'tool-badge-cmd',
    other: 'tool-badge-cmd',
  };

  el.modalToolsContainer.innerHTML = filtered.map((t, idx) => {
    const icon = iconMap[t.type] || '⚙️';
    const badgeClass = badgeClassMap[t.type] || 'tool-badge-cmd';
    const escapedSummary = escapeHtml(t.summary || t.tool);
    const escapedDetail = escapeHtml(t.detail || t.summary || '');
    const durationText = t.durationMs ? `<span style="font-size: 0.7rem; color: var(--text-dim); margin-left: auto;">${t.durationMs}ms</span>` : '';

    return `
      <div class="tool-card">
        <div class="tool-card-header">
          <div class="tool-card-title">
            <span>${icon}</span>
            <span class="${badgeClass}">${escapeHtml(t.tool)}</span>
            <span>${escapedSummary}</span>
          </div>
          ${durationText}
          <button class="tool-btn-copy" data-copy-idx="${idx}" title="Copy command/file detail">📋</button>
        </div>
        <div class="tool-card-body">${escapedDetail}</div>
      </div>
    `;
  }).join('');

  // Attach copy listeners
  el.modalToolsContainer.querySelectorAll('.tool-btn-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.copyIdx, 10);
      const item = filtered[idx];
      if (item && item.detail) {
        copyToClipboard(item.detail, 'Copied tool command!');
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      }
    });
  });
}

function closeWorkspaceModal() {
  el.workspaceModalOverlay.classList.remove('open');
  el.workspaceModal.classList.remove('open');
  if (state.activeLogStream) {
    state.activeLogStream.close();
    state.activeLogStream = null;
  }
}

function toggleFullscreenModal() {
  state.isFullscreen = !state.isFullscreen;
  el.workspaceModal.classList.toggle('is-fullscreen', state.isFullscreen);
  el.btnToggleFullscreen.textContent = state.isFullscreen ? '🗗' : '⛶';
  el.btnToggleFullscreen.title = state.isFullscreen ? 'Exit Fullscreen' : 'Toggle Fullscreen Width';
}

function switchModalTab(tabId) {
  state.activeModalTab = tabId;
  el.fsTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabId));
  el.fsTabPanes.forEach(p => p.classList.toggle('active', p.id === `modal-pane-${tabId}`));
}

async function startLogStream(filename) {
  if (state.activeLogStream) {
    state.activeLogStream.close();
  }

  state.rawLogLines = [];
  el.modalTerminalContent.innerHTML = 'Connecting to log stream...';
  el.streamStatusBadge.innerHTML = '<span class="stream-dot"></span> Live Streaming';
  el.streamStatusBadge.style.color = 'var(--accent)';

  // Initial immediate fetch for instant rendering of completed/existing logs
  try {
    const res = await fetch(`/api/logs/${encodeURIComponent(filename)}`);
    if (res.ok) {
      const fullText = await res.text();
      state.rawLogLines = fullText.split('\n');
      renderTerminalLines();
    }
  } catch (e) {
    console.warn('Initial log fetch failed:', e);
  }

  const sse = new EventSource(`/api/logs/${encodeURIComponent(filename)}/stream`);
  state.activeLogStream = sse;

  sse.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.chunk) {
        const lines = data.chunk.split('\n');
        if (state.rawLogLines.length === 0) {
          state.rawLogLines = lines;
        } else {
          for (const line of lines) {
            state.rawLogLines.push(line);
          }
        }
        renderTerminalLines();
      } else if (data.type === 'eof') {
        el.streamStatusBadge.innerHTML = '<span>●</span> Stream Finished';
        el.streamStatusBadge.style.color = 'var(--text-dim)';
      }
    } catch {}
  };

  sse.onerror = () => {
    el.streamStatusBadge.innerHTML = '<span>●</span> Stream Finished';
    el.streamStatusBadge.style.color = 'var(--text-dim)';
  };
}

function renderTerminalLines() {
  const query = state.filterLogQuery.toLowerCase();
  let filtered = state.rawLogLines;
  if (query) {
    filtered = filtered.filter(l => l.toLowerCase().includes(query));
  }

  el.logLinesCount.textContent = `${filtered.length} lines`;
  const rendered = filtered.map(l => ansiToHtml(escapeHtml(l))).join('\n');
  el.modalTerminalContent.innerHTML = rendered || '<span style="color: var(--text-dim);">No output lines recorded.</span>';

  if (state.autoscroll) {
    el.modalTerminalBox.scrollTop = el.modalTerminalBox.scrollHeight;
  }
}

// --- Process Management ---

async function killProcess(pid, filename) {
  if (!confirm(`Are you sure you want to terminate subagent process PID ${pid}?`)) return;
  try {
    const res = await fetch(`/api/runs/${encodeURIComponent(filename)}/kill`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert(`Process tree for PID ${pid} terminated.`);
      fetchStats();
      fetchRuns();
      if (state.selectedRun === filename) openWorkspaceModal(filename);
    } else {
      alert(`Could not terminate process: ${data.error || 'Unknown error'}`);
    }
  } catch (err) {
    alert(`Kill request failed: ${err.message}`);
  }
}

async function killAllDangling() {
  if (!confirm(`Terminate all ${state.danglingProcesses.length} dangling subagent processes on the system?`)) return;
  try {
    const res = await fetch('/api/dangling/kill-all', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      alert(`Terminated ${data.terminatedCount} dangling subagent processes.`);
      closeDanglingModal();
      fetchStats();
    }
  } catch (err) {
    alert(`Failed to terminate dangling processes: ${err.message}`);
  }
}

function openDanglingModal() {
  el.danglingListContainer.innerHTML = '';
  if (state.danglingProcesses.length === 0) {
    el.danglingListContainer.innerHTML = '<div style="color: var(--text-dim);">No dangling subagent processes detected.</div>';
  } else {
    for (const proc of state.danglingProcesses) {
      const item = document.createElement('div');
      item.className = 'dangling-item';
      item.innerHTML = `
        <div style="display: flex; flex-direction: column;">
          <span class="dangling-pid">PID: ${proc.pid}</span>
          <span class="dangling-cmd">${escapeHtml(proc.cmd || '')}</span>
        </div>
        <button class="btn btn-sm btn-danger btn-kill-single">Kill</button>
      `;
      item.querySelector('.btn-kill-single').addEventListener('click', async () => {
        await fetch(`/api/dangling/${proc.pid}/kill`, { method: 'POST' });
        fetchStats();
        openDanglingModal();
      });
      el.danglingListContainer.appendChild(item);
    }
  }

  el.danglingModalOverlay.classList.add('open');
  el.danglingModal.classList.add('open');
}

function closeDanglingModal() {
  el.danglingModalOverlay.classList.remove('open');
  el.danglingModal.classList.remove('open');
}

function openShortcutsModal() {
  el.shortcutsModalOverlay.classList.add('open');
  el.shortcutsModal.classList.add('open');
}

function closeShortcutsModal() {
  el.shortcutsModalOverlay.classList.remove('open');
  el.shortcutsModal.classList.remove('open');
}

// --- Formatters & Parsers ---

function formatISTTime(isoOrStr) {
  if (!isoOrStr) return '-';
  if (isoOrStr.includes(' ')) return isoOrStr;
  try {
    const d = new Date(isoOrStr);
    if (isNaN(d.getTime())) return isoOrStr;
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  } catch {
    return isoOrStr;
  }
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ansiToHtml(str) {
  return str
    .replace(/\x1B\[0m/g, '</span>')
    .replace(/\x1B\[1m/g, '<span style="font-weight: bold;">')
    .replace(/\x1B\[31m/g, '<span style="color: #f87171;">')
    .replace(/\x1B\[32m/g, '<span style="color: #4ade80;">')
    .replace(/\x1B\[33m/g, '<span style="color: #fbbf24;">')
    .replace(/\x1B\[34m/g, '<span style="color: #60a5fa;">')
    .replace(/\x1B\[35m/g, '<span style="color: #c084fc;">')
    .replace(/\x1B\[36m/g, '<span style="color: #38bdf8;">')
    .replace(/\x1B\[90m/g, '<span style="color: #64748b;">')
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function renderDiffToHtml(diffText) {
  if (!diffText) return '<div class="diff-empty">No diff captured.</div>';
  const lines = diffText.split('\n');
  return lines.map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
      return `<span class="diff-line-header">${escaped}</span>`;
    } else if (line.startsWith('+')) {
      return `<span class="diff-line-add">${escaped}</span>`;
    } else if (line.startsWith('-')) {
      return `<span class="diff-line-del">${escaped}</span>`;
    } else if (line.startsWith('@@')) {
      return `<span class="diff-line-header">${escaped}</span>`;
    }
    return `<span class="diff-line-context">${escaped}</span>`;
  }).join('\n');
}

function renderMarkdownToHtml(md) {
  if (!md) return '';
  let html = escapeHtml(md);

  // Fenced Code blocks
  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
    return `<pre><code class="language-${lang}">${code}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headings
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

  // Bold & Italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Unordered Lists
  html = html.replace(/^\s*-\s+(.*$)/gim, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

  // Paragraphs
  html = html.replace(/\n\n+/g, '</p><p>');
  html = `<p>${html}</p>`;

  return html;
}

function copyToClipboard(text, successMsg = 'Copied to clipboard!') {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast(successMsg);
  }).catch(() => {
    prompt('Copy to clipboard:', text);
  });
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.textContent = msg;
  toast.style.position = 'fixed';
  toast.style.bottom = '2rem';
  toast.style.right = '2rem';
  toast.style.padding = '0.6rem 1.2rem';
  toast.style.backgroundColor = 'var(--accent)';
  toast.style.color = '#000000';
  toast.style.fontWeight = '700';
  toast.style.fontSize = '0.85rem';
  toast.style.borderRadius = '8px';
  toast.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
  toast.style.zIndex = '9999';
  toast.style.transition = 'opacity 0.3s ease';
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2200);
}

// --- Global Event Listeners & Shortcuts ---

function initEventListeners() {
  // Theme Selector
  if (el.themeSelector) {
    el.themeSelector.value = state.theme;
    el.themeSelector.addEventListener('change', (e) => applyTheme(e.target.value));
  }
  applyTheme(state.theme);

  // Density Controls
  el.btnDensityComfortable.addEventListener('click', () => applyDensity('comfortable'));
  el.btnDensityCompact.addEventListener('click', () => applyDensity('compact'));
  applyDensity(state.density);

  // Notification Toggle
  el.btnToggleNotif.addEventListener('click', () => {
    state.notificationsEnabled = !state.notificationsEnabled;
    localStorage.setItem('subagent_notif', state.notificationsEnabled);
    updateNotifButton();
    if (state.notificationsEnabled) {
      if ('Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission();
      }
      playChime('success');
      showToast('Sound & Notifications enabled');
    } else {
      showToast('Sound & Notifications disabled');
    }
  });
  updateNotifButton();

  // Search filter with debounce
  let searchTimer = null;
  el.filterSearch.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filterSearch = e.target.value.trim();
      state.pageOffset = 0;
      fetchRuns();
    }, 250);
  });

  // Provider Filter Buttons
  el.providerFilters.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.providerFilters.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filterProvider = btn.dataset.provider;
      state.pageOffset = 0;
      fetchRuns();
    });
  });

  // Status Filter Buttons
  el.statusFilters.querySelectorAll('.seg-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.statusFilters.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.filterStatus = btn.dataset.status;
      state.pageOffset = 0;
      fetchRuns();
    });
  });

  // Pagination
  el.btnPrevPage.addEventListener('click', () => {
    if (state.pageOffset > 0) {
      state.pageOffset = Math.max(0, state.pageOffset - state.pageLimit);
      fetchRuns();
    }
  });

  el.btnNextPage.addEventListener('click', () => {
    if (state.pageOffset + state.pageLimit < state.totalRuns) {
      state.pageOffset += state.pageLimit;
      fetchRuns();
    }
  });

  // Refresh button
  el.btnRefresh.addEventListener('click', () => {
    fetchStats();
    fetchAnalytics();
    fetchWorkspaces();
    fetchRuns();
    showToast('Refreshed monitor data');
  });

  // Fullscreen Modal Controls & Tabs
  el.btnCloseWorkspaceModal.addEventListener('click', closeWorkspaceModal);
  el.workspaceModalOverlay.addEventListener('click', closeWorkspaceModal);
  el.btnToggleFullscreen.addEventListener('click', toggleFullscreenModal);
  el.btnModalCopyLog.addEventListener('click', () => {
    copyToClipboard(state.rawLogLines.join('\n'), 'Full log copied to clipboard!');
  });

  el.fsTabs.forEach(tab => {
    tab.addEventListener('click', () => switchModalTab(tab.dataset.tab));
  });

  // Terminal Controls
  el.chkAutoscroll.addEventListener('change', (e) => state.autoscroll = e.target.checked);
  el.chkWrap.addEventListener('change', (e) => {
    state.wordWrap = e.target.checked;
    el.modalTerminalContent.style.whiteSpace = state.wordWrap ? 'pre-wrap' : 'pre';
  });

  el.logSearchInput.addEventListener('input', (e) => {
    state.filterLogQuery = e.target.value.trim();
    renderTerminalLines();
  });

  // Tools & Commands Tab Controls
  if (el.toolsFilterPills) {
    el.toolsFilterPills.querySelectorAll('.tool-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        el.toolsFilterPills.querySelectorAll('.tool-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.toolFilterType = pill.dataset.toolType;
        renderToolsTab();
      });
    });
  }

  if (el.toolSearchInput) {
    el.toolSearchInput.addEventListener('input', (e) => {
      state.toolFilterQuery = e.target.value.trim();
      renderToolsTab();
    });
  }

  // Dangling Modal
  el.danglingChip.addEventListener('click', openDanglingModal);
  el.btnKillAllDangling.addEventListener('click', (e) => {
    e.stopPropagation();
    killAllDangling();
  });
  el.btnCloseDanglingModal.addEventListener('click', closeDanglingModal);
  el.btnDismissDangling.addEventListener('click', closeDanglingModal);
  el.danglingModalOverlay.addEventListener('click', closeDanglingModal);
  el.btnModalKillAll.addEventListener('click', killAllDangling);

  // Shortcuts Modal
  el.btnShortcuts.addEventListener('click', openShortcutsModal);
  el.btnCloseShortcutsModal.addEventListener('click', closeShortcutsModal);
  el.btnDismissShortcuts.addEventListener('click', closeShortcutsModal);
  el.shortcutsModalOverlay.addEventListener('click', closeShortcutsModal);

  // Keyboard Shortcuts Handler
  document.addEventListener('keydown', (e) => {
    const isInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

    if (e.key === 'Escape') {
      closeWorkspaceModal();
      closeDanglingModal();
      closeShortcutsModal();
      if (isInput) document.activeElement.blur();
      return;
    }

    if (isInput) return;

    if (e.key === '/') {
      e.preventDefault();
      el.filterSearch.focus();
    } else if (e.key === '?' || (e.shiftKey && e.key === '?')) {
      e.preventDefault();
      openShortcutsModal();
    } else if (e.key === 'f' || e.key === 'F') {
      if (el.workspaceModal.classList.contains('open')) {
        e.preventDefault();
        toggleFullscreenModal();
      }
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      fetchStats();
      fetchRuns();
      showToast('Refreshed data');
    } else if (e.key === 't' || e.key === 'T') {
      e.preventDefault();
      const themes = ['midnight', 'light', 'latte', 'catppuccin', 'tokyo', 'oled'];
      const nextTheme = themes[(themes.indexOf(state.theme) + 1) % themes.length];
      applyTheme(nextTheme);
      showToast(`Switched to ${nextTheme} theme`);
    } else if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.historyRuns.length > 0) {
        state.selectedRowIndex = Math.min(state.historyRuns.length - 1, state.selectedRowIndex + 1);
        renderHistoryTable();
      }
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.historyRuns.length > 0) {
        state.selectedRowIndex = Math.max(0, state.selectedRowIndex - 1);
        renderHistoryTable();
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (state.selectedRowIndex >= 0 && state.selectedRowIndex < state.historyRuns.length) {
        e.preventDefault();
        openWorkspaceModal(state.historyRuns[state.selectedRowIndex].filename);
      }
    }
  });
}

function updateNotifButton() {
  if (state.notificationsEnabled) {
    el.iconNotifOff.style.display = 'none';
    el.iconNotifOn.style.display = 'block';
  } else {
    el.iconNotifOff.style.display = 'block';
    el.iconNotifOn.style.display = 'none';
  }
}

// --- Global SSE Connection ---
function initSSE() {
  const evtSource = new EventSource('/api/events');

  evtSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'stats_update') {
        el.activeCount.textContent = data.activeCount || 0;
        el.todayCount.textContent = data.todayCount || 0;
        el.totalCount.textContent = data.totalCount || 0;
        el.activeBadge.textContent = `${data.activeCount || 0} Running`;
        renderActiveCards(data.activeRuns || []);
      }
    } catch {}
  };

  evtSource.onerror = () => {
    el.liveIndicator.innerHTML = '<span class="indicator-dot" style="background-color: var(--danger);"></span> Reconnecting...';
  };

  evtSource.onopen = () => {
    el.liveIndicator.innerHTML = '<span class="indicator-dot"></span> Live Sync';
  };
}

// --- App Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  initEventListeners();
  initSSE();
  fetchStats();
  fetchAnalytics();
  fetchWorkspaces();
  fetchRuns();

  // Tick duration timers every second
  setInterval(() => {
    document.querySelectorAll('.active-clock').forEach(clockEl => {
      const startTimeIso = clockEl.dataset.start;
      if (startTimeIso) {
        const startMs = new Date(startTimeIso).getTime();
        const diffSec = Math.max(0, Math.round((Date.now() - startMs) / 1000));
        const m = Math.floor(diffSec / 60);
        const s = diffSec % 60;
        clockEl.textContent = `⏱️ ${m}m ${s}s`;
      }
    });
  }, 1000);
});
