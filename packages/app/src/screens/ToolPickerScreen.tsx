import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ToolsResponse } from '@pilot/shared';
import { TOOLS_PATH } from '@pilot/shared';
import { TopBar } from '../components/TopBar.js';
import { apiGet } from '../api.js';
import { listMachines } from '../storage.js';

export interface ToolPickerScreenProps {
  machineId: string;
  onBack: () => void;
  /** Chosen tool → go to folder picker. */
  onPick: (tool: string) => void;
}

export function ToolPickerScreen({
  machineId,
  onBack,
  onPick,
}: ToolPickerScreenProps) {
  const [tools, setTools] = useState<ToolsResponse['tools'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const m = (await listMachines()).find((x) => x.id === machineId) ?? null;
    if (!m) {
      setError('Machine no longer paired.');
      return;
    }
    try {
      const res = await apiGet<ToolsResponse>(m, TOOLS_PATH);
      setTools(res.tools);
    } catch {
      setError('Could not reach the machine. Is it online?');
    }
  }, [machineId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <View style={styles.root}>
      <TopBar title="Choose tool" onBack={onBack} />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {tools === null && !error ? (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          {tools?.map((t) => (
            <TouchableOpacity
              key={t.id}
              style={[styles.row, !t.available && styles.rowDisabled]}
              onPress={() => t.available && onPick(t.id)}
              disabled={!t.available}
            >
              <Text style={styles.rowLabel}>{t.label}</Text>
              <Text style={[styles.rowTag, t.available ? styles.tagOn : styles.tagOff]}>
                {t.available ? 'available' : 'not found'}
              </Text>
            </TouchableOpacity>
          ))}
          {tools && tools.length === 0 && !error ? (
            <Text style={styles.empty}>No tools available.</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40 },
  error: { color: '#f87171', marginBottom: 12 },
  empty: { color: '#888', textAlign: 'center', marginTop: 24, lineHeight: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1f232c',
    padding: 16,
    borderRadius: 10,
    marginBottom: 8,
  },
  rowDisabled: { opacity: 0.45 },
  rowLabel: { color: '#fff', fontWeight: '600', fontSize: 15 },
  rowTag: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  tagOn: { backgroundColor: '#14532d', color: '#22c55e' },
  tagOff: { backgroundColor: '#2a1f23', color: '#f87171' },
});
