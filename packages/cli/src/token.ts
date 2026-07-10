import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { TOKEN_BYTES } from '@pilot/shared';

/** Where the persistent pairing token lives. */
export function tokenFilePath(): string {
  return join(homedir(), '.pilot', 'token');
}

const TOKEN_HEX_RE = new RegExp(`^[0-9a-f]{${TOKEN_BYTES * 2}}$`);

export interface TokenResult {
  token: string;
  path: string;
  /** true if a new token was generated (first run or `rotate`). */
  created: boolean;
}

/**
 * Load the pairing token from `~/.pilot/token`, creating it on first run.
 *
 * Persisting the token means a paired phone keeps working across daemon
 * restarts / reboots — the caller no longer mints a fresh `randomBytes` token
 * every boot, which used to silently invalidate every saved pairing. Pass
 * `rotate: true` to force a new token (and re-pair) on purpose.
 *
 * The file is written 0600 (owner-only); the token is a bearer credential.
 */
export function loadOrCreateToken(opts: { rotate?: boolean } = {}): TokenResult {
  const path = tokenFilePath();

  if (!opts.rotate) {
    try {
      const existing = readFileSync(path, 'utf8').trim();
      if (TOKEN_HEX_RE.test(existing)) {
        return { token: existing, path, created: false };
      }
      // Present but malformed — fall through and regenerate.
    } catch {
      // Not present or unreadable — fall through and create.
    }
  }

  const token = randomBytes(TOKEN_BYTES).toString('hex');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // tighten perms even if the file pre-existed
  } catch {
    // best-effort on platforms that don't support chmod
  }
  return { token, path, created: true };
}
