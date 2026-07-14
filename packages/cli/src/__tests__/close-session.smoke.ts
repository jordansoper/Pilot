/**
 * DELETE /api/sessions/:id smoke test.
 *
 * Boots the daemon in-process, opens a bash WS to create a session, then
 * exercises the close endpoint from every angle:
 *
 *   • 401 without auth
 *   • 404 on a syntactically valid but unknown UUID
 *   • 404 on a non-UUID path segment ("/api/sessions/not-a-uuid")
 *   • 405 on the collection ("/api/sessions", no id)
 *   • 204 on a real id — and the WS we attached to that session sees a
 *     `{type:'exit', exitCode, signal}` binary control frame before the
 *     server closes the socket (proves the kill cascaded to the user).
 *
 * Run: `pnpm --filter @pilot/cli close-session-smoke`
 */
import { randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';
import WebSocket from 'ws';
import { TOKEN_BYTES } from '@pilot/shared';
import { startServer } from '../server.js';

function decodeControl(buf: Buffer): { type?: string; exitCode?: number } {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const { port, close } = await startServer({
    token,
    port: 0,
    bind: '127.0.0.1',
    tailscaleIp: null,
  });
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${token}` };

  // ── 1) Auth gate ─────────────────────────────────────────────────────────
  const unauth = await fetch(`${base}/api/sessions/${randomUUID()}`, { method: 'DELETE' });
  if (unauth.status !== 401) {
    throw new Error(`DELETE without auth: expected 401, got ${unauth.status}`);
  }

  // ── 2) Bogus id formats ──────────────────────────────────────────────────
  const notUuid = await fetch(`${base}/api/sessions/not-a-uuid`, {
    method: 'DELETE',
    headers: auth,
  });
  if (notUuid.status !== 404) {
    throw new Error(`DELETE /api/sessions/not-a-uuid: expected 404, got ${notUuid.status}`);
  }
  const noId = await fetch(`${base}/api/sessions`, { method: 'DELETE', headers: auth });
  if (noId.status !== 405) {
    throw new Error(`DELETE /api/sessions (no id): expected 405, got ${noId.status}`);
  }

  // ── 3) Real session, real close, plus exit-cascade on the WS ─────────────
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws/pty?cwd=${encodeURIComponent(
      process.cwd(),
    )}&tool=bash&cols=80&rows=24`,
    { headers: auth },
  );

  const sessionId = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no session id in 5s')), 5000);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse((data as Buffer).toString('utf8'));
      } catch {
        return;
      }
      const obj = parsed as { type?: string; id?: unknown };
      if (obj?.type === 'session' && typeof obj.id === 'string') {
        clearTimeout(t);
        resolve(obj.id);
      }
    });
    ws.once('error', reject);
  });

  // Valid UUID, but no such session.
  const unknown = await fetch(`${base}/api/sessions/${randomUUID()}`, {
    method: 'DELETE',
    headers: auth,
  });
  if (unknown.status !== 404) {
    throw new Error(`DELETE unknown id: expected 404, got ${unknown.status}`);
  }

  // Kill the real session — should 204, and the WS should see the exit frame
  // BEFORE the server closes the socket (proves the cascade ordering).
  const exitPromise = new Promise<{ exitCode: number }>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no exit frame in 5s')), 5000);
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      const ctrl = decodeControl(data as Buffer);
      if (ctrl.type === 'exit') {
        clearTimeout(t);
        resolve({ exitCode: ctrl.exitCode ?? -1 });
      }
    });
    ws.once('error', reject);
  });

  const kill = await fetch(`${base}/api/sessions/${sessionId}`, { method: 'DELETE', headers: auth });
  if (kill.status !== 204) {
    throw new Error(`DELETE real session: expected 204, got ${kill.status}`);
  }

  // Idempotent: a second DELETE for the same id now returns 404 (gone).
  const second = await fetch(`${base}/api/sessions/${sessionId}`, {
    method: 'DELETE',
    headers: auth,
  });
  if (second.status !== 404) {
    throw new Error(`DELETE real session (after): expected 404, got ${second.status}`);
  }

  await exitPromise;
  await close();
  console.log(
    `[close-session-smoke] PASS — 401/404/404/405/204/404 all correct; WS saw the exit cascade`,
  );
}

main().catch((err) => {
  console.error(
    `[close-session-smoke] FAIL — ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
});
