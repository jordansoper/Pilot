// Builds the self-contained HTML document loaded into the terminal WebView.
//
// Lives outside TerminalScreen.tsx so it can be unit-tested in a plain Node
// environment — importing the screen would drag in react-native and
// react-native-webview, neither of which loads under vitest.

import { FIT_ADDON_JS, XTERM_CSS, XTERM_JS } from './vendor/xterm-assets.js';

/**
 * Inline a third-party script/style body without letting a literal
 * `</script>` or `</style>` inside it close the block early. Both forms stay
 * equivalent to the original once the JS/CSS parser sees them.
 */
function inlineSafe(source: string): string {
  return source.replace(/<\/(script|style)/gi, '<\\/$1');
}

/**
 * The static HTML body loaded into the WebView. Fully self-contained: xterm.js
 * and its fit addon are vendored into the bundle (see
 * `src/vendor/xterm-assets.ts`) rather than fetched from a CDN, opens a
 * WebSocket directly back to the CLI (faster than routing PTY bytes through
 * the RN bridge), forwards keystrokes, mirrors resize, and posts
 * `{type:'ready'|'size'|'closed'}` messages back to React Native.
 *
 * Nothing here touches the network except the WebSocket to the daemon. It used
 * to pull xterm from jsDelivr, which meant a phone with no route to the public
 * internet got a render-blocking stylesheet that never arrived: a white screen
 * and no terminal, for a machine sitting on the same LAN.
 *
 * The token is sent as the WebSocket subprotocol entry — the only auth
 * path that works from a browser-style WebView, since custom headers are
 * not allowed on `new WebSocket(...)` outside of Node clients.
 *
 * The single `__CONFIG__` placeholder is replaced at render time with a
 * JSON-encoded object (see {@link encodeConfig}).
 */
const TERMINAL_HTML_TEMPLATE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no" />
<style>${inlineSafe(XTERM_CSS)}</style>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #1a1a1a; color: #d0d0d0; }
  #term { position: absolute; inset: 0; padding: 4px; }
  .xterm-viewport, .xterm-screen { background: #1a1a1a !important; }
</style>
</head><body>
<div id="term"></div>
<script>${inlineSafe(XTERM_JS)}</script>
<script>${inlineSafe(FIT_ADDON_JS)}</script>
<script>
(function () {
  function post(msg) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  // Surface anything that throws in here. Without this a failure below leaves
  // an empty page and RN sits on "connecting…" forever with nothing to show —
  // which is exactly how the CDN and Windows-path bugs presented.
  window.onerror = function (message, _src, line) {
    post({ type: 'error', message: String(message) + ' (line ' + line + ')' });
    return true;
  };

  var CFG = __CONFIG__;
  var HOST = CFG.host;
  var PORT = CFG.port;
  var TOKEN = CFG.token;
  var CWD = CFG.cwd;
  var COLS = CFG.cols || 80;
  var ROWS = CFG.rows || 24;
  var SESSION = CFG.session; // stored session id to resume, or empty
  var TOOL = CFG.tool || 'bash';
  var MODEL = CFG.model || '';

  if (!HOST || !PORT || !TOKEN) {
    post({ type: 'error', message: 'missing host/port/token' });
    return;
  }

  var term = new window.Terminal({
    cursorBlink: true,
    fontFamily: 'Menlo, Courier New, monospace',
    fontSize: 12,
    cols: COLS, rows: ROWS,
    theme: { background: '#1a1a1a', foreground: '#d0d0d0', cursor: '#f8f8f0' }
  });
  var fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('term'));
  try { fit.fit(); } catch (_) { /* terminal may not yet be measurable */ }

  // The shell lives on the daemon and survives disconnects. We reconnect on
  // drop (e.g. returning from the background) and re-attach to the same
  // session by id — the daemon replays the scrollback, so you land back
  // exactly where you left off.
  var currentSession = SESSION || null;
  var ws = null;
  var retry = 0;
  var stopped = false; // true once the shell exits — no more reconnects

  function wsUrl() {
    var u = 'ws://' + HOST + ':' + PORT + '/ws/pty'
      + '?tool=' + encodeURIComponent(TOOL)
      + '&cols=' + term.cols
      + '&rows=' + term.rows;
    // Omit cwd rather than sending an empty one: the schema rejects a blank
    // value, and with it absent the daemon uses its own root — which beats the
    // app guessing a path that may not exist on that OS.
    if (MODEL) u += '&model=' + encodeURIComponent(MODEL);
    if (CWD) u += '&cwd=' + encodeURIComponent(CWD);
    if (currentSession) u += '&session=' + encodeURIComponent(currentSession);
    return u;
  }

  // Control frames arrive as BINARY (ArrayBuffer); PTY output arrives as text.
  function decodeControl(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  function connect() {
    // token is sent as the subprotocol entry — the CLI auth.ts bridges this.
    ws = new WebSocket(wsUrl(), TOKEN);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      retry = 0;
      try { fit.fit(); } catch (_) {}
      post({ type: 'ready', cols: term.cols, rows: term.rows });
    };
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') { term.write(ev.data); return; }
      var msg = decodeControl(ev.data);
      if (!msg) return;
      if (msg.type === 'session') {
        currentSession = msg.id;
        post({ type: 'session', id: msg.id, resumed: !!msg.resumed });
        // Resuming: clear whatever is on screen; the replay that follows
        // rebuilds it, avoiding duplicated scrollback.
        if (msg.resumed) { term.reset(); }
      } else if (msg.type === 'exit') {
        stopped = true;
        currentSession = null;
        term.write('\\r\\n\\x1b[2m── session ended ──\\x1b[0m\\r\\n');
        post({ type: 'exit', exitCode: msg.exitCode });
      }
    };
    ws.onclose = function (ev) {
      post({ type: 'closed', code: ev.code, reason: ev.reason || '' });
      if (stopped || ev.code === 1000) return; // exited cleanly — stop
      retry = Math.min(retry + 1, 6);
      var delay = Math.min(1000 * Math.pow(2, retry - 1), 10000);
      post({ type: 'reconnecting', inMs: delay });
      setTimeout(connect, delay);
    };
    ws.onerror = function () {
      post({ type: 'error', message: 'websocket error' });
    };
  }

  // ── Quick-key bar support ───────────────────────────────────────────
  // A soft keyboard has no Ctrl, Esc, Tab or arrows, so the RN toolbar drives
  // these through injectJavaScript. Ctrl/Alt are STICKY: they arm a modifier
  // that transforms the next character typed on the soft keyboard, which is
  // the only way to get Ctrl-C out of a keyboard that cannot express it.
  var pendingCtrl = false;
  var pendingAlt = false;

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
  }

  function postModifiers() {
    post({ type: 'modifiers', ctrl: pendingCtrl, alt: pendingAlt });
  }

  // Cursor and edit keys change encoding when the app (vim, less…) turns on
  // DECCKM, so read the mode off the terminal rather than hardcoding CSI.
  function cursorPrefix() {
    var modes = term.modes;
    return modes && modes.applicationCursorKeysMode ? '\\x1bO' : '\\x1b[';
  }

  window.pilotKey = function (name) {
    switch (name) {
      case 'esc':   send('\\x1b'); break;
      case 'tab':   send('\\t'); break;
      case 'up':    send(cursorPrefix() + 'A'); break;
      case 'down':  send(cursorPrefix() + 'B'); break;
      case 'right': send(cursorPrefix() + 'C'); break;
      case 'left':  send(cursorPrefix() + 'D'); break;
      case 'home':  send(cursorPrefix() + 'H'); break;
      case 'end':   send(cursorPrefix() + 'F'); break;
      case 'pgup':  send('\\x1b[5~'); break;
      case 'pgdn':  send('\\x1b[6~'); break;
      case 'ctrl-c': send('\\x03'); break;
      case 'ctrl-d': send('\\x04'); break;
      default: break;
    }
    term.focus();
  };

  // ── Copy / paste ────────────────────────────────────────────────────
  // xterm has no touch selection, so a long-press selects the touched line
  // and dragging extends it by whole lines. RN reads the result through
  // pilotCopy and owns the clipboard (the WebView page is not a secure
  // context, so navigator.clipboard is unavailable here).
  var selAnchor = null;
  var pressTimer = null;
  var pressStart = null;
  var termEl = document.getElementById('term');

  function rowAt(clientY) {
    var rect = termEl.getBoundingClientRect();
    var rowH = rect.height / term.rows;
    var r = Math.floor((clientY - rect.top) / rowH);
    r = Math.max(0, Math.min(term.rows - 1, r));
    return term.buffer.active.viewportY + r;
  }
  function selectRows(a, b) {
    var from = Math.min(a, b);
    var to = Math.max(a, b);
    term.selectLines(from, to);
  }
  termEl.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    pressStart = { x: t.clientX, y: t.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function () {
      selAnchor = rowAt(t.clientY);
      selectRows(selAnchor, selAnchor);
      post({ type: 'selection', has: true });
    }, 450);
  }, { passive: true });
  termEl.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    if (selAnchor === null) {
      // Moved before the long-press fired: it's a scroll, not a selection.
      if (pressStart && Math.abs(t.clientY - pressStart.y) + Math.abs(t.clientX - pressStart.x) > 10) {
        clearTimeout(pressTimer);
      }
      return;
    }
    e.preventDefault();
    selectRows(selAnchor, rowAt(t.clientY));
  }, { passive: false });
  function endTouch() {
    clearTimeout(pressTimer);
    selAnchor = null;
  }
  termEl.addEventListener('touchend', endTouch, { passive: true });
  termEl.addEventListener('touchcancel', endTouch, { passive: true });

  window.pilotCopy = function () {
    var text = term.getSelection();
    post({ type: 'copy', text: text });
    if (text) term.clearSelection();
  };
  window.pilotPaste = function (text) {
    // term.paste honours bracketed-paste mode, so editors and AI CLIs get the
    // text as a paste rather than as typed keystrokes.
    if (text) term.paste(text);
    term.focus();
  };

  window.pilotToggle = function (mod) {
    if (mod === 'ctrl') pendingCtrl = !pendingCtrl;
    if (mod === 'alt') pendingAlt = !pendingAlt;
    postModifiers();
    term.focus();
  };

  /** Apply any armed modifier to one chunk of typed input. */
  function applyModifiers(data) {
    if (!pendingCtrl && !pendingAlt) return data;
    var out = data;
    if (pendingCtrl && out.length === 1) {
      var c = out.toUpperCase().charCodeAt(0);
      // Ctrl maps @A-Z[\\]^_ onto 0x00-0x1f; anything else passes through.
      if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
      else if (c >= 97 && c <= 122) out = String.fromCharCode(c - 96);
    }
    if (pendingAlt) out = '\\x1b' + out;
    pendingCtrl = false;
    pendingAlt = false;
    postModifiers();
    return out;
  }

  term.onData(function (data) {
    send(applyModifiers(data));
  });
  term.onResize(function (sz) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: sz.cols, rows: sz.rows }));
    }
    post({ type: 'size', cols: sz.cols, rows: sz.rows });
  });

  window.addEventListener('resize', function () {
    try { fit.fit(); } catch (_) {}
  });

  connect();
})();
</script>
</body></html>`;

export interface TerminalConfig {
  host: string;
  port: string;
  token: string;
  cwd: string;
  cols: number;
  rows: number;
  session: string;
  /** Tool id to launch for a new session; defaults to the shell. */
  tool?: string;
  model?: string;
}

/**
 * Encode the per-session config as a JS object literal for the inline script.
 *
 * These values used to be pasted straight into `var CWD = "__CWD__";`, which
 * quietly assumed every path was POSIX. A Windows `cwd` is full of
 * backslashes, and inside a JS string literal those are escape sequences:
 * `C:\Users\jorda` loses them and becomes `C:Usersjorda` (so the daemon's
 * `statSync` check rejects a directory that does exist), while a folder like
 * `\ui` or `\xtras` produces `\u`/`\x` — a parse error that kills the entire
 * script and leaves a blank terminal. Folder names are also arbitrary user
 * data; `x"; alert(1); //` is a legal directory name.
 *
 * `JSON.stringify` handles quotes, backslashes and control characters. The
 * extra escapes cover the two things it doesn't: `</script>` ending the block
 * early, and U+2028/U+2029, which older JS parsers treat as line terminators.
 */
function encodeConfig(cfg: TerminalConfig): string {
  return JSON.stringify(cfg)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Build the WebView document for one session. */
export function renderHtml(cfg: TerminalConfig): string {
  // Function replacement, not a string: `$&` / `$1` in a folder name must not
  // be re-interpreted as a replacement pattern.
  return TERMINAL_HTML_TEMPLATE.replace('__CONFIG__', () => encodeConfig(cfg));
}
