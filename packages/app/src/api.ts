import type { PairedMachine } from './types.js';

/** The address to talk to — the one that last answered, else the first candidate. */
export function machineHost(m: PairedMachine): string {
  return m.lastGoodHost ?? m.hosts[0] ?? m.host;
}

function baseUrl(m: PairedMachine): string {
  return `http://${machineHost(m)}:${m.port}`;
}

function authHeaders(m: PairedMachine): Record<string, string> {
  return { authorization: `Bearer ${m.token}` };
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
    const res = await fetch(`${baseUrl(m)}${pathAndQuery}`, {
      headers: authHeaders(m),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/** Authenticated DELETE against a paired machine's daemon. Throws on non-2xx. */
export async function apiDelete<T = { ok: boolean }>(
  m: PairedMachine,
  pathAndQuery: string,
  timeoutMs = 6000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(m)}${pathAndQuery}`, {
      method: 'DELETE',
      headers: authHeaders(m),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/** Authenticated PUT against a paired machine's daemon. Throws on non-2xx. */
export async function apiPut<T = { ok: boolean }>(
  m: PairedMachine,
  pathAndQuery: string,
  body: unknown,
  timeoutMs = 6000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl(m)}${pathAndQuery}`, {
      method: 'PUT',
      headers: { ...authHeaders(m), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
