# `@pilot/app`

`pilot` — React Native + Expo (Android-first in v1).

## What it does (Phase 1)

Three screens, no deep routing yet:

1. **Machines** — list of paired machines (AsyncStorage), online/offline dot for each via `/api/health` with a 2 s timeout. Pull to refresh. Tap to open; long-press to remove.
2. **Add Machine** — `expo-camera` QR scanner that decodes a `pilot://pair?v=…&p=…` URL via `PairingPayloadSchema`, then upserts the machine. Has a manual-URL-paste fallback for a damaged QR.
3. **Terminal** — an editable cwd input above a `react-native-webview` hosting xterm.js. Opens a WebSocket directly to the CLI's `/ws/pty?cwd=…&tool=bash&cols=…&rows=…` and pipes the PTY.

## Screens

- **Machines**: list paired machines, ping `/api/health` for status.
- **Add Machine**: camera QR + manual fallback.
- **Terminal**: dedicated cwd editor + xterm over WebView.

## Stack choices

- **Auth bridge**: CLI accepts the token via `Sec-WebSocket-Protocol` subprotocol (in addition to `Authorization: Bearer`) so the WebView's browser-style `new WebSocket(url, token)` works. See `packages/cli/src/auth.ts`.
- **xterm bundle**: `xterm@5.3.0` + `xterm-addon-fit@0.8.0` from jsDelivr CDN inside the WebView HTML. Bundle-to-assets is Phase 5.
- **Navigation**: hand-rolled 3-screen state machine (no `react-navigation` / Expo Router). If Phase 2 grows a file picker chain deep enough to warrant a stack, swap to Expo Router.

## Run

```bash
pnpm --filter @pilot/shared build
pnpm --filter @pilot/app start         # Expo dev server
pnpm --filter @pilot/app android       # launch on Android emulator/device
```

## Required permissions

`expo-camera` ships a plugin in `app.json` that asks for the camera permission on app start. On Android it also adds `android.permission.CAMERA` to the manifest.

## Tests

```bash
pnpm --filter @pilot/app test
```

Vitest covers `pairing-decoder` (round-trip from `buildPairingUrl`). Storage and WebView are runtime-only — exercised manually on a device.
