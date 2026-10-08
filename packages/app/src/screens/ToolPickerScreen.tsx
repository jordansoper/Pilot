import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { SettingsResponse, ToolsResponse } from '@pilot/shared';
import { SETTINGS_PATH, TOOLS_PATH } from '@pilot/shared';
import { TopBar } from '../components/TopBar.js';
import { apiGet } from '../api.js';
import { listMachines } from '../storage.js';

export interface ToolPickerScreenProps {
  machineId: string;
  onBack: () => void;
  /** Chosen tool (and, for ollama, model) → go to folder picker. */
  onPick: (tool: string, model?: string) => void;
  /**
   * Install & set up a tool the machine doesn't have yet → open a terminal
   * where the daemon runs the install, then the tool's first-run setup.
   * `cwd` is the directory to run it in (the daemon's fsRoot / home dir).
   */
  onInstall: (tool: string, cwd: string) => void;
}

export function ToolPickerScreen({
  machineId,
  onBack,
  onPick,
  onInstall,
}: ToolPickerScreenProps) {
  const [tools, setTools] = useState<ToolsResponse['tools'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [modelFor, setModelFor] = useState<string | null>(null);
  const [model, setModel] = useState('');

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

  // Install runs in the machine's home dir (its fsRoot) — no folder to pick.
  const startInstall = useCallback(
    async (tool: string) => {
      if (installing) return;
      setInstalling(true);
      try {
        const m = (await listMachines()).find((x) => x.id === machineId) ?? null;
        if (!m) {
          setError('Machine no longer paired.');
          return;
        }
        const settings = await apiGet<SettingsResponse>(m, SETTINGS_PATH);
        onInstall(tool, settings.fsRoot);
      } catch {
        setError('Could not reach the machine. Is it online?');
      } finally {
        setInstalling(false);
      }
    },
    [installing, machineId, onInstall],
  );

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
          {tools?.map((t) => {
            // Missing but installable → the row becomes "Install & set up":
            // tapping opens a terminal where the daemon installs the agent
            // and runs its first-time setup (login etc.).
            const canInstall = !t.available && t.installable === true;
            return (
              <View key={t.id}>
              <TouchableOpacity
                style={[styles.row, !t.available && !canInstall && styles.rowDisabled]}
                onPress={() => {
                  if (t.available) {
                    // Ollama needs a model name before it can start.
                    if (t.id === 'ollama') setModelFor(t.id);
                    else onPick(t.id);
                  }
                  else if (canInstall) void startInstall(t.id);
                }}
                disabled={(!t.available && !canInstall) || installing}
              >
                <Text style={styles.rowLabel}>{t.label}</Text>
                <Text
                  style={[
                    styles.rowTag,
                    t.available ? styles.tagOn : canInstall ? styles.tagInstall : styles.tagOff,
                  ]}
                >
                  {t.available ? 'available' : canInstall ? 'install & set up' : 'not found'}
                </Text>
              </TouchableOpacity>
              {modelFor === t.id ? (
                <View style={styles.modelBox}>
                  <TextInput
                    value={model}
                    onChangeText={setModel}
                    placeholder="Model (e.g. llama3.2)"
                    placeholderTextColor="#6b7280"
                    style={styles.modelInput}
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={() => model.trim() && onPick(t.id, model.trim())}
                  />
                  <TouchableOpacity
                    disabled={!model.trim()}
                    style={[styles.modelGo, !model.trim() && styles.rowDisabled]}
                    onPress={() => onPick(t.id, model.trim())}
                  >
                    <Text style={styles.modelGoText}>Start</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              </View>
            );
          })}
          {tools && tools.length === 0 && !error ? (
            <Text style={styles.empty}>No tools available.</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  modelBox: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  modelInput: {
    flex: 1,
    backgroundColor: '#0f1115',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#374151',
  },
  modelGo: {
    backgroundColor: '#0ea5e9',
    borderRadius: 8,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  modelGoText: { color: '#fff', fontWeight: '600' },
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
  tagInstall: { backgroundColor: '#172554', color: '#60a5fa' },
});
