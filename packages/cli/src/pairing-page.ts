import QRCode from 'qrcode';
import { SHARED_PACKAGE_VERSION } from '@pilot/shared';

/** One reachable address for display under the QR. */
export interface PairingAddress {
  /** e.g. "192.168.1.20:7117". */
  address: string;
  /** e.g. "Tailscale — works anywhere" or "Local network (en0)". */
  label: string;
}

/** Escape a string for safe insertion into HTML text/attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the loopback pairing page: ONE crisp SVG QR (the payload encodes
 * every reachable address, so the app picks whichever answers — LAN when on
 * the same Wi-Fi, Tailscale from anywhere), plus the list of addresses it
 * covers. Shown at `http://localhost:<port>/` on the machine running the daemon.
 */
export async function buildPairingPageHtml(
  pairingUrl: string,
  machineName: string,
  addresses: PairingAddress[],
): Promise<string> {
  const qrSvg = await QRCode.toString(pairingUrl, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M',
  });
  const addrRows = addresses
    .map(
      (a) =>
        `<div class="addr"><span class="ip">${esc(a.address)}</span><span class="lbl">${esc(a.label)}</span></div>`,
    )
    .join('\n');
  const empty =
    addresses.length === 0
      ? `<p class="warn">⚠ No reachable address found (no Tailscale IP, no LAN IP).</p>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pilot — Pair a device</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    background: #0f1115; color: #e5e7eb;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  .card {
    width: 100%; max-width: 440px; background: #1a1e27; border: 1px solid #262b36;
    border-radius: 16px; padding: 28px; text-align: center;
    box-shadow: 0 12px 40px rgba(0,0,0,.4);
  }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .sub { margin: 0 0 20px; color: #9ca3af; font-size: 14px; }
  .qr { background: #fff; border-radius: 12px; padding: 16px; display: inline-block; line-height: 0; }
  .qr svg { width: 288px; height: 288px; display: block; }
  .name { margin: 18px 0 12px; font-size: 16px; font-weight: 600; }
  .addr {
    display: flex; justify-content: space-between; gap: 12px;
    padding: 8px 12px; margin-top: 6px; background: #0f1115;
    border: 1px solid #262b36; border-radius: 8px; text-align: left;
  }
  .ip { font-family: ui-monospace, Menlo, monospace; font-size: 13px; color: #e5e7eb; }
  .lbl { font-size: 12px; color: #38bdf8; }
  .warn { color: #fbbf24; font-size: 13px; }
  details { margin-top: 14px; }
  summary { cursor: pointer; color: #6b7280; font-size: 12px; }
  .url {
    margin-top: 6px; padding: 8px; background: #0f1115; border: 1px solid #262b36;
    border-radius: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 10px;
    color: #9ca3af; word-break: break-all; user-select: all; text-align: left;
  }
  .foot { margin-top: 20px; color: #4b5563; font-size: 11px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Pair with Pilot</h1>
    <p class="sub">Open the Pilot app → <b>+ Pair</b> → scan this code. One code works on Wi-Fi and over Tailscale.</p>
    <div class="qr">${qrSvg}</div>
    <p class="name">${esc(machineName)}</p>
    ${empty}
    ${addrRows}
    <details><summary>Can't scan? Copy the link</summary><div class="url">${esc(pairingUrl)}</div></details>
    <p class="foot">pilot-cli v${esc(SHARED_PACKAGE_VERSION)} · this page is only visible on this computer</p>
  </div>
</body>
</html>`;
}
