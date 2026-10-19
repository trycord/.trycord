import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';

import {useTheme} from '../theme';
import {AppText} from './AppText';
import {Icon, IconName} from './Icon';

export interface ListRowProps {
  title: string;
  subtitle?: string | null;
  icon?: IconName;
  /** Shown at the right of the row, before the chevron. */
  detail?: string | null;
  onPress?: () => void;
  accessibilityHint?: string;
  /** The row is selected right now. */
  selected?: boolean;
  /** The row is not available to act on. */
  disabled?: boolean;
  testID?: string;
}

/**
 * A row in a list.
 *
 * One pressable, one label, one optional detail, and a chevron when the row
 * goes somewhere. The whole row is the target, and the target is at least
 * 44 points tall.
 */
export function ListRow({
  title,
  subtitle,
  icon,
  detail,
  onPress,
  accessibilityHint,
  selected = false,
  disabled = false,
  testID,
}: ListRowProps): React.JSX.Element {
  const theme = useTheme();
  const content = (
    <View
      style={[
        styles.base,
        {
          minHeight: theme.minTouchTarget,
          paddingHorizontal: theme.spacing[4],
          paddingVertical: theme.spacing[2],
          backgroundColor: selected ? theme.semantic.selected : 'transparent',
        },
      ]}>
      {icon ? (
        <View style={styles.icon}>
          <Icon
            name={icon}
            size={22}
            color={selected ? theme.semantic.brand : theme.semantic.text2}
          />
        </View>
      ) : null}
      <View style={styles.body}>
        <AppText variant="body" numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="meta" tone="muted" numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
      {detail ? (
        <AppText variant="meta" tone="faint">
          {detail}
        </AppText>
      ) : null}
      {onPress ? (
        <Icon name="chevron-right" size={20} color={theme.semantic.text3} />
      ) : null}
    </View>
  );

  if (!onPress) {
    return (
      <View testID={testID} accessible accessibilityLabel={title}>
        {content}
      </View>
    );
  }

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{disabled, selected}}
      style={({pressed}) => [
        pressed ? {backgroundColor: theme.semantic.hover} : null,
      ]}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  icon: {
    width: 24,
    alignItems: 'center',
  },
  body: {
    flex: 1,
    gap: 2,
  },
});
