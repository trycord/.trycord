import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {AppText, Button, ListRow, Screen, TextField} from '../components';
import {AuthStackParamList} from '../navigation/types';
import {useSession} from '../session/SessionProvider';
import {
  createInstanceClient,
  DEFAULT_INSTANCE_URL,
  normalizeInstanceUrl,
  probeInstance,
} from '../session/instance';
import {useTheme} from '../theme';

type Props = NativeStackScreenProps<AuthStackParamList, 'InstancePicker'>;

/**
 * Choosing an instance.
 *
 * An address typed by hand is checked against the instance itself before it
 * is accepted, so a mistyped address is refused here rather than at the first
 * sign-in. The session of the instance being left is forgotten, so nothing
 * signed in there travels along.
 */
export function InstancePickerScreen({navigation}: Props): React.JSX.Element {
  const theme = useTheme();
  const {instance, useInstance, knownInstances} = useSession();

  const [address, setAddress] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [known, setKnown] = useState<string[]>([]);
  const [listing, setListing] = useState<{name: string; url: string}[]>([]);

  const currentUrl = instance?.url ?? DEFAULT_INSTANCE_URL;

  const loadListing = useCallback(async () => {
    try {
      const entries = await endpoints.discoverInstances(
        createInstanceClient(currentUrl),
      );
      setListing(entries.map(entry => ({name: entry.name, url: entry.url})));
    } catch {
      setListing([]);
    }
  }, [currentUrl]);

  useEffect(() => {
    void loadListing();
    void knownInstances().then(setKnown);
  }, [loadListing, knownInstances]);

  async function choose(url: string): Promise<void> {
    const target = normalizeInstanceUrl(url);
    if (!target) {
      setNote('Enter a full http(s) address, for example https://api.example.com');
      return;
    }
    setBusy(true);
    setNote('Checking that address…');
    try {
      const info = await probeInstance(target);
      await useInstance(target, info.name);
      setNote(`Now using ${info.name}`);
      navigation.navigate('SignIn', {instanceUrl: target});
    } catch (caught) {
      setNote(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {padding: theme.spacing[6], gap: theme.spacing[5]},
        ]}
        keyboardShouldPersistTaps="handled">
        <View style={styles.head}>
          <AppText variant="display">Choose an instance</AppText>
          <AppText variant="body" tone="muted">
            Trycord instances are run independently. Pick one, or give the
            address of one you run yourself.
          </AppText>
        </View>

        <View style={styles.current}>
          <AppText variant="label" tone="faint">
            THIS ONE
          </AppText>
          <AppText variant="body" numberOfLines={1}>
            {currentUrl}
          </AppText>
        </View>

        <View style={styles.block}>
          <TextField
            label="Address of another instance"
            value={address}
            onChangeText={setAddress}
            placeholder="https://trycord.example.com"
            keyboardType="url"
            autoCapitalize="none"
            autoComplete="off"
            testID="instance-address"
          />
          {note ? (
            <AppText variant="meta" tone="muted" accessibilityLiveRegion="polite">
              {note}
            </AppText>
          ) : null}
          <Button
            label="Connect"
            onPress={() => void choose(address)}
            busy={busy}
            testID="instance-connect"
          />
        </View>

        {listing.length ? (
          <View style={styles.block}>
            <AppText variant="label" tone="faint" accessibilityRole="header">
              KNOWN INSTANCES
            </AppText>
            {listing.map(entry => (
              <ListRow
                key={entry.url}
                title={entry.name}
                subtitle={entry.url}
                icon="globe"
                onPress={() => void choose(entry.url)}
                accessibilityHint="Switches to this instance"
              />
            ))}
          </View>
        ) : null}

        {known.length ? (
          <View style={styles.block}>
            <AppText variant="label" tone="faint" accessibilityRole="header">
              RECENTLY USED
            </AppText>
            {known.map(url => (
              <ListRow
                key={url}
                title={url}
                icon="clock"
                onPress={() => void choose(url)}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: 20,
  },
  head: {
    gap: 6,
  },
  current: {
    gap: 2,
  },
  block: {
    gap: 8,
  },
});
