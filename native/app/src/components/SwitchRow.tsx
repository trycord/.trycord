import React from 'react';
import {StyleSheet, Switch, View} from 'react-native';

import {useTheme} from '../theme';
import {AppText} from './AppText';

export interface SwitchRowProps {
  title: string;
  subtitle?: string | null;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}

/**
 * A setting that is on or off.
 *
 * The row and the switch are one control: the label names what the switch
 * does, and the switch says whether it is on. The whole row is the target,
 * so it can be operated without hitting the switch exactly.
 */
export function SwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled = false,
}: SwitchRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.base,
        {
          minHeight: theme.minTouchTarget,
          paddingHorizontal: theme.spacing[4],
          paddingVertical: theme.spacing[2],
        },
      ]}>
      <View style={styles.body}>
        <AppText variant="body">{title}</AppText>
        {subtitle ? (
          <AppText variant="meta" tone="muted">
            {subtitle}
          </AppText>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityLabel={title}
        accessibilityHint={subtitle}
        accessibilityRole="switch"
        accessibilityState={{checked: value, disabled}}
        trackColor={{false: theme.semantic.line2, true: theme.semantic.brand}}
        thumbColor="#FFFFFF"
        ios_backgroundColor={theme.semantic.line2}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  body: {
    flex: 1,
    gap: 2,
  },
});
