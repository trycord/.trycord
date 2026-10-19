import React from 'react';
import {StyleProp, StyleSheet, ViewStyle} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';

import {useTheme} from '../theme';

export interface ScreenProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** The background behind the safe area insets. */
  background?: string;
}

/**
 * The page.
 *
 * The safe area is handled here once, so no screen has to think about the
 * notch, the home indicator or the status bar.
 */
export function Screen({children, style, background}: ScreenProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[
        styles.base,
        {backgroundColor: background ?? theme.semantic.appBg},
        style,
      ]}>
      {children}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  base: {
    flex: 1,
  },
});
