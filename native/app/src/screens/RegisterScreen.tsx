import React, {useEffect, useState} from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {
  endpoints,
  isStaleLegalError,
  legalVersions,
  withLegalVersions,
} from '../api';
import {describeError, isApiError} from '../api/errors';
import {LegalInfo} from '../api/types';
import {AppText, Button, Icon, Screen, TextField} from '../components';
import {AuthStackParamList} from '../navigation/types';
import {useSession} from '../session/SessionProvider';
import {createInstanceClient, DEFAULT_INSTANCE_URL} from '../session/instance';
import {useTheme} from '../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'Register'>;

const USERNAME_PATTERN = /^[A-Za-z0-9_.]{2,32}$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72;

/**
 * Creating an account.
 *
 * The server refuses a registration whose accepted versions of the Terms and
 * the Privacy Policy do not match the versions in force, so the versions are
 * read from the instance and shown, and the exact ones that were shown are
 * the ones that are sent.
 */
export function RegisterScreen({navigation, route}: Props): React.JSX.Element {
  const theme = useTheme();
  const {register, instance} = useSession();
  const instanceUrl = instance?.url ?? route.params?.instanceUrl ?? DEFAULT_INSTANCE_URL;

  const [legal, setLegal] = useState<LegalInfo | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await endpoints.legal(createInstanceClient(instanceUrl));
        if (!cancelled) setLegal(info);
      } catch {
        if (!cancelled) setLegal(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instanceUrl]);

  async function submit(): Promise<void> {
    const name = username.trim();
    if (!USERNAME_PATTERN.test(name)) {
      setError('A username is 2 to 32 characters: letters, numbers, _ or .');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`A password is at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (passwordBytes(password) > MAX_PASSWORD_BYTES) {
      setError(`A password is at most ${MAX_PASSWORD_BYTES} bytes.`);
      return;
    }
    if (!accepted) {
      setError('Accept the Terms of Service and the Privacy Policy to continue.');
      return;
    }
    if (!legal) {
      // The versions are never guessed. A registration sent without them is
      // refused by the server, and the reader is told what to do instead.
      setError(
        'This instance did not say which terms are in force. Check your connection and try again.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = withLegalVersions(
        {
          username: name,
          password,
          displayName: displayName.trim() || undefined,
          email: email.trim() || undefined,
        },
        legal,
      );
      const outcome = await register(instanceUrl, {
        username: body.username,
        password: body.password,
        displayName: body.displayName,
        email: body.email,
        termsVersion: body.termsVersion as string,
        privacyVersion: body.privacyVersion as string,
      });
      if (!outcome.signedIn) {
        setError(
          'The account was created. Check your email to continue, then sign in.',
        );
      }
    } catch (caught) {
      if (isStaleLegalError(caught)) {
        setError(
          'The Terms or Privacy Policy changed since this screen was opened. Read the current documents and accept them again.',
        );
      } else if (isApiError(caught) && caught.code === 'REGISTRATION_DISABLED') {
        setError('This instance is not accepting new accounts.');
      } else {
        setError(describeError(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  const versions = legalVersions(legal);
  const acceptanceText = versions
    ? `I accept the Terms of Service (version ${versions.termsVersion}` +
      `${legal?.updated ? `, updated ${legal.updated}` : ''}) and the Privacy Policy ` +
      `(version ${versions.privacyVersion}).`
    : 'I accept the Terms of Service and the Privacy Policy. This instance has not said which version is in force.';

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
            <AppText variant="display">Create your account</AppText>
            <AppText variant="body" tone="muted">
              You are joining {instanceUrl}
            </AppText>
          </View>

          <TextField
            label="Username"
            value={username}
            onChangeText={setUsername}
            placeholder="yourname"
            autoCapitalize="none"
            autoComplete="username"
            testID="register-username"
          />
          <TextField
            label="Display name"
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="How your name appears"
            autoComplete="nickname"
            testID="register-displayname"
          />
          <TextField
            label="Email (optional)"
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="emailAddress"
            testID="register-email"
          />
          <TextField
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="At least 8 characters"
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            testID="register-password"
          />

          <Pressable
            onPress={() => setAccepted(value => !value)}
            accessibilityRole="checkbox"
            accessibilityState={{checked: accepted}}
            accessibilityLabel={acceptanceText}
            style={styles.accept}>
            <View
              style={[
                styles.box,
                {
                  borderColor: accepted ? theme.semantic.brand : theme.semantic.line2,
                  backgroundColor: accepted
                    ? theme.semantic.brandFill
                    : 'transparent',
                  borderRadius: theme.radii.sm,
                },
              ]}>
              {accepted ? (
                <Icon name="check" size={16} color="#FFFFFF" />
              ) : null}
            </View>
            <AppText variant="meta" tone="muted" style={styles.acceptText}>
              {acceptanceText}
            </AppText>
          </Pressable>

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
            label="Create account"
            onPress={() => void submit()}
            busy={busy}
            testID="register-submit"
          />

          <AppText variant="meta" tone="muted">
            Already have an account?{' '}
            <AppText
              variant="meta"
              tone="brand"
              onPress={() => navigation.navigate('SignIn', {instanceUrl})}
              accessibilityRole="link">
              Sign in
            </AppText>
          </AppText>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function passwordBytes(value: string): number {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) total += 1;
    else if (code < 0x800) total += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      total += 4;
      index += 1;
    } else total += 3;
  }
  return total;
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
  accept: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  box: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  acceptText: {
    flex: 1,
  },
});
