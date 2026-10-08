import type { PairedMachine } from './types.js';

/** The address to talk to — the one that last answered, else the first candidate. */
export function machineHost(m: PairedMachine): string {
  return m.lastGoodHost ?? m.hosts[0] ?? m.host;
}

/**
 * An API call that got a response the caller should react to differently
 * depending on the status.
 *
 * `status` is the whole point: "the daemon answered 404" and "nothing answered
 * at all" used to be indistinguishable at the call site, so every screen
 * reported both as "machine offline" — which sent you looking at Wi-Fi and
 * Tailscale when the real answer was that the endpoint didn't exist yet.
 * A thrown error that is NOT an ApiError means the request never completed
 * (DNS, refused connection, timeout/abort).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Turn a caught error into copy worth showing a user.
 *
 * `what` names the thing being fetched ("sessions", "the tool list") and is
 * only used for the 404 case, where the useful information is which capability
 * the daemon is missing.
 */
export function describeApiError(err: unknown, what: string): string {
  if (!(err instanceof ApiError)) {
    // Never reached the daemon: refused, timed out, wrong network.
    return 'Could not reach the machine. Is it online?';
  }
  if (err.status === 401 || err.status === 403) {
    return 'This machine rejected the saved token. Re-pair it from a new QR.';
  }
  if (err.status === 404) {
    return `This machine's Pilot is too old to provide ${what}. Update Pilot on that machine.`;
  }
  return `The machine returned an error (HTTP ${err.status}).`;
}

/** Authenticated GET against a paired machine's daemon. Throws on non-2xx. */
export async function apiGet<T>(
  m: PairedMachine,
  pathAndQuery: string,
  timeoutMs = 6000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${machineHost(m)}:${m.port}${pathAndQuery}`, {
      headers: { authorization: `Bearer ${m.token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Authenticated POST against a paired machine's daemon. Body is JSON-encoded.
 * Throws an `Error` whose message starts with `HTTP <code>` on non-2xx so the
 * caller can branch on the status (e.g. surfaces a 409 distinctly to the
 * user) without losing the ability to default to a generic message.
 */
export async function apiPost<T>(
  m: PairedMachine,
  pathAndQuery: string,
  body: unknown,
  timeoutMs = 20000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${machineHost(m)}:${m.port}${pathAndQuery}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${m.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Append the server's own `{error}` string when it shipped JSON, so the
      // app can show "HTTP 403: permission denied" / "HTTP 500: mkdir failed"
      // (or whatever the daemon reports) instead of an opaque status code.
      // Falls back to bare `HTTP <code>` if the body wasn't JSON.
      let suffix = '';
      const errBody = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (errBody && typeof errBody.error === 'string') {
        suffix = `: ${errBody.error}`;
      }
      throw new ApiError(res.status, `HTTP ${res.status}${suffix}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
