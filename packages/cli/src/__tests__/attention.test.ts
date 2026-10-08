import { describe, expect, it } from 'vitest';
import {
  ACTIVE_USER_MS,
  MIN_BURST_BYTES,
  newAttentionState,
  shouldNotify,
  summarizeTail,
} from '../attention.js';

describe('summarizeTail', () => {
  it('strips ANSI and keeps the last readable lines', () => {
    const buf =
      '\u001b[2J\u001b[1mDone.\u001b[0m\r\n\u001b[33mDo you want to proceed? (y/n)\u001b[0m\r\n';
    expect(summarizeTail(buf)).toBe('Done. · Do you want to proceed? (y/n)');
  });
  it('falls back when nothing is readable', () => {
    expect(summarizeTail('\u001b[?25l')).toBe('Waiting for your input');
  });
  it('truncates long output from the left', () => {
    expect(summarizeTail('x'.repeat(500), 50).length).toBeLessThanOrEqual(50);
  });
});

describe('shouldNotify', () => {
  const base = () => ({ ...newAttentionState(), bytesSinceInput: MIN_BURST_BYTES });
  it('never notifies for a plain shell', () => {
    expect(shouldNotify(base(), 'bash', 1e9)).toBe(false);
  });
  it('notifies once for an agent that produced output then went quiet', () => {
    const s = base();
    expect(shouldNotify(s, 'claude', 1e9)).toBe(true);
    s.notified = true;
    expect(shouldNotify(s, 'claude', 1e9)).toBe(false);
  });
  it('stays quiet while the user is typing or after only a tiny redraw', () => {
    const s = { ...base(), lastInputMs: 1e9 - (ACTIVE_USER_MS - 1) };
    expect(shouldNotify(s, 'claude', 1e9)).toBe(false);
    expect(shouldNotify({ ...newAttentionState(), bytesSinceInput: 5 }, 'claude', 1e9)).toBe(
      false,
    );
  });
});
