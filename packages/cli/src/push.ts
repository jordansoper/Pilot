import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Expo's push service: takes Expo push tokens, forwards to FCM/APNs. */
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

const TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;
const MAX_TOKENS = 20;

export function pushTokensPath(): string {
  return join(homedir(), '.pilot', 'push-tokens.json');
}

export interface PushMessage {
  title: string;
  body: string;
  /** Opaque payload delivered to the app (e.g. the session id). */
  data?: Record<string, unknown>;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Phones that asked to be told when an agent is waiting.
 *
 * Tokens are stored beside the pairing token (`~/.pilot/`, 0600) so they
 * survive daemon restarts. Delivery goes straight to Expo's push service —
 * no relay of ours — so the computer needs outbound internet for this feature
 * only; everything else stays on the LAN/tailnet.
 */
export class PushRegistry {
  private tokens: string[];

  constructor(
    private readonly path: string = pushTokensPath(),
    private readonly doFetch: FetchLike = (url, init) => fetch(url, init),
  ) {
    this.tokens = this.load();
  }

  static isValidToken(t: string): boolean {
    return TOKEN_RE.test(t);
  }

  list(): readonly string[] {
    return this.tokens;
  }

  register(token: string): boolean {
    if (!PushRegistry.isValidToken(token)) return false;
    if (!this.tokens.includes(token)) {
      // Newest first; cap so a misbehaving client can't grow the file forever.
      this.tokens = [token, ...this.tokens].slice(0, MAX_TOKENS);
      this.save();
    }
    return true;
  }

  unregister(token: string): void {
    const next = this.tokens.filter((t) => t !== token);
    if (next.length !== this.tokens.length) {
      this.tokens = next;
      this.save();
    }
  }

  /** Send to every registered phone; drops tokens Expo says are dead. */
  async notify(msg: PushMessage): Promise<void> {
    if (this.tokens.length === 0) return;
    const targets = [...this.tokens];
    const messages = targets.map((to) => ({
      to,
      title: msg.title,
      body: msg.body,
      data: msg.data ?? {},
      sound: 'default',
      priority: 'high',
      channelId: 'agent-waiting',
    }));
    try {
      const res = await this.doFetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        data?: Array<{ status?: string; details?: { error?: string } }>;
      };
      json.data?.forEach((ticket, i) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          const dead = targets[i];
          if (dead) this.unregister(dead);
        }
      });
    } catch {
      /* offline or Expo unreachable — a missed notification must not crash the daemon */
    }
  }

  private load(): string[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      return Array.isArray(parsed)
        ? parsed.filter((t): t is string => typeof t === 'string' && PushRegistry.isValidToken(t))
        : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.tokens), { mode: 0o600 });
      try {
        chmodSync(this.path, 0o600);
      } catch {
        /* not supported on this FS (Windows) */
      }
    } catch {
      /* best effort */
    }
  }
}
