import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import type { Launcher, LauncherContext } from './launchers.js';
import type { PtyHelloQuery } from '@pilot/shared';
import {
  QUIET_MS,
  newAttentionState,
  shouldNotify,
  summarizeTail,
  type AttentionState,
} from './attention.js';

/** Max bytes of terminal output retained per session for scrollback replay. */
const BUFFER_MAX_BYTES = 256 * 1024;
/** Hard cap on concurrent sessions to bound resource use. */
const MAX_SESSIONS = 64;
const REAP_INTERVAL_MS = 60 * 1000;

/** One attached viewer of a session (an open WebSocket). */
export interface SessionClient {
  /** Deliver PTY output. */
  send(data: string): void;
  /** The PTY exited; deliver the exit notice and close. */
  exit(e: { exitCode: number; signal: number | null }): void;
}

export interface PtySession {
  id: string;
  term: IPty;
  /** Working directory the session was launched in. */
  cwd: string;
  /** Tool id the session runs (e.g. "bash"). */
  tool: string;
  /** User-assigned display name, or null until renamed. */
  name: string | null;
  /** Unix epoch ms when created. */
  createdMs: number;
  /** Bounded tail of PTY output, replayed when a client re-attaches. */
  buffer: string;
  /**
   * Every client currently watching this session (phone, desktop app, …).
   * All of them receive the same output and any of them may type, so a
   * session can be followed live from several devices at once.
   */
  clients: Set<SessionClient>;
  attached: boolean;
  /** Inputs to the "agent is waiting for you" heuristic. */
  attention: AttentionState;
  quietTimer: ReturnType<typeof setTimeout> | null;
  alive: boolean;
  lastDetachMs: number;
}

/**
 * Owns persistent PTY sessions. A session's shell keeps running after its
 * WebSocket drops (app backgrounded / network blip), buffering output, so a
 * returning client re-attaches by id and replays the scrollback — the shell is
 * exactly where you left it (Termux-style), even though it lives on this host.
 */
export class SessionManager {
  private sessions = new Map<string, PtySession>();
  private reaper: ReturnType<typeof setInterval> | null = null;

  /**
   * @param onWaiting called when an agent session has gone quiet after output
   *   and nobody is typing — the daemon turns this into a push notification.
   */
  constructor(
    private readonly onWaiting?: (
      session: PtySession,
      summary: string,
    ) => void,
  ) {
    this.reaper = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref?.();
  }

  /** Re-attach to an existing live session, or spawn a new one. */
  createOrAttach(
    hello: PtyHelloQuery,
    launcher: Launcher,
    ctx: LauncherContext,
  ): { session: PtySession; resumed: boolean } {
    if (hello.session) {
      const existing = this.sessions.get(hello.session);
      if (existing && existing.alive) {
        return { session: existing, resumed: true };
      }
    }
    // Fresh session.
    // Sessions live until the user closes them (or the shell exits), so a full
    // table is an error rather than a cue to evict someone's detached session.
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`session limit reached (${MAX_SESSIONS}); close one first`);
    }
    const term = launcher.spawn(ctx, hello);
    const session: PtySession = {
      id: randomUUID(),
      term,
      cwd: ctx.cwd,
      tool: hello.tool,
      name: null,
      createdMs: Date.now(),
      buffer: '',
      clients: new Set(),
      attached: false,
      attention: newAttentionState(),
      quietTimer: null,
      alive: true,
      lastDetachMs: 0,
    };
    // One persistent subscription for the session's lifetime: buffer always,
    // forward to whoever is currently attached.
    term.onData((data: string) => {
      appendBounded(session, data);
      for (const c of session.clients) c.send(data);
      this.noteOutput(session, data.length);
    });
    term.onExit((e: { exitCode: number; signal?: number }) => {
      session.alive = false;
      const payload = { exitCode: e.exitCode, signal: e.signal ?? null };
      for (const c of [...session.clients]) c.exit(payload);
      // Give a re-attach a brief window to see the exit, then drop it.
      setTimeout(() => this.remove(session.id), 5_000).unref?.();
    });
    this.sessions.set(session.id, session);
    return { session, resumed: false };
  }

  /** PTY produced output: restart the "has it settled?" countdown. */
  private noteOutput(session: PtySession, bytes: number): void {
    if (!this.onWaiting) return;
    session.attention.bytesSinceInput += bytes;
    if (session.quietTimer) clearTimeout(session.quietTimer);
    session.quietTimer = setTimeout(() => {
      session.quietTimer = null;
      if (!session.alive) return;
      if (!shouldNotify(session.attention, session.tool, Date.now())) return;
      session.attention.notified = true;
      this.onWaiting?.(session, summarizeTail(session.buffer));
    }, QUIET_MS);
    session.quietTimer.unref?.();
  }

  /** A client typed into the session: the user is present, re-arm. */
  noteInput(session: PtySession): void {
    session.attention.lastInputMs = Date.now();
    session.attention.bytesSinceInput = 0;
    session.attention.notified = false;
  }

  /** Attach a viewer to a session. */
  attach(session: PtySession, client: SessionClient): void {
    session.clients.add(client);
    session.attached = true;
  }

  /** Remove one viewer; the PTY keeps running even when none are left. */
  detach(session: PtySession, client: SessionClient): void {
    session.clients.delete(client);
    session.attached = session.clients.size > 0;
    if (!session.attached) session.lastDetachMs = Date.now();
  }

  remove(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.quietTimer) clearTimeout(s.quietTimer);
    try {
      s.term.kill();
    } catch {
      /* already dead */
    }
    this.sessions.delete(id);
  }

  /**
   * Drop sessions whose PTY exited. Detached sessions are deliberately never
   * reaped for idleness: they live until closed from the app.
   */
  private reap(): void {
    for (const [id, s] of this.sessions) {
      if (!s.alive) this.remove(id);
    }
  }

  /**
   * A still-running session by id, or undefined if unknown or already exited.
   *
   * Used by the WS handshake to tell a re-attach from a fresh start before the
   * upgrade, so a resume doesn't have to satisfy checks that only make sense
   * for a new PTY (notably a valid `cwd` — the running one already has one).
   */
  getLive(id: string): PtySession | undefined {
    const s = this.sessions.get(id);
    return s && s.alive ? s : undefined;
  }

  /** Rename a live session. Returns false when the id is unknown. */
  rename(id: string, name: string): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return false;
    s.name = name;
    return true;
  }

  /** Snapshot of live sessions for `GET /api/sessions`, newest first. */
  list(): Array<{
    id: string;
    cwd: string;
    tool: string;
    createdMs: number;
    attached: boolean;
    name?: string;
  }> {
    return [...this.sessions.values()]
      .filter((s) => s.alive)
      .sort((a, b) => b.createdMs - a.createdMs)
      .map((s) => ({
        id: s.id,
        cwd: s.cwd,
        tool: s.tool,
        createdMs: s.createdMs,
        attached: s.attached,
        ...(s.name ? { name: s.name } : {}),
      }));
  }

  closeAll(): void {
    if (this.reaper) clearInterval(this.reaper);
    for (const id of [...this.sessions.keys()]) this.remove(id);
  }
}

function appendBounded(session: PtySession, data: string): void {
  session.buffer += data;
  if (session.buffer.length > BUFFER_MAX_BYTES) {
    session.buffer = session.buffer.slice(session.buffer.length - BUFFER_MAX_BYTES);
  }
}
