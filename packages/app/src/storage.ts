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
    // Defensive: only keep entries that look like a machine, then backfill
    // fields added in later versions (hosts, lastGoodHost) so pre-existing
    // pairings keep working.
    return parsed
      .filter(
        (m) =>
          !!m &&
          typeof m.host === 'string' &&
          typeof m.token === 'string' &&
          typeof m.port === 'number',
      )
      .map((m): PairedMachine => {
        const hosts =
          Array.isArray(m.hosts) && m.hosts.length > 0
            ? m.hosts.filter((h: unknown): h is string => typeof h === 'string')
            : [m.host];
        return {
          id: typeof m.id === 'string' ? m.id : machineId(m.host, m.port),
          host: m.host,
          hosts: hosts.length > 0 ? hosts : [m.host],
          port: m.port,
          token: m.token,
          name: typeof m.name === 'string' ? m.name : m.host,
          lastSeenMs: typeof m.lastSeenMs === 'number' ? m.lastSeenMs : null,
          lastGoodHost: typeof m.lastGoodHost === 'string' ? m.lastGoodHost : null,
        };
      });
  } catch {
    return [];
  }
}

/** Upsert by deterministic id (host:port). */
export async function upsertMachine(machine: PairedMachine): Promise<void> {
  const machines = await listMachines();
  const i = machines.findIndex((m) => m.id === machineId(machine.host, machine.port));
  const next =
    i >= 0
      ? machines.map((m, idx) => (idx === i ? { ...m, ...machine } : m))
      : [...machines, machine];
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export async function removeMachine(id: string): Promise<void> {
  const machines = await listMachines();
  const next = machines.filter((m) => m.id !== id);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

/**
 * Wipe all Pilot-stored data (paired machines, and any future keys). Used by
 * the Settings "Reset app" action to return to a clean slate — handy when a
 * pairing is stuck with a stale token.
 */
export async function resetApp(): Promise<void> {
  await AsyncStorage.multiRemove([STORAGE_KEY]);
}

export async function setLastSeen(id: string, lastSeenMs: number | null): Promise<void> {
  const machines = await listMachines();
  const i = machines.findIndex((m) => m.id === id);
  if (i < 0) return;
  const next = machines.map((m, idx) => (idx === i ? { ...m, lastSeenMs } : m));
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

/** Record which host last answered, so it's tried first and used for the terminal. */
export async function setLastGoodHost(id: string, host: string): Promise<void> {
  const machines = await listMachines();
  const i = machines.findIndex((m) => m.id === id);
  if (i < 0) return;
  const next = machines.map((m, idx) => (idx === i ? { ...m, lastGoodHost: host } : m));
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}
