// Pilot desktop — preload.
//
// The renderer is sandboxed (contextIsolation=true, nodeIntegration=false), so
// it cannot read files, make network requests, or see IPC channels directly.
// This preload exposes a tiny, locked-down `pilot` API via contextBridge —
// every method is a thin `ipcRenderer.invoke` shim, no raw access. The main
// process owns the bearer token and all daemon HTTP calls; the renderer only
// sees the curated result shapes.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pilot', {
  /**
   * The address the desktop window should iframe the pairing page from.
   * Loopback-only; the daemon refuses to serve it from any other interface.
   */
  getPairingUrl: () => ipcRenderer.invoke('pilot:get-pairing-url'),

  /**
   * Daemon meta for the status bar: version, uptime, tailnet IP, port,
   * machine name, reachable addresses. Re-fetched on each render.
   */
  getStatus: () => ipcRenderer.invoke('pilot:get-status'),

  /** Snapshot of live PTY sessions. Newest first. */
  getSessions: () => ipcRenderer.invoke('pilot:get-sessions'),

  /**
   * Ask the daemon to terminate a session by id. Returns `true` on a 204;
   * throws on any other response (caller renders the error).
   */
  closeSession: (id) => ipcRenderer.invoke('pilot:close-session', id),

  /**
   * Rename a session (PATCH /api/sessions/:id). Returns the updated
   * session snapshot, or null when the session no longer exists.
   */
  renameSession: (id, name) => ipcRenderer.invoke('pilot:rename-session', id, name),

  /**
   * Open a terminal bridge. Main attaches to the daemon's /ws/pty and
   * relays over IPC ('pilot:term-data' / 'pilot:term-control' /
   * 'pilot:term-closed', each prefixed with the returned termId).
   * Pass `sessionId` to re-attach to a live session; omit to start fresh.
   */
  termOpen: (opts) => ipcRenderer.invoke('pilot:term-open', opts),

  /** Write keystrokes to an open terminal bridge. */
  termInput: (termId, data) => ipcRenderer.invoke('pilot:term-input', termId, data),

  /** Propagate a viewport resize to the PTY. */
  termResize: (termId, cols, rows) =>
    ipcRenderer.invoke('pilot:term-resize', termId, cols, rows),

  /**
   * Close a terminal bridge. Detach-only: the shell keeps running on the
   * daemon so this (or any paired) device can re-attach later.
   */
  termClose: (termId) => ipcRenderer.invoke('pilot:term-close', termId),

  /** Read current settings (port, bind, name, runAtLogin). */
  getSettings: () => ipcRenderer.invoke('pilot:get-settings'),

  /**
   * Write settings. Accepts a partial object. Returns the merged result
   * plus a `needsRestart` flag. If port or bind changed, the main process
   * restarts the daemon automatically.
   */
  setSettings: (partial) => ipcRenderer.invoke('pilot:set-settings', partial),

  /**
   * Browse a directory on the host machine. Proxies to /api/fs?path=….
   * Returns `{ path, entries: [{ name, type }] }`.
   */
  browseFs: (dirPath) => ipcRenderer.invoke('pilot:browse-fs', dirPath),

  /**
   * Listen for main-process events (e.g. daemon-ready, show-settings).
   * Returns an unsubscribe function.
   */
  on: (channel, callback) => {
    const handler = (_evt, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
