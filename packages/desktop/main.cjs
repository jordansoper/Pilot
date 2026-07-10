// Pilot desktop — Phase 6 scaffold.
//
// Architecture (deliberately the simplest thing that works): launch the
// existing pilot-cli daemon as a CHILD PROCESS and point a BrowserWindow at
// its loopback pairing page (http://localhost:<port>/). Spawning the daemon
// out-of-process — rather than importing startServer() into the Electron main
// — sidesteps the node-pty native-ABI mismatch (node-pty is built for the
// system Node, not Electron's), which is the right trade-off for a first cut.
//
// Known follow-ups before this is a shippable, self-contained app (see
// PROJECT_PLAN §9 Phase 6): bundle a Node runtime + electron-rebuild node-pty
// so it doesn't depend on a system `node`; tray/menu-bar lifecycle; run-at-
// login; settings + folder-access UI; code-signing / notarization.

const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const CLI_ENTRY = path.join(__dirname, '..', 'cli', 'dist', 'index.js');

let daemon = null;
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 540,
    height: 780,
    title: 'Pilot',
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'loading.html'));
  // Open pilot:// or external links in the OS, not inside this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });
}

function startDaemon() {
  // System `node` so node-pty (built for it) loads. Bind 0.0.0.0 so the phone
  // can reach the API over Tailscale; the pairing page stays loopback-only.
  daemon = spawn('node', [CLI_ENTRY, '--bind', '0.0.0.0', '--no-qr'], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let opened = false;
  daemon.stdout.on('data', (buf) => {
    const line = buf.toString();
    process.stdout.write(`[daemon] ${line}`);
    const m = line.match(/localhost:(\d+)\//);
    if (m && !opened && win) {
      opened = true;
      win.loadURL(`http://localhost:${m[1]}/`);
    }
  });
  daemon.stderr.on('data', (buf) => process.stderr.write(`[daemon] ${buf}`));
  daemon.on('exit', (code) => {
    if (!opened && win) {
      win.loadURL(
        'data:text/html,' +
          encodeURIComponent(
            `<body style="background:#0f1115;color:#e5e7eb;font-family:system-ui;padding:32px">
             <h2>Daemon failed to start (exit ${code}).</h2>
             <p>Make sure the CLI is built: <code>pnpm --filter @pilot/cli build</code>,
             and that <code>node</code> is on PATH.</p></body>`,
          ),
      );
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  startDaemon();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (daemon) {
    try {
      daemon.kill();
    } catch {
      /* already gone */
    }
  }
});
