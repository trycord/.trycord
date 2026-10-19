import React from 'react';
import {StyleSheet, View} from 'react-native';

import {useTheme} from '../theme';
import {AppText} from './AppText';

export interface SectionProps {
  title: string;
  subtitle?: string | null;
  children: React.ReactNode;
}

/**
 * A titled group of rows.
 *
 * The title is a heading, so a screen reader can move between the groups of a
 * settings page rather than reading the whole thing as one list.
 */
export function Section({
  title,
  subtitle,
  children,
}: SectionProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={styles.base}>
      <AppText
        variant="label"
        tone="faint"
        accessibilityRole="header"
        style={styles.title}>
        {title.toUpperCase()}
      </AppText>
      {subtitle ? (
        <AppText variant="meta" tone="faint" style={styles.subtitle}>
          {subtitle}
        </AppText>
      ) : null}
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.semantic.panel,
            borderColor: theme.semantic.line,
            borderRadius: theme.radii.md,
          },
        ]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    gap: 8,
  },
  title: {
    marginLeft: 4,
  },
  subtitle: {
    marginLeft: 4,
    marginTop: -4,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
});
