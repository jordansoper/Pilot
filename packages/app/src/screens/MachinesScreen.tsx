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
import { listMachines, removeMachine, setLastGoodHost, setLastSeen } from '../storage.js';
import { HealthResponseSchema } from '@pilot/shared';

export interface MachinesScreenProps {
  onAddMachine: () => void;
  onOpenTerminal: (machineId: string) => void;
  onOpenSettings: () => void;
}

type Status = 'unknown' | 'checking' | 'online' | 'offline';

/** Ping one address. 6s timeout — generous for a cold Tailscale tunnel. */
async function pingHost(machine: PairedMachine, host: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch(`http://${host}:${machine.port}/api/health`, {
      headers: { authorization: `Bearer ${machine.token}` },
      signal: controller.signal,
    });
    if (!res.ok) return false;
    HealthResponseSchema.parse(await res.json());
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Try every candidate address in parallel; the first that answers wins (LAN
 * usually beats Tailscale on the same Wi-Fi). Returns the winning host so it
 * can be preferred next time and used for the terminal.
 */
async function pingOne(
  machine: PairedMachine,
): Promise<{ status: Status; host: string | null }> {
  const ordered = machine.lastGoodHost
    ? [machine.lastGoodHost, ...machine.hosts.filter((h) => h !== machine.lastGoodHost)]
    : machine.hosts;
  if (ordered.length === 0) return { status: 'offline', host: null };

  return new Promise((resolve) => {
    let remaining = ordered.length;
    let settled = false;
    for (const host of ordered) {
      void pingHost(machine, host).then((ok) => {
        if (settled) return;
        if (ok) {
          settled = true;
          resolve({ status: 'online', host });
        } else if (--remaining === 0) {
          resolve({ status: 'offline', host: null });
        }
      });
    }
  });
}

export function MachinesScreen({
  onAddMachine,
  onOpenTerminal,
  onOpenSettings,
}: MachinesScreenProps) {
  const [machines, setMachines] = useState<PairedMachine[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [activeHost, setActiveHost] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await listMachines();
      setMachines(list);
      const updates = list.map(async (m) => {
        setStatus((s) => ({ ...s, [m.id]: 'checking' }));
        const { status: s, host } = await pingOne(m);
        setStatus((cur) => ({ ...cur, [m.id]: s }));
        if (s === 'online' && host) {
          setActiveHost((cur) => ({ ...cur, [m.id]: host }));
          await setLastSeen(m.id, Date.now());
          await setLastGoodHost(m.id, host);
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
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.iconBtn} onPress={onOpenSettings} hitSlop={8}>
            <Text style={styles.iconBtnText}>⚙</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.addBtn} onPress={onAddMachine}>
            <Text style={styles.addBtnText}>+ Pair</Text>
          </TouchableOpacity>
        </View>
      </View>

      {machines.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No machines yet</Text>
          <Text style={styles.emptyBody}>
            Run <Text style={styles.code}>pilot</Text> on your dev machine, then tap "+
            Pair" to scan its QR.
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
                    {activeHost[m.id] ?? m.host}:{m.port}
                    {activeHost[m.id] ? ` · ${hostKind(activeHost[m.id]!)}` : ''}
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

/** Label a connected address as Tailscale (100.64.0.0/10) or LAN. */
function hostKind(host: string): string {
  const p = host.split('.').map(Number);
  const isTailscale = p.length === 4 && p[0] === 100 && p[1]! >= 64 && p[1]! <= 127;
  return isTailscale ? 'Tailscale' : 'LAN';
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
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  iconBtn: { padding: 8 },
  iconBtnText: { color: '#9ca3af', fontSize: 20 },
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
