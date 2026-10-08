import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { TopBar } from '../components/TopBar.js';
import { listMachines, resetApp } from '../storage.js';
import {
  notificationsEnabled,
  setNotificationsEnabled,
  syncPushRegistrations,
} from '../notifications.js';

export interface SettingsScreenProps {
  onBack: () => void;
  /** Called after a successful reset so the app can return to a clean home. */
  onReset: () => void;
}

export function SettingsScreen({ onBack, onReset }: SettingsScreenProps) {
  const [count, setCount] = useState<number | null>(null);
  const [notify, setNotify] = useState(true);
  const [notifyNote, setNotifyNote] = useState<string | null>(null);

  useEffect(() => {
    void listMachines().then((m) => setCount(m.length));
    void notificationsEnabled().then(setNotify);
  }, []);

  const toggleNotify = useCallback(async (on: boolean) => {
    setNotify(on);
    await setNotificationsEnabled(on);
    const res = await syncPushRegistrations();
    if (!on || !res) setNotifyNote(null);
    else if (res.ok) setNotifyNote('Registered with your machines.');
    else if (res.reason === 'denied') setNotifyNote('Notification permission was denied in Android settings.');
    else if (res.reason === 'no-project-id') setNotifyNote('This build has no Expo project id, so push is unavailable.');
    else setNotifyNote(`Could not enable notifications${res.detail ? `: ${res.detail}` : '.'}`);
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
        <Text style={styles.sectionLabel}>Notifications</Text>
        <View style={styles.switchRow}>
          <Text style={styles.value}>Tell me when an agent is waiting</Text>
          <Switch value={notify} onValueChange={(v) => void toggleNotify(v)} />
        </View>
        <Text style={styles.hint}>
          {notifyNote ??
            'Sent from your computer through Expo push, so the computer needs internet access for this one feature.'}
        </Text>
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
  value: { color: '#fff', fontSize: 16, flexShrink: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
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
