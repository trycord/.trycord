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
import {useTheme} from '../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'TwoFactor'>;

type Step = 'code' | 'password' | 'secret' | 'recovery';

/**
 * The second factor.
 *
 * Two situations share this screen. A sign-in that stopped at the second
 * factor needs the code from the authenticator, and an instance that asks
 * every account for a second factor needs one set up. The first thing asked
 * for is the password in the second case and the code in the first, and the
 * screen says which one it is waiting for.
 */
export function TwoFactorScreen({navigation, route}: Props): React.JSX.Element {
  const theme = useTheme();
  const {completeTwoFactor, api, signOut} = useSession();
  const mode = route.params?.mode ?? 'challenge';

  const [step, setStep] = useState<Step>(mode === 'enrol' ? 'password' : 'code');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCode(): Promise<void> {
    const trimmed = code.trim();
    if (!trimmed) {
      setError('Enter the code from your authenticator.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'enrol') {
        const outcome = await endpoints.twoFactorEnable(api, password, trimmed);
        setRecoveryCodes(outcome.recoveryCodes);
        setStep('recovery');
        return;
      }
      const challengeToken = route.params?.challengeToken;
      if (!challengeToken) {
        setError('This sign-in attempt is no longer valid. Sign in again.');
        return;
      }
      await completeTwoFactor(challengeToken, trimmed);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(): Promise<void> {
    if (!password) {
      setError('Enter your password.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const outcome = await endpoints.twoFactorSetup(api, password);
      setSecret(outcome.secret);
      setStep('secret');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function leave(): Promise<void> {
    await signOut();
    navigation.reset({index: 0, routes: [{name: 'SignIn'}]});
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
            <AppText variant="display">
              {step === 'recovery' ? 'Save these now' : 'Two-step sign-in'}
            </AppText>
            <AppText variant="body" tone="muted">
              {step === 'password'
                ? 'This instance asks every account for a second factor. Confirm your password to set one up.'
                : step === 'secret'
                  ? 'Add this secret to your authenticator, then enter the code it shows.'
                  : step === 'recovery'
                    ? 'Each of these signs you in once if you lose your authenticator.'
                    : 'Enter the code from your authenticator to finish signing in.'}
            </AppText>
          </View>

          {step === 'password' ? (
            <TextField
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoComplete="current-password"
              testID="twofactor-password"
            />
          ) : null}

          {step === 'secret' ? (
            <View
              style={[
                styles.secret,
                {
                  backgroundColor: theme.semantic.panel2,
                  borderColor: theme.semantic.line,
                  borderRadius: theme.radii.md,
                },
              ]}>
              <AppText variant="title" style={styles.secretText}>
                {secret}
              </AppText>
            </View>
          ) : null}

          {step === 'code' || step === 'secret' ? (
            <TextField
              label="Code from your app"
              value={code}
              onChangeText={setCode}
              placeholder="000000"
              keyboardType="number-pad"
              inputMode="numeric"
              maxFontSizeMultiplier={1.6}
              testID="twofactor-code"
            />
          ) : null}

          {step === 'recovery' ? (
            <View style={styles.codes}>
              {recoveryCodes.map(value => (
                <AppText key={value} variant="body" style={styles.code}>
                  {value}
                </AppText>
              ))}
            </View>
          ) : null}

          {error ? (
            <AppText
              variant="body"
              tone="danger"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite">
              {error}
            </AppText>
          ) : null}

          {step === 'password' ? (
            <Button
              label="Continue"
              onPress={() => void submitPassword()}
              busy={busy}
              testID="twofactor-continue"
            />
          ) : null}

          {step === 'code' || step === 'secret' ? (
            <Button
              label={step === 'secret' ? 'Turn on two-step sign-in' : 'Sign in'}
              onPress={() => void submitCode()}
              busy={busy}
              testID="twofactor-submit"
            />
          ) : null}

          {step === 'recovery' ? (
            <Button label="Sign in again" onPress={() => void leave()} testID="twofactor-done" />
          ) : null}

          {step !== 'recovery' ? (
            <Button
              label="Sign out"
              variant="ghost"
              onPress={() => void leave()}
              testID="twofactor-signout"
            />
          ) : null}
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
  secret: {
    padding: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  secretText: {
    letterSpacing: 2,
  },
  codes: {
    gap: 6,
  },
  code: {
    letterSpacing: 1,
  },
});
