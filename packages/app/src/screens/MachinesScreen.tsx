import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { PairedMachine } from '../types.js';
import { listMachines, removeMachine, setLastSeen } from '../storage.js';
import { HealthResponseSchema } from '@pilot/shared';

export interface MachinesScreenProps {
  onAddMachine: () => void;
  onOpenTerminal: (machineId: string) => void;
}

type Status = 'unknown' | 'checking' | 'online' | 'offline';

/**
 * Pings /api/health with a 2s timeout and reports status. The timeout is
 * generous-enough for Tailscale hairpin; tighter times produce spurious
 * `offline`s during the daemon's startup banner.
 */
async function pingOne(machine: PairedMachine): Promise<Status> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`http://${machine.host}:${machine.port}/api/health`, {
      headers: { authorization: `Bearer ${machine.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return 'offline';
    HealthResponseSchema.parse(await res.json());
    return 'online';
  } catch {
    return 'offline';
  } finally {
    clearTimeout(timeout);
  }
}

export function MachinesScreen({
  onAddMachine,
  onOpenTerminal,
}: MachinesScreenProps) {
  const [machines, setMachines] = useState<PairedMachine[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await listMachines();
      setMachines(list);
      const next: Record<string, Status> = {};
      const updates = list.map(async (m) => {
        next[m.id] = 'checking';
        setStatus((s) => ({ ...s, [m.id]: 'checking' }));
        const s = await pingOne(m);
        next[m.id] = s;
        setStatus((cur) => ({ ...cur, [m.id]: s }));
        if (s === 'online') {
          await setLastSeen(m.id, Date.now());
        }
      });
      await Promise.all(updates);
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleRemove = useCallback(
    async (id: string) => {
      await removeMachine(id);
      void refresh();
    },
    [refresh],
  );

  if (!loaded) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.h1}>Machines</Text>
        <TouchableOpacity style={styles.addBtn} onPress={onAddMachine}>
          <Text style={styles.addBtnText}>+ Pair</Text>
        </TouchableOpacity>
      </View>

      {machines.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No machines yet</Text>
          <Text style={styles.emptyBody}>
            Run{' '}
            <Text style={styles.code}>pilot</Text>
            {' '}on your dev machine, then tap "+ Pair" to scan its QR.
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.list}
          contentContainerStyle={{ paddingBottom: 24 }}
          refreshControl={
            <RefreshControl
              tintColor="#fff"
              refreshing={refreshing}
              onRefresh={refresh}
            />
          }
        >
          {machines.map((m) => {
            const s = status[m.id] ?? 'unknown';
            return (
              <TouchableOpacity
                key={m.id}
                style={styles.row}
                onPress={() => onOpenTerminal(m.id)}
                onLongPress={() => handleRemove(m.id)}
              >
                <View style={[styles.dot, dotStyles[s]]} />
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>{m.name}</Text>
                  <Text style={styles.rowSubtitle}>
                    {m.host}:{m.port}
                  </Text>
                </View>
                <Text style={styles.rowStatus}>{labelFor(s)}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function labelFor(s: Status): string {
  switch (s) {
    case 'unknown':
      return '–';
    case 'checking':
      return '…';
    case 'online':
      return 'Online';
    case 'offline':
      return 'Offline';
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  h1: { color: '#fff', fontSize: 22, fontWeight: '600' },
  addBtn: {
    backgroundColor: '#0ea5e9',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  addBtnText: { color: '#fff', fontWeight: '600' },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyTitle: { color: '#fff', fontSize: 16, marginBottom: 8 },
  emptyBody: { color: '#888', textAlign: 'center', lineHeight: 20 },
  code: { fontFamily: 'Menlo', color: '#0ea5e9' },
  list: { flex: 1 },
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
  rowText: { flex: 1 },
  rowTitle: { color: '#fff', fontWeight: '600', fontSize: 15 },
  rowSubtitle: { color: '#888', fontSize: 12, marginTop: 2 },
  rowStatus: { color: '#9ca3af', fontSize: 12 },
});

const dotStyles = StyleSheet.create({
  unknown: { backgroundColor: '#6b7280' },
  checking: { backgroundColor: '#facc15' },
  online: { backgroundColor: '#22c55e' },
  offline: { backgroundColor: '#f87171' },
});
