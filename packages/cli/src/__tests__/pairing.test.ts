import { describe, it, expect } from 'vitest';
import { buildPairingUrl, buildPairingPayload } from '../pairing.js';
import { PAIRING_SCHEME, PROTOCOL_VERSION } from '@pilot/shared';

const validToken = 'a'.repeat(64);

describe('buildPairingUrl', () => {
  it('uses the pilot:// scheme and includes PROTOCOL_VERSION in v=', () => {
    const payload = buildPairingPayload({
      host: '100.64.0.2',
      port: 7117,
      token: validToken,
      name: 'mbp',
    });
    const url = buildPairingUrl(payload);
    expect(url.startsWith(`${PAIRING_SCHEME}://pair?v=${PROTOCOL_VERSION}&p=`)).toBe(true);
  });

  it('round-trips the payload through base64url-encoded JSON in p=', () => {
    const payload = buildPairingPayload({
      host: '100.64.0.2',
      port: 7117,
      token: validToken,
      name: 'workstation-b',
    });
    const url = buildPairingUrl(payload);
    const parsed = new URL(url);
    const encoded = parsed.searchParams.get('p');
    expect(encoded).not.toBeNull();
    const decoded = JSON.parse(
      Buffer.from(encoded ?? '', 'base64url').toString('utf8'),
    );
    expect(decoded.host).toBe(payload.host);
    expect(decoded.port).toBe(payload.port);
    expect(decoded.token).toBe(payload.token);
    expect(decoded.name).toBe(payload.name);
    expect(decoded.version).toBe(PROTOCOL_VERSION);
  });
});
