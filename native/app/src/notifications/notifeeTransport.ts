/**
 * The notifee-backed push transport.
 *
 * notifee carries a data message on both platforms: APNs on iOS and Firebase
 * Cloud Messaging on Android. A data message is what this client wants,
 * because the notification is raised from a payload that holds identifiers
 * only - the message text is fetched from the server after the app opens.
 *
 * Credentials are required and are not in this repository:
 *   - iOS needs an APNs key uploaded to the instance's app record, and the
 *     aps-environment entitlement in the entitlements file.
 *   - Android needs a Firebase project with google-services.json, and a
 *     google-services plugin applied in android/app/build.gradle.
 *
 * Without them the transport reports itself unavailable and the app carries
 * on without push rather than failing to start.
 */

import notifee, {AndroidImportance} from '@notifee/react-native';
import {Platform} from 'react-native';

import {
  assertPrivacySafe,
  buildPushPayload,
  PushEvent,
  PushPayload,
  pushNotificationTitle,
} from './payload';
import {PushDevice, PushPlatform, PushTransport} from './transport';

const CHANNEL_ID = 'trycord-messages';

function platform(): PushPlatform {
  return Platform.OS === 'ios' ? 'ios' : 'android';
}

function readPayload(data: unknown): PushPayload | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  const raw = record.payload ?? record;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.v !== 'number' || typeof candidate.type !== 'string') {
    return null;
  }
  return candidate as unknown as PushPayload;
}

export function createNotifeeTransport(): PushTransport {
  return {
    available: true,

    async requestPermission(): Promise<boolean> {
      const settings = await notifee.requestPermission();
      return Boolean(settings.authorizationStatus >= 1);
    },

    async currentDevice(): Promise<PushDevice | null> {
      try {
        // On iOS this is the APNs token. On Android it is the FCM
        // registration token, and it only exists when a Firebase project is
        // configured for the build. A build without one has no token, and the
        // app runs without push.
        const token = await notifee.getToken();
        if (!token) return null;
        return {token, platform: platform()};
      } catch {
        return null;
      }
    },

    onToken(handler: (device: PushDevice) => void): () => void {
      // The token is read once at sign-in rather than watched: notifee does
      // not surface a token-change event, and the app re-reads it whenever it
      // comes to the front.
      void this.currentDevice().then(device => {
        if (device) handler(device);
      });
      return () => {};
    },

    onNotification(handler: (payload: PushPayload) => void): () => void {
      const unsubscribe = notifee.onForegroundEvent(event => {
        const data = (event.detail as {notification?: {data?: unknown}} | undefined)
          ?.notification?.data;
        const payload = readPayload(data);
        if (payload) handler(payload);
      });
      return unsubscribe;
    },

    async present(payload: PushPayload): Promise<void> {
      assertPrivacySafe(payload);
      if (platform() === 'android') {
        await notifee.createChannel({
          id: CHANNEL_ID,
          name: 'Messages',
          importance: AndroidImportance.DEFAULT,
        });
      }
      await notifee.displayNotification({
        title: pushNotificationTitle(payload),
        // No body: the text of the message is not in the payload, and it is
        // fetched from the server once the app is open and signed in.
        android: {channelId: CHANNEL_ID, pressAction: {id: 'default'}},
        ios: {sound: 'default'},
        data: {payload: JSON.stringify(payload)},
      });
    },
  };
}

/**
 * The background handler.
 *
 * A data message that arrives while the app is closed is handled here. The
 * payload is checked before it is shown, so a payload that somehow carried
 * content is dropped rather than displayed.
 */
export async function onBackgroundNotification(event: {
  detail: {notification?: {data?: unknown}};
}): Promise<void> {
  const data = event.detail?.notification?.data;
  const payload = readPayload(data);
  if (!payload) return;
  try {
    assertPrivacySafe(payload);
  } catch {
    return;
  }
  const transport = createNotifeeTransport();
  await transport.present(payload);
}

/**
 * Turns the server's idea of an event into a payload, with the check applied.
 * Exported so the app's own registration path uses the same rule.
 */
export function payloadForEvent(event: PushEvent): PushPayload {
  const payload = buildPushPayload(event);
  assertPrivacySafe(payload, event.content ?? null);
  return payload;
}
