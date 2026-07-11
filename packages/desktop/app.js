/* Pilot desktop — renderer logic.
 *
 * Talks to the daemon ONLY through `window.pilot` (set up by preload.cjs).
 * Three tabs: Pair (QR iframe), Sessions (live PTY list), Settings (config).
 */

'use strict';

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

const els = {
  tabPair: $('#tab-pair'),
  tabSessions: $('#tab-sessions'),
  tabSettings: $('#tab-settings'),
  panelPair: $('#panel-pair'),
  panelSessions: $('#panel-sessions'),
  panelSettings: $('#panel-settings'),
  sessionBadge: $('#session-badge'),
  sessionCount: $('#session-count'),
  lastUpdated: $('#last-updated'),
  refreshBtn: $('#refresh-btn'),
  sessionsList: $('#sessions-list'),
  pairFrame: $('#pair-frame'),
  pairPlaceholder: $('#pair-placeholder'),
  statusDot: $('#status-dot'),
  statusLabel: $('#status-label'),
  statusMeta: $('#status-meta'),
  confirmTpl: $('#confirm-tpl'),
  // Settings
  settingsForm: $('#settings-form'),
  settingPort: /** @type {HTMLInputElement} */ ($('#setting-port')),
  settingBind: /** @type {HTMLInputElement} */ ($('#setting-bind')),
  settingName: /** @type {HTMLInputElement} */ ($('#setting-name')),
  settingLogin: /** @type {HTMLInputElement} */ ($('#setting-login')),
  settingFsRoot: /** @type {HTMLInputElement} */ ($('#setting-fsroot')),
  bindTailscaleBtn: $('#bind-tailscale-btn'),
  fsrootBrowseBtn: $('#fsroot-browse-btn'),
  settingsFeedback: $('#settings-feedback'),
  restartBanner: $('#restart-banner'),
  // Folder picker modal
  fsOverlay: $('#fs-overlay'),
  fsCloseBtn: $('#fs-close-btn'),
  fsBreadcrumb: $('#fs-breadcrumb'),
  fsListing: $('#fs-listing'),
  fsSelectedPath: $('#fs-selected-path'),
  fsSelectBtn: $('#fs-select-btn'),
};

const state = {
  status: null,
  pairingUrl: null,
  sessions: [],
  pollHandle: 0,
  activeTab: 'pair',
  /** Current settings from main. Loaded once the Settings tab is opened. */
  settings: null,
  // Folder picker state
  fsCurrentPath: '',
  fsRoot: '',
  fsSelectedDir: '',
};

// ─────────────────────────────────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────────────────────────────────

function setActiveTab(name) {
  state.activeTab = name;
  const isPair = name === 'pair';
  const isSessions = name === 'sessions';
  const isSettings = name === 'settings';
  els.tabPair.setAttribute('aria-selected', String(isPair));
  els.tabSessions.setAttribute('aria-selected', String(isSessions));
  els.tabSettings.setAttribute('aria-selected', String(isSettings));
  els.panelPair.classList.toggle('hidden', !isPair);
  els.panelSessions.classList.toggle('hidden', !isSessions);
  els.panelSettings.classList.toggle('hidden', !isSettings);
  if (isPair) ensurePairFrame();
  else if (isSessions) refreshSessionsNow();
  else if (isSettings) loadSettings();
}

els.tabPair.addEventListener('click', () => setActiveTab('pair'));
els.tabSessions.addEventListener('click', () => setActiveTab('sessions'));
els.tabSettings.addEventListener('click', () => setActiveTab('settings'));
els.refreshBtn?.addEventListener('click', () => refreshSessionsNow());

// Listen for main-process commands.
if (window.pilot?.on) {
  window.pilot.on('pilot:daemon-ready', () => {
    if (state.activeTab === 'pair') ensurePairFrame();
    settingsLoaded = false;
  });
  window.pilot.on('pilot:daemon-down', () => {
    state.status = null;
    els.statusDot.dataset.state = 'offline';
    els.statusLabel.textContent = 'Daemon stopped';
    els.statusMeta.textContent = 'Restarting…';
    pairFrameAttempted = false;
  });
  window.pilot.on('pilot:daemon-error', (_evt, msg) => {
    els.statusDot.dataset.state = 'offline';
    els.statusLabel.textContent = 'Daemon error';
    els.statusMeta.textContent = typeof msg === 'string' ? msg.slice(0, 60) : '';
    pairFrameAttempted = false;
  });
  window.pilot.on('pilot:show-settings', () => {
    setActiveTab('settings');
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Pair frame
// ─────────────────────────────────────────────────────────────────────────

let pairFrameAttempted = false;
async function ensurePairFrame() {
  if (pairFrameAttempted || !els.pairFrame) return;
  if (!window.pilot) return;
  try {
    const url = await window.pilot.getPairingUrl();
    if (!url) return;
    state.pairingUrl = url;
    els.pairFrame.src = url;
    els.pairFrame.classList.add('ready');
    els.pairPlaceholder.style.display = 'none';
    pairFrameAttempted = true;
  } catch {
    /* daemon not ready yet */
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Polling
// ─────────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 3_000;

async function tick() {
  await Promise.all([updateStatus(), state.activeTab === 'sessions' && refreshSessionsNow()]);
  if (state.activeTab === 'pair' && !pairFrameAttempted) {
    await ensurePairFrame();
  }
}

function startPolling() {
  if (state.pollHandle) return;
  state.pollHandle = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
  void tick();
}

window.addEventListener('DOMContentLoaded', () => {
  setActiveTab('pair');
  startPolling();
});

// ─────────────────────────────────────────────────────────────────────────
// Status bar
// ─────────────────────────────────────────────────────────────────────────

async function updateStatus() {
  try {
    const s = await window.pilot.getStatus();
    state.status = s;
    els.statusDot.dataset.state = 'online';
    els.statusLabel.textContent = 'Online';
    const port = s.port != null ? `:${s.port}` : '';
    const tailnet = s.tailscaleIp ? ` · tailnet ${s.tailscaleIp}` : '';
    const name = s.machineName ? ` · ${s.machineName}` : '';
    els.statusMeta.textContent =
      `pilot-cli v${s.version}${port}${name}${tailnet} · ${formatUptime(s.uptimeMs)}`;
  } catch {
    state.status = null;
    els.statusDot.dataset.state = 'offline';
    els.statusLabel.textContent = 'Daemon unreachable';
    els.statusMeta.textContent = '';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Sessions list
// ─────────────────────────────────────────────────────────────────────────

async function refreshSessionsNow() {
  if (!els.sessionsList) return;
  try {
    const sessions = await window.pilot.getSessions();
    state.sessions = sessions;
    renderSessions(sessions);
    els.lastUpdated.textContent = 'just now';
    setTimeout(() => {
      if (state.sessions === sessions) {
        els.lastUpdated.textContent = formatNow();
      }
    }, 1500);
  } catch {
    renderError('Could not load sessions');
  }
}

function renderSessions(sessions) {
  const count = sessions.length;
  els.sessionCount.textContent = String(count);
  if (count > 0) {
    els.sessionBadge.textContent = String(count);
    els.sessionBadge.hidden = false;
  } else {
    els.sessionBadge.hidden = true;
  }

  const existing = new Map();
  els.sessionsList.querySelectorAll('[data-id]').forEach((node) => {
    existing.set(node.getAttribute('data-id'), node);
  });

  for (const s of sessions) {
    let card = existing.get(s.id);
    if (!card) {
      card = buildSessionCard(s);
      els.sessionsList.appendChild(card);
    } else {
      updateSessionCard(card, s);
    }
    existing.delete(s.id);
  }

  for (const [id, node] of existing) {
    void id;
    node.classList.add('removing');
    setTimeout(() => node.remove(), 220);
  }

  const existingEmpty = els.sessionsList.querySelector('.empty');
  if (sessions.length === 0 && !existingEmpty) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `
      <h3>No active sessions</h3>
      <p>Pair the Pilot app on your phone, then start a session — it'll appear here.</p>`;
    els.sessionsList.appendChild(empty);
  } else if (sessions.length > 0 && existingEmpty) {
    existingEmpty.remove();
  }
}

function buildSessionCard(s) {
  const card = document.createElement('article');
  card.className = 'session';
  card.dataset.id = s.id;
  card.innerHTML = `
    <div class="tool">${escapeHtml(s.tool)}</div>
    <div class="meta">
      <div class="cwd" title="${escapeAttr(s.cwd)}">${escapeHtml(s.cwd)}</div>
      <div class="row2">
        <span class="pill ${s.attached ? 'attached' : 'detached'}">${s.attached ? 'attached' : 'detached'}</span>
        <span>started ${formatAge(s.createdMs)}</span>
        <span class="short-id">· ${s.id.slice(0, 8)}</span>
      </div>
    </div>
    <button class="stop-btn" data-id="${escapeAttr(s.id)}">Stop</button>
  `;
  card.querySelector('.stop-btn').addEventListener('click', () => beginConfirmStop(s.id, card));
  updateSessionCard(card, s);
  return card;
}

function updateSessionCard(card, s) {
  const pill = card.querySelector('.pill');
  if (pill) {
    pill.textContent = s.attached ? 'attached' : 'detached';
    pill.classList.toggle('attached', s.attached);
    pill.classList.toggle('detached', !s.attached);
  }
  const ageEl = card.querySelector('.row2 span:nth-of-type(2)');
  if (ageEl) ageEl.textContent = `started ${formatAge(s.createdMs)}`;
}

function beginConfirmStop(id, card) {
  if (card.querySelector('.confirm-pop')) return;
  const btn = card.querySelector('.stop-btn');
  const node = els.confirmTpl.content.firstElementChild.cloneNode(true);
  btn.replaceWith(node);
  node.querySelector('.cancel').addEventListener('click', () => {
    const fresh = document.createElement('button');
    fresh.className = 'stop-btn';
    fresh.textContent = 'Stop';
    fresh.addEventListener('click', () => beginConfirmStop(id, card));
    node.replaceWith(fresh);
  });
  node.querySelector('.confirm').addEventListener('click', async () => {
    node.querySelector('.confirm').setAttribute('disabled', 'true');
    node.querySelector('.cancel').setAttribute('disabled', 'true');
    await doClose(id, card);
  });
}

async function doClose(id, card) {
  try {
    await window.pilot.closeSession(id);
    card.classList.add('removing');
    setTimeout(() => card.remove(), 220);
    void refreshSessionsNow();
  } catch (err) {
    showInlineError(card, err instanceof Error ? err.message : String(err));
  }
}

function showInlineError(card, msg) {
  let node = card.querySelector('.inline-err');
  if (!node) {
    node = document.createElement('div');
    node.className = 'inline-err';
    node.style.cssText =
      'color:#ef4444;font-size:11px;margin-top:6px;grid-column:2;text-align:right';
    card.appendChild(node);
  }
  node.textContent = msg;
  setTimeout(() => node.remove(), 4000);
}

function renderError(msg) {
  els.sessionsList.innerHTML = `
    <div class="error-state">
      <h3>Couldn't reach the daemon</h3>
      <p>${escapeHtml(msg)}. Is the daemon still running?</p>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Settings tab
// ─────────────────────────────────────────────────────────────────────────

let settingsLoaded = false;

async function loadSettings() {
  if (!window.pilot || settingsLoaded) return;
  try {
    state.settings = await window.pilot.getSettings();
    populateSettingsForm(state.settings);
    settingsLoaded = true;
  } catch {
    els.settingsFeedback.textContent = 'Could not load settings.';
    els.settingsFeedback.className = 'settings-feedback error';
  }
}

function populateSettingsForm(s) {
  els.settingPort.value = String(s.port ?? '');
  els.settingBind.value = s.bind ?? '';
  els.settingName.value = s.name ?? '';
  els.settingLogin.checked = s.runAtLogin ?? false;
  els.settingFsRoot.value = s.fsRoot ?? '';
  state.fsRoot = s.fsRoot ?? '';
}

// Bind address quick-set: use Tailscale IP.
els.bindTailscaleBtn?.addEventListener('click', async () => {
  try {
    const status = state.status || (await window.pilot.getStatus());
    if (status.tailscaleIp) {
      els.settingBind.value = status.tailscaleIp;
      els.settingsFeedback.textContent = 'Bind set to Tailscale IP.';
      els.settingsFeedback.className = 'settings-feedback success';
      setTimeout(() => { els.settingsFeedback.textContent = ''; }, 3000);
    } else {
      els.settingsFeedback.textContent = 'No Tailscale IP detected.';
      els.settingsFeedback.className = 'settings-feedback error';
      setTimeout(() => { els.settingsFeedback.textContent = ''; }, 3000);
    }
  } catch {
    els.settingsFeedback.textContent = 'Daemon not reachable — cannot detect Tailscale IP.';
    els.settingsFeedback.className = 'settings-feedback error';
  }
});

// Save settings.
els.settingsForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const saveBtn = $('#settings-save');
  saveBtn.setAttribute('disabled', 'true');
  saveBtn.textContent = 'Saving…';
  els.settingsFeedback.textContent = '';
  els.restartBanner.classList.add('hidden');

  const port = parseInt(els.settingPort.value, 10);
  const bind = els.settingBind.value.trim();
  const name = els.settingName.value.trim();
  const runAtLogin = els.settingLogin.checked;
  const fsRoot = els.settingFsRoot.value.trim();

  // Client-side validation (port 0 = ephemeral, allowed).
  if (els.settingPort.value && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    els.settingsFeedback.textContent = 'Port must be between 0 and 65535.';
    els.settingsFeedback.className = 'settings-feedback error';
    saveBtn.removeAttribute('disabled');
    saveBtn.textContent = 'Save settings';
    return;
  }
  if (!bind) {
    els.settingsFeedback.textContent = 'Bind address is required.';
    els.settingsFeedback.className = 'settings-feedback error';
    saveBtn.removeAttribute('disabled');
    saveBtn.textContent = 'Save settings';
    return;
  }

  try {
    const result = await window.pilot.setSettings({ port, bind, name, runAtLogin, fsRoot });
    state.settings = result;
    state.fsRoot = result.fsRoot ?? '';
    populateSettingsForm(result);
    if (result.error) {
      els.settingsFeedback.textContent = 'Settings saved, but daemon restart failed: ' + result.error;
      els.settingsFeedback.className = 'settings-feedback error';
    } else {
      els.settingsFeedback.textContent = 'Settings saved.';
      els.settingsFeedback.className = 'settings-feedback success';
    }
    if (result.needsRestart) {
      els.restartBanner.classList.remove('hidden');
      pairFrameAttempted = false;
      settingsLoaded = false;
    }
    setTimeout(() => {
      if (els.settingsFeedback.textContent === 'Settings saved.') {
        els.settingsFeedback.textContent = '';
      }
    }, 3000);
  } catch (err) {
    els.settingsFeedback.textContent =
      'Failed to save: ' + (err instanceof Error ? err.message : String(err));
    els.settingsFeedback.className = 'settings-feedback error';
  }
  saveBtn.removeAttribute('disabled');
  saveBtn.textContent = 'Save settings';
});

// ─────────────────────────────────────────────────────────────────────────
// Folder picker modal
// ─────────────────────────────────────────────────────────────────────────

els.fsrootBrowseBtn?.addEventListener('click', () => openFolderPicker());
els.fsCloseBtn?.addEventListener('click', () => closeFolderPicker());
els.fsOverlay?.addEventListener('click', (e) => {
  if (e.target === els.fsOverlay) closeFolderPicker();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.fsOverlay.classList.contains('hidden')) {
    closeFolderPicker();
  }
});
els.fsSelectBtn?.addEventListener('click', () => selectFolder());

function openFolderPicker() {
  // Start browsing from the current fsRoot or the current path if already selected.
  const startPath = els.settingFsRoot.value.trim() || state.fsRoot || '';
  state.fsCurrentPath = startPath;
  state.fsSelectedDir = startPath;
  els.fsOverlay.classList.remove('hidden');
  els.fsSelectBtn.setAttribute('disabled', 'true');
  els.fsSelectedPath.textContent = '';
  navigateFs(startPath);
}

function closeFolderPicker() {
  els.fsOverlay.classList.add('hidden');
}

function selectFolder() {
  if (state.fsSelectedDir) {
    els.settingFsRoot.value = state.fsSelectedDir;
  }
  closeFolderPicker();
}

async function navigateFs(dirPath) {
  if (!els.fsListing) return;
  els.fsListing.innerHTML =
    '<div class="fs-loading"><div class="dot"></div><span>Loading…</span></div>';
  els.fsSelectBtn.setAttribute('disabled', 'true');
  els.fsSelectedPath.textContent = '';

  try {
    const data = await window.pilot.browseFs(dirPath || undefined);
    state.fsCurrentPath = data.path;
    state.fsSelectedDir = data.path;
    els.fsSelectedPath.textContent = data.path;
    els.fsSelectBtn.removeAttribute('disabled');
    renderFsBreadcrumb(data.path);
    renderFsListing(data.path, data.entries);
  } catch (err) {
    els.fsListing.innerHTML = `
      <div class="fs-error">
        <span>Could not read this folder.</span>
        <span class="fs-error-detail">${escapeHtml(err instanceof Error ? err.message : String(err))}</span>
      </div>`;
  }
}

function renderFsBreadcrumb(fullPath) {
  if (!els.fsBreadcrumb) return;

  // Split the path into segments for clickable breadcrumbs.
  let segments;
  if (fullPath === '/') {
    segments = ['/'];
  } else {
    segments = fullPath.split('/').filter(Boolean);
    segments.unshift('/');
  }

  els.fsBreadcrumb.innerHTML = '';
  let accumulated = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i === 0) {
      // Root
      accumulated = '/';
    } else {
      accumulated = accumulated === '/' ? `/${seg}` : `${accumulated}/${seg}`;
    }

    const crumb = document.createElement('button');
    crumb.className = 'fs-crumb';
    crumb.textContent = i === 0 ? 'Home' : seg;
    crumb.title = accumulated;
    crumb.addEventListener('click', () => navigateFs(accumulated));

    els.fsBreadcrumb.appendChild(crumb);

    if (i < segments.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'fs-crumb-sep';
      sep.textContent = '/';
      sep.setAttribute('aria-hidden', 'true');
      els.fsBreadcrumb.appendChild(sep);
    }
  }
}

function renderFsListing(currentPath, entries) {
  if (!els.fsListing) return;
  els.fsListing.innerHTML = '';

  // Only show directories — we're picking a folder root.
  const dirs = entries.filter((e) => e.type === 'dir');

  if (dirs.length === 0) {
    els.fsListing.innerHTML =
      '<div class="fs-empty"><span>No subdirectories</span></div>';
    return;
  }

  for (const entry of dirs) {
    const item = document.createElement('button');
    item.className = 'fs-item';
    item.setAttribute('role', 'option');

    const entryPath =
      currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;

    item.innerHTML = `
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" class="fs-folder-icon">
        <path fill="currentColor" d="M2 3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H8.5L7.3 3H2z"/>
      </svg>
      <span>${escapeHtml(entry.name)}</span>
    `;

    item.addEventListener('click', () => navigateFs(entryPath));
    item.addEventListener('dblclick', () => {
      // Double-click: select it immediately (navigate first so UI updates).
      els.settingFsRoot.value = entryPath;
      closeFolderPicker();
    });

    // Highlight if this is the currently selected (saved) folder root.
    const savedRoot = els.settingFsRoot.value.trim();
    if (savedRoot && entryPath === savedRoot) {
      item.classList.add('fs-item-current');
    }

    els.fsListing.appendChild(item);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Formatters
// ─────────────────────────────────────────────────────────────────────────

function formatUptime(ms) {
  if (!ms || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `uptime ${h}h ${m}m`;
  if (m) return `uptime ${m}m ${sec}s`;
  return `uptime ${sec}s`;
}

function formatAge(createdMs) {
  if (!createdMs) return '–';
  const delta = Math.max(0, Date.now() - createdMs);
  if (delta < 5_000) return 'just now';
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function formatNow() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
