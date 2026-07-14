# Pilot — Troubleshooting & Manual Acceptance

Runbook for **Phase 1** sign-off plus a backlog of known platform-specific
issues we've already hit during development.

> See [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) for the architecture and
> [`README.md`](./README.md) for the dev loop.

---

## 1. Phase 1 manual sign-off checklist

These are the exact steps a contributor runs on their dev machine to
declare Phase 1 done. Replace `~/src/pilot` with your clone path.

```bash
git clone <repo> ~/src/pilot
cd ~/src/pilot

pnpm install                              # ~30 s
pnpm --filter @pilot/shared build         # builds dist/ for cli + app to import
pnpm --filter @pilot/cli smoke            # in-process daemon + bash round-trip
                                          # EXPECTED: "[smoke] PASS — bash echoed ...
                                          #          and bad-auth was rejected"

# On a Tailscale-attached machine, start the real daemon.
pnpm --filter @pilot/cli -- pilot --port 7117

# Scan the printed QR from a Tailscale-attached phone (or paste the URL
# into the app's manual-entry box on the AddMachine screen).
#  - Machines list should show the new row with an online dot
#  - Tap → Terminal → cwd /tmp → confirm bash prompt renders
#  - `echo hi` should round-trip back through xterm

# To exercise the dev build on Android:
pnpm --filter @pilot/app android
```

A run is GREEN when:

- `pnpm install` completes without `node-pty` or `react-native-webview`
  postinstall errors
- `pnpm --filter @pilot/cli smoke` prints `PASS`
- The app renders all three screens and the bash round-trip works
- Long-pressing a machine removes it from the list

Anything else is a bug — capture it below and file an issue.

---

## 2. Per-OS quick notes

### macOS

Happy path. `process.env.SHELL` resolves to `/bin/zsh` (or `/bin/bash`),
`pnpm install` builds node-pty cleanly, the smoke `bash` PTY round-trips
in under a second. Apple-Silicon cross-compilation works because
node-pty 1.x ships prebuilt binaries for `darwin-arm64` and `darwin-x64`.

If `pnpm install` complains about Xcode CLI tools:

```bash
xcode-select --install
```

### Linux

Happy path on most distros. node-pty 1.x ships Linux prebuilds for
`x64` and `arm64` glibc. If you're on Alpine / musl: install `build-base`
+ `python3` and let node-pty compile from source.

### Windows

The Phase 1 daemon runs on Windows but has two real pitfalls. See §3
below for the Git Bash friction. Quick rough edges:

- `pnpm install` requires **Visual Studio Build Tools** (C++ workload)
  for `node-pty` to compile if no Windows prebuild is found.
- Android `usesCleartextTraffic` is already on (see `packages/app/app.json`)
  so Tailscale IP fetches work.
- The `usesCleartextTraffic=true` only enables `http://` to RFC1918/loopback
  Tailscale IPs (100.x); do NOT use it for production endpoints.
- **Firewall prompt on first launch**: the daemon binds `0.0.0.0`, so
  Windows Defender Firewall asks to allow inbound access. This must be
  **allowed** (at least on Private networks) or the phone can never reach
  the daemon — pairing will scan fine and then time out, with no other
  error. If the prompt was dismissed: Windows Security → Firewall &
  network protection → Allow an app through firewall → tick Pilot.
- The default `bash` tool spawns **PowerShell** on Windows (the wire id
  stays `bash` for app compatibility).

---

## 3. Known issues

| Symptom | OS / env | Cause | Workaround |
|---|---|---|---|
| `pnpm --filter @pilot/cli smoke` reports `0 chunks from PTY` | Windows + Git Bash | `bash -l` sources shell init files via ConPTY; bash.exe in Git Bash doesn't emit anything back through ConPTY in this build within 60 s | Use macOS/Linux for the dev box; or use `cmd.exe`/PowerShell Phase 2 launchers; or set `PILOT_NO_LOGIN=1` if you add that env knob later |
| `pnpm --filter @pilot/cli smoke` reports `0 chunks from PTY` (also seen as `Error: posix_spawnp failed` when node-pty is called directly) | macOS / Linux + **pnpm** | pnpm's content-addressable store drops the `+x` bit on node-pty's prebuilt `prebuilds/<os-arch>/spawn-helper`. node-pty fork-execs that helper to launch the shell, so with mode 644 every spawn fails silently and the PTY emits nothing | Handled automatically: the root `postinstall` runs `scripts/fix-node-pty-perms.mjs` which restores `+x`. If you bypass postinstall (`pnpm install --ignore-scripts`), run `node scripts/fix-node-pty-perms.mjs` by hand |
| `bash: command not found` when smoke runs | Windows | `bash` not on PATH (Git Bash ships it inside the install dir) | Add `<Git>\usr\bin` to PATH, or `pnpm install` inside Git Bash itself |
| Expo bundler fails on Metro cache mismatch after dependency change | any | Stale `.expo` cache | `pnpm --filter @pilot/app clean && rm -rf .expo && pnpm --filter @pilot/app android` |
| App shows "Offline" even though daemon is up | any | Reachability: (a) daemon bound to `127.0.0.1` — the phone can't reach loopback over Tailscale, use `--bind 0.0.0.0`; (b) phone's Tailscale asleep/disconnected; (c) a genuinely wrong host | Isolate with the phone's browser → `http://<tailscale-ip>:7117/api/health`: a **401 page = reachable** (app-side issue), a **timeout = routing** (reconnect Tailscale on the phone). Daemon must run with `--bind 0.0.0.0`. |
| QR scanned but app says "payload rejected" | any | Pilot CLI version drift on the daemon side | Confirm `@pilot/shared` is the same version on both machines |
| App paired fine, now shows Offline / `401` / "cannot open terminal websocket" after the daemon restarted | any | **Historically:** each daemon start minted a fresh `crypto.randomBytes(32)` token, invalidating saved pairings. Especially bad under `tsx watch` (the `dev` script), which restarts — and rotates — on any workspace rebuild | **Fixed:** the token now persists to `~/.pilot/token` and is reused across restarts (see `packages/cli/src/token.ts`). Pair once. Use `pilot --rotate-token` to deliberately revoke + re-pair. Still prefer `start:dev`/`start` over `dev` for a long-running daemon so it isn't reloading. |
| `pilot-cli.service` crash-loops under systemd with `SystemError [ERR_SYSTEM_ERROR]: uv_interface_addresses returned Unknown system error 97` | Linux + systemd `--user` unit | `os.networkInterfaces()` (used to find LAN IPs for the QR) needs an `AF_NETLINK` socket. The unit's `RestrictAddressFamilies=` sandbox only allowed `AF_INET AF_INET6 AF_UNIX`, so the kernel EAFNOSUPPORTs it. Runs fine invoked manually — only breaks once systemd-managed | **Fixed in `install.sh`** (`generate_systemd_unit`) — `AF_NETLINK` added to the allow-list. If you hand-rolled a unit from the example below, add it too. |
| Daemon works all session, then goes Offline with no crash in the journal after you log out / close the SSH session | Linux, systemd `--user` unit | Without `loginctl enable-linger <user>`, systemd kills the *entire* user instance (and everything in it) when the last login session for that user ends — `systemctl --user enable` alone does not survive logout | **Fixed in `install.sh`** — runs `loginctl enable-linger` after installing the unit. For an existing install: `loginctl enable-linger $(whoami)`, then `systemctl --user restart pilot-cli`. Verify with `loginctl show-user $(whoami) | grep Linger` (should read `Linger=yes`). |
| `curl -fsSL https://pilot.remarkablenerds.com/install.sh \| bash` fails to resolve, or `git clone https://github.com/jordansoper/Pilot.git` 404s | any (fresh install) | Both are the script's *documented defaults*, but neither is actually published/live yet — `pilot.remarkablenerds.com` doesn't resolve and the GitHub repo isn't public | Not yet fixable in the script itself (needs the domain + repo to actually exist). Until then: download `install.sh` directly from your working copy and run it with `PILOT_REPO_URL` pointed at a reachable clone (SSH remote, a private token URL, or a local path — see the "non-empty directory" fix above, which lets you `rsync` a source tree into `$PILOT_HOME` and run the script against it instead of cloning) |
| `git clone` step fails with `destination path already exists and is not an empty directory` | any | `PILOT_HOME` already has files (e.g. you `rsync`'d a source tree there instead of cloning) but no `.git`, so the script's clone-vs-pull check didn't recognize it as "already installed" | **Fixed in `install.sh`** (`install_pilot`) — a non-empty, non-git `PILOT_HOME` is now detected and the script builds in place instead of trying to clone over it |
| Installer hangs indefinitely with no output during the clone/pull step | any, private repo over HTTPS without cached credentials | `git` was waiting on an interactive username/password prompt that can never be answered (`curl \| bash` has no TTY for it) | **Fixed in `install.sh`** — `GIT_TERMINAL_PROMPT=0` is now set globally, so git fails fast with an auth error instead of hanging |
| `sudo: command not found` (installer dies partway through system deps) | Minimal/rootless containers without `sudo` installed | `run_pkg_install` assumed `sudo` exists whenever not running as root | **Fixed in `install.sh`** — `run_pkg_install` now checks for `sudo` first and dies with a clear message ("re-run as root or install sudo") instead of a raw `command not found` |

### Windows + Git Bash + ConPTY (deep dive)

Repro path observed during development:

```
$ pnpm --filter @pilot/cli smoke
[smoke] listening on 127.0.0.1:55897
[smoke] /api/health OK: { version: '0.0.0', uptimeMs: 272, tailscaleIp: null, port: 55897 }
[smoke] FAIL — marker not seen after 60s — captured 0 chars (0 chunks) from PTY
```

What we learned:

- The HTTP+WS handshake works (server is bound, /api/health returns,
  WS upgrade passes auth, `bash` is invoked via `pty.spawn('bash',
  ['-l'], …)` without throwing).
- `term.onData(…)` never fires in 60 s. Either ConPTY on this Windows
  build never pipes bash's stdout back to the WS server, or `bash -l`
  is stuck sourcing init files for >60 s in this env.

What works:

- `/api/health`, `/ws/pty` upgrade, and WS auth (verified in the smoke).
- `bash -l` on macOS / Linux (verified by the same smoke at the top of
  the file).

Recommended next steps to make Windows work:

1. Add Phase 2 launchers `cmd` and `powershell` so Windows users have
   plainer options until Git Bash on ConPTY catches up.
2. Make the bash launcher's `-l` flag configurable per-launch (env var
   `PILOT_NO_LOGIN=1`) so smoke / Windows users can opt out of the login
   splash.
3. If neither works, document "Windows bash-via-ConPTY is currently
   flaky; use WSL or a Mac/Linux dev box" in the README.

---

## 4. Daemonization (Phase 5 preview)

Phase 5 will add `pilot install` to register the daemon with the OS.
Below are the equivalents right now, in case you want Phase 1 to start
on login before `pilot install` lands.

### macOS — LaunchAgent (`~/Library/LaunchAgents/com.pilot.cli.plist`)

Build the CLI first (`pnpm --filter @pilot/shared build && pnpm --filter @pilot/cli build`) so the daemon runs from the compiled `dist/`, not `tsx` watch mode:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.pilot.cli</string>
  <key>WorkingDirectory</key><string>/Users/YOU/src/pilot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.local/share/pnpm/pnpm</string>
    <string>--filter</string><string>@pilot/cli</string>
    <string>start</string>
    <string>--</string>
    <string>--no-qr</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>StandardOutPath</key><string>/tmp/pilot-cli.log</string>
  <key>StandardErrorPath</key><string>/tmp/pilot-cli.err</string>
</dict>
</plist>
```

Find your pnpm path with `which pnpm` and substitute in `ProgramArguments`.
Load: `launchctl load -w ~/Library/LaunchAgents/com.pilot.cli.plist`.
Important: a LaunchAgent that starts before Tailscale is up will print a
`tailscaleIp: null` QR — the daemon restarts when Tailscale comes up
only if `KeepAlive` is `true`.

### Linux — systemd user unit (`~/.config/systemd/user/pilot-cli.service`)

Run the BUILT CLI from inside the workspace (build first with
`pnpm --filter @pilot/shared build && pnpm --filter @pilot/cli build`):

```ini
[Unit]
Description=Pilot CLI daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/src/pilot
ExecStart=%h/.local/share/pnpm/node_modules/@pilot/cli/dist/index.js --port 7117 --no-qr
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

After install: `systemctl --user daemon-reload && systemctl --user enable --now pilot-cli`.
Finding the exact `dist/index.js` path: `ls $(pnpm root)/@pilot/cli/dist/`.

**Note:** this hand-rolled example unit has none of the sandboxing (`RestrictAddressFamilies`,
`NoNewPrivileges`) that `install.sh`'s generated unit has, so it doesn't hit the
`AF_NETLINK` crash above — but it also won't survive logout without
`loginctl enable-linger $(whoami)`, same as the generated one.

#### `install.sh` audit — fixed vs. still open (2026-07-12)

Found while manually deploying to a fresh Debian box (`test-pilot`) end-to-end —
`install.sh`'s systemd path had never been exercised against a real sandboxed
unit before. All rows above marked "Fixed in `install.sh`" are applied on the
`main` branch script as of this audit. Still open, roughly in priority order:

1. **No published install entrypoint.** The header's `curl -fsSL https://pilot.remarkablenerds.com/install.sh | bash` one-liner and the default `PILOT_REPO_URL` (`https://github.com/jordansoper/Pilot.git`) both point at things that don't exist yet. Every real install today has to happen by hand (rsync/scp a source tree + run the script locally, as documented in the known-issues row above). Blocks calling this script "done" until the domain + repo are live.
2. **`build_pilot()` builds `@pilot/shared` twice.** `pnpm install`'s root `postinstall`/`prepare` already runs `tsc -b` for `packages/shared` (visible in its install output: `packages/shared prepare$ tsc -b`), then `build_pilot()` explicitly runs `pnpm --filter @pilot/shared build` again. Harmless (tsc is incremental) but redundant — worth trimming.
3. **No AI-agent / dev-tooling step.** The actual use case this box was set up for — pairing in, then using it as a real dev machine with Claude Code, Codex CLI, GitHub Copilot CLI, and Syncthing — has zero coverage in `install.sh`. Each of those had to be installed by hand this round. Worth a `--with-dev-tools` flag or a companion script, given `PILOT_HOME`/Node/pnpm setup is already done by this point.
4. **Node version ceiling mismatch.** `install_nodejs()` pins Node 20.x via NodeSource — matches this repo's own `.nvmrc`, but `@anthropic-ai/claude-code` wants Node ≥22 (installs and runs anyway on 20, just with an `EBADENGINE` warning). If the dev-tooling step above ever lands, it needs to either install a second Node via nvm for those CLIs or accept the warning explicitly.
5. **`git pull --ff-only` failure is silently swallowed.** If `$PILOT_HOME` is an existing git checkout with local changes or a diverged history, the pull fails, the script just `warn`s, and then happily builds whatever stale code is already checked out — with no indication to the user that they're not running what they think they're running.
6. **`main()`'s repo-reachability probe (`git ls-remote`) has no timeout.** It's meant to fail fast with a friendly warning when `PILOT_REPO_URL` is unreachable, but on a hung network path it can block for a long time before `install_pilot()`'s own clone attempt even starts. Worth `git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 ls-remote` or an explicit `timeout 10`.

### Windows — Scheduled Task (PowerShell)

Wrap the daemon in a tiny batch file so the task can keep it alive
(use `start` not `start:dev`, and don't run `cmd /c` — it exits as soon
as the inner command returns, killing the daemon). Save this as
`%USERPROFILE%\bin\pilot-daemon.bat`:

```bat
@echo off
cd /d "%USERPROFILE%\src\pilot"
"%USERPROFILE%\.local\bin\pnpm.cmd" --filter @pilot/cli start -- --no-qr
```

Then register the task:

```powershell
$action = New-ScheduledTaskAction `
  -Execute "$env:USERPROFILE\bin\pilot-daemon.bat" `
  -WorkingDirectory "$env:USERPROFILE\src\pilot"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask `
  -TaskName 'PilotCli' `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Pilot CLI daemon (Phase 5 will replace this with pilot install)'
```

(W11 built-in Tailscale runs at logon so the daemon can announce its
tailnet IP right away. W7/8/10: install Tailscale and set it as a
logon startup item first.)

---

## 5. Building an installable Android APK

Two paths produce a sideloadable APK. The cloud (EAS) one requires only
an Expo account; the local one requires Android Studio + JDK 17 on the
build host.

### A. EAS Build (recommended — no JDK needed)

```bash
# One-time:
npm install -g eas-cli
eas login                                  # uses your free Expo account

# From the repo root, after a fresh install:
pnpm install
pnpm --filter @pilot/shared build

# Internal-distribution APK (sideload target):
pnpm --filter @pilot/app build:android:preview

# Play Store AAB (when ready to ship):
pnpm --filter @pilot/app build:android:production
```

EAS free tier: 30 builds / month on the Android queue. Profile
`preview` produces `app-release.apk` (internal distribution), `production`
produces an `.aab` for the Play Console.

When the build completes, `eas build:list` shows the artifact URL.
Install on a phone:

```bash
# Easiest: scan the QR Expo prints in the terminal
# OR: download the .apk and:
adb install app-release.apk
```

### B. Local Gradle (requires a JDK 17+ and the Android SDK)

Verified working on macOS (arm64) on 2026-07-11: `app-debug.apk` (153 MB,
`com.pilot.app`, versionName 0.1.0) built via the steps below.

```bash
# You need the Android SDK (Android Studio installs it at the path below) and
# a JDK. You do NOT need a separate JDK install — Android Studio bundles one
# (JBR). On this machine that is JDK 21, which builds Expo 51 fine despite the
# "17 is happiest" folklore.
export ANDROID_HOME="$HOME/Library/Android/sdk"                        # macOS default
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

pnpm install                         # root .npmrc pins node-linker=hoisted (see below)
pnpm --filter @pilot/shared build

# RELEASE APK — the sideload target. JS is bundled INTO the apk, so it runs
# standalone with no Metro server. Signed with the debug keystore by default
# (Expo template: buildTypes.release.signingConfig = signingConfigs.debug), so
# it installs on any device with "Install from unknown sources" — no keystore
# setup needed until you ship to Play. This is what you want on your phone:
pnpm --filter @pilot/app build:android:local:release
# Output: packages/app/android/app/build/outputs/apk/release/app-release.apk

# DEBUG APK — for the dev inner loop only. It does NOT embed the JS; it fetches
# the bundle from a Metro dev server at launch. Installing it and opening it
# with no reachable Metro throws the red screen:
#   "Unable to load script. Make sure you're either running Metro ... or that
#    your bundle 'index.android.bundle' is packaged correctly for release."
# To use a debug build: run `pnpm --filter @pilot/app start` and either be on
# the same LAN or `adb reverse tcp:8081 tcp:8081` over USB.
pnpm --filter @pilot/app build:android:local:debug
# Output: packages/app/android/app/build/outputs/apk/debug/app-debug.apk

# For a real production keystore (when shipping to Play), generate one with
# `keytool -genkeypair -keystore pilot-release.keystore -alias pilot \
#   -keyalg RSA -keysize 2048 -validity 10000`, wire it into
# packages/app/android/gradle.properties, and point release signingConfig at it.
```

> **Standalone bundling depends on two committed pieces** (both needed for the
> release bundle to build under pnpm): `packages/app/index.js` as the entry
> point (`main` in the app's package.json — replaces `expo/AppEntry`, whose
> `../../App` import breaks when pnpm puts expo in `.pnpm/`), and the
> `resolveRequest` shim in `metro.config.js` that maps the codebase's
> `.js`-suffixed relative imports (a `moduleResolution: "Bundler"` convention)
> onto their real `.ts`/`.tsx` files. Without them the bundler fails with
> `Unable to resolve module ../../App` or `...MachinesScreen.js`.

**Install to a phone** (USB debugging on, or `adb connect <ip>` over the
tailnet):

```bash
adb install -r packages/app/android/app/build/outputs/apk/debug/app-debug.apk
```

Caveat for cross-device debug-keystore installs: the debug keystore is
per-developer / per-machine. If you build a debug APK on machine A and
try to install it on a phone that already has a build from machine B,
Android will reject it as a signature mismatch. Use `adb uninstall
com.pilot.app` first, OR stick to the release-keystore path.

#### pnpm monorepo gotchas (why the build needs help)

The `android/` and `ios/` trees are generated by `expo prebuild --clean` and
are **gitignored** — they are regenerated on every build, so native tweaks
must live in config, not in the tree. Two things bite an Expo 51 + pnpm
monorepo, both handled automatically now:

1. **`node-linker=hoisted`** (root `.npmrc`). RN 0.74's generated
   `settings.gradle` resolves `@react-native/gradle-plugin` with a bare
   `require.resolve(...)` from `android/`, which fails under pnpm's default
   isolated store (`Included build '.../android/null' does not exist`). A flat
   node_modules — Expo's documented layout for pnpm — fixes it.
2. **`scripts/patch-android-prebuild.mjs`** (run by `build:android:local:*`
   via the `patch:android` script, right after prebuild). It:
   - rewrites the one remaining bare `require.resolve` in `settings.gradle` to
     the paths-based form the file already uses elsewhere, so both
     `includeBuild()` calls resolve to one path (otherwise Gradle errors:
     *"Included build … has build path :gradle-plugin which is the same as
     included build …"*);
   - adds the `splashscreen_background` color to `res/values*/colors.xml`,
     which Expo's splash theme references but prebuild doesn't emit when no
     splash background is configured (otherwise: *"AAPT: error: resource
     color/splashscreen_background not found"*).

   If you ever run a raw `expo prebuild` + `gradlew` by hand (bypassing the
   build scripts), run `pnpm --filter @pilot/app patch:android` in between.

---

## 6. Reporting issues

When you hit something that's not on this page, paste the relevant bits
into an issue. Useful fields:

- **OS**: `uname -a` (Mac/Linux) or `ver` (Windows).
- **Tailscale version**: `tailscale version`.
- **`@pilot/shared` version**: `pnpm --filter @pilot/shared list`.
- **CLI command**: `pilot --port 7117 --no-qr` (omit QR if photo-shared).
- **App command**: `pnpm --filter @pilot/app android` (with `EXPO_DEBUG=1`
  if it's a Metro bundling issue).
- **Smoke output**: paste the full `pnpm --filter @pilot/cli smoke`
  output, including the `[smoke] chunk #N` lines if any show up.
- **What you expected**: e.g. "bash prompt renders in <1 s".
- **What you saw**: paste, photo, or screen recording.
