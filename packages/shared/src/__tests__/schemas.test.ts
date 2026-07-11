import { describe, it, expect } from 'vitest';
import {
  PairingPayloadSchema,
  FsEntrySchema,
  FsResponseSchema,
  ToolInfoSchema,
  ToolsResponseSchema,
  HealthResponseSchema,
  PtyHelloQuerySchema,
  buildPairingPayload,
  buildPairingUrl,
} from '../schemas.js';
import { PROTOCOL_VERSION } from '../constants.js';

const validToken = 'a'.repeat(64); // 32 bytes hex-encoded

describe('PairingPayloadSchema', () => {
  it('accepts a valid payload', () => {
    const parsed = PairingPayloadSchema.parse({
      version: PROTOCOL_VERSION,
      host: '100.64.0.2',
      port: 7117,
      token: validToken,
      name: 'workstation-b',
    });
    expect(parsed.name).toBe('workstation-b');
  });

  it('accepts a multi-host payload and round-trips hosts through the URL', () => {
    const payload = buildPairingPayload({
      host: '100.64.0.2',
      hosts: ['100.64.0.2', '192.168.1.20'],
      port: 7117,
      token: validToken,
      name: 'mbp',
    });
    expect(payload.hosts).toEqual(['100.64.0.2', '192.168.1.20']);
    // hosts survives the base64url URL encoding the QR carries.
    const url = buildPairingUrl(payload);
    const p = url.split('p=')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    expect(decoded.hosts).toEqual(['100.64.0.2', '192.168.1.20']);
  });

  it('accepts a v1 payload with no hosts (back-compat)', () => {
    const parsed = PairingPayloadSchema.parse({
      version: PROTOCOL_VERSION,
      host: '100.64.0.2',
      port: 7117,
      token: validToken,
      name: 'old',
    });
    expect(parsed.hosts).toBeUndefined();
  });

  it('rejects a wrong protocol version', () => {
    expect(() =>
      PairingPayloadSchema.parse({
        version: 999,
        host: 'x',
        port: 1,
        token: validToken,
        name: 'n',
      }),
    ).toThrow();
  });

  it('rejects a too-short token', () => {
    expect(() =>
      PairingPayloadSchema.parse({
        version: PROTOCOL_VERSION,
        host: '100.0.0.1',
        port: 7117,
        token: 'short',
        name: 'n',
      }),
    ).toThrow(/token/i);
  });

  it('rejects an out-of-range port', () => {
    expect(() =>
      PairingPayloadSchema.parse({
        version: PROTOCOL_VERSION,
        host: 'x',
        port: 70000,
        token: validToken,
        name: 'n',
      }),
    ).toThrow();
  });

  it('buildPairingPayload defaults version to PROTOCOL_VERSION', () => {
    const p = buildPairingPayload({
      host: '100.64.0.2',
      port: 7117,
      token: validToken,
      name: 'mbp',
    });
    expect(p.version).toBe(PROTOCOL_VERSION);
  });
});

describe('FsEntrySchema / FsResponseSchema', () => {
  it('accepts a dir entry without size/mtime', () => {
    const e = FsEntrySchema.parse({ name: '.git', type: 'dir' });
    expect(e.size).toBeUndefined();
  });

  it('accepts a file entry with size+mtime', () => {
    const e = FsEntrySchema.parse({
      name: 'README.md',
      type: 'file',
      size: 1234,
      mtime: 1_700_000_000_000,
    });
    expect(e.size).toBe(1234);
  });

  it('rejects an unknown type', () => {
    expect(() => FsEntrySchema.parse({ name: 'x', type: 'symlink' })).toThrow();
  });

  it('round-trips a valid response', () => {
    const r = FsResponseSchema.parse({
      path: '/home/jordan',
      entries: [
        { name: 'code', type: 'dir' },
        { name: 'README.md', type: 'file', size: 42 },
      ],
    });
    expect(r.entries).toHaveLength(2);
  });
});

describe('ToolsResponseSchema / ToolInfoSchema', () => {
  it('accepts an available tool', () => {
    const t = ToolInfoSchema.parse({
      id: 'claude',
      label: 'Claude Code',
      available: true,
    });
    expect(t.available).toBe(true);
  });

  it('accepts an empty list', () => {
    expect(ToolsResponseSchema.parse({ tools: [] }).tools).toEqual([]);
  });
});

describe('HealthResponseSchema', () => {
  it('accepts a response with tailscaleIp: null', () => {
    const h = HealthResponseSchema.parse({
      version: '0.0.0',
      uptimeMs: 12_345,
      tailscaleIp: null,
      port: 7117,
    });
    expect(h.tailscaleIp).toBeNull();
  });
});

describe('PtyHelloQuerySchema', () => {
  it('coerces string query params to numbers', () => {
    // Simulates `URLSearchParams` arriving from the WS handshake.
    const q = PtyHelloQuerySchema.parse({
      cwd: '/tmp',
      tool: 'bash',
      cols: '120',
      rows: '40',
    });
    expect(q.cols).toBe(120);
    expect(q.rows).toBe(40);
  });

  it('applies defaults when cols/rows are missing', () => {
    const q = PtyHelloQuerySchema.parse({ cwd: '/tmp', tool: 'bash' });
    expect(q.cols).toBe(80);
    expect(q.rows).toBe(24);
  });

  it('accepts an optional model', () => {
    const q = PtyHelloQuerySchema.parse({
      cwd: '/tmp',
      tool: 'ollama-run',
      model: 'llama3.2',
    });
    expect(q.model).toBe('llama3.2');
  });
});
