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

type Props = NativeStackScreenProps<AuthStackParamList, 'ForgotPassword'>;

/**
 * Asking for a reset message.
 *
 * The answer is the same whether or not the account exists, and it is the
 * same either way here: nothing on this screen says whether an address is
 * registered.
 */
export function ForgotPasswordScreen({navigation, route}: Props): React.JSX.Element {
  const theme = useTheme();
  const {instance} = useSession();
  const instanceUrl = instance?.url ?? route.params?.instanceUrl ?? DEFAULT_INSTANCE_URL;

  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    const address = email.trim();
    if (!address) {
      setError('Enter the address on the account.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await endpoints.forgotPassword(createInstanceClient(instanceUrl), address);
      setSent(true);
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
            <AppText variant="display">Reset your password</AppText>
            <AppText variant="body" tone="muted">
              {sent
                ? 'If that address exists, a reset link is on its way.'
                : 'We will send a link to the address on the account.'}
            </AppText>
          </View>

          {sent ? null : (
            <TextField
              label="Email address"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              textContentType="emailAddress"
              testID="forgot-email"
            />
          )}

          {error ? (
            <AppText
              variant="body"
              tone="danger"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}

          {sent ? null : (
            <Button
              label="Send reset link"
              onPress={() => void submit()}
              busy={busy}
              testID="forgot-submit"
            />
          )}

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
