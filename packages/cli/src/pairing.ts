import qrcodeTerminal from 'qrcode-terminal';
import {
  buildPairingPayload,
  buildPairingUrl,
  PAIRING_SCHEME,
  PROTOCOL_VERSION,
  type PairingPayload,
} from '@pilot/shared';

export { buildPairingPayload, buildPairingUrl };
export type { PairingPayload };

export interface RenderPairingQrOptions {
  /** Caption rendered above the QR. */
  label?: string;
  /** Skip QR drawing and just print the URL — for headless / piped logs. */
  silent?: boolean;
}

/**
 * Print a QR code encoding the given pairing URL. Uses `qrcode-terminal`'s
 * ASCII renderer so no PNG dependency is needed in Phase 1.
 */
export function renderPairingQr(
  url: string,
  options: RenderPairingQrOptions = {},
): void {
  if (options.label) console.log(options.label);
  if (options.silent) {
    console.log(`Pair URL: ${url}`);
    return;
  }
  qrcodeTerminal.generate(url, { small: true });
  console.log(`Pair URL: ${url}`);
}

/** Re-exports for tests / downstream consumers. */
export { PAIRING_SCHEME, PROTOCOL_VERSION };
