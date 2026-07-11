import { networkInterfaces } from 'node:os';

export interface LanAddress {
  address: string;
  /** Network interface name (e.g. en0), for display. */
  iface: string;
}

/** 100.64.0.0/10 — the CGNAT range Tailscale assigns. */
export function isTailscaleCgnat(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

/**
 * Non-internal IPv4 addresses on real network interfaces, excluding Tailscale's
 * own CGNAT address. These are the LAN IPs (192.168.x, 10.x, …) a phone on the
 * same Wi-Fi can reach directly — no Tailscale required.
 */
export function getLanIpv4s(): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      // Node <18 typed family as string ('IPv4'); >=18 can be number 4.
      const isV4 = a.family === 'IPv4' || (a.family as unknown as number) === 4;
      if (!isV4 || a.internal) continue;
      if (isTailscaleCgnat(a.address)) continue;
      out.push({ address: a.address, iface });
    }
  }
  return out;
}
