import { describe, expect, it } from 'vitest';
import { renderHtml, type TerminalConfig } from '../terminal-html.js';

const cfg = (overrides: Partial<TerminalConfig> = {}): TerminalConfig => ({
  host: '192.168.20.201',
  port: '7117',
  token: 'a'.repeat(64),
  cwd: '/Users/jorda/Documents',
  cols: 80,
  rows: 24,
  session: '',
  ...overrides,
});

/**
 * Pull `var CFG = {...};` back out of the rendered page and evaluate it the
 * way the WebView's JS parser would. Throws if the emitted literal doesn't
 * parse — which is the failure that used to blank the whole terminal.
 */
function readBackConfig(html: string): TerminalConfig {
  const match = /var CFG = (.*);\n/.exec(html);
  if (!match) throw new Error('no CFG assignment found in rendered HTML');
  return new Function(`return ${match[1]!};`)() as TerminalConfig;
}

describe('renderHtml — config encoding', () => {
  it('round-trips a POSIX cwd', () => {
    const c = cfg();
    expect(readBackConfig(renderHtml(c))).toEqual(c);
  });

  it('round-trips a Windows cwd instead of eating the backslashes', () => {
    // The original bug: `C:\Users\jorda\Documents` was pasted straight into a
    // JS string literal, so \U \j \D collapsed to U j D and the daemon's
    // statSync rejected a directory that exists.
    const c = cfg({ cwd: 'C:\\Users\\jorda\\Documents\\Projects' });
    expect(readBackConfig(renderHtml(c)).cwd).toBe(
      'C:\\Users\\jorda\\Documents\\Projects',
    );
  });

  it.each([
    ['C:\\Users\\jorda\\ui\\src', 'a \\u segment — was an invalid Unicode escape'],
    ['C:\\Users\\jorda\\xtras', 'a \\x segment — was an invalid hex escape'],
    ['C:\\temp\\build', 'a \\t segment — silently became a tab'],
    ['C:\\Users\\jorda\\node_modules', 'a \\n segment — silently became a newline'],
    ['C:\\dev\\vue-app', 'a \\v segment — silently became a vertical tab'],
    ['C:\\repos\\backend', 'a \\b segment — silently became a backspace'],
  ])('survives %s (%s)', (cwd) => {
    expect(readBackConfig(renderHtml(cfg({ cwd }))).cwd).toBe(cwd);
  });

  it('neutralises a folder name that tries to break out of the script', () => {
    const cwd = 'C:\\tmp\\x"; window.pwned = 1; //';
    const html = renderHtml(cfg({ cwd }));
    // It still appears in the document — as inert data. What matters is that
    // the quote is escaped, so it cannot terminate the string and turn the
    // rest into code, and that it survives as the exact path.
    const literal = /var CFG = (.*);\n/.exec(html)![1]!;
    expect(literal).toContain('\\"');
    expect(readBackConfig(html).cwd).toBe(cwd);
  });

  it('escapes a folder name containing </script> so the block cannot close early', () => {
    const cwd = '/home/jorda/</script><script>evil()</script>';
    const html = renderHtml(cfg({ cwd }));
    expect(readBackConfig(html).cwd).toBe(cwd);
    expect(html).not.toContain('<script>evil()');
  });

  it('does not treat $& in a folder name as a replacement pattern', () => {
    // String.replace would expand `$&` to the matched text; the renderer uses
    // a function replacement precisely so it cannot.
    const cwd = '/home/jorda/$&$1weird';
    expect(readBackConfig(renderHtml(cfg({ cwd }))).cwd).toBe(cwd);
  });

  it('carries the session id through when resuming', () => {
    const session = '11111111-2222-4333-8444-555555555555';
    expect(readBackConfig(renderHtml(cfg({ session }))).session).toBe(session);
  });

  it('emits an inline script that actually parses, for every awkward path', () => {
    // The root of the white-screen bug: a bad escape made the WHOLE <script>
    // a syntax error, so nothing ran and nothing was reported. `new Function`
    // parses without executing, which is exactly the check that was missing.
    for (const cwd of [
      'C:\\Users\\jorda\\ui\\src',
      'C:\\Users\\jorda\\xtras',
      'C:\\Users\\jorda\\node_modules',
      '/home/jorda/</script>',
      'C:\\tmp\\quote"and\\backslash\\\\end',
    ]) {
      const html = renderHtml(cfg({ cwd }));
      // The last inline script is ours; the earlier two are vendored xterm.
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      const ours = scripts[scripts.length - 1]![1]!;
      expect(() => new Function(ours)).not.toThrow();
    }
  });
});

describe('renderHtml — offline assets', () => {
  const html = renderHtml(cfg());

  it('requests nothing from the network but the daemon', () => {
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
  });

  it('inlines xterm and the fit addon', () => {
    // The UMD bundles are what define window.Terminal / window.FitAddon.
    expect(html).toContain('FitAddon');
    expect(html.length).toBeGreaterThan(200_000);
  });

  it('reports a script failure back to RN instead of leaving a blank page', () => {
    expect(html).toContain('window.onerror');
  });
});

describe('renderHtml — working directory in the handshake', () => {
  it('omits cwd from the WS url when the app has no opinion', () => {
    // Resuming sends no cwd. An empty `cwd=` fails the daemon's schema, so the
    // parameter has to be left out entirely rather than sent blank.
    const html = renderHtml(cfg({ cwd: '' }));
    expect(readBackConfig(html).cwd).toBe('');
    expect(html).toContain("if (CWD) u += '&cwd='");
  });

  it('still sends a Windows cwd intact when one was picked', () => {
    const cwd = 'C:\\Users\\jorda\\Documents';
    expect(readBackConfig(renderHtml(cfg({ cwd }))).cwd).toBe(cwd);
  });
});

describe('renderHtml — quick-key bar hooks', () => {
  const html = renderHtml(cfg());

  it('exposes the entry points the RN toolbar injects', () => {
    expect(html).toContain('window.pilotKey');
    expect(html).toContain('window.pilotToggle');
  });

  it('emits the escape sequences a soft keyboard cannot produce', () => {
    // The template writes `\\x1b`, which renders to a literal backslash-x-1-b
    // in the HTML so the browser's JS parser turns it into ESC — rather than a
    // raw control byte sitting in the markup.
    for (const seq of [
      String.raw`'\x1b'`,
      String.raw`'\t'`,
      String.raw`'\x03'`,
      String.raw`'\x1b[5~'`,
    ]) {
      expect(html).toContain(seq);
    }
  });

  it('derives cursor keys from the terminal mode rather than hardcoding CSI', () => {
    // vim/less switch on DECCKM, after which arrows must be SS3 (ESC O A),
    // not CSI (ESC [ A) — sending the wrong one inserts junk instead of moving.
    expect(html).toContain('applicationCursorKeysMode');
  });

  it('maps a sticky Ctrl onto the C0 control range', () => {
    expect(html).toContain('String.fromCharCode(c - 64)');
    expect(html).toContain('String.fromCharCode(c - 96)');
  });
});

describe('renderHtml — tool launch + clipboard hooks', () => {
  it('passes tool and model into the websocket URL builder', () => {
    const html = renderHtml(cfg({ tool: 'ollama', model: 'llama3.2' }));
    expect(html).toContain("'?tool=' + encodeURIComponent(TOOL)");
    expect(readBackConfig(html)).toMatchObject({ tool: 'ollama', model: 'llama3.2' });
  });

  it('exposes copy/paste hooks for the RN key bar', () => {
    const html = renderHtml(cfg());
    expect(html).toContain('window.pilotCopy');
    expect(html).toContain('window.pilotPaste');
  });
});
