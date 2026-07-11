import process from 'node:process';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import type { PtyHelloQuery } from '@pilot/shared';

/** Per-spawn context derived from the WS handshake. */
export interface LauncherContext {
  cwd: string;
  cols: number;
  rows: number;
  /** Optional environment overrides (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * A registered tool launcher. Phase 1 registers only `bash`. Phase 2 will
 * register `ollama-run` (uses `hello.model`) and `freebuff`.
 *
 * Each launcher receives the full {@link PtyHelloQuery} so it can pick out
 * any field it needs (today: cwd/cols/rows; tomorrow: model, env vars).
 */
export interface Launcher {
  /** Stable, URL-safe id matching `/^[a-z0-9-]+$/`. */
  id: string;
  /** Human label for the app UI. */
  label: string;
  /** Spawn a PTY process for this tool. */
  spawn(ctx: LauncherContext, hello: PtyHelloQuery): IPty;
}

/**
 * Default shell launcher.
 *
 * Keeps the wire id `bash` (paired apps and stored sessions reference it) but
 * resolves to the platform's real shell:
 *   • POSIX: `$SHELL` (falls back to `bash`) with `-l` so `.bash_profile` /
 *     `.profile` are sourced and user tooling (bun, ollama, nvm shims, etc.)
 *     ends up on PATH.
 *   • Windows: PowerShell (node-pty uses ConPTY; no `-l` — that flag doesn't
 *     exist there). Falls back to `%COMSPEC%` (cmd.exe) if ever needed.
 */
const isWindows = process.platform === 'win32';

const bashLauncher: Launcher = {
  id: 'bash',
  label: isWindows ? 'PowerShell' : 'Bash',
  spawn(ctx, _hello) {
    // Bracket access because noPropertyAccessFromIndexSignature is on.
    const bin = isWindows
      ? 'powershell.exe'
      : (process.env['SHELL'] ?? 'bash');
    const args = isWindows ? ['-NoLogo'] : ['-l'];
    return ptySpawn(bin, args, {
      name: 'xterm-256color',
      cols: ctx.cols,
      rows: ctx.rows,
      cwd: ctx.cwd,
      env: ctx.env ?? process.env,
    });
  },
};

const launchers: ReadonlyMap<string, Launcher> = new Map([
  [bashLauncher.id, bashLauncher],
]);

export function getLauncher(id: string): Launcher | undefined {
  return launchers.get(id);
}

export function listLaunchers(): readonly Launcher[] {
  return Array.from(launchers.values());
}
