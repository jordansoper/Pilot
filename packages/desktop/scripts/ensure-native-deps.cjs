// Rebuild native deps against Electron's ABI — but only when we actually
// have to.
//
// node-pty (our only native dep) is built on node-addon-api, i.e. Node-API,
// which is ABI-stable across Node and Electron versions. Since 1.1.0 it ships
// prebuilt binaries and its own install script prefers them
// (`node scripts/prebuild.js || node-gyp rebuild`). When a prebuild exists for
// this platform+arch, a source rebuild produces a binary we would have loaded
// identically — so `electron-builder install-app-deps` is pure cost, and on a
// machine whose Visual Studio is newer than the bundled node-gyp can detect
// (e.g. VS 2026 / v18) it doesn't just cost time, it fails the whole install.
//
// Platforms without a prebuild still get the rebuild, so nothing regresses.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const NATIVE_DEPS = ['node-pty'];

function prebuildDirFor(dep) {
  let pkgJson;
  try {
    pkgJson = createRequire(__filename).resolve(`${dep}/package.json`);
  } catch {
    return null; // Not installed (or not resolvable) — let the rebuild decide.
  }
  return path.join(
    path.dirname(pkgJson),
    'prebuilds',
    `${process.platform}-${process.arch}`,
  );
}

const missing = NATIVE_DEPS.filter((dep) => {
  const dir = prebuildDirFor(dep);
  return !dir || !fs.existsSync(dir);
});

if (missing.length === 0) {
  console.log(
    `[pilot] Node-API prebuilds present for ${NATIVE_DEPS.join(', ')} ` +
      `(${process.platform}-${process.arch}) — skipping electron-builder install-app-deps.`,
  );
  process.exit(0);
}

console.log(`[pilot] No prebuild for ${missing.join(', ')} — running install-app-deps.`);
const result = spawnSync('electron-builder', ['install-app-deps'], {
  stdio: 'inherit',
  shell: true,
});
process.exit(result.status ?? 1);
