import type { PairingPayload } from '@pilot/shared';

/**
 * A persisted paired machine. Mirrors the wire `PairingPayload` but adds
 * fields the app decides on its own (favorite, last-seen, color, etc.).
 * Phase 1 keeps it minimal.
 */
export interface PairedMachine {
  /** Stable id, derived from `host:port` so re-pairing updates instead of duplicating. */
  id: string;
  /** Wire fields from the QR pairing payload (validated against PairingPayloadSchema). */
  host: string;
  port: number;
  token: string;
  name: string;
  /** ms since epoch; updated on successful /api/health ping. */
  lastSeenMs: number | null;
}

/** Construct a deterministic id for storage. */
export function machineId(host: string, port: number): string {
  return `${host}:${port}`;
}

export function fromPairingPayload(p: PairingPayload): PairedMachine {
  return {
    id: machineId(p.host, p.port),
    host: p.host,
    port: p.port,
    token: p.token,
    name: p.name,
    lastSeenMs: null,
  };
}

export { type PairingPayload };

/**
 * Minimal router state for the hand-rolled 3-screen navigator. Keeps the
 * app free of `react-navigation` / Expo Router for v1; if Phase 2 grows a
 * file picker that's deep enough to warrant a stack, swap to Expo Router.
 */
export type Screen =
  | { name: 'machines' }
  | { name: 'addMachine' }
  | { name: 'settings' }
  | { name: 'terminal'; machineId: string };
