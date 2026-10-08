import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { ToolsResponseSchema } from '@pilot/shared';
import { getLauncher, listTools, resolveOnPath } from '../launchers.js';

const isWindows = process.platform === 'win32';

/** Drop a runnable file on a fresh dir and return [dir, bareName]. */
function makeExecutable(name: string): [string, string] {
  const dir = mkdtempSync(join(tmpdir(), 'pilot-bin-'));
  // Windows resolves by PATHEXT, POSIX by the execute bit.
  const file = join(dir, isWindows ? `${name}.cmd` : name);
  writeFileSync(file, isWindows ? '@echo off\n' : '#!/bin/sh\n');
  if (!isWindows) chmodSync(file, 0o755);
  return [dir, name];
}

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('resolveOnPath', () => {
  it('finds an executable on PATH and returns its full path', () => {
    const [dir, name] = makeExecutable('pilot-fake-tool');
    dirs.push(dir);
    vi.stubEnv('PATH', dir);
    if (isWindows) vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');

    const resolved = resolveOnPath(name);
    expect(resolved).not.toBeNull();
    expect(resolved).toContain(name);
  });

  it('returns null when the binary is not on PATH', () => {
    const [dir] = makeExecutable('pilot-fake-tool');
    dirs.push(dir);
    vi.stubEnv('PATH', dir);
    expect(resolveOnPath('pilot-definitely-not-installed')).toBeNull();
  });

  it('ignores a directory that merely shares the name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilot-bin-'));
    dirs.push(dir);
    // The name exists under PATH but is a directory, not a runnable file.
    const sub = join(dir, 'pilot-dir-tool');
    mkdtempSync(sub);
    vi.stubEnv('PATH', dir);
    expect(resolveOnPath('pilot-dir-tool')).toBeNull();
  });

  it('checks an explicit path directly rather than scanning PATH', () => {
    const [dir, name] = makeExecutable('pilot-fake-tool');
    dirs.push(dir);
    vi.stubEnv('PATH', '');
    if (isWindows) vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
    const full = join(dir, isWindows ? `${name}.cmd` : name);
    expect(resolveOnPath(full)).toBe(full);
  });
});

describe('listTools', () => {
  it('returns a body matching ToolsResponseSchema', () => {
    expect(() => ToolsResponseSchema.parse({ tools: listTools() })).not.toThrow();
  });

  it("always reports the shell as available — it is the daemon's own", () => {
    // Guards the regression where $SHELL is an absolute path a PATH scan
    // would miss, hiding the one tool that always works.
    const shell = listTools().find((t) => t.id === 'bash');
    expect(shell).toBeDefined();
    expect(shell!.available).toBe(true);
  });

  it('lists the AI tools even when they are not installed, so the app can grey them out', () => {
    vi.stubEnv('PATH', '');
    const ids = listTools().map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['claude', 'ollama', 'freebuff']));
    expect(listTools().find((t) => t.id === 'claude')!.available).toBe(false);
  });

  it('reports a tool as available once it appears on PATH', () => {
    const [dir] = makeExecutable('claude');
    dirs.push(dir);
    vi.stubEnv('PATH', dir);
    if (isWindows) vi.stubEnv('PATHEXT', '.COM;.EXE;.BAT;.CMD');
    expect(listTools().find((t) => t.id === 'claude')!.available).toBe(true);
  });

  it('every id is registered and spawnable via getLauncher', () => {
    for (const tool of listTools()) {
      expect(getLauncher(tool.id)).toBeDefined();
    }
  });
});
