import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';

import {Message} from '../api/types';
import {useTheme} from '../theme';
import {timeOfDay} from '../util/format';
import {AppText} from './AppText';
import {Icon} from './Icon';

export interface MessageRowProps {
  message: Message;
  /** True when the person reading wrote it. */
  isMine: boolean;
  /** True when it follows the same person closely enough to group. */
  compact: boolean;
  onPress?: () => void;
  onPressAuthor?: (userId: string) => void;
}

/**
 * One message.
 *
 * A message is a single accessible element: the author, the time and the
 * text are read together, so a screen reader does not have to move through
 * three separate pieces to hear what was said.
 */
export function MessageRow({
  message,
  isMine,
  compact,
  onPress,
  onPressAuthor,
}: MessageRowProps): React.JSX.Element {
  const theme = useTheme();
  const author = message.authorDisplay || message.authorName || 'Unknown';
  const time = timeOfDay(message.createdAt);

  const label = [
    author,
    time,
    message.content,
    message.attachments.length ? `${message.attachments.length} attachments` : '',
    message.replyCount ? `${message.replyCount} replies` : '',
  ]
    .filter(Boolean)
    .join('. ');

  const body = (
    <View
      style={[
        styles.base,
        {
          paddingVertical: theme.spacing[1],
          paddingHorizontal: theme.spacing[4],
        },
      ]}>
      <View style={styles.gutter}>
        {!compact ? (
          <AppText variant="micro" tone="faint">
            {time}
          </AppText>
        ) : null}
      </View>
      <View style={styles.main}>
        {!compact ? (
          <Pressable
            onPress={
              message.authorId && onPressAuthor
                ? () => onPressAuthor(message.authorId as string)
                : undefined
            }
            accessibilityRole={message.authorId ? 'button' : 'text'}
            accessibilityLabel={`${author}, ${time}`}
            hitSlop={4}>
            <AppText
              variant="heading"
              tone={isMine ? 'brand' : 'primary'}
              numberOfLines={1}>
              {author}
            </AppText>
          </Pressable>
        ) : null}
        {message.content ? (
          <AppText variant="body" style={styles.text}>
            {message.content}
          </AppText>
        ) : null}
        {message.attachments.length ? (
          <View style={styles.attachments}>
            {message.attachments.map(attachment => (
              <View
                key={attachment.id}
                style={[
                  styles.attachment,
                  {
                    borderColor: theme.semantic.line,
                    borderRadius: theme.radii.sm,
                    padding: theme.spacing[2],
                  },
                ]}>
                <Icon name="file" size={16} color={theme.semantic.text3} />
                <AppText variant="meta" tone="muted" numberOfLines={1}>
                  {attachment.filename || 'Attachment'}
                </AppText>
              </View>
            ))}
          </View>
        ) : null}
        {message.reactions.length ? (
          <View style={styles.reactions}>
            {message.reactions.map(reaction => (
              <View
                key={reaction.emoji}
                style={[
                  styles.reaction,
                  {
                    borderColor: reaction.mine
                      ? theme.semantic.brandLine
                      : theme.semantic.line,
                    backgroundColor: reaction.mine
                      ? theme.semantic.brandSoft
                      : 'transparent',
                    borderRadius: theme.radii.pill,
                    paddingHorizontal: theme.spacing[2],
                  },
                ]}>
                <AppText variant="micro">{reaction.emoji}</AppText>
                <AppText variant="micro" tone="muted">
                  {String(reaction.count)}
                </AppText>
              </View>
            ))}
          </View>
        ) : null}
        {message.editedAt ? (
          <AppText variant="micro" tone="faint">
            edited
          </AppText>
        ) : null}
        {message.replyCount ? (
          <AppText variant="meta" tone="brand">
            {message.replyCount === 1 ? '1 reply' : `${message.replyCount} replies`}
          </AppText>
        ) : null}
      </View>
    </View>
  );

  if (!onPress) {
    return (
      <View accessible accessibilityRole="text" accessibilityLabel={label}>
        {body}
      </View>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the actions for this message"
      style={({pressed}) => (pressed ? {backgroundColor: theme.semantic.hover} : null)}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    gap: 8,
  },
  gutter: {
    width: 52,
    alignItems: 'flex-end',
    paddingTop: 2,
  },
  main: {
    flex: 1,
    gap: 2,
  },
  text: {
    lineHeight: 21,
  },
  attachments: {
    gap: 4,
    marginTop: 4,
  },
  attachment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  reactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  reaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 24,
  },
});
