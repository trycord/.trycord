import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {normalizeMessage} from '../api/normalize';
import {Message} from '../api/types';
import {
  Composer,
  ConnectionBanner,
  EmptyState,
  ErrorNotice,
  MessageRow,
  Screen,
} from '../components';
import {AppStackParamList} from '../navigation/types';
import {REALTIME_EVENTS} from '../realtime/socket';
import {useSession} from '../session/SessionProvider';
import {draftStoreFor} from '../storage/draftStore';
import {useTheme} from '../theme';
import {cancelTimer, scheduleTimer, TimerHandle} from '../util/runtime';

type Props = NativeStackScreenProps<AppStackParamList, 'Conversation'>;

const PAGE_SIZE = 50;

/**
 * A conversation.
 *
 * The same screen for a channel and for a direct message, because on a phone
 * they are the same thing: a scroll of messages and a composer above the
 * keyboard. What differs is the routes that read and write, and those are
 * passed in rather than chosen here.
 *
 * The socket delivers new messages while the screen is open. When the
 * connection comes back, the screen catches up on what it missed rather than
 * asking the reader to reload.
 */
export function ConversationScreen({route}: Props): React.JSX.Element {
  const theme = useTheme();
  const {kind, targetId, serverId, title, messageId} = route.params;
  const {api, realtime, instance, user, realtimeStatus} = useSession();

  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const listRef = useRef<FlatList<Message>>(null);
  const scrolledTo = useRef<string | null>(null);
  const drafts = useMemo(
    () => draftStoreFor(instance?.origin ?? 'no-instance'),
    [instance],
  );
  const saveTimer = useRef<TimerHandle | null>(null);

  const scope = kind === 'dm' ? 'dm' : 'channel';

  const readPage = useCallback(
    async (options: {before?: number; after?: number}) => {
      if (kind === 'dm') {
        return endpoints.directMessages(api, targetId, {
          limit: PAGE_SIZE,
          before: options.before,
          after: options.after,
        });
      }
      return endpoints.channelMessages(api, targetId, {
        limit: PAGE_SIZE,
        before: options.before,
        after: options.after,
      });
    },
    [api, kind, targetId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await readPage({});
      setMessages(rows);
      setError(null);
      if (kind === 'dm') {
        void endpoints.markConversationRead(api, targetId).catch(() => {});
      }
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [api, kind, readPage, targetId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The draft is read back when the conversation opens, so a message written
  // without a connection is still there.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await drafts.read(scope, targetId);
      if (cancelled || !stored) return;
      setDraft(stored.body);
    })();
    return () => {
      cancelled = true;
    };
  }, [drafts, scope, targetId]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) cancelTimer(saveTimer.current);
    };
  }, []);

  const upsert = useCallback((message: Message) => {
    setMessages(current => {
      const index = current.findIndex(row => row.id === message.id);
      if (index === -1) {
        return [...current, message].sort(bySequence);
      }
      const next = current.slice();
      next[index] = message;
      return next.sort(bySequence);
    });
  }, []);

  const remove = useCallback((id: string) => {
    setMessages(current => current.filter(row => row.id !== id));
  }, []);

  const upsertFrame = useCallback(
    (frame: Record<string, unknown>, conversationId?: string) => {
      const source = conversationId ? {...frame, conversationId} : frame;
      const message = normalizeMessage(source);
      if (message) upsert(message);
    },
    [upsert],
  );

  // A link to one message opens the conversation at that message.
  useEffect(() => {
    if (!messageId) return;
    if (scrolledTo.current === messageId) return;
    const index = messages.findIndex(row => row.id === messageId);
    if (index === -1) return;
    scrolledTo.current = messageId;
    const timer = scheduleTimer(() => {
      listRef.current?.scrollToIndex({index, viewPosition: 0.5});
    }, 60);
    return () => cancelTimer(timer);
  }, [messageId, messages]);

  // What the socket delivers.
  useEffect(() => {
    const offs: (() => void)[] = [];

    if (kind === 'dm') {
      offs.push(
        realtime.on(REALTIME_EVENTS.DM_MESSAGE, frame => {
          if (String(frame.conversationId) !== String(targetId)) return;
          upsertFrame(frame as Record<string, unknown>, targetId);
        }),
      );
      offs.push(
        realtime.on(REALTIME_EVENTS.DM_MESSAGE_UPDATED, frame => {
          if (String(frame.conversationId) !== String(targetId)) return;
          upsertFrame(frame as Record<string, unknown>, targetId);
        }),
      );
      offs.push(
        realtime.on(REALTIME_EVENTS.DM_MESSAGE_DELETED, frame => {
          if (String(frame.conversationId) !== String(targetId)) return;
          remove(String(frame.id));
        }),
      );
    } else {
      offs.push(
        realtime.on(REALTIME_EVENTS.MESSAGE, frame => {
          if (String(frame.channel_id) !== String(targetId)) return;
          upsertFrame(frame as Record<string, unknown>);
        }),
      );
      offs.push(
        realtime.on(REALTIME_EVENTS.MESSAGE_UPDATED, frame => {
          if (String(frame.channel_id) !== String(targetId)) return;
          upsertFrame(frame as Record<string, unknown>);
        }),
      );
      offs.push(
        realtime.on(REALTIME_EVENTS.MESSAGE_DELETED, frame => {
          if (String(frame.channel_id) !== String(targetId)) return;
          remove(String(frame.id));
        }),
      );
      offs.push(
        realtime.on(REALTIME_EVENTS.MESSAGE_REACTION, frame => {
          if (String(frame.channel_id) !== String(targetId)) return;
          setMessages(current =>
            current.map(row =>
              row.id === String(frame.id)
                ? {
                    ...row,
                    reactions: normalizeMessage({
                      ...row,
                      reactions: frame.reactions,
                    }).reactions,
                  }
                : row,
            ),
          );
        }),
      );
    }

    return () => {
      for (const off of offs) off();
    };
  }, [kind, realtime, remove, targetId, upsertFrame]);

  // What was missed while the connection was down.
  const messagesRef = useRef<Message[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    return realtime.on('open', () => {
      void (async () => {
        let highest = 0;
        for (const message of messagesRef.current) {
          const value = Number(message.seq);
          if (Number.isFinite(value) && value > highest) highest = value;
        }
        if (!highest) return;
        try {
          const rows = await readPage({after: highest});
          if (!rows.length) return;
          const known = new Set(messagesRef.current.map(row => row.id));
          const fresh = rows.filter(row => !known.has(row.id));
          if (fresh.length) {
            setMessages(current => [...current, ...fresh].sort(bySequence));
          }
        } catch {
          // The next reconnect tries again.
        }
      })();
    });
  }, [readPage, realtime]);

  // Joining the room the conversation lives in.
  useEffect(() => {
    if (kind === 'dm') {
      realtime.joinConversation(targetId);
    } else {
      if (serverId) realtime.joinServer(serverId);
      realtime.joinChannel(targetId);
    }
    return () => {
      if (kind === 'dm') {
        realtime.leaveConversation();
      } else {
        realtime.leaveChannel();
        if (serverId) realtime.leaveServer();
      }
    };
  }, [kind, realtime, serverId, targetId]);

  function onDraftChange(value: string): void {
    setDraft(value);
    if (saveTimer.current) cancelTimer(saveTimer.current);
    saveTimer.current = scheduleTimer(() => {
      saveTimer.current = null;
      void (async () => {
        if (!value.trim()) {
          await drafts.remove(scope, targetId);
          setNote(null);
          return;
        }
        await drafts.write({
          scope,
          targetId,
          serverId: serverId ?? null,
          body: value,
          replyToId: null,
          updatedAt: 0,
        });
        setNote('Draft saved on this device');
      })();
    }, 600);
  }

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      const sent =
        kind === 'dm'
          ? await endpoints.sendDirectMessage(api, targetId, {content: body})
          : await endpoints.sendChannelMessage(api, targetId, {content: body});
      if (sent) upsert(sent);
      setDraft('');
      await drafts.remove(scope, targetId);
      setNote(null);
    } catch (caught) {
      // The draft stays where it is, so the message is not lost.
      setError(describeError(caught));
    } finally {
      setSending(false);
    }
  }

  async function loadOlder(): Promise<void> {
    if (!messages.length) return;
    const oldest = messages[0].seq;
    if (oldest === null || oldest === undefined) return;
    try {
      const rows = await readPage({before: oldest});
      const known = new Set(messages.map(row => row.id));
      const older = rows.filter(row => !known.has(row.id));
      if (older.length) {
        setMessages(current => [...older, ...current].sort(bySequence));
      }
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  const myId = user?.id ? String(user.id) : '';

  return (
    <Screen>
      <ConnectionBanner status={realtimeStatus} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}>
        {error ? (
          <View style={[styles.notice, {padding: theme.spacing[4]}]}>
            <ErrorNotice message={error} onRetry={() => void load()} />
          </View>
        ) : null}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={item => item.id}
          contentContainerStyle={messages.length ? undefined : styles.empty}
          onEndReachedThreshold={0.4}
          onEndReached={() => void loadOlder()}
          onScrollToIndexFailed={info => {
            // The row has not been measured yet; going to the nearest known
            // offset and letting the list settle is better than nothing.
            listRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: true,
            });
          }}
          ListEmptyComponent={
            loading ? null : (
              <EmptyState
                icon={kind === 'dm' ? 'message' : 'hash'}
                title="No messages yet"
                text="Be the first to write here."
              />
            )
          }
          renderItem={({item, index}) => {
            const previous = index === 0 ? null : messages[index - 1];
            const compact = !!previous && previous.authorId === item.authorId;
            return (
              <MessageRow
                message={item}
                isMine={!!item.authorId && String(item.authorId) === myId}
                compact={compact}
              />
            );
          }}
        />
        <Composer
          value={draft}
          onChangeText={onDraftChange}
          onSend={() => void send()}
          busy={sending}
          note={note}
          placeholder={`Message ${title}`}
          accessibilityLabel={`Message ${title}`}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

function bySequence(a: Message, b: Message): number {
  const left = a.seq === null ? 0 : a.seq;
  const right = b.seq === null ? 0 : b.seq;
  if (left !== right) return left - right;
  return timeValue(a.createdAt) - timeValue(b.createdAt);
}

function timeValue(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  notice: {
    paddingBottom: 0,
  },
  empty: {
    flexGrow: 1,
    justifyContent: 'center',
  },
});
