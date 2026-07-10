#!/usr/bin/env node
/**
 * Restore the executable bit on node-pty's Unix `spawn-helper` binaries.
 *
 * node-pty ships prebuilt helpers under `prebuilds/<platform-arch>/`. On
 * macOS/Linux it fork-execs `spawn-helper` to launch the shell. pnpm's
 * content-addressable store does not preserve the +x bit when it materializes
 * these files, so a fresh `pnpm install` leaves the helper at mode 644 and
 * every PTY spawn fails with `posix_spawnp failed` (0 bytes ever emitted).
 *
 * This runs on `postinstall` and is a no-op on Windows and when nothing needs
 * fixing, so it is safe to run unconditionally.
 */
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

if (process.platform === 'win32') process.exit(0);

const root = process.cwd();
let fixed = 0;

/** Recursively find files named `spawn-helper` and mark them executable. */
function walk(dir, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Only descend into node_modules trees to keep this fast.
      if (entry.name === 'node_modules' || dir.includes('node_modules')) {
        walk(full, depth + 1);
      }
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
}

walk(join(root, 'node_modules'), 0);

if (fixed > 0) {
  console.log(`[fix-node-pty-perms] made ${fixed} spawn-helper binary(ies) executable`);
}
