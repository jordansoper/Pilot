import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateToken } from '../token.js';

// Each test gets its own throwaway token path so nothing touches ~/.pilot.
let dir: string;
let tokenPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pilot-token-'));
  tokenPath = join(dir, 'token');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadOrCreateToken', () => {
  it('creates a 64-hex-char token on first run and persists it 0600', () => {
    const first = loadOrCreateToken({ path: tokenPath });
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.path).toBe(tokenPath);
    expect(statSync(tokenPath).mode & 0o077).toBe(0); // no group/other bits
    expect(readFileSync(tokenPath, 'utf8').trim()).toBe(first.token);
  });

  it('reuses the same token across restarts', () => {
    const first = loadOrCreateToken({ path: tokenPath });
    const second = loadOrCreateToken({ path: tokenPath });
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it('rotate: replaces the stored token', () => {
    const first = loadOrCreateToken({ path: tokenPath });
    const rotated = loadOrCreateToken({ path: tokenPath, rotate: true });
    expect(rotated.created).toBe(true);
    expect(rotated.token).not.toBe(first.token);
    // Persisted, so a plain load returns the rotated one.
    expect(loadOrCreateToken({ path: tokenPath }).token).toBe(rotated.token);
  });

  it('regenerates when the stored token is malformed', () => {
    loadOrCreateToken({ path: tokenPath });
    writeFileSync(tokenPath, 'not-a-valid-token\n');
    const recovered = loadOrCreateToken({ path: tokenPath });
    expect(recovered.created).toBe(true);
    expect(recovered.token).toMatch(/^[0-9a-f]{64}$/);
  });
});
