# Changelog

Notable changes to Pilot, with the reasoning behind each — not just what
changed but why, so the decision doesn't need to be re-derived later. Newest
first. Dates are when the work happened, not necessarily when committed.

## 2026-07-26 — "websocket error" reopening any session on Windows

**Symptom:** reopening a session — especially one whose shell had exited — gave
"unable to connect to terminal, websocket error".

**Cause:** the app sent a working directory it had no business inventing.
`SessionsScreen` called `onOpenSession(sessionId)` with no cwd, so
`TerminalScreen` fell back to `DEFAULT_CWD = '/tmp'`. The daemon validates
`statSync(hello.cwd)` before the WS upgrade, unconditionally — and on Windows
`/tmp` resolves to `C:\tmp`, which doesn't exist. The upgrade was rejected with
`400 {"error":"invalid cwd","cwd":"/tmp"}`, and a rejected upgrade reaches the
WebView only as `ws.onerror`, i.e. "websocket error" with no hint of the real
reason. Reproduced exactly, then confirmed the same handshake succeeds when the
real folder is sent.

This is the item the previous entry dismissed as only affecting "a new session
started without picking a folder". That was wrong: it broke **every** resume on
Windows. It looked exit-specific only because a live terminal already holds its
socket open — the failure needs a fresh handshake to show up.

**Fixed in three places, because one alone would leave the trap armed:**

- **The client no longer guesses.** `cwd` is now optional in
  `PtyHelloQuerySchema`; omitted means "no opinion" and the daemon uses its own
  root (`$HOME`, or `PILOT_FS_ROOT` — the same root the folder picker browses).
  Only the daemon knows what a valid path looks like on its OS. An empty string
  is still rejected, so a blank cwd stays a bug rather than becoming a default.
- **A resume no longer validates a cwd it doesn't use.** The handshake now
  looks the session up first (`SessionManager.getLive`); re-attaching to a live
  PTY inherits that session's directory and skips the check entirely, since the
  process is already running somewhere.
- **The app passes the session's own cwd** through `onOpenSession(id, cwd)` —
  `SessionsScreen` already displayed it — so if the session has since exited,
  its replacement starts in the right folder instead of nowhere in particular.

**Verified** against the rebuilt daemon, all five paths opening a session: new
with a Windows cwd, resume-live with no cwd, brand-new with no cwd, resume of a
dead session id (the reported case), and resume of a dead id with a folder.
Previously path 2 returned 400. 124 tests across the workspace.

## 2026-07-26 — Termux-style quick-key bar (rebuilt, not recovered)

Rebuilding the APK from repo source lost the on-screen key bar the previous
build had — a second casualty of the uncommitted app source, alongside the tool
picker. Confirmed it was never in this repo: `TerminalScreen.tsx` still carried
orphaned `bar`/`cwdInput` styles with no JSX using them, and scanning both APKs
on disk found no `Ctrl` label in either, so the previous phone build was a third
artifact that was never saved. Rewrote it rather than trying to recover it.

**Design.** A soft keyboard cannot produce Esc, Tab, Ctrl or arrows, so the bar
supplies them. Two different mechanisms, because the keys need different things:

- **Direct keys** (Esc, Tab, arrows, ^C, ^D, Home/End, PgUp/PgDn) send their
  escape sequence immediately via a new `window.pilotKey` hook that RN reaches
  with `injectJavaScript`.
- **Ctrl and Alt are sticky.** They can't send anything on their own — they have
  to modify the _next_ character typed on the soft keyboard, which RN never
  sees, since the keyboard types straight into xterm inside the WebView. So the
  modifier state lives in the WebView: `window.pilotToggle` arms it,
  `term.onData` consumes it (mapping `@A-Z[\]^_` and `a-z` onto the C0 range for
  Ctrl, prefixing ESC for Alt), then posts the cleared state back so the buttons
  un-highlight. The buttons follow the WebView's state rather than leading it.

Cursor and edit keys read `term.modes.applicationCursorKeysMode` instead of
hardcoding CSI: vim and less switch on DECCKM, after which arrows must be sent
as SS3 (`ESC O A`) — send `ESC [ A` there and you insert junk instead of moving
the cursor.

**Verified** in the rebuilt bundle: `pilotKey`, `pilotToggle`,
`applicationCursorKeysMode`, `Ctrl`, `PgUp`/`PgDn` and the key ids all present.
`Ctrl` and `PgUp` were absent from _both_ previous APKs, which is what makes
those hits meaningful rather than incidental substring matches. 5 new tests,
41 in the app package, 120 across the workspace.

## 2026-07-26 — Android APK rebuilt on Windows (and the build path made to work there)

Rebuilt `app-release.apk` to pick up the terminal and error-handling fixes
below. First local Android build on this Windows machine, which needed one
repo fix to be possible at all.

- **`build:android:local:*` couldn't run on Windows.** Both scripts ended in
  `cd android && ./gradlew …` — a POSIX path cmd.exe can't execute, so the
  documented local-APK command failed immediately. Replaced with
  [`scripts/gradle.mjs`](packages/app/scripts/gradle.mjs), which picks
  `gradlew.bat` vs `./gradlew` and fills in `JAVA_HOME`/`ANDROID_HOME` when
  unset (Android Studio's bundled JBR and the default SDK location, per
  TROUBLESHOOTING §5) instead of letting Gradle fail with an opaque missing-SDK
  error. Worth noting the machine default was wrong here in a way that would
  have wasted time: bare `java` on PATH is JDK 25, far newer than this AGP
  accepts; the JBR is 21.

**Build:** `BUILD SUCCESSFUL in 11m 3s`, 470 tasks →
`packages/app/android/app/build/outputs/apk/release/app-release.apk` (79.4 MB).

**Verified by differential inspection of the old and new bundles** rather than
by trusting the build. Note the release bundle is Hermes bytecode, and Hermes
stores any string containing a non-ASCII character as UTF-16 — a plain ASCII
byte search misses those and reports a false "absent", which is exactly the
wrong answer to get when checking that a CDN reference is gone. Searching both
encodings, against the previous APK as a control:

| marker                      | old APK | new APK     |
| --------------------------- | ------- | ----------- |
| `cdn.jsdelivr.net`          | present | **gone**    |
| `__CWD__` (raw placeholder) | present | **gone**    |
| `var CFG = ` (JSON config)  | absent  | **present** |
| `window.onerror`            | absent  | **present** |
| `is too old to provide`     | absent  | **present** |

Bundle grew 0.99 → 1.55 MB, consistent with the ~290 KB of vendored xterm.

Both APKs are signed with the standard Android debug certificate
(SHA-256 `fac61745…`), so this installs over an existing build without an
uninstall. The previous APK was backed up to `~/pilot-apk-backup/` before
`expo prebuild --clean` regenerated `android/`.

**This APK does not have the tool picker** — that screen only ever existed in
the uncommitted source used for the APK now on the phone. Installing this
trades the picker for a working terminal until that source is recovered.

## 2026-07-26 — Blank terminal after picking a folder (Windows paths + CDN)

**Symptom:** pick a folder on the phone to start a session, get a white screen
and no terminal.

**Two causes, both in the WebView document.**

- **Windows paths were destroyed before the terminal loaded.** The template
  pasted the picked folder straight into a JS string literal
  (`var CWD = "__CWD__";`) via literal substitution. Backslashes are escape
  sequences there, so `C:\Users\jorda\Documents` silently became
  `C:UsersjordaDocuments` — and the daemon's pre-upgrade `statSync` then
  rejected a directory that plainly exists. Worse, a folder like `\ui` or
  `\xtras` produces `\u`/`\x`, which is a **parse error that kills the entire
  `<script>`**: no terminal, no message, nothing posted back to RN. POSIX paths
  have no backslashes, which is the only reason this survived until the daemon
  moved to Windows. All seven values now go through one JSON-encoded
  `__CONFIG__` object ([`terminal-html.ts`](packages/app/src/terminal-html.ts)),
  which also closes the injection hole — folder names are arbitrary user data
  and `x"; alert(1); //` is a legal directory name. The substitution uses a
  function replacement so a `$&` in a path isn't treated as a replacement
  pattern.

- **The terminal needed the public internet to draw itself.** xterm.js and
  xterm.css were fetched from jsDelivr at load time, so a phone with no route
  off the LAN got a _render-blocking_ stylesheet that never arrived — a white
  page, with the daemon one hop away. Both are now vendored into the JS bundle
  ([`src/vendor/xterm-assets.ts`](packages/app/src/vendor/xterm-assets.ts),
  regenerate with `pnpm --filter @pilot/app vendor:xterm`). Nothing in the
  document touches the network except the WebSocket to the daemon. The desktop
  app had already vendored the same files; the phone never got the treatment.

Also added `window.onerror` inside the WebView, which posts back to RN. Both
bugs above presented as a blank page precisely because a throw there was
silent — the app sat on "connecting…" with nothing to show.

The HTML builder moved out of `TerminalScreen.tsx` into `terminal-html.ts` so
it can be tested without importing react-native. 16 new tests cover the Windows
paths that used to mangle or crash, `</script>` and quote injection, `$&`, and
— guarding the actual failure — that the emitted script _parses_.

**Verified end-to-end** against the daemon: `/ws/pty` with
`cwd=C:\Users\jorda\Documents` starts PowerShell in that directory and it
reports the path back.

**Not fixed:** `DEFAULT_CWD` in `TerminalScreen.tsx` is still `/tmp`, which
doesn't exist on Windows. It only bites a new session started without picking a
folder; doing this properly needs a daemon-side default (its `$HOME`) rather
than a guess in the app.

## 2026-07-26 — `GET /api/tools` implemented; "offline" no longer means "404"

**Symptom:** the phone's tool picker showed "Could not reach the machine. Is it
online?" against a machine that was up, healthy, and answering everything else.

**Two independent causes, both fixed.**

- **`/api/tools` was never implemented.** `TOOLS_PATH` has been in
  [`constants.ts`](packages/shared/src/constants.ts) and `ToolInfo`/
  `ToolsResponse` in [`schemas.ts`](packages/shared/src/schemas.ts) since Phase
  1, but [`server.ts`](packages/cli/src/server.ts) never routed it, so the
  daemon 404'd. Added the route (GET-only, behind the same bearer auth) and
  turned [`launchers.ts`](packages/cli/src/launchers.ts) into a real registry:
  `bash` (the platform shell), `claude`, `ollama`, `freebuff`. Availability is
  a synchronous PATH scan (`resolveOnPath`) rather than a `which`/`where`
  subprocess — it runs once per tool per request and a sync caller can't await
  a spawn. It honours `PATHEXT` on Windows, which matters because npm-installed
  CLIs land as `.cmd` shims, never a bare `.exe`. Unavailable tools are still
  listed so the app can grey them out instead of hiding them. The shell is
  always reported available: `$SHELL` can be an absolute path a PATH scan would
  miss, and it's the one tool that always works.

- **Every failure was reported as "offline."** `apiGet` threw a plain `Error`,
  and screens caught it with a bare `catch {}`, so a 404 from a healthy machine
  rendered identically to an unplugged one — which sends you debugging Wi-Fi and
  Tailscale instead of the daemon's age. [`api.ts`](packages/app/src/api.ts) now
  throws an `ApiError` carrying `status`, with a `describeApiError` helper that
  separates "nothing answered" (a non-`ApiError` — refused/timeout/DNS) from
  401/403 (re-pair), 404 (daemon too old, naming the missing capability), and
  everything else. `SessionsScreen` and `FilePickerScreen` use it; the latter
  keeps its own copy for 400, since `/api/fs` answers 400 (never 404) for an
  unreadable or out-of-allowlist path. `MachinesScreen`'s status dot is left
  alone — it's a genuine binary reachability probe.

**A wrong turn worth recording:** the first cut wrapped Windows `.cmd`/`.bat`
shims in `cmd.exe /c`, reasoning that node-pty spawns via `CreateProcess`, which
can't execute batch files. Probing it with a synthetic shim showed node-pty
handles them directly, so the wrapper was removed — it bought nothing and would
have added a process layer that swallows exit codes and complicates Ctrl-C.

**Verified** against a running daemon: `GET /api/tools` → 200 with the tool
list, 401 without a token, 405 on POST. Detection matches `where` exactly on
this machine (claude ✓, freebuff ✓ as a `.cmd`, ollama ✗). New tests: 9 in
`launchers.test.ts` (the file BUILD_STATUS listed as a coverage gap) and 7 more
in the app's `api.test.ts`. 100 tests green across the workspace; typecheck and
lint clean.

**Note:** the tool-picker screen itself is not in this repo — the APK on the
phone was built from app source that was never committed (see the Windows entry
below). This change makes the daemon answer it correctly; the app half still
needs to be recovered or rewritten.

## 2026-07-26 — First real Windows build (the "unverified" platform, verified)

The 2026-07-12 cross-platform entry below shipped Windows support by source
audit and explicitly flagged it as untested on real hardware. Built it on
Windows for the first time; the audit held up structurally, but two genuine
bugs sat between "packages successfully" and "actually runs", plus a missing
build file. Output: `packages/desktop/dist/Pilot Setup 0.1.0.exe` (95.9 MB,
NSIS x64, unsigned).

- **`build/` was gitignored, so `after-pack.cjs` didn't exist.** The blanket
  `build/` rule in [`.gitignore`](.gitignore) matched electron-builder's
  _buildResources_ directory, which is source, not output. The afterPack hook
  the 2026-07-12 fix depends on was never committed — it survived only on the
  machine that wrote it, and packaging on any fresh clone fails outright since
  `package.json` still references it. Rewrote the hook from the behaviour
  documented below and mirrored in `daemon.cjs`, added `!packages/desktop/build/`,
  and restored the 512px icon there.

- **The daemon couldn't import anything on Windows.**
  [`daemon.cjs`](packages/desktop/daemon.cjs) passed raw
  `path.join(...)` results to dynamic `import()`. Node's ESM loader takes a
  URL, so `C:\…\server.js` is rejected — it reads `c:` as a URL scheme
  (`ERR_UNSUPPORTED_ESM_URL_SCHEME`). POSIX paths only worked by accident of
  starting with `/`. All six imports now go through a `pathToFileURL` helper.
  Symptom would have been the app's "Daemon failed to start (exit 1)".

- **`@pilot/shared` loaded as CommonJS in the packaged app** ("Named export
  'SHARED_PACKAGE_VERSION' not found"). Both the afterPack hook and
  `daemon.cjs` created the module shims _before_ writing the `type: module`
  package.json stubs. On macOS/Linux the shims are symlinks, so the later
  write reached them retroactively and the ordering never mattered; on Windows
  they're physical copies (no symlink privilege), so the copy froze the
  pre-stub state. Both now write the stubs first. This is the same
  symlink-vs-copy asymmetry as the 2026-07-12 entry, in a new place.

- **node-pty no longer needs a source rebuild.** `electron-builder
install-app-deps` in the desktop `postinstall` failed here with "Could not
  find any Visual Studio installation" — VS Build Tools _is_ installed, but
  it's 2026 (major 18) and the bundled node-gyp only detects through 2022.
  The rebuild turned out to be unnecessary: node-pty ≥1.1.0 is Node-API
  (`node-addon-api`) and ships prebuilds, which are ABI-stable across Node and
  Electron. Verified by loading it under `ELECTRON_RUN_AS_NODE` and spawning a
  real PTY. New [`scripts/ensure-native-deps.cjs`](packages/desktop/scripts/ensure-native-deps.cjs)
  skips the rebuild when a prebuild exists for the current platform+arch and
  still rebuilds when one doesn't, so no platform regresses.

- **`token.test.ts` asserted a POSIX file mode.** `mode & 0o077 === 0` can't
  hold on Windows, where `chmod` only toggles the read-only bit and `stat`
  always reports `0o666`. `token.ts` already treats the chmod as best-effort;
  the test now guards the assertion the same way. This would have failed the
  Windows CI job before it ever reached packaging.

**Verified end-to-end against the packaged bundle** (not the source tree):
daemon boots, pairing page returns HTTP 200, `/api/health` is 401 without a
bearer token and 200 with one, and `/ws/pty` spawns a real PowerShell PTY that
echoes back — with zero stderr. 70 unit tests green (49 shared, 21 cli); lint
clean.

**Still not done:** no code signing, so SmartScreen will warn on first run
(needs an Authenticode cert). Two _environment_ blockers are documented but
unfixable in-repo — electron-builder's `winCodeSign` archive contains macOS
symlinks it can't extract without Developer Mode (pre-extract it into
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` with
`-xr!darwin`), and `pnpm install` must run non-interactively
(`CI=true pnpm install --config.confirmModulesPurge=false`) or it stalls on the
modules-purge prompt. The Linux target remains unverified on real hardware.

## 2026-07-12 — Sessions died instantly with "posix_spawnp failed" (packaged app)

**Symptom:** starting a session from the Android app or the Mac app's
terminal showed "session ended: posix_spawnp failed." immediately. Only in
the packaged app — dev mode (`pnpm start`) was fine.

**Root cause:** node-pty locates its `spawn-helper` binary from its own
resolved module path and then blindly rewrites the substring `app.asar` →
`app.asar.unpacked` (it assumes it was required from _inside_ the asar
archive, where natives can't execute). Our daemon loads node-pty through the
`cli-dist/node_modules` shim whose realpath is already
`…/app.asar.unpacked/node_modules/node-pty`, so the rewrite produced
`…/app.asar.unpacked.unpacked/…` — a nonexistent helper path — and every PTY
spawn failed. This was the first time PTY spawning was actually exercised in
the packaged app (the daemon itself couldn't even start until the earlier
fix below), which is why it survived until now.

**Fix:** the daemon must load packages from a path containing no `app.asar`
segment at all. [`after-pack.cjs`](packages/desktop/build/after-pack.cjs) now
makes a REAL copy of the unpacked modules at `Resources/node_modules` (+14 MB;
symlinking wouldn't work — ESM resolves through symlinks to the realpath,
which would put `app.asar` right back in the module path) and points the
`cli-dist`/`shared-dist` shims there. The
[`daemon.cjs`](packages/desktop/daemon.cjs) self-heal recreates the copy for
bundles that predate it. Verified end-to-end: WebSocket `/ws/pty` against the
rebuilt app (from a relocated copy AND the installed `/Applications` app)
returns a session id and a live zsh prompt.

## 2026-07-12 — Android APK rebuild (release, local Gradle)

Rebuilt `app-release.apk` after the `/api/fs` client changes above (the
phone's folder picker now consumes `parent`/`segments`/entry `path` from the
daemon instead of splitting strings — see the cross-platform entry below).
Used the local-Gradle path from `TROUBLESHOOTING.md` §5B rather than EAS,
since this was a same-machine rebuild with no need to consume an Expo build
credit. `pnpm --filter @pilot/app build:android:local:release` → BUILD
SUCCESSFUL in 1m40s (470 tasks) →
`packages/app/android/app/build/outputs/apk/release/app-release.apk` (79 MB,
`com.pilot.app`). JS is bundled into the APK (no Metro server needed at
runtime); signed with the Expo template's debug keystore, so it installs
anywhere with "unknown sources" enabled — not yet suitable for the Play Store
(needs a real release keystore first, per the note in TROUBLESHOOTING.md).
`android/` is gitignored (regenerated by `expo prebuild` on every build), so
there's nothing to commit for this beyond the source changes it was rebuilt
to pick up.

## 2026-07-12 — Cross-platform build hardening (Windows + Linux + macOS)

**Context:** Pilot is being built for Windows, macOS, and Linux desktop, all
installed from just the `.app`/`.exe`/`AppImage` — no source checkout on the
target machine. An audit of the source turned up several places that only
worked on macOS by accident. Fixed all of them, then added CI so all three
platforms actually get built (native modules can't be cross-compiled, so this
requires one job per OS — see below).

- **Shell launcher was POSIX-only.**
  [`packages/cli/src/launchers.ts`](packages/cli/src/launchers.ts) spawned
  `$SHELL -l` unconditionally; on Windows `SHELL` is unset and `-l` isn't a
  real flag there. Now branches on `process.platform`: PowerShell
  (`-NoLogo`, no `-l`) on Windows, `$SHELL -l` (fallback `bash`) elsewhere.
  The wire id stays `bash` — already-paired phones don't need updating.

- **`/api/fs` made clients do path arithmetic.** The daemon returned only
  `{ path, entries }`; both the desktop folder picker
  ([`packages/desktop/app.js`](packages/desktop/app.js)) and the phone's
  ([`packages/app/src/screens/FilePickerScreen.tsx`](packages/app/src/screens/FilePickerScreen.tsx))
  split/joined path strings on `'/'` to build breadcrumbs and navigate into
  subfolders. That's wrong on Windows (`C:\Users\...`, `\` separator). Fixed
  by moving all path arithmetic server-side
  ([`packages/cli/src/server.ts`](packages/cli/src/server.ts)): the response
  now carries `parent`, `sep`, a `segments[]` breadcrumb trail, and an
  absolute `path` on every entry — clients just render and navigate to
  whatever path they're handed, never parse one. Schema updated in
  [`packages/shared/src/schemas.ts`](packages/shared/src/schemas.ts) with new
  POSIX/Windows round-trip tests.

- **Tailscale detection missed common install locations.** `getTailscaleIp()`
  spawned bare `tailscale` and relied on PATH — but a GUI-launched app (the
  packaged Electron app, not a terminal) inherits a minimal PATH that's
  missing `/opt/homebrew/bin` on macOS or `Program Files` on Windows. Fixed
  in [`packages/cli/src/tailscale.ts`](packages/cli/src/tailscale.ts) by
  trying a short list of known-install-path candidates per platform before
  giving up. This was actually already silently broken on macOS, not just a
  future Windows problem — the CLI/terminal case worked by luck because a
  terminal's PATH is different from a double-clicked app's.

- **Desktop window chrome and lifecycle assumed macOS.**
  [`packages/desktop/main.cjs`](packages/desktop/main.cjs):
  - `titleBarStyle: 'hiddenInset'` / `trafficLightPosition` (macOS-only
    BrowserWindow options) are now gated on `process.platform === 'darwin'`.
  - Closing the window used to always hide-to-tray. Kept that for
    macOS/Windows, but **not Linux**: stock GNOME has no system tray, so a
    hidden window there would be unrecoverable — no dock icon, no tray icon,
    nothing to click. On Linux, closing the window now quits.
  - `app.setLoginItemSettings` (run-at-login) is a silent no-op on Linux.
    Replaced the three call sites with one `syncRunAtLogin()` helper that
    writes/removes a freedesktop `~/.config/autostart/pilot.desktop` entry on
    Linux (AppImage-aware — execs `$APPIMAGE`, not the extracted binary path,
    so autostart survives an AppImage update) and keeps using the Electron
    API elsewhere.

- **Packaging shims (from the 2026-07-12 daemon-crash fix, see below) didn't
  cover Windows.** The afterPack hook
  ([`packages/desktop/build/after-pack.cjs`](packages/desktop/build/after-pack.cjs))
  and the daemon's runtime self-heal
  ([`packages/desktop/daemon.cjs`](packages/desktop/daemon.cjs)) originally
  used symlinks unconditionally to wire `cli-dist`/`shared-dist` up to the
  asar-unpacked `node_modules`. Windows can't create symlinks without admin
  rights or Developer Mode enabled, so both now branch: symlinks on
  macOS/Linux, physical `fs.cpSync` copies on Windows (bigger on disk, works
  everywhere without special privileges).

- **electron-builder had no Windows or Linux target.** Added `win` (NSIS,
  x64) and `linux` (AppImage x64+arm64, deb) to the `build` config in
  [`packages/desktop/package.json`](packages/desktop/package.json), plus a
  512px `build/icon.png` electron-builder can derive `.ico`/`.icns`/PNG sizes
  from per-platform.

- **CI added so all three platforms actually get built.** New
  [`.github/workflows/build.yml`](.github/workflows/build.yml): a 3-OS matrix
  (`macos-latest`, `windows-latest`, `ubuntu-latest`), each running install →
  build shared+cli → test → `electron-builder package` → upload the
  installer as an artifact; tag pushes (`v*`) additionally attach installers
  to a GitHub Release. This isn't optional polish — **native modules
  (`node-pty`) must be compiled on the OS they target against Electron's
  ABI**, so there's no way to produce a Windows build from this Mac. Without
  CI, "ships for all three platforms" would mean manually building on
  borrowed/rented machines every release.

- **Docs:** added a Windows section to
  [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) §2 covering the first-launch
  firewall prompt (must be allowed or phone pairing times out with no other
  error — the daemon binds `0.0.0.0`) and the PowerShell-by-default change.

**Not done yet / explicitly deferred:**

- No code signing for any platform. macOS builds are unsigned (Gatekeeper
  will refuse a downloaded zip on another Mac unless quarantine is stripped);
  Windows builds are unsigned (SmartScreen warning on first run). Needs an
  Apple Developer ID cert and a Windows Authenticode cert respectively.
- The Windows and Linux code paths above are unverified on real hardware —
  they were fixed by source audit + reasoning about platform differences,
  not tested on a Windows or Linux machine. The CI workflow is what will
  actually prove them out once it runs.

## 2026-07-12 — Daemon-failed-to-start crash on relaunch (macOS)

**Symptom:** Pilot showed "Daemon failed to start (exit 1)" after being
closed and reopened. Worked on first install, broke on the next launch.

**Root cause** (in
[`packages/desktop/daemon.cjs`](packages/desktop/daemon.cjs)'s
`ensureModuleResolution()`, which sets up module resolution for the forked
daemon process inside the packaged app — the compiled `cli-dist`/`shared-dist`
are ESM with bare imports like `ws`/`zod`, but they live in
`Resources/cli-dist`, not inside `app.asar` where Electron's own resolution
would find `node_modules`):

1. **Ordering bug** — the `@pilot/shared` symlink block ran _before_ the
   node_modules symlink block and called `mkdirSync(nmPilot, {recursive:
true})`, which created `cli-dist/node_modules` as a real directory. The
   next block then saw that path already existed and skipped creating the
   symlink to the real `app.asar.unpacked/node_modules` — so `ws`, `zod`,
   `qrcode`, `node-pty` were all unresolvable on the _second_ run (first run
   got lucky on ordering, or the dir didn't pre-exist yet).
2. **Absolute symlinks written at runtime, into the installed bundle.** The
   `@pilot/shared` link pointed at the build output path
   (`.../dist/mac-arm64/Pilot.app/...`). Once the bundle was moved to
   `/Applications`, that absolute path was wrong forever — the link dangled
   on every subsequent launch. Mutating the bundle after install is also a
   problem in its own right: it would invalidate a code signature once one
   exists.
3. Found while fixing #1/#2: **`shared-dist` needed its own `node_modules`
   link too.** ESM resolves a symlinked import to its _real_ path, so
   `shared-dist/schemas.js`'s `import 'zod'` resolves relative to
   `shared-dist`, not through whatever `cli-dist` was linked to.

**Fix, in two layers:**

- **Build-time (the real fix):** new electron-builder `afterPack` hook,
  [`packages/desktop/build/after-pack.cjs`](packages/desktop/build/after-pack.cjs).
  Creates all the shims — `cli-dist/node_modules`, `shared-dist/node_modules`,
  `@pilot/shared`, and the ESM `package.json` stubs — once, at package time,
  before code-signing runs, using paths _relative_ to the bundle so it
  survives being moved. The app no longer needs to write into itself at
  runtime at all.
- **Runtime (kept as a fallback only):** `daemon.cjs`'s pass now verifies
  existing links with `realpathSync`/`lstatSync` before touching anything, and
  only repairs if broken. This covers dev mode (`pnpm start`, no afterPack
  hook involved) and any bundle built before this fix existed. On a bundle
  built with the new hook, this pass verifies and writes nothing.

**Verification:** rebuilt with `package:dir`, copied the resulting `.app` to
a scratch directory (simulating "installed on a different machine/path"),
ran the daemon from the copy directly — pairing page served HTTP 200,
`/api/health` correctly required auth, zero stderr (no repair needed).
Repaired the already-installed `/Applications/Pilot.app` by hand for
immediate use, then later replaced it outright with a rebuild once the fix
landed.

## 2026-07-14 — Create folder from the phone (`POST /api/fs/mkdir`)

**Context:** the phone's folder picker could browse the daemon's `$HOME`
allowlist but couldn't _make_ a folder — you'd have to SSH/terminal-in
`mkdir` first, then come back to pick it. Added a "+ New folder" button
to the picker that asks for a name and creates it on the host.

> **⚠️ Gotcha — the daemon must be rebuilt for this route to exist.**
> First attempt on the actual phone hit `HTTP 405` in the app even though
> every line of source was correct: the running daemon was inherited from
> the previously packaged `/Applications/Pilot.app` (commit `b07c054`,
> 2026-07-12 "Cross-platform build hardening…", pre-mkdir), whose
> `handleHttp` verb allowlist did not include POST. To pick up the new
> endpoint, either rebuild Pilot.app (`pnpm --filter @pilot/desktop
package:dir` and replace the installed app), or run the daemon from a
> terminal (`pnpm --filter @pilot/cli start:dev`) for the duration of
> testing. Pair token survives both rebuild paths, so a same-machine
> rebuild doesn't force a re-pair.

- **New endpoint `POST /api/fs/mkdir`** in [`packages/cli/src/server.ts`](packages/cli/src/server.ts).
  Body `{ parent, name }`, validated by `FsMkdirRequestSchema` in
  [`packages/shared/src/schemas.ts`](packages/shared/src/schemas.ts).
  Returns `201 { path }` on success, `409` if it already exists, `400`
  on validation or allowlist escape, `403` on `EACCES`/`EPERM`,
  `404` on `ENOENT` parent, `500` on other I/O. The joined path is
  re-resolved and re-checked against the allowlist as defense-in-depth
  so a malformed `name` that ever slips past the schema still can't
  escape `$HOME` (or `PILOT_FS_ROOT`). `recursive: false` is
  intentional — duplicates surface as `409` rather than a silent
  "yes I made it" because some ancestor already existed.
- **Name rules** (in the zod schema, not in UI): 1–200 chars, no
  `/`/`\`/NUL, no leading `-` (so `rm -rf foo` never treats the
  name as a flag), no trailing space/`.` (Windows would strip them
  silently), not `.`/`..`, not a Windows reserved name like
  `CON`/`LPT1`. The reserved-name set lives in the schema so a
  folder created on macOS/Linux doesn't silently break when the
  same daemon is later paired to a Windows client.
- **App:** a "+ New folder" modal in
  [`packages/app/src/screens/FilePickerScreen.tsx`](packages/app/src/screens/FilePickerScreen.tsx)
  - new `apiPost()` helper in
    [`packages/app/src/api.ts`](packages/app/src/api.ts). `apiPost`
    throws `Error("HTTP <code>: <server error>")` on non-2xx so the
    picker can show "folder already exists" vs. "permission denied" vs.
    a generic failure without losing the actual status. After a
    successful create the picker re-browses the parent so the new
    folder lands at its sorted position with no manual refresh.
- **Method guard widened.** The top-of-`handleHttp` allowlist in
  `server.ts` was relaxed from GET/DELETE/PATCH to GET/DELETE/PATCH/
  **POST** so the new route can reach its handler. As a side effect,
  `DELETE`- or `PATCH`-ing `/api/health`, `/api/sessions`, or `/api/fs`
  now returns a clean `405` instead of silently leaking the underlying
  GET response — POST requests were already rejected by the global
  method guard before, so the practical behaviour change is
  `DELETE`/`PATCH` now hitting the per-path
  `if (req.method !== 'GET')` checks on those three endpoints. Worth
  knowing if any tooling relied on the old loose behaviour.
- **Tests:** three new cases in
  [`packages/cli/src/__tests__/smoke.ts`](packages/cli/src/__tests__/smoke.ts)
  — happy path → `201`, duplicate → `409`, parent outside allowlist
  → `400` — plus schema round-trips for `FsMkdirRequestSchema` and
  the Windows reserved-name list in
  [`packages/shared/src/__tests__/schemas.test.ts`](packages/shared/src/__tests__/schemas.test.ts).
  The smoke test boots the daemon with `PILOT_FS_ROOT` pinned to a
  fresh `tmpdir` so the mkdir cases can't pollute `$HOME`, and the
  escape case uses a real sibling tmp dir (not a hardcoded system
  path) so a missing-path error wouldn't accidentally fake the
  allowlist rejection.
- **Schema contract** documented in
  [`packages/shared/src/constants.ts`](packages/shared/src/constants.ts)
  (new `FS_MKDIR_PATH = '/api/fs/mkdir'` export) so the phone and
  the daemon agree by import, not by hand.

## 2026-07-11 and earlier

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) (what's built, decisions locked in,
forward roadmap) and [`BUILD_STATUS.md`](BUILD_STATUS.md) (file-by-file audit,
test coverage, baseline) — both rewritten 2026-07-11 to match reality. Git
history (`git log`) is authoritative for anything not called out there.
