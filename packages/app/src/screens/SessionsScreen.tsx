import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { SessionInfo, SessionsResponse } from '@pilot/shared';
import { SESSIONS_PATH } from '@pilot/shared';
import { TopBar } from '../components/TopBar.js';
import { apiGet } from '../api.js';
import { listMachines } from '../storage.js';
import type { PairedMachine } from '../types.js';

export interface SessionsScreenProps {
  machineId: string;
  onBack: () => void;
  /** Attach to an existing session. */
  onOpenSession: (sessionId: string) => void;
  /** Start a new session (goes to the folder picker first). */
  onNewSession: () => void;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

export function SessionsScreen({
  machineId,
  onBack,
  onOpenSession,
  onNewSession,
}: SessionsScreenProps) {
  const [machine, setMachine] = useState<PairedMachine | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const m = (await listMachines()).find((x) => x.id === machineId) ?? null;
    setMachine(m);
    if (!m) {
      setError('Machine no longer paired.');
      return;
    }
    try {
      const res = await apiGet<SessionsResponse>(m, SESSIONS_PATH);
      setSessions(res.sessions);
    } catch {
      setError('Could not reach the machine. Is it online?');
      setSessions([]);
    }
  }, [machineId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.root}>
      <TopBar title={machine?.name ?? 'Sessions'} onBack={onBack} />

      <TouchableOpacity style={styles.newBtn} onPress={onNewSession}>
        <Text style={styles.newBtnText}>＋ New session</Text>
      </TouchableOpacity>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {sessions === null && !error ? (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          {sessions && sessions.length > 0 ? (
            <>
              <Text style={styles.sectionLabel}>Running sessions</Text>
              {sessions.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  style={styles.row}
                  onPress={() => onOpenSession(s.id)}
                >
                  <View
                    style={[styles.dot, s.attached ? styles.dotOn : styles.dotIdle]}
                  />
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{s.tool}</Text>
                    <Text style={styles.rowSub}>{s.cwd}</Text>
                  </View>
                  <Text style={styles.rowMeta}>{ago(s.createdMs)}</Text>
                </TouchableOpacity>
              ))}
            </>
          ) : sessions && !error ? (
            <Text style={styles.empty}>
              No running sessions. Start one with ＋ New session.
            </Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40 },
  newBtn: {
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 16,
  },
  newBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  error: { color: '#f87171', marginBottom: 12 },
  sectionLabel: { color: '#9ca3af', fontSize: 12, marginBottom: 8 },
  empty: { color: '#888', textAlign: 'center', marginTop: 24, lineHeight: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1f232c',
    padding: 14,
    borderRadius: 10,
    marginBottom: 8,
    gap: 12,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOn: { backgroundColor: '#22c55e' },
  dotIdle: { backgroundColor: '#6b7280' },
  rowText: { flex: 1 },
  rowTitle: { color: '#fff', fontWeight: '600', fontSize: 15 },
  rowSub: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
    fontFamily: 'Menlo',
  },
  rowMeta: { color: '#9ca3af', fontSize: 11 },
});
