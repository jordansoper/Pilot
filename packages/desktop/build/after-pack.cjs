/**
 * electron-builder `afterPack` hook.
 *
 * node-pty ships a `spawn-helper` binary that macOS/Linux fork-exec to launch
 * the shell. Packaging (asar unpacking, zip/7z compression) does not
 * reliably preserve the +x bit — the same class of bug `fix-node-pty-perms.mjs`
 * works around for a plain `pnpm install`. Re-apply it here so a packaged
 * app doesn't silently fail every PTY spawn.
 */
const { chmodSync, readdirSync, statSync } = require('node:fs');
const { join } = require('node:path');

/** Recursively find files named `spawn-helper` under `dir` and mark them executable. */
function fixSpawnHelperPerms(dir, depth = 0) {
  if (depth > 12) return 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let fixed = 0;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      fixed += fixSpawnHelperPerms(full, depth + 1);
    } else if (entry.name === 'spawn-helper') {
      try {
        const mode = statSync(full).mode;
        if ((mode & 0o111) === 0) {
          chmodSync(full, mode | 0o755);
          fixed += 1;
        }
      } catch {
        /* ignore unreadable files */
      }
    }
  }
  return fixed;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return;
  const fixed = fixSpawnHelperPerms(context.appOutDir);
  if (fixed > 0) {
    console.log(`[after-pack] made ${fixed} spawn-helper binary(ies) executable`);
  }
};
