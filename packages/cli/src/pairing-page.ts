import QRCode from 'qrcode';
import { SHARED_PACKAGE_VERSION } from '@pilot/shared';
import type { ServerOptions } from './server.js';

/** Escape a string for safe insertion into HTML text/attributes. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the loopback pairing page: a crisp SVG QR plus the machine name,
 * Tailscale address, and the raw pilot:// URL for copy/paste. Shown at
 * `http://localhost:<port>/` on the machine running the daemon — far easier to
 * scan than the terminal ASCII QR.
 */
export async function buildPairingPageHtml(
  pairingUrl: string,
  opts: ServerOptions,
): Promise<string> {
  const qrSvg = await QRCode.toString(pairingUrl, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M',
  });
  const name = esc(opts.machineName ?? 'this machine');
  const address = opts.tailscaleIp
    ? `${opts.tailscaleIp}:${opts.port}`
    : `${opts.bind}:${opts.port}`;
  const tailscaleWarning = opts.tailscaleIp
    ? ''
    : `<p class="warn">⚠ Tailscale not detected — the phone must be on the same machine/network to reach this.</p>`;

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
  .qr {
    background: #fff; border-radius: 12px; padding: 16px; display: inline-block;
    line-height: 0;
  }
  .qr svg { width: 288px; height: 288px; display: block; }
  .name { margin: 20px 0 2px; font-size: 16px; font-weight: 600; }
  .addr { color: #9ca3af; font-size: 13px; font-family: ui-monospace, Menlo, monospace; }
  .warn { color: #fbbf24; font-size: 13px; margin: 14px 0 0; }
  details { margin-top: 18px; text-align: left; }
  summary { cursor: pointer; color: #9ca3af; font-size: 13px; }
  .url {
    margin-top: 8px; padding: 10px; background: #0f1115; border: 1px solid #262b36;
    border-radius: 8px; font-family: ui-monospace, Menlo, monospace; font-size: 11px;
    color: #9ca3af; word-break: break-all; user-select: all;
  }
  .foot { margin-top: 20px; color: #4b5563; font-size: 11px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Pair with Pilot</h1>
    <p class="sub">Open the Pilot app on your phone → <b>+ Pair</b> → scan this code.</p>
    <div class="qr">${qrSvg}</div>
    <p class="name">${name}</p>
    <p class="addr">${esc(address)}</p>
    ${tailscaleWarning}
    <details>
      <summary>Can't scan? Copy the pairing link</summary>
      <div class="url">${esc(pairingUrl)}</div>
    </details>
    <p class="foot">pilot-cli v${esc(SHARED_PACKAGE_VERSION)} · this page is only visible on this computer</p>
  </div>
</body>
</html>`;
}
