import React from 'react';
import {Pressable, StyleSheet, View} from 'react-native';

import {useTheme} from '../theme';
import {AppText} from './AppText';
import {Icon, IconName} from './Icon';

export interface AvatarProps {
  name: string;
  url?: string | null;
  size?: number;
  decorative?: boolean;
}

/**
 * A person's mark.
 *
 * When there is no picture there is an initial, so a row never shows an
 * empty hole. The picture is decorative when the name is already beside it.
 */
export function Avatar({
  name,
  url,
  size = 40,
  decorative = false,
}: AvatarProps): React.JSX.Element {
  const theme = useTheme();
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';

  if (url) {
    return (
      <View
        style={[
          styles.circle,
          {width: size, height: size, borderRadius: size / 2},
        ]}>
        <AppText
          variant="heading"
          tone="onBrand"
          accessibilityElementsHidden={decorative}
          importantForAccessibility={decorative ? 'no-hide-descendants' : 'yes'}>
          {initial}
        </AppText>
      </View>
    );
  }

  return (
    <View
      accessible={!decorative}
      accessibilityRole="image"
      accessibilityLabel={decorative ? undefined : name}
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: theme.semantic.panel3,
        },
      ]}>
      <AppText variant="heading" tone="muted">
        {initial}
      </AppText>
    </View>
  );
}

export interface IconButtonProps {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tint?: string;
  size?: number;
}

/**
 * An icon-only control.
 *
 * The icon is decorative and the name is on the control, so a screen reader
 * reads what the control does rather than nothing at all.
 */
export function IconButton({
  icon,
  label,
  onPress,
  disabled = false,
  tint,
  size = 24,
}: IconButtonProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{disabled}}
      hitSlop={8}
      style={({pressed}) => [
        styles.iconButton,
        {
          minWidth: theme.minTouchTarget,
          minHeight: theme.minTouchTarget,
          borderRadius: theme.radii.md,
          opacity: pressed ? 0.7 : 1,
        },
      ]}>
      <Icon name={icon} size={size} color={tint ?? theme.semantic.text1} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
