import type { PairedMachine } from './types.js';

/** The address to talk to — the one that last answered, else the first candidate. */
export function machineHost(m: PairedMachine): string {
  return m.lastGoodHost ?? m.hosts[0] ?? m.host;
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
