import AsyncStorage from '@react-native-async-storage/async-storage';
import { machineId, type PairedMachine } from './types.js';

const STORAGE_KEY = '@pilot/machines/v1';

/**
 * Read all paired machines from AsyncStorage. Returns an empty array if
 * the key isn't set yet or the JSON is malformed. Doesn't throw — failures
 * are surfaced to the caller via the returned array being shorter than
 * expected, so the UI can decide how aggressively to recover.
 */
export async function listMachines(): Promise<PairedMachine[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: only return entries that look like PairedMachine.
    return parsed.filter((m): m is PairedMachine => {
      return (
        !!m &&
        typeof m.host === 'string' &&
        typeof m.token === 'string' &&
        typeof m.port === 'number'
      );
    });
  } catch {
    return [];
  }
}

/** Upsert by deterministic id (host:port). */
export async function upsertMachine(machine: PairedMachine): Promise<void> {
  const machines = await listMachines();
  const i = machines.findIndex((m) => m.id === machineId(machine.host, machine.port));
  const next = i >= 0
    ? machines.map((m, idx) => (idx === i ? { ...m, ...machine } : m))
    : [...machines, machine];
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export async function removeMachine(id: string): Promise<void> {
  const machines = await listMachines();
  const next = machines.filter((m) => m.id !== id);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export async function setLastSeen(
  id: string,
  lastSeenMs: number | null,
): Promise<void> {
  const machines = await listMachines();
  const i = machines.findIndex((m) => m.id === id);
  if (i < 0) return;
  const next = machines.map((m, idx) =>
    idx === i ? { ...m, lastSeenMs } : m,
  );
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}
