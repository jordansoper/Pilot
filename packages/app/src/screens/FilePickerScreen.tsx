import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { FsResponse } from '@pilot/shared';
import { FS_PATH } from '@pilot/shared';
import { TopBar } from '../components/TopBar.js';
import { apiGet } from '../api.js';
import { listMachines } from '../storage.js';
import type { PairedMachine } from '../types.js';

export interface FilePickerScreenProps {
  machineId: string;
  onBack: () => void;
  /** Chosen folder → start a new session there. */
  onPick: (cwd: string) => void;
}

export function FilePickerScreen({ machineId, onBack, onPick }: FilePickerScreenProps) {
  const [machine, setMachine] = useState<PairedMachine | null>(null);
  const [data, setData] = useState<FsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(async (m: PairedMachine, path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const q = path ? `${FS_PATH}?path=${encodeURIComponent(path)}` : FS_PATH;
      setData(await apiGet<FsResponse>(m, q));
    } catch {
      setError('Could not read that folder.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const m = (await listMachines()).find((x) => x.id === machineId) ?? null;
      setMachine(m);
      if (!m) {
        setError('Machine no longer paired.');
        setLoading(false);
        return;
      }
      await browse(m);
    })();
  }, [machineId, browse]);

  const current = data?.path ?? '';
  // Navigation targets come from the daemon as absolute host-native paths —
  // never split or join them here (the host may be macOS, Linux, or Windows).
  const parent = data?.parent ?? null;
  const dirs = (data?.entries ?? []).filter((e) => e.type === 'dir');

  return (
    <View style={styles.root}>
      <TopBar title="Choose folder" onBack={onBack} />

      <Text style={styles.path} numberOfLines={1}>
        {current || '…'}
      </Text>

      {machine ? (
        <TouchableOpacity style={styles.useBtn} onPress={() => onPick(current)}>
          <Text style={styles.useBtnText}>Use this folder</Text>
        </TouchableOpacity>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          {parent && machine ? (
            <TouchableOpacity
              style={styles.row}
              onPress={() => void browse(machine, parent)}
            >
              <Text style={styles.rowIcon}>↑</Text>
              <Text style={styles.rowName}>..</Text>
            </TouchableOpacity>
          ) : null}
          {dirs.map((d) => (
            <TouchableOpacity
              key={d.name}
              style={styles.row}
              onPress={() => machine && void browse(machine, d.path)}
            >
              <Text style={styles.rowIcon}>📁</Text>
              <Text style={styles.rowName}>{d.name}</Text>
            </TouchableOpacity>
          ))}
          {dirs.length === 0 && !error ? (
            <Text style={styles.empty}>
              No sub-folders here. Use this folder or go up.
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
  path: {
    color: '#9ca3af',
    fontFamily: 'Menlo',
    fontSize: 12,
    marginBottom: 12,
  },
  useBtn: {
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    marginBottom: 14,
  },
  useBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  error: { color: '#f87171', marginBottom: 12 },
  empty: { color: '#888', textAlign: 'center', marginTop: 24 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
    backgroundColor: '#1f232c',
    borderRadius: 10,
    marginBottom: 8,
    gap: 12,
  },
  rowIcon: { fontSize: 16, width: 22, textAlign: 'center' },
  rowName: { color: '#fff', fontSize: 15 },
});
