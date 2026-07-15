import type { PairingPayload } from '@pilot/shared';

/**
 * A persisted paired machine. Mirrors the wire `PairingPayload` but adds
 * fields the app decides on its own (favorite, last-seen, color, etc.).
 * Phase 1 keeps it minimal.
 */
export interface PairedMachine {
  /** Stable id, derived from `host:port` so re-pairing updates instead of duplicating. */
  id: string;
  /** Primary host (for the id + display). Always also present in `hosts`. */
  host: string;
  /** All candidate addresses (Tailscale, LAN, …); the app tries each. */
  hosts: string[];
  port: number;
  token: string;
  name: string;
  /** ms since epoch; updated on successful /api/health ping. */
  lastSeenMs: number | null;
  /** The host that last answered — tried first, and used for the terminal. */
  lastGoodHost: string | null;
}

/** Construct a deterministic id for storage. */
export function machineId(host: string, port: number): string {
  return `${host}:${port}`;
}

export function fromPairingPayload(p: PairingPayload): PairedMachine {
  const hosts = p.hosts && p.hosts.length > 0 ? p.hosts : [p.host];
  return {
    id: machineId(p.host, p.port),
    host: p.host,
    hosts,
    port: p.port,
    token: p.token,
    name: p.name,
    lastSeenMs: null,
    lastGoodHost: null,
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
  | { name: 'sessions'; machineId: string }
  | { name: 'toolPicker'; machineId: string }
  | { name: 'filePicker'; machineId: string; tool: string }
  | {
      name: 'terminal';
      machineId: string;
      sessionId?: string;
      cwd?: string;
      tool?: string;
      /** Install-and-set-up mode: the daemon installs `tool` before running it. */
      install?: boolean;
    };
