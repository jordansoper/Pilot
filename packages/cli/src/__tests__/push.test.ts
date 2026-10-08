import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PushRegistry } from '../push.js';

const T1 = 'ExponentPushToken[abc123_-X]';
const T2 = 'ExponentPushToken[def456]';
const tmp = () => join(mkdtempSync(join(tmpdir(), 'pilot-push-')), 'tokens.json');

describe('PushRegistry', () => {
  it('rejects non-Expo tokens and persists valid ones', () => {
    const path = tmp();
    const r = new PushRegistry(path);
    expect(r.register('not-a-token')).toBe(false);
    expect(r.register(T1)).toBe(true);
    expect(new PushRegistry(path).list()).toEqual([T1]);
  });

  it('sends one message per token and drops DeviceNotRegistered tokens', async () => {
    const doFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ status: 'ok' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }],
      }),
    });
    const r = new PushRegistry(tmp(), doFetch);
    r.register(T1);
    r.register(T2); // newest first → [T2, T1]
    await r.notify({ title: 'Claude Code', body: 'Proceed?', data: { sessionId: 's' } });
    const sent = JSON.parse(doFetch.mock.calls[0]![1].body) as Array<{ to: string }>;
    expect(sent.map((m) => m.to)).toEqual([T2, T1]);
    expect(r.list()).toEqual([T2]);
  });

  it('swallows network failures', async () => {
    const r = new PushRegistry(tmp(), async () => {
      throw new Error('offline');
    });
    r.register(T1);
    await expect(r.notify({ title: 'a', body: 'b' })).resolves.toBeUndefined();
  });
});
