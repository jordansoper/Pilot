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
