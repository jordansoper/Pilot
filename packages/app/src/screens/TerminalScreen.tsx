import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import { listMachines } from '../storage.js';
import type { PairedMachine } from '../types.js';
import { renderHtml } from '../terminal-html.js';

const BASE_URL = 'http://pilot.local';

/**
 * Termux-style quick keys. A soft keyboard can't produce Esc, Tab, Ctrl or
 * arrows, which makes a real shell — let alone vim or a TUI — unusable without
 * them. Ctrl and Alt are sticky toggles handled inside the WebView (see
 * `terminal-html.ts`): they arm a modifier applied to the next typed
 * character, rather than sending anything on their own.
 */
const QUICK_KEYS: ReadonlyArray<{ label: string; key: string }> = [
  { label: 'Esc', key: 'esc' },
  { label: 'Tab', key: 'tab' },
  { label: '↑', key: 'up' },
  { label: '↓', key: 'down' },
  { label: '←', key: 'left' },
  { label: '→', key: 'right' },
  { label: '^C', key: 'ctrl-c' },
  { label: '^D', key: 'ctrl-d' },
  { label: 'Home', key: 'home' },
  { label: 'End', key: 'end' },
  { label: 'PgUp', key: 'pgup' },
  { label: 'PgDn', key: 'pgdn' },
];

export interface TerminalScreenProps {
  machineId: string;
  /** Existing session to re-attach to, or undefined to start a new one. */
  sessionId?: string;
  /** Working directory for a NEW session (from the folder picker). */
  cwd?: string;
  /** Tool id for a NEW session; defaults to the shell. */
  tool?: string | undefined;
  /** Model for tools that take one (ollama). */
  model?: string | undefined;
  onBack: () => void;
}

export function TerminalScreen({
  machineId,
  sessionId,
  cwd,
  tool,
  model,
  onBack,
}: TerminalScreenProps) {
  const [machine, setMachine] = useState<PairedMachine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('connecting…');
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);
  const webRef = useRef<WebView>(null);

  // `true;` at the end keeps Android's evaluateJavascript from warning about a
  // non-serialisable return value.
  const sendKey = useCallback((key: string) => {
    webRef.current?.injectJavaScript(`window.pilotKey(${JSON.stringify(key)});true;`);
  }, []);
  const copySelection = useCallback(() => {
    webRef.current?.injectJavaScript('window.pilotCopy();true;');
  }, []);
  const pasteClipboard = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (!text) return;
    webRef.current?.injectJavaScript(`window.pilotPaste(${JSON.stringify(text)});true;`);
  }, []);
  const toggleModifier = useCallback((mod: 'ctrl' | 'alt') => {
    webRef.current?.injectJavaScript(`window.pilotToggle(${JSON.stringify(mod)});true;`);
  }, []);

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
      setMachine(m);
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
      else if (msg.type === 'copy') {
        if (typeof msg.text === 'string' && msg.text) {
          void Clipboard.setStringAsync(msg.text);
          setStatus('copied');
        } else {
          setStatus('long-press a line to select, then Copy');
        }
      } else if (msg.type === 'modifiers') {
        // The WebView owns modifier state — it clears them once the next
        // character consumes them, so the buttons follow rather than lead.
        setCtrlArmed(!!msg.ctrl);
        setAltArmed(!!msg.alt);
      } else if (msg.type === 'session') {
        setStatus(msg.resumed ? 'resumed session' : 'new session');
      } else if (msg.type === 'exit') {
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

  if (!machine) {
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
    // Empty means "no opinion" — the daemon picks its own root. Guessing here
    // is what broke resumes on Windows: the old `/tmp` fallback doesn't exist
    // there, and the daemon rejected the handshake with `invalid cwd`.
    cwd: cwd ?? '',
    cols: 80,
    rows: 24,
    session: sessionId ?? '',
    tool: tool ?? 'bash',
    model: model ?? '',
  });

  return (
    <View style={styles.root}>
      <Header onBack={onBack} status={status} />
      <View style={styles.web}>
        <WebView
          ref={webRef}
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
          // Stable within a mount so backgrounding doesn't reset the terminal;
          // keyed by the specific session/cwd so opening a different session
          // gets a fresh WebView.
          key={`${machine.id}|${sessionId ?? `new:${cwd ?? ''}`}`}
        />
      </View>
      <KeyBar
        ctrlArmed={ctrlArmed}
        altArmed={altArmed}
        onKey={sendKey}
        onToggle={toggleModifier}
        onCopy={copySelection}
        onPaste={() => void pasteClipboard()}
      />
    </View>
  );
}

function KeyBar({
  ctrlArmed,
  altArmed,
  onKey,
  onToggle,
  onCopy,
  onPaste,
}: {
  ctrlArmed: boolean;
  altArmed: boolean;
  onKey: (key: string) => void;
  onToggle: (mod: 'ctrl' | 'alt') => void;
  onCopy: () => void;
  onPaste: () => void;
}) {
  return (
    <View style={styles.bar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.barContent}
      >
        {/* Sticky modifiers first — they read as state, not actions. */}
        <TouchableOpacity
          onPress={() => onToggle('ctrl')}
          style={[styles.key, ctrlArmed && styles.keyArmed]}
        >
          <Text style={[styles.keyText, ctrlArmed && styles.keyTextArmed]}>Ctrl</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onToggle('alt')}
          style={[styles.key, altArmed && styles.keyArmed]}
        >
          <Text style={[styles.keyText, altArmed && styles.keyTextArmed]}>Alt</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onCopy} style={styles.key}>
          <Text style={styles.keyText}>Copy</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onPaste} style={styles.key}>
          <Text style={styles.keyText}>Paste</Text>
        </TouchableOpacity>
        {QUICK_KEYS.map((k) => (
          <TouchableOpacity key={k.key} onPress={() => onKey(k.key)} style={styles.key}>
            <Text style={styles.keyText}>{k.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
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
    backgroundColor: '#0f1115',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: '#2a2f3a',
  },
  barContent: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
  },
  key: {
    minWidth: 44, // Android's minimum comfortable touch target.
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
    backgroundColor: '#1b2029',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyArmed: { backgroundColor: '#2563eb' },
  keyText: { color: '#d1d5db', fontSize: 13, fontWeight: '600' },
  keyTextArmed: { color: '#fff' },
  web: { flex: 1, backgroundColor: '#1a1a1a' },
});
