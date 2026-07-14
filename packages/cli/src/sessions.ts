import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import type { Launcher, LauncherContext } from './launchers.js';
import type { PtyHelloQuery } from '@pilot/shared';

/** Max bytes of terminal output retained per session for scrollback replay. */
const BUFFER_MAX_BYTES = 256 * 1024;
/** Keep a detached (backgrounded) session this long before killing its PTY. */
const IDLE_MAX_MS = 30 * 60 * 1000;
/** Hard cap on concurrent sessions to bound resource use. */
const MAX_SESSIONS = 24;
const REAP_INTERVAL_MS = 60 * 1000;

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
  /** Current output sink (the attached WebSocket), or null when detached. */
  sink: ((data: string) => void) | null;
  /** Called once when the PTY exits (server forwards an exit control frame). */
  onExit: ((e: { exitCode: number; signal: number | null }) => void) | null;
  /** The socket currently attached (opaque); guards late-close detaches. */
  owner: unknown;
  attached: boolean;
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

  constructor() {
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
    if (this.sessions.size >= MAX_SESSIONS) this.reap(true);
    const term = launcher.spawn(ctx, hello);
    const session: PtySession = {
      id: randomUUID(),
      term,
      cwd: ctx.cwd,
      tool: hello.tool,
      name: null,
      createdMs: Date.now(),
      buffer: '',
      sink: null,
      onExit: null,
      owner: null,
      attached: true,
      alive: true,
      lastDetachMs: 0,
    };
    // One persistent subscription for the session's lifetime: buffer always,
    // forward to whoever is currently attached.
    term.onData((data: string) => {
      appendBounded(session, data);
      session.sink?.(data);
    });
    term.onExit((e: { exitCode: number; signal?: number }) => {
      session.alive = false;
      const payload = { exitCode: e.exitCode, signal: e.signal ?? null };
      session.onExit?.(payload);
      // Give a re-attach a brief window to see the exit, then drop it.
      setTimeout(() => this.remove(session.id), 5_000).unref?.();
    });
    this.sessions.set(session.id, session);
    return { session, resumed: false };
  }

  /** Mark a session detached (client gone); its PTY keeps running. */
  detach(session: PtySession): void {
    session.sink = null;
    session.onExit = null;
    session.owner = null;
    session.attached = false;
    session.lastDetachMs = Date.now();
  }

  remove(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.term.kill();
    } catch {
      /* already dead */
    }
    this.sessions.delete(id);
  }

  /** Kill sessions whose PTY exited or that have been idle too long. */
  private reap(force = false): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      const idle = !s.attached && now - s.lastDetachMs > IDLE_MAX_MS;
      if (!s.alive || idle) {
        this.remove(id);
      }
    }
    // Under pressure, drop the oldest detached session to make room.
    if (force && this.sessions.size >= MAX_SESSIONS) {
      let oldest: PtySession | null = null;
      for (const s of this.sessions.values()) {
        if (!s.attached && (!oldest || s.lastDetachMs < oldest.lastDetachMs)) oldest = s;
      }
      if (oldest) this.remove(oldest.id);
    }
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
