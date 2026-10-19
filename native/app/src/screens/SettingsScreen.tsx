import React, {useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import {AppText, Button, ListRow, Screen, Section} from '../components';
import {RootParamList} from '../navigation/types';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';
import {fullTimestamp} from '../util/format';

/**
 * The settings.
 *
 * The four groups the product has - account, security, notifications and
 * privacy - each behind its own screen, so the settings page is a table of
 * contents rather than a wall of switches.
 */
export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const {user, instance, signOut, realtimeStatus} = useSession();
  const [busy, setBusy] = useState(false);

  async function leave(): Promise<void> {
    setBusy(true);
    try {
      await signOut();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {padding: theme.spacing[4], gap: theme.spacing[5]},
        ]}>
        <View style={styles.head}>
          <AppText variant="title">{user?.displayName || user?.username || 'Signed in'}</AppText>
          <AppText variant="meta" tone="muted">
            {user?.username ? `@${user.username}` : ''}
          </AppText>
          {user?.email ? (
            <AppText variant="meta" tone="faint">
              {user.email}
              {user.emailVerified ? ' · verified' : ' · not verified'}
            </AppText>
          ) : null}
        </View>

        <Section title="Account">
          <ListRow
            title="Account"
            icon="user"
            onPress={() => navigation.navigate('AccountSettings')}
            accessibilityHint="Your name, status and biography"
          />
          <ListRow
            title="Security"
            icon="shield"
            onPress={() => navigation.navigate('SecuritySettings')}
            accessibilityHint="Password, two-step sign-in and signed-in devices"
          />
          <ListRow
            title="Notifications"
            icon="bell"
            onPress={() => navigation.navigate('NotificationSettings')}
            accessibilityHint="What you are told about, and when"
          />
          <ListRow
            title="Privacy"
            icon="lock"
            onPress={() => navigation.navigate('PrivacySettings')}
            accessibilityHint="Who can reach you, and what they can see"
          />
        </Section>

        <Section title="Instance">
          <ListRow title={instance?.name || instance?.url || 'Instance'} icon="globe" />
          <ListRow
            title={instance?.url || ''}
            subtitle="The instance this session belongs to"
            icon="link"
          />
          <ListRow
            title={realtimeStatus === 'online' ? 'Live connection' : 'Reconnecting'}
            icon={realtimeStatus === 'online' ? 'activity' : 'wifi-off'}
          />
        </Section>

        {user?.createdAt ? (
          <AppText variant="meta" tone="faint">
            Account created {fullTimestamp(user.createdAt)}
          </AppText>
        ) : null}

        <Button
          label="Sign out"
          variant="danger"
          onPress={() => void leave()}
          busy={busy}
          testID="settings-signout"
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 20,
  },
  head: {
    gap: 2,
    paddingHorizontal: 4,
  },
});
