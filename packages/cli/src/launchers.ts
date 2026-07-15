import process from 'node:process';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { execSync } from 'node:child_process';
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
  /**
   * Binary probed for availability (`which <bin>`). Not always the same as
   * `id` — e.g. the `claude-code` tool runs the `claude` binary.
   */
  bin: string;
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
  bin: 'bash',
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

/** Simple `which` check — returns true if the binary is on PATH. */
function hasBin(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ollama launcher — `ollama run <model>` or plain `ollama` if no model given.
 */
const ollamaLauncher: Launcher = {
  id: 'ollama',
  label: 'Ollama',
  bin: 'ollama',
  spawn(ctx, hello) {
    const args = hello.model ? ['run', hello.model] : [];
    return ptySpawn('ollama', args, {
      name: 'xterm-256color',
      cols: ctx.cols,
      rows: ctx.rows,
      cwd: ctx.cwd,
      env: ctx.env ?? process.env,
    });
  },
};

/**
 * Shared shape for AI coding agents (Claude Code, Freebuff, Codex): each is
 * a single binary launched with no args, plus an install command the daemon
 * can run on the user's behalf.
 *
 * When the handshake carries `install=1`, the PTY runs the install command
 * and — on success — execs the agent so its first-run setup (login, config)
 * happens right there in the interactive session. On failure it drops into
 * a login shell so the user can investigate from the phone. Runs under
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
      return ptySpawn(opts.bin, [], {
        name: 'xterm-256color',
        cols: ctx.cols,
        rows: ctx.rows,
        cwd: ctx.cwd,
        env: ctx.env ?? process.env,
      });
    },
  };
}

/** Claude Code — the `claude` CLI from Anthropic. */
const claudeCodeLauncher = agentLauncher({
  id: 'claude-code',
  label: 'Claude Code',
  bin: 'claude',
  installCommand: 'npm install -g @anthropic-ai/claude-code',
});

/** Freebuff — the `freebuff` CLI AI coding agent. */
const freebuffLauncher = agentLauncher({
  id: 'freebuff',
  label: 'Freebuff',
  bin: 'freebuff',
  installCommand: 'npm install -g freebuff',
});

/** Codex — the `codex` CLI from OpenAI. */
const codexLauncher = agentLauncher({
  id: 'codex',
  label: 'Codex',
  bin: 'codex',
  installCommand: 'npm install -g @openai/codex',
});

const launchers: ReadonlyMap<string, Launcher> = new Map([
  [bashLauncher.id, bashLauncher],
  [ollamaLauncher.id, ollamaLauncher],
  [claudeCodeLauncher.id, claudeCodeLauncher],
  [freebuffLauncher.id, freebuffLauncher],
  [codexLauncher.id, codexLauncher],
]);

export function getLauncher(id: string): Launcher | undefined {
  return launchers.get(id);
}

export function listLaunchers(): readonly Launcher[] {
  return Array.from(launchers.values());
}

/** List all launchers with live availability checks. */
export function listLaunchersWithAvailability(): Array<{
  id: string;
  label: string;
  available: boolean;
  installable: boolean;
}> {
  return Array.from(launchers.values()).map((l) => ({
    id: l.id,
    label: l.label,
    // Probe the actual binary, not the tool id — they differ for
    // claude-code (binary: `claude`).
    available: l.id === 'bash' || hasBin(l.bin),
    installable: Boolean(l.installCommand) && !isWindows,
  }));
}
