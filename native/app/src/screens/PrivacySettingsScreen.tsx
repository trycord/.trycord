import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {PrivacySettings} from '../api/types';
import {AppText, ErrorNotice, ListRow, Screen, Section, SwitchRow} from '../components';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';

const DM_CHOICES: {value: PrivacySettings['allowDmsFrom']; label: string}[] = [
  {value: 'anyone', label: 'Anyone'},
  {value: 'friends', label: 'Friends'},
  {value: 'nobody', label: 'Nobody'},
];

const REQUEST_CHOICES: {value: PrivacySettings['allowFriendRequests']; label: string}[] = [
  {value: 'anyone', label: 'Anyone'},
  {value: 'friends', label: 'Friends'},
  {value: 'nobody', label: 'Nobody'},
];

/**
 * Privacy.
 *
 * Who may reach this account, and what this account shows. A choice is saved
 * as it is made, so nothing is lost by leaving the screen.
 */
export function PrivacySettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {api} = useSession();

  const [settings, setSettings] = useState<PrivacySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const loaded = await endpoints.privacySettings(api);
      setSettings(loaded);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function update(patch: Partial<PrivacySettings>): Promise<void> {
    const previous = settings;
    if (previous) setSettings({...previous, ...patch});
    try {
      const saved = await endpoints.savePrivacySettings(api, patch);
      setSettings(saved);
      setNotice('Saved.');
      setError(null);
    } catch (caught) {
      if (previous) setSettings(previous);
      setError(describeError(caught));
    }
  }

  if (!settings) {
    return (
      <Screen>
        <View style={[styles.padded, {padding: theme.spacing[4]}]}>
          {error ? (
            <ErrorNotice message={error} onRetry={() => void load()} />
          ) : (
            <AppText variant="body" tone="muted">
              Loading…
            </AppText>
          )}
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

        <Section title="Direct messages">
          {DM_CHOICES.map(choice => (
            <ListRow
              key={choice.value}
              title={choice.label}
              icon="message"
              selected={settings.allowDmsFrom === choice.value}
              onPress={() => void update({allowDmsFrom: choice.value})}
              accessibilityHint="Who may start a conversation with you"
            />
          ))}
        </Section>

        <Section title="Friend requests">
          {REQUEST_CHOICES.map(choice => (
            <ListRow
              key={choice.value}
              title={choice.label}
              icon="user-plus"
              selected={settings.allowFriendRequests === choice.value}
              onPress={() => void update({allowFriendRequests: choice.value})}
              accessibilityHint="Who may ask to be a friend"
            />
          ))}
        </Section>

        <Section title="What others see">
          <SwitchRow
            title="Show when you are online"
            value={settings.showOnline}
            onValueChange={value => void update({showOnline: value})}
          />
          <SwitchRow
            title="Show that you have read a message"
            value={settings.showReadReceipts}
            onValueChange={value => void update({showReadReceipts: value})}
          />
          <SwitchRow
            title="Let people find you in search"
            value={settings.allowSearch}
            onValueChange={value => void update({allowSearch: value})}
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
});
