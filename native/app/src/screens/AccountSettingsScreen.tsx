import React, {useEffect, useState} from 'react';
import {KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View} from 'react-native';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {AppText, Button, ErrorNotice, Screen, Section, TextField} from '../components';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';

/**
 * The account.
 *
 * The name, the status and the biography - the three things a person
 * changes about themselves. The address is shown but not changed here,
 * because changing it needs a confirmation at the address.
 */
export function AccountSettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const {api, user, refreshUser} = useSession();

  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [statusText, setStatusText] = useState(user?.statusText || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisplayName(user?.displayName || '');
    setStatusText(user?.statusText || '');
    setBio(user?.bio || '');
  }, [user]);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await endpoints.updateMe(api, {
        displayName: displayName.trim(),
        statusText: statusText.trim(),
        bio: bio.trim(),
      });
      await refreshUser();
      setNotice('Saved.');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setSaving(false);
    }
  }

  async function resendVerification(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await endpoints.resendVerificationEmail(api);
      setNotice('Verification message sent.');
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
          {error ? (
            <ErrorNotice message={error} />
          ) : null}
          {notice ? (
            <AppText
              variant="meta"
              tone="success"
              accessibilityLiveRegion="polite"
              accessibilityRole="alert">
              {notice}
            </AppText>
          ) : null}

          <TextField
            label="Display name"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="How your name appears"
            autoComplete="nickname"
            testID="account-displayname"
          />
          <TextField
            label="Status"
            value={statusText}
            onChangeText={setStatusText}
            placeholder="What you are up to"
            testID="account-status"
          />
          <TextField
            label="Biography"
            value={bio}
            onChangeText={setBio}
            placeholder="A little about you"
            multiline
            testID="account-bio"
          />

          <Button
            label="Save"
            onPress={() => void save()}
            busy={saving}
            testID="account-save"
          />

          <Section title="Address">
            <View style={[styles.row, {padding: theme.spacing[4]}]}>
              <AppText variant="body">
                {user?.email || 'No address on this account'}
              </AppText>
              {user?.email && !user.emailVerified ? (
                <AppText variant="meta" tone="faint">
                  This address has not been confirmed yet.
                </AppText>
              ) : null}
            </View>
            {user?.email && !user.emailVerified ? (
              <View style={[styles.row, {paddingHorizontal: theme.spacing[4]}]}>
                <Button
                  label="Send a new verification message"
                  variant="secondary"
                  onPress={() => void resendVerification()}
                  busy={busy}
                />
              </View>
            ) : null}
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
  row: {
    gap: 4,
  },
});
