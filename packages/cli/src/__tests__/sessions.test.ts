import { describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { PtyHelloQuery } from '@pilot/shared';
import { SessionManager, type SessionClient } from '../sessions.js';
import type { Launcher } from '../launchers.js';

function fakeLauncher(): { launcher: Launcher; emit: (s: string) => void } {
  let onData: (d: string) => void = () => {};
  const term = {
    onData: (cb: (d: string) => void) => void (onData = cb),
    onExit: () => {},
    kill: () => {},
  } as unknown as IPty;
  return {
    launcher: { id: 'bash', label: 'x', bin: 'x', spawn: () => term },
    emit: (s) => onData(s),
  };
}

const hello = { tool: 'bash', cwd: '/', cols: 80, rows: 24 } as PtyHelloQuery;
const ctx = { cwd: '/', cols: 80, rows: 24 };

describe('SessionManager multi-attach', () => {
  it('mirrors output to every attached client and survives one leaving', () => {
    const mgr = new SessionManager();
    const { launcher, emit } = fakeLauncher();
    const { session } = mgr.createOrAttach(hello, launcher, ctx);
    const a: SessionClient = { send: vi.fn(), exit: vi.fn() };
    const b: SessionClient = { send: vi.fn(), exit: vi.fn() };
    mgr.attach(session, a);
    mgr.attach(session, b);
    emit('hi');
    expect(a.send).toHaveBeenCalledWith('hi');
    expect(b.send).toHaveBeenCalledWith('hi');

    mgr.detach(session, a);
    expect(session.attached).toBe(true);
    emit('again');
    expect(b.send).toHaveBeenCalledWith('again');
    expect(a.send).not.toHaveBeenCalledWith('again');

    mgr.detach(session, b);
    expect(session.attached).toBe(false);
    mgr.closeAll();
  });

  it('never reaps a detached session for idleness', () => {
    vi.useFakeTimers();
    const mgr = new SessionManager();
    const { launcher } = fakeLauncher();
    const { session } = mgr.createOrAttach(hello, launcher, ctx);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(mgr.getLive(session.id)).toBeDefined();
    mgr.closeAll();
    vi.useRealTimers();
  });
});

describe('SessionManager waiting detection', () => {
  const agentHello = { ...hello, tool: 'claude' } as PtyHelloQuery;

  it('fires once when an agent goes quiet, and re-arms after the user types', () => {
    vi.useFakeTimers();
    const onWaiting = vi.fn();
    const mgr = new SessionManager(onWaiting);
    const { launcher, emit } = fakeLauncher();
    const { session } = mgr.createOrAttach(agentHello, launcher, ctx);
    mgr.attach(session, { send: () => {}, exit: () => {} });

    emit('Do you want to proceed with these changes? '.repeat(5));
    vi.advanceTimersByTime(30_000);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting.mock.calls[0]![1]).toContain('proceed');

    vi.advanceTimersByTime(60_000); // still quiet: no repeat ping
    expect(onWaiting).toHaveBeenCalledTimes(1);

    mgr.noteInput(session);
    vi.advanceTimersByTime(30_000); // user typed, then silence: nothing new to report
    expect(onWaiting).toHaveBeenCalledTimes(1);

    emit('Next question? '.repeat(20));
    vi.advanceTimersByTime(30_000);
    expect(onWaiting).toHaveBeenCalledTimes(2);
    mgr.closeAll();
    vi.useRealTimers();
  });

  it('stays silent for a plain shell', () => {
    vi.useFakeTimers();
    const onWaiting = vi.fn();
    const mgr = new SessionManager(onWaiting);
    const { launcher, emit } = fakeLauncher();
    mgr.createOrAttach(hello, launcher, ctx);
    emit('x'.repeat(500));
    vi.advanceTimersByTime(60_000);
    expect(onWaiting).not.toHaveBeenCalled();
    mgr.closeAll();
    vi.useRealTimers();
  });
});
