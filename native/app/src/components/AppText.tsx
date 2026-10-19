import React from 'react';
import {StyleSheet, Text, TextProps} from 'react-native';

import {useTheme} from '../theme';

export type TextVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'meta'
  | 'micro'
  | 'label';

export type TextTone = 'primary' | 'muted' | 'faint' | 'brand' | 'danger' | 'success' | 'onBrand';

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  tone?: TextTone;
}

/**
 * The one text style.
 *
 * Every piece of text in the app goes through here, so the type scale, the
 * weights and the colours stay where the tokens put them. Dynamic type is
 * allowed: the sizes scale with the system setting, up to a point where a
 * two-word button would no longer fit, which is what the cap is for.
 */
export function AppText({
  variant = 'body',
  tone = 'primary',
  style,
  children,
  ...rest
}: AppTextProps): React.JSX.Element {
  const theme = useTheme();
  const toneColor = toneColorFor(theme, tone);

  return (
    <Text
      style={[
        styles.base,
        {
          fontSize: theme.typeScale[variant],
          fontWeight: theme.fontWeights[variantWeight(variant)],
          color: toneColor,
          letterSpacing: variant === 'label' ? theme.tracking.label : undefined,
        },
        style,
      ]}
      maxFontSizeMultiplier={1.8}
      allowFontScaling
      {...rest}>
      {children}
    </Text>
  );
}

function variantWeight(variant: TextVariant) {
  switch (variant) {
    case 'display':
    case 'title':
      return 'bold' as const;
    case 'heading':
      return 'strong' as const;
    case 'label':
      return 'medium' as const;
    default:
      return 'body' as const;
  }
}

function toneColorFor(
  theme: ReturnType<typeof useTheme>,
  tone: TextTone,
): string {
  switch (tone) {
    case 'muted':
      return theme.semantic.text2;
    case 'faint':
      return theme.semantic.text3;
    case 'brand':
      return theme.semantic.brand;
    case 'danger':
      return theme.semantic.danger;
    case 'success':
      return theme.semantic.success;
    case 'onBrand':
      return theme.semantic.text1;
    default:
      return theme.semantic.text1;
  }
}

const styles = StyleSheet.create({
  base: {
    includeFontPadding: false,
  },
});
