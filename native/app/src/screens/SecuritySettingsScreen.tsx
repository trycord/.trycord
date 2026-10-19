import React, {useCallback, useEffect, useState} from 'react';
import {KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View} from 'react-native';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {DeviceSession} from '../api/types';
import {
  AppText,
  Button,
  ErrorNotice,
  ListRow,
  Screen,
  Section,
  TextField,
} from '../components';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';
import {fullTimestamp} from '../util/format';

/**
 * Security.
 *
 * The password, the second factor, and the list of devices that are signed
 * in. The devices are the account's own list, so a session can be ended from
 * here and not only by signing out of this one.
 */
export function SecuritySettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {api} = useSession();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [twoFactorOn, setTwoFactorOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [deviceSessions, factor] = await Promise.all([
        endpoints.sessions(api),
        endpoints.twoFactorStatus(api),
      ]);
      setSessions(deviceSessions);
      setTwoFactorOn(factor.enabled);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changePassword(): Promise<void> {
    if (!currentPassword) {
      setError('Enter your current password.');
      return;
    }
    if (newPassword.length < 8) {
      setError('A new password is at least 8 characters.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await endpoints.changePassword(api, currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setNotice('Password changed.');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function signOutOthers(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await endpoints.revokeOtherSessions(api);
      await load();
      setNotice('Other devices signed out.');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {padding: theme.spacing[4], gap: theme.spacing[4]},
          ]}
          keyboardShouldPersistTaps="handled">
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

          <Section title="Password">
            <View style={[styles.form, {padding: theme.spacing[4], gap: theme.spacing[3]}]}>
              <TextField
                label="Current password"
                value={currentPassword}
                onChangeText={setCurrentPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="current-password"
                testID="security-current-password"
              />
              <TextField
                label="New password"
                value={newPassword}
                onChangeText={setNewPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="new-password"
                textContentType="newPassword"
                testID="security-new-password"
              />
              <Button
                label="Change password"
                onPress={() => void changePassword()}
                busy={saving}
                testID="security-change-password"
              />
            </View>
          </Section>

          <Section title="Two-step sign-in">
            <ListRow
              title={
                twoFactorOn === null
                  ? 'Checking…'
                  : twoFactorOn
                    ? 'Turned on'
                    : 'Turned off'
              }
              subtitle="A code from your authenticator, in addition to your password"
              icon="shield"
            />
          </Section>

          <Section title="Signed-in devices">
            {sessions.length ? (
              sessions.map(session => (
                <ListRow
                  key={session.jti}
                  title={session.userAgent || 'A device'}
                  subtitle={
                    session.lastUsedAt
                      ? `Last used ${fullTimestamp(session.lastUsedAt)}`
                      : undefined
                  }
                  icon="monitor"
                />
              ))
            ) : (
              <View style={[styles.row, {padding: theme.spacing[4]}]}>
                <AppText variant="meta" tone="faint">
                  No other devices are signed in.
                </AppText>
              </View>
            )}
            <View style={[styles.row, {padding: theme.spacing[4]}]}>
              <Button
                label="Sign out other devices"
                variant="secondary"
                onPress={() => void signOutOthers()}
                busy={busy}
                testID="security-revoke-others"
              />
            </View>
          </Section>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    gap: 16,
  },
  form: {
    gap: 12,
  },
  row: {
    gap: 4,
  },
});
