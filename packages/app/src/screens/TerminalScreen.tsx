import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { clearSessionId, getSessionId, listMachines, setSessionId } from '../storage.js';
import type { PairedMachine } from '../types.js';

/**
 * The static HTML body loaded into the WebView. Self-contained: imports
 * xterm.js + FitAddon from jsDelivr, opens a WebSocket directly back to
 * the CLI (faster than routing PTY bytes through the RN bridge), forwards
 * keystrokes, mirrors resize, and posts `{type:'ready'|'size'|'closed'}`
 * messages back to React Native.
 *
 * The token is sent as the WebSocket subprotocol entry — the only auth
 * path that works from a browser-style WebView, since custom headers are
 * not allowed on `new WebSocket(...)` outside of Node clients.
 *
 * Placeholders `__HOST__`, `__PORT__`, `__TOKEN__`, `__CWD__`, `__COLS__`,
 * `__ROWS__` are interpolated by literal string substitution at render
 * time, NOT via DOM mutation after load (more robust than `history.replaceState`).
 */
const TERMINAL_HTML_TEMPLATE = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #1a1a1a; color: #d0d0d0; }
  #term { position: absolute; inset: 0; padding: 4px; }
  .xterm-viewport, .xterm-screen { background: #1a1a1a !important; }
</style>
</head><body>
<div id="term"></div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
<script>
(function () {
  var HOST = "__HOST__";
  var PORT = "__PORT__";
  var TOKEN = "__TOKEN__";
  var CWD = "__CWD__";
  var COLS = parseInt("__COLS__", 10) || 80;
  var ROWS = parseInt("__ROWS__", 10) || 24;
  var SESSION = "__SESSION__"; // stored session id to resume, or empty

  function post(msg) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }

  if (!HOST || !PORT || !TOKEN) {
    post({ type: 'error', message: 'missing host/port/token in URL' });
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
      + '?cwd=' + encodeURIComponent(CWD)
      + '&tool=bash'
      + '&cols=' + term.cols
      + '&rows=' + term.rows;
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

  term.onData(function (data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
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

/** Substitute __PLACEHOLDER__ markers with literal-but-safe strings. */
function renderHtml(opts: {
  host: string;
  port: string;
  token: string;
  cwd: string;
  cols: number;
  rows: number;
  session: string;
}): string {
  return TERMINAL_HTML_TEMPLATE.replace(/__([A-Z]+)__/g, (_, key: string) => {
    switch (key) {
      case 'HOST':
        return opts.host;
      case 'PORT':
        return opts.port;
      case 'TOKEN':
        return opts.token;
      case 'CWD':
        return opts.cwd;
      case 'COLS':
        return String(opts.cols);
      case 'ROWS':
        return String(opts.rows);
      case 'SESSION':
        return opts.session;
      default:
        return '';
    }
  });
}

const DEFAULT_CWD = '/tmp';
const BASE_URL = 'http://pilot.local';

export interface TerminalScreenProps {
  machineId: string;
  onBack: () => void;
}

export function TerminalScreen({ machineId, onBack }: TerminalScreenProps) {
  const [machine, setMachine] = useState<PairedMachine | null>(null);
  const [cwd, setCwd] = useState(DEFAULT_CWD);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('connecting…');
  // Session id to resume, loaded once before the WebView mounts.
  const [initialSession, setInitialSession] = useState<string>('');
  const [sessionLoaded, setSessionLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await listMachines();
      if (cancelled) return;
      const m = list.find((x) => x.id === machineId) ?? null;
      if (!m) {
        setError('Machine no longer paired.');
        return;
      }
      const sid = await getSessionId(machineId);
      if (cancelled) return;
      setMachine(m);
      setInitialSession(sid ?? '');
      setSessionLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId]);

  const onMessage = (event: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') setStatus(`connected · ${msg.cols}×${msg.rows}`);
      else if (msg.type === 'closed') setStatus(`closed (${msg.code})`);
      else if (msg.type === 'reconnecting') setStatus('reconnecting…');
      else if (msg.type === 'error') setError(msg.message ?? 'error');
      else if (msg.type === 'size') setStatus(`connected · ${msg.cols}×${msg.rows}`);
      else if (msg.type === 'session') {
        // Persist so a full app restart can resume the same shell.
        void setSessionId(machineId, msg.id);
        setStatus(msg.resumed ? 'resumed session' : 'new session');
      } else if (msg.type === 'exit') {
        // Shell ended — drop the stored id so next open starts fresh.
        void clearSessionId(machineId);
        setStatus('session ended');
      }
    } catch {
      /* malformed postMessage — ignore */
    }
  };

  if (error) {
    return (
      <View style={styles.root}>
        <Header onBack={onBack} status={status} />
        <View style={styles.center}>
          <Text style={styles.errTitle}>Cannot open terminal</Text>
          <Text style={styles.errBody}>{error}</Text>
        </View>
      </View>
    );
  }

  if (!machine || !sessionLoaded) {
    return (
      <View style={styles.root}>
        <Header onBack={onBack} status={status} />
        <View style={styles.center}>
          <Text style={styles.muted}>Loading…</Text>
        </View>
      </View>
    );
  }

  const html = renderHtml({
    // Prefer the address that answered the health check (LAN when on the same
    // Wi-Fi), falling back to the first candidate.
    host: machine.lastGoodHost ?? machine.hosts[0] ?? machine.host,
    port: String(machine.port),
    token: machine.token,
    cwd,
    cols: 80,
    rows: 24,
    session: initialSession,
  });

  return (
    <View style={styles.root}>
      <Header onBack={onBack} status={status} />
      <View style={styles.bar}>
        <TextInput
          style={styles.cwdInput}
          value={cwd}
          onChangeText={setCwd}
          placeholder="/path/inside/the/machine"
          placeholderTextColor="#666"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <View style={styles.web}>
        <WebView
          style={styles.web}
          originWhitelist={['*']}
          source={{ html, baseUrl: BASE_URL }}
          onMessage={onMessage}
          // Block navigation away from our inline page.
          onShouldStartLoadWithRequest={(req) =>
            req.url.startsWith(BASE_URL) || req.url === 'about:blank'
          }
          mixedContentMode="always"
          javaScriptCanOpenWindowsAutomatically={false}
          // Keyed by machine only (not cwd) so the terminal is stable — it must
          // NOT remount/reset when backgrounded or when the cwd field changes;
          // the session persists and reconnects itself. cwd is the initial
          // launch dir, read once at mount.
          key={machine.id}
        />
      </View>
    </View>
  );
}

function Header({ onBack, status }: { onBack: () => void; status: string }) {
  return (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} style={styles.backBtn}>
        <Text style={styles.backText}>‹ Machines</Text>
      </TouchableOpacity>
      <Text style={styles.status}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  muted: { color: '#888' },
  errTitle: { color: '#fff', fontSize: 16, marginBottom: 8 },
  errBody: { color: '#f87171', textAlign: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#161a21',
  },
  backBtn: { padding: 4, paddingRight: 12 },
  backText: { color: '#9ca3af', fontSize: 14 },
  status: { color: '#9ca3af', fontSize: 12, flex: 1, textAlign: 'right' },
  bar: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#0f1115',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#2a2f3a',
  },
  cwdInput: {
    color: '#fff',
    fontFamily: 'Menlo',
    fontSize: 12,
    padding: 6,
  },
  web: { flex: 1, backgroundColor: '#1a1a1a' },
});
