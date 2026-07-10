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
 * Bash launcher.
 *
 * Resolves the binary lazily so users on Windows without `bash` on PATH
 * (the common Git-Bash case) still get a working spawn: we try
 * `process.env.SHELL` first and fall back to the literal `bash`.
 *
 * Uses `-l` (login shell) so `.bash_profile` / `.profile` are sourced and
 * user tooling (`bun`, `ollama`, nvm shims, etc.) ends up on PATH.
 */
const bashLauncher: Launcher = {
  id: 'bash',
  label: 'Bash',
  spawn(ctx, _hello) {
    // Bracket access because noPropertyAccessFromIndexSignature is on.
    const bin = process.env['SHELL'] ?? 'bash';
    return ptySpawn(bin, ['-l'], {
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
