# Project Plan — Pilot

> Pair your phone with your dev machines and run AI CLIs (and any shell) on
> them from anywhere. The computer runs a small daemon; the Android app is a
> remote terminal into it, reachable over your local Wi-Fi or over Tailscale.
>
> This document reflects **what is actually built today** and the roadmap from
> here. For per-OS gotchas and the manual acceptance checklist see
> [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md); for a file-by-file audit see
> [`BUILD_STATUS.md`](./BUILD_STATUS.md).

## 1. What Pilot is

A **daemon** (`pilot-cli`) runs on each computer you want to reach. A phone app
(`pilot-app`) pairs with it by scanning a QR code, then opens a terminal
(xterm.js) that streams a real PTY over a WebSocket. The shell lives on the
computer; the phone is a faithful, reconnecting view of it.

The eventual point is launching **AI CLIs** — freebuff, Claude Code, ollama —
in a chosen project folder from your phone. Today the plumbing is done and it
launches `bash`; the AI-tool launchers are the next step (§7).

## 2. Decisions locked in

| Area | Choice | Notes |
|---|---|---|
| Transport | **Tailscale + LAN**, no central server | Everything runs inside the user's own network. One pairing QR carries both the Tailscale IP and the LAN IP; the app uses whichever answers. |
| CLI runtime | **Node ≥ 20 + TypeScript** | Runs via `tsx` in dev, `node dist` in prod. (Bun was the original plan; Node won for `node-pty` stability.) |
| Android app | **React Native + Expo** (Android-first) | UI is lists/pickers + xterm.js in a `react-native-webview`. |
| Desktop app | **Electron** (`packages/desktop`) | Wraps the daemon in a window; scaffolded, not yet self-contained. §7 Phase D. |
| Terminal UI | **xterm.js in a WebView over WebSocket** | TUIs (Claude Code, etc.) are streamed faithfully as ANSI, not parsed into chat bubbles. |
| Sessions | **Persistent, server-side** | The PTY survives disconnects; the app re-attaches by id and replays scrollback. |

## 3. Architecture (as built)

```
┌──────────────────────────┐      LAN (same Wi-Fi)      ┌──────────────────────────┐
│  Android phone           │  ───── direct, fast ─────  │  Computer (Mac/Win/Linux)│
│  ┌────────────────────┐  │                            │  ┌────────────────────┐  │
│  │ Expo app           │  │   ── or ── Tailscale ───   │  │ pilot-cli (daemon) │  │
│  │  Machines          │──┼─────── (WireGuard) ────────┼──│  HTTP + WS on :7117 │  │
│  │  Sessions picker   │  │   HTTP  /api/health         │  │  SessionManager    │  │
│  │  Folder picker     │  │   HTTP  /api/sessions       │  │   └─ node-pty ×N   │  │
│  │  Terminal (xterm)  │  │   HTTP  /api/fs             │  │  loopback pair page │  │
│  └────────────────────┘  │   WS    /ws/pty (attach)    │  │  ~/.pilot/token     │  │
└──────────────────────────┘                            │  └────────────────────┘  │
                                                        └──────────────────────────┘
```

One QR pairs the machine. From then on the phone talks HTTP/WS directly to the
daemon over whichever path is up. No relay, no accounts, no server we operate.

## 4. Repo layout

pnpm monorepo (`node-linker=hoisted` — required for Expo/RN native builds):

```
pilot/
├── packages/
│   ├── shared/     # zod schemas + TS types — the single source of truth for the wire contract
│   ├── cli/        # pilot-cli daemon (Node + TS): server, sessions, launchers, pairing, token
│   ├── app/        # pilot-app (Expo / React Native, Android)
│   └── desktop/    # pilot-desktop (Electron scaffold) — launches the daemon + shows the QR
├── scripts/        # postinstall fixups (node-pty perms, Android prebuild patches)
├── PROJECT_PLAN.md · BUILD_STATUS.md · TROUBLESHOOTING.md
```

## 5. Wire contract (implemented)

All under `http://<host>:7117`, `Authorization: Bearer <token>` on everything
except the loopback pairing page. Schemas live in `@pilot/shared`.

| Endpoint | Status | Purpose |
|---|---|---|
| `GET /` (and `/pair`) | ✅ | Loopback-only HTML pairing page with a crisp SVG QR + the addresses it covers. 404 to non-loopback (the QR carries the token). |
| `GET /api/health` | ✅ | `{ version, uptimeMs, tailscaleIp, port }` — drives the online dot. |
| `GET /api/sessions` | ✅ | `{ sessions: [{ id, cwd, tool, createdMs, attached }] }` — the session picker. |
| `GET /api/fs?path=` | ✅ | `{ path, entries: [{ name, type }] }`. Allowlist rooted at `$HOME` (or `PILOT_FS_ROOT`); path-escape → 400. |
| `WS /ws/pty?cwd&tool&cols&rows[&session]` | ✅ | Bidirectional PTY. `session=<uuid>` re-attaches to a live session; otherwise a new one is created and its id is returned. Session/exit are **binary** control frames; PTY bytes are text. |
| `GET /api/tools` | ⛔ **not built** | Will report which launchers are installed. Blocks the tool picker (§7 Phase A). |

## 6. Pairing, sessions & security

**Pairing.** The daemon persists a 32-byte token at `~/.pilot/token` (0600) and
**reuses it across restarts** — pair once, it sticks. `pilot --rotate-token`
revokes and forces a re-pair. The QR encodes `{ version, host, hosts[], port,
token, name }`; `hosts[]` carries every reachable address so one code works on
LAN and Tailscale. The nicest way to pair is opening `http://localhost:7117/`
on the computer and scanning the on-screen QR.

**Sessions.** `SessionManager` owns each PTY plus a 256 KB scrollback ring. A
dropped socket **detaches** (the shell keeps running); the app reconnects with
backoff and re-attaches by id, and the daemon replays the buffer — you land
where you left off (Termux-style). Detached sessions are reaped after 30 min
idle or on shell exit (max 24). Multiple sessions per machine run concurrently.

**Threat model.** Anyone already on your tailnet/LAN who has the token can drive
the daemon; Tailscale ACLs / your LAN keep strangers out, the bearer token keeps
other devices from impersonating your phone. Cleartext HTTP is used **inside**
the already-encrypted Tailscale/LAN path (the Android release build must opt in
via `usesCleartextTraffic` — see TROUBLESHOOTING §5); a tighter network-security
config scoped to the tailnet + LAN is a future hardening (§7).

## 7. Roadmap

Status legend: ✅ done · 🟡 partial · ⛔ not started.

### Done (the working core)

- ✅ **Scaffold + CI** — pnpm monorepo, shared zod contract, typecheck/lint/test gates.
- ✅ **Vertical slice** — pair → persistent `bash` terminal, verified end-to-end on a real phone over both LAN and Tailscale.
- ✅ **Multi-machine** — the app stores N machines; delete asks for confirmation.
- ✅ **One-QR LAN + Tailscale** — app auto-selects the reachable address and shows which it used.
- ✅ **Persistent sessions** — background/return resumes the same shell with scrollback.
- ✅ **Multiple sessions per machine** — session picker: attach to a running shell or start a new one.
- ✅ **Folder picker** — browse the machine's dirs (`$HOME` allowlist) to choose where a new session launches.
- ✅ **Settings + Reset app**, back navigation (incl. Android hardware back), status-bar layout fix.

### Phase A — AI tool launchers (highest priority; delivers the original goal)

Right now only `bash` is registered. This is the step that makes Pilot *Pilot*.

- `cli`: register `claude`, `freebuff`, `ollama` launchers (each = binary + args + a `which`-style detection); implement `GET /api/tools`.
- `app`: a **tool picker** in the new-session flow (after the folder picker). `ollama` also needs a model input.
- Verify Claude Code's interactive first-run auth completes inside the PTY.

### Phase B — Terminal UX polish

- A **Ctrl / Alt / Esc / arrows** key toolbar above the terminal (these are painful on a phone keyboard).
- Copy/paste, and IME/height handling.
- **Bundle xterm.js** instead of loading it from a CDN, so the terminal works with no internet (pure tailnet/LAN).
- Session niceties: kill/rename a session from the app; configurable idle timeout.

### Phase C — CLI daemonization (headless)

- `pilot install` → LaunchAgent / systemd user unit / Windows Scheduled Task, so servers run the daemon at login. (Interactive desktops get this from Phase D instead.)
- Crash logs to `~/.pilot/log.jsonl`.

### Phase D — Desktop app (macOS + Windows; Linux best-effort)

Make `packages/desktop` a real, **self-contained** app so a non-technical user
never touches a terminal.

- **Today:** an Electron scaffold that spawns the daemon as a child process and shows the loopback pairing page in a window. Needs a Mac with a display to launch (the scaffold uses the system `node`).
- **To finish:** bundle its own Node runtime + `node-pty` (electron-rebuild) so no system Node is needed; tray / menu-bar lifecycle with run-at-login; a settings panel (port, name, **bind-to-Tailscale-IP by default**); a folder-access GUI for the FS allowlist; tool toggles; then **code-signing + notarization** and a single installer per OS (`.dmg`/`.pkg`, `.exe`/MSI, AppImage/`.deb`).
- **Watch out for:** the `node-pty` ABI under Electron, and port-7117 conflicts with a manually-run daemon (detect, don't crash on `EADDRINUSE`).
- **Done =** on a clean machine with no Node/pnpm/repo, install the signed app, launch it, toggle run-at-login, open the QR, add an allowed folder, and pair + drive a session from the phone — Tailscale the only other thing installed.

### Later / bigger picture

- **iOS app** — the codebase is Expo, so mostly a build target + UI testing away.
- **Tighter security** — network-security-config scoped to tailnet + LAN instead of blanket cleartext; an in-app "rotate token" button.
- **Transport fallback** — if Tailscale-as-a-prerequisite ever blocks adoption, add a relay + WebRTC path. The REST/WS contract is transport-agnostic, so this is localized.

## 8. Known constraints & gotchas

These bit us and are documented in [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md):

- **Default bind is `127.0.0.1`** — the phone can't reach loopback; run with `--bind 0.0.0.0` (the desktop app and the recommended commands already do). Making bind-to-Tailscale-IP the default is a Phase D item.
- **Android release builds block cleartext HTTP by default** — Pilot's build patches `usesCleartextTraffic=true` into the manifest (safe: the transport is already encrypted). This was the cause of a long "always offline" chase.
- **pnpm + `node-pty`** — the store drops the `+x` bit on the prebuilt `spawn-helper`; a `postinstall` restores it.
- **Expo + pnpm Android builds** need `node-linker=hoisted` plus post-prebuild patches (gradle-plugin resolution, splash color, cleartext) applied by `scripts/patch-android-prebuild.mjs`.
- **Use `start:dev`/`start`, not `dev`** for a long-running daemon — `tsx watch` restarts on workspace rebuilds.

## 9. What "great" looks like

In a coffee shop with Tailscale up (or on your home Wi-Fi, faster), you open
Pilot → tap your laptop → see your running sessions → resume the one where
Claude Code was mid-edit, or start a new one in `~/code/thing` → answer its
prompt → lock your phone, get home, reopen → the session is exactly where you
left it. Installing the daemon was a one-double-click app; you never opened a
terminal. That's the target.
