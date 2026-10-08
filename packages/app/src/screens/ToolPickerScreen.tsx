import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { ToolInfo, ToolsResponse } from '@pilot/shared';
import { TOOLS_PATH } from '@pilot/shared';
import { TopBar } from '../components/TopBar.js';
import { apiGet, describeApiError } from '../api.js';
import { listMachines } from '../storage.js';

export interface ToolPickerScreenProps {
  machineId: string;
  cwd: string;
  onBack: () => void;
  /** Chosen tool (and, for ollama, model) → start the session. */
  onPick: (tool: string, model?: string) => void;
}

/** Tools that need a model name before they can start. */
const NEEDS_MODEL = new Set(['ollama']);

export function ToolPickerScreen({ machineId, cwd, onBack, onPick }: ToolPickerScreenProps) {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modelFor, setModelFor] = useState<string | null>(null);
  const [model, setModel] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const m = (await listMachines()).find((x) => x.id === machineId);
        if (!m) {
          if (!cancelled) setError('Machine no longer paired.');
          return;
        }
        const res = await apiGet<ToolsResponse>(m, TOOLS_PATH);
        if (!cancelled) setTools(res.tools);
      } catch (err) {
        if (!cancelled) setError(describeApiError(err, 'the tool list'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [machineId]);

  const choose = (t: ToolInfo) => {
    if (!t.available) return;
    if (NEEDS_MODEL.has(t.id)) {
      setModelFor(t.id);
      return;
    }
    onPick(t.id);
  };

  return (
    <View style={styles.root}>
      <TopBar title="Choose tool" onBack={onBack} />
      <Text style={styles.path} numberOfLines={1}>
        {cwd}
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
          {tools.map((t) => (
            <View key={t.id}>
              <TouchableOpacity
                disabled={!t.available}
                style={[styles.row, !t.available && styles.rowDisabled]}
                onPress={() => choose(t)}
              >
                <Text style={styles.rowName}>{t.label}</Text>
                {!t.available ? <Text style={styles.badge}>not installed</Text> : null}
              </TouchableOpacity>
              {modelFor === t.id ? (
                <View style={styles.modelBox}>
                  <TextInput
                    value={model}
                    onChangeText={setModel}
                    placeholder="Model (e.g. llama3.2)"
                    placeholderTextColor="#6b7280"
                    style={styles.input}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={() => model.trim() && onPick(t.id, model.trim())}
                  />
                  <TouchableOpacity
                    disabled={!model.trim()}
                    style={[styles.go, !model.trim() && styles.rowDisabled]}
                    onPress={() => onPick(t.id, model.trim())}
                  >
                    <Text style={styles.goText}>Start</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40 },
  path: { color: '#9ca3af', fontFamily: 'Menlo', fontSize: 12, marginBottom: 12 },
  error: { color: '#f87171', marginBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
    paddingHorizontal: 14,
    backgroundColor: '#1f232c',
    borderRadius: 10,
    marginBottom: 8,
  },
  rowDisabled: { opacity: 0.45 },
  rowName: { color: '#fff', fontSize: 16 },
  badge: { color: '#9ca3af', fontSize: 12 },
  modelBox: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  input: {
    flex: 1,
    backgroundColor: '#0f1115',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#374151',
  },
  go: {
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  goText: { color: '#fff', fontWeight: '600' },
});
