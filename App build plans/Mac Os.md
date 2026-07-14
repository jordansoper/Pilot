⬜ Electron desktop app launches daemon + shows pairing QR
	— `packages/desktop` (Phase 6 scaffold) spawns the pilot-cli daemon as a child
	  process and opens a BrowserWindow pointed at its loopback pairing page.
	  Architecture: daemon runs out-of-process via system `node` to avoid node-pty
	  native-ABI mismatch with Electron's Node. The window is 540×780 with a
	  centered QR code — scan it with the Pilot mobile app to pair.

⬜ Self-contained .app bundle (no system Node dependency)
	— Currently requires `node` on PATH (pnpm --filter @pilot/cli build first).
	  End goal: bundle Node runtime + node-pty prebuilt for Electron via
	  electron-rebuild so the .app is fully self-contained and portable.

⬜ Code signing + notarization for distribution
	— macOS Gatekeeper requires notarized apps. Need an Apple Developer account
	  ($99/yr), signing certificate, and `electron-notarize` in the build pipeline.
	  For .dmg/.zip distribution outside the App Store.

⬜ Mac App Store submission
	— Requires sandboxed entitlements, hardened runtime, and MAS-specific build.
	  Lower priority than direct .dmg distribution for dev-tool users.

⬜ Menu bar app (tray icon) + window lifecycle
	— Close button minimizes to menu bar (not quit). System tray icon with:
	  • Open Pilot (restore window)
	  • Quit Pilot (stop daemon + exit)
	— Default: open to sessions list, not the pairing screen (once paired).

⬜ Run at login (LaunchAgent)
	— `~/Library/LaunchAgents/com.pilot.daemon.plist` auto-starts the daemon at
	  login so it's ready before the desktop app launches. The app toggles this
	  via a "Run at Login" checkbox in Settings.

⬜ Session management (cross-device)
	— Multi-session per machine, background sessions survive disconnect.
	  Rename sessions (syncs to mobile), close sessions, refresh button.
	  Cross-device continuation: start on phone, pick up on Mac.

⬜ Settings panel
	— Port, bind address, machine name, FS root allowlist, rotate token,
	  Run at Login toggle. Port/bind changes restart the daemon with a
	  race-condition guard (wait for old daemon to release the port).

⬜ Auto-updates (electron-updater)
	— Check for updates on launch + periodically. Download in background,
	  prompt to install on next quit. Squirrel.Mac or DMG updater.

⬜ Universal binary (arm64 + x64)
	— Apple Silicon (M1/M2/M3) + Intel Mac support. `electron-builder` can
	  produce a universal .app that runs natively on both architectures.

---

## Build methods

### Development (from source)

```bash
# From repo root
pnpm --filter @pilot/shared build
pnpm --filter @pilot/cli build
pnpm --filter @pilot/desktop start
```

Launches Electron with the system `node` CLI daemon as a child process.
Requires Node ≥ 20 and pnpm ≥ 9.

### Production .app bundle (planned)

```bash
pnpm --filter @pilot/desktop build:mac     # produces dist/Pilot-*.dmg
pnpm --filter @pilot/desktop build:mac:mas # Mac App Store build
```

Not yet implemented — the desktop package only has a `start` script.
Will use `electron-builder` with:
- `electron-rebuild` for node-pty against Electron's Node ABI
- `electron-notarize` for Apple notarization
- `@electron/osx-sign` for code signing

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | ≥ 20 | `node --version` |
| pnpm | ≥ 9 | `pnpm --version` |
| Xcode Command Line Tools | latest | `xcode-select --install` |
| Python 3 | ≥ 3.9 | `python3 --version` (for node-pty native build) |

For distribution:
| Tool | Purpose |
|------|---------|
| Apple Developer account | Code signing + notarization ($99/yr) |
| electron-builder | Packaging .dmg/.zip |
| electron-notarize | Notarization API |

---

## Architecture

```
┌──────────────────────────────────────┐
│         Electron Main Process        │
│  (main.cjs)                          │
│                                      │
│  ┌──────────────┐  ┌───────────────┐ │
│  │ BrowserWindow│  │ child_process │ │
│  │ (pairing QR) │  │ (pilot-cli)   │ │
│  │ localhost:7… │  │ --bind 0.0.0.0│ │
│  └──────────────┘  └───────────────┘ │
└──────────────────────────────────────┘
         │                    │
         │ loopback HTTP      │ Tailscale IP
         ▼                    ▼
   [QR visible only      [Phone connects
    on this Mac]           over Tailscale]
```

The daemon runs as a separate process (not imported as a library) because:
1. `node-pty` has native bindings built for system Node, not Electron's Node ABI
2. Process isolation: daemon crash doesn't take down the UI
3. The daemon can outlive the desktop app (background mode)

---

## macOS-specific code considerations

### node-pty ABI mismatch

`node-pty` ships prebuilds for system Node. Electron bundles its own Node with a
different ABI. Two approaches:
1. **(Current)** Spawn daemon with system `node` — works but requires Node on PATH
2. **(Planned)** `electron-rebuild` to compile node-pty against Electron's Node ABI,
   then import `startServer()` directly → single self-contained .app

### Window lifecycle

macOS convention: closing the window (red X) hides the app, doesn't quit it.
Cmd+Q quits. The app should:
- `window.on('close')` → `event.preventDefault(); win.hide()` (minimize to tray)
- `app.on('before-quit')` → kill daemon, cleanup
- `app.on('activate')` → `win.show()` (dock click restores)

### Code signing entitlements

For notarization, the app needs the Hardened Runtime capability with these
entitlements:
```xml
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
<key>com.apple.security.cs.disable-library-validation</key><true/>
<key>com.apple.security.network.client</key><true/>
<key>com.apple.security.network.server</key><true/>
```
(`node-pty` and Electron need JIT + unsigned libs; the daemon listens on a port.)

### LaunchAgent plist

```xml
<!-- ~/Library/LaunchAgents/com.pilot.daemon.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pilot.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/Pilot.app/Contents/Resources/pilot-daemon</string>
    <string>--bind</string>
    <string>0.0.0.0</string>
    <string>--no-qr</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Toggle via the desktop app's Settings panel:
```bash
launchctl load ~/Library/LaunchAgents/com.pilot.daemon.plist    # ON
launchctl unload ~/Library/LaunchAgents/com.pilot.daemon.plist  # OFF
```

---

## Testing matrix

| Mac | Chip | macOS | Status |
|---|---|---|---|
| MacBook Air M2 | Apple Silicon | macOS 15 Sequoia | ⬜ Test |
| MacBook Pro M1 | Apple Silicon | macOS 14 Sonoma | ⬜ Test |
| Mac mini (Intel) | Intel x64 | macOS 14 Sonoma | ⬜ Test |
| MacBook Pro (Intel) | Intel x64 | macOS 13 Ventura | ⬜ Test |

### Key scenarios

| Scenario | Expected result |
|---|---|
| First launch (unpaired) | Shows pairing QR, scan with phone → paired |
| Re-launch (already paired) | Opens to sessions list, not pairing screen |
| Close window → reopen from dock | Window restores, daemon still running |
| Cmd+Q quit | Daemon killed, app exits cleanly |
| Phone opens session on Mac | Terminal appears, sessions list shows it |
| Rename session on Mac → check phone | Name syncs to mobile app |
| Rename session on phone → check Mac | Name syncs to desktop app |
| Daemon port already in use | Warn user, offer to kill old daemon |
| No internet / Tailscale down | Local LAN pairing still works |
| Notarized app launch | No Gatekeeper warning |

---

## Priority order

1. **Self-contained .app** — bundle Node + electron-rebuild node-pty so app runs without system Node
2. **Tray icon + window lifecycle** — close to tray, dock restore, Cmd+Q quit
3. **Session management** — open, rename, close, cross-device sync
4. **Code signing + notarization** — produce a distributable .dmg
5. **LaunchAgent (run at login)** — auto-start daemon
6. **Settings panel** — port, bind, name, fsRoot, rotate token
7. **Auto-updates** — electron-updater with Squirrel.Mac
8. **Universal binary** — arm64 + x64 in one .app
9. **Mac App Store submission** — sandboxed build for MAS

---

## Script reference

```bash
# Development
pnpm --filter @pilot/desktop start              # Launch Electron + daemon

# Build prerequisites
pnpm --filter @pilot/shared build               # Shared types
pnpm --filter @pilot/cli build                  # CLI daemon

# Production (planned)
pnpm --filter @pilot/desktop build:mac          # .dmg distribution
pnpm --filter @pilot/desktop build:mac:mas      # Mac App Store
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Daemon fails to start in Electron | node-pty built for system Node, not Electron's | Use system `node` to spawn daemon (current approach) or run `electron-rebuild` |
| "node: command not found" in packaged app | System Node not bundled | Bundle Node runtime in .app (see priority 1) |
| Gatekeeper blocks app on launch | Not notarized | Right-click → Open (first time only); long-term: notarize |
| App won't open after signing | Entitlements missing Hardened Runtime exceptions | Add `allow-unsigned-executable-memory` + `disable-library-validation` |
| Window opens to pairing screen every time | Not persisting paired state | Persist paired machines to `~/Library/Application Support/Pilot/` |
| Session closes when Mac sleeps | Daemon killed on sleep | Use `KeepAlive` in LaunchAgent; handle sleep/wake events |
