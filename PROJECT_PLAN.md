# Project Plan — Remote CLI Connector

> Companion to `Remote cli tool android.md`. The spec's goal: a cross-platform CLI tool that pairs with an Android app so you can browse folders on your computer from your phone and launch AI CLIs (Freebuff, Claude Code, Ollama) against them in a chat-shaped interface. Multiple machines.

## 1. Decisions Locked In

| Area | Choice | Why |
|---|---|---|
| Transport | **Tailscale (with SSH-tunnel fallback)** | No central server to operate. Flat private network, encrypted, works behind any NAT. Android Tailscale client exists. |
| CLI tool | **Bun + TypeScript**, single binary | Fast iteration, first-class HTTP/WS, `--compile` for shipping. |
| Android app | **React Native + Expo** | UI is webby (lists, pickers, chat). xterm.js lives in a WebView. |
| v1 scope | **Thin vertical slice** | Pair one computer → pick a folder → launch Claude Code → terminal/chat in the app. |
| v1 chat UI | **xterm.js inside RN WebView**, piped over WebSocket | Claude Code is a TUI, not a chat API. Trying to parse its ANSI into chat bubbles is a losing game. |

## 2. Non-Goals for v1

- iOS build (Android only while we prove the loop).
- Public/internet-exposed access. Tailscale-only.
- Native RN chat-bubble UI for CLIs that are TUIs. Terminal emulator wins.
- Auto-update, crash reporting, telemetry beyond a basic logger.
- Encrypted-at-rest session history (we'll keep in-memory + temp files only v1).

## 3. Architecture (v1)

```
┌──────────────────────────┐                ┌──────────────────────────┐
│  Android Phone           │   Tailscale    │  Developer Machine       │
│  ┌────────────────────┐  │   (WireGuard)  │  ┌────────────────────┐  │
│  │ Expo App (RN)      │──┼────────────────┼──│ Bun CLI (daemon)   │  │
│  │  - Computer list   │  │   HTTP / WS    │  │  - HTTP /api/fs    │  │
│  │  - File picker     │  │   over         │  │  - WS /ws/pty      │  │
│  │  - AI picker       │  │   ts-net       │  │  - node-pty        │  │
│  │  - xterm.js WebView│  │                │  │     └─> claude,    │  │
│  └────────────────────┘  │                │  │         freebuff,   │  │
│  Tailscale Android app ──┼────────────────┼──│         ollama,     │  │
│  (gives phone a 100.x)   │                │  │         bash…       │  │
└──────────────────────────┘                │  └────────────────────┘  │
                                            │  Claude Code installed?  │
                                            └──────────────────────────┘
```

**Flow under Tailscale:**
1. User installs Tailscale on the phone + dev machine, logs into the same tailnet.
2. User runs the CLI on the dev machine. CLI prints a `tailscale ip` + port + a fresh token + a **QR code** containing `pilot://pair?host=100.x.y.z&port=7117&token=…`.
3. Android app scans QR → saves the machine as "paired".
4. App fetches `/api/fs?path=…` over Tailscale to browse folders.
5. User picks a folder + AI tool. App opens WS to `/ws/pty?cwd=…&tool=claude`.
6. CLI spawns the AI CLI via `node-pty` with chosen `cwd`. Bytes flow over WS to xterm.js in the app.

## 4. Components

### 4.1 `pilot-cli` (Bun + TypeScript)

A daemon the user runs on every machine they want to expose.

Responsibilities:
- Print a Tailscale IP and QR on startup.
- Serve `GET /api/fs?path=…` → `{ entries: [{ name, type, size, mtime }] }`. No write endpoints v1.
- Serve `GET /api/health` → version, uptime, detected AI tools installed.
- Serve `GET /api/tools` → list of AI launchers detected.
- Serve `WS /ws/pty?cwd&tool&cols&rows` → spawn the process via `node-pty`, pipe both directions.
- Run with `--port 7117` (default), `--bind 127.0.0.1` (Tailscale handles routing), `--no-qr` (headless).
- Auth: every request must present `Authorization: Bearer <token>` matching the token from the most recent startup QR.

Native deps:
- **node-pty** (PTY bridging)
- **qrcode-terminal** (QR for pairing)
- Optional: **@lydell/node-pty-prebuilt-multiarch** if `node-pty` prebuilts prove flaky. Decision noted in §7 risks.

### 4.2 `pilot-app` (Expo / React Native)

Screens (rough):
1. **Machines** — list of saved pairings, online/offline indicator, "+" FAB to add.
2. **Add Machine** — QR scanner (uses `expo-barcode-scanner` / `expo-camera`).
3. **File Picker** — tree fetched from `/api/fs`. Tap to enter folder. Long-press or tap ✓ to confirm.
4. **Tool Picker** — chips / list for claude, freebuff, ollama (only ones the CLI reported installed).
5. **Terminal** — a `react-native-webview` hosting `xterm.js`, pointing its `Terminal` at a `WebSocket` to `/ws/pty`.

State: AsyncStorage for paired machines. Tiny, no DB v1.

### 4.3 No central server

The whole product works inside the user's tailnet. There is no relay we operate. This is a major simplification: no accounts, no billing, no rate limiting, no GDPR surface. The price is requiring Tailscale as a precondition.

If that proves too heavy for users later, swap transport to a relay + WebRTC. The CLI+app contract (REST `/api/fs`, WS `/ws/pty`) is transport-agnostic, so this is a localized change.

## 5. Repos / Repo Layout

Monorepo so dev loops are simple. **pnpm workspaces** (works fine with Bun).

```
pilot/
├── packages/
│   ├── cli/                 # pilot-cli (Bun, builds to ./dist/pilot)
│   ├── app/                 # pilot-app (Expo)
│   └── shared/              # zod schemas + TS types shared by CLI & app
├── examples/
│   └── dev-tailscale-setup.md
├── pnpm-workspace.yaml
├── package.json
└── PROJECT_PLAN.md           # this file
```

`shared` exports:
- `PairingPayload` (zod): `{ version: 1, host, port, token, name }`
- `FsEntry`, `ToolInfo`, `PtyHello`
- Constants: `DEFAULT_PORT = 7117`, `WS_PATH = "/ws/pty"`, `FS_PATH = "/api/fs"`.

## 6. Pairing & Security

**v1 threat model:** an attacker who is *already on your tailnet* can drive your CLI. That's the bar. Tailscale ACLs are responsible for keeping strangers out; the per-session token is responsible for keeping other tailnet devices from impersonating your phone.

**Pairing flow:**
1. CLI generates a 32-byte token (`crypto.randomBytes`) on startup, prints a QR-encoded `pilot://pair?…` URL, and accepts a `--insecure-no-token` flag only for `pnpm dev` on localhost.
2. App scans QR, validates `PairingPayload` with zod, stores `{ id, name, host, port, token }` in AsyncStorage.
3. All HTTP/WS calls include `Authorization: Bearer <token>`. CLI rejects mismatches with 401.
4. Tokens rotate on every CLI restart. App detects 401 → marks machine offline + prompts re-pair.
5. **No token ever leaves the tailnet.** QR contains plaintext token; this is fine because the QR is over-the-shoulder only, and the whole transport is already encrypted by WireGuard.

## 7. AI Launcher Abstraction

A v1 launcher is just `{ id, bin, args, cwd, env, label, detectCommand }`.

Hardcoded in v1 (in `packages/cli/src/launchers/`):
- `claude` → `["claude"]`, detect via `which claude`
- `freebuff` → `["freebuff"]`, detect via `which freebuff` (placeholder until freebuff ships a CLI)
- `ollama-run` → `["ollama", "run", "<model>"]`, with `<model>` asked from user at tool-picker time
- `bash` → `["bash"]` (don't ship without this — needed to verify the PTY plumbing independently of any AI tool)

Each launcher is invoked inside a `node-pty` with `cwd = user-picked folder`. We do **not** try to parse the process output into structured chat messages. We just stream ANSI to xterm.js. v1 wins by routing TUIs faithfully.

## 8. APIs (v1 contract)

All under `http://<tailscale-ip>:7117`. Authorization header everywhere.

- `GET /api/health` → `{ version, uptimeMs, tailscaleIp, port }`
- `GET /api/tools` → `{ tools: [{ id, label, available }] }`
- `GET /api/fs?path=<absolute>` → `{ path, entries: [{ name, type: 'dir'|'file', size?, mtime? }] }`. 400 if `path` outside an allowlist rooted at `$HOME` (v1 safety net).
- `WS /ws/pty?cwd&tool[&model][&cols&rows]` → bidirectional PTY.

If we change any of these in v2 they only change inside `packages/shared`, both repos consume the zod schemas. Single source of truth.

## 9. Phases

### Phase 0 — Scaffold (½ day)
- pnpm workspace, `shared` package with zod schemas, empty `cli` + `app` packages that import from `shared`.
- CI: typecheck (`tsc --noEmit`), lint (`eslint`), test (`vitest` for `shared`).

### Phase 1 — Vertical slice, `bash` over Tailscale (the proof)
**Acceptance:** with Tailscale set up on phone+laptop, scanning the QR pairs the machine, tapping it opens a terminal running `bash`, typing `ls` twice returns output. No file picker, no AI yet.

Deliverables:
- `cli`: QR startup, `/api/health`, `/ws/pty` running `bash` via `node-pty`, bearer auth.
- `app`: Add Machine (QR scan), Machines list, Terminal screen with xterm.js WebView.
- `examples/dev-tailscale-setup.md` — 60-second Tailscale setup recipe for new contributors.

This phase exists to kill the Bun+node-pty risk in isolation.

### Phase 2 — File picker + Claude Code
- `cli`: `/api/fs`, allowlist, `/api/tools` with claude detection.
- `app`: File Picker screen, Tool Picker screen (Claude only).
- Launch `claude` in picked `cwd`.

### Phase 3 — Multi-machine
- App stores N machines, supports re-pair, shows offline on 401.
- CLI supports `--name "workstation-b"` so QR embeds a friendly name.

### Phase 4 — More tools
- `freebuff` launcher (gated on Freebuff's CLI landing).
- `ollama run <model>` launcher with model picker in app.

### Phase 5 — Daemonization & polish
- Optional `--install` flag on CLI: creates systemd user unit / LaunchAgent / Windows Scheduled Task. Sensible defaults; idempotent.
- Reconnect + keepalive on the WS.
- Tabs / multiple simultaneous sessions in app.
- Crash logs to disk on CLI side.

### Phase 6 — Desktop app (macOS + Windows, Linux best-effort)

**Goal:** a double-click, launchable desktop app that wraps `pilot-cli` so a
non-technical user never touches a terminal. It runs the daemon in the
background, lives in the menu bar / system tray, and gives a real UI for the
things you currently do with flags and env vars: pairing QR, settings, and
folder access. The CLI stays the source of truth for the wire protocol; the
desktop app is a front-end that manages a daemon, not a reimplementation.

**Why this is its own phase:** it's a new deliverable (a third client after
`cli` and `app`), it introduces desktop packaging/code-signing/notarization
work, and it should only start once the daemon's surface (Phases 2–4: `/api/fs`
allowlist, `/api/tools`, launchers) is stable enough to expose in a GUI.

**Scope (v1 of the desktop app):**
- **Launch & lifecycle.** Menu-bar (macOS) / system-tray (Windows) icon with
  Start/Stop, "run at login" toggle, and a status line (running/stopped,
  Tailscale up/down, N connected clients). Supersedes Phase 5's OS-level
  daemonization for interactive desktops; the CLI `--install` path stays for
  headless/Linux servers.
- **Pairing QR window.** Render the `pilot://pair` QR in a real window (not
  ASCII), with a "copy pair URL" button and a "regenerate token / re-pair"
  action. Shows which machine name + Tailscale IP it's advertising.
- **Settings.** Port, machine name, and **which interface to bind** — default
  to the discovered Tailscale IP (this is where the loopback-vs-Tailscale bind
  footgun gets solved with a sane default and an explanation, not a flag).
- **Folder access.** A GUI for the FS allowlist (Phase 2's `$HOME` /
  `PILOT_FS_ROOT`): add/remove allowed root folders via a native folder
  picker, so the phone can only browse what the user has granted. Closes the
  §11 "Filesystem scope" open question for the desktop case.
- **Tool toggles.** Enable/disable launchers (bash / claude / freebuff /
  ollama) and show which were auto-detected as installed.

**Tech decision — Electron (primary), Tauri (noted alternative).** The daemon
is already Node + native `node-pty`, so an Electron main process can import and
run the existing `startServer()` from `@pilot/cli` in-process and reuse the
`@pilot/shared` zod schemas and even React components. Tauri would give much
smaller binaries but forces the daemon to run as a spawned Node sidecar and
adds a Rust toolchain — revisit only if bundle size becomes a real complaint.
Lands as a new `packages/desktop/` in the monorepo.

**Risks specific to this phase:**
- **Code-signing & notarization.** macOS Gatekeeper needs a Developer ID +
  notarization; Windows needs an Authenticode cert or users hit SmartScreen.
  This is paperwork + CI work, not code — budget for it.
- **Bundling `node-pty`.** The native module must be packaged per-arch
  (electron-builder + the same prebuild/spawn-helper care as the CLI — see the
  `spawn-helper` execute-bit issue in TROUBLESHOOTING §3).
- **Two things that manage a daemon.** Make sure the desktop app and a manually
  run `pilot-cli` don't fight over port 7117 — detect and surface a conflict
  rather than crashing with `EADDRINUSE`.

**Definition of done:** on a clean Mac and a clean Windows box, install the
signed app, launch it from the Applications list / Start menu, toggle "run at
login", open the QR window, add an allowed folder, and pair + drive a `bash`
session from the phone — all without opening a terminal.

## 10. Risks (top 3)

1. **`node-pty` native compilation across Win/Mac/Linux from Bun** — historically flaky. **Mitigation:** prove Phase 1 on all 3 OSes on day 1. If Bun-side fails, fall back to `@lydell/node-pty-prebuilt-multiarch` or ship Node 20 LTS instead. The whole project hinges on this so we don't move on to Phase 2 until it works everywhere.
2. **Terminal UX inside a React Native WebView** — IME height, copy/paste, IME insertion of escape sequences, two-finger gestures. **Mitigation:** install `xterm.js` with `FitAddon` + `WebLinksAddon`, plus a custom "Ctrl/Alt" toolbar above the WebView. Expect iteration.
3. **Android networking over Tailscale** — Tailscale Android can go to sleep, killing sockets. **Mitigation:** app-side reconnect with backoff, plus a push of "open Tailscale app first" hint when 3+ reconnects fail.

## 11. Open Questions (revisit before Phase 5)

- **Multi-session UX.** Tabs, modal sheets, or one terminal = one screen with a back button?
- **Tabs in app drawer?** Adding Pilot alongside Tailscale as two apps feels clunky. Worth a `pilot://` deep-link from Tailscale?
- **Claude Code auth.** First-time `claude` login is interactive. Will it complete cleanly inside our PTY? Phrase 2 verification step.
- **Filesystem scope.** `$HOME` allowlist is v1 fine; do we eventually support arbitrary roots for headless / work machines?
- **Logging.** Ship with `--log-file ~/.pilot/log.jsonl`? Truncate policy? Sentry or not?

## 12. What "Done" for v1 Looks Like

Recording on a phone in a coffee shop, with Tailscale up, you can:
- Open Pilot → tap your laptop → navigate to `~/code/side-project/` → pick `claude` → ask "refactor this file" → see the diff appear in the terminal → answer a yes/no prompt Claude asks → close the app, walk home, reopen → the session is still there, scrolled to where you left it.

If we hit that, v1 ships; everything after is polish.
