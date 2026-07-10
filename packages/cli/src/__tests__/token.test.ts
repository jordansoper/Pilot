import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import os from 'node:os';

// Point ~/.pilot at a throwaway dir so tests never touch the real home.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pilot-token-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

// Import AFTER the mock is armed via a fresh module each test.
async function fresh() {
  vi.resetModules();
  return import('../token.js');
}

describe('loadOrCreateToken', () => {
  it('creates a 64-hex-char token on first run and persists it 0600', async () => {
    const { loadOrCreateToken, tokenFilePath } = await fresh();
    const first = loadOrCreateToken();
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.path).toBe(tokenFilePath());
    // 0600 → no group/other bits.
    expect(statSync(first.path).mode & 0o077).toBe(0);
    expect(readFileSync(first.path, 'utf8').trim()).toBe(first.token);
  });

  it('reuses the same token across restarts', async () => {
    const a = await fresh();
    const first = a.loadOrCreateToken();
    const b = await fresh();
    const second = b.loadOrCreateToken();
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it('rotate: replaces the stored token', async () => {
    const a = await fresh();
    const first = a.loadOrCreateToken();
    const b = await fresh();
    const rotated = b.loadOrCreateToken({ rotate: true });
    expect(rotated.created).toBe(true);
    expect(rotated.token).not.toBe(first.token);
    // Persisted, so the next plain load returns the rotated one.
    const c = await fresh();
    expect(c.loadOrCreateToken().token).toBe(rotated.token);
  });

  it('regenerates when the stored token is malformed', async () => {
    const a = await fresh();
    const first = a.loadOrCreateToken();
    // Corrupt the file.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(first.path, 'not-a-valid-token\n');
    const b = await fresh();
    const recovered = b.loadOrCreateToken();
    expect(recovered.created).toBe(true);
    expect(recovered.token).toMatch(/^[0-9a-f]{64}$/);
    expect(recovered.token).not.toBe('not-a-valid-token');
  });
});
