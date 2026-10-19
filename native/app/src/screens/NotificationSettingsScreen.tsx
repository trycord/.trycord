import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {NotificationPrefs} from '../api/types';
import {AppText, ErrorNotice, Screen, Section, SwitchRow} from '../components';
import {
  createNotifeeTransport,
  registerDevice,
  registrationFor,
} from '../notifications';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';

/**
 * Notifications.
 *
 * What the app is told about, and whether it says anything while quiet hours
 * are on. Each switch is saved as it is flipped, so nothing is lost by
 * leaving the screen.
 */
export function NotificationSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {api, instance} = useSession();
  const transport = useMemo(() => createNotifeeTransport(), []);

  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pushOn, setPushOn] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await endpoints.notificationPreferences(api);
      setPrefs(loaded);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function update(patch: Partial<NotificationPrefs>): Promise<void> {
    const previous = prefs;
    if (previous) setPrefs({...previous, ...patch});
    try {
      const saved = await endpoints.saveNotificationPreferences(api, patch);
      setPrefs(saved);
      setNotice('Saved.');
      setError(null);
    } catch (caught) {
      if (previous) setPrefs(previous);
      setError(describeError(caught));
    }
  }

  async function enablePush(): Promise<void> {
    setPushBusy(true);
    setError(null);
    setNotice(null);
    try {
      const granted = await transport.requestPermission();
      if (!granted) {
        setError('Notifications are turned off for this app in the system settings.');
        return;
      }
      const device = await transport.currentDevice();
      if (!device) {
        setError('This device could not be registered for push notifications.');
        return;
      }
      const result = await registerDevice(
        api,
        registrationFor(device, instance?.origin ?? ''),
      );
      if (result.unsupported) {
        setError('This instance does not accept push registrations yet.');
        return;
      }
      setPushOn(true);
      setNotice('This device will be told about messages while the app is closed.');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setPushBusy(false);
    }
  }

  if (error && !prefs) {
    return (
      <Screen>
        <View style={[styles.padded, {padding: theme.spacing[4]}]}>
          <ErrorNotice message={error} onRetry={() => void load()} />
        </View>
      </Screen>
    );
  }

  if (!prefs) {
    return (
      <Screen>
        <View style={[styles.padded, {padding: theme.spacing[4]}]}>
          <AppText variant="body" tone="muted">
            Loading…
          </AppText>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {padding: theme.spacing[4], gap: theme.spacing[4]},
        ]}>
        {error ? <ErrorNotice message={error} /> : null}
        {notice ? (
          <AppText
            variant="meta"
            tone="success"
            accessibilityLiveRegion="polite"
            accessibilityRole="alert">
            {notice}
          </AppText>
        ) : null}

        <Section title="Tell me about">
          <SwitchRow
            title="Direct messages"
            subtitle="When someone messages you"
            value={prefs.notifyOnDm}
            onValueChange={value => void update({notifyOnDm: value})}
          />
          <SwitchRow
            title="Mentions"
            subtitle="When someone mentions you"
            value={prefs.notifyOnMention}
            onValueChange={value => void update({notifyOnMention: value})}
          />
          <SwitchRow
            title="Replies"
            subtitle="When someone replies to you"
            value={prefs.notifyOnReply}
            onValueChange={value => void update({notifyOnReply: value})}
          />
          <SwitchRow
            title="Friend requests"
            subtitle="When someone asks to be a friend"
            value={prefs.notifyOnFriendRequest}
            onValueChange={value => void update({notifyOnFriendRequest: value})}
          />
        </Section>

        <Section
          title="Quiet hours"
          subtitle="Notifications are still recorded while quiet hours are on; they are just not raised.">
          <SwitchRow
            title="Keep quiet during quiet hours"
            value={prefs.quietHoursEnabled}
            onValueChange={value => void update({quietHoursEnabled: value})}
          />
          {prefs.quietHoursEnabled ? (
            <View style={[styles.row, {padding: theme.spacing[4]}]}>
              <AppText variant="meta" tone="muted">
                {prefs.quietHoursStart || 'Not set'} to {prefs.quietHoursEnd || 'Not set'}
              </AppText>
            </View>
          ) : null}
        </Section>

        <Section
          title="This device"
          subtitle="A push notification carries no message text. It says where to go, and the app fetches the rest once it is open.">
          <SwitchRow
            title="Push notifications on this device"
            subtitle={
              pushOn
                ? 'This device is registered with the instance'
                : 'Turn on to be told about messages while the app is closed'
            }
            value={pushOn}
            disabled={pushBusy}
            onValueChange={value => {
              if (value) {
                void enablePush();
                return;
              }
              setPushOn(false);
            }}
          />
        </Section>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  padded: {
    flex: 1,
    justifyContent: 'center',
  },
  content: {
    gap: 16,
  },
  row: {
    gap: 4,
  },
});
