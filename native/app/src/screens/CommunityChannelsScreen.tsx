import React, {useCallback, useEffect, useState} from 'react';
import {SectionList, StyleSheet, View} from 'react-native';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';

import {endpoints} from '../api';
import {describeError} from '../api/errors';
import {Channel, ChannelCategory} from '../api/types';
import {AppText, EmptyState, ErrorNotice, ListRow, Screen} from '../components';
import {AppStackParamList} from '../navigation/types';
import {useSession} from '../session/SessionProvider';
import {useTheme} from '../theme';

type Props = NativeStackScreenProps<AppStackParamList, 'CommunityChannels'>;

interface ChannelSection {
  title: string;
  categoryId: string | null;
  data: Channel[];
}

/**
 * The channels of a community.
 *
 * The channels are grouped the way the instance groups them, and a channel
 * that is not a text channel - a voice room, a stage - is still listed, so
 * the list matches what the instance says is there.
 */
export function CommunityChannelsScreen({route, navigation}: Props): React.JSX.Element {
  const theme = useTheme();
  const {serverId, title} = route.params;
  const {api} = useSession();

  const [sections, setSections] = useState<ChannelSection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const tree = await endpoints.channelTree(api, serverId);
      const grouped = groupChannels(tree.categories, tree.channels);
      setSections(grouped);
      setError(null);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setLoading(false);
    }
  }, [api, serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  function open(channel: Channel): void {
    navigation.navigate('Conversation', {
      kind: 'channel',
      targetId: channel.id,
      serverId,
      title: channel.name,
    });
  }

  if (error && !sections.length) {
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
      <SectionList
        sections={sections}
        keyExtractor={item => item.id}
        contentContainerStyle={sections.length ? undefined : styles.empty}
        ListHeaderComponent={
          <View style={styles.header}>
            <AppText variant="title">{title}</AppText>
            <AppText
              variant="meta"
              tone="brand"
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate('MemberList', {serverId, title})
              }>
              Members
            </AppText>
          </View>
        }
        ListEmptyComponent={
          loading ? null : (
            <EmptyState
              icon="hash"
              title="No channels yet"
              text="This community has not set any up."
            />
          )
        }
        renderSectionHeader={({section}) =>
          section.title ? (
            <View
              style={[
                styles.sectionHeader,
                {backgroundColor: theme.semantic.appBg, paddingHorizontal: theme.spacing[4]},
              ]}>
              <AppText variant="label" tone="faint" accessibilityRole="header">
                {section.title.toUpperCase()}
              </AppText>
            </View>
          ) : null
        }
        renderItem={({item}) => (
          <ListRow
            title={item.name}
            subtitle={item.topic}
            icon={item.type === 'text' ? 'hash' : 'volume'}
            detail={item.unreadCount ? String(item.unreadCount) : null}
            onPress={() => open(item)}
            accessibilityHint="Opens this channel"
          />
        )}
      />
    </Screen>
  );
}

function groupChannels(
  categories: ChannelCategory[],
  channels: Channel[],
): ChannelSection[] {
  const sections: ChannelSection[] = [];
  const uncategorised = channels.filter(channel => {
    if (!channel.categoryId) return true;
    return !categories.some(category => category.id === channel.categoryId);
  });

  for (const category of categories) {
    const data = channels.filter(channel => channel.categoryId === category.id);
    if (data.length) {
      sections.push({title: category.name, categoryId: category.id, data});
    }
  }

  if (uncategorised.length) {
    sections.push({title: 'Channels', categoryId: null, data: uncategorised});
  }

  return sections;
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionHeader: {
    paddingTop: 12,
    paddingBottom: 4,
  },
});
