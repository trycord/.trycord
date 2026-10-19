import React, {useState} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {AppText, Button, Screen, TextField} from '../components';
import {AuthStackParamList} from '../navigation/types';
import {useSession} from '../session/SessionProvider';
import {createInstanceClient, DEFAULT_INSTANCE_URL} from '../session/instance';
import {useTheme} from '../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'ResetPassword'>;

const MIN_PASSWORD_LENGTH = 8;

/**
 * Choosing a new password.
 *
 * The link that brought the reader here carries a one-use token. Setting the
 * password ends every session the account had, including the one that asked
 * for the reset - which is the point of a reset.
 *
 * When the account has a second factor, the answer is a challenge rather
 * than a session: proving control of the mailbox is not proving control of
 * the authenticator, so the factor still has to be presented.
 */
export function ResetPasswordScreen({navigation, route}: Props): React.JSX.Element {
  const theme = useTheme();
  const {instance} = useSession();
  const instanceUrl = instance?.url ?? route.params?.instanceUrl ?? DEFAULT_INSTANCE_URL;

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`A password is at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await endpoints.resetPassword(
        createInstanceClient(instanceUrl),
        route.params.token,
        password,
        confirm,
      );
      if ('mfaRequired' in outcome) {
        // The password is set; the sign-in still owes the second step.
        navigation.navigate('TwoFactor', {
          mode: 'challenge',
          challengeToken: outcome.challengeToken,
          expiresInSeconds: outcome.expiresInSeconds,
          instanceUrl,
        });
        return;
      }
      setNotice('Password set. Sign in with it.');
      navigation.navigate('SignIn', {instanceUrl});
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
            {padding: theme.spacing[6], gap: theme.spacing[4]},
          ]}
          keyboardShouldPersistTaps="handled">
          <View style={styles.head}>
            <AppText variant="display">Choose a new password</AppText>
            <AppText variant="body" tone="muted">
              Setting a new password signs every device out of this account.
            </AppText>
          </View>

          <TextField
            label="New password"
            value={password}
            onChangeText={setPassword}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            testID="reset-password"
          />
          <TextField
            label="Confirm new password"
            value={confirm}
            onChangeText={setConfirm}
            placeholder="Type it again"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            testID="reset-confirm"
          />

          {error ? (
            <AppText
              variant="body"
              tone="danger"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}

          {notice ? (
            <AppText
              variant="body"
              tone="success"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite">
              {notice}
            </AppText>
          ) : null}

          <Button
            label="Set new password"
            onPress={() => void submit()}
            busy={busy}
            testID="reset-submit"
          />

          <AppText
            variant="meta"
            tone="brand"
            onPress={() => navigation.navigate('SignIn', {instanceUrl})}
            accessibilityRole="link">
            Back to sign in
          </AppText>
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
    flexGrow: 1,
    justifyContent: 'center',
  },
  head: {
    gap: 6,
  },
});
