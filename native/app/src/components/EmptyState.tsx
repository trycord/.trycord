import React from 'react';
import {StyleSheet, View} from 'react-native';

import {useTheme} from '../theme';
import {AppText} from './AppText';
import {Icon, IconName} from './Icon';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  text?: string | null;
  children?: React.ReactNode;
}

/** The screen that says there is nothing here, and why. */
export function EmptyState({
  icon = 'message',
  title,
  text,
  children,
}: EmptyStateProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.base, {padding: theme.spacing[6]}]}>
      <Icon name={icon} size={40} color={theme.semantic.text3} />
      <AppText variant="heading" style={styles.title}>
        {title}
      </AppText>
      {text ? (
        <AppText variant="body" tone="muted" style={styles.text}>
          {text}
        </AppText>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  title: {
    textAlign: 'center',
  },
  text: {
    textAlign: 'center',
  },
});
