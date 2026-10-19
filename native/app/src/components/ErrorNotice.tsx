import React from 'react';
import {StyleSheet, View} from 'react-native';

import {useTheme} from '../theme';
import {AppText} from './AppText';
import {Button} from './Button';
import {Icon} from './Icon';

export interface ErrorNoticeProps {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}

/**
 * The notice that says something went wrong.
 *
 * It is announced when it appears, and it offers the one action that helps:
 * try again.
 */
export function ErrorNotice({
  message,
  onRetry,
  retryLabel = 'Try again',
}: ErrorNoticeProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={[
        styles.base,
        {
          padding: theme.spacing[4],
          borderRadius: theme.radii.md,
          backgroundColor: theme.semantic.panel2,
          borderColor: theme.semantic.danger,
          gap: theme.spacing[2],
        },
      ]}>
      <View style={styles.head}>
        <Icon name="alert" size={20} color={theme.semantic.danger} />
        <AppText variant="heading" tone="danger">
          Something went wrong
        </AppText>
      </View>
      <AppText variant="body" tone="muted">
        {message}
      </AppText>
      {onRetry ? (
        <Button label={retryLabel} onPress={onRetry} variant="secondary" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
