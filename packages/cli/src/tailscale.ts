import { spawn } from 'node:child_process';

const TIMEOUT_MS = 1_000;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;

/**
 * Strict-IPv4 string check. Used both inside {@link getTailscaleIp} and as an
 * exported helper so unit tests don't have to spawn a subprocess.
 */
export function isValidIpv4(s: string): boolean {
  return IPV4.test(s);
}

/**
 * Best-effort resolution of this host's Tailscale IPv4 address.
 *
 * Strategy: spawn `tailscale ip -4`, read stdout until close or 1s timeout,
 * accept the first whitespace-separated token that looks like an IPv4.
 * Returns `null` on every failure (binary missing, not on a tailnet, timeout,
 * garbage output). This deliberately never throws — the daemon still works
 * without Tailscale, just won't be reachable cross-machine.
 */
export async function getTailscaleIp(): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let proc: ReturnType<typeof spawn>;

    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc?.kill();
      } catch {
        /* already dead */
      }
      resolve(result);
    };

    try {
      proc = spawn('tailscale', ['ip', '-4'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => finish(null), TIMEOUT_MS);

    proc.stdout?.on('data', (buf: Buffer) => {
      out += buf.toString('utf8');
    });
    // Drain stderr so a noisy tailscale can't wedge on a full pipe buffer.
    proc.stderr?.on('data', () => {
      /* discard */
    });

    proc.on('error', () => finish(null));
    proc.on('close', (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const token = out.trim().split(/\s+/, 1)[0] ?? '';
      finish(isValidIpv4(token) ? token : null);
    });
  });
}
