import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiError, apiGet, apiPost, describeApiError, machineHost } from '../api.js';
import type { PairedMachine } from '../types.js';

const TOKEN = 'a'.repeat(64);

const m = (overrides: Partial<PairedMachine> = {}): PairedMachine => ({
  id: '100.64.0.2:7117',
  host: '100.64.0.2',
  hosts: ['100.64.0.2', '192.168.1.20'],
  port: 7117,
  token: TOKEN,
  name: 'mbp',
  lastSeenMs: null,
  lastGoodHost: null,
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('machineHost', () => {
  it('prefers lastGoodHost over hosts[0] over host', () => {
    expect(machineHost(m({ lastGoodHost: '10.0.0.5' }))).toBe('10.0.0.5');
    expect(machineHost(m())).toBe('100.64.0.2');
    expect(machineHost(m({ hosts: [] }))).toBe('100.64.0.2');
  });
});

describe('apiPost', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs URL-encoded JSON, sets auth + content-type, returns parsed body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ path: '/x/y' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiPost<{ path: string }>(m(), '/api/fs/mkdir', {
      parent: '/x',
      name: 'y',
    });

    expect(result).toEqual({ path: '/x/y' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://100.64.0.2:7117/api/fs/mkdir');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    });
    expect(init.body).toBe(JSON.stringify({ parent: '/x', name: 'y' }));
  });

  it('throws "HTTP <code>: <server error>" on 4xx with JSON {error} body', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ error: 'folder already exists' }, 409)),
    );
    await expect(
      apiPost(m(), '/api/fs/mkdir', { parent: '/x', name: 'y' }),
    ).rejects.toThrow(/^HTTP 409: folder already exists$/);
  });

  it('throws bare "HTTP <code>" on 4xx with non-JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('not json', { status: 405 })),
    );
    await expect(
      apiPost(m(), '/api/fs/mkdir', { parent: '/x', name: 'y' }),
    ).rejects.toThrow(/^HTTP 405$/);
  });

  it('routes POST through machineHost() (lastGoodHost wins)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ path: '/x' }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await apiPost(m({ lastGoodHost: '10.0.0.5' }), '/x', {});
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toBe('http://10.0.0.5:7117/x');
  });

  it('propagates the JSON parse failure on 2xx with invalid body', async () => {
    // The caller should see the parse error rather than silently accepting a
    // malformed response. Asserting on the specific error class (rather than
    // `rejects.toThrow()`) catches regressions that wrap the SyntaxError in
    // a generic Error before throwing.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('garbage', { status: 200 })),
    );
    await expect(apiPost(m(), '/x', {})).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('apiGet', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GETs the URL with auth header, parses JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiGet<{ ok: boolean }>(m(), '/api/health');
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://100.64.0.2:7117/api/health');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it('throws "HTTP <code>" on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('nope', { status: 500 })),
    );
    await expect(apiGet(m(), '/api/health')).rejects.toThrow(/^HTTP 500$/);
  });

  it('throws an ApiError carrying the status, so callers can branch on it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(new Response('nope', { status: 404 })),
    );
    await expect(apiGet(m(), '/api/tools')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });
  });

  it('lets a transport failure through as a non-ApiError', async () => {
    // The distinction describeApiError relies on: nothing answered at all.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new TypeError('Network request failed')),
    );
    await expect(apiGet(m(), '/api/tools')).rejects.not.toBeInstanceOf(ApiError);
  });
});

describe('describeApiError', () => {
  it('reports a transport failure as the machine being unreachable', () => {
    expect(
      describeApiError(new TypeError('Network request failed'), 'the tool list'),
    ).toMatch(/Could not reach the machine/);
  });

  it('reports a 404 as a stale daemon, naming the capability — not as offline', () => {
    // The bug this whole helper exists for: a healthy machine answering 404
    // used to render identically to an unplugged one.
    const msg = describeApiError(new ApiError(404, 'HTTP 404'), 'the tool list');
    expect(msg).toMatch(/too old/);
    expect(msg).toContain('the tool list');
    expect(msg).not.toMatch(/Could not reach/);
  });

  it('reports 401/403 as a token problem', () => {
    expect(describeApiError(new ApiError(401, 'HTTP 401'), 'x')).toMatch(/Re-pair/);
    expect(describeApiError(new ApiError(403, 'HTTP 403'), 'x')).toMatch(/Re-pair/);
  });

  it('falls back to the bare status for anything else', () => {
    expect(describeApiError(new ApiError(500, 'HTTP 500'), 'x')).toMatch(/HTTP 500/);
  });
});
