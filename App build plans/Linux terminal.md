⬜ Single terminal command to install all dependencies and run Pilot on Linux
	— One curl-pipe-bash or wget command that installs everything needed. Must handle: Node.js ≥ 20 (via nodesource or nvm fallback), pnpm, system dependencies (build-essential, python3, libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libgbm1 for Electron), Tailscale (if not already installed), then clone/install Pilot and set up the systemd user unit. See install command section below.

⬜ Pilot to be its own terminal app (like Warp)
	— The Electron desktop client IS the terminal. No external terminal needed. The app window hosts xterm.js sessions. Tabs for multiple sessions. The daemon runs as a child process managed by Electron's main process.

⬜ Snapshots active sessions when client is closed, so they reopen when restarted
	— Sessions are server-side (daemon owns the PTY), so closing the desktop window just detaches. On relaunch, the Sessions tab shows all running sessions — clicking Open re-attaches with full scrollback replay. No explicit "snapshot" step needed; persistence is inherent in the daemon's SessionManager.

⬜ Run at login (daemon auto-start)
	— systemd user unit at `~/.config/systemd/user/pilot-cli.service`. The desktop app can toggle this via a "Run at Login" checkbox (enables/disables the systemd unit with `systemctl --user enable/disable`). The daemon starts with the user session, before any GUI, so it's ready when the desktop app launches.

⬜ Bind to Tailscale IP by default (not 0.0.0.0)
	— Default bind address should be the Tailscale IP (100.x.y.z) when available, falling back to 0.0.0.0 if Tailscale isn't running. This is more secure than binding to all interfaces. Configurable in Settings.

⬜ Remove requirement for Tailscale — local LAN connection included
	— The daemon already advertises both LAN and Tailscale IPs in the pairing QR. For Linux, ensure the LAN IP discovery works across all common network managers (NetworkManager, systemd-networkd, netplan). The app auto-selects whichever address is reachable.

⬜ Packaging for Linux distros
	— AppImage (universal, no install needed), .deb (Debian/Ubuntu/Pop!_OS), and .rpm (Fedora/RHEL). The AppImage should be self-contained: bundles its own Electron + Node runtime + node-pty prebuild. The .deb and .rpm declare dependencies on system libs (libgtk-3-0, libnotify4, etc.) but bundle Node + the app.
	— Publish to a custom APT repo and COPR for auto-updates, or rely on Electron's built-in autoUpdater with a static file server.

⬜ Install command (one-liner)
	— Goal: a single command a user can paste into any Linux terminal to get Pilot running. Design:

```bash
curl -fsSL https://pilot.remarkablenerds.com/install.sh | bash
```

	The install script should:
	1. Detect distro (Debian, Ubuntu, Fedora, Arch, openSUSE) and install system deps with the native package manager
	2. Check for Node.js ≥ 20; if missing, install via nodesource (deb/rpm) or nvm
	3. Check for pnpm; if missing, `npm install -g pnpm@9`
	4. Check for Tailscale; if missing, install via the official Tailscale install script (`curl -fsSL https://tailscale.com/install.sh | sh`)
	5. Clone/download Pilot to `~/.local/share/pilot` (or install via npm/pkg if published)
	6. Run `pnpm install --prod` and build
	7. Install the systemd user unit so the daemon starts at login
	8. Start the daemon immediately
	9. Print the pairing QR URL (or instruct user to open the desktop app)

	Alternative for distros with native packages: the .deb/.rpm postinstall script does steps 6-8.

⬜ CLI-only mode (headless servers)
	— For servers without a display (no Electron), `pilot install` registers the systemd user unit. The daemon runs headless; pairing happens by opening `http://localhost:7117/` from another machine on the tailnet, or by running `pilot --pair` to print the QR to stdout for scanning. Crash logs go to `~/.pilot/log.jsonl`.

⬜ Window management
	— Close to tray (not quit) — clicking X minimizes to tray. Quit from tray menu or Ctrl+Q actually stops the daemon and exits.
	— Restore window geometry (size, position, maximized state) from last session.
	— Works on Wayland and X11. Electron's `--ozone-platform=wayland` flag for native Wayland support.

⬜ Settings panel
	— Port: change the daemon's listen port (restarts daemon)
	— Machine name: friendly name shown in the pairing QR (restarts daemon)
	— Bind address: Tailscale IP (default), 0.0.0.0, or custom IP
	— FS root: override the folder-browser allowlist (defaults to $HOME)
	— Run at Login: toggle the systemd user unit
	— Rotate token: revoke all pairings, mint a new token (requires re-pairing all devices)

---

## Linux-specific considerations

### Desktop environment compatibility

| DE | Tray support | Notes |
|---|---|---|
| GNOME 44+ | Needs AppIndicator extension | Standard GNOME Shell doesn't show XEmbed tray icons. Users must install `gnome-shell-extension-appindicator` or we ship a GNOME Shell extension. Alternatively, keep the window visible and use a "minimize to taskbar" approach. |
| KDE Plasma | Native XEmbed + SNI | Fully supported out of the box. |
| Xfce | Native XEmbed | Fully supported. |
| Cinnamon | Native XEmbed + SNI | Fully supported. |
| Sway (wlroots) | Via `tray` protocol | SNI-only; Electron tray works if `libappindicator3` is installed. |
| i3/bspwm | No tray | Fall back to window-always-visible mode. |

### Display server

- **X11**: Fully supported by Electron. No flags needed.
- **Wayland**: Electron 28+ supports Wayland natively with `--ozone-platform=wayland`. The AppImage should try Wayland first, fall back to X11. Known issue: `xdotool`-style window focusing doesn't work on Wayland — use the `xdg-activation` protocol instead.

### node-pty

- node-pty 1.x ships prebuilds for `linux-x64` and `linux-arm64` (glibc).
- **Alpine/musl**: no prebuild available — must compile from source. The install script should detect musl and install `build-base python3 make gcc`.
- The pnpm postinstall fix (`scripts/fix-node-pty-perms.mjs`) is required on Linux too — pnpm's store drops the `+x` bit on the `spawn-helper` binary.

### systemd user unit

The daemon runs as a user service (not system-wide), so it starts at login, survives logouts (if lingering is enabled), and the desktop app can control it without root.

```ini
# ~/.config/systemd/user/pilot-cli.service
[Unit]
Description=Pilot CLI daemon
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/share/pilot/pilot-daemon --port 7117 --no-qr
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

The desktop app's "Run at Login" toggle runs:
```bash
systemctl --user enable --now pilot-cli   # ON
systemctl --user disable --now pilot-cli  # OFF
```

### Single-instance lock (Linux-specific)

Electron's `app.requestSingleInstanceLock()` works on Linux. Additional checks:
- The daemon port (7117) should be checked before starting — if it's in use, warn the user and offer to kill the old daemon.
- Use a lock file at `~/.pilot/daemon.lock` with the PID, checked on daemon start.

### Auto-updates

- **AppImage**: use AppImageUpdate or `electron-updater` with a static file server. The AppImage itself can be self-updating.
- **deb/rpm**: rely on the APT/RPM repo for updates, or use `electron-updater` with the deb/rpm provider.
- **Security**: auto-update checks should happen over HTTPS. The update server should sign releases.

### Testing matrix

| Distro | DE | Display | Status |
|---|---|---|---|
| Ubuntu 24.04 LTS | GNOME 46 | Wayland | ⬜ Test |
| Ubuntu 24.04 LTS | GNOME 46 | X11 | ⬜ Test |
| Fedora 40 | GNOME 46 | Wayland | ⬜ Test |
| Debian 12 | GNOME 43 | X11 | ⬜ Test |
| Arch Linux | KDE Plasma 6 | Wayland | ⬜ Test |
| Linux Mint 22 | Cinnamon | X11 | ⬜ Test |
| Alpine Linux 3.20 | Sway | Wayland | ⬜ Test (musl) |

---

## Priority order (what to build first)

1. **CLI daemon on Linux** — already works. Verify smoke test passes on Ubuntu 24.04.
2. **systemd user unit + `pilot install`** — enables headless server use. The one-liner install command depends on this.
3. **One-liner install command** — `curl -fsSL https://pilot.remarkablenerds.com/install.sh | bash`. This is the primary distribution channel for Linux.
4. **Electron desktop app on Linux** — port the Mac desktop app to Linux. Most code is shared; the Linux-specific parts are tray (AppIndicator), systemd integration, and packaging.
5. **Session management features** — Open, Rename, New Session, cross-device continuation. Same as Mac.
6. **AppImage packaging** — self-contained, no-install distribution.
7. **deb/rpm packaging** — for distro-native install + auto-updates.
8. **Testing matrix** — run through all distro/DE/display combos.
9. Pilot help menu to show all availible commands

---

## Notes from Mac build review (things to carry over)

From the 2026-07-11 Mac build review:
- Daemon-restart race: when changing settings (port, name, bind), wait for the old daemon to release the port before starting the new one. The Mac fix applies identically on Linux.
- Machine-name changes must restart the daemon (QR embeds the name, would be stale otherwise).
- Auto-restart backoff must actually back off across restarts (attempt counter resetting bug fix applies to Linux).
- Renderer terminal never sees the auth token: main process bridges /ws/pty over IPC.
- `resolveDist()` in daemon.cjs needs a correct dev fallback path — same issue on Linux.
- `node_modules/electron/path.txt` trailing newline fix applies.
