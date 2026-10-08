import { describe, it, expect } from 'vitest';
import {
  PairingPayloadSchema,
  FsEntrySchema,
  FsResponseSchema,
  FsMkdirRequestSchema,
  FsMkdirResponseSchema,
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
    const e = FsEntrySchema.parse({
      name: '.git',
      type: 'dir',
      path: '/home/jordan/.git',
    });
    expect(e.size).toBeUndefined();
  });

  it('accepts a file entry with size+mtime', () => {
    const e = FsEntrySchema.parse({
      name: 'README.md',
      type: 'file',
      path: '/home/jordan/README.md',
      size: 1234,
      mtime: 1_700_000_000_000,
    });
    expect(e.size).toBe(1234);
  });

  it('rejects an unknown type', () => {
    expect(() =>
      FsEntrySchema.parse({ name: 'x', type: 'symlink', path: '/x' }),
    ).toThrow();
  });

  it('rejects an entry without a path', () => {
    expect(() => FsEntrySchema.parse({ name: 'x', type: 'dir' })).toThrow();
  });

  it('round-trips a valid POSIX response', () => {
    const r = FsResponseSchema.parse({
      path: '/home/jordan',
      parent: null,
      sep: '/',
      segments: [{ name: 'jordan', path: '/home/jordan' }],
      entries: [
        { name: 'code', type: 'dir', path: '/home/jordan/code' },
        { name: 'README.md', type: 'file', path: '/home/jordan/README.md', size: 42 },
      ],
    });
    expect(r.entries).toHaveLength(2);
    expect(r.parent).toBeNull();
  });

  it('round-trips a valid Windows response', () => {
    const r = FsResponseSchema.parse({
      path: 'C:\\Users\\jordan\\code',
      parent: 'C:\\Users\\jordan',
      sep: '\\',
      segments: [
        { name: 'jordan', path: 'C:\\Users\\jordan' },
        { name: 'code', path: 'C:\\Users\\jordan\\code' },
      ],
      entries: [{ name: 'pilot', type: 'dir', path: 'C:\\Users\\jordan\\code\\pilot' }],
    });
    expect(r.sep).toBe('\\');
  });

  it('rejects an unknown separator', () => {
    expect(() =>
      FsResponseSchema.parse({
        path: '/x',
        parent: null,
        sep: ':',
        segments: [{ name: 'x', path: '/x' }],
        entries: [],
      }),
    ).toThrow();
  });
});

describe('FsMkdirRequestSchema', () => {
  it('accepts a plain POSIX request', () => {
    const r = FsMkdirRequestSchema.parse({
      parent: '/home/jordan/projects',
      name: 'new-app',
    });
    expect(r.name).toBe('new-app');
  });

  it('accepts a folder name with a leading dot (e.g. .vscode)', () => {
    const r = FsMkdirRequestSchema.parse({
      parent: '/home/jordan/code',
      name: '.vscode',
    });
    expect(r.name).toBe('.vscode');
  });

  it('accepts a Windows-style parent path', () => {
    const r = FsMkdirRequestSchema.parse({
      parent: 'C:\\Users\\jordan\\code',
      name: 'app',
    });
    expect(r.parent).toBe('C:\\Users\\jordan\\code');
  });

  it.each(['.', '..'])('rejects name = "%s"', (name) => {
    expect(() => FsMkdirRequestSchema.parse({ parent: '/home/jordan', name })).toThrow();
  });

  it.each(['a/b', 'with/slash', 'a\\b', 'back\\slash'])(
    'rejects name containing a path separator (%s)',
    (name) => {
      expect(() => FsMkdirRequestSchema.parse({ parent: '/home/jordan', name })).toThrow(
        /separator/i,
      );
    },
  );

  it('rejects a 201-char name', () => {
    expect(() =>
      FsMkdirRequestSchema.parse({ parent: '/home/jordan', name: 'a'.repeat(201) }),
    ).toThrow();
  });

  it('accepts a 200-char name at the boundary', () => {
    const r = FsMkdirRequestSchema.parse({
      parent: '/home/jordan',
      name: 'a'.repeat(200),
    });
    expect(r.name).toHaveLength(200);
  });

  it.each(['-foo', '--all', '-rf'])('rejects a name starting with "-" (%s)', (name) => {
    expect(() => FsMkdirRequestSchema.parse({ parent: '/home/jordan', name })).toThrow();
  });

  it.each(['foo ', 'foo.', 'foo .'])(
    'rejects a name ending in space or "." (%s)',
    (name) => {
      expect(() =>
        FsMkdirRequestSchema.parse({ parent: '/home/jordan', name }),
      ).toThrow();
    },
  );

  it('rejects a NUL byte', () => {
    expect(() =>
      FsMkdirRequestSchema.parse({ parent: '/home/jordan', name: 'foo\0bar' }),
    ).toThrow(/NUL/i);
  });

  it.each(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'con', 'lpt3'])(
    'rejects Windows reserved names (case-insensitive: %s)',
    (name) => {
      expect(() => FsMkdirRequestSchema.parse({ parent: '/home/jordan', name })).toThrow(
        /reserved/i,
      );
    },
  );
});

describe('FsMkdirResponseSchema', () => {
  it('accepts a POSIX response', () => {
    const r = FsMkdirResponseSchema.parse({ path: '/home/jordan/projects/new-app' });
    expect(r.path).toBe('/home/jordan/projects/new-app');
  });

  it('accepts a Windows response', () => {
    const r = FsMkdirResponseSchema.parse({ path: 'C:\\Users\\jordan\\code\\app' });
    expect(r.path).toBe('C:\\Users\\jordan\\code\\app');
  });

  it('rejects an empty path', () => {
    expect(() => FsMkdirResponseSchema.parse({ path: '' })).toThrow();
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

  it('accepts a handshake with no cwd at all', () => {
    // Resuming a session sends no cwd — the running PTY already has one, and
    // only the daemon knows a valid path for its own OS. Requiring it here is
    // what made the app send `/tmp`, which fails on Windows.
    const q = PtyHelloQuerySchema.parse({ tool: 'bash', session: undefined });
    expect(q.cwd).toBeUndefined();
    expect(q.tool).toBe('bash');
  });

  it('still rejects an empty cwd, so a blank one is a bug not a default', () => {
    expect(() => PtyHelloQuerySchema.parse({ cwd: '', tool: 'bash' })).toThrow();
  });
});
