/// <reference types="@cloudflare/vitest-pool-workers" />
// `SELF` and friends from `cloudflare:test` are exposed by vitest-pool-workers
// at test runtime; the triple-slash directive above pulls in the matching
// type declarations so `tsc --noEmit` is happy.
import { describe, it, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import worker, { INSTALL_SH_SHA256, INSTALL_SH_BYTES } from '../worker.js';

// Importing `worker` keeps the module hot and validates the default export
// shape at test-time. Real exercise uses SELF.fetch, which runs the actual
// fetch handler in workerd (the same runtime as Cloudflare's edge).
void worker;

const INSTALL_URL = 'https://pilot.remarkablenerds.com/install.sh';

describe('pilot.remarkablenerds.com worker', () => {
  describe('GET /install.sh', () => {
    it('returns install.sh with the expected cache + content headers', async () => {
      const res = await SELF.fetch(INSTALL_URL);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');

      // Cache-Control contract: max-age, s-maxage, stale-while-revalidate.
      const cc = res.headers.get('Cache-Control') ?? '';
      expect(cc).toMatch(/max-age=\d+/);
      expect(cc).toMatch(/s-maxage=\d+/);
      expect(cc).toMatch(/stale-while-revalidate=\d+/);

      // Security headers.
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');

      // Diagnostics.
      expect(res.headers.get('X-Pilot-Source')).toBe('bundled');
      expect(res.headers.get('X-Pilot-Bundled-Sha256')).toBe(INSTALL_SH_SHA256);
      expect(res.headers.get('ETag')).toBe(`"${INSTALL_SH_SHA256.slice(0, 16)}"`);

      const body = await res.text();
      expect(body).toMatch(/^#!/);
      expect(body).toContain('Pilot — Linux install script');
      expect(body).toContain('pilot.remarkablenerds.com/install.sh');
      // Byte length matches the bundled length exactly.
      expect(new TextEncoder().encode(body).length).toBe(INSTALL_SH_BYTES);
    });

    it('honors If-None-Match and returns 304 with the same ETag', async () => {
      const first = await SELF.fetch(INSTALL_URL);
      const etag = first.headers.get('ETag');
      expect(etag).not.toBeNull();

      const cond = await SELF.fetch(INSTALL_URL, {
        headers: { 'If-None-Match': etag! },
      });
      expect(cond.status).toBe(304);
      expect(await cond.text()).toBe('');
      expect(cond.headers.get('ETag')).toBe(etag);
      // 304 still carries the cache + security contract.
      expect(cond.headers.get('Cache-Control')).toMatch(/max-age=\d+/);
      expect(cond.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('does not 304 for a mismatched ETag', async () => {
      const res = await SELF.fetch(INSTALL_URL, {
        headers: { 'If-None-Match': '"deadbeef"' },
      });
      expect(res.status).toBe(200);
    });

    it('treats /install as an alias for /install.sh', async () => {
      const res = await SELF.fetch('https://pilot.remarkablenerds.com/install');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('X-Pilot-Source')).toBe('bundled');
    });

    it('returns a Content-Length matching the byte count', async () => {
      const res = await SELF.fetch(INSTALL_URL);
      expect(res.headers.get('Content-Length')).toBe(String(INSTALL_SH_BYTES));
    });
  });

  describe('GET /', () => {
    it('returns the HTML landing page with the curl one-liner', async () => {
      const res = await SELF.fetch('https://pilot.remarkablenerds.com/');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toMatch(/text\/html/);
      const body = await res.text();
      expect(body).toContain('curl -fsSL https://pilot.remarkablenerds.com/install.sh');
      expect(body).toContain('Pilot');
      expect(body).toContain('Copy');
      // Has the install size badge derived from the bundled script.
      expect(body).toContain('KB');
    });
  });

  describe('unknown paths', () => {
    it('returns 404 text/plain for paths that are not /install.sh or /', async () => {
      const res = await SELF.fetch('https://pilot.remarkablenerds.com/whatever');
      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
      const body = await res.text();
      expect(body).toContain('/install.sh');
    });
  });
});
