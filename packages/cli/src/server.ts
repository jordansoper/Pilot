import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import type { Duplex } from 'node:stream';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  FS_ALLOWLIST_ROOT_ENV,
  FS_PATH,
  HEALTH_PATH,
  PROTOCOL_VERSION,
  PtyHelloQuerySchema,
  SessionPatchSchema,
  SESSIONS_PATH,
  SHARED_PACKAGE_VERSION,
  WS_PATH,
  type FsResponse,
  type HealthResponse,
  type PtyHelloQuery,
} from '@pilot/shared';
import { checkBearer } from './auth.js';
import { getLauncher } from './launchers.js';
import { buildPairingPageHtml, type PairingAddress } from './pairing-page.js';
import { SessionManager } from './sessions.js';

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
  /**
   * `pilot://pair?…` URL. When set, the daemon serves a loopback-only HTML
   * pairing page (crisp QR) at `GET /` — a cleaner alternative to the terminal
   * ASCII QR. Never served to non-loopback clients (the QR carries the token).
   */
  pairingUrl?: string;
  /** Friendly machine name, shown on the pairing page. */
  machineName?: string;
  /** Reachable addresses shown under the QR on the pairing page. */
  pairingAddresses?: PairingAddress[];
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
  const sessions = new SessionManager();
  // Pre-render the loopback pairing page once (the pairing URL is fixed for
  // the daemon's lifetime), so request handling stays synchronous.
  const pairingPageHtml = opts.pairingUrl
    ? await buildPairingPageHtml(
        opts.pairingUrl,
        opts.machineName ?? 'this machine',
        opts.pairingAddresses ?? [],
      )
    : null;
  const httpServer = createServer((req, res) => {
    handleHttp(req, res, opts, actualPort, pairingPageHtml, sessions);
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
    handlePtyConnection(ws, req, sessions);
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
        sessions.closeAll();
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

/** True for connections originating on this machine (loopback). */
function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/**
 * Opt-in per-request logging (set `PILOT_DEBUG=1`). Prints who connected, to
 * what path, and the token prefix they presented — so a "why is my phone
 * offline" investigation can see whether the phone reaches the daemon at all
 * and whether its token matches. Off by default; never logs the full token.
 */
function debugLog(req: IncomingMessage, kind: string): void {
  if (!process.env['PILOT_DEBUG']) return;
  const raw =
    req.headers.authorization ??
    (typeof req.headers['sec-websocket-protocol'] === 'string'
      ? req.headers['sec-websocket-protocol']
      : '');
  const tok =
    raw
      .replace(/^bearer[,\s]+/i, '')
      .trim()
      .slice(0, 6) || 'none';
  const from = req.socket.remoteAddress ?? '?';
  console.log(
    `[debug] ${kind} ${req.method ?? ''} ${req.url ?? ''} from=${from} token=${tok}`,
  );
}

/** Allowlist root for `/api/fs` — nothing above this is browsable. */
function fsRoot(): string {
  return path.resolve(process.env[FS_ALLOWLIST_ROOT_ENV] || homedir());
}

/**
 * Breadcrumb from the allowlist root down to `resolved` (inclusive). All
 * paths are absolute and host-native — clients never join or split paths,
 * so the same client code works against `/home/x` and `C:\Users\x`.
 */
function fsSegments(root: string, resolved: string): FsResponse['segments'] {
  const segments = [{ name: path.basename(root) || root, path: root }];
  if (resolved !== root) {
    const rel = path.relative(root, resolved);
    let acc = root;
    for (const name of rel.split(path.sep)) {
      acc = path.join(acc, name);
      segments.push({ name, path: acc });
    }
  }
  return segments;
}

/** Browse a directory under the allowlist root. Ends the response. */
async function handleFs(res: ServerResponse, url: URL): Promise<void> {
  const root = fsRoot();
  const requested = url.searchParams.get('path');
  const resolved = requested ? path.resolve(requested) : root;
  // Reject anything outside the root (path-escape protection).
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    sendJson(res, 400, { error: 'path outside allowlist', root });
    return;
  }
  try {
    const dirents = await fs.promises.readdir(resolved, { withFileTypes: true });
    const entries = dirents
      .filter((d) => !d.name.startsWith('.') && (d.isDirectory() || d.isFile()))
      .map(
        (d) =>
          ({
            name: d.name,
            type: d.isDirectory() ? 'dir' : 'file',
            path: path.join(resolved, d.name),
          }) as const,
      )
      // Directories first, then alphabetical — good for a folder picker.
      .sort((a, b) =>
        a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name),
      );
    const body: FsResponse = {
      path: resolved,
      parent: resolved === root ? null : path.dirname(resolved),
      sep: path.sep as FsResponse['sep'],
      segments: fsSegments(root, resolved),
      entries,
    };
    sendJson(res, 200, body);
  } catch {
    sendJson(res, 400, { error: 'cannot read path', path: resolved });
  }
}

/**
 * `PATCH /api/sessions/:id` — rename a session. Body: `{ name: string }`
 * (1–100 chars). Responds with the updated session snapshot.
 */
async function handleSessionPatch(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  id: string,
): Promise<void> {
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) throw new Error('body too large');
    }
  } catch {
    sendJson(res, 400, { error: 'could not read body' });
    return;
  }
  let parsed;
  try {
    parsed = SessionPatchSchema.safeParse(JSON.parse(raw));
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }
  if (!parsed.success) {
    sendJson(res, 400, { error: 'invalid body', issues: parsed.error.issues });
    return;
  }
  const name = parsed.data.name.trim();
  if (!name) {
    sendJson(res, 400, { error: 'name must not be blank' });
    return;
  }
  if (!sessions.rename(id, name)) {
    sendJson(res, 404, { error: 'session not found' });
    return;
  }
  const session = sessions.list().find((s) => s.id === id);
  sendJson(res, 200, { session });
}

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  actualPort: number,
  pairingPageHtml: string | null,
  sessions: SessionManager,
): void {
  debugLog(req, 'HTTP');
  const url = new URL(req.url ?? '/', `http://${opts.bind}:${actualPort}`);

  // Loopback-only pairing page. Served BEFORE auth (it has no token) but only
  // to localhost, because the QR embeds the bearer token — exposing it to the
  // tailnet would defeat pairing. Non-loopback callers get a plain 404.
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/pair')) {
    if (pairingPageHtml && isLoopback(req)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pairingPageHtml);
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
    return;
  }

  if (!checkBearer(req, opts.token)) {
    send401(res);
    return;
  }

  // Loopback pairing page is GET-only (it's served before this method guard).
  // DELETE and PATCH are only meaningful for `/api/sessions/:id`.
  if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'PATCH') {
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
  if (url.pathname === SESSIONS_PATH) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    sendJson(res, 200, { sessions: sessions.list() });
    return;
  }
  if (
    (req.method === 'DELETE' || req.method === 'PATCH') &&
    url.pathname.startsWith(SESSIONS_PATH + '/')
  ) {
    const id = url.pathname.slice(SESSIONS_PATH.length + 1);
    // Reject non-UUID path segments as 404 (not 405): from the client's view
    // they're asking about a session that doesn't exist, not the wrong verb.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    const exists = sessions.list().some((s) => s.id === id);
    if (!exists) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (req.method === 'PATCH') {
      void handleSessionPatch(req, res, sessions, id);
      return;
    }
    // `remove` kills the PTY; the existing `onExit` callback on the WS
    // connection immediately forwards a binary `{type:'exit'}` control
    // frame to any attached client and closes the socket — so killing a
    // session that's currently in use cleanly drops the user out at their
    // terminal.
    sessions.remove(id);
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === FS_PATH) {
    void handleFs(res, url);
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
  debugLog(req, 'WS-upgrade');
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
  const parsed = PtyHelloQuerySchema.safeParse(Object.fromEntries(url.searchParams));
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

/** Send a JSON control frame as BINARY so the client can tell it from PTY text. */
function sendControl(ws: WebSocket, obj: unknown): void {
  try {
    ws.send(Buffer.from(JSON.stringify(obj), 'utf8'), { binary: true });
  } catch {
    /* socket already gone */
  }
}

function handlePtyConnection(
  ws: WebSocket,
  req: IncomingMessage,
  mgr: SessionManager,
): void {
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

  let attached: {
    session: ReturnType<SessionManager['createOrAttach']>['session'];
    resumed: boolean;
  };
  try {
    attached = mgr.createOrAttach(hello, launcher, {
      cwd: hello.cwd,
      cols: hello.cols,
      rows: hello.rows,
    });
  } catch (err) {
    sendControl(ws, {
      type: 'exit',
      protocol: PROTOCOL_VERSION,
      exitCode: -1,
      signal: null,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      ws.close(1011, 'spawn failed');
    } catch {
      /* already closed */
    }
    return;
  }
  const { session, resumed } = attached;
  session.owner = ws;
  session.attached = true;

  // The block below is synchronous — no awaits — so no live PTY output (which
  // fires on a later tick) can interleave before the scrollback replay.
  sendControl(ws, {
    type: 'session',
    protocol: PROTOCOL_VERSION,
    id: session.id,
    resumed,
  });
  if (resumed && session.buffer) {
    try {
      ws.send(session.buffer);
    } catch {
      /* socket already gone */
    }
  }
  session.sink = (data: string) => {
    try {
      ws.send(data);
    } catch {
      /* socket already gone */
    }
  };
  session.onExit = (payload) => {
    sendControl(ws, { type: 'exit', protocol: PROTOCOL_VERSION, ...payload });
    try {
      ws.close(1000, 'pty exited');
    } catch {
      /* already closed */
    }
  };

  ws.on('message', (data: RawData, isBinary) => {
    if (isBinary) {
      try {
        session.term.write(rawToBuffer(data));
      } catch {
        /* pty gone */
      }
      return;
    }
    const text = typeof data === 'string' ? data : rawToBuffer(data).toString('utf8');
    const control = parseResize(text);
    if (control) {
      try {
        session.term.resize(control.cols, control.rows);
      } catch {
        /* resize after exit — discard */
      }
      return;
    }
    try {
      session.term.write(Buffer.from(text, 'utf8'));
    } catch {
      /* pty gone */
    }
  });

  ws.on('close', () => {
    live.delete(ws);
    // Detach only — the shell keeps running so the client can re-attach and
    // resume. Guard against a stale socket detaching a session that a newer
    // client has already taken over.
    if (session.owner === ws) mgr.detach(session);
  });
}
