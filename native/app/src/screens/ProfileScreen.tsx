import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {User} from '../api/types';
import {AppText, Avatar, ErrorNotice, Screen} from '../components';
import {AppStackParamList} from '../navigation/types';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';
import {fullTimestamp} from '../util/format';

type Props = NativeStackScreenProps<AppStackParamList, 'Profile'>;

/**
 * A person's profile.
 *
 * The public shape of an account: the name, the handle, what they have
 * written about themselves and when they joined. Nothing here is a control
 * that changes the account - the profile is read-only, and the account's own
 * settings live in Settings.
 */
export function ProfileScreen({route}: Props): React.JSX.Element {
  const theme = useTheme();
  const {userId} = route.params;
  const {api} = useSession();

  const [person, setPerson] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const found = await endpoints.userProfile(api, userId);
      setPerson(found);
      setError(found ? null : 'That profile could not be found.');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [api, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <Screen>
        <View style={[styles.padded, {padding: theme.spacing[4]}]}>
          <ErrorNotice message={error} onRetry={() => void load()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {padding: theme.spacing[6], gap: theme.spacing[4]},
        ]}>
        <View style={styles.head}>
          <Avatar
            name={person?.displayName || person?.username || '?'}
            url={person?.avatarUrl}
            size={72}
          />
          <View style={styles.names}>
            <AppText variant="title">
              {person?.displayName || person?.username || 'Unknown'}
            </AppText>
            <AppText variant="body" tone="muted">
              {person?.username ? `@${person.username}` : ''}
            </AppText>
          </View>
        </View>

        {person?.statusText ? (
          <AppText variant="body">{person.statusText}</AppText>
        ) : null}

        {person?.bio ? (
          <AppText variant="body" tone="muted">
            {person.bio}
          </AppText>
        ) : null}

        {person?.createdAt ? (
          <AppText variant="meta" tone="faint">
            Joined {fullTimestamp(person.createdAt)}
          </AppText>
        ) : null}

        {loading ? (
          <AppText variant="meta" tone="faint">
            Loading…
          </AppText>
        ) : null}
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
    gap: 12,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  names: {
    flex: 1,
    gap: 2,
  },
});
