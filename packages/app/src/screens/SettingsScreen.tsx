import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { TopBar } from '../components/TopBar.js';
import { listMachines, resetApp } from '../storage.js';

export interface SettingsScreenProps {
  onBack: () => void;
  /** Called after a successful reset so the app can return to a clean home. */
  onReset: () => void;
}

export function SettingsScreen({ onBack, onReset }: SettingsScreenProps) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    void listMachines().then((m) => setCount(m.length));
  }, []);

  const confirmReset = useCallback(() => {
    Alert.alert(
      'Reset app?',
      'This removes all paired machines and stored data. You will need to pair again from a QR code. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            void resetApp().then(onReset);
          },
        },
      ],
    );
  }, [onReset]);

  return (
    <View style={styles.root}>
      <TopBar title="Settings" onBack={onBack} />

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Paired machines</Text>
        <Text style={styles.value}>{count === null ? '…' : count}</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Data</Text>
        <TouchableOpacity style={styles.dangerBtn} onPress={confirmReset}>
          <Text style={styles.dangerText}>Reset app</Text>
        </TouchableOpacity>
        <Text style={styles.hint}>
          Clears all paired machines and stored data. Use this if a machine is stuck on a
          stale pairing — then pair again from a fresh QR.
        </Text>
      </View>

      <Text style={styles.version}>Pilot · Phase 1</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  section: {
    backgroundColor: '#1f232c',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
  },
  sectionLabel: { color: '#9ca3af', fontSize: 12, marginBottom: 8 },
  value: { color: '#fff', fontSize: 16 },
  dangerBtn: {
    backgroundColor: '#3b1d1d',
    borderColor: '#f87171',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  dangerText: { color: '#f87171', fontWeight: '600', fontSize: 15 },
  hint: { color: '#888', fontSize: 12, marginTop: 8, lineHeight: 18 },
  version: { color: '#4b5563', fontSize: 12, textAlign: 'center', marginTop: 'auto' },
});
