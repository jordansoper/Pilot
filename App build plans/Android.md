✅ EAS cloud build pipeline working (preview APK + production AAB)
	— `eas build --platform android --profile preview` produces a release-signed APK
	  distributed via EAS internal distribution (QR code / install link).
	— `eas build --platform android --profile production` produces an Android App Bundle
	  for the Play Store. Both profiles use pnpm@9.12.0 + Node 20.18.0 in EAS workers.

✅ Local Android build (debug APK)
	— `pnpm --filter @pilot/app build:android:local:debug` runs the full pipeline:
	  `expo prebuild --platform android --clean` → `patch:android` → `./gradlew assembleDebug`
	— Requires local Android SDK, JDK 17+, and Gradle.
	— The `patch:android` step (scripts/patch-android-prebuild.mjs) fixes three things:
	  1. pnpm-incompatible gradle-plugin resolution in settings.gradle
	  2. Missing splashscreen_background color in colors.xml
	  3. Cleartext HTTP in AndroidManifest.xml (needed for Tailscale LAN traffic)

✅ EAS internal distribution for testers
	— Preview builds upload to EAS, which generates a QR code + install link.
	  Testers install directly without the Play Store. No device registration needed.

⬜ Play Store submission
	— Production profile builds an AAB (Android App Bundle), not an APK.
	  `eas submit --platform android --profile production` uploads to the Play Store
	  internal testing track. Requires a Google Play Console account + service account key.

✅ QR scanner (expo-camera) permission flow
	— Camera permission declared in app.json + expo-camera plugin.
	  Runtime permission request on first QR scan. Handles "deny" gracefully.

✅ Cleartext HTTP enabled (required)
	— Release builds disable HTTP by default. Our Tailscale traffic is WireGuard-encrypted
	  at the tunnel layer, so cleartext inside it is safe. Two layers ensure this:
	  1. `"usesCleartextTraffic": true` in app.json
	  2. Post-prebuild patch in AndroidManifest.xml (belt-and-suspenders)

✅ Back navigation works correctly (hardware back + on-screen back)
	— Hand-rolled navigation stack (no react-navigation). Android hardware back button
	  pops the stack; exits only from the home screen. Status bar insets handled manually.

✅ Android status bar insets
	— `SafeAreaView` from react-native only insets on iOS. On Android we pad by
	  `StatusBar.currentHeight` so content doesn't render under the clock/battery.

✅ React Native New Architecture enabled
	— `"newArchEnabled": true` in app.json enables Fabric renderer + TurboModules.
	  Requires RN 0.74+ (we're on 0.74.5). Faster rendering, concurrent features.
	  No code changes needed — our components use the public RN API.

✅ Monorepo Metro config
	— Metro watches the whole workspace so it resolves workspace:* symlinks (pnpm).
	  Custom `resolveRequest` rewrites relative `.js` imports to resolve `.ts`/`.tsx`
	  sources (needed for verbatimModuleSyntax + moduleResolution: Bundler).

✅ Session management features
	— Multi-session per machine, background sessions survive disconnect (daemon keeps PTY alive).
	  Rename sessions, close sessions, refresh button in terminal.
	— Cross-device session continuation (start on phone, pick up on desktop).

✅ Chat function (AI tool launcher)
	— Choose between shell (bash) and AI tool launchers (Claude Code, freebuff, ollama).
	  Tool list from GET /api/tools. Chat mode: dispatch-style with notification when
	  response is ready. Builds on the existing PTY + WebSocket infrastructure.

---

## Build methods

### Method 1: EAS cloud build (recommended for release)

No local Android SDK needed. Builds run on Expo's managed infrastructure.

```bash
# From repo root — build a release-signed APK for internal distribution
pnpm --filter @pilot/app build:android:preview

# Full command:
# cd packages/app && eas build --platform android --profile preview --non-interactive
```

The preview profile in `eas.json`:
```json
"preview": {
  "node": "20.18.0",
  "pnpm": "9.12.0",
  "distribution": "internal",
  "android": {
    "buildType": "apk",
    "gradleCommand": ":app:assembleRelease"
  }
}
```

Output: a QR code + install URL from EAS. Install on any Android device directly.

### Method 2: Local Gradle build

Requires local toolchain. Useful for rapid iteration during development.

```bash
# Prerequisites: Android SDK, JDK 17+, Gradle
# From packages/app:
pnpm build:android:local:debug     # debug APK → android/app/build/outputs/apk/debug/
pnpm build:android:local:release   # release APK → android/app/build/outputs/apk/release/
```

Pipeline: `expo prebuild --platform android --clean` → `patch:android` → `./gradlew assembleDebug`

### Method 3: Expo development build

For hot-reload during development:

```bash
pnpm --filter @pilot/app start          # Metro bundler
# Press 'a' for Android, or scan QR with Expo Go
```

---

## Prerequisites (local builds only)

| Tool | Version | Check |
|------|---------|-------|
| Node.js | ≥ 20 | `node --version` |
| pnpm | ≥ 9 | `pnpm --version` |
| JDK | 17 (LTS) | `java -version` |
| Android SDK | Build-tools 34+, Platform 34 | `sdkmanager --list` |
| Gradle | 8.x (wrapper included) | `./gradlew --version` |
| ANDROID_HOME | Set to SDK root | `echo $ANDROID_HOME` |

Set environment variables:
```bash
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
```

Install SDK components:
```bash
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

---

## EAS configuration

**`eas.json`** (repo root):
```json
{
  "cli": { "version": ">= 7.0.0", "appVersionSource": "remote" },
  "build": {
    "preview": {
      "node": "20.18.0", "pnpm": "9.12.0",
      "distribution": "internal",
      "android": { "buildType": "apk", "gradleCommand": ":app:assembleRelease" }
    },
    "production": {
      "node": "20.18.0", "pnpm": "9.12.0",
      "android": { "buildType": "app-bundle" }
    }
  },
  "submit": {
    "production": { "android": { "track": "internal" } }
  }
}
```

**`app.json`** (packages/app/):
```json
{
  "expo": {
    "name": "Pilot", "slug": "pilot", "version": "0.1.0",
    "android": {
      "package": "com.pilot.app", "versionCode": 1,
      "permissions": ["android.permission.CAMERA"],
      "usesCleartextTraffic": true
    }
  }
}
```

---

## Signing

- **Preview builds**: EAS manages keystore automatically ("remote" appVersionSource).
  First build generates an upload keystore stored in EAS servers.
- **Production builds**: Same EAS-managed keystore, or bring your own via
  `eas credentials`. For Play Store submission, the upload key must match what
  Google Play Console expects.
- **Local release builds**: Need a local keystore at `android/app/release.keystore`
  with properties in `android/gradle.properties` (not committed). Use debug
  builds for local iteration; leave release signing to EAS.

---

## Android-specific code considerations

### Metro + pnpm monorepo

`metro.config.js` does three things:
1. `watchFolders` includes the whole workspace so Metro picks up `packages/shared`
2. `nodeModulesPaths` includes both local and workspace node_modules
3. Custom `resolveRequest` rewrites `.js` → `.ts`/`.tsx` for verbatimModuleSyntax

### Cleartext HTTP

Android 9+ (API 28+) blocks cleartext HTTP in release builds. Our app communicates
with the local daemon over Tailscale (WireGuard-encrypted tunnel), so cleartext
inside it is safe. Two layers ensure this:
1. `"usesCleartextTraffic": true` in `app.json`'s expo.android config
2. Post-prebuild patch adds `android:usesCleartextTraffic="true"` to
   AndroidManifest.xml as a belt-and-suspenders measure

### Status bar insets

React Native's `SafeAreaView` only insets on iOS. On Android, content renders
under the status bar. Fixed with manual padding:
```tsx
paddingTop: Platform.OS === 'android' ? (RNStatusBar.currentHeight ?? 0) : 0
```

### expo-camera permissions

Camera permission is declared in `app.json` via the expo-camera plugin.
Runtime permission requested on first QR scan attempt. Handle deny gracefully.

---

## Patch script (scripts/patch-android-prebuild.mjs)

Applied after every `expo prebuild --clean` (which wipes the `android/` directory).
All steps are idempotent:

1. **settings.gradle**: `require.resolve('@react-native/gradle-plugin/package.json')`
   fails under pnpm because the transitive dep isn't resolvable from `android/`.
   Rewritten to paths-based form used elsewhere in the file.

2. **colors.xml** (values + values-night): Expo's splash theme references
   `@color/splashscreen_background` but doesn't emit it — resource linking fails
   without it. Adds `#ffffff` as fallback.

3. **AndroidManifest.xml**: Release builds default `usesCleartextTraffic` to OFF.
   Adds `android:usesCleartextTraffic="true"` so the app can reach the daemon over
   plain HTTP inside the Tailscale tunnel.

---

## Testing matrix

| Device / Emulator | Arch | Status |
|---|---|---|
| Pixel 8 (Android 14, API 34) | arm64-v8a | ⬜ Test |
| Pixel 6a (Android 13, API 33) | arm64-v8a | ⬜ Test |
| Samsung Galaxy S23 (Android 14, API 34) | arm64-v8a | ⬜ Test |
| Emulator (Android 11, API 30) | x86_64 | ⬜ Test |
| Emulator (Android 9, API 28) | x86_64 | ⬜ Test (minimum) |

### Key scenarios

| Scenario | Expected result |
|---|---|
| QR scan pairing | Deep link parses payload, shows machine in list |
| Open terminal session (bash) | WebSocket connects, PTY renders, keyboard works |
| Background session | Leave terminal, return — session still running |
| Multiple sessions per machine | Two+ terminal sessions open and switchable |
| Folder picker | Browse folders on daemon, pick one for session cwd |
| Hardware back button | Pops screen stack; exits app from home screen only |
| App backgrounded/foregrounded | Reconnects WebSocket, replay scrollback |
| No Tailscale (LAN only) | App reaches daemon over local Wi-Fi IP |
| Tailscale connected | App reaches daemon over 100.x.y.z address |
| Camera denied | Graceful error, manual host input fallback |
| New Architecture rendering | No visual regressions vs old architecture |

---

## Versioning

- `versionCode` — integer in `packages/app/app.json` under `expo.android.versionCode`.
  Increment before every Play Store upload. EAS reads it automatically
  (`"appVersionSource": "remote"`). Currently `1`.
- `version` — semantic version in `packages/app/app.json` under `expo.version`.
  Displayed to users. Currently `0.1.0`.

---

## Priority order (what to build first)

1. **EAS preview build** — produce an APK that can be installed on any device
2. **Session management** — rename, close, refresh in active terminal sessions
3. **Chat function** — AI tool launcher with notification on response
4. **Play Store submission** — production AAB build + submit to internal track
5. **Local build pipeline** — verify debug APK builds without EAS
6. **Testing matrix** — run through all device/API level combos
7. **Automated CI** — GitHub Actions workflow for PR preview builds

---

## Script reference

```bash
# From repo root:

# First: build shared types (required for local builds; EAS does this automatically)
pnpm --filter @pilot/shared build

# EAS cloud — preview APK
pnpm --filter @pilot/app build:android:preview

# EAS cloud — production AAB
pnpm --filter @pilot/app build:android:production

# Local debug APK (requires Android SDK + JDK 17)
pnpm --filter @pilot/app build:android:local:debug

# Local release APK (requires keystore configured)
pnpm --filter @pilot/app build:android:local:release

# Dev server (Metro)
pnpm --filter @pilot/app start

# Prebuild only (generates android/ without building)
pnpm --filter @pilot/app prebuild:android

# Typecheck
pnpm --filter @pilot/app typecheck

# Lint
pnpm --filter @pilot/app lint
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `require.resolve('@react-native/gradle-plugin/package.json')` fails | pnpm can't resolve transitive dep from android/ | Run `patch:android` after prebuild (automatic in `build:android:local:*`) |
| `error: resource color/splashscreen_background not found` | Expo prebuild doesn't emit the color | Run `patch:android` (automatic) |
| App shows "Offline" on release APK but not debug | `usesCleartextTraffic` disabled in release | Verify patch ran; check AndroidManifest.xml |
| Metro can't find `@pilot/shared` | Monorepo symlinks not followed | Check metro.config.js watchFolders + nodeModulesPaths |
| `Build failed: Android SDK not found` (local) | ANDROID_HOME not set or SDK not installed | Set ANDROID_HOME, run sdkmanager |
| EAS build fails on install step | pnpm lockfile mismatch | Run `pnpm install --frozen-lockfile` locally and commit |
| Camera permission denied forever | User tapped "Don't ask again" | Direct them to Settings → Apps → Pilot → Permissions |
| Deep link doesn't open app | Intent filter not registered | Check app.json scheme (currently `pilot://`) |
