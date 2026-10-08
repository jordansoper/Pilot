import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import type { Duplex } from 'node:stream';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  FS_ALLOWLIST_ROOT_ENV,
  FS_MKDIR_PATH,
  FS_PATH,
  HEALTH_PATH,
  PROTOCOL_VERSION,
  FsMkdirRequestSchema,
  PtyHelloQuerySchema,
  SESSIONS_PATH,
  PUSH_REGISTER_PATH,
  PUSH_UNREGISTER_PATH,
  PushTokenRequestSchema,
  SETTINGS_PATH,
  SessionUpdateSchema,
  SettingsUpdateSchema,
  SHARED_PACKAGE_VERSION,
  TOOLS_PATH,
  WS_PATH,
  type FsResponse,
  type HealthResponse,
  type PtyHelloQuery,
  type SettingsResponse,
  type SettingsUpdateResponse,
} from '@pilot/shared';
import { checkBearer } from './auth.js';
import { getLauncher, listTools } from './launchers.js';
import { buildPairingPageHtml, type PairingAddress } from './pairing-page.js';
import { SessionManager, type SessionClient } from './sessions.js';
import { PushRegistry } from './push.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Parsed PtyHello cache for the upgrade→connection handoff. `cwd` is resolved
 * to a concrete directory during the handshake (the wire field is optional),
 * so everything downstream can rely on it.
 */
type ResolvedHello = PtyHelloQuery & { cwd: string };
const queryCache = new WeakMap<IncomingMessage, ResolvedHello>();
/** Liveness flag for the heartbeat, kept off the ws object. */
const live = new WeakMap<WebSocket, boolean>();

export interface ServerOptions {
  /** Push-token store; defaults to `~/.pilot/push-tokens.json`. Tests inject one. */
  pushRegistry?: PushRegistry;
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

/** Mutable daemon settings, updated via PUT /api/settings. */
export interface DaemonSettings {
  port: number;
  bind: string;
  name: string;
  fsRoot: string;
  tailscaleIp: string | null;
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
  const push = opts.pushRegistry ?? new PushRegistry();
  const sessions = new SessionManager((session, summary) => {
    void push.notify({
      title: `${session.name ?? toolLabel(session.tool)} is waiting for you`,
      body: summary,
      data: { sessionId: session.id, tool: session.tool, cwd: session.cwd },
    });
  });
  // Pre-render the loopback pairing page once (the pairing URL is fixed for
  // the daemon's lifetime), so request handling stays synchronous.
  const pairingPageHtml = opts.pairingUrl
    ? await buildPairingPageHtml(
        opts.pairingUrl,
        opts.machineName ?? 'this machine',
        opts.pairingAddresses ?? [],
      )
    : null;
  // Mutable daemon settings — fsRoot resolved once at startup, but
  // overridable via PUT /api/settings (name/fsRoot take effect immediately;
  // port/bind require restart).
  const settings: DaemonSettings = {
    port: actualPort,
    bind: opts.bind,
    name: opts.machineName ?? 'this machine',
    fsRoot: path.resolve(process.env[FS_ALLOWLIST_ROOT_ENV] || homedir()),
    tailscaleIp: opts.tailscaleIp,
  };

  const httpServer = createServer((req, res) => {
    handleHttp(req, res, opts, actualPort, pairingPageHtml, sessions, settings, push);
  });

  const wss = new WebSocketServer({
    noServer: true,
    // Bounded so a single misbehaving client can't wedge the daemon.
    maxPayload: 16 * 1024,
  });

  httpServer.on('upgrade', (req, socket: Duplex, head: Buffer) => {
    handleUpgrade(req, socket, head, wss, opts, actualPort, sessions, settings);
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

/**
 * Resolve the effective FS allowlist root. Settings take precedence over
 * the env var; env var takes precedence over $HOME.
 */
function resolveFsRoot(settings: DaemonSettings): string {
  return path.resolve(settings.fsRoot);
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

/**
 * Read JSON request body with a hard size cap so a misbehaving client can't
 * OOM the daemon by streaming an unbounded body. Returns `null` on either a
 * size-overflow or a parse error; callers decide what HTTP status to send.
 */
async function readSmallJson(req: IncomingMessage): Promise<unknown | null> {
  let raw = '';
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 4096) throw new Error('body too large');
    }
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Create a single directory under the allowlist root. Body:
 * `{ parent: string, name: string }` (`FsMkdirRequestSchema`). The parent
 * is resolved and verified to be inside the allowlist; the joined path is
 * re-verified as defense-in-depth (so a `name` containing `..` segments
 * can't escape even if a future schema change weakens the filter).
 * Returns 201 with `{ path }` on success, 400 on validation, 409 if it
 * already exists, 500 on other I/O errors.
 */
async function handleFsMkdir(
  req: IncomingMessage,
  res: ServerResponse,
  settings: DaemonSettings,
): Promise<void> {
  const parsed = FsMkdirRequestSchema.safeParse(await readSmallJson(req));
  if (!parsed.success) {
    sendJson(res, 400, { error: 'invalid body', issues: parsed.error.issues });
    return;
  }
  const { parent, name } = parsed.data;
  const root = resolveFsRoot(settings);
  const parentResolved = path.resolve(parent);
  if (parentResolved !== root && !parentResolved.startsWith(root + path.sep)) {
    sendJson(res, 400, { error: 'parent outside allowlist', root });
    return;
  }
  const target = path.resolve(parentResolved, name);
  // Defense-in-depth: re-check the joined path against the allowlist so a
  // malformed `name` can't escape even if the schema's filter is weakened.
  if (target !== root && !target.startsWith(root + path.sep)) {
    sendJson(res, 400, { error: 'path outside allowlist', root });
    return;
  }
  try {
    // `recursive: false` is intentional — we want EEXIST on a duplicate, not
    // a silent "yes I made it" because some ancestor already existed.
    await fs.promises.mkdir(target, { recursive: false });
    sendJson(res, 201, { path: target });
    return;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'EEXIST') {
      sendJson(res, 409, { error: 'folder already exists', path: target });
      return;
    }
    // ENOENT means the parent disappeared between accept and syscall; ENOTDIR
    // means a non-directory segment is on the path. Both surface as friendly
    // 4xx instead of generic 500. Mirrors how `handleFs` lets `readdir` throw
    // and reads the errno — no separate stat (avoids TOCTOU + extra I/O).
    if (e?.code === 'ENOENT') {
      sendJson(res, 404, { error: 'parent not found', path: parentResolved });
      return;
    }
    if (e?.code === 'ENOTDIR') {
      sendJson(res, 400, { error: 'parent is not a directory', path: parentResolved });
      return;
    }
    // EACCES / EPERM are common on macOS — the daemon runs as the same user
    // as the file picker is browsing, but paths like `~/Library/Caches` or
    // SIP-protected dirs refuse writes. Map to a clean 403 instead of the
    // generic 500 so the app can surface a meaningful message.
    if (e?.code === 'EACCES' || e?.code === 'EPERM') {
      sendJson(res, 403, {
        error: 'permission denied (parent folder not writable)',
        path: parentResolved,
      });
      return;
    }
    // Verbose OS details only when PILOT_DEBUG is set — don't leak paths or
    // errno text into the production response.
    if (process.env['PILOT_DEBUG']) {
      sendJson(res, 500, {
        error: 'mkdir failed',
        code: e?.code ?? 'UNKNOWN',
        message: e?.message ?? '',
      });
    } else {
      sendJson(res, 500, { error: 'mkdir failed' });
    }
  }
}

/** Browse a directory under the allowlist root. Ends the response. */
async function handleFs(res: ServerResponse, url: URL, settings: DaemonSettings): Promise<void> {
  const root = resolveFsRoot(settings);
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

function toolLabel(id: string): string {
  return listTools().find((t) => t.id === id)?.label ?? id;
}

/** `POST /api/push/register` | `/api/push/unregister` — body `{ token }`. */
async function handlePushToken(
  req: IncomingMessage,
  res: ServerResponse,
  push: PushRegistry,
  register: boolean,
): Promise<void> {
  const parsed = PushTokenRequestSchema.safeParse(await readSmallJson(req));
  if (!parsed.success) {
    sendJson(res, 400, { error: 'invalid body', issues: parsed.error.issues });
    return;
  }
  if (register) push.register(parsed.data.token);
  else push.unregister(parsed.data.token);
  sendJson(res, 200, { ok: true });
}

function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServerOptions,
  actualPort: number,
  pairingPageHtml: string | null,
  sessions: SessionManager,
  settings: DaemonSettings,
  push: PushRegistry,
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

  // ── Per-session routes: /api/sessions/<uuid> ────────────────────
  if (url.pathname.startsWith(SESSIONS_PATH + '/')) {
    const sid = url.pathname.slice(SESSIONS_PATH.length + 1);
    // Reject non-UUID path segments as 404 (not 405): from the client's view
    // they're asking about a session that doesn't exist, not the wrong verb.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
      sendJson(res, 404, { error: 'session not found' });
      return;
    }
    if (req.method === 'DELETE') {
      if (!sessions.list().some((s) => s.id === sid)) {
        sendJson(res, 404, { error: 'session not found' });
        return;
      }
      // `remove` kills the PTY; the existing `onExit` callback on the WS
      // connection immediately forwards a binary `{type:'exit'}` control
      // frame to any attached client and closes the socket — so killing a
      // session that's currently in use cleanly drops the user out at their
      // terminal.
      sessions.remove(sid);
      res.writeHead(204);
      res.end();
      return;
    }
    // Both verbs are supported: the mobile app uses PUT, the desktop app
    // uses PATCH. Same handler either way.
    if (req.method === 'PUT' || req.method === 'PATCH') {
      void handleSessionRename(req, res, sessions, sid);
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  // ── GET routes ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (url.pathname === HEALTH_PATH) {
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
      sendJson(res, 200, { sessions: sessions.list() });
      return;
    }
    if (url.pathname === FS_PATH) {
      void handleFs(res, url, settings);
      return;
    }
    if (url.pathname === SETTINGS_PATH) {
      const body: SettingsResponse = {
        port: actualPort,
        bind: settings.bind,
        name: settings.name,
        fsRoot: settings.fsRoot,
        tailscaleIp: opts.tailscaleIp,
      };
      sendJson(res, 200, body);
      return;
    }
    if (url.pathname === TOOLS_PATH) {
      sendJson(res, 200, { tools: listTools() });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  // ── POST routes ─────────────────────────────────────────────────
  if (req.method === 'POST') {
    if (url.pathname === FS_MKDIR_PATH) {
      void handleFsMkdir(req, res, settings);
      return;
    }
    if (url.pathname === PUSH_REGISTER_PATH || url.pathname === PUSH_UNREGISTER_PATH) {
      void handlePushToken(req, res, push, url.pathname === PUSH_REGISTER_PATH);
      return;
    }
  }

  // ── PUT /api/settings ───────────────────────────────────────────
  if (req.method === 'PUT' && url.pathname === SETTINGS_PATH) {
    void handleSettingsUpdate(req, res, settings, opts, actualPort);
    return;
  }

  sendJson(res, 405, { error: 'method not allowed' });
}

// ── PUT /api/settings ────────────────────────────────────────────────────

/** Max request body size for PUT requests (64 KB). */
const BODY_MAX = 64 * 1024;

/** Read JSON body from an incoming request, bounded. */
async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  let body = '';
  let size = 0;
  try {
    body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > BODY_MAX) {
          req.destroy();
          reject(new Error('body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  } catch {
    sendJson(res, 413, { error: 'request body too large or unreadable' });
    return null;
  }
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'invalid JSON' });
    return null;
  }
}

/**
 * `PUT`/`PATCH` `/api/sessions/:id` — rename a session. Body: `{ name: string }`
 * (1–100 chars). Responds with the updated session snapshot.
 */
async function handleSessionRename(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: SessionManager,
  sid: string,
): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed) return;
  const result = SessionUpdateSchema.safeParse(parsed);
  if (!result.success) {
    sendJson(res, 400, { error: 'invalid body', issues: result.error.issues });
    return;
  }
  if (!sessions.rename(sid, result.data.name)) {
    sendJson(res, 404, { error: 'session not found' });
    return;
  }
  const session = sessions.list().find((s) => s.id === sid);
  sendJson(res, 200, { session });
}

async function handleSettingsUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  settings: DaemonSettings,
  opts: ServerOptions,
  actualPort: number,
): Promise<void> {
  const parsed = await readJsonBody(req, res);
  if (!parsed) return;

  const result = SettingsUpdateSchema.safeParse(parsed);
  if (!result.success) {
    sendJson(res, 400, { error: 'invalid settings', issues: result.error.issues });
    return;
  }

  const update = result.data;
  const restartReasons: string[] = [];

  if (update.name !== undefined) {
    settings.name = update.name;
  }
  if (update.fsRoot !== undefined) {
    settings.fsRoot = path.resolve(update.fsRoot);
  }
  if (update.port !== undefined) {
    settings.port = update.port;
    restartReasons.push('port');
  }
  if (update.bind !== undefined) {
    settings.bind = update.bind;
    restartReasons.push('bind');
  }

  const response: SettingsUpdateResponse = {
    settings: {
      port: actualPort,
      bind: settings.bind,
      name: settings.name,
      fsRoot: settings.fsRoot,
      tailscaleIp: opts.tailscaleIp,
    },
    needsRestart: restartReasons.length > 0,
    restartReasons,
  };
  sendJson(res, 200, response);
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
  sessions: SessionManager,
  settings: DaemonSettings,
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

  // Re-attaching to a live session? Then the cwd is irrelevant — the PTY is
  // already running somewhere — so don't validate it, and inherit the
  // session's own directory. Validating here is what broke every resume from
  // the app on Windows: it sends no cwd for a resume, the old default was
  // `/tmp`, and that doesn't exist on Windows, so the upgrade was rejected
  // with a 400 the client could only report as "websocket error".
  const live = hello.session ? sessions.getLive(hello.session) : undefined;
  if (live) {
    queryCache.set(req, { ...hello, cwd: live.cwd });
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      wss.emit('connection', ws, req);
    });
    return;
  }

  // A new session (or a resume whose session is gone): fall back to the
  // daemon's own root rather than making the client guess a path that exists
  // on this OS.
  const cwd = hello.cwd ?? resolveFsRoot(settings);
  try {
    const stat = fs.statSync(cwd);
    if (!stat.isDirectory()) throw new Error('not a directory');
  } catch {
    socket.write(
      'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n' +
        JSON.stringify({ error: 'invalid cwd', cwd }),
    );
    socket.destroy();
    return;
  }
  queryCache.set(req, { ...hello, cwd });
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
  const client: SessionClient = {
    send(data) {
      try {
        ws.send(data);
      } catch {
        /* socket already gone */
      }
    },
    exit(payload) {
      sendControl(ws, { type: 'exit', protocol: PROTOCOL_VERSION, ...payload });
      try {
        ws.close(1000, 'pty exited');
      } catch {
        /* already closed */
      }
    },
  };
  mgr.attach(session, client);

  ws.on('message', (data: RawData, isBinary) => {
    if (isBinary) {
      mgr.noteInput(session);
      try {
        session.term.write(rawToBuffer(data));
      } catch {
        /* pty gone */
      }
      return;
    }
    const text = typeof data === 'string' ? data : rawToBuffer(data).toString('utf8');
    const control = parseResize(text);
    if (!control) mgr.noteInput(session);
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
    // resume. Other attached devices keep streaming.
    mgr.detach(session, client);
  });
}
