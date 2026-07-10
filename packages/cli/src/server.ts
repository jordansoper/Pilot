import fs from 'node:fs';
import process from 'node:process';
import type { Duplex } from 'node:stream';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  WebSocketServer,
  type RawData,
  type WebSocket,
} from 'ws';
import type { IPty } from 'node-pty';
import {
  HEALTH_PATH,
  PROTOCOL_VERSION,
  PtyHelloQuerySchema,
  SHARED_PACKAGE_VERSION,
  WS_PATH,
  type HealthResponse,
  type PtyHelloQuery,
} from '@pilot/shared';
import { checkBearer } from './auth.js';
import { getLauncher } from './launchers.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

/** Parsed PtyHello cache for the upgrade→connection handoff. */
const queryCache = new WeakMap<IncomingMessage, PtyHelloQuery>();
/** Liveness flag for the heartbeat, kept off the ws object. */
const live = new WeakMap<WebSocket, boolean>();

export interface ServerOptions {
  /** Hex bearer token, generated per CLI startup. */
  token: string;
  /** TCP port (use 0 to let the OS pick an ephemeral one). */
  port: number;
  /** IP to bind (Tailscale IP, 127.0.0.1, or 0.0.0.0). */
  bind: string;
  /** Resolved Tailscale IPv4, or null if not on a tailnet. */
  tailscaleIp: string | null;
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * Normalize any ws RawData variant to a Buffer for term.write. In Node
 * `ws@8` binary frames arrive as `Buffer`, but we narrow defensively so an
 * `ArrayBuffer` (the only remaining case after the two type guards) is
 * handled cleanly.
 */
function rawToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  // After the two type guards above, `data` has narrowed to `ArrayBuffer`.
  return Buffer.from(data);
}

/**
 * Start the HTTP+WS daemon. Returns the actual bound port (might differ
 * from `opts.port` when caller asked for `port: 0`).
 */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  let actualPort = opts.port;
  const httpServer = createServer((req, res) => {
    handleHttp(req, res, opts, actualPort);
  });

  const wss = new WebSocketServer({
    noServer: true,
    // Bounded so a single misbehaving client can't wedge the daemon.
    maxPayload: 16 * 1024,
  });

  httpServer.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    handleUpgrade(req, socket, head, wss, opts, actualPort);
  });

  // Server-side WS heartbeat: ping every 30s. A client that misses two
  // pongs is terminated and (via the connection handler) has its PTY
  // killed. Critical for mobile clients that silently drop TCP without FIN.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const alive = live.get(client) ?? true;
      if (!alive) {
        client.terminate();
        continue;
      }
      live.set(client, false);
      try {
        client.ping();
      } catch {
        /* socket already gone */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: WebSocket, req) => {
    live.set(ws, true);
    ws.on('pong', () => live.set(ws, true));
    handlePtyConnection(ws, req);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.bind, () => {
      const addr = httpServer.address();
      actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve();
    });
  });

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const client of wss.clients) client.terminate();
        wss.close();
        httpServer.close(() => resolve());
      }),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP routes
// ─────────────────────────────────────────────────────────────────────────

function send401(res: ServerResponse): void {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  actualPort: number,
): void {
  if (!checkBearer(req, opts.token)) {
    send401(res);
    return;
  }
  const url = new URL(req.url ?? '/', `http://${opts.bind}:${actualPort}`);

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }
  if (url.pathname === HEALTH_PATH) {
    // process.uptime() is monotonic; Date.now() can jump on NTP corrections.
    // actualPort (not opts.port) so a smoke test using port=0 reports the
    // OS-assigned ephemeral value.
    const body: HealthResponse = {
      version: SHARED_PACKAGE_VERSION,
      uptimeMs: Math.round(process.uptime() * 1000),
      tailscaleIp: opts.tailscaleIp,
      port: actualPort,
    };
    sendJson(res, 200, body);
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

// ─────────────────────────────────────────────────────────────────────────
// WS /ws/pty
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pre-upgrade handshake: path → bearer auth → query schema → cwd existence.
 * Each step rejects on the raw socket before the WS protocol switch.
 */
function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  opts: ServerOptions,
  actualPort: number,
): void {
  const url = new URL(req.url ?? '/', `http://${opts.bind}:${actualPort}`);
  if (url.pathname !== WS_PATH) {
    socket.destroy();
    return;
  }
  if (!checkBearer(req, opts.token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const parsed = PtyHelloQuerySchema.safeParse(
    Object.fromEntries(url.searchParams),
  );
  if (!parsed.success) {
    socket.write(
      'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
        JSON.stringify({ error: 'invalid handshake', issues: parsed.error.issues }),
    );
    socket.destroy();
    return;
  }
  const hello = parsed.data;
  try {
    const stat = fs.statSync(hello.cwd);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    socket.write(
      'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
        JSON.stringify({ error: 'invalid cwd', cwd: hello.cwd }),
    );
    socket.destroy();
    return;
  }
  queryCache.set(req, hello);
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    wss.emit('connection', ws, req);
  });
}

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

function parseResize(raw: string): ResizeMessage | null {
  try {
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj === 'object' &&
      (obj as { type?: unknown }).type === 'resize' &&
      typeof (obj as { cols?: unknown }).cols === 'number' &&
      typeof (obj as { rows?: unknown }).rows === 'number'
    ) {
      const r = obj as ResizeMessage;
      return { type: 'resize', cols: r.cols, rows: r.rows };
    }
  } catch {
    /* not JSON → input frame */
  }
  return null;
}

function handlePtyConnection(ws: WebSocket, req: IncomingMessage): void {
  const hello = queryCache.get(req);
  if (!hello) {
    ws.close(1011, 'missing handshake');
    return;
  }
  const launcher = getLauncher(hello.tool);
  if (!launcher) {
    ws.close(1008, `unknown tool: ${hello.tool}`);
    return;
  }

  let term: IPty;
  try {
    term = launcher.spawn(
      { cwd: hello.cwd, cols: hello.cols, rows: hello.rows },
      hello,
    );
  } catch (err) {
    try {
      ws.send(
        JSON.stringify({
          type: 'exit',
          protocol: PROTOCOL_VERSION,
          exitCode: -1,
          signal: null,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch {
      /* socket already gone */
    }
    try {
      ws.close(1011, 'spawn failed');
    } catch {
      /* already closed */
    }
    return;
  }

  // Settle-once flag so the "client closed → process exits → onExit sends
  // JSON after ws.close" path can't throw and crash the daemon.
  let closed = false;
  const finishFromProcess = (payload: {
    exitCode: number;
    signal: number | null;
  }) => {
    if (closed) return;
    closed = true;
    try {
      ws.send(JSON.stringify({ type: 'exit', protocol: PROTOCOL_VERSION, ...payload }));
    } catch {
      /* socket already gone */
    }
    try {
      ws.close(1000, 'pty exited');
    } catch {
      /* already closed */
    }
    live.delete(ws);
  };
  const finishFromClient = () => {
    if (closed) return;
    closed = true;
    try {
      term.kill();
    } catch {
      /* already dead */
    }
    live.delete(ws);
  };

  const safeWrite = (data: string | Buffer) => {
    if (closed) return;
    try {
      term.write(data);
    } catch {
      finishFromProcess({ exitCode: -1, signal: null });
    }
  };

  // node-pty's onData delivers a stringified PTY output chunk.
  term.onData((data: string) => {
    if (closed) return;
    try {
      ws.send(data);
    } catch {
      finishFromProcess({ exitCode: -1, signal: null });
    }
  });

  term.onExit((event: { exitCode: number; signal?: number }) => {
    finishFromProcess({
      exitCode: event.exitCode,
      signal: event.signal ?? null,
    });
  });

  ws.on('message', (data: RawData, isBinary) => {
    if (closed) return;
    if (isBinary) {
      safeWrite(rawToBuffer(data));
      return;
    }
    const text = typeof data === 'string' ? data : rawToBuffer(data).toString('utf8');
    const control = parseResize(text);
    if (control) {
      try {
        term.resize(control.cols, control.rows);
      } catch {
        /* resize after exit — discard silently */
      }
      return;
    }
    safeWrite(Buffer.from(text, 'utf8'));
  });

  ws.on('close', () => {
    finishFromClient();
  });
}
