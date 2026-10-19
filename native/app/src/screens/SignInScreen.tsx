import React, {useState} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {describeError} from '../api/errors';
import {AppText, Button, Screen, TextField} from '../components';
import {AuthStackParamList} from '../navigation/types';
import {useSession} from '../session/SessionProvider';
import {DEFAULT_INSTANCE_URL} from '../session/instance';
import {useTheme} from '../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'SignIn'>;

/**
 * Signing in.
 *
 * The instance is named at the top, because a session belongs to an instance
 * and a person who is not sure which one they are signing in to will sign in
 * to the wrong one.
 */
export function SignInScreen({navigation, route}: Props): React.JSX.Element {
  const theme = useTheme();
  const {signIn, instance} = useSession();
  const instanceUrl = instance?.url ?? route.params?.instanceUrl ?? DEFAULT_INSTANCE_URL;

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    if (!username.trim() || !password) {
      setError('Enter your username and your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await signIn(instanceUrl, username.trim(), password);
      if (outcome.status === 'mfa-required') {
        navigation.navigate('TwoFactor', {
          mode: 'challenge',
          challengeToken: outcome.challengeToken,
          expiresInSeconds: outcome.expiresInSeconds,
          username: username.trim(),
          instanceUrl,
        });
      }
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
            <AppText variant="display">Welcome back</AppText>
            <AppText variant="body" tone="muted">
              Sign in to your communities.
            </AppText>
          </View>

          <View style={styles.instance}>
            <AppText variant="meta" tone="faint">
              INSTANCE
            </AppText>
            <AppText variant="meta" numberOfLines={1}>
              {instanceUrl}
            </AppText>
          </View>

          <TextField
            label="Username or email"
            value={username}
            onChangeText={setUsername}
            placeholder="your name"
            autoCapitalize="none"
            autoComplete="username"
            textContentType="username"
            testID="signin-username"
          />

          <TextField
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="Your password"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={() => void submit()}
            testID="signin-password"
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

          <Button
            label="Sign in"
            onPress={() => void submit()}
            busy={busy}
            testID="signin-submit"
          />

          <View style={styles.links}>
            <AppText variant="meta" tone="muted">
              New here?{' '}
              <AppText
                variant="meta"
                tone="brand"
                onPress={() => navigation.navigate('Register', {instanceUrl})}
                accessibilityRole="link">
                Create an account
              </AppText>
            </AppText>
            <AppText
              variant="meta"
              tone="brand"
              onPress={() => navigation.navigate('ForgotPassword', {instanceUrl})}
              accessibilityRole="link">
              Forgot your password?
            </AppText>
            <AppText
              variant="meta"
              tone="brand"
              onPress={() => navigation.navigate('InstancePicker')}
              accessibilityRole="link">
              Use another instance
            </AppText>
          </View>
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
  instance: {
    gap: 2,
  },
  links: {
    gap: 8,
    alignItems: 'flex-start',
  },
});
