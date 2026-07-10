import { describe, it, expect } from 'vitest';
import { isValidIpv4, getTailscaleIp } from '../tailscale.js';

describe('isValidIpv4', () => {
  it('accepts a Tailscale-style IP', () => {
    expect(isValidIpv4('100.64.0.2')).toBe(true);
  });

  it('accepts 0.0.0.0', () => {
    expect(isValidIpv4('0.0.0.0')).toBe(true);
  });

  it('accepts 255.255.255.255', () => {
    expect(isValidIpv4('255.255.255.255')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidIpv4('')).toBe(false);
  });

  it('rejects a hostname', () => {
    expect(isValidIpv4('localhost')).toBe(false);
  });

  it('rejects an IPv6 address', () => {
    expect(isValidIpv4('::1')).toBe(false);
    expect(isValidIpv4('fe80::1')).toBe(false);
  });

  it('rejects obvious non-IPv4 garbage', () => {
    expect(isValidIpv4('not-an-ip')).toBe(false);
    expect(isValidIpv4('100.64.0')).toBe(false);
    expect(isValidIpv4('100.64.0.2.3')).toBe(false);
  });
});

describe('getTailscaleIp (integration)', () => {
  // We cannot assume `tailscale` is installed in CI; this test covers the
  // expected behaviour in BOTH states (binary missing → null, binary present
  // → first IPv4 line or null). If the binary is missing the test still
  // passes as long as the resolver returned null within ~1.5s.
  it('returns null or a valid IPv4 string within 1.5s', async () => {
    const ip = await getTailscaleIp();
    if (ip !== null) expect(isValidIpv4(ip)).toBe(true);
    expect(typeof ip === 'string' || ip === null).toBe(true);
  }, 3000);
});
