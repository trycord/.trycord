import React, {useCallback, useEffect, useState} from 'react';
import {FlatList, RefreshControl, StyleSheet, View} from 'react-native';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {Conversation} from '../api/types';
import {EmptyState, ErrorNotice, ListRow, Screen} from '../components';
import {RootParamList} from '../navigation/types';
import {REALTIME_EVENTS} from '../realtime/socket';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';
import {preview, relativeTime} from '../util/format';

/**
 * The conversations.
 *
 * The list of direct conversations, refreshed when it comes to the front and
 * when a message arrives on the socket. The unread count is on the row, so
 * the state of a conversation does not have to be inferred from the text.
 */
export function ConversationsScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParamList>>();
  const {api, realtime} = useSession();

  const [rows, setRows] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'first' | 'refresh') => {
      if (mode === 'first') setLoading(true);
      try {
        const list = await endpoints.conversations(api);
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

  useEffect(() => {
    const off = realtime.on(REALTIME_EVENTS.DM_MESSAGE, () => {
      void load('refresh');
    });
    return off;
  }, [realtime, load]);

  function open(conversation: Conversation): void {
    const title = conversation.peer
      ? conversation.peer.displayName || conversation.peer.username
      : 'Conversation';
    navigation.navigate('Conversation', {
      kind: 'dm',
      targetId: conversation.id,
      title,
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
              icon="message"
              title="No conversations yet"
              text="When someone messages you, the conversation appears here."
            />
          )
        }
        renderItem={({item}) => {
          const peer = item.peer;
          const title = peer
            ? peer.displayName || peer.username
            : 'Conversation';
          const last = item.messages.length ? item.messages[item.messages.length - 1] : null;
          return (
            <ListRow
              title={title}
              subtitle={last ? preview(last.content, 60) : null}
              detail={
                item.unreadCount
                  ? String(item.unreadCount)
                  : item.lastMessageAt
                    ? relativeTime(item.lastMessageAt)
                    : null
              }
              icon="message"
              onPress={() => open(item)}
              accessibilityHint="Opens the conversation"
            />
          );
        }}
        ItemSeparatorComponent={() => (
          <View
            style={{
              height: StyleSheet.hairlineWidth,
              backgroundColor: theme.semantic.line,
              marginLeft: theme.spacing[4] + 24 + 12,
            }}
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
