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

async function startDaemon() {
  const cliDist = getCliDistPath();
  const sharedDist = getSharedDistPath();

  // daemon.cjs handles its own module resolution (dev vs prod).
  // We just pass the paths via environment variables and fork.

  return new Promise((resolve, reject) => {
    daemon = fork(DAEMON_ENTRY, [], {
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

    // Forward stdout/stderr for dev visibility.
    daemon.stdout?.on('data', (buf) => process.stdout.write(`[daemon] ${buf}`));
    daemon.stderr?.on('data', (buf) => process.stderr.write(`[daemon] ${buf}`));

    daemon.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'ready':
          pairPort = msg.port;
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

    let restartAttempts = 0;
    daemon.on('exit', (code) => {
      pairPort = null;
      apiToken = null;
      if (daemon) {
        // Unexpected exit (intentional shutdown sets daemon=null before exit).
        // Auto-restart with exponential backoff: 2s, 4s, 8s, 16s, 32s max.
        // Only auto-restart if the window is still open and we're not quitting.
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
                if (win && !win.isDestroyed() && !app.isQuitting) {
                  startDaemon().catch(() => {});
                }
              }, delay);
            }
          }
        }
      }
      daemon = null;
    });

    daemon.on('error', (err) => {
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
        if (app.isPackaged) {
          app.setLoginItemSettings({ openAtLogin: settings.runAtLogin });
        }
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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 18 },
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

  // macOS: hide instead of close (consistent with tray behavior).
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

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

async function daemonFetch(method, pathname) {
  const { port, token } = ensureReady();
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
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

  const needsRestart = updated.port !== oldPort || updated.bind !== oldBind || updated.fsRoot !== (settings.fsRoot ?? homedir());
  settings = updated;
  saveSettings(settings);

  // Sync run-at-login (only in packaged/signed builds).
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.runAtLogin });
  }
  updateTrayMenu();

  if (needsRestart) {
    // Shut down old daemon and start a new one.
    if (daemon) {
      daemon.send({ type: 'shutdown' });
      daemon = null;
      pairPort = null;
      apiToken = null;
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

  // Login items require code signing — only set in packaged/signed builds.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: settings.runAtLogin });
  }

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
