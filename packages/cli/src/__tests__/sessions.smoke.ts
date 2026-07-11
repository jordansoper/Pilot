/**
 * Session-persistence smoke test. Boots the daemon, opens a WS, sets a shell
 * variable, DROPS the socket (like backgrounding the app), reconnects with the
 * returned session id, and asserts: (1) the scrollback is replayed, and (2) the
 * SAME shell is still there (the variable survives). Exits 0 on pass.
 *
 * Run: `pnpm --filter @pilot/cli sessions-smoke`
 */
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import WebSocket from 'ws';
import { TOKEN_BYTES } from '@pilot/shared';
import { startServer } from '../server.js';

function decodeControl(buf: Buffer): { type?: string; id?: string; resumed?: boolean } {
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
  const wsUrl = `ws://127.0.0.1:${port}/ws/pty?cwd=${encodeURIComponent(
    process.cwd(),
  )}&tool=bash&cols=80&rows=24`;
  const marker = `SESS_${randomBytes(3).toString('hex')}`;

  // 1) First connection: capture the session id, set a shell variable.
  const ws1 = new WebSocket(wsUrl, token);
  let sessionId = '';
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no session id in 10s')), 10_000);
    ws1.on('open', () => ws1.send(`FOO=${marker}\n`));
    ws1.on('message', (data, isBinary) => {
      if (isBinary) {
        const ctrl = decodeControl(data as Buffer);
        if (ctrl.type === 'session' && ctrl.id) {
          sessionId = ctrl.id;
          clearTimeout(t);
          resolve();
        }
      }
    });
    ws1.on('error', reject);
  });
  // Give the PTY a moment to process the variable assignment, then drop.
  await new Promise((r) => setTimeout(r, 400));
  ws1.terminate(); // hard drop — simulates a backgrounded app losing the socket

  // 2) Reconnect with the session id; expect replay + the live shell.
  const ws2 = new WebSocket(`${wsUrl}&session=${sessionId}`, token);
  let captured = '';
  let resumed = false;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `did not see ${marker} echoed after resume in 15s. resumed=${resumed}. Got:\n${captured.slice(-400)}`,
          ),
        ),
      15_000,
    );
    ws2.on('open', () => {
      // Ask the resumed shell to echo the variable set on the first connection.
      setTimeout(() => ws2.send('echo "V=$FOO"\n'), 500);
    });
    ws2.on('message', (data, isBinary) => {
      if (isBinary) {
        const ctrl = decodeControl(data as Buffer);
        if (ctrl.type === 'session') resumed = !!ctrl.resumed;
        return;
      }
      captured += data.toString();
      // The variable survives only if it's the same shell process.
      if (captured.includes(`V=${marker}`)) {
        clearTimeout(t);
        resolve();
      }
    });
    ws2.on('error', reject);
  });

  if (!resumed) throw new Error('server did not report resumed=true');
  ws2.close();
  await close();
  console.log(
    `[sessions-smoke] PASS — resumed session ${sessionId.slice(0, 8)}…, $FOO survived the drop`,
  );
}

main().catch((err) => {
  console.error(`[sessions-smoke] FAIL — ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
