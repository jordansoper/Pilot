import { useCallback, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { QrScanner } from '../components/QrScanner.js';
import { TopBar } from '../components/TopBar.js';
import { decodePairingUrl } from '../pairing-decoder.js';
import { fromPairingPayload } from '../types.js';
import { upsertMachine } from '../storage.js';

/**
 * Pairing screen. Scans a `pilot://pair` QR, decodes it with the shared
 * schema, persists, and pops back to the machines list. Also accepts a
 * manual URL paste as a fallback for a damaged QR or a clipboard-shared
 * deep link.
 */
export interface AddMachineScreenProps {
  onDone: () => void;
  onCancel: () => void;
}

export function AddMachineScreen({ onDone, onCancel }: AddMachineScreenProps) {
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  const handleScanned = useCallback(
    async (value: string) => {
      try {
        const decoded = decodePairingUrl(value);
        if (!decoded.ok) {
          setError(decoded.error);
          return;
        }
        await upsertMachine(fromPairingPayload(decoded.payload));
        onDone();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [onDone],
  );

  const handleManualSubmit = useCallback(async () => {
    try {
      setError(null);
      const decoded = decodePairingUrl(manual);
      if (!decoded.ok) {
        setError(decoded.error);
        return;
      }
      await upsertMachine(fromPairingPayload(decoded.payload));
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [manual, onDone]);

  return (
    <View style={styles.root}>
      <TopBar title="Pair a machine" onBack={onCancel} />
      <View style={styles.scannerBox}>
        <QrScanner onScanned={handleScanned} onError={(e) => setError(e)} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.help}>Or paste a pilot://pair URL:</Text>
      <TextInput
        style={styles.input}
        value={manual}
        onChangeText={setManual}
        placeholder="pilot://pair?v=1&p=…"
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
      <View style={styles.row}>
        <TouchableOpacity style={styles.btnGhost} onPress={onCancel}>
          <Text style={styles.btnGhostText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btnPrimary, !manual && styles.btnDisabled]}
          disabled={!manual}
          onPress={handleManualSubmit}
        >
          <Text style={styles.btnPrimaryText}>Pair</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  scannerBox: {
    flex: 1,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  error: { color: '#f87171', marginVertical: 8 },
  help: { color: '#888', marginTop: 12 },
  input: {
    backgroundColor: '#1f232c',
    color: '#fff',
    padding: 12,
    borderRadius: 8,
    marginVertical: 8,
    minHeight: 56,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'flex-end',
  },
  btnGhost: {
    padding: 12,
  },
  btnGhostText: { color: '#9ca3af' },
  btnPrimary: {
    paddingVertical: 12,
    paddingHorizontal: 18,
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '600' },
  btnDisabled: { opacity: 0.4 },
});
