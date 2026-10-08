import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { PUSH_REGISTER_PATH, PUSH_UNREGISTER_PATH } from '@pilot/shared';
import { apiPost } from './api.js';
import { listMachines } from './storage.js';

const ENABLED_KEY = '@pilot/notifications/enabled/v1';
const CHANNEL_ID = 'agent-waiting';

/** Show the banner only when the app is NOT in the foreground. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Notifications are on unless the user switched them off. */
export async function notificationsEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(ENABLED_KEY)) !== 'off';
}

export async function setNotificationsEnabled(on: boolean): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, on ? 'on' : 'off');
}

export type PushTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: 'denied' | 'no-project-id' | 'error'; detail?: string };

/** Ask permission and fetch this phone's Expo push token. */
export async function getPushToken(): Promise<PushTokenResult> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Agent waiting',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== 'granted') return { ok: false, reason: 'denied' };

    const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
    const projectId = extra?.eas?.projectId;
    if (!projectId) return { ok: false, reason: 'no-project-id' };

    const res = await Notifications.getExpoPushTokenAsync({ projectId });
    return { ok: true, token: res.data };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Tell every paired machine to notify this phone (or stop). Best effort per
 * machine: one being offline must not block the rest.
 */
export async function syncPushRegistrations(): Promise<PushTokenResult | null> {
  const machines = await listMachines();
  if (machines.length === 0) return null;
  const enabled = await notificationsEnabled();
  const tokenRes = await getPushToken();
  if (!tokenRes.ok) return tokenRes;
  await Promise.all(
    machines.map((m) =>
      apiPost(m, enabled ? PUSH_REGISTER_PATH : PUSH_UNREGISTER_PATH, {
        token: tokenRes.token,
      }).catch(() => undefined),
    ),
  );
  return tokenRes;
}
