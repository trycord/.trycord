import React, {useCallback, useEffect, useState} from 'react';
import {FlatList, StyleSheet, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from '@react-navigation/native-stack';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {Member} from '../api/types';
import {
  EmptyState,
  ErrorNotice,
  ListRow,
  Screen,
  TextField,
} from '../components';
import {AppStackParamList, RootParamList} from '../navigation/types';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';

type Props = NativeStackScreenProps<AppStackParamList, 'MemberList'>;

/**
 * The members of a community.
 *
 * The list is asked for again when the search changes, and the search is
 * carried to the server rather than done on the phone, so a community with
 * more members than fit on screen still works.
 */
export function MemberListScreen({route}: Props): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const {serverId} = route.params;
  const {api} = useSession();

  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (search: string) => {
      setLoading(true);
      try {
        const list = await endpoints.members(api, serverId, {
          limit: 50,
          q: search.trim() || undefined,
        });
        setRows(list);
        setError(null);
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setLoading(false);
      }
    },
    [api, serverId],
  );

  useEffect(() => {
    void load(query);
  }, [load, query]);

  if (error && !rows.length) {
    return (
      <Screen>
        <View style={[styles.padded, {padding: theme.spacing[4]}]}>
          <ErrorNotice message={error} onRetry={() => void load(query)} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={[styles.search, {padding: theme.spacing[4]}]}>
        <TextField
          label="Search members"
          value={query}
          onChangeText={setQuery}
          placeholder="A name or a handle"
          autoCapitalize="none"
          autoComplete="off"
          testID="members-search"
        />
      </View>
      <FlatList
        data={rows}
        keyExtractor={item => item.user.id}
        contentContainerStyle={rows.length ? undefined : styles.empty}
        ListEmptyComponent={
          loading ? null : (
            <EmptyState
              icon="users"
              title="Nobody found"
              text="Try another name."
            />
          )
        }
        renderItem={({item}) => (
          <ListRow
            title={item.user.displayName || item.user.username}
            subtitle={item.user.username}
            icon="user"
            onPress={() =>
              navigation.navigate('Profile', {
                userId: item.user.id,
                title: item.user.displayName || item.user.username,
              })
            }
            accessibilityHint="Opens this person's profile"
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  padded: {
    flex: 1,
    justifyContent: 'center',
  },
  empty: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  search: {
    paddingBottom: 0,
  },
});
