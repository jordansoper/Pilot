import { describe, it, expect } from 'vitest';
import { decodePairingUrl } from '../pairing-decoder.js';
import {
  buildPairingPayload,
  buildPairingUrl,
  PAIRING_SCHEME,
  PROTOCOL_VERSION,
} from '@pilot/shared';

const validToken = 'a'.repeat(64);

describe('decodePairingUrl', () => {
  it('round-trips a URL produced by buildPairingUrl', () => {
    const payload = buildPairingPayload({
      host: '100.64.0.2',
      port: 7117,
      token: validToken,
      name: 'mbp',
    });
    const url = buildPairingUrl(payload);
    const decoded = decodePairingUrl(url);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.payload).toEqual(payload);
  });

  it('accepts scheme without scheme prefix (defensive)', () => {
    const payload = buildPairingPayload({
      host: '100.64.0.2', port: 7117, token: validToken, name: 'mbp',
    });
    const url = buildPairingUrl(payload);
    // Strip the `pilot://` prefix; the decoder should accept `pair?...`.
    const stripped = url.slice(`${PAIRING_SCHEME}://`.length);
    const decoded = decodePairingUrl(stripped);
    expect(decoded.ok).toBe(true);
  });

  it('rejects a non-pilot:// scheme', () => {
    const bad = `https://pair?v=${PROTOCOL_VERSION}&p=foo`;
    const decoded = decodePairingUrl(bad);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toMatch(/Wrong scheme/i);
  });

  it('rejects a payload whose version literal is wrong', () => {
    const wrong = {
      version: PROTOCOL_VERSION + 999,
      host: '100.64.0.2',
      port: 7117,
      token: validToken,
      name: 'mbp',
    };
    const p = Buffer.from(JSON.stringify(wrong), 'utf8').toString('base64url');
    const url = `${PAIRING_SCHEME}://pair?v=${PROTOCOL_VERSION}&p=${p}`;
    const decoded = decodePairingUrl(url);
    expect(decoded.ok).toBe(false);
  });

  it("rejects garbage that isn't a URL", () => {
    const decoded = decodePairingUrl('not-a-url-at-all');
    expect(decoded.ok).toBe(false);
  });

  it('rejects a URL with no `p` param', () => {
    const url = `${PAIRING_SCHEME}://pair?v=${PROTOCOL_VERSION}`;
    const decoded = decodePairingUrl(url);
    expect(decoded.ok).toBe(false);
  });
});
