import React, {useCallback, useState} from 'react';
import {FlatList, RefreshControl, StyleSheet, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {Community} from '../api/types';
import {EmptyState, ErrorNotice, ListRow, Screen} from '../components';
import {RootParamList} from '../navigation/types';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';

/**
 * The communities.
 *
 * The list the reader belongs to. A community is opened by name, because a
 * name is what a person can read out loud, and the identifier is what the
 * routes use.
 */
export function CommunitiesScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const {api} = useSession();

  const [rows, setRows] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'first' | 'refresh') => {
      if (mode === 'first') setLoading(true);
      try {
        const list = await endpoints.communities(api);
        setRows(list);
        setError(null);
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [api],
  );

  useFocusEffect(
    useCallback(() => {
      void load('first');
    }, [load]),
  );

  function open(community: Community): void {
    navigation.navigate('CommunityChannels', {
      serverId: community.id,
      title: community.name,
    });
  }

  if (error && !rows.length) {
    return (
      <Screen>
        <View style={[styles.padded, {padding: theme.spacing[4]}]}>
          <ErrorNotice message={error} onRetry={() => void load('first')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <FlatList
        data={rows}
        keyExtractor={item => item.id}
        contentContainerStyle={rows.length ? undefined : styles.empty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load('refresh');
            }}
            tintColor={theme.semantic.brand}
          />
        }
        ListEmptyComponent={
          loading ? null : (
            <EmptyState
              icon="server"
              title="No communities yet"
              text="Communities you join appear here."
            />
          )
        }
        renderItem={({item}) => (
          <ListRow
            title={item.name}
            subtitle={item.description}
            detail={item.memberCount ? `${item.memberCount}` : null}
            icon="server"
            onPress={() => open(item)}
            accessibilityHint="Opens the channels in this community"
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
});
