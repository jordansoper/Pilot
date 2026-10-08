// electron-builder afterPack hook — bake the daemon's module-resolution shims
// into the bundle at package time, before code-signing runs.
//
// The forked daemon (daemon.cjs) is plain Node, so it cannot resolve packages
// from inside app.asar. Three constraints shape what happens below:
//
//   1. The compiled cli-dist/shared-dist are ESM with bare imports (ws, zod,
//      qrcode, node-pty), and they live in Resources/, not inside the asar —
//      so each needs a node_modules shim next to it.
//   2. Packages must load from a path with NO `app.asar` segment. node-pty
//      finds its spawn-helper by rewriting `app.asar` → `app.asar.unpacked`
//      in its own realpath; run it from an already-unpacked path and that
//      produces `app.asar.unpacked.unpacked`, so every PTY spawn dies with
//      "posix_spawnp failed". Hence the real copy at Resources/node_modules
//      rather than pointing the shims at app.asar.unpacked directly.
//   3. Links must be relative, so the bundle survives being moved (dist →
//      /Applications). Nothing here may depend on the build-time path.
//
// Windows gets physical copies instead of symlinks: creating a symlink there
// needs admin rights or Developer Mode. daemon.cjs's runtime self-heal makes
// the same split and only repairs what this hook did not already do.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resourcesDirFor(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  if (packager && typeof packager.getResourcesDir === 'function') {
    return packager.getResourcesDir(appOutDir);
  }
  // Fallback for a packager shape we don't recognise.
  if (electronPlatformName === 'darwin') {
    const productName = packager?.appInfo?.productFilename ?? 'Pilot';
    return path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources');
  }
  return path.join(appOutDir, 'resources');
}

exports.default = async function afterPack(context) {
  const isWin = context.electronPlatformName === 'win32';
  const resources = resourcesDirFor(context);

  const asarUnpackedNm = path.join(resources, 'app.asar.unpacked', 'node_modules');
  const realNm = path.join(resources, 'node_modules');
  const cliDist = path.join(resources, 'cli-dist');
  const sharedDist = path.join(resources, 'shared-dist');

  if (!fs.existsSync(asarUnpackedNm)) {
    throw new Error(
      `afterPack: expected unpacked modules at ${asarUnpackedNm}. ` +
        'Check the "asarUnpack" entry in package.json — without it the daemon ' +
        'cannot resolve ws/zod/qrcode/node-pty at runtime.',
    );
  }
  for (const dist of [cliDist, sharedDist]) {
    if (!fs.existsSync(dist)) {
      throw new Error(
        `afterPack: missing ${dist}. Build the workspace first ` +
          '(pnpm --filter @pilot/shared build && pnpm --filter @pilot/cli build).',
      );
    }
  }

  // Mark both dists as ESM so Node treats their .js files as modules. This has
  // to happen BEFORE the shims below: on Windows they are physical copies, so
  // a package.json written afterwards would never reach the copy and
  // `@pilot/shared` would load as CommonJS ("Named export … not found"). On
  // macOS/Linux the shims are symlinks, which is why writing last worked there.
  fs.writeFileSync(
    path.join(sharedDist, 'package.json'),
    JSON.stringify({ name: '@pilot/shared', type: 'module', main: './index.js' }),
    'utf8',
  );
  fs.writeFileSync(
    path.join(cliDist, 'package.json'),
    JSON.stringify({ type: 'module' }),
    'utf8',
  );

  // A real copy, reachable without traversing any `app.asar` segment.
  fs.rmSync(realNm, { recursive: true, force: true });
  fs.cpSync(asarUnpackedNm, realNm, { recursive: true });

  // Make `@pilot/shared` importable. This goes inside the modules copy FIRST,
  // so the per-dist shims below pick it up.
  const nmPilot = path.join(realNm, '@pilot');
  const sharedLink = path.join(nmPilot, 'shared');
  fs.rmSync(sharedLink, { recursive: true, force: true });
  fs.mkdirSync(nmPilot, { recursive: true });
  if (isWin) {
    fs.cpSync(sharedDist, sharedLink, { recursive: true });
  } else {
    fs.symlinkSync(path.relative(nmPilot, sharedDist), sharedLink, 'dir');
  }

  // Both dists need their own shim: ESM resolves a symlinked import to its
  // realpath, so shared-dist's `import 'zod'` resolves from shared-dist rather
  // than through whatever cli-dist was linked to.
  for (const dir of [cliDist, sharedDist]) {
    const nm = path.join(dir, 'node_modules');
    fs.rmSync(nm, { recursive: true, force: true });
    if (isWin) {
      fs.cpSync(realNm, nm, { recursive: true });
    } else {
      fs.symlinkSync(path.relative(dir, realNm), nm, 'dir');
    }
  }
};
