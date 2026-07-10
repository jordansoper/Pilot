# Pilot — Build Status & Forward Plan

> One-shot audit of everything in the repo **as of right now**, mapped
> against [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) §9 phases. Read this
> alongside [`README.md`](./README.md) (entry points) and
> [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) (known-issues runbook).

> **Git status note:** this repo isn't initialized as a git repo yet, so
> there's no commit history to consult. Treat this doc as the source of
> truth until you `git init` and commit.

---

## At a glance

| Area | Status |
|---|---|
| Layout | pnpm monorepo with 3 packages (`shared`, `cli`, `app`) — done |
| TypeScript / lint / test tooling | Configured, but build output for `shared` is required before cli/app can import it (`pnpm --filter @pilot/shared build`) |
| CI | GitHub Actions: install → topological build → typecheck → lint → test on every PR/push |
| API contract (REST + WS) | Zod schemas cover everything in `PROJECT_PLAN §8` |
| CLI daemon (`pilot`) | Implements Phase 1 vertical slice: QR pairing, `/api/health`, `/ws/pty on bash` |
| Android app (`pilot-app`) | Phase 1 three-screen flow: Machines → AddMachine → Terminal (xterm.js in WebView) |
| Phase 1 acceptance | **Partially green.** `pnpm --filter @pilot/cli smoke` passes on macOS (arm64) — the full `node-pty → WS → bash` round-trip works. Still needs a real Tailscale + phone run-through for the app half. See note below on the node-pty perms fix that unblocked the smoke. |
| Phases 2–5 | **Not started.** See the plan section below. |

---

## What's built

### `@pilot/shared` — single source of truth for the wire contract

Path: `packages/shared/`

| File | Purpose |
|---|---|
| `src/constants.ts` | `PROTOCOL_VERSION=1`, `DEFAULT_PORT=7117`, route paths, `PAIRING_SCHEME='pilot'`, `TOKEN_BYTES=32`, `FS_ALLOWLIST_ROOT_ENV` |
| `src/schemas.ts` | All v1 zod schemas (`PairingPayload`, `FsEntry/Response`, `ToolInfo/ToolsResponse`, `HealthResponse`, `PtyHelloQuery`) plus `buildPairingPayload`, `buildPairingUrl` helpers and a base64url encoder |
| `src/types.ts` | `z.infer`-backed TS aliases (no second source of truth) |
| `src/version.ts` | `SHARED_PACKAGE_VERSION = '0.0.0'` re-exported so `cli` can echo it on `/api/health` |
| `src/index.ts` | Barrel re-export of everything |
| `src/__tests__/schemas.test.ts` | **16 vitest assertions** — covers every schema, plus coercion/default tests for `PtyHelloQuery` |
| `vitest.config.ts` | node env, picks up `src/**/*.test.ts` |
| `tsconfig.json` | composite project, `composite: true`, references by cli/app |

Status: **complete for v1 contract**. Note: `/api/fs` schemas are defined
but no route serves them yet (Phase 2).

### `@pilot/cli` — daemon that boots on the dev machine

Path: `packages/cli/`

| File | Purpose |
|---|---|
| `src/index.ts` | Entry: arg parser (`--port/-p`, `--bind/-b`, `--name/-n`, `--no-qr`, `-h`), generates 32-byte hex token, prints QR, boots HTTP+WS server, registers SIGINT/SIGTERM handlers |
| `src/server.ts` | The whole daemon. `createServer` + `WebSocketServer` (no-server mode). Routes: `GET /api/health` (auth-gated), `WS /ws/pty` (pre-upgrade auth + query-schema-validate + `cwd` existence check). PTY lifecycle is careful: heartbeat ping every 30 s, terminates dead clients; settles the "PTY exited vs client closed" race via a `closed` flag; resize frame is `{type:'resize',cols,rows}` as JSON |
| `src/auth.ts` | `checkBearer` accepts both `Authorization: Bearer <hex>` AND `Sec-WebSocket-Protocol: <hex>` (constants lowercase + `timingSafeEqual` on decoded byte buffers — for browser/RN-WebView clients that can't set custom WS headers). Also `pickSubprotocol` to echo back to `handleUpgrade` |
| `src/tailscale.ts` | `getTailscaleIp()` shells `tailscale ip -4` with a 1 s timeout, validates strict IPv4, returns null on any failure. `isValidIpv4` exported for tests |
| `src/pairing.ts` | Re-exports `buildPairingPayload/URL` from shared, `renderPairingQr` via `qrcode-terminal` |
| `src/launchers.ts` | Currently **only `bash`** registered. Honors `process.env.SHELL`, falls back to literal `bash`, runs `bash -l` for a login shell. |
| `src/__tests__/auth.test.ts` | **7 tests** — bearer prefix case-insensitivity, length guard, wrong-token, missing/non-bearer, multi-value Authorization (RFC 7235) |
| `src/__tests__/pairing.test.ts` | **2 tests** — `pilot://` scheme, base64url JSON round-trip |
| `src/__tests__/tailscale.test.ts` | **8 tests** — strict IPv4 regex + 1 integration that returns either a valid IP or null within 1.5 s |
| `src/__tests__/smoke.ts` | **Real integration**: boots the daemon in-process on `127.0.0.1:0`, pings `/api/health` with good/bad tokens, opens `/ws/pty` on `bash`, sends `echo <marker>`, asserts marker round-trips within 60 s. Run with `pnpm --filter @pilot/cli smoke` |

Notable design choices already baked in:
- Server uses `noServer: true` + `handleUpgrade` so it can do auth + query
  parsing **before** the WS protocol switch — a bad token gets a 401 on the
  raw HTTP socket, not a silent `1008` after upgrade.
- All constants come from `@pilot/shared` (no hardcoded duplicates).
- `bash` runs as a login shell (`-l`) so `.bash_profile` / `.profile` are
  sourced, putting `bun`, `nvm`, etc. on PATH.

Status: **Phase 1 CLI core is complete**. Strict requirements from
`PROJECT_PLAN §4.1` to check off before declaring Phase 1 done:
- ✅ `/api/health` with bearer auth
- ✅ Bearer token, generated per startup, validated with `timingSafeEqual`
- ✅ QR via ASCII renderer (no PNG dep)
- ✅ Tailscale IP discovery (best-effort, never throws)
- ✅ WS `/ws/pty` running bash via `node-pty`
- ⏳ **NOT YET**: `/api/fs`, `/api/tools`, claude/freebuff/ollama launchers

### `@pilot/app` — Expo React Native, Android-first

Path: `packages/app/`

| File | Purpose |
|---|---|
| `App.tsx` | Hand-rolled 3-screen navigator driven by a `Screen` discriminated union (`machines`, `addMachine`, `terminal`). Why hand-rolled: no `react-navigation`, low turning radius for v1 |
| `src/types.ts` | `PairedMachine`, `machineId(host,port)` (deterministic id so re-pairs upsert), `fromPairingPayload`, `Screen` union |
| `src/storage.ts` | AsyncStorage wrappers around the single key `@pilot/machines/v1`. Defensive parse + shape-narrow filter so bad JSON doesn't crash the list |
| `src/pairing-decoder.ts` | `decodePairingUrl`: accepts `pilot://pair?v=1&p=…`, defensive about missing scheme prefix, decodes base64url via RN-safe `atob`+`TextDecoder` (no `Buffer`), runs the zod schema |
| `src/components/QrScanner.tsx` | `expo-camera@15` `CameraView` wrapper, lazy permission request, reticle overlay, 2 s same-value throttle so a camera stuck on one frame doesn't double-emit |
| `src/screens/MachinesScreen.tsx` | List with **traffic-light dots**: `unknown` (gray) / `checking` (yellow, while ping in flight) / `online` (green) / `offline` (red). Pull-to-refresh. Long-press deletes the row. Pulls `/api/health` per row with a 2 s `AbortController` timeout, writes `lastSeenMs` on success |
| `src/screens/AddMachineScreen.tsx` | Scanner + manual URL paste fallback (for damaged QRs / clipboard-shared links) |
| `src/screens/TerminalScreen.tsx` | The whole terminal experience in one screen. Loads a self-contained HTML template via `WebView source={{ html, baseUrl: 'http://pilot.local' }}`. Template imports **xterm.js@5.3.0** + **FitAddon** from jsDelivr, opens a `WebSocket` directly from the WebView (token sent as the subprotocol entry — required because RN WebView can't set custom WS headers), pipes xterm `onData` to WS, listens for `{type:'resize'}` JSON frames, posts `{type:'ready'\|size\|closed\|error}` back to RN. The `key={`${id}|${cwd}`}` re-mounts on machine/cwd change so the IIFE re-reads placeholders cleanly |
| `src/__tests__/pairing-decoder.test.ts` | **6 tests** covering round-trip, missing scheme prefix, wrong scheme, wrong version literal, garbage URL, missing `p` param |
| `app.json` | Bundle id `com.pilot.app`, `CAMERA` permission, `usesCleartextTraffic: true` (for Tailscale `100.x`), `newArchEnabled: true` |
| `metro.config.js` | Watches whole monorepo, `nodeModulesPaths` for both `packages/app/node_modules` and workspace `node_modules`, `disableHierarchicalLookup: true` |
| `babel.config.js` | `babel-preset-expo` |

Notable design choices:
- Web-View opens the WS directly (not via a RN bridge). Faster keystroke
  round-trip, and works on Tailscale IPs without per-message RN serialization.
- `--name` is already wired end-to-end: CLI's `--name/-n` flag sets the
  friendly name in the QR; the app displays `machine.name` as the row title.
- The Terminal screen **doesn't yet** handle IME height, copy/paste gestures,
  or a Ctrl/Alt toolbar (all called out as `PROJECT_PLAN §10` risk #2).
- The WebView doesn't have reconnect-on-drop yet (`PROJECT_PLAN §10` risk #3).

Status: **Phase 1 app screens are complete**, including the xterm WebView
plumbing. Missing for production polish: reconnect, IME handling, link
addons (see Forward Plan → Phase 5).

### Root & tooling

| File | Purpose |
|---|---|
| `package.json` | Workspace scripts: `dev:cli`, `dev:app`, `build`, `typecheck`, `lint`, `test`, `format`, `clean`. Node ≥ 20, pnpm ≥ 9 |
| `pnpm-workspace.yaml` | Declares `packages/*` |
| `tsconfig.base.json` | ES2022 target, strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `noPropertyAccessFromIndexSignature` (this is why you see `process.env['SHELL']` in cli code) |
| `eslint.config.mjs` | Flat config; per-package `globals` (node for cli/shared, browser for app); `consistent-type-imports: error` |
| `.prettierrc.json` | 90-col, single quote, trailing comma all |
| `.nvmrc` | node 20 |
| `eas.json` | `preview` profile builds signed-internal APK, `production` builds `.aab` for Play |
| `.github/workflows/ci.yml` | ubuntu-latest; `pnpm install --frozen-lockfile`, topological build, typecheck, lint, test |
| `.gitignore` | Ignores `dist/`, `.expo/`, `*.tsbuildinfo` |
| `PROJECT_PLAN.md` | Architecture + phase-by-phase plan (the canonical reference) |
| `TROUBLESHOOTING.md` | Per-OS gotchas, daemonization recipes for mac/linux/win, and the documented `Windows + Git Bash + ConPTY` issue where Phase 1 smoke hangs |

---

## Test coverage snapshot

| Layer | Tested | Not tested |
|---|---|---|
| `@pilot/shared` | All 7 schemas + edge cases (16 vitest cases) | — |
| `@pilot/cli` auth | 7 cases incl. RFC 7235 multi-value | — |
| `@pilot/cli` pairing | 2 cases: scheme + base64url roundtrip | — |
| `@pilot/cli` tailscale | 7 unit + 1 integration ("returns valid IP or null in <1.5 s") | force-error paths (process spawn throw) |
| `@pilot/cli` server | E2E smoke (bash round-trip + 401-on-bad-token) | `/api/health` unknown-method → 405, `/api/health` wrong-method, WS bad cwd → 400, malformed JSON resize frame, heartbeat termination path, all error branches in `handlePtyConnection` |
| `@pilot/cli` launchers | — | bash errors when `SHELL` not set; non-bash launchers (none exist yet) |
| `@pilot/app` pairing-decoder | 6 cases | — |
| `@pilot/app` storage | — | `upsertMachine`, `removeMachine`, `setLastSeen`, corrupt JSON resilience |
| `@pilot/app` screens | — | `MachinesScreen` (ping flow, status state machine), `TerminalScreen` (placeholder substitution, JSON postMessage parsing), `AddMachineScreen` |

**The biggest gap**: the app has only one unit-test file. The whole UI is
unsupported by tests today; rely on manual acceptance per the TROUBLESHOOTING
checklist until vitest+RN-Testing-Library or component tests are added.

---

## What's NOT built (gap vs PROJECT_PLAN §9)

| Phase | Item | Where it should land |
|---|---|---|
| 1 | End-to-end manual acceptance on real Tailscale + phone | Manual — see TROUBLESHOOTING §1 |
| 2 | `GET /api/fs?path=…` with `$HOME` (or `PILOT_FS_ROOT`) allowlist | `packages/cli/src/server.ts` — schemas already in `@pilot/shared` |
| 2 | `GET /api/tools` (per-machine detection of available CLIs) | `packages/cli/src/server.ts` + `packages/cli/src/launchers.ts` |
| 2 | FilePicker screen in the app | new `packages/app/src/screens/FilePickerScreen.tsx` |
| 2 | ToolPicker screen (Claude only at first) | new `packages/app/src/screens/ToolPickerScreen.tsx` |
| 2 | `claude` launcher (register in `launchers.ts`) | same file |
| 3 | Per-machine friendly-name editor / re-pair UI flow | partially done — `--name` is wired in CLI, app stores `name`; no in-app edit |
| 4 | `freebuff` launcher (gated) | `launchers.ts` |
| 4 | `ollama run <model>` launcher + model picker in app | `launchers.ts` + new screen |
| 5 | WS reconnect with backoff on the app side | `TerminalScreen.tsx` |
| 5 | Optional `pilot install` daemonization | new `packages/cli/src/install.ts` |
| 5 | Tabs / multi-session in app | bigger UI rework (consider Expo Router then) |
| 5 | IME height handling + Ctrl/Alt toolbar in WebView | `TerminalScreen.tsx` + companion RN component |
| 5 | xterm WebLinksAddon | small template HTML edit |
| 5 | Crash logs to disk on CLI side | new file |
| 6 | Desktop app (macOS + Windows): launchable GUI wrapping the daemon — tray/menu-bar lifecycle, pairing-QR window, settings (port/name/bind-to-Tailscale-IP), folder-access GUI for the FS allowlist, tool toggles, run-at-login | new `packages/desktop/` (Electron; reuses `startServer()` from `@pilot/cli` + `@pilot/shared` schemas). See PROJECT_PLAN §9 Phase 6 |
| Backlog | Windows + Git Bash + ConPTY workarounds | `PILOT_NO_LOGIN` env knob, or Phase 2 `cmd`/`powershell` launchers (see TROUBLESHOOTING §3) |

---

## Plan for moving forward

The order below is **the smallest set of increments** that closes Phase 1
acceptance and unlocks the rest. Each step has its own *definition of done*.

### Step 0 — set up the repo so progress survives

1. `git init`, first commit of the current state (so this doc gets a hash).
2. Capture a baseline: `pnpm install && pnpm typecheck && pnpm lint && pnpm test`.
   These all need to pass green before any new code lands.
3. `pnpm --filter @pilot/cli smoke` — must print `PASS — bash echoed …`. On
   Windows + Git Bash this **will hang** (documented in TROUBLESHOOTING §3).
   Run on macOS/Linux or in WSL for the dev box.

### Step 1 — close out Phase 1 acceptance

Definition of done for Phase 1 (matches TROUBLESHOOTING §1):

- [ ] Tailscale attached on phone + dev machine, both on the same tailnet.
- [ ] `pilot --port 7117` prints the QR and is reachable on the phone.
- [ ] App scan → row appears in Machines list with a green dot.
- [ ] Tap row → Terminal screen → `bash -l` prompt renders in <2 s.
- [ ] `echo hi` round-trips through xterm.js → bytes appear on phone within
      one keystroke.
- [ ] Close app → reopen → still paired (token persists in AsyncStorage).
- [ ] Restart daemon → app row goes red (token rotated) → re-pair from a new QR.
- [ ] Long-press a row → confirm it's gone from the list.

Tactical gaps inside Phase 1 to address while doing this:
- **Reconnect-on-drop**: the WebView's WS doesn't retry yet. Add a small
  reconnect-with-backoff loop in the template HTML (or move spawn to RN
  side and use a `WebSocket` polyfill that retries) — cheapest fix is
  inline. This de-risks `PROJECT_PLAN §10` risk #3 before Phase 2.
- **App-side tolerance of port 0**: when CLI goes through `--no-qr` smoke
  on port 0, `MachinesScreen` will display `:0` — fine since smoke isn't a
  pairing path, but worth noting in case we want a fake QR later.

### Step 2 — start Phase 2 (file picker + Claude Code)

This is the next *substantive* chunk. Sketch out into the existing app
shape — no big tooling change:

1. **CLI side**
   - Add `GET /api/fs?path=…` to `server.ts`. Validate `path` against
     `$HOME` (or `process.env[FS_ALLOWLIST_ROOT_ENV]`) using `path.resolve`
     + `startsWith`. Use `fs.promises.readdir` with `withFileTypes`; return
     matches to `FsResponseSchema`.
   - Add `GET /api/tools` to `server.ts`. Probe binaries via `which/where`
     against the launcher map. Return `ToolsResponseSchema`.
   - Add a `claude` launcher to `launchers.ts` (mirrors `bash`, no flags).
     Optionally register a `--login`-off toggle (helps the Windows case).
2. **App side**
   - Add `src/screens/FilePickerScreen.tsx`. Calls `/api/fs` against each
     directory entered, tap-navigate, "✓ Pick" button. Keep the imperative
     navigator — just slot it into the `Screen` union after `terminal` so
     the flow is `machines → terminal? → filePicker → toolPicker → terminal`.
   - Add `src/screens/ToolPickerScreen.tsx`. Renders chips from `/api/tools`.
     For Claude-only first phase it's a single button.
   - Wire `cwd` from the picker all the way into the Terminal screen —
     Terminal already accepts a `cwd` prop, just thread it.
3. **Tests to add while we touch this code**
   - `server.test.ts`: `/api/fs` happy path, path-escape attempt, non-dir
     path returns 400. `/api/tools` happy path + missing-binary case.
   - `launchers.test.ts`: bash uses `process.env['SHELL']` when set; falls
     back to `'bash'` otherwise.
   - `storage.test.ts`: `upsertMachine` is idempotent on same id, removes by
     id, `setLastSeen` no-op on missing id.
4. **Definition of done for Phase 2**
   - [ ] App can browse `$HOME` of the paired machine.
   - [ ] Selecting a folder + Claude returns a running `claude` TUI in the
         app's WebView (manual acceptance, not a test).
   - [ ] `/api/fs` rejects `/etc/passwd` with 400 (escape attempt).
   - [ ] Claude's interactive first-time auth completes cleanly inside the
         PTY (manual — depends on `claude`'s own flow).

### Step 3 — Phase 3 (multi-machine) is mostly cheap

Storage layer is **already** array-shaped, and the Machines screen already
traverses N rows. What's left for Phase 3:

1. App-side: in-app "edit name" for a row (read `m.name`, offer a text
   input, persist as an app-only field separate from the QR name). Or
   simpler: keep the QR's name forever — leaving this for after Phase 2.
2. CLI-side: confirm `--name` survives restart (it currently does — name
   isn't part of the token). Done.
3. Add a unit test that `listMachines` + `upsertMachine` correctly upsert by
   `host:port` id (the canonical "re-pair replaces, not duplicates" rule).

### Step 4 — Phase 4 (more tools)

Each launcher is one new entry in `launchers.ts`:

1. `claude` ships in Phase 2; here we just register additional ones.
2. `ollama-run` — reads `hello.model` from the `/ws/pty?model=…` query.
   Add a model picker to `ToolPickerScreen.tsx` (or a sub-screen) when
   this tool is selected.
3. `freebuff` — placeholder until Freebuff ships a CLI; just register with
   `available: false` so the app can show it greyed out.

### Step 5 — Phase 5 (polish)

| Item | Notes |
|---|---|
| `pilot install` cross-OS daemonization | Templates already drafted in TROUBLESHOOTING §4 (LaunchAgent / systemd user unit / Windows Scheduled Task) — promote from docs to code in `packages/cli/src/install.ts`. |
| WS reconnect on the app side | In `TerminalScreen.tsx`'s HTML template. Backoff schedule: 1 s → 2 s → 5 s → 10 s cap. Reset on successful open. |
| IME handling + Ctrl/Alt toolbar | One companion RN component above the `WebView` posting synthetic key combinations into the WebView via `evaluateJavaScript('term.sendKey(...)')`. |
| WebLinksAddon | One script tag added to the embedded HTML. |
| Crash logs on CLI | Append JSONL to `${XDG_STATE_HOME:-$HOME/.local/state}/pilot/log.jsonl`; phase 2 rotational. |
| Tabs / multi-session | Big rework — consider swapping the hand-rolled navigator for Expo Router at this point. |

### Backlog — Windows-specific (carry until "good enough")

- `PILOT_NO_LOGIN=1` to drop `-l` from bash (TROUBLESHOOTING §3).
- Phase 2 launchers `cmd` and `powershell` so Windows users have a path
  that doesn't depend on Git Bash + ConPTY.

---

## Risks I'm tracking (per PROJECT_PLAN §10, current state)

1. **`node-pty` prebuilt availability on Windows** — README says
   Windows builds need VS Build Tools. Already documented in
   TROUBLESHOOTING §2. Be ready to swap to `@lydell/node-pty-prebuilt-multiarch`
   if Bun-side installs fail.
2. **WebView IME / gesture polish** — not addressed yet. Cheap to defer
   until Phase 2 acceptance.
3. **Tailscale Android sleep killing sockets** — flagged in this doc's
   Step 1 as the highest-leverage thing to do next.
4. **Claude Code first-run auth inside PTY** — unknown until Phase 2 manual
   run. If it gets stuck on a TTY-detect prompt, the bash `-l` flow plus
   the `xterm-256color` TERM we set in `launchers.ts` should be enough.

---

## Baseline established (2026-07-11)

Ran the full sequence on macOS (arm64, Node 26.5, pnpm 9.12 via corepack):

- `git init` + first commit — **done** (repo now has history).
- `pnpm install` — **green**.
- `pnpm typecheck && pnpm lint && pnpm test` — **all green** (39 unit tests).
- `pnpm --filter @pilot/cli smoke` — **green** after fixing a real blocker
  (below).

**Blocker found and fixed — node-pty `spawn-helper` execute bit.** The smoke
test initially failed with `0 chunks from PTY` on macOS. Root cause: pnpm's
store dropped the `+x` bit on node-pty's prebuilt
`prebuilds/darwin-arm64/spawn-helper`, so `pty.fork` failed with
`posix_spawnp failed` and the shell never started. Fix: a root `postinstall`
(`scripts/fix-node-pty-perms.mjs`) restores the bit on every install; verified
it survives a fresh `pnpm install`. This is **not** the Windows/ConPTY issue —
same symptom, different cause. Documented in TROUBLESHOOTING §3.

## Recommended *very next* actions

1. **Real-device Phase 1 acceptance** — the only thing left to call Phase 1
   done: run `pnpm --filter @pilot/cli dev` on this Mac with Tailscale up,
   scan the QR from the Android app, confirm the bash terminal round-trips on
   the phone (TROUBLESHOOTING §1 checklist). Everything downstream assumes
   this works; the smoke proves the CLI half, not the app half.
2. Tackle **WS reconnect in WebView** as the cheapest pre-Phase-2 win.
3. Then start **Phase 2** (file picker + `/api/fs` + `/api/tools`), and add
   the `freebuff` launcher alongside `claude` in the same pass — freebuff is a
   CLI tool, so it's a one-line launcher, no need to wait for Phase 4.

Once those five are done, jump into **Step 2** above (Phase 2 file picker
+ Claude) — that's where the user-visible value lives next.
