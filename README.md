# Pilot

Remote CLI connector — pair your phone with your dev machines over **Tailscale** and launch AI CLIs (Freebuff, Claude Code, Ollama) on them from anywhere.

> 📄 The full plan lives in [`PROJECT_PLAN.md`](./PROJECT_PLAN.md). Read that before changing architecture.

## Workspace

This is a **pnpm** monorepo with three packages:

| Package | Role |
|---|---|
| [`packages/shared`](./packages/shared) | Zod schemas + TS types shared by cli and app. The single source of truth for the REST/WS contract. |
| [`packages/cli`](./packages/cli) | `pilot-cli` — daemon that runs on the dev machine. Bun/Node + TypeScript. |
| [`packages/app`](./packages/app) | `pilot-app` — React Native + Expo, Android-first. |

## Quick start

```bash
pnpm install            # install all workspace deps
pnpm --filter @pilot/shared build
pnpm typecheck           # tsc on all packages
pnpm lint                # eslint (flat config)
pnpm test                # vitest on @pilot/shared (more added in Phase 1)
```

Per-package scripts:

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

## Phase status

- ✅ **Phase 0 — Scaffold** (you are here)
- ⏳ Phase 1 — Vertical slice: pair one machine → bash terminal over Tailscale
- ⏳ Phase 2 — File picker + Claude Code launch
- ⏳ Phase 3 — Multi-machine
- ⏳ Phase 4 — Freebuff + Ollama launchers
- ⏳ Phase 5 — Daemonization & polish
- ⏳ Phase 6 — Desktop app (macOS + Windows): launchable GUI wrapping the daemon — pairing QR, settings, folder-access config, run-at-login
