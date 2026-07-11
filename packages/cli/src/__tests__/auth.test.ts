import type { IncomingMessage } from 'node:http';
import { describe, it, expect } from 'vitest';
import { checkBearer } from '../auth.js';

const TOKEN = 'a'.repeat(64);

function makeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('checkBearer', () => {
  it('accepts the correct token with "Bearer" prefix', () => {
    expect(checkBearer(makeReq({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true);
  });

  it('accepts the correct token with lowercase "bearer" prefix', () => {
    expect(checkBearer(makeReq({ authorization: `bearer ${TOKEN}` }), TOKEN)).toBe(true);
  });

  it('rejects a token of the wrong length even if prefix is right', () => {
    expect(
      checkBearer(makeReq({ authorization: `Bearer ${'b'.repeat(63)}` }), TOKEN),
    ).toBe(false);
    expect(
      checkBearer(makeReq({ authorization: `Bearer ${'b'.repeat(65)}` }), TOKEN),
    ).toBe(false);
  });

  it('rejects a wrong token of the right length', () => {
    const wrong = 'b'.repeat(64);
    expect(checkBearer(makeReq({ authorization: `Bearer ${wrong}` }), TOKEN)).toBe(false);
  });

  it('rejects missing header', () => {
    expect(checkBearer(makeReq({}), TOKEN)).toBe(false);
    expect(checkBearer(makeReq({ authorization: undefined }), TOKEN)).toBe(false);
  });

  it('rejects non-bearer schemes', () => {
    expect(checkBearer(makeReq({ authorization: `Basic ${TOKEN}` }), TOKEN)).toBe(false);
    expect(checkBearer(makeReq({ authorization: TOKEN }), TOKEN)).toBe(false);
  });

  it('honours multi-value Authorization header (RFC 7235)', () => {
    expect(
      checkBearer(makeReq({ authorization: `Negotiate x, Bearer ${TOKEN}` }), TOKEN),
    ).toBe(true);
  });
});
