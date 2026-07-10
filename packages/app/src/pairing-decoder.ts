import { PairingPayloadSchema, PAIRING_SCHEME, type PairingPayload } from '@pilot/shared';

/**
 * Result of attempting to decode a scanned QR string.
 */
export type DecodeResult =
  | { ok: true; payload: PairingPayload }
  | { ok: false; error: string };

/**
 * Decode a scanned QR string into a validated {@link PairingPayload}.
 * Works in both Node (vitest) and React Native (runtime) because it uses
 * `atob` / `TextDecoder` rather than Node-only `Buffer`.
 *
 * Accepts:
 *   - `pilot://pair?v=1&p=<base64url JSON>` (canonical CLI output), and
 *   - Any URL whose first path segment equals the {@link PAIRING_SCHEME}.
 */
export function decodePairingUrl(scanned: string): DecodeResult {
  const trimmed = scanned.trim();
  let url: URL;
  try {
    const normalized = /^[a-z]+:\/\//i.test(trimmed)
      ? trimmed
      : `${PAIRING_SCHEME}://${trimmed}`;
    url = new URL(normalized);
  } catch {
    return { ok: false, error: 'Not a valid URL.' };
  }
  if (url.protocol !== `${PAIRING_SCHEME}:`) {
    return {
      ok: false,
      error: `Wrong scheme — expected ${PAIRING_SCHEME}://, got ${url.protocol}.`,
    };
  }
  const p = url.searchParams.get('p');
  if (!p) {
    return { ok: false, error: 'Missing payload (param `p`).' };
  }
  let json: unknown;
  try {
    json = JSON.parse(base64UrlDecodeToString(p));
  } catch {
    return { ok: false, error: 'Payload is not valid base64url JSON.' };
  }
  const parsed = PairingPayloadSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `Payload rejected: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  return { ok: true, payload: parsed.data };
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Decode a base64url string to a UTF-8 string using only plain JS —
 * no `atob`, `TextDecoder`, or `Buffer`. Hermes (React Native's engine)
 * does not reliably ship those globals, and when `TextDecoder` is missing
 * the whole decode throws at runtime (the QR looks "invalid" on-device even
 * though the payload is fine). A hand-rolled decoder runs identically in
 * Node (vitest) and on-device.
 */
function base64UrlDecodeToString(input: string): string {
  const std = input.replace(/-/g, '+').replace(/_/g, '/');
  const clean = std.replace(/=+$/, '');

  // base64 -> bytes
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const idx = BASE64_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base64 character: ${ch}`);
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  // bytes -> UTF-8 string (handles multibyte + surrogate pairs)
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 >= 0xc0 && b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++]! & 0x3f));
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f),
      );
    } else {
      const cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i++]! & 0x3f) << 12) |
        ((bytes[i++]! & 0x3f) << 6) |
        (bytes[i++]! & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
    }
  }
  return out;
}
