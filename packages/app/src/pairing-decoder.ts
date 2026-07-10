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

/**
 * Decode a base64url string to a UTF-8 string. Works in Node (atob is
 * global) and React Native (0.74+ ships atob via Hermes/JSI).
 * Avoids `Buffer` because RN doesn't ship one unless we add a polyfill.
 */
function base64UrlDecodeToString(input: string): string {
  const std = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  // atob returns a binary string; we re-encode it as a Uint8Array and
  // run it through TextDecoder so multibyte UTF-8 sequences survive.
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
