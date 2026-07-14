# Pilot desktop

The macOS (and Linux/Windows-best-effort) wrapper for the Pilot daemon.

## What it does

- Spawns `pilot-cli` as a child process (so `node-pty` keeps the system
  Node's ABI — no Electron-rebuild dance).
- Reads the bearer token from `~/.pilot/token` (created by the CLI) and exposes
  a small IPC surface to the renderer. The token never leaves the main
  process.
- Shows a tabbed UI: **Pair** (iframe to the loopback pairing QR page) and
  **Sessions** (live list with a Stop button that calls the
  `DELETE /api/sessions/:id` endpoint on the daemon).
- Mac-native chrome: hidden-inset title bar with traffic-light insets, system
  fonts, dark theme that matches the pairing page.

## Run it

The desktop app depends on the built CLI. The `start` script wires this up:

```bash
pnpm --filter @pilot/shared build
pnpm --filter @pilot/cli build
pnpm --filter @pilot/desktop start
```

`start` is also a single command that does the first two steps for you.

Prerequisites: `node` ≥ 20 on `PATH`, and a built `packages/cli/dist/`.

## Window

A 560 × 820 window opens. As soon as the daemon prints its
`http://localhost:<port>/` line, the loading state is replaced by the
**Pair / Sessions** tab UI.

## Architecture

```
┌──────────────────────────┐                ┌──────────────────────────┐
│  Renderer (sandboxed)    │  window.pilot   │  Electron main           │
│   app.html / app.js      │ ───────────────▶│  - spawns pilot-cli      │
│  No network access       │   ipcRenderer   │  - reads ~/.pilot/token  │
│  No fs access            │                 │  - calls daemon HTTP APIs │
│                          │                 │    /api/health, /api/     │
│  Tabs: Pair | Sessions   │                 │    sessions, DELETE /api/│
│  Status bar + polling    │                 │    sessions/:id          │
└──────────────────────────┘                └────────────┬─────────────┘
                                                          │
                                                          ▼
                                              ┌──────────────────────────┐
                                              │  pilot-cli (daemon)      │
                                              │  node-pty + HTTP + WS    │
                                              │  port 7117 (default)     │
                                              └──────────────────────────┘
```

The renderer's only network primitives are the four `window.pilot.*` methods
exposed by `preload.cjs`. Everything else — bearer auth, the filesystem
(`~/.pilot/token`), and HTTP to the daemon — stays in the main process.

## Known limits (follow-ups)

- Still uses the system `node` (a real release will bundle a Node runtime).
- No code-signing / notarization yet.
- Tray / run-at-login not wired.
- No settings panel yet (port / name / Tailscale bind default).
- Window position isn't remembered between launches.
