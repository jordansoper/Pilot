import process from 'node:process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import type { PtyHelloQuery, ToolInfo } from '@pilot/shared';

const isWindows = process.platform === 'win32';

/** Per-spawn context derived from the WS handshake. */
export interface LauncherContext {
  cwd: string;
  cols: number;
  rows: number;
  /** Optional environment overrides (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * A registered tool launcher.
 *
 * Each launcher receives the full {@link PtyHelloQuery} so it can pick out any
 * field it needs (cwd/cols/rows for everyone; `model` for ollama).
 */
export interface Launcher {
  /** Stable, URL-safe id matching `/^[a-z0-9-]+$/`. */
  id: string;
  /** Human label for the app UI. */
  label: string;
  /** Executable looked up on PATH to decide whether the tool is installed. */
  bin: string;
  /**
   * Set for the daemon's own shell, which is always spawnable and shouldn't be
   * hidden just because `$SHELL` points somewhere a PATH scan won't find.
   */
  alwaysAvailable?: boolean;
  /**
   * POSIX shell command that installs the tool. When present, the tool is
   * reported as `installable` in `GET /api/tools`, and a `/ws/pty` handshake
   * carrying `install=1` spawns this command in the PTY (then execs the tool
   * for first-run setup) instead of the tool itself. Not supported on
   * Windows.
   */
  installCommand?: string;
  /** Spawn a PTY process for this tool. */
  spawn(ctx: LauncherContext, hello: PtyHelloQuery): IPty;
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    // Windows has no execute bit; PATHEXT membership is the real test there.
    if (!isWindows) accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an executable the way a shell would, returning its full path or null.
 *
 * Deliberately not a `which`/`where` subprocess: this runs for every tool on
 * every `GET /api/tools`, and spawning one process per probe is both slower and
 * unusable from a synchronous caller. Honours `PATHEXT` on Windows, which
 * matters because npm-installed CLIs land as `claude.cmd`, never a bare `.exe`.
 */
export function resolveOnPath(bin: string): string | null {
  const exts = isWindows
    ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  // An explicit path isn't a PATH lookup — check it where it points.
  if (isAbsolute(bin) || bin.includes('/') || (isWindows && bin.includes('\\'))) {
    if (isExecutableFile(bin)) return bin;
    for (const ext of exts) {
      if (ext && isExecutableFile(bin + ext)) return bin + ext;
    }
    return null;
  }

  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, bin + ext);
      if (isExecutableFile(full)) return full;
    }
  }
  return null;
}

/**
 * Spawn a PATH-resolved tool, failing with a message the app can show.
 *
 * Spawns the resolved path directly, including Windows `.cmd`/`.bat` shims —
 * node-pty handles those itself (verified against a synthetic shim), so
 * wrapping them in `cmd.exe /c` would only add a process layer that swallows
 * exit codes and complicates Ctrl-C.
 */
function spawnTool(
  bin: string,
  args: readonly string[],
  ctx: LauncherContext,
  label: string,
): IPty {
  const resolved = resolveOnPath(bin);
  if (!resolved) {
    throw new Error(
      `${label} is not installed on this machine (\`${bin}\` not found on PATH)`,
    );
  }

  return ptySpawn(resolved, [...args], {
    name: 'xterm-256color',
    cols: ctx.cols,
    rows: ctx.rows,
    cwd: ctx.cwd,
    env: ctx.env ?? process.env,
  });
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
 *     exist there).
 */
// Bracket access because noPropertyAccessFromIndexSignature is on.
const shellBin = isWindows ? 'powershell.exe' : (process.env['SHELL'] ?? 'bash');

const shellLauncher: Launcher = {
  id: 'bash',
  label: isWindows ? 'PowerShell' : 'Bash',
  bin: shellBin,
  alwaysAvailable: true,
  spawn(ctx, _hello) {
    return ptySpawn(shellBin, isWindows ? ['-NoLogo'] : ['-l'], {
      name: 'xterm-256color',
      cols: ctx.cols,
      rows: ctx.rows,
      cwd: ctx.cwd,
      env: ctx.env ?? process.env,
    });
  },
};

const ollamaLauncher: Launcher = {
  id: 'ollama',
  label: 'Ollama',
  bin: 'ollama',
  spawn(ctx, hello) {
    // `?model=` comes from the app's model picker. Without one, drop the user
    // at ollama's own output rather than guessing which model they meant.
    const args = hello.model ? ['run', hello.model] : [];
    return spawnTool('ollama', args, ctx, 'Ollama');
  },
};

/**
 * Shared shape for AI coding agents (Claude Code, Freebuff, Codex): a single
 * binary launched with no args, plus an install command the daemon can run on
 * the user's behalf.
 *
 * When the handshake carries `install=1`, the PTY runs the install command
 * and — on success — execs the agent so its first-run setup (login, config)
 * happens right there in the interactive session. On failure it drops into a
 * login shell so the user can investigate from the phone. Runs under
 * `bash -l` (not `$SHELL`, whose syntax may differ — fish) so the user's
 * profile PATH (nvm, npm globals) is loaded for both install and exec.
 */
function agentLauncher(opts: {
  id: string;
  label: string;
  bin: string;
  installCommand: string;
}): Launcher {
  return {
    id: opts.id,
    label: opts.label,
    bin: opts.bin,
    installCommand: opts.installCommand,
    spawn(ctx, hello) {
      if (hello.install === '1' && !isWindows) {
        const script = [
          `echo "[pilot] Installing ${opts.label}..."`,
          `echo "[pilot] Running: ${opts.installCommand}"`,
          `if ${opts.installCommand}; then`,
          `  echo "[pilot] ${opts.label} installed — starting it for first-run setup..."`,
          `  exec ${opts.bin}`,
          `else`,
          `  echo "[pilot] ${opts.label} install failed — see the output above. Dropping into a shell."`,
          `  exec bash -l`,
          `fi`,
        ].join('\n');
        return ptySpawn('bash', ['-lc', script], {
          name: 'xterm-256color',
          cols: ctx.cols,
          rows: ctx.rows,
          cwd: ctx.cwd,
          env: ctx.env ?? process.env,
        });
      }
      return spawnTool(opts.bin, [], ctx, opts.label);
    },
  };
}

const claudeCodeLauncher = agentLauncher({
  id: 'claude-code',
  label: 'Claude Code',
  bin: 'claude',
  installCommand: 'npm install -g @anthropic-ai/claude-code',
});

const freebuffLauncher = agentLauncher({
  id: 'freebuff',
  label: 'Freebuff',
  bin: 'freebuff',
  installCommand: 'npm install -g freebuff',
});

const codexLauncher = agentLauncher({
  id: 'codex',
  label: 'Codex',
  bin: 'codex',
  installCommand: 'npm install -g @openai/codex',
});

const launchers: ReadonlyMap<string, Launcher> = new Map(
  [shellLauncher, ollamaLauncher, claudeCodeLauncher, freebuffLauncher, codexLauncher].map(
    (l) => [l.id, l],
  ),
);

export function getLauncher(id: string): Launcher | undefined {
  return launchers.get(id);
}

export function listLaunchers(): readonly Launcher[] {
  return Array.from(launchers.values());
}

/**
 * Registered tools plus whether each is actually installed here — the body of
 * `GET /api/tools`. Unavailable tools are still listed so the app can show them
 * greyed out rather than pretending they don't exist.
 */
export function listTools(): ToolInfo[] {
  return listLaunchers().map((l) => ({
    id: l.id,
    label: l.label,
    available: l.alwaysAvailable === true || resolveOnPath(l.bin) !== null,
    installable: Boolean(l.installCommand) && !isWindows,
  }));
}
