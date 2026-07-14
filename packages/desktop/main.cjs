// Pilot desktop — self-contained Mac app.
//
// Architecture:
//   • Forks daemon.cjs via child_process.fork() — the child shares Electron's
//     Node ABI, so node-pty works without system Node. The parent and child
//     communicate via IPC (process.send / child.on('message')).
//   • Reads the bearer token from ~/.pilot/token (persisted by the CLI).
//   • Tray icon with show/hide/quit; run-at-login toggle; window position
//     remembered across launches; settings stored as JSON in userData.
//
// Renderer UI lives in app.html / styles.css / app.js — a tabbed UI:
//   • "Pair" tab     → iframes the loopback pairing page.
//   • "Sessions" tab → live PTY list with Stop buttons.
//   • "Settings" tab → port, machine name, bind, run-at-login.
//   • Status footer  → daemon dot, version, uptime, tailnet IP.

const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  Tray,
  Menu,
  dialog,
  nativeImage,
} = require('electron');
const { fork } = require('node:child_process');
const { homedir, hostname } = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// ───────────────────────────────────────────────────────────────────────
// Single instance: a second copy tells the user and hands off to the first
// (which would otherwise fail with EADDRINUSE when its daemon binds the port).
// ───────────────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  dialog.showErrorBox(
    'Pilot is already running',
    'Another copy of Pilot is already open — bringing its window to the front instead.',
  );
  app.exit(0);
}

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) {
    createWindow();
  } else {
    win.show();
    win.focus();
  }
});

const TOKEN_PATH = path.join(homedir(), '.pilot', 'token');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const WINDOW_STATE_PATH = path.join(app.getPath('userData'), 'window-state.json');
const DAEMON_ENTRY = path.join(__dirname, 'daemon.cjs');

// ───────────────────────────────────────────────────────────────────────
// Resolve CLI & shared dist paths (dev vs packaged)
// ───────────────────────────────────────────────────────────────────────

function getCliDistPath() {
  const dev = path.join(__dirname, '..', 'cli', 'dist');
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, 'cli-dist');
}

function getSharedDistPath() {
  const dev = path.join(__dirname, '..', 'shared', 'dist');
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, 'shared-dist');
}

// ───────────────────────────────────────────────────────────────────────
// Settings persistence (simple JSON file in userData)
// ───────────────────────────────────────────────────────────────────────

/** @type {{ port: number, bind: string, name: string, runAtLogin: boolean, fsRoot: string }} */
const defaultSettings = {
  port: 7117,
  bind: '0.0.0.0',
  name: hostname(),
  runAtLogin: false,
  fsRoot: homedir(),
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(
      `[desktop] could not save settings: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

let settings = loadSettings();

/**
 * Sync the run-at-login OS setting to `settings.runAtLogin`.
 *   • macOS/Windows: `app.setLoginItemSettings` (packaged builds only —
 *     login items need a real signed/installed app).
 *   • Linux: `setLoginItemSettings` is a no-op, so write/remove a freedesktop
 *     autostart entry at ~/.config/autostart/pilot.desktop instead.
 */
function syncRunAtLogin() {
  if (process.platform === 'linux') {
    // app.getPath('appData') is ~/.config on Linux.
    const desktopPath = path.join(app.getPath('appData'), 'autostart', 'pilot.desktop');
    try {
      if (settings.runAtLogin) {
        // For AppImage, exec the image itself, not the extracted binary.
        const execPath = process.env.APPIMAGE || process.execPath;
        fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
        fs.writeFileSync(
          desktopPath,
          [
            '[Desktop Entry]',
            'Type=Application',
            'Name=Pilot',
            `Exec="${execPath}"`,
            'X-GNOME-Autostart-enabled=true',
            '',
          ].join('\n'),
          'utf8',
        );
      } else {
        fs.rmSync(desktopPath, { force: true });
      }
    } catch (err) {
      process.stderr.write(
        `[desktop] could not update autostart entry: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    return;
  }
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.runAtLogin });
  }
}

// ───────────────────────────────────────────────────────────────────────
// Window state persistence
// ───────────────────────────────────────────────────────────────────────

function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveWindowState(w) {
  if (!w || w.isDestroyed()) return;
  const bounds = w.getBounds();
  try {
    fs.mkdirSync(path.dirname(WINDOW_STATE_PATH), { recursive: true });
    fs.writeFileSync(
      WINDOW_STATE_PATH,
      JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
      'utf8',
    );
  } catch {
    /* best-effort */
  }
}

// ───────────────────────────────────────────────────────────────────────
// Live daemon state
// ───────────────────────────────────────────────────────────────────────

let daemon = null; // ChildProcess from fork()
let pairPort = null;
let apiToken = null;

function readTokenFromDisk() {
  try {
    apiToken = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch (err) {
    process.stderr.write(
      `[desktop] could not read token at ${TOKEN_PATH}: ${err instanceof Error ? err.message : err}\n`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────
// Start the daemon (fork daemon.cjs)
// ───────────────────────────────────────────────────────────────────────

// Auto-restart backoff shared across startDaemon calls: 2s, 4s, 8s, 16s, 32s.
// Reset once a daemon reaches 'ready' so a later crash starts the ladder over.
let restartAttempts = 0;

async function startDaemon() {
  const cliDist = getCliDistPath();
  const sharedDist = getSharedDistPath();

  // daemon.cjs handles its own module resolution (dev vs prod).
  // We just pass the paths via environment variables and fork.

  return new Promise((resolve, reject) => {
    // Capture the child locally: after a settings restart the old child's
    // late 'exit'/'message' events must not clobber the new daemon's state.
    const child = fork(DAEMON_ENTRY, [], {
      env: {
        ...process.env,
        PILOT_PORT: String(settings.port),
        PILOT_BIND: settings.bind,
        PILOT_NAME: settings.name,
        PILOT_FS_ROOT: settings.fsRoot,
        PILOT_CLI_DIST: cliDist,
        PILOT_SHARED_DIST: sharedDist,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    daemon = child;

    // Forward stdout/stderr for dev visibility.
    child.stdout?.on('data', (buf) => process.stdout.write(`[daemon] ${buf}`));
    child.stderr?.on('data', (buf) => process.stderr.write(`[daemon] ${buf}`));

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (daemon !== child) return; // stale child from a previous restart
      switch (msg.type) {
        case 'ready':
          pairPort = msg.port;
          restartAttempts = 0;
          readTokenFromDisk();
          // Notify renderer.
          if (win && !win.isDestroyed()) {
            const currentUrl = win.webContents.getURL();
            if (currentUrl.includes('loading.html') || currentUrl === 'about:blank') {
              win.loadFile(path.join(__dirname, 'app.html'));
            }
            win.webContents.send('pilot:daemon-ready');
          }
          resolve();
          break;
        case 'error':
          reject(new Error(msg.message || 'daemon startup failed'));
          break;
        case 'log':
          // Logs already forwarded via stderr above; suppress info in prod.
          break;
        case 'exiting':
          pairPort = null;
          apiToken = null;
          if (win && !win.isDestroyed()) {
            win.webContents.send('pilot:daemon-down');
          }
          break;
        default:
          break;
      }
    });

    child.on('exit', (code) => {
      // Intentional shutdowns (settings restart, quit) null/replace `daemon`
      // before the child exits — only the current daemon's death matters.
      if (daemon !== child) return;
      daemon = null;
      pairPort = null;
      apiToken = null;
      closeAllTerms();
      // Unexpected exit: auto-restart with exponential backoff while the
      // window is still open and we're not quitting.
      if (win && !win.isDestroyed() && !app.isQuitting) {
        if (win.webContents.getURL().includes('loading.html')) {
          // Daemon failed before ever becoming ready.
          win.loadURL(
            'data:text/html,' +
              encodeURIComponent(
                `<body style="background:#0f1115;color:#e5e7eb;font-family:system-ui;padding:32px">
                 <h2>Daemon failed to start (exit ${code}).</h2>
                 <p>Make sure <code>pnpm --filter @pilot/cli build</code> has been run,
                 and that <code>@electron/rebuild</code> has rebuilt native modules.</p></body>`,
              ),
          );
        } else {
          win.webContents.send('pilot:daemon-down');
          restartAttempts++;
          if (restartAttempts <= 5) {
            const delay = Math.min(2000 * Math.pow(2, restartAttempts - 1), 32000);
            setTimeout(() => {
              if (!daemon && win && !win.isDestroyed() && !app.isQuitting) {
                startDaemon().catch(() => {});
              }
            }, delay);
          }
        }
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// Tray icon
// ───────────────────────────────────────────────────────────────────────

let tray = null;
let win = null;

function createTray() {
  // Create a simple 16x16 icon programmatically (a filled circle).
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = 5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;
      if (dist <= r) {
        canvas[i] = 0;
        canvas[i + 1] = 0;
        canvas[i + 2] = 0;
        canvas[i + 3] = 255;
      } else if (dist <= r + 1) {
        const alpha = Math.round(255 * (r + 1 - dist));
        canvas[i] = 0;
        canvas[i + 1] = 0;
        canvas[i + 2] = 0;
        canvas[i + 3] = alpha;
      }
    }
  }
  const img = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  const trayIcon = img.resize({ width: 16, height: 16 });

  // Template images are macOS-only — they auto-adapt to light/dark mode.
  if (process.platform === 'darwin') {
    trayIcon.setTemplateImage(true);
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Pilot');
  tray.on('click', () => {
    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    if (win.isVisible()) {
      win.focus();
    } else {
      win.show();
      win.focus();
    }
  });

  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Pilot',
      click: () => {
        if (!win || win.isDestroyed()) createWindow();
        else {
          win.show();
          win.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Run at Login',
      type: 'checkbox',
      checked: settings.runAtLogin,
      click: (item) => {
        settings.runAtLogin = item.checked;
        saveSettings(settings);
        syncRunAtLogin();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Pilot',
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

// ───────────────────────────────────────────────────────────────────────
// Window
// ───────────────────────────────────────────────────────────────────────

function createWindow() {
  const saved = loadWindowState();

  win = new BrowserWindow({
    x: saved?.x,
    y: saved?.y,
    width: saved?.width ?? 560,
    height: saved?.height ?? 820,
    minWidth: 460,
    minHeight: 580,
    title: 'Pilot',
    backgroundColor: '#0f1115',
    // Frameless-style chrome is macOS-only; Windows/Linux get a normal
    // title bar (these options are ignored there, but be explicit).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 18 } }
      : {}),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.loadFile(path.join(__dirname, 'loading.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Debounced window position save.
  let saveTimeout;
  const debouncedSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveWindowState(win), 500);
  };
  win.on('resize', debouncedSave);
  win.on('move', debouncedSave);

  // macOS/Windows: hide instead of close (live in the tray). NOT on Linux —
  // GNOME has no tray by default, so a hidden window would be unrecoverable;
  // there, closing the window quits (via window-all-closed below).
  if (process.platform !== 'linux') {
    win.on('close', (e) => {
      if (!app.isQuitting) {
        e.preventDefault();
        win.hide();
      }
    });
  }

  win.on('closed', () => {
    saveWindowState(win);
    win = null;
  });

  win.once('ready-to-show', () => {
    win.show();
  });
}

// ───────────────────────────────────────────────────────────────────────
// IPC: curated surface only. Token never leaves main.
// ───────────────────────────────────────────────────────────────────────

function ensureReady() {
  if (!pairPort || !apiToken) {
    throw new Error('Daemon not ready yet');
  }
  return { port: pairPort, token: apiToken };
}

async function daemonFetch(method, pathname, body) {
  const { port, token } = ensureReady();
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

ipcMain.handle('pilot:get-pairing-url', () => {
  if (!pairPort) throw new Error('Daemon not ready yet');
  return `http://localhost:${pairPort}/`;
});

ipcMain.handle('pilot:get-status', async () => {
  const res = await daemonFetch('GET', '/api/health');
  if (!res.ok) throw new Error(`/api/health status=${res.status}`);
  /** @type {any} */
  const json = await res.json();
  json.machineName = settings.name;
  return json;
});

ipcMain.handle('pilot:get-sessions', async () => {
  const res = await daemonFetch('GET', '/api/sessions');
  if (!res.ok) throw new Error(`/api/sessions status=${res.status}`);
  const body = /** @type {any} */ (await res.json());
  return body.sessions ?? [];
});

ipcMain.handle('pilot:close-session', async (_evt, id) => {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('invalid session id');
  }
  const res = await daemonFetch('DELETE', `/api/sessions/${id}`);
  if (res.status === 204) return true;
  if (res.status === 404) return false;
  throw new Error(`/api/sessions/${id} status=${res.status}`);
});

ipcMain.handle('pilot:rename-session', async (_evt, id, name) => {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('invalid session id');
  }
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    throw new Error('name must be 1–100 characters');
  }
  const res = await daemonFetch('PATCH', `/api/sessions/${id}`, { name: name.trim() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/sessions/${id} status=${res.status}`);
  const body = /** @type {any} */ (await res.json());
  return body.session ?? null;
});

// ──────────────────────────────────────────────────────────────
// Terminal bridge — the renderer never sees the token or the raw
// WebSocket. Main attaches to the daemon's /ws/pty and relays PTY
// bytes/control frames over IPC. Closing a bridge only detaches:
// the shell keeps running on the daemon for any device to resume.
// ──────────────────────────────────────────────────────────────

/** @type {Map<number, import('ws')>} termId → live socket */
const terms = new Map();
let nextTermId = 1;

function closeAllTerms() {
  for (const [id, sock] of terms) {
    try {
      sock.close();
    } catch {
      /* already gone */
    }
    terms.delete(id);
  }
}

ipcMain.handle('pilot:term-open', (evt, opts) => {
  const { port, token } = ensureReady();
  if (!opts || typeof opts !== 'object') throw new Error('invalid options');
  const { cwd, tool, sessionId, cols, rows } = opts;
  if (typeof cwd !== 'string' || !cwd) throw new Error('cwd required');
  if (typeof tool !== 'string' || !/^[a-z0-9-]+$/.test(tool)) throw new Error('invalid tool');
  if (sessionId != null && (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId))) {
    throw new Error('invalid session id');
  }

  const params = new URLSearchParams({
    cwd,
    tool,
    cols: String(Number.isInteger(cols) && cols > 0 ? cols : 80),
    rows: String(Number.isInteger(rows) && rows > 0 ? rows : 24),
  });
  if (sessionId) params.set('session', sessionId);

  const WebSocket = require('ws');
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws/pty?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const termId = nextTermId++;
  terms.set(termId, sock);

  const wc = evt.sender;
  const send = (channel, payload) => {
    if (!wc.isDestroyed()) wc.send(channel, termId, payload);
  };

  sock.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary frames are JSON control messages ({type:'session'|'exit'}).
      try {
        send('pilot:term-control', JSON.parse(data.toString('utf8')));
      } catch {
        /* malformed control frame — drop */
      }
    } else {
      send('pilot:term-data', data.toString('utf8'));
    }
  });
  sock.on('close', () => {
    terms.delete(termId);
    send('pilot:term-closed', null);
  });
  sock.on('error', (err) => {
    terms.delete(termId);
    send('pilot:term-control', {
      type: 'exit',
      exitCode: -1,
      signal: null,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return termId;
});

ipcMain.handle('pilot:term-input', (_evt, termId, data) => {
  const sock = terms.get(termId);
  if (!sock || typeof data !== 'string') return;
  try {
    sock.send(data);
  } catch {
    /* socket gone */
  }
});

ipcMain.handle('pilot:term-resize', (_evt, termId, cols, rows) => {
  const sock = terms.get(termId);
  if (!sock || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
  try {
    sock.send(JSON.stringify({ type: 'resize', cols, rows }));
  } catch {
    /* socket gone */
  }
});

ipcMain.handle('pilot:term-close', (_evt, termId) => {
  const sock = terms.get(termId);
  if (!sock) return;
  terms.delete(termId);
  try {
    sock.close();
  } catch {
    /* already gone */
  }
});

// ──────────────────────────────────────────────────────────────
// FS browser IPC — proxies to the daemon's /api/fs endpoint.
// ──────────────────────────────────────────────────────────────

ipcMain.handle('pilot:browse-fs', async (_evt, dirPath) => {
  const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
  const res = await daemonFetch('GET', `/api/fs${qs}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `FS browse failed (${res.status})`);
  }
  return /** @type {any} */ (await res.json());
});

// ───────────────────────────────────────────────────────────────────────
// Settings IPC
// ───────────────────────────────────────────────────────────────────────

ipcMain.handle('pilot:get-settings', () => {
  return { ...settings };
});

ipcMain.handle('pilot:set-settings', async (_evt, partial) => {
  const oldPort = settings.port;
  const oldBind = settings.bind;
  const oldName = settings.name;
  const oldFsRoot = settings.fsRoot ?? homedir();

  const updated = { ...settings };
  // Port 0 = ephemeral (OS picks), supported by the CLI.
  if (typeof partial.port === 'number' && Number.isInteger(partial.port) && partial.port >= 0 && partial.port <= 65535) {
    updated.port = partial.port;
  }
  if (typeof partial.bind === 'string' && partial.bind.length > 0) {
    updated.bind = partial.bind;
  }
  if (typeof partial.name === 'string' && partial.name.length > 0) {
    updated.name = partial.name.trim();
  }
  if (typeof partial.runAtLogin === 'boolean') {
    updated.runAtLogin = partial.runAtLogin;
  }
  if (typeof partial.fsRoot === 'string' && partial.fsRoot.length > 0) {
    updated.fsRoot = partial.fsRoot;
  }

  // Name is baked into the pairing QR, so a name change needs a restart too.
  const needsRestart =
    updated.port !== oldPort ||
    updated.bind !== oldBind ||
    updated.name !== oldName ||
    updated.fsRoot !== oldFsRoot;
  settings = updated;
  saveSettings(settings);

  syncRunAtLogin();
  updateTrayMenu();

  if (needsRestart) {
    // Shut down old daemon and start a new one. Wait for the old child to
    // actually exit first — it holds the port until then, and a same-port
    // restart (name/fsRoot change) would otherwise race into EADDRINUSE.
    closeAllTerms();
    if (daemon) {
      const old = daemon;
      daemon = null;
      pairPort = null;
      apiToken = null;
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            old.kill('SIGKILL');
          } catch {
            /* already gone */
          }
          resolve();
        }, 5000);
        old.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          old.send({ type: 'shutdown' });
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    try {
      await startDaemon();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[desktop] restart failed: ${msg}\n`);
      if (win && !win.isDestroyed()) {
        win.webContents.send('pilot:daemon-error', msg);
      }
      return { ...settings, needsRestart, error: msg };
    }
  }

  return { ...settings, needsRestart };
});

// ───────────────────────────────────────────────────────────────────────
// App lifecycle
// ───────────────────────────────────────────────────────────────────────

app.isQuitting = false;

app.whenReady().then(async () => {
  createWindow();
  createTray();

  syncRunAtLogin();

  // Start the daemon.
  try {
    await startDaemon();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[desktop] daemon startup failed: ${msg}\n`);

    if (msg.includes('EADDRINUSE')) {
      if (win && !win.isDestroyed()) {
        const result = await dialog.showMessageBox(win, {
          type: 'error',
          title: 'Port in use',
          message: `Port ${settings.port} is already in use.`,
          detail:
            'Another copy of Pilot or another program is using this port.\n\n' +
            'You can change the port in Settings, or stop the other program and restart Pilot.',
          buttons: ['Open Settings', 'Quit'],
          defaultId: 0,
        });
        if (result.response === 0) {
          win.loadFile(path.join(__dirname, 'app.html'));
          win.webContents.once('did-finish-load', () => {
            win.webContents.send('pilot:show-settings');
          });
          return;
        }
      }
    } else {
      // Generic failure
      if (win && !win.isDestroyed()) {
        win.loadURL(
          'data:text/html,' +
            encodeURIComponent(
              `<body style="background:#0f1115;color:#e5e7eb;font-family:system-ui;padding:32px">
               <h2>Daemon failed to start</h2>
               <p style="color:#9ca3af;max-width:420px;word-break:break-all">${escapeHtml(msg)}</p>
               <p style="margin-top:24px">Make sure <code>pnpm --filter @pilot/cli build</code> has been
               run, and that <code>@electron/rebuild</code> has rebuilt native modules.</p></body>`,
            ),
        );
      }
    }
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (win) {
      win.show();
      win.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  app.isQuitting = true;
  saveWindowState(win);
  closeAllTerms();
  if (daemon) {
    try {
      daemon.send({ type: 'shutdown' });
    } catch {
      /* already gone */
    }
    daemon = null;
    pairPort = null;
    apiToken = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
