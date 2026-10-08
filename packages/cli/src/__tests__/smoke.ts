/**
 * Smoke test — boots pilot-cli in-process, opens a WS to /ws/pty for bash
 * in this directory, sends `echo <marker>`, and asserts the marker appears
 * in PTY output within 30s. Exits 0 on pass, non-zero on failure.
 *
 * Run with: `pnpm --filter @pilot/cli smoke`
 *
 * Requires bash on PATH (or process.env.SHELL resolving to a working shell).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import WebSocket from 'ws';
import {
  FS_ALLOWLIST_ROOT_ENV,
  FsMkdirResponseSchema,
  HealthResponseSchema,
  TOKEN_BYTES,
} from '@pilot/shared';
import { startServer } from '../server.js';

const MAX_LOGGED_CHUNKS = 20;
const ACK_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  // Boot the daemon with FS_ALLOWLIST_ROOT pinned to a fresh tmp dir BEFORE
  // startServer (the daemon reads the env once at boot, not per-request).
  // The mkdir tests then run against a private allowlist so they can't
  // pollute the host's $HOME, and the escape test uses a sibling tmp dir,
  // not a hardcoded system path.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-smoke-root-'));
  const tmpOutside = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-smoke-out-'));
  const mkdirName = `pilot-${randomBytes(4).toString('hex')}`;
  process.env[FS_ALLOWLIST_ROOT_ENV] = tmpRoot;

  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const { port, close } = await startServer({
    token,
    port: 0,
    bind: '127.0.0.1',
    tailscaleIp: null,
  });
  console.log(`[smoke] listening on 127.0.0.1:${port}`);

  try {
    // 1) /api/health with a valid token returns 200 + JSON.
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (healthRes.status !== 200) {
      throw new Error(`/api/health status=${healthRes.status}`);
    }
    const healthJson = HealthResponseSchema.parse(await healthRes.json());
    console.log(`[smoke] /api/health OK:`, healthJson);

    // 2) /api/health without a token returns 401.
    const unauthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (unauthRes.status !== 401) {
      throw new Error(`/api/health without auth: expected 401, got ${unauthRes.status}`);
    }

    // 3) POST /api/fs/mkdir — happy path. Expect 201 and a JSON body of
    // shape FsMkdirResponseSchema with the host-native absolute path of the
    // new folder (server-joined, never client-built).
    const mkdirRes = await fetch(`http://127.0.0.1:${port}/api/fs/mkdir`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ parent: tmpRoot, name: mkdirName }),
    });
    if (mkdirRes.status !== 201) {
      throw new Error(`/api/fs/mkdir happy: expected 201, got ${mkdirRes.status}`);
    }
    const mkdirJson = FsMkdirResponseSchema.parse(await mkdirRes.json());
    const expectedPath = path.join(tmpRoot, mkdirName);
    if (mkdirJson.path !== expectedPath) {
      throw new Error(
        `/api/fs/mkdir happy: path mismatch (got ${mkdirJson.path}, expected ${expectedPath})`,
      );
    }

    // 4) POST /api/fs/mkdir — duplicate name → 409 (the directory already
    // exists on disk from step 3).
    const dupRes = await fetch(`http://127.0.0.1:${port}/api/fs/mkdir`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ parent: tmpRoot, name: mkdirName }),
    });
    if (dupRes.status !== 409) {
      throw new Error(`/api/fs/mkdir dup: expected 409, got ${dupRes.status}`);
    }

    // 5) POST /api/fs/mkdir — parent outside the FS allowlist → 400.
    // `tmpOutside` is a real sibling dir that exists on disk, so a missing-
    // path error wouldn't accidentally fake a "path outside allowlist".
    const escapeRes = await fetch(`http://127.0.0.1:${port}/api/fs/mkdir`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ parent: tmpOutside, name: mkdirName }),
    });
    if (escapeRes.status !== 400) {
      throw new Error(`/api/fs/mkdir escape: expected 400, got ${escapeRes.status}`);
    }

    // 6) WS round-trip on bash.
  const marker = `pilot-smoke-${randomBytes(4).toString('hex')}`;
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/pty?cwd=${encodeURIComponent(
      process.cwd(),
    )}&tool=bash&cols=80&rows=24`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  let captured = '';
  let chunksLogged = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ws open timeout')), 5000);
      ws.once('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              `marker not seen after ${ACK_TIMEOUT_MS / 1000}s — captured ` +
                `${captured.length} chars (${chunksLogged} chunks) from PTY:\n` +
                captured.slice(-600),
            ),
          ),
        ACK_TIMEOUT_MS,
      );
      ws.on('message', (data) => {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        captured += text;
        // Burst-log the first N chunks so a hung shell is debuggable.
        if (chunksLogged < MAX_LOGGED_CHUNKS) {
          chunksLogged += 1;
          console.log(
            `[smoke] chunk #${chunksLogged} (${text.length} chars):`,
            JSON.stringify(text.length > 200 ? text.slice(0, 200) + '…' : text),
          );
        }
        if (captured.includes(marker)) {
          clearTimeout(t);
          resolve();
        }
      });
      ws.once('error', (err) => {
        clearTimeout(t);
        reject(err);
      });
      ws.send(`echo ${marker}\n`);
    });
  } finally {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  // 7) Bad token on upgrade returns 401 (no protocol switch).
  await new Promise<void>((resolve, reject) => {
    const sock = new WebSocket(
      `ws://127.0.0.1:${port}/ws/pty?cwd=${encodeURIComponent(process.cwd())}&tool=bash`,
      { headers: { authorization: `Bearer ${'0'.repeat(64)}` } },
    );
    const t = setTimeout(
      () => reject(new Error('bad-auth ws: no response within 5s')),
      5000,
    );
    sock.once('open', () => {
      clearTimeout(t);
      reject(new Error('bad-auth ws unexpectedly opened'));
    });
    sock.once('unexpected-response', (_req, res) => {
      clearTimeout(t);
      if (res.statusCode === 401) resolve();
      else reject(new Error(`bad-auth status=${res.statusCode}`));
      try {
        sock.close();
      } catch {
        /* noop */
      }
    });
    sock.once('error', (err) => {
      clearTimeout(t);
      // 'unexpected-response' fires alongside 'error' on 401; only treat
      // as a real failure if the underlying message doesn't say 401.
      const msg = String(err);
      if (!msg.includes('401') && !msg.toLowerCase().includes('unauthorized')) {
        reject(err);
      }
    });
  });

    console.log(
      `[smoke] PASS — mkdir 201/409/400 OK, bash echoed "${marker}", bad-auth ws rejected`,
    );
  } finally {
    await close();
    // Force-remove both tmp dirs so we don't leak `/tmp/pilot-smoke-*` on
    // every CI run, regardless of pass/fail.
    for (const d of [tmpRoot, tmpOutside]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    // Hygiene: the daemon reads PILOT_FS_ROOT live, so unset it so a future
    // boot in the same Node process (e.g. ad-hoc `tsx server.ts` smoke runs)
    // gets the documented default instead of a leaked test dir.
    delete process.env[FS_ALLOWLIST_ROOT_ENV];
  }
}

main().catch((err) => {
  console.error(`[smoke] FAIL — ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
