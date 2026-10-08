import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createConnection } from 'node:net';

const LOCK_FILE = join(homedir(), '.pilot', 'daemon.lock');

/** Check whether a TCP port is in use on a given host. */
function isPortInUse(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => resolve(false));
  });
}

/**
 * Result of {@link acquireLock}. When `held` is false, `message` explains why
 * and the caller should exit (or ask the user whether to proceed anyway).
 */
export interface LockResult {
  held: boolean;
  /** Human-readable reason when lock couldn't be acquired. */
  message?: string;
}

/**
 * Acquire the daemon singleton lock.
 *
 * 1. Checks whether `port` is already in use on localhost.
 * 2. Checks whether the PID in `~/.pilot/daemon.lock` is still alive.
 * 3. If both checks pass, writes the current PID to the lock file.
 *
 * Designed to prevent accidentally stacking two daemons on the same port
 * (e.g. the user forgot one was running in a tmux session).
 */
export async function acquireLock(bind: string, port: number): Promise<LockResult> {
  // 1. Port check — test against the intended bind address.
  const testHost = bind === '0.0.0.0' ? '127.0.0.1' : bind;
  if (await isPortInUse(testHost, port)) {
    // Is the existing listener our own daemon? Try reading the lock file.
    let pidInfo = '';
    try {
      const raw = readFileSync(LOCK_FILE, 'utf8').trim();
      pidInfo = ` (PID ${raw})`;
    } catch {
      /* no lock file */
    }
    return {
      held: false,
      message: `Port ${port} is already in use${pidInfo}. Stop the existing daemon first, or use --port to pick a different port.`,
    };
  }

  // 2. Stale lock file check.
  if (existsSync(LOCK_FILE)) {
    try {
      const raw = readFileSync(LOCK_FILE, 'utf8').trim();
      const pid = Number(raw);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 0); // signal 0 = existence check
          return {
            held: false,
            message: `Lock file ${LOCK_FILE} exists and PID ${pid} is alive. If you're sure the daemon is stopped, delete the lock file and retry.`,
          };
        } catch {
          // PID not alive — stale lock file, clean it up.
        }
      }
    } catch {
      /* unreadable — overwrite below */
    }
  }

  // 3. Write current PID.
  mkdirSync(dirname(LOCK_FILE), { recursive: true });
  writeFileSync(LOCK_FILE, `${String(process.pid)}\n`, { mode: 0o644 });

  return { held: true };
}

/**
 * Remove the PID lock file. Call on graceful shutdown. Does NOT throw if the
 * file is already gone (e.g. another process cleaned it up).
 */
export function releaseLock(): void {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* already removed or never created — noop */
  }
}
