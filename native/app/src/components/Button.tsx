import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';

import {useTheme} from '../theme';
import {AppText} from './AppText';
import {Icon, IconName} from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The button.
 *
 * A pressable at least 44 points tall, so it can be hit without looking, and
 * one that says what it is: the label is read out, and the busy and disabled
 * states are announced rather than only drawn.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  icon,
  accessibilityHint,
  style,
  testID,
}: ButtonProps): React.JSX.Element {
  const theme = useTheme();
  const inactive = disabled || busy;
  const palette = paletteFor(theme, variant);

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{disabled: inactive, busy}}
      style={({pressed}) => [
        styles.base,
        {
          minHeight: theme.minTouchTarget,
          paddingHorizontal: theme.spacing[4],
          borderRadius: theme.radii.md,
          backgroundColor: palette.background,
          borderColor: palette.border,
          opacity: pressed && !inactive ? 0.85 : 1,
        },
        style,
      ]}>
      <View style={styles.content}>
        {busy ? (
          <ActivityIndicator color={palette.text} size="small" />
        ) : icon ? (
          <Icon name={icon} size={20} color={palette.text} />
        ) : null}
        <AppText
          variant="heading"
          style={{color: palette.text, fontWeight: theme.fontWeights.strong}}>
          {label}
        </AppText>
      </View>
    </Pressable>
  );
}

function paletteFor(
  theme: ReturnType<typeof useTheme>,
  variant: ButtonVariant,
) {
  switch (variant) {
    case 'secondary':
      return {
        background: theme.semantic.surface,
        border: theme.semantic.line,
        text: theme.semantic.text1,
      };
    case 'ghost':
      return {
        background: 'transparent',
        border: 'transparent',
        text: theme.semantic.text2,
      };
    case 'danger':
      return {
        background: theme.semantic.danger,
        border: theme.semantic.danger,
        text: '#FFFFFF',
      };
    default:
      return {
        background: theme.semantic.brandFill,
        border: theme.semantic.brandFill,
        text: '#FFFFFF',
      };
  }
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
