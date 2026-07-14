⬜ Electron desktop app on Windows (same codebase as Mac)
	— `packages/desktop` is already cross-platform Electron. On Windows the same
	  `main.cjs` launches the daemon as a child process and opens a BrowserWindow
	  at the loopback pairing page. Requires `node` on PATH (or bundled Node).

⬜ Self-contained .exe installer (no system Node dependency)
	— Bundle Node runtime + node-pty compiled for Electron's Node ABI via
	  electron-rebuild. Distribute as NSIS or MSI installer. End state: user runs
	  `Pilot-Setup.exe`, gets a Start Menu shortcut, app just works.

⬜ Windows Taskbar / System Tray integration
	— Minimize to system tray (notification area) instead of taskbar. System tray
	  icon with right-click menu: Open Pilot, Quit. Single-click restores window.
	— Taskbar icon shows connection status (green dot = daemon running).

⬜ Auto-start with Windows
	— Register as a user-level startup app (registry `HKCU\Software\Microsoft\
	  Windows\CurrentVersion\Run`) or use a Scheduled Task trigger "At logon".
	  The desktop app's Settings panel has a "Run at Login" checkbox.

⬜ PowerShell / cmd / WSL terminal backends
	— Daemon spawns the user's preferred shell. Detect and use:
	  • PowerShell 7+ (pwsh.exe) if available
	  • Windows PowerShell 5 (powershell.exe) as fallback
	  • cmd.exe as last resort
	  • WSL (wsl.exe) if detected — spawn bash inside the user's default distro

⬜ Git Bash + ConPTY compatibility
	— Windows Terminal and ConPTY-enabled consoles work with node-pty's winpty
	  backend. Git Bash (MSYS2) can work but requires `winpty` agent. Known issues
	  documented in TROUBLESHOOTING.md § "Windows + Git Bash + ConPTY".

⬜ Session management (cross-device)
	— Multi-session per machine, background sessions survive disconnect.
	  Rename sessions, close sessions, refresh button.
	  Cross-device continuation: start on phone, pick up on Windows.

⬜ MSI / NSIS / portable packaging
	— NSIS installer (simple, customizable) or MSI (enterprise deployment via
	  Group Policy). Portable .zip for power users. All three from `electron-builder`.
	— Optionally distribute via `winget` (Windows Package Manager).

⬜ Settings panel
	— Port, bind address, machine name, FS root allowlist, rotate token,
	  Run at Login toggle, preferred shell (powershell/pwsh/cmd/wsl).

⬜ Auto-updates (electron-updater)
	— Squirrel.Windows or NSIS updater. Check for updates on launch + periodically.
	  Download in background, prompt to install on next quit.

---

## Build methods

### Development (from source)

```bash
# From repo root — requires Node ≥ 20, pnpm ≥ 9 on Windows
pnpm --filter @pilot/shared build
pnpm --filter @pilot/cli build
pnpm --filter @pilot/desktop start
```

### Production .exe installer (planned)

```bash
pnpm --filter @pilot/desktop build:win     # NSIS → dist/Pilot-Setup.exe
pnpm --filter @pilot/desktop build:win:msi # MSI   → dist/Pilot-*.msi
```

Will use `electron-builder` with:
- `electron-rebuild` for node-pty against Electron's Node ABI
- NSIS for simple installer or MSI for enterprise deployment
- Windows code signing certificate for SmartScreen trust

---

## Prerequisites

| Tool | Version | Check |
|------|---------|-------|
| Node.js | ≥ 20 | `node --version` |
| pnpm | ≥ 9 | `pnpm --version` |
| Visual Studio Build Tools | 2022 | Required for node-pty native compilation |
| Python 3 | ≥ 3.9 | `python --version` (for node-gyp) |

For distribution:
| Tool | Purpose |
|------|---------|
| Windows code signing cert | SmartScreen trust + no "unknown publisher" warning |
| electron-builder | Packaging .exe/.msi |
| NSIS (optional) | Custom installer UI |

---

## Architecture

Same as macOS — Electron main process spawns CLI daemon as child process,
shows pairing page in BrowserWindow. Key differences:
- Shell selection: prefers `pwsh.exe` → `powershell.exe` → `cmd.exe` → `wsl.exe`
- node-pty uses `winpty` agent on Windows for PTY emulation
- Daemon uses Windows-style paths (`C:\Users\...\.pilot\`)
- System tray uses `Tray` API (Windows native notification area)

---

## Windows-specific code considerations

### Shell detection

The `bash` launcher currently hardcodes `bash`. On Windows, the shell should be
detected from the environment and user preference:

```ts
function resolveShell(): { bin: string; args: string[] } {
  // User override
  if (process.env.PILOT_SHELL) return { bin: process.env.PILOT_SHELL, args: [] };
  // WSL (if installed — spawns bash inside default distro)
  // PowerShell 7+
  if (which('pwsh.exe')) return { bin: 'pwsh.exe', args: ['-NoLogo'] };
  // Windows PowerShell 5
  if (which('powershell.exe')) return { bin: 'powershell.exe', args: ['-NoLogo'] };
  // Fallback
  return { bin: 'cmd.exe', args: [] };
}
```

### ConPTY / winpty

node-pty on Windows uses the `winpty` agent for pseudo-terminal emulation.
Windows 10 1909+ and Windows 11 support ConPTY natively, which is faster and
more reliable. node-pty 1.x prefers ConPTY when available.

Issues with Git Bash: MSYS2's mintty terminal has its own PTY layer that
conflicts with winpty. Users should use Windows Terminal or ConPTY-enabled
consoles instead. See TROUBLESHOOTING.md for workarounds.

### Auto-start registration

Registry approach (most reliable on Windows):
```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  Pilot = "C:\Program Files\Pilot\Pilot.exe" --minimized
```

Or via Scheduled Task (more control over triggers):
```powershell
$action = New-ScheduledTaskAction -Execute "C:\Program Files\Pilot\Pilot.exe"
$trigger = New-ScheduledTaskTrigger -AtLogon
Register-ScheduledTask -TaskName "Pilot" -Action $action -Trigger $trigger
```

### File paths

Windows uses `%APPDATA%` instead of `~`:
- Token: `%APPDATA%\pilot\token`
- Lock file: `%APPDATA%\pilot\daemon.lock`
- Paired machines (desktop): `%APPDATA%\Pilot\machines.json`

### System tray

Windows notification area supports right-click context menus natively.
Electron's `Tray` API handles this. The tray icon should use a `.ico` file
with multiple sizes (16×16, 32×32, 48×48).

---

## Testing matrix

| Windows Version | Shell | Arch | Status |
|---|---|---|---|
| Windows 11 24H2 | Windows Terminal + pwsh 7 | x64 | ⬜ Test |
| Windows 11 23H2 | cmd.exe | x64 | ⬜ Test |
| Windows 10 22H2 | PowerShell 5 | x64 | ⬜ Test |
| Windows 10 22H2 | Git Bash (MSYS2) | x64 | ⬜ Test (edge case) |
| Windows Server 2022 | cmd.exe | x64 | ⬜ Test (headless) |

### Key scenarios

| Scenario | Expected result |
|---|---|
| First launch (unpaired) | Shows pairing QR, scan with phone → paired |
| Re-launch (already paired) | Opens to sessions list |
| Minimize to tray → restore | Window restores, daemon still running |
| Right-click tray → Quit | Daemon killed, app exits cleanly |
| Start with Windows (auto-start) | App minimized to tray on login |
| Shell: PowerShell 7 | PTY spawns pwsh.exe, works correctly |
| Shell: cmd.exe | PTY spawns cmd.exe, works correctly |
| Shell: WSL bash | PTY spawns wsl.exe, bash inside distro |
| Phone opens session on Windows | Terminal appears, sessions list shows it |
| Rename session on Windows → check phone | Name syncs to mobile app |
| Windows Terminal as host | ConPTY works, no rendering glitches |
| Git Bash as host | May need winpty tweaks (see TROUBLESHOOTING) |
| Installer: NSIS .exe | Installs to Program Files, Start Menu shortcut |
| Installer: MSI | Installs silently for enterprise deployment |
| Uninstall | Removes app, prompts to keep/delete user data |
| SmartScreen on first launch | Shows "Windows protected your PC" (until code-signed) |

---

## Priority order

1. **Shell detection** — `pwsh` → `powershell` → `cmd` → `wsl` fallback chain
2. **Self-contained .exe** — bundle Node + electron-rebuild node-pty
3. **System tray + window lifecycle** — minimize to tray, right-click quit
4. **Session management** — open, rename, close, cross-device sync
5. **NSIS installer** — simple .exe installer with Start Menu shortcut
6. **Auto-start** — registry Run key or Scheduled Task
7. **Code signing** — EV certificate for SmartScreen trust
8. **Auto-updates** — Squirrel.Windows via electron-updater
9. **MSI packaging** — enterprise deployment
10. **winget distribution** — `winget install Pilot`

---

## Script reference

```bash
# Development
pnpm --filter @pilot/desktop start              # Launch Electron + daemon

# Build prerequisites
pnpm --filter @pilot/shared build               # Shared types
pnpm --filter @pilot/cli build                  # CLI daemon

# Production (planned)
pnpm --filter @pilot/desktop build:win          # NSIS .exe installer
pnpm --filter @pilot/desktop build:win:msi      # MSI installer
pnpm --filter @pilot/desktop build:win:portable # Portable .zip
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| node-pty fails to compile | Missing VS Build Tools or Python | Install "Visual Studio Build Tools 2022" with "Desktop development with C++" and Python 3 |
| PTY output is garbled in Git Bash | mintty PTY conflicts with winpty | Use Windows Terminal or set `PILOT_SHELL=pwsh.exe` |
| "node: command not found" | Node not on PATH or not installed | Install Node ≥ 20, ensure it's in PATH |
| SmartScreen blocks installer | App not code-signed | Click "More info" → "Run anyway"; long-term: buy EV code signing cert |
| App shows "Offline" on release build | Windows Firewall blocking port 7117 | Add inbound rule: `netsh advfirewall firewall add rule name="Pilot" dir=in action=allow protocol=TCP localport=7117` |
| Daemon port conflict | Another process on 7117 | Use `--port` flag or kill conflicting process |
| Auto-start doesn't work | Registry key missing or path wrong | Verify `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Pilot` |
| System tray icon missing | Windows hides overflow area icons | Drag Pilot icon from overflow to visible area in taskbar settings |
