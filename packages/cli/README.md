# `@pilot/cli`

`pilot` — the daemon that runs on every dev machine you want to expose.

## What it does (Phase 1)

- Generates a 32-byte bearer token at startup and prints a `pilot://pair`
  QR encoding host + port + token + machine name (verified by the app).
- Looks up the host's Tailscale IPv4 in the background and falls back to
  `127.0.0.1` with a warning if Tailscale isn't installed.
- Listens on `--bind:port` (defaults `127.0.0.1:7117`) and serves:
  - `GET /api/health` — version, uptime, tailscale IP, port.
  - `GET /ws/pty?cwd=…&tool=bash&cols=80&rows=24` — bidirectional PTY
    over WebSocket.
- Every request (HTTP and WS upgrade) requires `Authorization: Bearer <token>`.

## Flags

```
--port, -p <n>   TCP port to listen on (default 7117; use 0 for ephemeral)
--bind, -b <ip>  IP to bind to (default 127.0.0.1)
--name, -n <s>   Friendly machine name shown in the app (default: hostname)
--no-qr          Print pairing URL but skip the ASCII QR (for headless / CI logs)
-h, --help       Print help
```

## Run

```bash
pnpm --filter @pilot/shared build
pnpm --filter @pilot/cli dev              # tsx watch
pnpm --filter @pilot/cli start            # node dist/index.js (after build)
pnpm --filter @pilot/cli -- --port 7117   # pass CLI flags via `--`
```

## WS protocol (client → server → client)

| Direction | Payload | Meaning |
|---|---|---|
| C→S text | `echo hi\n` | PTY input (UTF-8). |
| C→S text | `{"type":"resize","cols":120,"rows":40}` | PTY resize. |
| C→S binary | any bytes | PTY input preserved byte-for-byte (clipboard paste). |
| S→C text | raw ANSI/printable | PTY output. |
| S→C last text | `{"type":"exit","exitCode":0,"signal":null}` | then close 1000. |
| S→C code `1008` | text | Handshake refused (invalid query / unknown tool). |
| S→C code `1011` | text | Spawn failed or PTY write failed. |

Server pings every 30 s; if the client misses two pongs, the server
terminates the WS and kills the PTY. Critical for mobile clients that
silently drop TCP without FIN.

## Smoke test

```bash
pnpm --filter @pilot/cli smoke
```

Boots an in-process daemon, opens a WS to `bash` in the repo root, sends
`echo pilot-smoke-…`, asserts the marker appears in output, and confirms
bad-auth upgrades get a 401. Requires `bash` (or `$SHELL` resolving to a
working shell) on PATH.

## Runtime

- **Today**: runs on Node 20 (via `tsx` for dev, `node dist/index.js` for
  production). Both Node 20's stdlib (`node:crypto`, `node:http`, `node:os`)
  and `ws` + `node-pty` work everywhere we ship.
- **Goal (Phase 5)**: ship a single Bun binary with `bun build --compile`.
  Code is already runtime-agnostic; we only swap the dev command.

## Phase 1 → Phase 2

When `/api/tools`, file picker, and ollama/freebuff launchers land, the
launcher registry in `src/launchers.ts` is the only place that has to grow.
The server, auth, WS handler, and pairing code are Phase 2-ready.
