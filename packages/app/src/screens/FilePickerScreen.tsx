import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import type { FsMkdirResponse, FsResponse } from '@pilot/shared';
import { FS_MKDIR_PATH, FS_PATH } from '@pilot/shared';
import { TopBar } from '../components/TopBar.js';
import { ApiError, apiGet, apiPost, describeApiError } from '../api.js';
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

  // "New folder" modal state.
  const [newFolderModal, setNewFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const browse = useCallback(async (m: PairedMachine, path?: string) => {
    setLoading(true);
    setError(null);
    try {
      const q = path ? `${FS_PATH}?path=${encodeURIComponent(path)}` : FS_PATH;
      setData(await apiGet<FsResponse>(m, q));
    } catch (err) {
      // /api/fs answers 400 (never 404) for a path that's unreadable or
      // outside the allowlist — so a 400 is about this folder, while anything
      // else is about the machine or the daemon's age.
      setError(
        err instanceof ApiError && err.status === 400
          ? 'Could not read that folder.'
          : describeApiError(err, 'folder browsing'),
      );
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

  const openNewFolder = useCallback(() => {
    setNewFolderName('');
    setCreateError(null);
    setCreating(false);
    setNewFolderModal(true);
  }, []);
  const closeNewFolder = useCallback(() => {
    if (creating) return;
    setNewFolderModal(false);
  }, [creating]);

  const createFolder = useCallback(async () => {
    if (!machine) return;
    const name = newFolderName.trim();
    if (!name) return;
    setCreating(true);
    setCreateError(null);
    try {
      await apiPost<FsMkdirResponse>(machine, FS_MKDIR_PATH, {
        parent: data?.path ?? '',
        name,
      });
      setNewFolderModal(false);
      setNewFolderName('');
      // Re-browse so the new folder appears in the listing without a manual
      // refresh and lands in the sorted position the server returns.
      await browse(machine, data?.path);
    } catch (err) {
      // apiPost throws `Error("HTTP <code>: <server error>")` on non-2xx when
      // the body was JSON with `{ error }`; otherwise bare status. Native
      // fetch failures (timeout, DNS, ECONNREFUSED) come through as plain
      // `Error` strings like "Aborted" or "Network request failed".
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('409') || msg.includes('already exists')) {
        setCreateError('A folder with that name already exists.');
      } else if (msg.startsWith('HTTP ')) {
        // Pass the server-side detail through verbatim so the next attempt
        // shows the actual reason ("HTTP 403: permission denied …", etc.).
        setCreateError(`Could not create folder (${msg})`);
      } else {
        setCreateError(`Network error: ${msg}`);
      }
    } finally {
      setCreating(false);
    }
  }, [machine, newFolderName, data?.path, browse]);

  const current = data?.path ?? '';
  // Navigation targets come from the daemon as absolute host-native paths —
  // never split or join them here (the host may be macOS, Linux, or Windows).
  const parent = data?.parent ?? null;
  const dirs = (data?.entries ?? []).filter((e) => e.type === 'dir');
  const canCreate = machine !== null && newFolderName.trim().length > 0 && !creating;

  return (
    <View style={styles.root}>
      <TopBar title="Choose folder" onBack={onBack} />

      <Text style={styles.path} numberOfLines={1}>
        {current || '…'}
      </Text>

      {machine ? (
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.useBtn, styles.actionFlex]}
            onPress={() => onPick(current)}
          >
            <Text style={styles.useBtnText}>Use this folder</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.newBtn, styles.actionFlex]}
            onPress={openNewFolder}
          >
            <Text style={styles.newBtnText}>+ New folder</Text>
          </TouchableOpacity>
        </View>
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
              No sub-folders here.{' '}
              {machine
                ? 'Tap "+ New folder" to create one, or go up.'
                : 'Use this folder or go up.'}
            </Text>
          ) : null}
        </ScrollView>
      )}

      <Modal
        animationType="fade"
        transparent
        visible={newFolderModal}
        onRequestClose={closeNewFolder}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalRoot}
        >
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={closeNewFolder}
          />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>New folder</Text>
            <Text style={styles.modalSubtitle} numberOfLines={1}>
              In {current || '…'}
            </Text>
            <TextInput
              value={newFolderName}
              onChangeText={setNewFolderName}
              placeholder="Folder name"
              placeholderTextColor="#6b7280"
              style={styles.modalInput}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => void createFolder()}
              editable={!creating}
              selectTextOnFocus
            />
            {createError ? (
              <Text style={styles.modalError} accessibilityLiveRegion="polite">
                {createError}
              </Text>
            ) : null}
            <View style={styles.modalButtons}>
              <TouchableOpacity
                onPress={closeNewFolder}
                disabled={creating}
                style={styles.modalBtn}
              >
                <Text style={styles.modalCancel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => void createFolder()}
                disabled={!canCreate}
                style={styles.modalBtn}
              >
                <Text
                  style={[styles.modalCreate, !canCreate && styles.modalCreateDisabled]}
                >
                  {creating ? 'Creating…' : 'Create'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
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
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  actionFlex: { flex: 1 },
  useBtn: {
    backgroundColor: '#0ea5e9',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  useBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  newBtn: {
    backgroundColor: '#1f232c',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#374151',
  },
  newBtnText: { color: '#0ea5e9', fontWeight: '600', fontSize: 15 },
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
  modalRoot: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'stretch',
    padding: 16,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  modalCard: {
    backgroundColor: '#1f232c',
    borderRadius: 12,
    padding: 16,
  },
  modalTitle: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 4 },
  modalSubtitle: {
    color: '#9ca3af',
    fontFamily: 'Menlo',
    fontSize: 12,
    marginBottom: 14,
  },
  modalInput: {
    backgroundColor: '#0f1115',
    color: '#fff',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#374151',
    marginBottom: 12,
  },
  modalError: { color: '#f87171', marginBottom: 8 },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 14,
    marginTop: 4,
  },
  modalBtn: { paddingVertical: 6, paddingHorizontal: 4 },
  modalCancel: { color: '#9ca3af', fontSize: 15 },
  modalCreate: { color: '#0ea5e9', fontWeight: '600', fontSize: 15 },
  modalCreateDisabled: { color: '#374151' },
});
