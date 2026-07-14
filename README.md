# Pilot

Remote CLI connector — pair your phone with your dev machines over **Tailscale** and launch CLIs from anywhere.

> 📄 The full plan lives in [`PROJECT_PLAN.md`](./PROJECT_PLAN.md). Read that before changing architecture.

## Workspace

This is a **pnpm** monorepo with three packages:

| Package                                  | Role                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/shared`](./packages/shared)   | Zod schemas + TS types shared by cli and app. The single source of truth for the REST/WS contract.                                                                                                                    |
| [`packages/cli`](./packages/cli)         | `pilot-cli` — daemon that runs on the dev machine. Bun/Node + TypeScript.                                                                                                                                             |
| [`packages/app`](./packages/app)         | `pilot-app` — React Native + Expo, Android-first.                                                                                                                                                                     |
| [`packages/desktop`](./packages/desktop) | `pilot-desktop` — **Phase 6 scaffold.** Electron app that launches the daemon and shows the pairing QR in a window. Run: `pnpm --filter @pilot/desktop start`. Not yet self-contained (uses system `node`) or signed. |

## Install

### Automated (Linux, recommended)

For a fresh Linux box — including headless servers, dev VMs, and CI
runners — use:

```bash
curl -fsSL https://pilot.remarkablenerds.com/install.sh | bash
```

The script installs Node ≥ 20, pnpm, Tailscale, and the system libraries
Pilot needs; clones the repo into `~/.local/share/pilot`; builds the CLI
daemon; registers it as a `systemd --user` service (`pilot-cli.service`);
and starts it. Pair the Pilot app on your phone by scanning the QR
printed at the end, or by opening `http://localhost:7117/`.

Common overrides (env vars):

| Var                | Default                                    | Effect                                             |
| ------------------ | ------------------------------------------ | -------------------------------------------------- |
| `PILOT_HOME`       | `~/.local/share/pilot`                     | Clone target                                       |
| `PILOT_REPO_URL`   | `https://github.com/jordansoper/Pilot.git` | Fork or pinned URL                                 |
| `PILOT_PORT`       | `7117`                                     | Daemon listen port                                 |
| `PILOT_BIND`       | `0.0.0.0`                                  | Bind address (`127.0.0.1` for localhost-only)      |
| `PILOT_NAME`       | `$(hostname)`                              | Friendly name on the QR                            |
| `PILOT_NO_START`   | `0`                                        | Don't start the daemon (CI smoke runs)             |
| `PILOT_NO_SYSTEMD` | `0`                                        | Skip the systemd unit (Docker, WSL, chroot, macOS) |

Full list, plus per-distro behavior (apt/dnf/pacman/zypper/apk, musl
detection for Alpine, etc.), lives in [`install.sh`](./install.sh). To
inspect the script before running it:

```bash
curl -fsSL https://pilot.remarkablenerds.com/install.sh -o /tmp/install.sh
less -FX /tmp/install.sh
PILOT_NO_START=1 bash /tmp/install.sh    # dry-ish: install but don't start
```

### Manual (clone + build)

For contributors, hosts that can't run `curl | bash`, or anyone who wants
to run the daemon in their own shell without registering a systemd unit:

```bash
# 1. Clone
git clone https://github.com/jordansoper/Pilot.git
cd Pilot

# 2. Install tooling: Node ≥ 20 and pnpm ≥ 9
#    (See "Requirements" below.)

# 3. Workspace install + topological build
#    (topological order so apps see @pilot/shared/dist)
pnpm install --frozen-lockfile
pnpm -r --topological build

# 4. Run the daemon in the foreground (Ctrl+C to stop)
node packages/cli/dist/index.js --bind 0.0.0.0 --port 7117

# 5. Pair your phone
#    Scan the QR printed in the terminal with the Pilot app, or open:
#    http://localhost:7117/
```

For an iterative dev loop, swap step 4 for the workspace `dev` scripts:

```bash
pnpm --filter @pilot/shared build     # one-off; then cached per package
pnpm --filter @pilot/cli dev          # tsx watch — auto-restarts on save
pnpm --filter @pilot/app start        # Expo dev server — pair with the app
```

Both paths produce the same `packages/cli/dist/index.js` artifact; only
the surrounding niceties (systemd unit, distro detection, Tailscale
check) differ. After a manual install, `install.sh` will recognize the
existing clone at `~/.local/share/pilot` and `git pull --ff-only` on
each subsequent run — so you can switch between manual development and
the automated installer freely.

### Per-package scripts

```bash
pnpm --filter @pilot/cli dev      # CLI in watch mode (tsx)
pnpm --filter @pilot/app start    # Expo dev server for the Android app
```

## Phase 1 manual acceptance & platform pitfalls

See [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) for the sign-off
checklist, per-OS notes (Mac / Linux / Windows), daemonization
snippets (LaunchAgent / systemd / Scheduled Task), and a backlog of
known issues (currently: Windows Git Bash + ConPTY can be sluggish —
use a Mac or Linux box for the dev machine until workarounds land in
Phase 2).

## Requirements

- Node ≥ 20
- pnpm ≥ 9 (`npm i -g pnpm@9`)
- Bun ≥ 1.1 (Phase 1 CLI runtime — install before Phase 1 work)
- Android Studio + an emulator or device (Phase 1+)
- Tailscale on dev machine + phone (Phase 1+)

## Status

See [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) §7 for the full roadmap. In short:

**Done** — pair (one QR, LAN + Tailscale), persistent `bash` terminal that
survives backgrounding, multiple concurrent sessions per machine with a session
picker, folder picker for new sessions, multi-machine, settings/reset, back nav.

**Next**

- ⏳ **Phase A — AI tool launchers** (freebuff / Claude Code / ollama) + `/api/tools` + a tool picker. _The top priority — today it only launches `bash`._
- ⏳ Phase B — Terminal UX polish (Ctrl/Alt key toolbar, copy/paste, bundle xterm.js offline)
- ⏳ Phase C — CLI daemonization for headless servers (`pilot install`)
- ⏳ Phase D — Desktop app (macOS + Windows): self-contained, signed, single-installer GUI wrapping the daemon (scaffolded in `packages/desktop`)
